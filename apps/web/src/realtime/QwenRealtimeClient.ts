import {
  parseQwenServerEvent,
  qwenErrorEventSchema,
  qwenSessionUpdateEventSchema,
  type QwenRealtimeModel,
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

export type InputMode = "hands_free" | "push_to_talk";

export type QwenRealtimeOptions = {
  model: QwenRealtimeModel;
  voice: string;
  instructions: string;
  inputMode: InputMode;
  assistantStarts: boolean;
};

export type RealtimeClientSnapshot = {
  connection: RealtimeConnectionState;
  activity: RealtimeActivity;
  detail: string;
  userCaption: string;
  assistantCaption: string;
  microphoneMuted: boolean;
  inputMode: InputMode;
};

export const initialClientSnapshot: RealtimeClientSnapshot = {
  connection: "idle",
  activity: "idle",
  detail: "尚未开始",
  userCaption: "",
  assistantCaption: "",
  microphoneMuted: false,
  inputMode: "hands_free",
};

type Direction = "client" | "server";

export type QwenRealtimeCallbacks = {
  onSnapshot?: (snapshot: RealtimeClientSnapshot) => void;
  onTranscript?: (transcript: PendingTranscript) => void;
  onProviderEvent?: (direction: Direction, event: unknown) => void;
  onError?: (error: RealtimeError) => void;
};

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

  constructor(
    private readonly remoteAudio: HTMLAudioElement,
    private readonly callbacks: QwenRealtimeCallbacks = {},
  ) {}

  async start(options: QwenRealtimeOptions): Promise<void> {
    this.teardown();
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
      this.mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: false,
      });
      this.microphoneTrack = this.mediaStream.getAudioTracks()[0] ?? null;
      if (!this.microphoneTrack) {
        throw new ClientError("NO_AUDIO_TRACK", "没有获得可用的麦克风音轨。");
      }

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
        `/api/realtime/qwen/sessions?model=${encodeURIComponent(options.model)}`,
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
    if (!this.projection.responseActive || !this.isCommandChannelOpen()) {
      return;
    }

    this.remoteAudio.muted = true;
    this.sendClientEvent({
      event_id: createEventId(),
      type: "response.cancel",
    });
    this.projection = {
      ...this.projection,
      responseActive: false,
      activity: "listening",
    };
    this.syncProjectionToSnapshot();
  }

  private bindPeerConnection(peerConnection: RTCPeerConnection): void {
    peerConnection.ondatachannel = ({ channel }) => {
      if (channel.label === "txt" || !this.commandChannel) {
        this.commandChannel = channel;
      }
      this.attachEventChannel(channel);
    };

    peerConnection.ontrack = ({ track, streams }) => {
      if (track.kind !== "audio") {
        return;
      }

      this.remoteAudio.srcObject = streams[0] ?? new MediaStream([track]);
      void this.remoteAudio.play().catch(() => {
        this.callbacks.onError?.({
          code: "AUDIO_PLAYBACK_BLOCKED",
          message: "浏览器阻止了声音播放，请再次点击页面后重试。",
          recoverable: true,
        });
      });
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

    const result = projectQwenEvent(this.projection, event);
    this.projection = result.state;

    if (event.type === "response.created") {
      this.remoteAudio.muted = false;
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

      // turn_detection 只能在首个音频包前设置；等服务端确认配置后再恢复 RTP。
      await this.microphoneSender.replaceTrack(this.microphoneTrack);
      if (this.manuallyClosing) {
        return;
      }
      this.mediaAttached = true;
      this.applyMicrophoneGate();
      this.sessionConfigured = true;
      this.updateConnection("active", "已连接，可以开始说话");

      if (this.options?.assistantStarts && !this.initialResponseRequested) {
        this.initialResponseRequested = true;
        this.sendClientEvent({
          event_id: createEventId(),
          type: "response.create",
        });
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
    this.mediaAttached = false;

    this.remoteAudio.pause();
    this.remoteAudio.srcObject = null;
    this.remoteAudio.muted = false;

    this.options = null;
    this.sessionConfigurationStarted = false;
    this.sessionActivationStarted = false;
    this.sessionConfigured = false;
    this.initialResponseRequested = false;
    this.pushToTalkActive = false;
    this.seenEventIds.clear();
  }
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
