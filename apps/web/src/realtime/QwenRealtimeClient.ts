import {
  parseQwenServerEvent,
  qwenAssistantTranscriptDeltaSchema,
  qwenErrorEventSchema,
  qwenResponseCreatedEventSchema,
  qwenResponseDoneEventSchema,
  qwenResponseCreateEventSchema,
  qwenSessionUpdateEventSchema,
  qwenSpeechStartedEventSchema,
  qwenSpeechStoppedEventSchema,
  qwenUserTextItemCreateEventSchema,
  type QwenServerEvent,
  type RealtimeActivity,
  type RealtimeConnectionState,
  type RealtimeError,
} from "@meet/protocol";

import {
  initialQwenProjection,
  projectQwenEvent,
  type PendingTranscript,
  type QwenConversationProjection,
} from "./qwen-event-state.js";
import type { TeachingCallState } from "../teaching/teaching-state.js";

export type InputMode = "hands_free" | "push_to_talk";

export type RealtimeClientOptions = {
  characterId: string;
  conversationId: string;
  writer?: { clientId: string; epoch: number };
  resumed?: boolean;
  voice: string;
  instructions: string;
  inputMode: InputMode;
  assistantStarts: boolean;
  openingText?: string;
  audioInputDeviceId?: string;
};

export type QwenRealtimeOptions = RealtimeClientOptions;

export type RealtimeClientSnapshot = {
  connection: RealtimeConnectionState;
  activity: RealtimeActivity;
  detail: string;
  userCaption: string;
  assistantCaption: string;
  microphoneMuted: boolean;
  microphoneLabel: string;
  inputMode: InputMode;
};

export const initialClientSnapshot: RealtimeClientSnapshot = {
  connection: "idle",
  activity: "idle",
  detail: "尚未开始",
  userCaption: "",
  assistantCaption: "",
  microphoneMuted: false,
  microphoneLabel: "",
  inputMode: "hands_free",
};

type Direction = "client" | "server";

export type RealtimeClientCallbacks = {
  onSnapshot?: (snapshot: RealtimeClientSnapshot) => void;
  onTranscript?: (transcript: PendingTranscript) => void;
  onProviderEvent?: (direction: Direction, event: unknown) => void;
  onError?: (error: RealtimeError) => void;
  onUnauthorized?: () => void;
  onBeforeReconnect?: () => Promise<void>;
  onTeachingState?: (state: TeachingCallState) => void;
};

export type QwenRealtimeCallbacks = RealtimeClientCallbacks;

export interface RealtimeClient {
  start(options: RealtimeClientOptions): Promise<void>;
  close(): Promise<void>;
  retry(): void;
  interrupt(): void;
  setMicrophoneMuted(muted: boolean): void;
  setPushToTalkActive(active: boolean): void;
  requestTeaching(): void;
  beginTeachingMute(): void;
  muteTeaching(): void;
}

export class QwenRealtimeClient {
  private peerConnection: RTCPeerConnection | null = null;
  private commandChannel: RTCDataChannel | null = null;
  private eventChannels = new Set<RTCDataChannel>();
  private mediaStream: MediaStream | null = null;
  private microphoneTrack: MediaStreamTrack | null = null;
  private microphoneSender: RTCRtpSender | null = null;
  private abortController: AbortController | null = null;
  private reconnectTimer: number | null = null;
  private projection: QwenConversationProjection = initialQwenProjection;
  private snapshot: RealtimeClientSnapshot = initialClientSnapshot;
  private options: QwenRealtimeOptions | null = null;
  private sessionConfigurationStarted = false;
  private sessionActivationStarted = false;
  private sessionConfigured = false;
  private initialResponseRequested = false;
  private mediaAttached = false;
  private pushToTalkActive = false;
  private manuallyClosing = false;
  private seenEventIds = new Set<string>();
  private mediaAttachPromise: Promise<void> | null = null;
  private pendingSpeechIds = new Set<string>();
  private manualAudioSuppressed = false;
  private confirmedInterruptSuppressed = false;
  private cancelRequested = false;
  private remoteAudioTrack: MediaStreamTrack | null = null;
  private playbackAudioTrack: MediaStreamTrack | null = null;
  private playbackAttempt = 0;
  private awaitingFreshResponseAudio = false;
  private freshResponseId: string | null = null;
  private activeResponseId: string | null = null;
  private interruptedResponseId: string | null = null;
  private validInterruptPending = false;
  private audioDrainContext: AudioContext | null = null;
  private audioDrainGain: GainNode | null = null;
  private audioDrainSource: MediaStreamAudioSourceNode | null = null;
  private audioDrainStream: MediaStream | null = null;
  private audioDrainPreparationAttempted = false;
  private audioDrainResumePromise: Promise<void> | null = null;
  private audioDrainResumeAttempt = 0;
  private audioDrainFailureReported = false;
  private audioDrainVisibilityListener: EventListener | null = null;
  private audioDrainRetryListener: EventListener | null = null;
  private playbackRetryListener: EventListener | null = null;

  constructor(
    private readonly remoteAudio: HTMLAudioElement,
    private readonly callbacks: QwenRealtimeCallbacks = {},
  ) {}

  async start(options: QwenRealtimeOptions): Promise<void> {
    this.teardown();
    // start() 由用户点击触发；在首次 await 前创建并恢复 AudioContext，
    // 让移动浏览器授予这条静音 drain 管线播放权限。
    this.prepareRemoteAudioDrain();
    this.manuallyClosing = false;
    this.options = options;
    this.projection = { ...initialQwenProjection };
    this.snapshot = {
      ...initialClientSnapshot,
      inputMode: options.inputMode,
      connection: "requesting_microphone",
      detail: "正在请求麦克风权限",
    };
    this.emitSnapshot();

    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new ClientError(
          "MEDIA_UNAVAILABLE",
          "当前浏览器不支持麦克风采集，请使用新版浏览器并通过 HTTPS 访问。",
        );
      }

      this.abortController = new AbortController();
      const audioConstraints: MediaTrackConstraints = {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      };
      if (options.audioInputDeviceId) {
        audioConstraints.deviceId = { exact: options.audioInputDeviceId };
      }
      this.mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: audioConstraints,
        video: false,
      });
      this.microphoneTrack = this.mediaStream.getAudioTracks()[0] ?? null;
      if (!this.microphoneTrack) {
        throw new ClientError("NO_AUDIO_TRACK", "没有获得可用的麦克风音轨。");
      }
      this.microphoneTrack.enabled = false;
      this.snapshot = {
        ...this.snapshot,
        microphoneLabel: this.microphoneTrack.label || "已授权的麦克风",
      };
      this.emitSnapshot();

      this.updateConnection("connecting", "正在建立 WebRTC 连接");
      const peerConnection = new RTCPeerConnection({ iceServers: [] });
      this.peerConnection = peerConnection;
      this.bindPeerConnection(peerConnection);

      this.microphoneSender = peerConnection.addTrack(
        this.microphoneTrack,
        this.mediaStream,
      );
      await this.microphoneSender.replaceTrack(null);
      this.mediaAttached = false;

      const bootstrapChannel = peerConnection.createDataChannel("oai-events");
      this.attachEventChannel(bootstrapChannel);

      const offer = await peerConnection.createOffer();
      await peerConnection.setLocalDescription(offer);
      await waitForIceGatheringComplete(peerConnection);

      const offerSdp = peerConnection.localDescription?.sdp;
      if (!offerSdp) {
        throw new ClientError(
          "MISSING_LOCAL_SDP",
          "浏览器没有生成 SDP offer。",
        );
      }

      const response = await fetch(
        getCharacterRealtimeSessionUrl(
          options.characterId,
          options.conversationId,
          options.writer,
        ),
        {
          method: "POST",
          headers: {
            Accept: "application/sdp, application/json",
            "Content-Type": "application/sdp",
          },
          body: offerSdp,
          signal: this.abortController.signal,
        },
      );
      const responseText = await response.text();
      if (!response.ok) {
        if (response.status === 401) {
          this.callbacks.onUnauthorized?.();
        }
        throw readGatewayError(responseText, response.status);
      }

      await peerConnection.setRemoteDescription({
        type: "answer",
        sdp: responseText,
      });
    } catch (error) {
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
    this.teardown();
    this.snapshot = {
      ...initialClientSnapshot,
      connection: "closed",
      detail: "通话已结束",
      inputMode: this.snapshot.inputMode,
    };
    this.emitSnapshot();
  }

  requestTeaching(): void {
    // The legacy direct WebRTC transport has no application relay channel.
  }

  beginTeachingMute(): void {
    // The legacy direct WebRTC transport has no application relay channel.
  }

  muteTeaching(): void {
    // The legacy direct WebRTC transport has no application relay channel.
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
    this.applyMicrophoneGate();
  }

  interrupt(): void {
    this.manualAudioSuppressed = true;
    this.awaitingFreshResponseAudio = true;
    this.freshResponseId = null;
    this.interruptedResponseId ??= this.activeResponseId;
    this.syncRemoteAudioPlayback();

    if (
      !this.projection.responseActive ||
      !this.isCommandChannelOpen() ||
      this.cancelRequested
    ) {
      return;
    }

    this.sendClientEvent({
      event_id: createEventId(),
      type: "response.cancel",
    });
    this.cancelRequested = true;
  }

  private bindPeerConnection(peerConnection: RTCPeerConnection): void {
    peerConnection.ondatachannel = ({ channel }) => {
      if (channel.label === "txt" || !this.commandChannel) {
        this.commandChannel = channel;
      }
      this.attachEventChannel(channel);
    };

    peerConnection.ontrack = ({ track }) => {
      if (track.kind !== "audio") {
        return;
      }

      this.acceptRemoteAudioTrack(track);
    };

    peerConnection.onconnectionstatechange = () => {
      if (this.manuallyClosing) {
        return;
      }

      switch (peerConnection.connectionState) {
        case "connected":
          this.clearReconnectTimer();
          this.updateConnection(
            this.sessionConfigured ? "active" : "configuring",
            this.sessionConfigured ? "连接正常" : "正在配置实时会话",
          );
          break;
        case "disconnected":
          this.updateConnection("reconnecting", "连接暂时中断，浏览器正在恢复");
          this.startReconnectTimer();
          break;
        case "failed":
          this.pauseAfterConnectionFailure("WebRTC 连接失败，请结束后重试。");
          break;
        case "closed":
          this.updateConnection("closed", "连接已关闭");
          break;
      }
    };
  }

  private attachEventChannel(channel: RTCDataChannel): void {
    if (this.eventChannels.has(channel)) {
      return;
    }

    this.eventChannels.add(channel);
    channel.onmessage = (message) => {
      if (typeof message.data !== "string") {
        return;
      }

      try {
        // 官方 WebRTC 网关会创建名为 txt 的服务端通道；若网关复用
        // 客户端发起的通道，则以首个真正收到服务端事件的通道兜底。
        if (!this.commandChannel || channel.label === "txt") {
          this.commandChannel = channel;
        }
        this.handleProviderEvent(parseQwenServerEvent(message.data));
      } catch {
        this.callbacks.onError?.({
          code: "INVALID_PROVIDER_EVENT",
          message: "收到无法解析的千问实时事件。",
          recoverable: true,
        });
      }
    };
    channel.onclose = () => {
      this.eventChannels.delete(channel);
      if (this.commandChannel === channel) {
        this.commandChannel = null;
      }
    };
  }

  private handleProviderEvent(event: QwenServerEvent): void {
    if (event.event_id && this.seenEventIds.has(event.event_id)) {
      return;
    }
    if (event.event_id) {
      this.seenEventIds.add(event.event_id);
      if (this.seenEventIds.size > 256) {
        const first = this.seenEventIds.values().next().value;
        if (first) this.seenEventIds.delete(first);
      }
    }

    this.callbacks.onProviderEvent?.("server", event);

    if (event.type === "session.created") {
      this.updateConnection("configuring", "正在应用角色和声音设置");
      void this.configureSession();
    }

    const speechStarted = qwenSpeechStartedEventSchema.safeParse(event);
    if (speechStarted.success) {
      // smart_turn 仍负责判断这是不是有效插话；客户端立即销毁当前
      // 播放管线，让已经排队的旧 RTP 音频不能在下一次恢复时重放。
      this.pendingSpeechIds.add(speechStarted.data.item_id);
      this.awaitingFreshResponseAudio = true;
      this.freshResponseId = null;
      this.interruptedResponseId ??= this.activeResponseId;
      this.syncRemoteAudioPlayback();
    }

    const speechStopped = qwenSpeechStoppedEventSchema.safeParse(event);
    if (speechStopped.success) {
      this.pendingSpeechIds.delete(speechStopped.data.item_id);
      if (speechStopped.data.reason !== "turn_invalid") {
        this.confirmedInterruptSuppressed = true;
        this.validInterruptPending = true;
      } else if (
        this.pendingSpeechIds.size === 0 &&
        !this.manualAudioSuppressed &&
        !this.confirmedInterruptSuppressed &&
        !this.validInterruptPending &&
        this.freshResponseId === null
      ) {
        // 无效附和不会产生新响应，直接从当前远端音轨的实时位置
        // 重建播放管线，不能等待不存在的 response.created。
        this.awaitingFreshResponseAudio = false;
        this.freshResponseId = null;
        this.interruptedResponseId = null;
      }
      this.syncRemoteAudioPlayback();
    }

    const responseDone = qwenResponseDoneEventSchema.safeParse(event);
    if (
      responseDone.success &&
      responseDone.data.response.status === "cancelled" &&
      responseDone.data.response.status_details.reason === "turn_detected" &&
      this.awaitingFreshResponseAudio &&
      this.freshResponseId === null &&
      (this.interruptedResponseId === null ||
        this.interruptedResponseId === responseDone.data.response.id)
    ) {
      this.confirmedInterruptSuppressed = true;
      this.validInterruptPending = true;
      this.awaitingFreshResponseAudio = true;
      this.syncRemoteAudioPlayback();
    }
    if (
      responseDone.success &&
      this.activeResponseId === responseDone.data.response.id
    ) {
      this.cancelRequested = false;
      this.activeResponseId = null;
    }

    const result = projectQwenEvent(this.projection, event);
    this.projection = result.state;

    const responseCreated = qwenResponseCreatedEventSchema.safeParse(event);
    if (responseCreated.success) {
      this.activeResponseId = responseCreated.data.response.id;
      this.manualAudioSuppressed = false;
      this.confirmedInterruptSuppressed = false;
      this.cancelRequested = false;
      if (this.awaitingFreshResponseAudio) {
        this.freshResponseId = responseCreated.data.response.id;
      }
      // response.created 只表示推理开始。远端 RTP 与 DataChannel 是
      // 独立链路，此时恢复会重新放出旧 RTP 尾音，因此继续关闸。
      this.syncRemoteAudioPlayback();
    }

    const assistantTranscriptDelta =
      qwenAssistantTranscriptDeltaSchema.safeParse(event);
    if (
      assistantTranscriptDelta.success &&
      this.awaitingFreshResponseAudio &&
      this.freshResponseId === assistantTranscriptDelta.data.response_id &&
      !this.isRemoteAudioSuppressed()
    ) {
      // 同一新响应已经开始产生音频字幕，才从仍在实时推进的 receiver
      // track 建立一个全新的播放 clone，跳过旧元素中的解码缓冲。
      this.awaitingFreshResponseAudio = false;
      this.freshResponseId = null;
      this.interruptedResponseId = null;
      this.validInterruptPending = false;
      this.syncRemoteAudioPlayback();
    }

    for (const transcript of result.commits) {
      this.callbacks.onTranscript?.(transcript);
    }

    if (event.type === "session.updated") {
      void this.activateConfiguredSession();
    }

    const providerError = qwenErrorEventSchema.safeParse(event);
    if (providerError.success) {
      const error = providerError.data.error;
      this.callbacks.onError?.({
        code: error?.code ?? error?.type ?? "QWEN_REALTIME_ERROR",
        message: error?.message ?? "千问实时会话返回错误。",
        recoverable: true,
      });
    }

    this.syncProjectionToSnapshot();
  }

  private async configureSession(): Promise<void> {
    if (this.sessionConfigurationStarted || !this.options) {
      return;
    }
    this.sessionConfigurationStarted = true;

    try {
      if (!this.microphoneSender || !this.microphoneTrack) {
        throw new ClientError("NO_AUDIO_TRACK", "麦克风音轨已经失效。");
      }

      if (!this.commandChannel) {
        throw new ClientError("NO_DATA_CHANNEL", "实时事件通道尚未建立。");
      }
      await waitForDataChannelOpen(this.commandChannel);

      const event = qwenSessionUpdateEventSchema.parse({
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
      });
      this.sendClientEvent(event);

      // 官方 WebRTC 时序要求先发送 session.update，再立即恢复 RTP sender。
      // 音轨保持 disabled，直到 session.updated 确认配置后才真正发送语音。
      this.mediaAttachPromise = this.microphoneSender.replaceTrack(
        this.microphoneTrack,
      );
      await this.mediaAttachPromise;
    } catch (error) {
      const clientError = normalizeError(error);
      this.updateConnection("error", clientError.message);
      this.callbacks.onError?.({
        code: clientError.code,
        message: clientError.message,
        recoverable: true,
      });
    }
  }

  private async activateConfiguredSession(): Promise<void> {
    if (this.sessionActivationStarted || this.sessionConfigured) {
      return;
    }
    this.sessionActivationStarted = true;

    try {
      if (!this.microphoneSender || !this.microphoneTrack) {
        throw new ClientError("NO_AUDIO_TRACK", "麦克风音轨已经失效。");
      }

      if (this.manuallyClosing) {
        return;
      }
      await this.mediaAttachPromise;
      this.mediaAttached = true;
      this.applyMicrophoneGate();
      this.sessionConfigured = true;
      this.updateConnection(
        "active",
        this.microphoneTrack.label
          ? `已连接，麦克风：${this.microphoneTrack.label}`
          : "已连接，可以开始说话",
      );

      if (
        this.options?.assistantStarts &&
        !this.options.resumed &&
        !this.initialResponseRequested
      ) {
        this.initialResponseRequested = true;
        this.sendClientEvent(
          qwenUserTextItemCreateEventSchema.parse({
            event_id: createEventId(),
            type: "conversation.item.create",
            item: {
              type: "message",
              role: "user",
              content: [
                {
                  type: "input_text",
                  text: "请根据角色设定主动、自然地向我打招呼并开始本次对话，不要提及这条指令。",
                },
              ],
            },
          }),
        );
        this.sendClientEvent(
          qwenResponseCreateEventSchema.parse({
            event_id: createEventId(),
            type: "response.create",
          }),
        );
      }
    } catch (error) {
      const clientError = normalizeError(error);
      this.updateConnection("error", clientError.message);
      this.callbacks.onError?.({
        code: clientError.code,
        message: clientError.message,
        recoverable: true,
      });
    }
  }

  private sendClientEvent(event: unknown): void {
    if (!this.commandChannel || this.commandChannel.readyState !== "open") {
      throw new ClientError("DATA_CHANNEL_NOT_OPEN", "实时事件通道尚未就绪。");
    }
    this.commandChannel.send(JSON.stringify(event));
    this.callbacks.onProviderEvent?.("client", event);
  }

  private isCommandChannelOpen(): boolean {
    return this.commandChannel?.readyState === "open";
  }

  private acceptRemoteAudioTrack(track: MediaStreamTrack): void {
    if (this.remoteAudioTrack !== track) {
      this.detachRemoteAudioPlayback();
      this.remoteAudioTrack = track;
      this.connectRemoteAudioDrain(track);
    }
    this.ensureAudioDrainRunning();
    this.syncRemoteAudioPlayback();
  }

  private prepareRemoteAudioDrain(): void {
    this.audioDrainPreparationAttempted = true;
    const audioWindow = window as typeof window & {
      webkitAudioContext?: typeof AudioContext;
    };
    const AudioContextConstructor =
      audioWindow.AudioContext ?? audioWindow.webkitAudioContext;
    if (!AudioContextConstructor) {
      return;
    }

    try {
      const context = new AudioContextConstructor();
      const gain = context.createGain();
      gain.gain.value = 0;
      gain.connect(context.destination);
      this.audioDrainContext = context;
      this.audioDrainGain = gain;
      this.registerAudioDrainVisibilityListener();
      this.ensureAudioDrainRunning();
    } catch {
      this.audioDrainContext = null;
      this.audioDrainGain = null;
    }
  }

  private ensureAudioDrainRunning(): void {
    const context = this.audioDrainContext;
    if (!context) {
      if (this.audioDrainPreparationAttempted && this.remoteAudioTrack) {
        this.reportAudioDrainFailure();
      }
      return;
    }
    if (context.state === "running") {
      if (this.remoteAudioTrack && !this.audioDrainSource) {
        this.reportAudioDrainFailure();
        return;
      }
      this.audioDrainFailureReported = false;
      this.clearAudioDrainRetryListener();
      return;
    }
    if (context.state === "closed") {
      return;
    }
    // Web Audio 允许未获用户激活的 resume() 永久 pending；只要仍未运行，
    // 就预先挂一次点击兜底，不能等待 Promise reject 后才提供恢复入口。
    this.scheduleAudioDrainRetry();
    if (this.audioDrainResumePromise) {
      return;
    }

    let resumePromise: Promise<void>;
    const attempt = ++this.audioDrainResumeAttempt;
    try {
      resumePromise = context.resume();
    } catch {
      this.reportAudioDrainFailure();
      return;
    }
    this.audioDrainResumePromise = resumePromise;
    void resumePromise
      .then(() => {
        if (
          this.audioDrainContext !== context ||
          this.audioDrainResumeAttempt !== attempt
        ) {
          return;
        }
        if (context.state === "running") {
          if (this.remoteAudioTrack && !this.audioDrainSource) {
            this.reportAudioDrainFailure();
          } else {
            this.audioDrainFailureReported = false;
            this.clearAudioDrainRetryListener();
          }
        } else {
          this.reportAudioDrainFailure();
        }
      })
      .catch(() => {
        if (
          this.audioDrainContext === context &&
          this.audioDrainResumeAttempt === attempt &&
          context.state !== "running"
        ) {
          this.reportAudioDrainFailure();
        }
      })
      .finally(() => {
        if (this.audioDrainResumePromise === resumePromise) {
          this.audioDrainResumePromise = null;
        }
      });
  }

  private reportAudioDrainFailure(): void {
    if (this.audioDrainFailureReported || !this.remoteAudioTrack) {
      return;
    }
    this.audioDrainFailureReported = true;
    this.scheduleAudioDrainRetry();
    this.callbacks.onError?.({
      code: "AUDIO_DRAIN_UNAVAILABLE",
      message: "浏览器无法保持音频清理通道，请点击页面恢复后再试。",
      recoverable: true,
    });
  }

  private scheduleAudioDrainRetry(): void {
    if (this.audioDrainRetryListener || typeof document === "undefined") {
      return;
    }
    const retry: EventListener = () => {
      this.audioDrainRetryListener = null;
      this.audioDrainFailureReported = false;
      this.audioDrainResumeAttempt += 1;
      this.audioDrainResumePromise = null;
      if (!this.audioDrainContext) {
        this.prepareRemoteAudioDrain();
      }
      if (this.remoteAudioTrack && !this.audioDrainSource) {
        this.connectRemoteAudioDrain(this.remoteAudioTrack);
      }
      this.ensureAudioDrainRunning();
    };
    this.audioDrainRetryListener = retry;
    document.addEventListener("pointerdown", retry, {
      capture: true,
      once: true,
    });
  }

  private clearAudioDrainRetryListener(): void {
    if (!this.audioDrainRetryListener || typeof document === "undefined") {
      this.audioDrainRetryListener = null;
      return;
    }
    document.removeEventListener("pointerdown", this.audioDrainRetryListener, {
      capture: true,
    });
    this.audioDrainRetryListener = null;
  }

  private registerAudioDrainVisibilityListener(): void {
    if (this.audioDrainVisibilityListener || typeof document === "undefined") {
      return;
    }
    const listener: EventListener = () => {
      if (document.visibilityState === "visible") {
        this.ensureAudioDrainRunning();
      }
    };
    this.audioDrainVisibilityListener = listener;
    document.addEventListener("visibilitychange", listener);
  }

  private clearAudioDrainVisibilityListener(): void {
    if (!this.audioDrainVisibilityListener || typeof document === "undefined") {
      this.audioDrainVisibilityListener = null;
      return;
    }
    document.removeEventListener(
      "visibilitychange",
      this.audioDrainVisibilityListener,
    );
    this.audioDrainVisibilityListener = null;
  }

  private connectRemoteAudioDrain(track: MediaStreamTrack): void {
    this.audioDrainSource?.disconnect();
    this.audioDrainSource = null;
    this.audioDrainStream = null;
    if (!this.audioDrainContext || !this.audioDrainGain) {
      if (this.audioDrainPreparationAttempted) {
        this.reportAudioDrainFailure();
      }
      return;
    }

    let source: MediaStreamAudioSourceNode | null = null;
    try {
      const stream = new MediaStream([track]);
      source = this.audioDrainContext.createMediaStreamSource(stream);
      source.connect(this.audioDrainGain);
      this.audioDrainStream = stream;
      this.audioDrainSource = source;
    } catch {
      source?.disconnect();
      this.audioDrainSource = null;
      this.audioDrainStream = null;
      this.reportAudioDrainFailure();
    }
  }

  private isRemoteAudioSuppressed(): boolean {
    return (
      this.pendingSpeechIds.size > 0 ||
      this.manualAudioSuppressed ||
      this.confirmedInterruptSuppressed
    );
  }

  private syncRemoteAudioPlayback(): void {
    if (this.isRemoteAudioSuppressed() || this.awaitingFreshResponseAudio) {
      this.detachRemoteAudioPlayback();
      return;
    }
    this.attachRemoteAudioPlayback();
  }

  private detachRemoteAudioPlayback(): void {
    this.remoteAudio.muted = true;
    if (!this.playbackAudioTrack && !this.remoteAudio.srcObject) {
      return;
    }

    this.playbackAttempt += 1;
    this.remoteAudio.pause();
    this.remoteAudio.srcObject = null;
    try {
      this.remoteAudio.load();
    } catch {
      // 部分移动浏览器会在 MediaStream 已解绑时抛出；srcObject=null
      // 已经完成关键的播放管线断开，继续清理播放 clone。
    }
    this.playbackAudioTrack?.stop();
    this.playbackAudioTrack = null;
  }

  private attachRemoteAudioPlayback(): void {
    this.ensureAudioDrainRunning();
    if (
      !this.remoteAudioTrack ||
      this.playbackAudioTrack ||
      this.remoteAudio.srcObject
    ) {
      if (this.playbackAudioTrack) {
        this.remoteAudio.muted = false;
      }
      return;
    }

    const playbackTrack = this.remoteAudioTrack.clone();
    const playbackStream = new MediaStream([playbackTrack]);
    const attempt = ++this.playbackAttempt;
    this.playbackAudioTrack = playbackTrack;
    this.remoteAudio.srcObject = playbackStream;
    this.remoteAudio.muted = false;
    this.clearPlaybackRetryListener();

    let playPromise: Promise<void>;
    try {
      playPromise = this.remoteAudio.play();
    } catch (error) {
      this.handleRemotePlaybackFailure(error, attempt);
      return;
    }
    void playPromise.catch((error: unknown) => {
      this.handleRemotePlaybackFailure(error, attempt);
    });
  }

  private handleRemotePlaybackFailure(error: unknown, attempt: number): void {
    if (attempt !== this.playbackAttempt) {
      return;
    }

    this.awaitingFreshResponseAudio = true;
    this.freshResponseId = null;
    this.detachRemoteAudioPlayback();
    this.schedulePlaybackRetry();
    this.callbacks.onError?.({
      code: "AUDIO_PLAYBACK_BLOCKED",
      message: "浏览器阻止了声音播放，请再次点击页面后重试。",
      recoverable: true,
    });
  }

  private schedulePlaybackRetry(): void {
    if (this.playbackRetryListener || typeof document === "undefined") {
      return;
    }

    const retry: EventListener = () => {
      this.playbackRetryListener = null;
      this.ensureAudioDrainRunning();
      if (this.isRemoteAudioSuppressed()) {
        return;
      }
      this.awaitingFreshResponseAudio = false;
      this.freshResponseId = null;
      this.syncRemoteAudioPlayback();
    };
    this.playbackRetryListener = retry;
    document.addEventListener("pointerdown", retry, {
      capture: true,
      once: true,
    });
  }

  private clearPlaybackRetryListener(): void {
    if (!this.playbackRetryListener || typeof document === "undefined") {
      this.playbackRetryListener = null;
      return;
    }
    document.removeEventListener("pointerdown", this.playbackRetryListener, {
      capture: true,
    });
    this.playbackRetryListener = null;
  }

  private applyMicrophoneGate(): void {
    if (!this.microphoneTrack) {
      return;
    }

    const modeAllowsAudio =
      this.snapshot.inputMode === "hands_free" || this.pushToTalkActive;
    this.microphoneTrack.enabled =
      this.mediaAttached && !this.snapshot.microphoneMuted && modeAllowsAudio;
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
    connection: RealtimeConnectionState,
    detail: string,
  ): void {
    this.snapshot = { ...this.snapshot, connection, detail };
    this.emitSnapshot();
  }

  private emitSnapshot(): void {
    this.callbacks.onSnapshot?.({ ...this.snapshot });
  }

  private startReconnectTimer(): void {
    this.clearReconnectTimer();
    this.reconnectTimer = window.setTimeout(() => {
      this.pauseAfterConnectionFailure(
        "连接在 30 秒内未恢复。本技术样例不会切换模型，请结束后重试。",
      );
    }, 30_000);
  }

  private pauseAfterConnectionFailure(message: string): void {
    this.clearReconnectTimer();
    this.snapshot = {
      ...this.snapshot,
      connection: "paused",
      activity: "idle",
      detail: message,
    };
    this.emitSnapshot();
    this.callbacks.onError?.({
      code: "CONNECTION_FAILED",
      message,
      recoverable: true,
    });
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private teardown(): void {
    this.clearReconnectTimer();
    this.abortController?.abort();
    this.abortController = null;

    for (const channel of this.eventChannels) {
      channel.onmessage = null;
      channel.onclose = null;
      channel.close();
    }
    this.eventChannels.clear();
    this.commandChannel = null;

    if (this.peerConnection) {
      this.peerConnection.onconnectionstatechange = null;
      this.peerConnection.ondatachannel = null;
      this.peerConnection.ontrack = null;
      this.peerConnection.close();
    }
    this.peerConnection = null;

    for (const track of this.mediaStream?.getTracks() ?? []) {
      track.stop();
    }
    this.mediaStream = null;
    this.microphoneTrack = null;
    this.microphoneSender = null;
    this.mediaAttachPromise = null;
    this.mediaAttached = false;

    this.pendingSpeechIds.clear();
    this.manualAudioSuppressed = false;
    this.confirmedInterruptSuppressed = false;
    this.cancelRequested = false;
    this.awaitingFreshResponseAudio = false;
    this.freshResponseId = null;
    this.activeResponseId = null;
    this.interruptedResponseId = null;
    this.validInterruptPending = false;
    this.clearPlaybackRetryListener();
    this.clearAudioDrainRetryListener();
    this.clearAudioDrainVisibilityListener();
    this.detachRemoteAudioPlayback();
    this.remoteAudioTrack = null;
    this.remoteAudio.muted = false;
    this.audioDrainSource?.disconnect();
    this.audioDrainGain?.disconnect();
    const audioDrainContext = this.audioDrainContext;
    this.audioDrainSource = null;
    this.audioDrainGain = null;
    this.audioDrainStream = null;
    this.audioDrainContext = null;
    this.audioDrainPreparationAttempted = false;
    this.audioDrainResumePromise = null;
    this.audioDrainResumeAttempt += 1;
    this.audioDrainFailureReported = false;
    void audioDrainContext?.close().catch(() => undefined);

    this.options = null;
    this.sessionConfigurationStarted = false;
    this.sessionActivationStarted = false;
    this.sessionConfigured = false;
    this.initialResponseRequested = false;
    this.pushToTalkActive = false;
    this.seenEventIds.clear();
  }
}

export function getCharacterRealtimeSessionUrl(
  characterId: string,
  conversationId?: string,
  writer?: { clientId: string; epoch: number },
): string {
  const path = `/api/characters/${encodeURIComponent(characterId)}/realtime/sessions`;
  if (!conversationId) return path;
  const query = new URLSearchParams({ conversationId });
  if (writer) {
    query.set("clientId", writer.clientId);
    query.set("epoch", String(writer.epoch));
  }
  return `${path}?${query}`;
}

class ClientError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ClientError";
  }
}

function normalizeError(error: unknown): ClientError {
  if (error instanceof ClientError) {
    return error;
  }
  if (error instanceof DOMException && error.name === "NotAllowedError") {
    return new ClientError(
      "MICROPHONE_PERMISSION_DENIED",
      "麦克风权限被拒绝，请在浏览器设置中允许后重试。",
    );
  }
  if (
    error instanceof DOMException &&
    (error.name === "NotFoundError" || error.name === "OverconstrainedError")
  ) {
    return new ClientError(
      "MICROPHONE_UNAVAILABLE",
      "选择的麦克风不可用，请刷新设备后重新选择。",
    );
  }
  if (error instanceof Error) {
    return new ClientError("REALTIME_CLIENT_ERROR", error.message);
  }
  return new ClientError("REALTIME_CLIENT_ERROR", "实时会话发生未知错误。");
}

function readGatewayError(input: string, status: number): ClientError {
  try {
    const value = JSON.parse(input) as Record<string, unknown>;
    const code = typeof value.code === "string" ? value.code : "GATEWAY_ERROR";
    const message =
      typeof value.message === "string"
        ? value.message
        : `实时会话握手失败（HTTP ${status}）。`;
    return new ClientError(code, message);
  } catch {
    return new ClientError(
      "GATEWAY_ERROR",
      `实时会话握手失败（HTTP ${status}）。`,
    );
  }
}

function createEventId(): string {
  return `event_${crypto.randomUUID().replaceAll("-", "")}`;
}

async function waitForIceGatheringComplete(
  peerConnection: RTCPeerConnection,
): Promise<void> {
  if (peerConnection.iceGatheringState === "complete") {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      cleanup();
      reject(new ClientError("ICE_GATHERING_TIMEOUT", "ICE 信息收集超时。"));
    }, 10_000);
    const handleStateChange = (): void => {
      if (peerConnection.iceGatheringState === "complete") {
        cleanup();
        resolve();
      }
    };
    const cleanup = (): void => {
      window.clearTimeout(timeout);
      peerConnection.removeEventListener(
        "icegatheringstatechange",
        handleStateChange,
      );
    };

    peerConnection.addEventListener(
      "icegatheringstatechange",
      handleStateChange,
    );
  });
}

async function waitForDataChannelOpen(channel: RTCDataChannel): Promise<void> {
  if (channel.readyState === "open") {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      cleanup();
      reject(new ClientError("DATA_CHANNEL_TIMEOUT", "实时事件通道打开超时。"));
    }, 5_000);
    const handleOpen = (): void => {
      cleanup();
      resolve();
    };
    const handleClose = (): void => {
      cleanup();
      reject(new ClientError("DATA_CHANNEL_CLOSED", "实时事件通道已关闭。"));
    };
    const cleanup = (): void => {
      window.clearTimeout(timeout);
      channel.removeEventListener("open", handleOpen);
      channel.removeEventListener("close", handleClose);
    };

    channel.addEventListener("open", handleOpen);
    channel.addEventListener("close", handleClose);
  });
}
