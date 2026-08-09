import {
  qwenRealtimePublicConfigSchema,
  type QwenRealtimeModel,
  type QwenRealtimePublicConfig,
  type RealtimeConnectionState,
  type TranscriptSegment,
} from "@meet/protocol";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { registerSW } from "virtual:pwa-register";

import {
  initialClientSnapshot,
  QwenRealtimeClient,
  type InputMode,
  type RealtimeClientSnapshot,
} from "./realtime/QwenRealtimeClient.js";

type EventLogEntry = {
  id: string;
  at: string;
  direction: "client" | "server";
  payload: string;
};

type MicrophoneOption = {
  deviceId: string;
  label: string;
};

const connectionLabels: Record<RealtimeConnectionState, string> = {
  idle: "未开始",
  requesting_microphone: "请求麦克风",
  connecting: "连接中",
  configuring: "配置角色",
  active: "通话中",
  reconnecting: "恢复连接",
  paused: "已暂停",
  closed: "已结束",
  error: "发生错误",
};

const activityLabels = {
  idle: "安静等待",
  listening: "正在聆听",
  user_speaking: "你正在说话",
  thinking: "正在思考",
  assistant_speaking: "角色正在说话",
} as const;

export default function App() {
  const audioRef = useRef<HTMLAudioElement>(null);
  const clientRef = useRef<QwenRealtimeClient | null>(null);
  const updateServiceWorkerRef = useRef<
    ((reloadPage?: boolean) => Promise<void>) | null
  >(null);

  const [publicConfig, setPublicConfig] =
    useState<QwenRealtimePublicConfig | null>(null);
  const [configError, setConfigError] = useState("");
  const [snapshot, setSnapshot] = useState<RealtimeClientSnapshot>(
    initialClientSnapshot,
  );
  const [hasClient, setHasClient] = useState(false);
  const [model, setModel] = useState<QwenRealtimeModel>(
    "qwen-audio-3.0-realtime-plus",
  );
  const [voice, setVoice] = useState("longanqian");
  const [instructions, setInstructions] = useState(
    "你是一位自然、耐心、有角色感的中文聊天伙伴。先听清用户再回答，默认简短口语化，不要像客服或说明书。",
  );
  const [assistantStarts, setAssistantStarts] = useState(true);
  const [inputMode, setInputModeState] = useState<InputMode>(() => {
    const saved = window.localStorage.getItem("meet.inputMode");
    return saved === "push_to_talk" ? "push_to_talk" : "hands_free";
  });
  const [microphones, setMicrophones] = useState<MicrophoneOption[]>([]);
  const [selectedMicrophoneId, setSelectedMicrophoneId] = useState(
    () => window.localStorage.getItem("meet.microphoneDeviceId") ?? "",
  );
  const [microphoneListError, setMicrophoneListError] = useState("");
  const [history, setHistory] = useState<TranscriptSegment[]>([]);
  const [eventLog, setEventLog] = useState<EventLogEntry[]>([]);
  const [errorMessage, setErrorMessage] = useState("");
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const [offlineReady, setOfflineReady] = useState(false);

  const refreshMicrophones = useCallback(async (): Promise<void> => {
    if (!navigator.mediaDevices?.enumerateDevices) {
      setMicrophoneListError("当前浏览器不支持列出麦克风设备。");
      return;
    }

    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const audioInputs = devices
        .filter(
          (device) =>
            device.kind === "audioinput" && device.deviceId !== "default",
        )
        .map((device, index) => ({
          deviceId: device.deviceId,
          label: device.label.trim() || `麦克风 ${index + 1}`,
        }));

      setMicrophones(audioInputs);
      setSelectedMicrophoneId((current) => {
        if (
          !current ||
          audioInputs.some(({ deviceId }) => deviceId === current)
        ) {
          return current;
        }
        window.localStorage.removeItem("meet.microphoneDeviceId");
        return "";
      });
      setMicrophoneListError("");
    } catch (error) {
      setMicrophoneListError(
        error instanceof Error ? error.message : "无法读取麦克风设备。",
      );
    }
  }, []);

  const authorizeAndRefreshMicrophones = async (): Promise<void> => {
    if (!navigator.mediaDevices?.getUserMedia) {
      setMicrophoneListError("当前浏览器不支持麦克风采集。");
      return;
    }

    try {
      const probeStream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: false,
      });
      probeStream.getTracks().forEach((track) => track.stop());
      await refreshMicrophones();
    } catch (error) {
      setMicrophoneListError(
        error instanceof Error ? error.message : "麦克风授权失败。",
      );
    }
  };

  useEffect(() => {
    let cancelled = false;

    void fetch("/api/realtime/qwen/config")
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(`读取服务端配置失败（HTTP ${response.status}）。`);
        }
        return qwenRealtimePublicConfigSchema.parse(await response.json());
      })
      .then((config) => {
        if (cancelled) return;
        setPublicConfig(config);
        setModel(config.model);
        setVoice(config.voice);
        setInstructions(config.defaultInstructions);
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setConfigError(
            error instanceof Error ? error.message : "无法读取服务端配置。",
          );
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const mediaDevices = navigator.mediaDevices;
    const handleDeviceChange = (): void => {
      void refreshMicrophones();
    };

    void refreshMicrophones();
    mediaDevices?.addEventListener("devicechange", handleDeviceChange);
    return () => {
      mediaDevices?.removeEventListener("devicechange", handleDeviceChange);
    };
  }, [refreshMicrophones]);

  useEffect(() => {
    updateServiceWorkerRef.current = registerSW({
      immediate: true,
      onNeedRefresh: () => setUpdateAvailable(true),
      onOfflineReady: () => setOfflineReady(true),
    });
  }, []);

  useEffect(
    () => () => {
      void clientRef.current?.close();
    },
    [],
  );

  const readyToStart = Boolean(
    publicConfig?.enabled &&
    publicConfig.configured &&
    audioRef.current &&
    !hasClient,
  );
  const configState = useMemo(() => {
    if (configError) return { label: "API 不可用", tone: "error" };
    if (!publicConfig) return { label: "读取配置", tone: "neutral" };
    if (!publicConfig.enabled) return { label: "样例未启用", tone: "warning" };
    if (!publicConfig.configured)
      return { label: "等待填写密钥", tone: "warning" };
    return { label: "服务端已就绪", tone: "success" };
  }, [configError, publicConfig]);

  const startCall = async (): Promise<void> => {
    if (!audioRef.current || !publicConfig || !readyToStart) {
      return;
    }

    setErrorMessage("");
    setHistory([]);
    setEventLog([]);

    const client = new QwenRealtimeClient(audioRef.current, {
      onSnapshot: setSnapshot,
      onTranscript: ({ speaker, text }) => {
        setHistory((current) => [
          ...current,
          {
            id: createLocalId(),
            speaker,
            text,
            createdAt: new Date().toISOString(),
          },
        ]);
      },
      onProviderEvent: (direction, event) => {
        const entry: EventLogEntry = {
          id: createLocalId(),
          at: new Date().toLocaleTimeString("zh-CN", { hour12: false }),
          direction,
          payload: JSON.stringify(event),
        };
        setEventLog((current) => [...current.slice(-79), entry]);
      },
      onError: (error) => setErrorMessage(error.message),
    });

    clientRef.current = client;
    setHasClient(true);
    try {
      await client.start({
        model,
        voice: voice.trim(),
        instructions: instructions.trim(),
        inputMode,
        assistantStarts,
        audioInputDeviceId: selectedMicrophoneId || undefined,
      });
      void refreshMicrophones();
    } catch {
      clientRef.current = null;
      setHasClient(false);
    }
  };

  const endCall = async (): Promise<void> => {
    const client = clientRef.current;
    clientRef.current = null;
    setHasClient(false);
    await client?.close();
  };

  const setInputMode = (nextMode: InputMode): void => {
    if (hasClient) {
      return;
    }
    setInputModeState(nextMode);
    window.localStorage.setItem("meet.inputMode", nextMode);
  };

  const selectMicrophone = (deviceId: string): void => {
    setSelectedMicrophoneId(deviceId);
    if (deviceId) {
      window.localStorage.setItem("meet.microphoneDeviceId", deviceId);
    } else {
      window.localStorage.removeItem("meet.microphoneDeviceId");
    }
  };

  const toggleMute = (): void => {
    clientRef.current?.setMicrophoneMuted(!snapshot.microphoneMuted);
  };

  const beginPushToTalk = (
    event: ReactPointerEvent<HTMLButtonElement>,
  ): void => {
    event.currentTarget.setPointerCapture(event.pointerId);
    clientRef.current?.setPushToTalkActive(true);
  };

  const endPushToTalk = (): void => {
    clientRef.current?.setPushToTalkActive(false);
  };

  return (
    <div className="app-shell">
      <header className="topbar">
        <a className="brand" href="#top" aria-label="Meet 首页">
          <span className="brand-mark">M</span>
          <span>
            <strong>Meet</strong>
            <small>Realtime Lab</small>
          </span>
        </a>
        <div className={`config-badge ${configState.tone}`}>
          <span className="status-dot" />
          {configState.label}
        </div>
      </header>

      <main id="top" className="workspace">
        <section className="stage" aria-label="实时通话舞台">
          <div className="stage-glow stage-glow-one" />
          <div className="stage-glow stage-glow-two" />

          <div className="call-status">
            <span className={`live-dot connection-${snapshot.connection}`} />
            <span>{connectionLabels[snapshot.connection]}</span>
            <span className="status-separator">·</span>
            <span>{activityLabels[snapshot.activity]}</span>
          </div>

          <div className={`portrait activity-${snapshot.activity}`}>
            <div className="portrait-ring ring-one" />
            <div className="portrait-ring ring-two" />
            <div className="portrait-face">
              <span className="portrait-letter">M</span>
              <span className="portrait-spark spark-one" />
              <span className="portrait-spark spark-two" />
            </div>
          </div>

          <div className="caption-area" aria-live="polite">
            {snapshot.userCaption && (
              <p className="user-caption">你：{snapshot.userCaption}</p>
            )}
            <p className="assistant-caption">
              {snapshot.assistantCaption || getCaptionPlaceholder(snapshot)}
            </p>
            <p className="connection-detail">{snapshot.detail}</p>
          </div>

          <div className="mode-switch" aria-label="语音输入模式">
            <button
              className={inputMode === "hands_free" ? "selected" : ""}
              type="button"
              disabled={hasClient}
              onClick={() => setInputMode("hands_free")}
            >
              免提对话
            </button>
            <button
              className={inputMode === "push_to_talk" ? "selected" : ""}
              type="button"
              disabled={hasClient}
              onClick={() => setInputMode("push_to_talk")}
            >
              按住说话
            </button>
          </div>

          <div className="call-controls">
            {!hasClient ? (
              <button
                className="primary-call-button"
                type="button"
                disabled={
                  !readyToStart || !voice.trim() || !instructions.trim()
                }
                onClick={() => void startCall()}
              >
                <span className="button-icon">↗</span>
                开始通话
              </button>
            ) : (
              <>
                <button
                  className={`round-control ${snapshot.microphoneMuted ? "active" : ""}`}
                  type="button"
                  onClick={toggleMute}
                  aria-label={
                    snapshot.microphoneMuted ? "打开麦克风" : "静音麦克风"
                  }
                >
                  {snapshot.microphoneMuted ? "静" : "麦"}
                </button>

                {inputMode === "push_to_talk" && (
                  <button
                    className="push-to-talk-button"
                    type="button"
                    disabled={
                      snapshot.connection !== "active" ||
                      snapshot.microphoneMuted
                    }
                    onPointerDown={beginPushToTalk}
                    onPointerUp={endPushToTalk}
                    onPointerCancel={endPushToTalk}
                    onLostPointerCapture={endPushToTalk}
                  >
                    按住说话
                  </button>
                )}

                <button
                  className="round-control stop-response"
                  type="button"
                  onClick={() => clientRef.current?.interrupt()}
                  aria-label="停止角色说话"
                >
                  ■
                </button>
                <button
                  className="end-call-button"
                  type="button"
                  onClick={() => void endCall()}
                >
                  结束
                </button>
              </>
            )}
          </div>
        </section>

        <aside className="lab-panel" aria-label="技术验证设置">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">QWEN AUDIO 3.0 WEBRTC SPIKE</p>
              <h1>实时语音实验室</h1>
            </div>
            <span className="version-chip">v0.1</span>
          </div>
          <p className="panel-intro">
            先验证自然度、打断、字幕和连接体验。这里的角色设定只在本次通话生效。
          </p>

          {!window.isSecureContext && (
            <div className="notice error-notice">
              非安全上下文无法稳定使用麦克风。请通过 localhost 或 HTTPS 打开。
            </div>
          )}
          {configError && (
            <div className="notice error-notice">{configError}</div>
          )}
          {publicConfig && !publicConfig.enabled && (
            <div className="notice warning-notice">
              请在 <code>.env</code> 中设置{" "}
              <code>REALTIME_SPIKE_ENABLED=true</code>。
            </div>
          )}
          {publicConfig?.enabled && !publicConfig.configured && (
            <div className="notice warning-notice">
              请在服务端 <code>.env</code> 填写 API Key 和获批的 WebRTC
              Endpoint；它们不会发送到浏览器。
            </div>
          )}
          {errorMessage && (
            <div className="notice error-notice" role="alert">
              {errorMessage}
            </div>
          )}

          <fieldset className="settings-group" disabled={hasClient}>
            <label className="field-label" htmlFor="model">
              实时模型
            </label>
            <select
              id="model"
              value={model}
              onChange={(event) =>
                setModel(event.target.value as QwenRealtimeModel)
              }
            >
              {(
                publicConfig?.availableModels ?? [
                  "qwen-audio-3.0-realtime-plus",
                  "qwen-audio-3.0-realtime-flash",
                ]
              ).map((availableModel) => (
                <option key={availableModel} value={availableModel}>
                  {availableModel === "qwen-audio-3.0-realtime-plus"
                    ? "Qwen Audio 3.0 Plus · 质量优先"
                    : "Qwen Audio 3.0 Flash · 速度优先"}
                </option>
              ))}
            </select>

            <label className="field-label" htmlFor="voice">
              预设声音
            </label>
            <input
              id="voice"
              value={voice}
              onChange={(event) => setVoice(event.target.value)}
              placeholder="longanqian"
              autoComplete="off"
            />

            <label className="field-label" htmlFor="microphone">
              麦克风
            </label>
            <div className="field-with-action">
              <select
                id="microphone"
                value={selectedMicrophoneId}
                onChange={(event) => selectMicrophone(event.target.value)}
              >
                <option value="">浏览器默认</option>
                {microphones.map((microphone) => (
                  <option key={microphone.deviceId} value={microphone.deviceId}>
                    {microphone.label}
                  </option>
                ))}
              </select>
              <button
                type="button"
                onClick={() => void authorizeAndRefreshMicrophones()}
              >
                刷新设备
              </button>
            </div>
            <small className="field-hint">
              {snapshot.microphoneLabel
                ? `当前使用：${snapshot.microphoneLabel}`
                : "若设备名称未显示，请刷新设备并允许麦克风权限。"}
            </small>
            {microphoneListError && (
              <small className="field-error">{microphoneListError}</small>
            )}

            <label className="field-label" htmlFor="instructions">
              角色设定
            </label>
            <textarea
              id="instructions"
              value={instructions}
              onChange={(event) => setInstructions(event.target.value)}
              rows={6}
            />

            <label className="check-field">
              <input
                type="checkbox"
                checked={assistantStarts}
                onChange={(event) => setAssistantStarts(event.target.checked)}
              />
              <span>
                <strong>由角色先打招呼</strong>
                <small>会话配置成功后注入开场请求并生成自然问候</small>
              </span>
            </label>
          </fieldset>

          <details className="diagnostic-section" open>
            <summary>
              <span>完整字幕</span>
              <span className="count-chip">{history.length}</span>
            </summary>
            <div className="transcript-list">
              {history.length === 0 ? (
                <p className="empty-state">完成一句话后会显示在这里。</p>
              ) : (
                history.map((item) => (
                  <article
                    className={`transcript ${item.speaker}`}
                    key={item.id}
                  >
                    <span>{item.speaker === "user" ? "你" : "角色"}</span>
                    <p>{item.text}</p>
                  </article>
                ))
              )}
            </div>
          </details>

          <details className="diagnostic-section event-section">
            <summary>
              <span>原始事件</span>
              <span className="count-chip">{eventLog.length}</span>
            </summary>
            <div className="event-log">
              {eventLog.length === 0 ? (
                <p className="empty-state">DataChannel 事件会显示在这里。</p>
              ) : (
                [...eventLog].reverse().map((entry) => (
                  <div className="event-entry" key={entry.id}>
                    <span className={`direction ${entry.direction}`}>
                      {entry.direction === "client" ? "发送" : "接收"}
                    </span>
                    <time>{entry.at}</time>
                    <code>{entry.payload}</code>
                  </div>
                ))
              )}
            </div>
          </details>
        </aside>
      </main>

      {(updateAvailable || offlineReady) && (
        <div className="pwa-toast">
          <p>
            {updateAvailable
              ? "Meet 有新版本。当前通话不会被自动刷新。"
              : "应用外壳已可离线打开；实时聊天仍需要联网。"}
          </p>
          {updateAvailable && (
            <button
              type="button"
              disabled={hasClient}
              onClick={() => void updateServiceWorkerRef.current?.(true)}
            >
              {hasClient ? "通话结束后更新" : "立即更新"}
            </button>
          )}
          <button
            className="toast-dismiss"
            type="button"
            onClick={() => {
              setUpdateAvailable(false);
              setOfflineReady(false);
            }}
          >
            稍后
          </button>
        </div>
      )}

      <audio ref={audioRef} autoPlay playsInline className="remote-audio" />
    </div>
  );
}

function getCaptionPlaceholder(snapshot: RealtimeClientSnapshot): string {
  if (snapshot.connection === "active") {
    if (snapshot.activity === "thinking") return "让我想一想…";
    if (snapshot.activity === "assistant_speaking") return "…";
    if (snapshot.inputMode === "push_to_talk") return "按住下方按钮开始说话。";
    return "我在听，你可以直接说话。";
  }
  if (snapshot.connection === "connecting")
    return "正在跨过网络，去见你的角色…";
  if (snapshot.connection === "configuring") return "正在让角色准备好声音…";
  return "设置一个角色，然后开始真正的实时对话。";
}

function createLocalId(): string {
  return crypto.randomUUID();
}
