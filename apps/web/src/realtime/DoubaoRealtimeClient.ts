import {
  doubaoErrorEventSchema,
  doubaoInputAudioAppendEventSchema,
  doubaoInputAudioCommitEventSchema,
  doubaoOutputAudioDeltaEventSchema,
  doubaoOutputAudioDoneEventSchema,
  doubaoOutputAudioStartedEventSchema,
  doubaoOutputTextDeltaEventSchema,
  doubaoOutputTextDoneEventSchema,
  doubaoResponseCancelEventSchema,
  doubaoResponseCanceledEventSchema,
  doubaoSessionCloseEventSchema,
  doubaoSessionCreatedEventSchema,
  doubaoSpeechTextCommitEventSchema,
  doubaoUserTranscriptionCompletedEventSchema,
  doubaoUserTranscriptionDeltaEventSchema,
  doubaoUserTranscriptionStartedEventSchema,
  parseDoubaoEvent,
  type DoubaoEvent,
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
import type {
  GenerationPcmSink,
  TaggedPcmChunk,
} from "./interruptible-pcm-playback.js";
import {
  decodePcm16Base64,
  encodePcm16Base64,
  resamplePcm16,
} from "./pcm-codec.js";
import type { PendingTranscript } from "./qwen-event-state.js";
import {
  initialClientSnapshot,
  type RealtimeClient,
  type RealtimeClientCallbacks,
  type RealtimeClientOptions,
  type RealtimeClientSnapshot,
} from "./QwenRealtimeClient.js";
import {
  getCharacterRealtimeWebSocketUrl,
  type ScheduledTask,
} from "./QwenWebSocketRealtimeClient.js";

const SOCKET_OPEN = 1;
const PROVIDER_OUTPUT_SAMPLE_RATE = 24_000;
const DEFAULT_MAX_SOCKET_BUFFERED_BYTES = 512 * 1024;
const RECONNECT_WINDOW_MS = 30_000;
const RECONNECT_DELAYS_MS = [1_000, 2_000, 4_000, 8_000] as const;

export type DoubaoRealtimeClientDependencies = {
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
};

export class DoubaoRealtimeClient implements RealtimeClient {
  private socket: WebSocket | null = null;
  private microphone: PcmMicrophoneCapture | null = null;
  private playback: PcmPlaybackOutput | null = null;
  private responseAudio: InterruptiblePcmPlayback | null = null;
  private snapshot: RealtimeClientSnapshot = initialClientSnapshot;
  private options: RealtimeClientOptions | null = null;
  private userDraft = "";
  private assistantDraft = "";
  private activeResponseId: string | null = null;
  private lifecycle = 0;
  private manuallyClosing = false;
  private relayReady = false;
  private sessionConfigured = false;
  private initialGreetingRequested = false;
  private pushToTalkActive = false;
  private seenEventIds = new Set<string>();
  private socketBackpressureReported = false;
  private reconnectStartedAt: number | null = null;
  private reconnectAttempt = 0;
  private reconnectAttemptInFlight = false;
  private reconnectRetryTask: ScheduledTask | null = null;
  private reconnectDeadlineTask: ScheduledTask | null = null;
  private removeForegroundListener: (() => void) | null = null;
  private terminalSocketError = false;

  constructor(
    private readonly legacyRemoteAudio: HTMLAudioElement,
    private readonly callbacks: RealtimeClientCallbacks = {},
    private readonly dependencies: DoubaoRealtimeClientDependencies = {},
  ) {}

  async start(options: RealtimeClientOptions): Promise<void> {
    this.teardown();
    const lifecycle = this.lifecycle;
    this.manuallyClosing = false;
    this.options = options;
    this.snapshot = {
      ...initialClientSnapshot,
      inputMode: options.inputMode,
      connection: "requesting_microphone",
      detail: "正在请求麦克风权限",
    };
    this.clearLegacyRemoteAudio();
    this.emitSnapshot();

    const onAudioError = (error: BrowserPcmError): void => {
      if (lifecycle === this.lifecycle)
        this.reportError(error.code, error.message);
    };
    const playback =
      this.dependencies.createPlayback?.(onAudioError) ??
      new AudioWorkletPcmPlayback({ onError: onAudioError });
    const microphoneOptions: MicrophonePcmCaptureOptions = {
      deviceId: options.audioInputDeviceId,
      packetDurationMs: 20,
      onPacket: (samples) => {
        if (lifecycle === this.lifecycle) this.sendMicrophonePacket(samples);
      },
      onError: onAudioError,
    };
    const microphone =
      this.dependencies.createMicrophone?.(microphoneOptions) ??
      new AudioWorkletMicrophoneCapture(microphoneOptions);
    this.playback = playback;
    this.microphone = microphone;

    try {
      await Promise.all([playback.start(), microphone.start()]);
      if (lifecycle !== this.lifecycle) return;
      this.responseAudio = new InterruptiblePcmPlayback(
        new ProviderOutputPcmSink(playback),
      );
      this.snapshot = {
        ...this.snapshot,
        microphoneLabel: microphone.microphoneLabel,
      };
      this.emitSnapshot();
      this.updateConnection("connecting", "正在建立豆包实时语音连接");
      this.registerForegroundListener();
      this.openSocket(lifecycle);
    } catch (error) {
      if (lifecycle !== this.lifecycle) return;
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
    const socket = this.socket;
    if (socket?.readyState === SOCKET_OPEN && this.sessionConfigured) {
      try {
        this.sendClientEvent(
          doubaoSessionCloseEventSchema.parse({
            event_id: createEventId(),
            type: "session.close",
          }),
        );
        await waitForSocketClose(socket, 1_500);
      } catch {
        // The transport teardown below is the bounded fallback.
      }
    }
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
    // Teaching relay controls are intentionally unavailable for Doubao.
  }

  beginTeachingMute(): void {
    // Teaching relay controls are intentionally unavailable for Doubao.
  }

  muteTeaching(): void {
    // Teaching relay controls are intentionally unavailable for Doubao.
  }

  setMicrophoneMuted(muted: boolean): void {
    this.snapshot = { ...this.snapshot, microphoneMuted: muted };
    this.applyMicrophoneGate();
    this.emitSnapshot();
  }

  setPushToTalkActive(active: boolean): void {
    if (
      this.snapshot.inputMode !== "push_to_talk" ||
      active === this.pushToTalkActive
    ) {
      return;
    }
    if (
      active &&
      (this.snapshot.connection !== "active" || this.snapshot.microphoneMuted)
    ) {
      return;
    }
    const wasActive = this.pushToTalkActive;
    this.pushToTalkActive = active;
    this.applyMicrophoneGate();
    if (wasActive && !active && this.sessionConfigured) {
      this.sendInputCommit();
    }
  }

  interrupt(): void {
    const interruptedResponseId =
      this.responseAudio?.manualInterrupt(
        Boolean(this.activeResponseId) || this.snapshot.activity === "thinking",
      ) ?? null;
    this.activeResponseId = null;
    this.assistantDraft = "";
    this.snapshot = {
      ...this.snapshot,
      activity: "listening",
      assistantCaption: "",
    };
    this.emitSnapshot();
    if (interruptedResponseId || this.sessionConfigured)
      this.sendResponseCancel();
  }

  private openSocket(lifecycle: number): void {
    if (!this.options || lifecycle !== this.lifecycle) return;
    const socket =
      this.dependencies.createSocket?.(
        getCharacterRealtimeWebSocketUrl(
          this.options.characterId,
          this.options.conversationId,
          this.dependencies.getLocationHref?.(),
        ),
      ) ??
      new WebSocket(
        getCharacterRealtimeWebSocketUrl(
          this.options.characterId,
          this.options.conversationId,
          this.dependencies.getLocationHref?.(),
        ),
      );
    this.socket = socket;
    this.bindSocket(socket, lifecycle);
  }

  private bindSocket(socket: WebSocket, lifecycle: number): void {
    socket.onopen = () => {
      if (!this.isCurrentSocket(socket, lifecycle)) return;
      this.updateConnection(
        this.reconnectStartedAt === null ? "connecting" : "reconnecting",
        "服务端已连接，正在创建豆包实时会话",
      );
    };
    socket.onmessage = (message) => {
      if (!this.isCurrentSocket(socket, lifecycle)) return;
      if (typeof message.data !== "string") {
        this.reportError("INVALID_REALTIME_FRAME", "收到非文本的实时控制帧。");
        return;
      }
      this.handleSocketMessage(message.data);
    };
    socket.onerror = () => {
      if (this.isCurrentSocket(socket, lifecycle)) {
        this.reportError(
          "REALTIME_NETWORK_ERROR",
          "实时语音连接发生网络错误，正在自动恢复。",
        );
      }
    };
    socket.onclose = (event) => {
      if (!this.isCurrentSocket(socket, lifecycle)) return;
      if (this.manuallyClosing) return;
      this.handleUnexpectedSocketFailure(
        socket,
        lifecycle,
        event.reason || "豆包实时语音连接已断开，正在自动恢复。",
      );
    };
  }

  private handleSocketMessage(input: string): void {
    let raw: unknown;
    try {
      raw = JSON.parse(input) as unknown;
    } catch {
      this.reportError(
        "INVALID_PROVIDER_EVENT",
        "收到无法解析的豆包实时事件。",
      );
      return;
    }
    const relayFrame = readRelayControlFrame(raw);
    if (relayFrame) {
      this.handleRelayControlFrame(relayFrame);
      return;
    }
    try {
      this.handleProviderEvent(parseDoubaoEvent(input));
    } catch {
      this.reportError(
        "INVALID_PROVIDER_EVENT",
        "收到无法解析的豆包实时事件。",
      );
    }
  }

  private handleRelayControlFrame(frame: RelayControlFrame): void {
    if (frame.type === "relay.ready") {
      this.relayReady = true;
      return;
    }
    if (frame.type !== "relay.error") return;
    if (
      frame.status === 401 ||
      frame.status === 403 ||
      frame.code === "DOUBAO_AUTHORIZATION_FAILED"
    ) {
      this.terminalSocketError = true;
    }
    this.reportError(
      frame.code ?? "REALTIME_RELAY_ERROR",
      frame.message ?? "实时语音中继连接失败。",
    );
  }

  private handleProviderEvent(event: DoubaoEvent): void {
    if (event.event_id && this.seenEventIds.has(event.event_id)) return;
    if (event.event_id) this.rememberEventId(event.event_id);
    this.callbacks.onProviderEvent?.(
      "server",
      summarizeAudioEventForDiagnostics(event),
    );

    if (doubaoSessionCreatedEventSchema.safeParse(event).success) {
      this.activateSession();
    }

    if (doubaoUserTranscriptionStartedEventSchema.safeParse(event).success) {
      const interrupted = this.responseAudio?.currentResponseId;
      this.responseAudio?.speechStarted();
      this.activeResponseId = null;
      this.assistantDraft = "";
      this.snapshot = {
        ...this.snapshot,
        activity: "user_speaking",
        assistantCaption: "",
      };
      if (interrupted) this.sendResponseCancel();
    }

    const userDelta = doubaoUserTranscriptionDeltaEventSchema.safeParse(event);
    if (userDelta.success) {
      this.userDraft = userDelta.data.delta
        ? `${this.userDraft}${userDelta.data.delta}`
        : (userDelta.data.text ?? this.userDraft);
      this.snapshot = {
        ...this.snapshot,
        activity: "user_speaking",
        userCaption: this.userDraft,
      };
    }

    const userCompleted =
      doubaoUserTranscriptionCompletedEventSchema.safeParse(event);
    if (userCompleted.success) {
      const text =
        userCompleted.data.transcript ??
        userCompleted.data.text ??
        this.userDraft;
      if (text.trim()) {
        this.emitTranscript({
          speaker: "user",
          text: text.trim(),
          status: "completed",
          providerEventId: event.event_id ?? null,
        });
      }
      this.userDraft = "";
      this.responseAudio?.confirmSpeechInterruption();
      this.responseAudio?.commitSpeechTurn();
      this.snapshot = {
        ...this.snapshot,
        activity: "thinking",
        userCaption: "",
      };
    }

    const audioStarted = doubaoOutputAudioStartedEventSchema.safeParse(event);
    if (audioStarted.success && audioStarted.data.response_id) {
      this.beginResponse(audioStarted.data.response_id);
    }

    const audioDelta = doubaoOutputAudioDeltaEventSchema.safeParse(event);
    if (audioDelta.success) {
      const responseId =
        audioDelta.data.response_id ?? this.activeResponseId ?? null;
      if (!responseId) {
        this.reportError(
          "DOUBAO_AUDIO_RESPONSE_MISSING",
          "豆包返回的音频缺少响应标识，已忽略该音频块。",
        );
        this.emitSnapshot();
        return;
      }
      this.beginResponse(responseId);
      try {
        const result = this.responseAudio?.enqueue(
          responseId,
          decodePcm16Base64(audioDelta.data.delta),
        );
        if (result?.shouldCancel) this.sendResponseCancel();
        this.playback?.ensureRunning();
      } catch (error) {
        this.reportError(
          "INVALID_PROVIDER_AUDIO",
          error instanceof Error
            ? error.message
            : "豆包返回了无效的 PCM 音频。",
        );
      }
    }

    const textDelta = doubaoOutputTextDeltaEventSchema.safeParse(event);
    if (textDelta.success) {
      this.assistantDraft += textDelta.data.delta;
      this.snapshot = {
        ...this.snapshot,
        activity: "assistant_speaking",
        assistantCaption: this.assistantDraft,
      };
    }

    const textDone = doubaoOutputTextDoneEventSchema.safeParse(event);
    if (textDone.success && textDone.data.text) {
      this.assistantDraft = textDone.data.text;
      this.snapshot = {
        ...this.snapshot,
        assistantCaption: this.assistantDraft,
      };
    }

    const audioDone = doubaoOutputAudioDoneEventSchema.safeParse(event);
    if (audioDone.success) {
      this.responseAudio?.responseDone(audioDone.data.response_id, false);
      this.commitAssistant("completed", audioDone.data.response_id);
    }

    if (doubaoResponseCanceledEventSchema.safeParse(event).success) {
      if (this.activeResponseId) {
        this.responseAudio?.responseDone(
          this.activeResponseId,
          true,
          "client_cancelled",
        );
        this.commitAssistant("interrupted", this.activeResponseId);
      }
    }

    if (event.type === "response.done" && this.assistantDraft.trim()) {
      this.commitAssistant(
        "completed",
        this.activeResponseId ?? event.event_id ?? "response.done",
      );
    }

    const providerError = doubaoErrorEventSchema.safeParse(event);
    if (providerError.success) {
      const code = String(
        providerError.data.status_code ??
          providerError.data.code ??
          "DOUBAO_REALTIME_ERROR",
      );
      if (code.startsWith("4")) this.terminalSocketError = true;
      this.reportError(
        code,
        providerError.data.message ?? "豆包实时语音会话返回错误。",
      );
    }
    this.emitSnapshot();
  }

  private beginResponse(responseId: string): void {
    if (this.activeResponseId === responseId) return;
    const admission = this.responseAudio?.beginResponse(responseId);
    if (admission?.shouldCancel) this.sendResponseCancel();
    if (admission && !admission.accepted) return;
    this.activeResponseId = responseId;
    this.assistantDraft = "";
    this.snapshot = {
      ...this.snapshot,
      activity: "assistant_speaking",
      assistantCaption: "",
    };
  }

  private commitAssistant(
    status: PendingTranscript["status"],
    responseId: string,
  ): void {
    if (this.assistantDraft.trim()) {
      this.emitTranscript({
        speaker: "assistant",
        text: this.assistantDraft.trim(),
        status,
        providerEventId: responseId,
      });
    }
    this.assistantDraft = "";
    this.activeResponseId = null;
    this.snapshot = {
      ...this.snapshot,
      activity: "listening",
      assistantCaption: "",
    };
  }

  private activateSession(): void {
    if (this.sessionConfigured) return;
    this.relayReady = true;
    this.sessionConfigured = true;
    const resumed = this.completeReconnect();
    this.updateConnection(
      "active",
      resumed
        ? "连接已恢复，已接回确认过的对话"
        : this.microphone?.microphoneLabel
          ? `已连接，麦克风：${this.microphone.microphoneLabel}`
          : "已连接，可以开始说话",
    );
    this.snapshot = { ...this.snapshot, activity: "listening" };
    this.applyMicrophoneGate();
    if (this.options?.assistantStarts && !this.initialGreetingRequested) {
      this.initialGreetingRequested = true;
      const greeting = this.options.openingText?.trim();
      if (greeting) {
        this.sendClientEvent(
          doubaoSpeechTextCommitEventSchema.parse({
            event_id: createEventId(),
            type: "speech_text_buffer.commit",
            speech_id: createSpeechId(),
            text: greeting,
          }),
        );
      }
    }
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
    const maximum =
      this.dependencies.maxSocketBufferedBytes ??
      DEFAULT_MAX_SOCKET_BUFFERED_BYTES;
    if (socket.bufferedAmount >= maximum) {
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
      socket.bufferedAmount < maximum / 2
    ) {
      this.socketBackpressureReported = false;
    }
    this.sendClientEvent(
      doubaoInputAudioAppendEventSchema.parse({
        event_id: createEventId(),
        type: "input_audio_buffer.append",
        audio: encodePcm16Base64(samples),
      }),
    );
  }

  private sendInputCommit(): void {
    try {
      this.sendClientEvent(
        doubaoInputAudioCommitEventSchema.parse({
          event_id: createEventId(),
          type: "input_audio_buffer.commit",
        }),
      );
    } catch {
      this.reportError("INPUT_COMMIT_FAILED", "提交本轮语音失败，请重试。");
    }
  }

  private sendResponseCancel(): void {
    if (!this.isSocketOpen() || !this.relayReady) return;
    try {
      this.sendClientEvent(
        doubaoResponseCancelEventSchema.parse({
          event_id: createEventId(),
          type: "response.cancel",
        }),
      );
    } catch {
      this.reportError(
        "RESPONSE_CANCEL_FAILED",
        "停止角色发言失败，请检查实时连接。",
      );
    }
  }

  private sendClientEvent(event: unknown): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== SOCKET_OPEN || !this.relayReady) {
      throw new DoubaoClientError(
        "REALTIME_SOCKET_NOT_READY",
        "实时语音连接尚未就绪。",
      );
    }
    socket.send(JSON.stringify(event));
    this.callbacks.onProviderEvent?.("client", event);
  }

  private handleUnexpectedSocketFailure(
    socket: WebSocket,
    lifecycle: number,
    detail: string,
  ): void {
    if (!this.isCurrentSocket(socket, lifecycle) || this.manuallyClosing)
      return;
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
        "连接在 30 秒内未恢复。",
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
    this.reconnectAttemptInFlight = true;
    const lifecycle = this.lifecycle;
    try {
      await this.microphone?.ensureAvailable();
      await this.callbacks.onBeforeReconnect?.();
      if (lifecycle !== this.lifecycle || this.manuallyClosing) return;
      this.reconnectAttempt += 1;
      this.relayReady = false;
      this.sessionConfigured = false;
      this.updateConnection(
        "reconnecting",
        `正在进行第 ${this.reconnectAttempt} 次恢复尝试`,
      );
      this.openSocket(lifecycle);
    } catch {
      this.updateConnection(
        "reconnecting",
        "已确认记录暂时无法同步，稍后继续恢复",
      );
    } finally {
      this.reconnectAttemptInFlight = false;
      if (!this.socket && this.reconnectStartedAt !== null) {
        this.scheduleReconnectAttempt();
      }
    }
  }

  private resetTransportForReconnect(): void {
    this.microphone?.setEnabled(false);
    this.responseAudio?.reset();
    this.pushToTalkActive = false;
    this.userDraft = "";
    this.assistantDraft = "";
    this.activeResponseId = null;
    this.relayReady = false;
    this.sessionConfigured = false;
    this.socketBackpressureReported = false;
  }

  private pauseConnection(detail: string, code: string): void {
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

  private applyMicrophoneGate(): void {
    const modeAllowsAudio =
      this.snapshot.inputMode === "hands_free" || this.pushToTalkActive;
    this.microphone?.setEnabled(
      this.sessionConfigured &&
        this.snapshot.connection === "active" &&
        !this.snapshot.microphoneMuted &&
        modeAllowsAudio,
    );
  }

  private isSocketOpen(): boolean {
    return this.socket?.readyState === SOCKET_OPEN;
  }

  private isCurrentSocket(socket: WebSocket, lifecycle: number): boolean {
    return this.socket === socket && this.lifecycle === lifecycle;
  }

  private updateConnection(
    connection: RealtimeClientSnapshot["connection"],
    detail: string,
  ): void {
    this.snapshot = { ...this.snapshot, connection, detail };
    this.emitSnapshot();
  }

  private emitTranscript(transcript: PendingTranscript): void {
    this.callbacks.onTranscript?.(transcript);
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
    if (this.seenEventIds.size > 512) {
      const oldest = this.seenEventIds.values().next().value as
        string | undefined;
      if (oldest) this.seenEventIds.delete(oldest);
    }
  }

  private now(): number {
    return this.dependencies.now?.() ?? Date.now();
  }

  private scheduleTask(callback: () => void, delayMs: number): ScheduledTask {
    return (this.dependencies.scheduleTask ?? scheduleTask)(callback, delayMs);
  }

  private clearLegacyRemoteAudio(): void {
    this.legacyRemoteAudio.pause();
    this.legacyRemoteAudio.srcObject = null;
    this.legacyRemoteAudio.removeAttribute("src");
  }

  private teardown(): void {
    this.lifecycle += 1;
    this.clearReconnectState();
    this.removeForegroundListener?.();
    this.removeForegroundListener = null;
    if (this.socket) this.detachSocket(this.socket);
    void this.microphone?.stop();
    void this.playback?.stop();
    this.microphone = null;
    this.playback = null;
    this.responseAudio = null;
    this.options = null;
    this.relayReady = false;
    this.sessionConfigured = false;
    this.pushToTalkActive = false;
    this.userDraft = "";
    this.assistantDraft = "";
    this.activeResponseId = null;
    this.seenEventIds.clear();
    this.clearLegacyRemoteAudio();
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

function readRelayControlFrame(input: unknown): RelayControlFrame | null {
  if (
    typeof input !== "object" ||
    input === null ||
    typeof Reflect.get(input, "type") !== "string" ||
    !(Reflect.get(input, "type") as string).startsWith("relay.")
  ) {
    return null;
  }
  return {
    type: Reflect.get(input, "type") as string,
    code:
      typeof Reflect.get(input, "code") === "string"
        ? (Reflect.get(input, "code") as string)
        : undefined,
    message:
      typeof Reflect.get(input, "message") === "string"
        ? (Reflect.get(input, "message") as string)
        : undefined,
    status:
      typeof Reflect.get(input, "status") === "number"
        ? (Reflect.get(input, "status") as number)
        : undefined,
  };
}

function summarizeAudioEventForDiagnostics(event: DoubaoEvent): unknown {
  const audio = doubaoOutputAudioDeltaEventSchema.safeParse(event);
  return audio.success
    ? { ...event, delta: `[PCM16 base64 ${audio.data.delta.length} chars]` }
    : event;
}

function createEventId(): string {
  return `event_${crypto.randomUUID().replaceAll("-", "")}`;
}

function createSpeechId(): string {
  return `speech_${crypto.randomUUID().replaceAll("-", "")}`;
}

function scheduleTask(callback: () => void, delayMs: number): ScheduledTask {
  const timeout = globalThis.setTimeout(callback, delayMs);
  return { cancel: () => globalThis.clearTimeout(timeout) };
}

function subscribeToForeground(callback: () => void): () => void {
  if (typeof document === "undefined") return () => undefined;
  const listener = () => {
    if (document.visibilityState === "visible") callback();
  };
  document.addEventListener("visibilitychange", listener);
  return () => document.removeEventListener("visibilitychange", listener);
}

function waitForSocketClose(
  socket: WebSocket,
  timeoutMs: number,
): Promise<void> {
  return new Promise((resolve) => {
    if (socket.readyState >= 2) return resolve();
    const timeout = globalThis.setTimeout(resolve, timeoutMs);
    const previous = socket.onclose;
    socket.onclose = (event) => {
      globalThis.clearTimeout(timeout);
      previous?.call(socket, event);
      resolve();
    };
  });
}

class DoubaoClientError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "DoubaoClientError";
  }
}

function normalizeError(error: unknown): DoubaoClientError {
  if (error instanceof DoubaoClientError) return error;
  if (error instanceof BrowserAudioError) {
    return new DoubaoClientError(error.code, error.message);
  }
  if (
    typeof DOMException !== "undefined" &&
    error instanceof DOMException &&
    error.name === "NotAllowedError"
  ) {
    return new DoubaoClientError(
      "MICROPHONE_PERMISSION_DENIED",
      "麦克风权限被拒绝，请在浏览器设置中允许后重试。",
    );
  }
  if (error instanceof Error) {
    return new DoubaoClientError("REALTIME_CLIENT_ERROR", error.message);
  }
  return new DoubaoClientError(
    "REALTIME_CLIENT_ERROR",
    "实时会话发生未知错误。",
  );
}
