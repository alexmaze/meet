import type {
  CharacterRuntimeResponse,
  ConversationMode,
  RealtimeConnectionState,
  RealtimeProvidersResponse,
  TranscriptSegment,
  UserAccount,
} from "@meet/protocol";
import { realtimeProvidersResponseSchema } from "@meet/protocol";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from "react";

import { mapRuntimeToLaunchOptions } from "../characters/character-logic.js";
import {
  ConversationApiError,
  appendConversationMessages,
  completeConversation,
  createConversation,
} from "../history/conversation-api.js";
import TeachingCallControls from "../teaching/TeachingCallControls.js";
import {
  getTeachingAvailability,
  persistThenMuteTeaching,
  prepareConversationTeaching,
  TeachingApiError,
} from "../teaching/teaching-api.js";
import {
  initialTeachingCallState,
  resolveCallTeachingChoice,
  unavailableTeachingAvailability,
  type TeachingAvailability,
  type TeachingCallState,
  type TeachingChoice,
} from "../teaching/teaching-state.js";
import {
  initialClientSnapshot,
  type InputMode,
  type RealtimeClient,
  type RealtimeClientCallbacks,
  type RealtimeClientSnapshot,
} from "./QwenRealtimeClient.js";
import { DoubaoRealtimeClient } from "./DoubaoRealtimeClient.js";
import { QwenWebSocketRealtimeClient } from "./QwenWebSocketRealtimeClient.js";
import { selectVisibleAssistantCaption } from "./caption-display.js";

type EventLogEntry = {
  id: string;
  at: string;
  direction: "client" | "server";
  payload: string;
};

type MicrophoneOption = { deviceId: string; label: string };

type PendingPersistedMessage = {
  id: string;
  sequence: number;
  role: "user" | "assistant";
  status: "completed" | "interrupted";
  text: string;
  providerEventId: string | null;
  createdAt: string;
};

type ConversationPersistence = {
  id: string;
  nextSequence: number;
  acknowledgedSequence: number;
  pending: PendingPersistedMessage[];
  flushing: Promise<void> | null;
};

type CharacterCallProps = {
  runtime: CharacterRuntimeResponse;
  user: UserAccount;
  onExit: () => void;
  onUnauthorized: () => void;
};

const connectionLabels: Record<RealtimeConnectionState, string> = {
  idle: "准备就绪",
  requesting_microphone: "请求麦克风",
  connecting: "连接中",
  configuring: "正在唤醒角色",
  active: "通话中",
  reconnecting: "正在恢复",
  paused: "已暂停",
  closed: "已结束",
  error: "发生错误",
};

const activityLabels = {
  idle: "安静等待",
  listening: "正在听你说",
  user_speaking: "你正在说话",
  thinking: "正在思考",
  assistant_speaking: "正在回应",
} as const;

export default function CharacterCall({
  runtime,
  user,
  onExit,
  onUnauthorized,
}: CharacterCallProps) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const clientRef = useRef<RealtimeClient | null>(null);
  const persistenceRef = useRef<ConversationPersistence | null>(null);
  const [snapshot, setSnapshot] = useState<RealtimeClientSnapshot>(
    initialClientSnapshot,
  );
  const [hasClient, setHasClient] = useState(false);
  const [inputMode, setInputModeState] = useState<InputMode>(() => {
    const saved = window.localStorage.getItem("meet.inputMode");
    return saved === "push_to_talk" ? "push_to_talk" : "hands_free";
  });
  const [conversationMode, setConversationMode] =
    useState<ConversationMode>("normal");
  const [microphones, setMicrophones] = useState<MicrophoneOption[]>([]);
  const [selectedMicrophoneId, setSelectedMicrophoneId] = useState(
    () => window.localStorage.getItem("meet.microphoneDeviceId") ?? "",
  );
  const [microphoneListError, setMicrophoneListError] = useState("");
  const [history, setHistory] = useState<TranscriptSegment[]>([]);
  const [eventLog, setEventLog] = useState<EventLogEntry[]>([]);
  const [errorMessage, setErrorMessage] = useState("");
  const [persistenceError, setPersistenceError] = useState("");
  const [providerConfig, setProviderConfig] =
    useState<RealtimeProvidersResponse | null>(null);
  const [configError, setConfigError] = useState("");
  const [toolsOpen, setToolsOpen] = useState(false);
  const [callStarting, setCallStarting] = useState(false);
  const [teachingAvailability, setTeachingAvailability] =
    useState<TeachingAvailability | null>(null);
  const [teachingAvailabilityLoading, setTeachingAvailabilityLoading] =
    useState(user.accountType === "child");
  const [teachingAvailabilityError, setTeachingAvailabilityError] =
    useState(false);
  const [teachingAvailabilityReload, setTeachingAvailabilityReload] =
    useState(0);
  const [teachingChoice, setTeachingChoice] = useState<TeachingChoice | null>(
    null,
  );
  const [teachingState, setTeachingState] = useState<TeachingCallState>(() =>
    initialTeachingCallState(unavailableTeachingAvailability(), "chat_only"),
  );
  const [teachingActionPending, setTeachingActionPending] = useState<
    "request" | "mute" | null
  >(null);

  const character = runtime.character;
  const launch = mapRuntimeToLaunchOptions(runtime);
  const visibleAssistantCaption = selectVisibleAssistantCaption(
    snapshot,
    history,
  );
  const captionPlaceholder = getCaptionPlaceholder(snapshot, character.name);
  const realtimeProvider = launch.ok ? launch.provider : null;

  useEffect(() => {
    if (user.accountType !== "child") {
      setTeachingAvailabilityLoading(false);
      return;
    }
    const controller = new AbortController();
    setTeachingAvailability(null);
    setTeachingAvailabilityLoading(true);
    setTeachingAvailabilityError(false);
    void getTeachingAvailability(character.id, controller.signal)
      .then((availability) => {
        setTeachingAvailability(
          realtimeProvider === "doubao"
            ? unavailableTeachingAvailability()
            : availability,
        );
        setTeachingAvailabilityLoading(false);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        if (error instanceof TeachingApiError && error.status === 401) {
          onUnauthorized();
          return;
        }
        setTeachingAvailability(unavailableTeachingAvailability());
        setTeachingAvailabilityError(true);
        setTeachingAvailabilityLoading(false);
      });
    return () => controller.abort();
  }, [
    character.id,
    onUnauthorized,
    realtimeProvider,
    teachingAvailabilityReload,
    user.accountType,
  ]);

  useEffect(() => {
    const controller = new AbortController();
    setConfigError("");
    void fetch("/api/realtime/providers", {
      credentials: "same-origin",
      cache: "no-store",
      headers: { Accept: "application/json" },
      signal: controller.signal,
    })
      .then(async (response) => {
        if (response.status === 401) {
          onUnauthorized();
          throw new Error("登录状态已失效。");
        }
        if (!response.ok) {
          throw new Error("无法确认实时服务状态。");
        }
        const parsed = realtimeProvidersResponseSchema.safeParse(
          await response.json(),
        );
        if (!parsed.success) {
          throw new Error("实时服务状态格式不正确。");
        }
        return parsed.data;
      })
      .then(setProviderConfig)
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        const message =
          error instanceof Error &&
          [
            "登录状态已失效。",
            "无法确认实时服务状态。",
            "实时服务状态格式不正确。",
          ].includes(error.message)
            ? error.message
            : "无法确认实时服务状态。";
        setConfigError(message);
      });
    return () => controller.abort();
  }, [onUnauthorized]);

  const selectedProviderConfig = launch.ok
    ? providerConfig?.providers.find(
        ({ provider }) => provider === launch.provider,
      )
    : undefined;

  const refreshMicrophones = useCallback(async (): Promise<void> => {
    if (!navigator.mediaDevices?.enumerateDevices) {
      setMicrophoneListError("当前浏览器不支持列出麦克风设备。");
      return;
    }
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const options = devices
        .filter(
          (device) =>
            device.kind === "audioinput" && device.deviceId !== "default",
        )
        .map((device, index) => ({
          deviceId: device.deviceId,
          label: device.label.trim() || `麦克风 ${index + 1}`,
        }));
      setMicrophones(options);
      setSelectedMicrophoneId((current) => {
        if (!current || options.some((option) => option.deviceId === current))
          return current;
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

  useEffect(() => {
    const mediaDevices = navigator.mediaDevices;
    const handleDeviceChange = () => void refreshMicrophones();
    void refreshMicrophones();
    mediaDevices?.addEventListener("devicechange", handleDeviceChange);
    return () =>
      mediaDevices?.removeEventListener("devicechange", handleDeviceChange);
  }, [refreshMicrophones]);

  useEffect(
    () => () => {
      void clientRef.current?.close();
    },
    [],
  );

  const flushPersistence = async (): Promise<void> => {
    const persistence = persistenceRef.current;
    if (!persistence) return;
    if (persistence.flushing) return persistence.flushing;

    const flush = (async () => {
      while (
        persistenceRef.current === persistence &&
        persistence.pending.length > 0
      ) {
        const message = persistence.pending[0];
        if (!message) break;
        let lastError: unknown;
        for (let attempt = 0; attempt < 3; attempt += 1) {
          try {
            const acknowledgedSequence = await appendConversationMessages(
              persistence.id,
              { messages: [message] },
            );
            persistence.acknowledgedSequence = acknowledgedSequence;
            persistence.pending.shift();
            setPersistenceError("");
            lastError = undefined;
            break;
          } catch (error) {
            lastError = error;
            if (error instanceof ConversationApiError && error.status === 401) {
              onUnauthorized();
              throw error;
            }
            if (attempt < 2) await delay(500 * 2 ** attempt);
          }
        }
        if (lastError) {
          setPersistenceError(
            "文字记录暂时没有同步成功；保持页面打开时会在下一条字幕出现后继续重试。",
          );
          throw lastError;
        }
      }
    })().finally(() => {
      if (persistenceRef.current === persistence) persistence.flushing = null;
    });
    persistence.flushing = flush;
    return flush;
  };

  const queueTranscript = (transcript: {
    speaker: "user" | "assistant";
    text: string;
    status: "completed" | "interrupted";
    providerEventId: string | null;
  }): void => {
    const persistence = persistenceRef.current;
    const createdAt = new Date().toISOString();
    const id = createLocalId();
    setHistory((current) => [
      ...current,
      { id, speaker: transcript.speaker, text: transcript.text, createdAt },
    ]);
    if (!persistence) return;
    persistence.pending.push({
      id,
      sequence: persistence.nextSequence,
      role: transcript.speaker,
      status: transcript.status,
      text: transcript.text,
      providerEventId: transcript.providerEventId,
      createdAt,
    });
    persistence.nextSequence += 1;
    void flushPersistence().catch(() => undefined);
  };

  const finishPersistence = async (): Promise<boolean> => {
    const persistence = persistenceRef.current;
    if (!persistence) return true;
    try {
      await flushPersistence();
      if (persistence.pending.length > 0) return false;
      await completeConversation(
        persistence.id,
        persistence.acknowledgedSequence,
      );
      if (persistenceRef.current === persistence) persistenceRef.current = null;
      setPersistenceError("");
      return true;
    } catch (error) {
      if (error instanceof ConversationApiError && error.status === 401) {
        onUnauthorized();
      } else {
        setPersistenceError(
          "通话已经停止，但文字记录尚未完整收口；历史中会标记为未正常结束。",
        );
      }
      return false;
    }
  };

  const startCall = async (choice?: TeachingChoice) => {
    if (
      !audioRef.current ||
      hasClient ||
      callStarting ||
      !launch.ok ||
      !selectedProviderConfig?.enabled ||
      !selectedProviderConfig.configured
    )
      return;
    const childTeachingChoice = resolveCallTeachingChoice(
      user.accountType,
      conversationMode,
      choice,
    );
    if (user.accountType === "child" && !childTeachingChoice) return;
    const effectiveAvailability =
      teachingAvailability ?? unavailableTeachingAvailability();
    setCallStarting(true);
    if (childTeachingChoice) {
      setTeachingChoice(childTeachingChoice);
      setTeachingState(
        initialTeachingCallState(effectiveAvailability, childTeachingChoice),
      );
    }
    setErrorMessage("");
    setPersistenceError("");
    setHistory([]);
    setEventLog([]);

    if (persistenceRef.current && !(await finishPersistence())) {
      setCallStarting(false);
      return;
    }

    let conversationId: string;
    try {
      const conversation = await createConversation({
        id: createLocalId(),
        characterId: character.id,
        mode: conversationMode,
      });
      conversationId = conversation.id;
      persistenceRef.current = {
        id: conversation.id,
        nextSequence: conversation.lastSequence + 1,
        acknowledgedSequence: conversation.lastSequence,
        pending: [],
        flushing: null,
      };
      if (childTeachingChoice) {
        const teachingPreparation =
          childTeachingChoice === "enabled"
            ? effectiveAvailability.enabled
              ? {
                  choice: "enabled" as const,
                  expectedConfigurationRevision:
                    effectiveAvailability.configurationRevision,
                  acknowledgedDisclosureVersion:
                    effectiveAvailability.disclosureVersion,
                }
              : null
            : { choice: "chat_only" as const };
        if (!teachingPreparation) {
          throw new TeachingApiError(
            409,
            "TEACHING_CONFIGURATION_REVISION_CONFLICT",
          );
        }
        const prepared = await prepareConversationTeaching(
          conversation.id,
          teachingPreparation,
        );
        setTeachingState(prepared);
      }
    } catch (error) {
      const unauthorized =
        (error instanceof ConversationApiError ||
          error instanceof TeachingApiError) &&
        error.status === 401;
      const teachingConfigurationChanged =
        error instanceof TeachingApiError && error.status === 409;
      if (unauthorized) {
        onUnauthorized();
      }
      await finishPersistence();
      if (!unauthorized) {
        setPersistenceError(
          teachingConfigurationChanged
            ? "学习小支线的设置刚刚更新了。请重新查看说明，再选择是否开启；通话尚未开始。"
            : error instanceof TeachingApiError
              ? "无法安全准备学习小支线，请稍后重试。通话尚未开始。"
              : "无法创建通话记录，请稍后重试。通话尚未开始。",
        );
      }
      if (teachingConfigurationChanged) {
        setTeachingAvailabilityReload((current) => current + 1);
      }
      setTeachingChoice(null);
      setCallStarting(false);
      return;
    }

    const callbacks: RealtimeClientCallbacks = {
      onSnapshot: (nextSnapshot) => {
        setSnapshot(nextSnapshot);
        if (nextSnapshot.connection === "active") setErrorMessage("");
      },
      onTranscript: queueTranscript,
      onProviderEvent: (direction, event) => {
        setEventLog((current) => [
          ...current.slice(-79),
          {
            id: createLocalId(),
            at: new Date().toLocaleTimeString("zh-CN", { hour12: false }),
            direction,
            payload: JSON.stringify(event),
          },
        ]);
      },
      onError: (error) => setErrorMessage(error.message),
      onUnauthorized,
      onBeforeReconnect: flushPersistence,
      onTeachingState: (nextState) => {
        setTeachingState(nextState);
        setTeachingActionPending(null);
      },
    };
    const client: RealtimeClient =
      launch.provider === "doubao"
        ? new DoubaoRealtimeClient(audioRef.current, callbacks)
        : new QwenWebSocketRealtimeClient(audioRef.current, callbacks);

    clientRef.current = client;
    setHasClient(true);
    try {
      await client.start({
        ...launch.value,
        conversationId,
        inputMode,
        audioInputDeviceId: selectedMicrophoneId || undefined,
      });
      void refreshMicrophones();
    } catch {
      clientRef.current = null;
      setHasClient(false);
      await finishPersistence();
      setTeachingChoice(null);
    } finally {
      setCallStarting(false);
    }
  };

  const endCall = async () => {
    const client = clientRef.current;
    clientRef.current = null;
    setHasClient(false);
    setCallStarting(false);
    setTeachingActionPending(null);
    await client?.close();
    await finishPersistence();
    setTeachingChoice(null);
  };

  const exitCall = async () => {
    await endCall();
    onExit();
  };

  const setInputMode = (mode: InputMode) => {
    if (hasClient) return;
    setInputModeState(mode);
    window.localStorage.setItem("meet.inputMode", mode);
  };

  const selectMicrophone = (deviceId: string) => {
    setSelectedMicrophoneId(deviceId);
    if (deviceId)
      window.localStorage.setItem("meet.microphoneDeviceId", deviceId);
    else window.localStorage.removeItem("meet.microphoneDeviceId");
  };

  const beginPushToTalk = (event: ReactPointerEvent<HTMLButtonElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    clientRef.current?.setPushToTalkActive(true);
  };

  const requestTeaching = () => {
    if (!teachingState.canRequest || teachingActionPending) return;
    setTeachingActionPending("request");
    clientRef.current?.requestTeaching();
  };

  const muteTeaching = async () => {
    if (!teachingState.canMute || teachingActionPending) return;
    const client = clientRef.current;
    const conversationId = persistenceRef.current?.id;
    setTeachingActionPending("mute");
    setTeachingState((current) => ({
      revision: current.revision,
      state: "restoring",
      canRequest: false,
      canMute: false,
    }));
    client?.beginTeachingMute();
    if (!client || !conversationId) {
      setErrorMessage("无法确认当前通话的学习状态，已为安全起见停止通话。");
      await endCall();
      return;
    }
    try {
      const persistedState = await persistThenMuteTeaching(conversationId, {
        sendRelayMute: () => {
          if (clientRef.current === client) client.muteTeaching();
        },
        stopOnFailure: async () => {
          if (clientRef.current === client) await endCall();
        },
      });
      if (clientRef.current === client) {
        setTeachingState(persistedState);
        setTeachingActionPending(null);
      }
    } catch (error) {
      if (error instanceof TeachingApiError && error.status === 401) {
        onUnauthorized();
      } else {
        setErrorMessage(
          "没有安全切回普通聊天，通话已停止。请重新开始后选择“本次只聊天”。",
        );
      }
    }
  };

  return (
    <main
      className={`immersive-call character-bg-${character.visualProfile.background}`}
      style={
        {
          "--character-accent": character.visualProfile.accentColor,
        } as CSSProperties
      }
    >
      <div className="call-backdrop" aria-hidden="true">
        <img src={character.visualProfile.avatarUrl} alt="" />
      </div>
      <header className="immersive-call-header">
        <button
          type="button"
          className="call-back-button"
          onClick={() => void exitCall()}
        >
          <span aria-hidden="true">←</span>
          <span>返回</span>
        </button>
        <div className="call-character-name">
          <strong>{character.name}</strong>
          <small>{character.description}</small>
        </div>
        <div className="call-header-actions">
          <span
            className={`call-status-pill connection-${snapshot.connection}`}
          >
            <i /> {connectionLabels[snapshot.connection]}
          </span>
          <button
            type="button"
            className={`call-tools-button${toolsOpen ? " active" : ""}`}
            aria-expanded={toolsOpen}
            aria-controls="call-tools-panel"
            onClick={() => setToolsOpen((current) => !current)}
          >
            <span aria-hidden="true">☷</span>
            <span>字幕与设备</span>
          </button>
        </div>
      </header>

      <section
        className="immersive-call-stage"
        aria-label={`与${character.name}通话`}
      >
        <div className={`call-portrait activity-${snapshot.activity}`}>
          <span className="call-portrait-ring ring-one" />
          <span className="call-portrait-ring ring-two" />
          <img
            src={character.visualProfile.avatarUrl}
            alt={`${character.name} 的头像`}
          />
        </div>
        <div className="call-activity-label" role="status">
          <i aria-hidden="true" />
          <span>{activityLabels[snapshot.activity]}</span>
        </div>
        <div className="call-caption" aria-live="polite">
          {snapshot.userCaption && (
            <div className="call-live-caption user">
              <span>你</span>
              <p>{snapshot.userCaption}</p>
            </div>
          )}
          {visibleAssistantCaption && (
            <div className="call-live-caption assistant">
              <span>{character.name}</span>
              <p>{visibleAssistantCaption}</p>
            </div>
          )}
          {!snapshot.userCaption &&
            !visibleAssistantCaption &&
            captionPlaceholder && (
              <p className="call-caption-placeholder">{captionPlaceholder}</p>
            )}
          <small>{snapshot.detail}</small>
        </div>
      </section>

      {(configError || !launch.ok || errorMessage || persistenceError) && (
        <div className="call-error" role="alert">
          {configError ||
            (!launch.ok ? launch.message : errorMessage || persistenceError)}
        </div>
      )}
      {selectedProviderConfig &&
        (!selectedProviderConfig.enabled ||
          !selectedProviderConfig.configured) && (
          <div className="call-error" role="status">
            {!selectedProviderConfig.enabled
              ? "实时通话当前未启用，请联系家庭管理员检查服务配置。"
              : "实时模型尚未配置完成，请联系家庭管理员检查服务端密钥与连接配置。"}
          </div>
        )}

      <footer className="immersive-call-controls">
        {user.accountType === "child" && !hasClient && (
          <TeachingCallControls
            phase="precall"
            characterName={character.name}
            availability={teachingAvailability}
            loading={teachingAvailabilityLoading}
            loadError={teachingAvailabilityError}
            temporary={conversationMode === "temporary"}
            guardianHistoryAccess={user.guardianHistoryAccess ?? "allowed"}
            disabled={
              callStarting ||
              !launch.ok ||
              !selectedProviderConfig?.enabled ||
              !selectedProviderConfig.configured ||
              Boolean(configError)
            }
            onEnable={() => void startCall("enabled")}
            onChatOnly={() => void startCall("chat_only")}
          />
        )}
        {user.accountType === "child" && hasClient && teachingChoice && (
          <TeachingCallControls
            phase="incall"
            state={teachingState}
            actionPending={teachingActionPending}
            onRequest={requestTeaching}
            onMute={() => void muteTeaching()}
          />
        )}
        <div className="call-mode-switch" aria-label="通话记忆模式">
          <button
            className={conversationMode === "normal" ? "selected" : ""}
            type="button"
            disabled={hasClient || callStarting}
            onClick={() => setConversationMode("normal")}
          >
            延续关系
          </button>
          <button
            className={conversationMode === "temporary" ? "selected" : ""}
            type="button"
            disabled={hasClient || callStarting}
            onClick={() => setConversationMode("temporary")}
          >
            临时对话
          </button>
        </div>
        <div className="call-mode-switch" aria-label="语音输入模式">
          <button
            className={inputMode === "hands_free" ? "selected" : ""}
            type="button"
            disabled={hasClient || callStarting}
            onClick={() => setInputMode("hands_free")}
          >
            免提
          </button>
          <button
            className={inputMode === "push_to_talk" ? "selected" : ""}
            type="button"
            disabled={hasClient || callStarting}
            onClick={() => setInputMode("push_to_talk")}
          >
            按住说话
          </button>
        </div>
        <div className="call-control-row">
          {!hasClient && user.accountType !== "child" ? (
            <button
              className="call-start-button"
              type="button"
              disabled={
                !launch.ok ||
                !selectedProviderConfig?.enabled ||
                !selectedProviderConfig.configured ||
                Boolean(configError) ||
                callStarting
              }
              onClick={() => void startCall()}
            >
              <span aria-hidden="true">●</span>{" "}
              {callStarting ? "正在开始…" : "开始通话"}
            </button>
          ) : hasClient ? (
            <>
              <button
                className={`call-round-button ${snapshot.microphoneMuted ? "active" : ""}`}
                type="button"
                aria-label={
                  snapshot.microphoneMuted ? "打开麦克风" : "静音麦克风"
                }
                onClick={() =>
                  clientRef.current?.setMicrophoneMuted(
                    !snapshot.microphoneMuted,
                  )
                }
              >
                {snapshot.microphoneMuted ? "静" : "麦"}
              </button>
              {inputMode === "push_to_talk" && (
                <button
                  className="call-ptt-button"
                  type="button"
                  disabled={
                    snapshot.connection !== "active" || snapshot.microphoneMuted
                  }
                  onPointerDown={beginPushToTalk}
                  onPointerUp={() =>
                    clientRef.current?.setPushToTalkActive(false)
                  }
                  onPointerCancel={() =>
                    clientRef.current?.setPushToTalkActive(false)
                  }
                  onLostPointerCapture={() =>
                    clientRef.current?.setPushToTalkActive(false)
                  }
                >
                  按住说话
                </button>
              )}
              <button
                className="call-round-button"
                type="button"
                aria-label="停止角色说话"
                onClick={() => clientRef.current?.interrupt()}
              >
                ■
              </button>
              {snapshot.connection === "paused" && (
                <button
                  className="call-retry-button"
                  type="button"
                  onClick={() => clientRef.current?.retry()}
                >
                  继续重试
                </button>
              )}
              <button
                className="call-end-button"
                type="button"
                onClick={() => void endCall()}
              >
                结束
              </button>
            </>
          ) : null}
        </div>
      </footer>

      {toolsOpen && (
        <button
          type="button"
          className="call-tools-scrim"
          aria-label="关闭字幕与设备面板"
          onClick={() => setToolsOpen(false)}
        />
      )}
      <aside
        id="call-tools-panel"
        className={`call-tools${toolsOpen ? " open" : ""}`}
        aria-label="通话设置与记录"
        hidden={!toolsOpen}
      >
        <header className="call-tools-header">
          <div>
            <strong>字幕与设备</strong>
            <small>完整记录仅在这里滚动</small>
          </div>
          <button
            type="button"
            aria-label="关闭字幕与设备面板"
            onClick={() => setToolsOpen(false)}
          >
            ×
          </button>
        </header>
        <details>
          <summary>麦克风与完整字幕</summary>
          <div className="call-tool-content">
            <label htmlFor="call-microphone">麦克风</label>
            <div className="microphone-row">
              <select
                id="call-microphone"
                value={selectedMicrophoneId}
                disabled={hasClient || callStarting}
                onChange={(event) => selectMicrophone(event.target.value)}
              >
                <option value="">系统默认麦克风</option>
                {microphones.map((microphone) => (
                  <option key={microphone.deviceId} value={microphone.deviceId}>
                    {microphone.label}
                  </option>
                ))}
              </select>
              <button
                type="button"
                disabled={hasClient || callStarting}
                onClick={() => void refreshMicrophones()}
              >
                刷新
              </button>
            </div>
            {microphoneListError && (
              <p className="tool-error">{microphoneListError}</p>
            )}
            <div className="call-transcript-list">
              {history.length === 0 ? (
                <p className="empty-tool-state">
                  通话后，完整字幕会出现在这里。
                </p>
              ) : (
                history.map((item) => (
                  <div
                    key={item.id}
                    className={`call-transcript ${item.speaker}`}
                  >
                    <strong>
                      {item.speaker === "assistant" ? character.name : "你"}
                    </strong>
                    <p>{item.text}</p>
                  </div>
                ))
              )}
            </div>
          </div>
        </details>
        <details>
          <summary>技术诊断</summary>
          <div className="call-tool-content diagnostic-copy">
            <dl>
              <div>
                <dt>实时能力</dt>
                <dd>{runtime.realtime.provider.toUpperCase()}</dd>
              </div>
              <div>
                <dt>模型</dt>
                <dd>{runtime.realtime.model}</dd>
              </div>
              <div>
                <dt>声音</dt>
                <dd>{character.voiceProfile.displayName}</dd>
              </div>
            </dl>
            <div className="call-event-log">
              {eventLog.length === 0 ? (
                <p className="empty-tool-state">暂无实时事件。</p>
              ) : (
                eventLog.map((entry) => (
                  <div key={entry.id}>
                    <time>{entry.at}</time>
                    <span>
                      {entry.direction === "client" ? "发出" : "收到"}
                    </span>
                    <code>{entry.payload}</code>
                  </div>
                ))
              )}
            </div>
          </div>
        </details>
      </aside>
      <audio className="remote-audio" ref={audioRef} autoPlay playsInline />
    </main>
  );
}

function getCaptionPlaceholder(
  snapshot: RealtimeClientSnapshot,
  name: string,
): string {
  if (snapshot.connection === "active") return "";
  if (snapshot.connection === "closed") return "通话结束了，随时可以再聊。";
  if (snapshot.connection === "error" || snapshot.connection === "paused")
    return "连接暂停，请查看提示后重试。";
  return `准备好后，${name}会在这里回应你。`;
}

function createLocalId(): string {
  return crypto.randomUUID();
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}
