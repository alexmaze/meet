import type {
  CharacterRuntimeResponse,
  ConversationMode,
  ConversationContinuityStatus,
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
  getConversation,
  createConversation,
} from "../history/conversation-api.js";
import {
  confirmConversationFinish,
  finishSavedConversation,
  prepareConversation,
  getConversationStatus,
  heartbeatConversation,
  getConversationClientId,
  getPendingEndOperation,
  savePendingEndOperation,
  clearPendingEndOperation,
} from "../history/continuity-api.js";
import "./call-continuity.css";
import {
  flushTranscriptQueue,
  type ConversationPersistence,
} from "./transcript-persistence.js";
import { reauthenticateCall } from "./reauthenticate-call.js";
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

type CharacterCallProps = {
  runtime: CharacterRuntimeResponse;
  user: UserAccount;
  initialMode?: ConversationMode;
  resumeConversationId?: string;
  onViewHistory?: (conversationId: string) => void;
  onViewMemories?: (input: {
    characterId: string;
    sourceConversationId?: string;
    status?: "active" | "suggested";
  }) => void;
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
  initialMode = "normal",
  resumeConversationId,
  onViewHistory,
  onViewMemories,
}: CharacterCallProps) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const clientRef = useRef<RealtimeClient | null>(null);
  const persistenceRef = useRef<ConversationPersistence | null>(null);
  const [snapshot, setSnapshot] = useState<RealtimeClientSnapshot>(
    initialClientSnapshot,
  );
  const [hasClient, setHasClient] = useState(false);
  const [closing, setClosing] = useState<
    "saving" | "confirming" | "failed" | "done" | null
  >(null);
  const [closingStatus, setClosingStatus] =
    useState<ConversationContinuityStatus | null>(null);
  const [pendingCount, setPendingCount] = useState(0);
  const [lastSavedAt, setLastSavedAt] = useState<string | null>(null);
  const [leavePrompt, setLeavePrompt] = useState(false);
  const [markerUnavailable, setMarkerUnavailable] = useState(false);
  const [needsAuthentication, setNeedsAuthentication] = useState(false);
  const [reauthPassword, setReauthPassword] = useState("");
  const [reauthPending, setReauthPending] = useState(false);
  const [reauthError, setReauthError] = useState("");
  const finishingRef = useRef(false);
  const endCallRef = useRef<(() => Promise<boolean>) | null>(null);
  const finishPromiseRef = useRef<Promise<boolean> | null>(null);
  const lifecycleRef = useRef(0);
  const hasActivatedRef = useRef(false);
  const prepareRequestRef = useRef<string | null>(null);
  const createRequestRef = useRef<string | null>(null);
  const [activeRealtime, setActiveRealtime] = useState(runtime.realtime);
  const [inputMode, setInputModeState] = useState<InputMode>(() => {
    const saved = window.localStorage.getItem("meet.inputMode");
    return saved === "push_to_talk" ? "push_to_talk" : "hands_free";
  });
  const [conversationMode, setConversationMode] =
    useState<ConversationMode>(initialMode);
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
  const launch = mapRuntimeToLaunchOptions({
    ...runtime,
    realtime: activeRealtime,
  });
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
          if (persistenceRef.current) {
            setNeedsAuthentication(true);
            void endCallRef.current?.();
          } else onUnauthorized();
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
          if (persistenceRef.current) {
            setNeedsAuthentication(true);
            void endCallRef.current?.();
          } else onUnauthorized();
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
      lifecycleRef.current += 1;
      void clientRef.current?.close();
    },
    [],
  );

  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (
        !persistenceRef.current?.pending.length &&
        !persistenceRef.current?.endOperation
      )
        return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", beforeUnload);
    const timer = window.setInterval(() => {
      const persistence = persistenceRef.current;
      if (!persistence) return;
      void heartbeatConversation(persistence.id, persistence.writer).catch(
        (error: unknown) => {
          if (
            error instanceof ConversationApiError &&
            (error.status === 401 || error.status === 409)
          ) {
            if (error.status === 401) setNeedsAuthentication(true);
            void endCallRef.current?.();
            setErrorMessage(
              error.status === 401
                ? "登录已失效。文字仍保留在此页面，重新登录原账号后可重试保存。"
                : "这次通话的连接占用已变化。已停止声音，未同步文字仍保留在此页面。",
            );
          }
        },
      );
    }, 10_000);
    return () => {
      window.removeEventListener("beforeunload", beforeUnload);
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    if (closing !== "done" || !closingStatus) return;
    if (
      ![closingStatus.summary.state, closingStatus.memory.state].some(
        (state) => state === "processing" || state === "not_started",
      )
    )
      return;
    let cancelled = false;
    const timer = window.setInterval(() => {
      void getConversationStatus(closingStatus.conversation.id)
        .then((status) => {
          if (!cancelled) setClosingStatus(status);
        })
        .catch(() => undefined);
    }, 4_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [closing, closingStatus]);

  const flushPersistence = async (): Promise<void> => {
    const persistence = persistenceRef.current;
    if (!persistence) return;
    try {
      await flushTranscriptQueue(
        persistence,
        appendConversationMessages,
        (message) => {
          if (persistenceRef.current !== persistence) return;
          setPendingCount(persistence.pending.length);
          setLastSavedAt(message.createdAt);
          setPersistenceError("");
        },
        delay,
      );
    } catch (error) {
      if (error instanceof ConversationApiError && error.status === 401) {
        setNeedsAuthentication(true);
        setPersistenceError(
          "登录已失效。请保留此页面，重新登录原账号后重试保存。",
        );
      } else {
        setPersistenceError(
          `还有 ${persistence.pending.length} 条文字未同步；保持页面打开时可以重试。`,
        );
      }
      throw error;
    }
  };

  const prepareReconnect = async (): Promise<void> => {
    const persistence = persistenceRef.current;
    if (!persistence || finishingRef.current)
      throw new ConversationApiError(409, "CONVERSATION_END_PENDING");
    const status = await getConversationStatus(persistence.id);
    if (status.conversation.status === "completed" || status.endRequestId)
      throw new ConversationApiError(409, "CONVERSATION_END_PENDING");
    if (
      status.connectionState === "interrupted" ||
      status.writerEpoch !== persistence.writer.epoch
    ) {
      const prepared = await prepareConversation(persistence.id, {
        clientId: getConversationClientId(),
        requestId: createLocalId(),
        intent: "connect",
      });
      // Client options retain this identity object across reconnects.
      Object.assign(persistence.writer, prepared.writer);
    }
    await flushPersistence();
  };

  const queueTranscript = (transcript: {
    speaker: "user" | "assistant";
    text: string;
    status: "completed" | "interrupted";
    providerEventId: string | null;
  }): void => {
    if (finishingRef.current) return;
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
    setPendingCount(persistence.pending.length);
    void flushPersistence().catch(() => undefined);
  };

  const finishPersistence = async (): Promise<boolean> => {
    if (finishPromiseRef.current) return finishPromiseRef.current;
    const persistence = persistenceRef.current;
    if (!persistence) return true;
    const operation = persistence.endOperation ?? {
      conversationId: persistence.id,
      requestId: createLocalId(),
      lastSequence: persistence.nextSequence - 1,
    };
    persistence.endOperation = operation;
    setMarkerUnavailable(!savePendingEndOperation(user.id, operation));
    const finish = (async () => {
      try {
        setClosing("saving");
        // Reclaim only when the old writer has expired; the server refuses another live owner.
        const current = await getConversationStatus(
          persistence.id,
          operation.requestId,
        );
        if (current.conversation.status === "completed") {
          if (persistence.pending.length) {
            const detail = await getConversation(persistence.id);
            const saved = new Set(detail.messages.map((message) => message.id));
            persistence.pending = persistence.pending.filter(
              (message) => !saved.has(message.id),
            );
            setPendingCount(persistence.pending.length);
            if (persistence.pending.length)
              throw new ConversationApiError(
                409,
                "CONVERSATION_COMPLETED_WITH_PENDING_TEXT",
              );
          }
          setClosingStatus(current);
          clearPendingEndOperation(persistence.id, user.id);
          persistenceRef.current = null;
          setClosing("done");
          return true;
        }
        if (
          current.connectionState === "interrupted" ||
          current.writerEpoch !== persistence.writer.epoch
        ) {
          const prepared = await prepareConversation(persistence.id, {
            clientId: getConversationClientId(),
            requestId: createLocalId(),
            intent: "finish",
          });
          Object.assign(persistence.writer, prepared.writer);
        }
        await flushPersistence();
        if (persistence.pending.length > 0) return false;
        setClosing("confirming");
        const status = await confirmConversationFinish(persistence.id, {
          writer: persistence.writer,
          requestId: operation.requestId,
          lastSequence: operation.lastSequence,
          discardMissing: false,
        });
        setClosingStatus(status);
        setLastSavedAt(status.lastSavedAt);
        clearPendingEndOperation(persistence.id, user.id);
        if (persistenceRef.current === persistence)
          persistenceRef.current = null;
        setPersistenceError("");
        setClosing("done");
        return true;
      } catch (error) {
        if (error instanceof ConversationApiError && error.status === 401)
          setNeedsAuthentication(true);
        setClosing("failed");
        setPersistenceError(
          error instanceof ConversationApiError && error.status === 401
            ? "登录已失效。文字仍保留在此页面，重新登录原账号后重试。"
            : persistence.pending.length
              ? `还有 ${persistence.pending.length} 条文字未同步。请保持此页面打开，网络恢复后重试。`
              : "文字已保存，结束状态还没有确认。可以重试确认，不会重复创建通话。",
        );
        return false;
      }
    })().finally(() => {
      finishPromiseRef.current = null;
    });
    finishPromiseRef.current = finish;
    return finish;
  };

  const startCall = async (choice?: TeachingChoice) => {
    if (
      !audioRef.current ||
      hasClient ||
      callStarting ||
      closing ||
      Boolean(
        persistenceRef.current?.pending.length ||
        persistenceRef.current?.endOperation,
      ) ||
      (!resumeConversationId &&
        (!launch.ok ||
          !selectedProviderConfig?.enabled ||
          !selectedProviderConfig.configured))
    )
      return;
    const childTeachingChoice = resolveCallTeachingChoice(
      user.accountType,
      conversationMode,
      choice,
    );
    if (
      user.accountType === "child" &&
      !childTeachingChoice &&
      !resumeConversationId
    )
      return;
    const effectiveAvailability =
      teachingAvailability ?? unavailableTeachingAvailability();
    const lifecycle = ++lifecycleRef.current;
    finishingRef.current = false;
    hasActivatedRef.current = false;
    setCallStarting(true);
    if (childTeachingChoice && !resumeConversationId) {
      setTeachingChoice(childTeachingChoice);
      setTeachingState(
        initialTeachingCallState(effectiveAvailability, childTeachingChoice),
      );
    }
    setErrorMessage("");
    setPersistenceError("");
    setHistory([]);
    setEventLog([]);

    let conversationId: string;
    let createdConversationId: string | null = null;
    let callLaunch = launch;
    let resumed: boolean;
    try {
      const previousEnd = resumeConversationId
        ? getPendingEndOperation(resumeConversationId, user.id)
        : null;
      if (previousEnd) {
        setErrorMessage("上次已点击结束，请回到待处理通话确认结束状态。");
        setCallStarting(false);
        return;
      }
      if (!resumeConversationId) createRequestRef.current ??= createLocalId();
      const conversation = resumeConversationId
        ? (await getConversation(resumeConversationId)).conversation
        : await createConversation({
            id: createRequestRef.current!,
            characterId: character.id,
            mode: conversationMode,
          });
      conversationId = conversation.id;
      if (!resumeConversationId) createdConversationId = conversation.id;
      prepareRequestRef.current ??= createLocalId();
      const prepared = await prepareConversation(conversation.id, {
        clientId: getConversationClientId(),
        requestId: prepareRequestRef.current,
        intent: "connect",
      });
      prepareRequestRef.current = null;
      persistenceRef.current = {
        id: conversation.id,
        writer: prepared.writer,
        endOperation: null,
        nextSequence: prepared.status.conversation.lastSequence + 1,
        acknowledgedSequence: prepared.status.conversation.lastSequence,
        pending: [],
        flushing: null,
      };
      setConversationMode(prepared.status.conversation.mode);
      setLastSavedAt(prepared.status.lastSavedAt);
      resumed = Boolean(resumeConversationId) || prepared.launch === "resume";
      if (prepared.realtime) {
        const recoveredRealtime = { ...runtime.realtime, ...prepared.realtime };
        setActiveRealtime(recoveredRealtime);
        callLaunch = mapRuntimeToLaunchOptions({
          ...runtime,
          realtime: recoveredRealtime,
        });
      }
      if (lifecycle !== lifecycleRef.current) {
        await finishPersistence();
        return;
      }
      if (resumed) {
        const detail = await getConversation(conversation.id);
        setHistory(
          detail.messages.map((message) => ({
            id: message.id,
            speaker: message.role,
            text: message.text,
            createdAt: message.createdAt,
          })),
        );
        if (user.accountType === "child") setTeachingChoice("chat_only");
      }
      if (!callLaunch.ok) throw new Error(callLaunch.message);
      if (childTeachingChoice && !resumed && !resumeConversationId) {
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
      if (unauthorized && !persistenceRef.current) {
        onUnauthorized();
      }
      if (!resumeConversationId) {
        if (persistenceRef.current) await finishPersistence();
        else if (createdConversationId) {
          const operation = {
            conversationId: createdConversationId,
            requestId: createLocalId(),
            lastSequence: 0,
          };
          savePendingEndOperation(user.id, operation);
          try {
            const status = await getConversationStatus(createdConversationId);
            if (
              !status.hasConnected &&
              status.conversation.messageCount === 0
            ) {
              await finishSavedConversation(status, user.id);
              createRequestRef.current = null;
            }
          } catch {
            /* The non-content marker makes uncertain cleanup reviewable next time. */
          }
        }
      }
      if (!unauthorized) {
        setPersistenceError(
          resumeConversationId
            ? recoveryErrorMessage(error)
            : teachingConfigurationChanged
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

    if (!callLaunch.ok || lifecycle !== lifecycleRef.current) {
      setCallStarting(false);
      return;
    }
    const callbacks: RealtimeClientCallbacks = {
      onSnapshot: (nextSnapshot) => {
        setSnapshot(nextSnapshot);
        if (nextSnapshot.connection === "active") {
          hasActivatedRef.current = true;
          setErrorMessage("");
        } else if (
          (nextSnapshot.connection === "paused" ||
            nextSnapshot.connection === "error") &&
          !hasActivatedRef.current &&
          !resumeConversationId &&
          persistenceRef.current?.nextSequence === 1
        ) {
          // A failed first connection must not keep an empty call alive indefinitely.
          void endCallRef.current?.();
        }
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
      onUnauthorized: () => {
        setNeedsAuthentication(true);
        void endCallRef.current?.();
        setErrorMessage("登录已失效，请保留此页面，重新登录原账号后重试保存。");
      },
      onBeforeReconnect: prepareReconnect,
      onTeachingState: (nextState) => {
        setTeachingState(nextState);
        setTeachingActionPending(null);
      },
    };
    const client: RealtimeClient =
      callLaunch.provider === "doubao"
        ? new DoubaoRealtimeClient(audioRef.current, callbacks)
        : new QwenWebSocketRealtimeClient(audioRef.current, callbacks);

    clientRef.current = client;
    setHasClient(true);
    try {
      await client.start({
        ...callLaunch.value,
        assistantStarts: !resumed && callLaunch.value.assistantStarts,
        resumed,
        conversationId,
        writer: persistenceRef.current!.writer,
        inputMode,
        audioInputDeviceId: selectedMicrophoneId || undefined,
      });
      void refreshMicrophones();
    } catch {
      clientRef.current = null;
      setHasClient(false);
      if (!resumeConversationId) await finishPersistence();
      setTeachingChoice(null);
    } finally {
      setCallStarting(false);
    }
  };

  const endCall = async (): Promise<boolean> => {
    if (finishPromiseRef.current) return finishPromiseRef.current;
    finishingRef.current = true;
    lifecycleRef.current += 1;
    const client = clientRef.current;
    clientRef.current = null;
    setHasClient(false);
    setCallStarting(false);
    setTeachingActionPending(null);
    setClosing("saving");
    const persistence = persistenceRef.current;
    if (persistence && !persistence.endOperation) {
      persistence.endOperation = {
        conversationId: persistence.id,
        requestId: createLocalId(),
        lastSequence: persistence.nextSequence - 1,
      };
      setMarkerUnavailable(
        !savePendingEndOperation(user.id, persistence.endOperation),
      );
    }
    // close() stops capture/playback synchronously before any transport wait.
    await client?.close();
    const finished = await finishPersistence();
    if (!persistenceRef.current && !closingStatus) setClosing("done");
    setTeachingChoice(null);
    return finished;
  };

  useEffect(() => {
    endCallRef.current = endCall;
  });

  const exitCall = async () => {
    if (callStarting) return;
    if (!hasClient && !persistenceRef.current) {
      onExit();
      return;
    }
    if (closing === "saving" || closing === "confirming") return;
    if (!closing) {
      await endCall();
      return;
    }
    setLeavePrompt(true);
  };

  const authenticateAndRetry = async () => {
    if (reauthPending || !reauthPassword) return;
    setReauthPending(true);
    setReauthError("");
    try {
      await reauthenticateCall(user, reauthPassword);
      setNeedsAuthentication(false);
      setReauthPassword("");
      await finishPersistence();
    } catch (error) {
      setReauthError(
        error instanceof Error ? error.message : "无法重新登录，请稍后重试。",
      );
    } finally {
      setReauthPending(false);
    }
  };

  const discardAndLeave = () => {
    const persistence = persistenceRef.current;
    if (persistence) {
      persistence.pending.length = 0;
      persistenceRef.current = null;
    }
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
        setNeedsAuthentication(true);
        await endCall();
      } else {
        setErrorMessage(
          "没有安全切回普通聊天，通话已停止。请重新开始后选择“本次只聊天”。",
        );
      }
    }
  };

  if (closing) {
    const conversationId =
      closingStatus?.conversation.id ?? persistenceRef.current?.id;
    return (
      <main
        className="call-continuity"
        style={
          {
            "--character-accent": character.visualProfile.accentColor,
          } as CSSProperties
        }
      >
        <section
          className="call-finish-card"
          aria-labelledby="call-finish-title"
        >
          <img
            className="call-finish-avatar"
            src={character.visualProfile.avatarUrl}
            alt=""
          />
          <p className="call-finish-kicker">
            {conversationMode === "temporary" ? "临时对话" : "这次聊天"}
          </p>
          <h1 id="call-finish-title">和{character.name}的通话已停止</h1>
          {closingStatus && (
            <p>
              {new Date(closingStatus.conversation.startedAt).toLocaleString(
                "zh-CN",
              )}{" "}
              · 有效通话 {formatDuration(closingStatus.connectedDurationMs)}
            </p>
          )}
          <div className="call-finish-status" role="status" aria-live="polite">
            <strong>
              {closing === "done"
                ? "文字记录已保存，通话已结束"
                : pendingCount > 0
                  ? `还有 ${pendingCount} 条文字未同步`
                  : closing === "saving"
                    ? "正在核对文字保存状态"
                    : "文字已保存，正在确认结束状态"}
            </strong>
            {lastSavedAt && (
              <small>
                已保存至 {new Date(lastSavedAt).toLocaleTimeString("zh-CN")}
              </small>
            )}
          </div>
          {persistenceError && (
            <p className="call-finish-error" role="alert">
              {persistenceError}
            </p>
          )}
          {markerUnavailable && closing !== "done" && (
            <p>
              浏览器未能保存结束操作标记。请保持此页面打开，完成确认后再离开。
            </p>
          )}
          {closingStatus && (
            <dl className="call-finish-results">
              <div>
                <dt>本次回顾</dt>
                <dd>{analysisLabel(closingStatus.summary.state, "回顾")}</dd>
                {closingStatus.summary.content && (
                  <details>
                    <summary>查看本次回顾</summary>
                    <p>{closingStatus.summary.content}</p>
                  </details>
                )}
              </div>
              <div>
                <dt>长期记忆</dt>
                <dd>
                  {conversationMode === "temporary"
                    ? "临时对话不新增长期记忆"
                    : closingStatus.memory.state === "completed"
                      ? closingStatus.memory.activeCount +
                          closingStatus.memory.suggestedCount >
                        0
                        ? `新保存 ${closingStatus.memory.activeCount} 条、待确认 ${closingStatus.memory.suggestedCount} 条`
                        : "本次没有新增需要长期记住的内容"
                      : analysisLabel(closingStatus.memory.state, "记忆")}
                </dd>
              </div>
            </dl>
          )}
          {needsAuthentication && (
            <form
              className="call-reauth"
              onSubmit={(event) => {
                event.preventDefault();
                void authenticateAndRetry();
              }}
            >
              <p>重新登录 {user.displayName}，保留的文字不会离开此页面。</p>
              <label htmlFor="call-reauth-password">
                {user.username} 的密码
              </label>
              <input
                id="call-reauth-password"
                type="password"
                autoComplete="current-password"
                value={reauthPassword}
                disabled={reauthPending}
                onChange={(event) => setReauthPassword(event.target.value)}
              />
              {reauthError && <p role="alert">{reauthError}</p>}
              <button type="submit" disabled={reauthPending || !reauthPassword}>
                {reauthPending ? "正在验证…" : "重新登录并保存"}
              </button>
            </form>
          )}
          <div className="call-finish-actions">
            {closing === "failed" && (
              <button
                type="button"
                className="primary-button"
                onClick={() => void finishPersistence()}
              >
                重试{pendingCount ? "保存" : "确认"}
              </button>
            )}
            <button
              type="button"
              disabled={closing === "saving" || closing === "confirming"}
              onClick={() => void exitCall()}
            >
              返回角色
            </button>
            {conversationId && onViewHistory && (
              <button
                type="button"
                onClick={() => onViewHistory(conversationId)}
              >
                {closing === "done" ? "查看记录" : "查看已保存记录"}
              </button>
            )}
            {closing === "done" &&
              conversationMode !== "temporary" &&
              conversationId &&
              onViewMemories && (
                <button
                  type="button"
                  onClick={() =>
                    onViewMemories({
                      characterId: character.id,
                      sourceConversationId: conversationId,
                    })
                  }
                >
                  查看本次记忆
                </button>
              )}
          </div>
          {closing !== "done" && pendingCount > 0 && (
            <p className="call-finish-note">
              未同步文字仅保留在此页面。强制刷新或系统关闭应用时，最后未同步部分可能丢失。
            </p>
          )}
        </section>
        {leavePrompt && (
          <div className="call-leave-scrim">
            <section
              className="call-leave-dialog"
              role="alertdialog"
              aria-modal="true"
              aria-labelledby="call-leave-title"
              aria-describedby="call-leave-description"
            >
              <h2 id="call-leave-title">保存还没有完成</h2>
              <p id="call-leave-description">
                {pendingCount
                  ? `离开将放弃 ${pendingCount} 条尚未同步的文字。`
                  : "通话结束状态还未确认。"}
                服务端已经保存的内容会保留，首页仍会显示需要处理的通话。
              </p>
              <button
                autoFocus
                type="button"
                onClick={() => setLeavePrompt(false)}
              >
                留在此页
              </button>
              <button type="button" onClick={discardAndLeave}>
                {pendingCount ? "放弃未同步文字并离开" : "保留待处理记录并离开"}
              </button>
            </section>
          </div>
        )}
        <audio className="remote-audio" ref={audioRef} autoPlay playsInline />
      </main>
    );
  }

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
          disabled={callStarting}
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
      {!resumeConversationId &&
        selectedProviderConfig &&
        (!selectedProviderConfig.enabled ||
          !selectedProviderConfig.configured) && (
          <div className="call-error" role="status">
            {!selectedProviderConfig.enabled
              ? "实时通话当前未启用，请联系家庭管理员检查服务配置。"
              : "实时模型尚未配置完成，请联系家庭管理员检查服务端密钥与连接配置。"}
          </div>
        )}

      <footer className="immersive-call-controls">
        {user.accountType === "child" &&
          !hasClient &&
          !resumeConversationId && (
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
            disabled={
              hasClient || callStarting || Boolean(resumeConversationId)
            }
            onClick={() => setConversationMode("normal")}
          >
            延续关系
          </button>
          <button
            className={conversationMode === "temporary" ? "selected" : ""}
            type="button"
            disabled={
              hasClient || callStarting || Boolean(resumeConversationId)
            }
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
          {!hasClient && persistenceRef.current && (
            <button
              type="button"
              className="call-end-button"
              disabled={callStarting}
              onClick={() => void endCall()}
            >
              结束并保存
            </button>
          )}
          {!hasClient &&
          (user.accountType !== "child" || resumeConversationId) ? (
            <button
              className="call-start-button"
              type="button"
              disabled={
                (!resumeConversationId &&
                  (!launch.ok ||
                    !selectedProviderConfig?.enabled ||
                    !selectedProviderConfig.configured ||
                    Boolean(configError))) ||
                callStarting
              }
              onClick={() => void startCall()}
            >
              <span aria-hidden="true">●</span>{" "}
              {callStarting
                ? "正在连接…"
                : resumeConversationId
                  ? conversationMode === "temporary"
                    ? "恢复临时对话"
                    : "恢复通话"
                  : "开始通话"}
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

function formatDuration(milliseconds: number): string {
  const seconds = Math.floor(milliseconds / 1000);
  return seconds < 60
    ? `${seconds} 秒`
    : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
}
function analysisLabel(
  state: ConversationContinuityStatus["summary"]["state"],
  subject: string,
): string {
  switch (state) {
    case "completed":
      return "已整理完成";
    case "not_configured":
      return `暂未启用${subject}整理，文字已保存`;
    case "failed":
      return `${subject}暂未整理完成，文字已保存`;
    case "not_applicable":
      return "本次不需要整理";
    default:
      return "正在整理，可以稍后查看";
  }
}

function recoveryErrorMessage(error: unknown): string {
  if (!(error instanceof ConversationApiError))
    return "暂时无法恢复通话。可以重试原模型，或结束并保存。";
  switch (error.code) {
    case "CONVERSATION_IN_USE":
      return "正在另一台设备通话，请在原设备继续。";
    case "CONVERSATION_END_PENDING":
      return "上次已点击结束，请返回首页确认结束状态。";
    case "CONVERSATION_ALREADY_COMPLETED":
      return "这次通话已经结束，可以返回后再次聊天。";
    case "CONVERSATION_CHARACTER_UNAVAILABLE":
      return "原角色已不可用。已保存的记录仍可查看，也可以结束保存。";
    case "CONVERSATION_WRITER_STALE":
      return "连接占用已经变化，请刷新通话状态后再恢复。";
    default:
      return "暂时无法恢复通话。可以重试原模型，或结束并保存。";
  }
}
