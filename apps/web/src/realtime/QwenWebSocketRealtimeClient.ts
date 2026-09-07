import {
  parseQwenServerEvent,
  qwenErrorEventSchema,
  qwenInputAudioBufferCommittedEventSchema,
  qwenResponseAudioDeltaEventSchema,
  qwenResponseCreateEventSchema,
  qwenResponseCreatedEventSchema,
  qwenResponseDoneEventSchema,
  qwenSessionUpdateEventSchema,
  qwenSpeechStartedEventSchema,
  qwenSpeechStoppedEventSchema,
  qwenUserTextItemCreateEventSchema,
  type QwenServerEvent,
  type RealtimeError,
} from "@meet/protocol";

import {
  AudioWorkletMicrophoneCapture,
  AudioWorkletPcmPlayback,
  BrowserAudioError,
  type BrowserPcmError,
  type MicrophonePcmCaptureOptions,
  type PcmMicrophoneCapture,
  type PcmPlaybackOutput,
} from "./browser-pcm-audio.js";
import { InterruptiblePcmPlayback } from "./interruptible-pcm-playback.js";
import { SessionRenewal } from "./session-renewal.js";
import type {
  GenerationPcmSink,
  TaggedPcmChunk,
} from "./interruptible-pcm-playback.js";
import {
  decodePcm16Base64,
  encodePcm16Base64,
  resamplePcm16,
} from "./pcm-codec.js";
import {
  initialQwenProjection,
  projectQwenEvent,
  type QwenConversationProjection,
} from "./qwen-event-state.js";
import {
  initialClientSnapshot,
  type QwenRealtimeCallbacks,
  type QwenRealtimeOptions,
  type RealtimeClientSnapshot,
} from "./QwenRealtimeClient.js";
import {
  parseTeachingRelayFrame,
  teachingAudioGateAckFrame,
  teachingMuteFrame,
  teachingRequestFrame,
  teachingStateFromRelayFrame,
} from "../teaching/teaching-state.js";

export type {
  InputMode,
  QwenRealtimeCallbacks,
  QwenRealtimeOptions,
  RealtimeClientSnapshot,
} from "./QwenRealtimeClient.js";

const SOCKET_OPEN = 1;
const DEFAULT_MAX_SOCKET_BUFFERED_BYTES = 512 * 1024;
const PROVIDER_OUTPUT_SAMPLE_RATE = 24_000;
const RECONNECT_WINDOW_MS = 30_000;
const RECONNECT_DELAYS_MS = [1_000, 2_000, 4_000, 8_000] as const;

export type ScheduledTask = { cancel(): void };

export type QwenWebSocketClientDependencies = {
  createSocket?: (url: string) => WebSocket;
  createPlayback?: (
    onError: (error: BrowserPcmError) => void,
  ) => PcmPlaybackOutput;
  createMicrophone?: (
    options: MicrophonePcmCaptureOptions,
  ) => PcmMicrophoneCapture;
  getLocationHref?: () => string;
  maxSocketBufferedBytes?: number;
  now?: () => number;
  scheduleTask?: (callback: () => void, delayMs: number) => ScheduledTask;
  subscribeToForeground?: (callback: () => void) => () => void;
};

type RelayControlFrame = {
  type: string;
  code?: string;
  message?: string;
  status?: number;
  teaching?: boolean;
};

/**
 * Qwen WebSocket client with application-owned PCM playback. Unlike the WebRTC
 * receiver track, each output chunk remains tagged with response_id until it is
 * consumed, so an interruption can atomically invalidate every old chunk.
 */
export class QwenWebSocketRealtimeClient {
  private socket: WebSocket | null = null;
  private microphone: PcmMicrophoneCapture | null = null;
  private playback: PcmPlaybackOutput | null = null;
  private responseAudio: InterruptiblePcmPlayback | null = null;
  private projection: QwenConversationProjection = initialQwenProjection;
  private snapshot: RealtimeClientSnapshot = initialClientSnapshot;
  private options: QwenRealtimeOptions | null = null;
  private lifecycle = 0;
  private manuallyClosing = false;
  private relayReady = false;
  private configurationSent = false;
  private sessionConfigured = false;
  private initialResponseRequested = false;
  private responseCreatePending = false;
  private pushToTalkActive = false;
  private pendingSpeechIds = new Set<string>();
  private awaitingCommittedSpeechIds = new Set<string>();
  private committedSpeechIds = new Set<string>();
  private pendingTranscriptionIds = new Set<string>();
  private unfinishedResponseIds = new Set<string>();
  private seenEventIds = new Set<string>();
  private socketBackpressureReported = false;
  private reconnectStartedAt: number | null = null;
  private reconnectAttempt = 0;
  private reconnectAttemptInFlight = false;
  private reconnectGeneration = 0;
  private reconnectRetryTask: ScheduledTask | null = null;
  private reconnectDeadlineTask: ScheduledTask | null = null;
  private removeForegroundListener: (() => void) | null = null;
  private terminalSocketError = false;
  private teachingStateRevision = -1;
  private teachingStateFingerprint = "";
  private teachingAudioGateRevision = 0;
  private teachingAudioGateValue: boolean | null = null;
  private teachingAudioGateOpen = true;
  private teachingRequestPending = false;
  private teachingMutePending = false;
  private teachingBusy = false;
  private plannedReconnect = false;
  private readonly renewal = new SessionRenewal({
    now: () => this.now(),
    schedule: (callback, delay) => this.scheduleTask(callback, delay),
    isSafe: () => this.canRenewSession(),
    send: (frame) => {
      if (!this.socket || !this.relayReady) throw new Error("SOCKET_CLOSED");
      this.socket.send(JSON.stringify(frame));
    },
    flushRecords: async () => {
      await this.callbacks.onBeforeReconnect?.();
    },
    renew: () => {
      if (!this.socket || !this.canRenewSession()) return;
      this.plannedReconnect = true;
      this.detachSocket(this.socket);
      this.beginReconnect("正在自动续接，马上继续聊天", true);
    },
    notice: (detail) => this.updateConnection(this.snapshot.connection, detail),
  });

  constructor(
    private readonly legacyRemoteAudio: HTMLAudioElement,
    private readonly callbacks: QwenRealtimeCallbacks = {},
    private readonly dependencies: QwenWebSocketClientDependencies = {},
  ) {}

  async start(options: QwenRealtimeOptions): Promise<void> {
    this.teardown();
    const lifecycle = this.lifecycle;
    this.manuallyClosing = false;
    this.options = options;
    this.projection = { ...initialQwenProjection };
    this.snapshot = {
      ...initialClientSnapshot,
      inputMode: options.inputMode,
      connection: "requesting_microphone",
      detail: "正在请求麦克风权限",
    };
    this.clearLegacyRemoteAudio();
    this.emitSnapshot();

    const onAudioError = (error: BrowserPcmError): void => {
      if (lifecycle !== this.lifecycle) {
        return;
      }
      this.reportError(error.code, error.message);
    };
    const playback =
      this.dependencies.createPlayback?.(onAudioError) ??
      new AudioWorkletPcmPlayback({ onError: onAudioError });
    const microphoneOptions: MicrophonePcmCaptureOptions = {
      deviceId: options.audioInputDeviceId,
      packetDurationMs: 20,
      onPacket: (samples) => {
        if (lifecycle === this.lifecycle) {
          this.sendMicrophonePacket(samples);
        }
      },
      onError: onAudioError,
    };
    const microphone =
      this.dependencies.createMicrophone?.(microphoneOptions) ??
      new AudioWorkletMicrophoneCapture(microphoneOptions);
    this.playback = playback;
    this.microphone = microphone;

    try {
      // Both operations are started before awaiting. In particular, playback
      // resumes its AudioContext while start() still has the call-button gesture.
      const playbackStart = playback.start();
      const microphoneStart = microphone.start();
      await Promise.all([playbackStart, microphoneStart]);
      if (lifecycle !== this.lifecycle) {
        return;
      }

      const resamplingSink = new ProviderOutputPcmSink(playback);
      this.responseAudio = new InterruptiblePcmPlayback(resamplingSink);
      this.snapshot = {
        ...this.snapshot,
        microphoneLabel: microphone.microphoneLabel,
      };
      this.emitSnapshot();
      this.updateConnection("connecting", "正在建立实时语音连接");
      this.registerForegroundListener();
      this.openSocket(lifecycle);
    } catch (error) {
      if (lifecycle !== this.lifecycle) {
        return;
      }
      const clientError = normalizeError(error);
      this.teardown();
      this.snapshot = {
        ...this.snapshot,
        connection: "error",
        activity: "idle",
        detail: clientError.message,
      };
      this.emitSnapshot();
      this.callbacks.onError?.({
        code: clientError.code,
        message: clientError.message,
        recoverable: true,
      });
      throw clientError;
    }
  }

  async close(): Promise<void> {
    this.manuallyClosing = true;
    const inputMode = this.snapshot.inputMode;
    this.teardown();
    this.snapshot = {
      ...initialClientSnapshot,
      connection: "closed",
      detail: "通话已结束",
      inputMode,
    };
    this.emitSnapshot();
  }

  retry(): void {
    if (
      !this.options ||
      !this.microphone ||
      !this.playback ||
      (this.snapshot.connection !== "paused" &&
        this.snapshot.connection !== "reconnecting")
    ) {
      return;
    }
    this.terminalSocketError = false;
    this.beginReconnect("正在按你的选择重新连接", true);
  }

  requestTeaching(): void {
    this.renewal.activity();
    if (this.teachingMutePending) return;
    this.teachingRequestPending = true;
    this.flushTeachingControls();
  }

  beginTeachingMute(): void {
    this.renewal.activity();
    this.teachingRequestPending = false;
    this.applyTeachingAudioGate(false);
  }

  muteTeaching(): void {
    this.renewal.activity();
    this.teachingRequestPending = false;
    this.teachingMutePending = true;
    this.applyTeachingAudioGate(false);
    this.flushTeachingControls();
  }

  setMicrophoneMuted(muted: boolean): void {
    this.snapshot = { ...this.snapshot, microphoneMuted: muted };
    this.applyMicrophoneGate();
    this.emitSnapshot();
  }

  setPushToTalkActive(active: boolean): void {
    if (this.snapshot.inputMode !== "push_to_talk") {
      return;
    }
    if (active === this.pushToTalkActive) {
      return;
    }
    if (
      active &&
      (this.snapshot.connection !== "active" || this.snapshot.microphoneMuted)
    ) {
      return;
    }
    this.pushToTalkActive = active;
    this.renewal.activity();
    this.applyMicrophoneGate();
  }

  interrupt(): void {
    this.renewal.activity();
    const expectPendingResponse =
      this.projection.responseActive ||
      this.responseCreatePending ||
      this.projection.activity === "thinking" ||
      this.projection.activity === "user_speaking";
    const interruptedResponseId =
      this.responseAudio?.manualInterrupt(expectPendingResponse) ?? null;
    this.projection = {
      ...this.projection,
      activity: "listening",
      responseActive: false,
      // Keep the identity until its terminal event commits the interrupted
      // draft. PCM admission already rejects all subsequent old deltas.
    };
    this.syncProjectionToSnapshot();
    if (interruptedResponseId) {
      this.sendResponseCancel();
    }
  }

  sendText(text: string): void {
    const normalized = text.trim();
    if (!normalized) {
      return;
    }
    this.renewal.activity();
    this.sendClientEvent(
      qwenUserTextItemCreateEventSchema.parse({
        event_id: createEventId(),
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: normalized }],
        },
      }),
    );
    try {
      this.sendClientEvent(
        qwenResponseCreateEventSchema.parse({
          event_id: createEventId(),
          type: "response.create",
        }),
      );
      this.responseCreatePending = true;
    } catch (error) {
      this.responseCreatePending = false;
      throw error;
    }
  }

  private bindSocket(socket: WebSocket, lifecycle: number): void {
    socket.onopen = () => {
      if (!this.isCurrentSocket(socket, lifecycle)) {
        return;
      }
      this.updateConnection(
        this.reconnectStartedAt === null ? "connecting" : "reconnecting",
        "服务端已连接，正在连接千问实时模型",
      );
    };
    socket.onmessage = (message) => {
      if (!this.isCurrentSocket(socket, lifecycle)) {
        return;
      }
      if (typeof message.data !== "string") {
        this.reportError("INVALID_REALTIME_FRAME", "收到非文本的实时控制帧。");
        return;
      }
      this.handleSocketMessage(message.data);
    };
    socket.onerror = () => {
      if (!this.isCurrentSocket(socket, lifecycle)) {
        return;
      }
      this.handleUnexpectedSocketFailure(
        socket,
        lifecycle,
        "实时语音连接发生网络错误，正在自动恢复。",
      );
    };
    socket.onclose = (event) => {
      if (!this.isCurrentSocket(socket, lifecycle) || this.manuallyClosing) {
        return;
      }
      if (event.code === 4401 || event.code === 4403) {
        this.terminalSocketError = true;
        if (event.code === 4401) this.callbacks.onUnauthorized?.();
      }
      const detail = event.reason || "实时语音连接已断开，正在自动恢复。";
      this.handleUnexpectedSocketFailure(socket, lifecycle, detail);
    };
  }

  private openSocket(lifecycle: number): void {
    const options = this.options;
    if (!options || lifecycle !== this.lifecycle) {
      throw new QwenWebSocketClientError(
        "REALTIME_SESSION_CLOSED",
        "当前实时通话已经结束。",
      );
    }
    const url = getCharacterRealtimeWebSocketUrl(
      options.characterId,
      options.conversationId,
      this.dependencies.getLocationHref?.(),
      options.writer,
    );
    const socket = this.dependencies.createSocket?.(url) ?? new WebSocket(url);
    this.socket = socket;
    this.bindSocket(socket, lifecycle);
  }

  private handleUnexpectedSocketFailure(
    socket: WebSocket,
    lifecycle: number,
    detail: string,
  ): void {
    if (!this.isCurrentSocket(socket, lifecycle) || this.manuallyClosing) {
      return;
    }
    this.detachSocket(socket);
    this.resetTransportForReconnect();
    if (this.terminalSocketError) {
      this.pauseConnection(detail, "REALTIME_AUTHORIZATION_FAILED");
      return;
    }
    this.beginReconnect(detail);
  }

  private beginReconnect(detail: string, immediately = false): void {
    if (!this.options || this.manuallyClosing) return;
    this.resetTransportForReconnect();
    if (this.reconnectStartedAt === null) {
      this.reconnectStartedAt = this.now();
      this.reconnectAttempt = 0;
      this.reconnectDeadlineTask?.cancel();
      this.reconnectDeadlineTask = this.scheduleTask(() => {
        this.pauseConnection(
          "连接在 30 秒内未恢复。你可以继续重试，或结束并保存已确认记录。",
          "REALTIME_RECONNECT_TIMEOUT",
        );
      }, RECONNECT_WINDOW_MS);
    }
    this.snapshot = {
      ...this.snapshot,
      connection: "reconnecting",
      activity: "idle",
      detail,
      userCaption: "",
      assistantCaption: "",
    };
    this.emitSnapshot();
    this.scheduleReconnectAttempt(immediately);
  }

  private scheduleReconnectAttempt(immediately = false): void {
    if (
      this.manuallyClosing ||
      this.reconnectStartedAt === null ||
      this.reconnectRetryTask ||
      this.reconnectAttemptInFlight ||
      this.socket
    ) {
      return;
    }
    const elapsed = this.now() - this.reconnectStartedAt;
    if (elapsed >= RECONNECT_WINDOW_MS) {
      this.pauseConnection(
        "连接在 30 秒内未恢复。你可以继续重试，或结束并保存已确认记录。",
        "REALTIME_RECONNECT_TIMEOUT",
      );
      return;
    }
    const delay = immediately
      ? 0
      : (RECONNECT_DELAYS_MS[
          Math.min(this.reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)
        ] ?? 8_000);
    this.reconnectRetryTask = this.scheduleTask(
      () => {
        this.reconnectRetryTask = null;
        void this.runReconnectAttempt();
      },
      Math.min(delay, RECONNECT_WINDOW_MS - elapsed),
    );
  }

  private async runReconnectAttempt(): Promise<void> {
    if (
      this.manuallyClosing ||
      this.reconnectStartedAt === null ||
      this.reconnectAttemptInFlight ||
      this.socket
    ) {
      return;
    }
    if (this.now() - this.reconnectStartedAt >= RECONNECT_WINDOW_MS) {
      this.pauseConnection(
        "连接在 30 秒内未恢复。你可以继续重试，或结束并保存已确认记录。",
        "REALTIME_RECONNECT_TIMEOUT",
      );
      return;
    }

    this.reconnectAttemptInFlight = true;
    const lifecycle = this.lifecycle;
    const reconnectGeneration = this.reconnectGeneration;
    try {
      await this.microphone?.ensureAvailable();
      await this.callbacks.onBeforeReconnect?.();
      if (
        lifecycle !== this.lifecycle ||
        reconnectGeneration !== this.reconnectGeneration ||
        this.manuallyClosing ||
        this.reconnectStartedAt === null
      ) {
        return;
      }
      this.reconnectAttempt += 1;
      this.relayReady = false;
      this.configurationSent = false;
      this.sessionConfigured = false;
      this.updateConnection(
        "reconnecting",
        this.plannedReconnect
          ? "正在自动续接，马上继续聊天"
          : `正在进行第 ${this.reconnectAttempt} 次恢复尝试`,
      );
      this.openSocket(lifecycle);
    } catch {
      if (
        lifecycle === this.lifecycle &&
        reconnectGeneration === this.reconnectGeneration &&
        this.reconnectStartedAt !== null
      ) {
        this.updateConnection(
          "reconnecting",
          "已确认记录暂时无法同步，稍后继续恢复",
        );
      }
    } finally {
      if (
        lifecycle === this.lifecycle &&
        reconnectGeneration === this.reconnectGeneration
      ) {
        this.reconnectAttemptInFlight = false;
        if (!this.socket && this.reconnectStartedAt !== null) {
          this.scheduleReconnectAttempt();
        }
      }
    }
  }

  private resetTransportForReconnect(): void {
    this.renewal.reset();
    this.microphone?.setEnabled(false);
    this.responseAudio?.reset();
    this.responseCreatePending = false;
    this.pushToTalkActive = false;
    this.projection = { ...initialQwenProjection };
    this.pendingSpeechIds.clear();
    this.awaitingCommittedSpeechIds.clear();
    this.committedSpeechIds.clear();
    this.pendingTranscriptionIds.clear();
    this.unfinishedResponseIds.clear();
    this.teachingBusy = false;
    this.teachingStateRevision = -1;
    this.teachingStateFingerprint = "";
    this.teachingAudioGateRevision = 0;
    this.teachingAudioGateValue = null;
    this.teachingAudioGateOpen = false;
    this.relayReady = false;
    this.configurationSent = false;
    this.sessionConfigured = false;
    this.socketBackpressureReported = false;
  }

  private pauseConnection(detail: string, code: string): void {
    this.renewal.reset();
    this.plannedReconnect = false;
    this.clearReconnectState();
    if (this.socket) this.detachSocket(this.socket);
    this.microphone?.setEnabled(false);
    this.responseAudio?.reset();
    this.snapshot = {
      ...this.snapshot,
      connection: "paused",
      activity: "idle",
      detail,
      userCaption: "",
      assistantCaption: "",
    };
    this.emitSnapshot();
    this.reportError(code, detail);
  }

  private detachSocket(socket: WebSocket): void {
    socket.onopen = null;
    socket.onmessage = null;
    socket.onerror = null;
    socket.onclose = null;
    if (this.socket === socket) this.socket = null;
    if (socket.readyState === 0 || socket.readyState === SOCKET_OPEN) {
      socket.close(1000, "replacing connection");
    }
  }

  private completeReconnect(): boolean {
    const resumed = this.reconnectStartedAt !== null;
    this.clearReconnectState();
    this.terminalSocketError = false;
    return resumed;
  }

  private clearReconnectState(): void {
    this.reconnectGeneration += 1;
    this.reconnectRetryTask?.cancel();
    this.reconnectRetryTask = null;
    this.reconnectDeadlineTask?.cancel();
    this.reconnectDeadlineTask = null;
    this.reconnectStartedAt = null;
    this.reconnectAttempt = 0;
    this.reconnectAttemptInFlight = false;
  }

  private registerForegroundListener(): void {
    this.removeForegroundListener?.();
    const subscribe =
      this.dependencies.subscribeToForeground ?? subscribeToForeground;
    this.removeForegroundListener = subscribe(() => {
      if (this.snapshot.connection !== "reconnecting") return;
      this.reconnectRetryTask?.cancel();
      this.reconnectRetryTask = null;
      this.scheduleReconnectAttempt(true);
    });
  }

  private now(): number {
    return this.dependencies.now?.() ?? Date.now();
  }

  private scheduleTask(callback: () => void, delayMs: number): ScheduledTask {
    return (this.dependencies.scheduleTask ?? scheduleTask)(callback, delayMs);
  }

  private handleSocketMessage(input: string): void {
    let raw: unknown;
    try {
      raw = JSON.parse(input) as unknown;
    } catch {
      this.reportError(
        "INVALID_PROVIDER_EVENT",
        "收到无法解析的千问实时事件。",
      );
      return;
    }

    if (this.renewal.handleFrame(raw)) return;
    const relayFrame = readRelayControlFrame(raw);
    const teachingFrame = parseTeachingRelayFrame(raw);
    if (teachingFrame.kind === "invalid") {
      this.reportError(
        "INVALID_TEACHING_RELAY_FRAME",
        "收到无效的学习小支线控制帧。",
      );
      return;
    }
    if (teachingFrame.kind === "state") {
      const fingerprint = JSON.stringify(teachingFrame.frame);
      if (
        teachingFrame.frame.revision === this.teachingStateRevision &&
        fingerprint !== this.teachingStateFingerprint
      ) {
        this.reportError(
          "CONFLICTING_TEACHING_STATE_REVISION",
          "收到版本相同但内容冲突的学习小支线状态。",
        );
        return;
      }
      if (teachingFrame.frame.revision > this.teachingStateRevision) {
        this.renewal.activity();
        this.teachingBusy =
          teachingFrame.frame.state === "active" ||
          teachingFrame.frame.state === "restoring";
        this.teachingStateRevision = teachingFrame.frame.revision;
        this.teachingStateFingerprint = fingerprint;
        this.callbacks.onTeachingState?.(
          teachingStateFromRelayFrame(teachingFrame.frame),
        );
      }
      return;
    }
    if (teachingFrame.kind === "audio_gate") {
      this.handleTeachingAudioGate(
        teachingFrame.frame.revision,
        teachingFrame.frame.open,
      );
      return;
    }

    if (relayFrame) {
      this.handleRelayControlFrame(relayFrame);
      return;
    }

    try {
      this.handleProviderEvent(parseQwenServerEvent(input));
    } catch {
      this.reportError(
        "INVALID_PROVIDER_EVENT",
        "收到无法解析的千问实时事件。",
      );
    }
  }

  private handleRelayControlFrame(frame: RelayControlFrame): void {
    if (frame.type === "relay.ready") {
      if (!this.relayReady) {
        // Teaching relays open their gate before session.updated. An explicit
        // non-teaching relay needs no such ACK, including after replacement.
        if (frame.teaching === false) this.teachingAudioGateOpen = true;
        this.relayReady = true;
        this.configureSession();
        this.flushTeachingControls();
      }
      return;
    }
    if (frame.type === "relay.error") {
      this.responseCreatePending = false;
      if (
        frame.status === 401 ||
        frame.status === 403 ||
        frame.status === 409
      ) {
        this.terminalSocketError = true;
        if (frame.status === 401) this.callbacks.onUnauthorized?.();
      }
      this.reportError(
        frame.code ?? "REALTIME_RELAY_ERROR",
        frame.message ?? "实时语音中继连接失败。",
      );
    }
    // relay.* frames are local transport control and intentionally never enter
    // the provider parser, transcript projection, or diagnostics callback.
  }

  private configureSession(): void {
    if (this.configurationSent || !this.options || !this.relayReady) {
      return;
    }
    this.configurationSent = true;
    this.updateConnection("configuring", "正在应用角色和声音设置");
    this.sendClientEvent(
      qwenSessionUpdateEventSchema.parse({
        event_id: createEventId(),
        type: "session.update",
        session: {
          modalities: ["text", "audio"],
          voice: this.options.voice,
          input_audio_format: "pcm",
          output_audio_format: "pcm",
          instructions: this.options.instructions,
          max_history_turns: 50,
          turn_detection: { type: "smart_turn" },
        },
      }),
    );
  }

  private handleProviderEvent(event: QwenServerEvent): void {
    if (event.event_id && this.seenEventIds.has(event.event_id)) {
      return;
    }
    if (event.event_id) {
      this.rememberEventId(event.event_id);
    }

    if (
      event.type.startsWith("response.") ||
      event.type.startsWith("input_audio_buffer.") ||
      event.type.startsWith("conversation.item.input_audio_transcription.")
    ) {
      this.renewal.activity();
    }

    this.callbacks.onProviderEvent?.(
      "server",
      summarizeAudioEventForDiagnostics(event),
    );

    let shouldProjectEvent = true;

    const speechStarted = qwenSpeechStartedEventSchema.safeParse(event);
    if (speechStarted.success) {
      this.pendingTranscriptionIds.add(speechStarted.data.item_id);
      this.pendingSpeechIds.add(speechStarted.data.item_id);
      if (this.pendingSpeechIds.size === 1) {
        this.responseAudio?.speechStarted();
      }
      // Audio has already been invalidated. Preserve the draft accumulated up
      // to the interruption, but reject all later transcript events until the
      // response admission state selects an id again.
      this.projection = {
        ...this.projection,
        responseActive: false,
        activeResponseId: null,
      };
    }

    const speechStopped = qwenSpeechStoppedEventSchema.safeParse(event);
    if (speechStopped.success) {
      if (speechStopped.data.reason !== "turn_invalid") {
        this.awaitingCommittedSpeechIds.add(speechStopped.data.item_id);
      } else {
        this.pendingTranscriptionIds.delete(speechStopped.data.item_id);
        this.awaitingCommittedSpeechIds.delete(speechStopped.data.item_id);
        this.committedSpeechIds.delete(speechStopped.data.item_id);
      }
      this.pendingSpeechIds.delete(speechStopped.data.item_id);
      if (
        this.pendingSpeechIds.size === 0 &&
        this.awaitingCommittedSpeechIds.size === 0
      ) {
        const restoredResponseId =
          this.responseAudio?.resumeAfterInvalidTurn() ?? null;
        if (restoredResponseId) {
          this.projection = {
            ...this.projection,
            responseActive: true,
            activeResponseId: restoredResponseId,
          };
        }
      }
      this.tryCommitSpeechBoundary();
    }

    const speechCommitted =
      qwenInputAudioBufferCommittedEventSchema.safeParse(event);
    if (speechCommitted.success) {
      const itemId = speechCommitted.data.item_id;
      if (
        this.pendingSpeechIds.has(itemId) ||
        this.awaitingCommittedSpeechIds.has(itemId)
      ) {
        this.committedSpeechIds.add(itemId);
        this.tryCommitSpeechBoundary();
      }
    }

    const responseCreated = qwenResponseCreatedEventSchema.safeParse(event);
    if (responseCreated.success) {
      this.unfinishedResponseIds.add(responseCreated.data.response.id);
      this.responseCreatePending = false;
      const admission = this.teachingAudioGateOpen
        ? this.responseAudio?.beginResponse(responseCreated.data.response.id)
        : null;
      if (!this.teachingAudioGateOpen || !admission?.accepted) {
        shouldProjectEvent = false;
      }
      if (admission?.shouldCancel) {
        this.sendResponseCancel();
      }
    }

    const audioDelta = readResponseAudioDelta(event);
    if (
      audioDelta &&
      this.teachingAudioGateOpen &&
      this.responseAudio?.currentResponseId === audioDelta.responseId
    ) {
      try {
        const samples = decodePcm16Base64(audioDelta.delta);
        const result = this.responseAudio?.enqueue(
          audioDelta.responseId,
          samples,
        );
        if (result?.shouldCancel) {
          this.sendResponseCancel();
        }
        this.playback?.ensureRunning();
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : "千问返回了无效的 PCM 音频。";
        this.reportError("INVALID_PROVIDER_AUDIO", message);
      }
    }

    const responseDone = qwenResponseDoneEventSchema.safeParse(event);
    if (responseDone.success) {
      this.unfinishedResponseIds.delete(responseDone.data.response.id);
      this.responseAudio?.responseDone(
        responseDone.data.response.id,
        responseDone.data.response.status === "cancelled",
        responseDone.data.response.status === "cancelled"
          ? responseDone.data.response.status_details.reason
          : undefined,
      );
    }

    if (
      event.type === "conversation.item.input_audio_transcription.completed" ||
      event.type === "conversation.item.input_audio_transcription.failed"
    ) {
      const itemId =
        typeof event.item_id === "string"
          ? event.item_id
          : this.pendingTranscriptionIds.size === 1
            ? this.pendingTranscriptionIds.values().next().value
            : undefined;
      if (itemId) this.pendingTranscriptionIds.delete(itemId);
      if (event.type.endsWith(".failed")) {
        this.projection = { ...this.projection, userDraft: "" };
      }
    }

    const transcriptResponseId = readTranscriptResponseId(event);
    if (
      transcriptResponseId &&
      this.responseAudio?.currentResponseId !== transcriptResponseId
    ) {
      shouldProjectEvent = false;
    }
    if (!this.teachingAudioGateOpen && event.type.startsWith("response.")) {
      shouldProjectEvent = false;
    }

    const result = shouldProjectEvent
      ? projectQwenEvent(this.projection, event)
      : { state: this.projection, commits: [] };
    this.projection = result.state;
    for (const transcript of result.commits) {
      this.callbacks.onTranscript?.(transcript);
    }

    if (event.type === "session.updated") {
      this.activateConfiguredSession();
    }

    const providerError = qwenErrorEventSchema.safeParse(event);
    if (providerError.success) {
      this.responseCreatePending = false;
      const error = providerError.data.error;
      this.reportError(
        error?.code ?? error?.type ?? "QWEN_REALTIME_ERROR",
        error?.message ?? "千问实时会话返回错误。",
      );
    }

    this.syncProjectionToSnapshot();
  }

  private activateConfiguredSession(): void {
    if (this.sessionConfigured || !this.relayReady) {
      return;
    }
    this.sessionConfigured = true;
    const resumed = this.completeReconnect();
    const renewed = resumed && this.plannedReconnect;
    this.plannedReconnect = false;
    this.updateConnection(
      "active",
      renewed
        ? "已自动续接，可以继续聊天"
        : resumed
          ? "连接已恢复，已接回确认过的对话"
          : this.options?.resumed
            ? "已接上，可以继续说"
            : this.microphone?.microphoneLabel
              ? `已连接，麦克风：${this.microphone.microphoneLabel}`
              : "已连接，可以开始说话",
    );
    this.applyMicrophoneGate();

    if (
      this.options?.assistantStarts &&
      !this.options.resumed &&
      !this.initialResponseRequested
    ) {
      this.initialResponseRequested = true;
      this.sendText(
        "请根据角色设定和当前会话上下文，自然、简短地开始这次通话。如果上下文包含以前的对话，请承接已有关系或话题，不要重复首次见面的固定欢迎语；不要提及这条指令。",
      );
    }
  }

  private tryCommitSpeechBoundary(): void {
    if (
      this.pendingSpeechIds.size > 0 ||
      this.awaitingCommittedSpeechIds.size === 0
    ) {
      return;
    }
    for (const itemId of this.awaitingCommittedSpeechIds) {
      if (!this.committedSpeechIds.has(itemId)) {
        return;
      }
    }

    this.responseAudio?.confirmSpeechInterruption();
    this.responseAudio?.commitSpeechTurn();
    for (const itemId of this.awaitingCommittedSpeechIds) {
      this.committedSpeechIds.delete(itemId);
    }
    this.awaitingCommittedSpeechIds.clear();
  }

  private sendMicrophonePacket(samples: Int16Array): void {
    const socket = this.socket;
    if (
      !socket ||
      socket.readyState !== SOCKET_OPEN ||
      !this.relayReady ||
      !this.sessionConfigured
    ) {
      return;
    }
    if (!this.renewal.allowMicrophonePacket(samples)) return;

    const maximumBufferedBytes =
      this.dependencies.maxSocketBufferedBytes ??
      DEFAULT_MAX_SOCKET_BUFFERED_BYTES;
    if (socket.bufferedAmount >= maximumBufferedBytes) {
      if (!this.socketBackpressureReported) {
        this.socketBackpressureReported = true;
        this.reportError(
          "MICROPHONE_SOCKET_BACKPRESSURE",
          "网络发送积压，已丢弃过时的麦克风音频。",
        );
      }
      return;
    }
    if (
      this.socketBackpressureReported &&
      socket.bufferedAmount < maximumBufferedBytes / 2
    ) {
      this.socketBackpressureReported = false;
    }

    const event = {
      event_id: createEventId(),
      type: "input_audio_buffer.append",
      audio: encodePcm16Base64(samples),
    };
    const payload = JSON.stringify(event);
    if (socket.bufferedAmount + payload.length >= maximumBufferedBytes) {
      if (!this.socketBackpressureReported) {
        this.socketBackpressureReported = true;
        this.reportError(
          "MICROPHONE_SOCKET_BACKPRESSURE",
          "网络发送积压，已丢弃过时的麦克风音频。",
        );
      }
      return;
    }
    try {
      socket.send(payload);
    } catch {
      this.reportError(
        "MICROPHONE_SEND_FAILED",
        "麦克风音频发送失败，请检查网络连接。",
      );
    }
  }

  private sendClientEvent(event: unknown): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== SOCKET_OPEN || !this.relayReady) {
      throw new QwenWebSocketClientError(
        "REALTIME_SOCKET_NOT_READY",
        "实时语音连接尚未就绪。",
      );
    }
    socket.send(JSON.stringify(event));
    this.callbacks.onProviderEvent?.("client", event);
  }

  private sendRelayControlEvent(event: unknown): boolean {
    const socket = this.socket;
    if (!socket || socket.readyState !== SOCKET_OPEN || !this.relayReady) {
      return false;
    }
    try {
      socket.send(JSON.stringify(event));
      return true;
    } catch {
      this.reportError(
        "TEACHING_CONTROL_SEND_FAILED",
        "学习小支线控制没有发送成功，请检查实时连接。",
      );
      return false;
    }
  }

  private flushTeachingControls(): void {
    if (this.teachingMutePending) {
      if (this.sendRelayControlEvent(teachingMuteFrame(createEventId()))) {
        this.teachingMutePending = false;
      }
      return;
    }
    if (
      this.teachingRequestPending &&
      this.sendRelayControlEvent(teachingRequestFrame(createEventId()))
    ) {
      this.teachingRequestPending = false;
    }
  }

  private handleTeachingAudioGate(revision: number, open: boolean): void {
    if (revision < this.teachingAudioGateRevision) return;
    if (
      revision === this.teachingAudioGateRevision &&
      this.teachingAudioGateValue !== null &&
      open !== this.teachingAudioGateValue
    ) {
      this.reportError(
        "CONFLICTING_TEACHING_AUDIO_GATE_REVISION",
        "收到版本相同但开关冲突的学习音频控制帧。",
      );
      return;
    }
    if (revision > this.teachingAudioGateRevision) {
      this.teachingAudioGateRevision = revision;
      this.teachingAudioGateValue = open;
      this.applyTeachingAudioGate(open);
    }
    this.sendRelayControlEvent(
      teachingAudioGateAckFrame(createEventId(), revision),
    );
  }

  private applyTeachingAudioGate(open: boolean): void {
    if (open === this.teachingAudioGateOpen) return;
    this.renewal.activity();
    this.teachingAudioGateOpen = open;
    this.applyMicrophoneGate();
    this.responseAudio?.reset();
    this.responseCreatePending = false;
    this.projection = {
      ...this.projection,
      activity:
        this.projection.activity === "user_speaking"
          ? "user_speaking"
          : this.sessionConfigured
            ? "listening"
            : "idle",
      responseActive: false,
      activeResponseId: null,
      assistantDraft: "",
    };
    this.syncProjectionToSnapshot();
  }

  private sendResponseCancel(): void {
    if (!this.isSocketOpen() || !this.relayReady) {
      return;
    }
    try {
      this.sendClientEvent({
        event_id: createEventId(),
        type: "response.cancel",
      });
    } catch {
      this.reportError(
        "RESPONSE_CANCEL_FAILED",
        "停止角色发言失败，请检查实时连接。",
      );
    }
  }

  private isSocketOpen(): boolean {
    return this.socket?.readyState === SOCKET_OPEN;
  }

  private isCurrentSocket(socket: WebSocket, lifecycle: number): boolean {
    return this.socket === socket && this.lifecycle === lifecycle;
  }

  private canRenewSession(): boolean {
    return (
      this.snapshot.connection === "active" &&
      this.sessionConfigured &&
      this.relayReady &&
      !this.manuallyClosing &&
      this.socket?.readyState === SOCKET_OPEN &&
      this.socket.bufferedAmount === 0 &&
      this.playback?.hasPendingAudio === false &&
      !this.pushToTalkActive &&
      this.teachingAudioGateOpen &&
      !this.teachingBusy &&
      !this.teachingRequestPending &&
      !this.teachingMutePending &&
      !this.responseCreatePending &&
      this.unfinishedResponseIds.size === 0 &&
      this.pendingSpeechIds.size === 0 &&
      this.awaitingCommittedSpeechIds.size === 0 &&
      this.pendingTranscriptionIds.size === 0 &&
      !this.projection.responseActive &&
      this.projection.activity === "listening" &&
      !this.projection.userDraft &&
      !this.projection.assistantDraft &&
      (typeof document === "undefined" ||
        document.visibilityState === "visible")
    );
  }

  private applyMicrophoneGate(): void {
    const modeAllowsAudio =
      this.snapshot.inputMode === "hands_free" || this.pushToTalkActive;
    this.microphone?.setEnabled(
      this.sessionConfigured &&
        this.snapshot.connection === "active" &&
        this.teachingAudioGateOpen &&
        !this.snapshot.microphoneMuted &&
        modeAllowsAudio,
    );
  }

  private syncProjectionToSnapshot(): void {
    this.snapshot = {
      ...this.snapshot,
      activity: this.projection.activity,
      userCaption: this.projection.userDraft,
      assistantCaption: this.projection.assistantDraft,
    };
    this.emitSnapshot();
  }

  private updateConnection(
    connection: RealtimeClientSnapshot["connection"],
    detail: string,
  ): void {
    this.snapshot = { ...this.snapshot, connection, detail };
    this.emitSnapshot();
  }

  private emitSnapshot(): void {
    this.callbacks.onSnapshot?.({ ...this.snapshot });
  }

  private reportError(code: string, message: string): void {
    const error: RealtimeError = { code, message, recoverable: true };
    this.callbacks.onError?.(error);
  }

  private rememberEventId(eventId: string): void {
    this.seenEventIds.add(eventId);
    if (this.seenEventIds.size > 256) {
      const oldest = this.seenEventIds.values().next().value;
      if (oldest) {
        this.seenEventIds.delete(oldest);
      }
    }
  }

  private clearLegacyRemoteAudio(): void {
    this.legacyRemoteAudio.muted = true;
    this.legacyRemoteAudio.pause();
    this.legacyRemoteAudio.srcObject = null;
  }

  private teardown(): void {
    this.lifecycle += 1;
    this.renewal.reset();
    this.plannedReconnect = false;
    this.teachingBusy = false;
    this.pendingTranscriptionIds.clear();
    this.unfinishedResponseIds.clear();
    this.clearReconnectState();
    this.removeForegroundListener?.();
    this.removeForegroundListener = null;
    this.microphone?.setEnabled(false);
    void this.microphone?.stop();
    this.microphone = null;

    this.responseAudio?.reset();
    this.responseAudio = null;
    void this.playback?.stop();
    this.playback = null;

    if (this.socket) {
      this.socket.onopen = null;
      this.socket.onmessage = null;
      this.socket.onerror = null;
      this.socket.onclose = null;
      if (
        this.socket.readyState === 0 ||
        this.socket.readyState === SOCKET_OPEN
      ) {
        this.socket.close(1000, "client closing");
      }
    }
    this.socket = null;
    this.clearLegacyRemoteAudio();

    this.options = null;
    this.projection = { ...initialQwenProjection };
    this.relayReady = false;
    this.configurationSent = false;
    this.sessionConfigured = false;
    this.initialResponseRequested = false;
    this.responseCreatePending = false;
    this.pushToTalkActive = false;
    this.pendingSpeechIds.clear();
    this.awaitingCommittedSpeechIds.clear();
    this.committedSpeechIds.clear();
    this.seenEventIds.clear();
    this.socketBackpressureReported = false;
    this.terminalSocketError = false;
    this.teachingStateRevision = -1;
    this.teachingStateFingerprint = "";
    this.teachingAudioGateRevision = 0;
    this.teachingAudioGateValue = null;
    this.teachingAudioGateOpen = true;
    this.teachingRequestPending = false;
    this.teachingMutePending = false;
  }
}

class ProviderOutputPcmSink implements GenerationPcmSink {
  constructor(private readonly output: PcmPlaybackOutput) {}

  reset(generation: number): void {
    this.output.reset(generation);
  }

  enqueue(chunk: TaggedPcmChunk): boolean {
    return this.output.enqueue({
      ...chunk,
      samples: resamplePcm16(
        chunk.samples,
        PROVIDER_OUTPUT_SAMPLE_RATE,
        this.output.outputSampleRate,
      ),
    });
  }
}

export function getCharacterRealtimeWebSocketUrl(
  characterId: string,
  conversationId: string,
  locationHref = typeof window === "undefined"
    ? "http://localhost/"
    : window.location.href,
  writer?: { clientId: string; epoch: number },
): string {
  const url = new URL(
    `/api/characters/${encodeURIComponent(characterId)}/realtime/websocket`,
    locationHref,
  );
  url.searchParams.set("conversationId", conversationId);
  if (writer) {
    url.searchParams.set("clientId", writer.clientId);
    url.searchParams.set("epoch", String(writer.epoch));
  }
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

function readRelayControlFrame(input: unknown): RelayControlFrame | null {
  if (!isRecord(input) || typeof input.type !== "string") {
    return null;
  }
  if (!input.type.startsWith("relay.")) {
    return null;
  }
  return {
    type: input.type,
    code: typeof input.code === "string" ? input.code : undefined,
    message: typeof input.message === "string" ? input.message : undefined,
    status: typeof input.status === "number" ? input.status : undefined,
    teaching: typeof input.teaching === "boolean" ? input.teaching : undefined,
  };
}

function readResponseAudioDelta(
  event: QwenServerEvent,
): { responseId: string; delta: string } | null {
  const parsed = qwenResponseAudioDeltaEventSchema.safeParse(event);
  if (!parsed.success) {
    return null;
  }
  return {
    responseId: parsed.data.response_id,
    delta: parsed.data.delta,
  };
}

function readTranscriptResponseId(event: QwenServerEvent): string | null {
  if (
    (event.type === "response.audio_transcript.delta" ||
      event.type === "response.audio_transcript.done") &&
    typeof event.response_id === "string"
  ) {
    return event.response_id;
  }
  return null;
}

function summarizeAudioEventForDiagnostics(event: QwenServerEvent): unknown {
  const audio = readResponseAudioDelta(event);
  if (!audio) {
    return event;
  }
  return {
    ...event,
    delta: `[PCM16 base64 ${audio.delta.length} chars]`,
  };
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null;
}

function createEventId(): string {
  return `event_${crypto.randomUUID().replaceAll("-", "")}`;
}

function scheduleTask(callback: () => void, delayMs: number): ScheduledTask {
  const timeout = globalThis.setTimeout(callback, delayMs);
  return { cancel: () => globalThis.clearTimeout(timeout) };
}

function subscribeToForeground(callback: () => void): () => void {
  if (typeof document === "undefined") return () => undefined;
  const onVisibilityChange = () => {
    if (document.visibilityState === "visible") callback();
  };
  document.addEventListener("visibilitychange", onVisibilityChange);
  return () =>
    document.removeEventListener("visibilitychange", onVisibilityChange);
}

class QwenWebSocketClientError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "QwenWebSocketClientError";
  }
}

function normalizeError(error: unknown): QwenWebSocketClientError {
  if (error instanceof QwenWebSocketClientError) {
    return error;
  }
  if (error instanceof BrowserAudioError) {
    return new QwenWebSocketClientError(error.code, error.message);
  }
  if (
    typeof DOMException !== "undefined" &&
    error instanceof DOMException &&
    error.name === "NotAllowedError"
  ) {
    return new QwenWebSocketClientError(
      "MICROPHONE_PERMISSION_DENIED",
      "麦克风权限被拒绝，请在浏览器设置中允许后重试。",
    );
  }
  if (
    typeof DOMException !== "undefined" &&
    error instanceof DOMException &&
    (error.name === "NotFoundError" || error.name === "OverconstrainedError")
  ) {
    return new QwenWebSocketClientError(
      "MICROPHONE_UNAVAILABLE",
      "选择的麦克风不可用，请刷新设备后重新选择。",
    );
  }
  if (error instanceof Error) {
    return new QwenWebSocketClientError("REALTIME_CLIENT_ERROR", error.message);
  }
  return new QwenWebSocketClientError(
    "REALTIME_CLIENT_ERROR",
    "实时会话发生未知错误。",
  );
}
