import type {
  ChildCharacterLearningPlan,
  LearningPlanContentRevision,
  LearningPlanConfiguration,
  LearningPlanGenerationResponse,
  LearningPlanTargetCharacter,
  LearningPlanTargetTeachingAvailability,
  LearningPlanTargetsResponse,
  TeachingPlanGenerationErrorCode,
  TeachingSubject,
  UserAccount,
} from "@meet/protocol";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type FormEvent,
  type SetStateAction,
} from "react";

import {
  getLearningPlanContent,
  getLearningPlanGeneration,
  getLearningPlanTargets,
  listLearningPlans,
  publishLearningPlanContent,
  putLearningPlan,
  requestLearningPlanGeneration,
  TeachingApiError,
} from "./teaching-api.js";
import {
  ShortLearningPlanBuilder,
  shortPlanGradeLabel,
  shortPlanRecommendedSubject,
  validateShortPlanGoal,
  type ShortPlanBuilderValue,
  type ShortPlanDraftItemView,
  type ShortPlanDraftView,
  type ShortPlanExample,
} from "./ShortLearningPlanBuilder.js";

type TeachingPlansPanelProps = {
  currentUser: UserAccount;
  open: boolean;
  onClose: () => void;
  onUnauthorized: () => void;
};

type LoadState = "idle" | "loading" | "ready" | "error";
type Notice = { kind: "success" | "error"; message: string };
type GenerationState = "idle" | "generating" | "failed" | "ready";

export type LearningPlanGenerationRequestIdentity = Readonly<{
  childUserId: string;
  characterId: string;
  planRevision: number;
  clientRequestId: string;
  generationId: string | null;
  resultUnknown: boolean;
}>;

type LearningPlanGenerationRequestTarget = Pick<
  LearningPlanGenerationRequestIdentity,
  "childUserId" | "characterId" | "planRevision"
>;

export function normalizeLearningGoalForSave(
  learningGoal: string | null,
): string | null {
  const normalized = learningGoal?.trim() ?? "";
  return normalized || null;
}

export function shouldConfirmPublishedShortPlanRemoval(input: {
  activeContentRevisionId: string | null;
  persistedLearningGoal: string | null;
  nextLearningGoal: string | null;
}): boolean {
  return (
    input.activeContentRevisionId !== null &&
    input.persistedLearningGoal !== null &&
    input.nextLearningGoal === null
  );
}

export function resolveLearningPlanGenerationRequestIdentity(
  previous: LearningPlanGenerationRequestIdentity | null,
  target: LearningPlanGenerationRequestTarget,
  createClientRequestId: () => string = () => crypto.randomUUID(),
): LearningPlanGenerationRequestIdentity {
  if (
    previous?.childUserId === target.childUserId &&
    previous.characterId === target.characterId &&
    previous.planRevision === target.planRevision
  ) {
    return previous;
  }
  return {
    ...target,
    clientRequestId: createClientRequestId(),
    generationId: null,
    resultUnknown: false,
  };
}

export function resolveLearningPlanGenerationReadId(
  request: LearningPlanGenerationRequestIdentity | null,
  target: Pick<
    LearningPlanGenerationRequestIdentity,
    "childUserId" | "characterId"
  >,
): string | null {
  return request?.childUserId === target.childUserId &&
    request.characterId === target.characterId
    ? request.generationId
    : null;
}

const defaultConfiguration: LearningPlanConfiguration = {
  enabled: true,
  subject: "general",
  difficulty: "starter",
  triggerMode: "gentle",
  gradeLevel: "unspecified",
  learningGoal: null,
  activityCount: 4,
  durationDays: 7,
};

export const teachingSubjectOptions: readonly Readonly<{
  value: TeachingSubject;
  label: string;
}>[] = [
  { value: "chinese", label: "语文" },
  { value: "english", label: "英语" },
  { value: "math", label: "数学" },
  { value: "science", label: "科学" },
  { value: "general", label: "综合 / 其他" },
];

const generationPollIntervalMs = 1_000;
const generationMaximumPolls = 90;

export function getTeachingTargetAvailabilityMessage(
  availability: LearningPlanTargetTeachingAvailability,
): string | null {
  if (availability.available) return null;
  switch (availability.reason) {
    case "provider_unsupported":
      return "当前模型或供应商暂不支持学习小支线；设置仍可保存，角色会继续正常聊天。";
    case "configuration_not_approved":
      return "这个角色的实时配置尚未批准用于学习小支线；设置仍可保存，批准后才会生效。";
    case "realtime_unavailable":
      return "这个角色的实时模型、连接或音色尚未就绪；设置仍可保存，配置恢复后才会生效。";
  }
}

function getTeachingTargetOptionLabel(
  character: LearningPlanTargetCharacter,
): string {
  if (character.teachingAvailability.available) {
    return `${character.name}（当前可用）`;
  }
  switch (character.teachingAvailability.reason) {
    case "provider_unsupported":
      return `${character.name}（模型待支持）`;
    case "configuration_not_approved":
      return `${character.name}（配置待批准）`;
    case "realtime_unavailable":
      return `${character.name}（实时配置未就绪）`;
  }
}

export function TeachingCharacterSelector({
  characters,
  selectedCharacterId,
  disabled = false,
  onChange,
}: {
  characters: LearningPlanTargetCharacter[];
  selectedCharacterId: string;
  disabled?: boolean;
  onChange: (characterId: string) => void;
}) {
  const selectedCharacter =
    characters.find((character) => character.id === selectedCharacterId) ??
    null;
  const availabilityMessage = selectedCharacter
    ? getTeachingTargetAvailabilityMessage(
        selectedCharacter.teachingAvailability,
      )
    : null;

  return (
    <div className="teaching-character-target">
      <label>
        <span>角色</span>
        <select
          value={selectedCharacterId}
          disabled={disabled}
          aria-describedby={
            availabilityMessage ? "teaching-character-availability" : undefined
          }
          onChange={(event) => onChange(event.target.value)}
        >
          {characters.map((character) => (
            <option key={character.id} value={character.id}>
              {getTeachingTargetOptionLabel(character)}
            </option>
          ))}
        </select>
      </label>
      {availabilityMessage && (
        <p
          id="teaching-character-availability"
          className="teaching-character-availability"
          role="status"
        >
          {availabilityMessage}
        </p>
      )}
    </div>
  );
}

export default function TeachingPlansPanel({
  currentUser,
  open,
  onClose,
  onUnauthorized,
}: TeachingPlansPanelProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [loadState, setLoadState] = useState<LoadState>("idle");
  const [targets, setTargets] = useState<LearningPlanTargetsResponse>({
    children: [],
    characters: [],
  });
  const [plans, setPlans] = useState<ChildCharacterLearningPlan[]>([]);
  const [plansLoading, setPlansLoading] = useState(false);
  const [selectedChildId, setSelectedChildId] = useState("");
  const [selectedCharacterId, setSelectedCharacterId] = useState("");
  const [configuration, setConfiguration] =
    useState<LearningPlanConfiguration>(defaultConfiguration);
  const [loadError, setLoadError] = useState("");
  const [notice, setNotice] = useState<Notice | null>(null);
  const [saving, setSaving] = useState(false);
  const [reload, setReload] = useState(0);
  const generationControllerRef = useRef<AbortController | null>(null);
  const generationRequestRef =
    useRef<LearningPlanGenerationRequestIdentity | null>(null);
  const contentControllerRef = useRef<AbortController | null>(null);
  const [generationState, setGenerationState] =
    useState<GenerationState>("idle");
  const [generationError, setGenerationError] = useState<string | null>(null);
  const [generationResultUnknown, setGenerationResultUnknown] = useState(false);
  const [draft, setDraft] = useState<ShortPlanDraftView | null>(null);
  const [draftPublished, setDraftPublished] = useState(false);
  const [publishing, setPublishing] = useState(false);

  const selectedPlan = useMemo(
    () =>
      plans.find(
        (plan) =>
          plan.childUserId === selectedChildId &&
          plan.characterId === selectedCharacterId,
      ) ?? null,
    [plans, selectedChildId, selectedCharacterId],
  );
  const selectedCharacter = useMemo(
    () =>
      targets.characters.find(
        (character) => character.id === selectedCharacterId,
      ) ?? null,
    [selectedCharacterId, targets.characters],
  );
  const shortPlanValue = useMemo<ShortPlanBuilderValue>(
    () => ({
      gradeLevel: configuration.gradeLevel,
      learningGoal: configuration.learningGoal ?? "",
      activityCount:
        configuration.activityCount as ShortPlanBuilderValue["activityCount"],
      durationDays: configuration.durationDays,
    }),
    [configuration],
  );

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    else if (!open && dialog.open) dialog.close();
    return () => {
      if (dialog.open) dialog.close();
    };
  }, [open]);

  useEffect(() => {
    if (!open) {
      setNotice(null);
      setLoadError("");
      return;
    }
    const controller = new AbortController();
    setLoadState("loading");
    setLoadError("");
    setNotice(null);
    void getLearningPlanTargets(controller.signal)
      .then((nextTargets) => {
        setTargets(nextTargets);
        setSelectedChildId((current) =>
          nextTargets.children.some((child) => child.id === current)
            ? current
            : (nextTargets.children[0]?.id ?? ""),
        );
        setSelectedCharacterId((current) =>
          nextTargets.characters.some((character) => character.id === current)
            ? current
            : (nextTargets.characters[0]?.id ?? ""),
        );
        setLoadState("ready");
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        if (handleUnauthorized(error, onUnauthorized)) return;
        setLoadState("error");
        setLoadError(presentTeachingError(error, "load"));
      });
    return () => controller.abort();
  }, [open, onUnauthorized, reload]);

  useEffect(() => {
    if (!open || !selectedChildId) {
      setPlans([]);
      setPlansLoading(false);
      return;
    }
    const controller = new AbortController();
    setPlansLoading(true);
    setLoadError("");
    void listLearningPlans(selectedChildId, controller.signal)
      .then((nextPlans) => {
        setPlans(nextPlans);
        setPlansLoading(false);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        if (handleUnauthorized(error, onUnauthorized)) return;
        setPlansLoading(false);
        setLoadError(presentTeachingError(error, "load"));
      });
    return () => controller.abort();
  }, [open, onUnauthorized, selectedChildId, reload]);

  useEffect(() => {
    generationControllerRef.current?.abort();
    generationControllerRef.current = null;
    contentControllerRef.current?.abort();
    contentControllerRef.current = null;
    setGenerationState("idle");
    setGenerationError(null);
    setGenerationResultUnknown(
      generationRequestRef.current?.childUserId === selectedChildId &&
        generationRequestRef.current.characterId === selectedCharacterId &&
        generationRequestRef.current.resultUnknown,
    );
    setDraft(null);
    setDraftPublished(false);
    setSaving(false);
    setPublishing(false);
  }, [open, selectedChildId, selectedCharacterId]);

  useEffect(() => {
    if (
      !open ||
      plansLoading ||
      !selectedChildId ||
      !selectedCharacterId ||
      !selectedPlan
    ) {
      return;
    }
    contentControllerRef.current?.abort();
    const controller = new AbortController();
    contentControllerRef.current = controller;
    void getLearningPlanContent(
      selectedChildId,
      selectedCharacterId,
      controller.signal,
    )
      .then((content) => {
        const contentToPreview = content.latestDraft ?? content.activeContent;
        if (!contentToPreview) return;
        setDraft(toShortPlanDraftView(contentToPreview));
        setDraftPublished(
          content.activeContent?.contentRevisionId ===
            contentToPreview.contentRevisionId,
        );
        setGenerationState("ready");
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        if (handleUnauthorized(error, onUnauthorized)) return;
        // Content preview is supplementary. Existing settings remain editable.
      });
    return () => {
      controller.abort();
      if (contentControllerRef.current === controller) {
        contentControllerRef.current = null;
      }
    };
  }, [
    open,
    onUnauthorized,
    plansLoading,
    reload,
    selectedChildId,
    selectedCharacterId,
  ]);

  useEffect(() => {
    setConfiguration(
      selectedPlan
        ? {
            enabled: selectedPlan.enabled,
            subject: selectedPlan.subject,
            difficulty: selectedPlan.difficulty,
            triggerMode: selectedPlan.triggerMode,
            gradeLevel: selectedPlan.gradeLevel,
            learningGoal: selectedPlan.learningGoal,
            activityCount: selectedPlan.activityCount,
            durationDays: selectedPlan.durationDays,
          }
        : defaultConfiguration,
    );
  }, [selectedPlan]);

  const updateConfiguration = (
    next:
      | LearningPlanConfiguration
      | ((current: LearningPlanConfiguration) => LearningPlanConfiguration),
  ) => {
    contentControllerRef.current?.abort();
    contentControllerRef.current = null;
    setConfiguration(next);
    setDraft(null);
    setDraftPublished(false);
    setGenerationState("idle");
    setGenerationError(null);
  };

  const updateShortPlan = (next: ShortPlanBuilderValue) => {
    updateConfiguration((current) => ({
      ...current,
      subject:
        shortPlanRecommendedSubject(next.learningGoal) ?? current.subject,
      gradeLevel: next.gradeLevel,
      learningGoal: next.learningGoal,
      activityCount: next.activityCount,
      durationDays: next.durationDays,
    }));
  };

  const applyShortPlanExample = (example: ShortPlanExample) => {
    updateConfiguration((current) => ({
      ...current,
      enabled: true,
      subject: example.subject,
      gradeLevel: example.value.gradeLevel,
      learningGoal: example.value.learningGoal,
      activityCount: example.value.activityCount,
      durationDays: example.value.durationDays,
    }));
  };

  const generateShortPlan = async () => {
    const existingGenerationId = resolveLearningPlanGenerationReadId(
      generationRequestRef.current,
      {
        childUserId: selectedChildId,
        characterId: selectedCharacterId,
      },
    );
    const normalizedGoal =
      normalizeLearningGoalForSave(configuration.learningGoal) ?? "";
    const validationError = existingGenerationId
      ? null
      : configuration.gradeLevel === "unspecified"
        ? "生成计划前，请先选择一个参考阶段。"
        : validateShortPlanGoal(normalizedGoal);
    if (
      validationError ||
      !selectedChildId ||
      !selectedCharacterId ||
      saving ||
      plansLoading
    ) {
      if (validationError) {
        setGenerationState("failed");
        setGenerationError(validationError);
      }
      return;
    }

    generationControllerRef.current?.abort();
    const controller = new AbortController();
    generationControllerRef.current = controller;
    setSaving(true);
    setGenerationState("generating");
    setGenerationError(null);
    setDraft(null);
    setDraftPublished(false);
    setNotice(null);

    try {
      let requestIdentity: LearningPlanGenerationRequestIdentity;
      let requested: LearningPlanGenerationResponse;
      if (existingGenerationId && generationRequestRef.current) {
        requestIdentity = generationRequestRef.current;
        requested = await getLearningPlanGeneration(
          selectedChildId,
          selectedCharacterId,
          existingGenerationId,
          controller.signal,
        );
      } else {
        const saved = await putLearningPlan(
          selectedChildId,
          selectedCharacterId,
          {
            expectedRevision: selectedPlan?.revision ?? null,
            ...configuration,
            learningGoal: normalizedGoal,
          },
        );
        if (controller.signal.aborted) return;
        rememberLearningPlan(setPlans, saved);

        requestIdentity = resolveLearningPlanGenerationRequestIdentity(
          generationRequestRef.current,
          {
            childUserId: selectedChildId,
            characterId: selectedCharacterId,
            planRevision: saved.revision,
          },
        );
        generationRequestRef.current = requestIdentity;
        requested = await requestLearningPlanGeneration(
          selectedChildId,
          selectedCharacterId,
          {
            expectedPlanRevision: saved.revision,
            clientRequestId: requestIdentity.clientRequestId,
            generationMode: "text_model",
          },
        );
        requestIdentity = {
          ...requestIdentity,
          generationId: requested.generation.id,
        };
        if (
          generationRequestRef.current?.clientRequestId ===
          requestIdentity.clientRequestId
        ) {
          generationRequestRef.current = requestIdentity;
        }
      }
      const completed = await pollLearningPlanGeneration({
        initial: requested,
        childUserId: selectedChildId,
        characterId: selectedCharacterId,
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;

      const resultUnknown =
        completed.generation.status === "failed" &&
        completed.generation.errorCode === "model_result_unknown";
      if (
        resultUnknown &&
        generationRequestRef.current?.clientRequestId ===
          requestIdentity.clientRequestId
      ) {
        generationRequestRef.current = {
          ...requestIdentity,
          generationId: completed.generation.id,
          resultUnknown: true,
        };
      }
      if (
        !resultUnknown &&
        (completed.generation.status === "succeeded" ||
          completed.generation.status === "failed" ||
          completed.generation.status === "superseded")
      ) {
        if (
          generationRequestRef.current?.clientRequestId ===
          requestIdentity.clientRequestId
        ) {
          generationRequestRef.current = null;
        }
      }
      setGenerationResultUnknown(resultUnknown);

      if (completed.generation.status === "succeeded" && completed.draft) {
        setDraft(toShortPlanDraftView(completed.draft));
        setDraftPublished(false);
        setGenerationState("ready");
        return;
      }

      setGenerationState("failed");
      setGenerationError(
        completed.generation.status === "failed"
          ? generationFailureMessage(completed.generation.errorCode)
          : completed.generation.status === "superseded"
            ? "学习设置已经变化，这份旧草稿已停止生成。请确认当前目标后重新生成。"
            : "计划仍在后台生成，可以稍后重新打开这个设置查看。",
      );
    } catch (error) {
      if (controller.signal.aborted || isAbortError(error)) return;
      if (handleUnauthorized(error, onUnauthorized)) return;
      if (error instanceof TeachingApiError && error.status === 409) {
        setGenerationState("failed");
        setGenerationError(
          "设置刚被其他页面更新，已开始重新读取；请确认当前目标后再生成。",
        );
        setReload((current) => current + 1);
      } else {
        setGenerationState("failed");
        setGenerationError(presentGenerationRequestError(error));
      }
    } finally {
      if (generationControllerRef.current === controller) {
        generationControllerRef.current = null;
        setSaving(false);
      }
    }
  };

  const publishShortPlan = async () => {
    if (
      !draft ||
      !selectedPlan ||
      !selectedChildId ||
      !selectedCharacterId ||
      publishing
    ) {
      return;
    }
    setPublishing(true);
    setNotice(null);
    try {
      const published = await publishLearningPlanContent(
        selectedChildId,
        selectedCharacterId,
        {
          expectedPlanRevision: selectedPlan.revision,
          contentRevisionId: draft.contentRevisionId,
          reviewConfirmed: true,
        },
      );
      rememberLearningPlan(setPlans, published.learningPlan);
      setDraft(toShortPlanDraftView(published.activeContent));
      setDraftPublished(true);
      setGenerationState("ready");
      setNotice({
        kind: "success",
        message: selectedCharacter?.teachingAvailability.available
          ? "短期学习计划已确认，将从孩子下一次通话开始使用。"
          : "短期学习计划已确认；待这个角色的实时模型支持后生效，普通聊天不受影响。",
      });
    } catch (error) {
      if (handleUnauthorized(error, onUnauthorized)) return;
      if (error instanceof TeachingApiError && error.status === 409) {
        setNotice({
          kind: "error",
          message: "设置刚被其他页面更新，这份草稿没有启用。已重新读取。",
        });
        setReload((current) => current + 1);
      } else {
        setNotice({
          kind: "error",
          message: "草稿没有启用，当前学习内容保持不变。请稍后再试。",
        });
      }
    } finally {
      setPublishing(false);
    }
  };

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (
      !selectedChildId ||
      !selectedCharacterId ||
      saving ||
      plansLoading ||
      Boolean(loadError)
    )
      return;
    const normalizedLearningGoal = normalizeLearningGoalForSave(
      configuration.learningGoal,
    );
    if (
      selectedPlan &&
      shouldConfirmPublishedShortPlanRemoval({
        activeContentRevisionId: selectedPlan.activeContentRevisionId,
        persistedLearningGoal: selectedPlan.learningGoal,
        nextLearningGoal: normalizedLearningGoal,
      }) &&
      !window.confirm(
        configuration.subject === "chinese"
          ? "清除目标会停用当前已发布的短期内容；在发布新计划前，这个角色只进行普通聊天。确定继续吗？"
          : "清除目标会停用当前已发布的短期内容，并恢复这个学科的基础内容。确定继续吗？",
      )
    ) {
      return;
    }
    setSaving(true);
    setNotice(null);
    try {
      const saved = await putLearningPlan(
        selectedChildId,
        selectedCharacterId,
        {
          expectedRevision: selectedPlan?.revision ?? null,
          ...configuration,
          learningGoal: normalizedLearningGoal,
        },
      );
      rememberLearningPlan(setPlans, saved);
      if (
        generationRequestRef.current &&
        generationRequestRef.current.planRevision !== saved.revision
      ) {
        generationRequestRef.current = null;
        setGenerationResultUnknown(false);
      }
      setNotice({
        kind: "success",
        message: !configuration.enabled
          ? "这个角色的学习小支线已关闭。"
          : normalizedLearningGoal === null &&
              selectedPlan?.activeContentRevisionId
            ? configuration.subject === "chinese"
              ? "已清除短期目标；在发布新计划前，这个角色只进行普通聊天。"
              : "已清除短期目标并恢复基础学习内容，将从孩子下一次通话开始生效。"
            : configuration.learningGoal?.trim() ||
                configuration.subject === "chinese"
              ? "基础设置已保存；生成并确认短期计划草稿后才会替换当前学习内容。"
              : selectedCharacter?.teachingAvailability.available
                ? "学习小支线已保存，将从孩子下一次通话开始生效。"
                : "学习小支线已保存；待这个角色的实时模型支持后生效，普通聊天不受影响。",
      });
    } catch (error) {
      if (handleUnauthorized(error, onUnauthorized)) return;
      if (error instanceof TeachingApiError && error.status === 409) {
        setNotice({
          kind: "error",
          message: "设置刚被其他页面更新，已重新读取，请确认后再保存。",
        });
        setReload((current) => current + 1);
      } else {
        setNotice({
          kind: "error",
          message: presentTeachingError(error, "save"),
        });
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <dialog
      ref={dialogRef}
      className="teaching-plans-panel"
      aria-labelledby="teaching-plans-title"
      aria-modal="true"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <header className="admin-panel-header">
        <div>
          <p className="product-eyebrow">LEARNING BRANCH</p>
          <h2 id="teaching-plans-title">学习小支线</h2>
          <p>给角色设一个轻量目标；孩子每次都能选择只聊天。</p>
        </div>
        <button
          className="ui-icon-button"
          type="button"
          onClick={onClose}
          aria-label="关闭学习小支线设置"
        >
          ×
        </button>
      </header>

      <div className="teaching-plans-content">
        <section className="teaching-boundary-note" aria-label="功能边界">
          <strong>先从一个可控的小目标开始</strong>
          <p>
            所有儿童可见的家庭公共角色都能先配置；角色名称后的状态会说明当前能否生效。角色会等到安全的下一轮再自然衔接，不会把隐藏提示或内部判断展示给孩子。
          </p>
          <p>
            {currentUser.accountType === "admin"
              ? "管理员可以配置家庭中的儿童账号。"
              : "你只能看到服务端允许你配置的儿童账号。"}
          </p>
        </section>

        {loadState === "loading" && (
          <p className="teaching-panel-state" role="status">
            正在读取可配置的孩子与角色…
          </p>
        )}
        {loadError && (
          <div className="product-notice error" role="alert">
            {loadError}
            <button
              type="button"
              onClick={() => setReload((value) => value + 1)}
            >
              重试
            </button>
          </div>
        )}
        {notice && (
          <div
            className={`product-notice ${notice.kind}`}
            role={notice.kind === "error" ? "alert" : "status"}
          >
            {notice.message}
          </div>
        )}

        {loadState === "ready" && targets.children.length === 0 && (
          <p className="teaching-panel-state">
            目前没有你可以配置的儿童账号。普通角色聊天不受影响。
          </p>
        )}
        {loadState === "ready" &&
          targets.children.length > 0 &&
          targets.characters.length === 0 && (
            <p className="teaching-panel-state">
              目前没有儿童可见的家庭公共角色；私人角色需要先共享给家庭。
            </p>
          )}

        {loadState === "ready" &&
          targets.children.length > 0 &&
          targets.characters.length > 0 && (
            <form
              className="teaching-plan-form"
              aria-busy={
                plansLoading || generationState === "generating" || publishing
              }
              onSubmit={(event) => void save(event)}
            >
              <div className="teaching-plan-targets">
                <label>
                  <span>孩子</span>
                  <select
                    value={selectedChildId}
                    disabled={
                      saving || publishing || generationState === "generating"
                    }
                    onChange={(event) => setSelectedChildId(event.target.value)}
                  >
                    {targets.children.map((child) => (
                      <option key={child.id} value={child.id}>
                        {child.displayName}
                      </option>
                    ))}
                  </select>
                </label>
                <TeachingCharacterSelector
                  characters={targets.characters}
                  selectedCharacterId={selectedCharacterId}
                  disabled={
                    saving || publishing || generationState === "generating"
                  }
                  onChange={setSelectedCharacterId}
                />
              </div>

              <label className="teaching-enabled-field">
                <input
                  type="checkbox"
                  checked={configuration.enabled}
                  disabled={saving || publishing}
                  onChange={(event) =>
                    updateConfiguration((current) => ({
                      ...current,
                      enabled: event.target.checked,
                    }))
                  }
                />
                <span>
                  <strong>允许这个角色带来学习小支线</strong>
                  <small>关闭后，孩子与这个角色的通话只保留普通聊天。</small>
                </span>
              </label>

              <fieldset
                disabled={!configuration.enabled || saving || publishing}
              >
                <legend>小支线范围</legend>
                <div className="teaching-plan-options">
                  <label>
                    <span>主题</span>
                    <select
                      value={configuration.subject}
                      onChange={(event) =>
                        updateConfiguration((current) => ({
                          ...current,
                          subject: event.target
                            .value as LearningPlanConfiguration["subject"],
                        }))
                      }
                    >
                      {teachingSubjectOptions.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    <span>互动挑战度</span>
                    <select
                      value={configuration.difficulty}
                      onChange={(event) =>
                        updateConfiguration((current) => ({
                          ...current,
                          difficulty: event.target
                            .value as LearningPlanConfiguration["difficulty"],
                        }))
                      }
                    >
                      <option value="starter">轻松入门</option>
                      <option value="growing">逐步提升</option>
                      <option value="challenge">稍有挑战</option>
                    </select>
                  </label>
                  <label>
                    <span>出现方式</span>
                    <select
                      value={configuration.triggerMode}
                      onChange={(event) =>
                        updateConfiguration((current) => ({
                          ...current,
                          triggerMode: event.target
                            .value as LearningPlanConfiguration["triggerMode"],
                        }))
                      }
                    >
                      <option value="gentle">合适时轻轻邀请</option>
                      <option value="on_request">只在孩子点按钮时开始</option>
                    </select>
                  </label>
                </div>
              </fieldset>

              <ShortLearningPlanBuilder
                value={shortPlanValue}
                disabled={
                  !configuration.enabled ||
                  saving ||
                  plansLoading ||
                  Boolean(loadError)
                }
                generationState={generationState}
                generationError={generationError}
                generationResultUnknown={generationResultUnknown}
                draft={draft}
                draftPublished={draftPublished}
                publishing={publishing}
                onChange={updateShortPlan}
                onApplyExample={applyShortPlanExample}
                onGenerate={() => void generateShortPlan()}
                onPublish={() => void publishShortPlan()}
              />

              <div className="teaching-plan-submit">
                <p>
                  {plansLoading
                    ? "正在读取这个孩子现有的角色设置…"
                    : "这里只保存基础设置；“生成短期计划”会调用已配置的大模型生成草稿，成人确认前不会生效。"}
                </p>
                <button
                  type="submit"
                  disabled={
                    saving || publishing || plansLoading || Boolean(loadError)
                  }
                >
                  {saving ? "正在保存…" : "保存基础设置"}
                </button>
              </div>
            </form>
          )}
      </div>
    </dialog>
  );
}

function rememberLearningPlan(
  setPlans: Dispatch<SetStateAction<ChildCharacterLearningPlan[]>>,
  saved: ChildCharacterLearningPlan,
) {
  setPlans((current) => [
    ...current.filter(
      (plan) =>
        plan.childUserId !== saved.childUserId ||
        plan.characterId !== saved.characterId,
    ),
    saved,
  ]);
}

export function toShortPlanDraftView(
  content: LearningPlanContentRevision,
): ShortPlanDraftView {
  return {
    contentRevisionId: content.contentRevisionId,
    title: content.title,
    goal: `${shortPlanGradeLabel(content.gradeLevel)} · ${content.normalizedGoal}`,
    durationDays: content.durationDays,
    source:
      content.schemaVersion === "generated-teaching-plan-v2"
        ? "model_generated"
        : "legacy_reviewed",
    items: content.activities.map(toShortPlanDraftItemView),
    pendingSupportMessage: null,
  };
}

function toShortPlanDraftItemView(
  item: LearningPlanContentRevision["activities"][number],
): ShortPlanDraftItemView {
  switch (item.kind) {
    case "model_generated_activity": {
      const common = {
        id: item.key,
        title: item.title,
        detail: item.objective,
      };
      switch (item.activityType) {
        case "explain_and_reflect":
          return {
            ...common,
            typeLabel: "讲解与思考",
            reviewFields: [
              { label: "讲解内容", value: item.teachingText },
              { label: "反思问题", value: item.reflectionPrompt },
              { label: "示例回答", value: item.exampleResponse },
              { label: "反馈内容", value: item.feedbackText },
            ],
          };
        case "multiple_choice": {
          const correctChoice = item.choices.find(
            (choice) => choice.id === item.correctChoiceId,
          );
          return {
            ...common,
            typeLabel: "选择题",
            reviewFields: [
              { label: "题目", value: item.questionText },
              {
                label: "选项",
                value: item.choices.map(
                  (choice) => `${choice.id.toUpperCase()}. ${choice.text}`,
                ),
              },
              {
                label: "参考答案",
                value: correctChoice
                  ? `${correctChoice.id.toUpperCase()}. ${correctChoice.text}`
                  : item.correctChoiceId.toUpperCase(),
              },
              { label: "提示", value: item.hintText },
              { label: "答案讲解", value: item.answerExplanation },
            ],
          };
        }
        case "short_answer":
          return {
            ...common,
            typeLabel: "简答题",
            reviewFields: [
              { label: "题目", value: item.questionText },
              { label: "可接受回答", value: item.acceptedAnswers },
              { label: "提示", value: item.hintText },
              { label: "答案讲解", value: item.answerExplanation },
            ],
          };
      }
      throw new Error("不支持的模型生成教学活动。");
    }
    case "reviewed_catalog_ref":
      return {
        id: item.key,
        typeLabel: "已审核内容",
        title: reviewedCatalogItemLabel(item.catalogItemId),
        detail:
          "来自版本化内容目录；角色只会在一次邀请和一次简短反馈内自然表达。",
      };
    case "pinyin_practice": {
      const syllable = `${item.initial ?? ""}${item.final}`;
      switch (item.practiceMode) {
        case "blend":
          return {
            id: item.key,
            typeLabel: "拼音拼读",
            title: item.initial
              ? `${item.initial} + ${item.final} = ${syllable}`
              : `拼读 ${syllable}`,
            detail: "可以尝试拼读，也可以只听一次示范；不做发音评分。",
          };
        case "recognize":
          return {
            id: item.key,
            typeLabel: "拼音辨认",
            title: `辨认音节 ${syllable}`,
            detail: "只做一个简短选择，允许提示一次，也可以立即跳过。",
          };
        case "tone_demo":
          return {
            id: item.key,
            typeLabel: "声调示范",
            title: `${syllable} 的第 ${item.tone} 声`,
            detail: "角色示范一次声调，不依据实时转写判断孩子发音好坏。",
          };
      }
      return {
        id: item.key,
        typeLabel: "拼音练习",
        title: `练习音节 ${syllable}`,
        detail: "只进行一次可跳过的受控拼音活动，不做发音评分。",
      };
    }
    case "multiplication_fact":
      return {
        id: item.key,
        typeLabel: "乘法口诀",
        title: `${item.multiplicand} × ${item.multiplier} = ${item.product}`,
        detail: `${multiplicationScenarioLabel(item.scenario)}情境；答案由确定性规则校验，每次只问这一道。`,
      };
  }
}

function reviewedCatalogItemLabel(catalogItemId: string): string {
  switch (catalogItemId) {
    case "english-space-orbit-v1":
      return "太空英语：orbit";
    case "math-space-supplies-v1":
      return "飞船补给乘法题";
    case "science-space-gravity-v1":
      return "地球引力知识彩蛋";
    default:
      return "受控学习活动";
  }
}

function multiplicationScenarioLabel(
  scenario: Extract<
    LearningPlanContentRevision["activities"][number],
    { kind: "multiplication_fact" }
  >["scenario"],
): string {
  switch (scenario) {
    case "supplies":
      return "补给";
    case "energy":
      return "能量";
    case "formation":
      return "编队";
    case "equipment":
      return "装备";
  }
}

async function pollLearningPlanGeneration(input: {
  initial: LearningPlanGenerationResponse;
  childUserId: string;
  characterId: string;
  signal: AbortSignal;
}): Promise<LearningPlanGenerationResponse> {
  let current = input.initial;
  for (let attempt = 0; attempt < generationMaximumPolls; attempt += 1) {
    if (!isPendingGeneration(current)) return current;
    await abortableDelay(generationPollIntervalMs, input.signal);
    current = await getLearningPlanGeneration(
      input.childUserId,
      input.characterId,
      current.generation.id,
      input.signal,
    );
  }
  return current;
}

function isPendingGeneration(response: LearningPlanGenerationResponse) {
  return (
    response.generation.status === "queued" ||
    response.generation.status === "running"
  );
}

function abortableDelay(milliseconds: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const timeoutId = window.setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);
    const abort = () => {
      window.clearTimeout(timeoutId);
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal.addEventListener("abort", abort, { once: true });
  });
}

export function generationFailureMessage(
  errorCode: TeachingPlanGenerationErrorCode | null,
): string {
  switch (errorCode) {
    case "generator_not_configured":
      return "需要管理员先在“模型设置”中绑定并启用“教学计划生成模型”。基础设置和当前已启用计划不受影响。";
    case "model_configuration_changed":
      return "生成期间教学计划模型配置发生变化，没有采用这次结果。请重新生成。";
    case "model_request_failed":
      return "教学计划模型这次没有完成请求。当前学习内容没有变化，可以稍后重试。";
    case "model_result_unknown":
      return "供应商可能已计费，系统未自动重试。如确认再次生成，请先修改并保存学习设置形成新版本。";
    case "invalid_generation_input":
      return "生成前的计划配置校验没有通过，当前学习内容没有变化。请重新保存年级和目标后再试。";
    case "invalid_model_output":
      return "模型返回了空内容，或计划不符合严格结构，因此没有交给角色使用。系统不会自动重试以免重复计费；可以调整目标后再生成。";
    case "content_compilation_failed":
      return "模型草稿没有通过运行时安全编译，因此没有生成可启用的活动。可以调整目标后重试。";
    case "plan_revision_changed":
      return "生成期间学习设置已经变化，这份草稿已作废。请确认当前目标后重试。";
    case "worker_interrupted":
      return "生成任务被中断，当前学习内容没有变化。请稍后重试。";
    case "unsupported_goal":
      return "模型没有为这个目标生成可安全预览的活动。请把学习内容和期望练习方式写得更具体。";
    case "needs_clarification":
      return "目标还不够明确。请补充要学习的具体内容、范围或练习方式后重新生成。";
    case null:
      return "这次没有生成可确认的草稿，当前学习内容没有变化。";
  }
}

function presentGenerationRequestError(error: unknown): string {
  if (error instanceof TeachingApiError && error.status === 403) {
    return "当前账号没有为这个孩子生成学习计划的权限。";
  }
  if (error instanceof TeachingApiError && error.status === 404) {
    return "孩子、角色或生成任务已经不可用，请重新打开设置。";
  }
  return "短期计划暂时没有生成，现有学习设置没有变化。请稍后再试。";
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function handleUnauthorized(error: unknown, invalidate: () => void): boolean {
  if (error instanceof TeachingApiError && error.status === 401) {
    invalidate();
    return true;
  }
  return false;
}

function presentTeachingError(
  error: unknown,
  operation: "load" | "save",
): string {
  if (error instanceof TeachingApiError && error.status === 403) {
    return "当前账号没有管理这项设置的权限。";
  }
  if (error instanceof TeachingApiError && error.status === 404) {
    return "孩子或角色已经不可用，请返回后重试。";
  }
  return operation === "save"
    ? "没有保存成功，请稍后再试。"
    : "暂时无法读取学习小支线设置。";
}
