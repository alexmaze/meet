export const shortPlanGradeLevels = [
  "preschool",
  "grade_1",
  "grade_2",
  "grade_3",
  "grade_4",
  "grade_5",
  "grade_6",
  "grade_7",
  "grade_8",
  "grade_9",
  "grade_10",
  "grade_11",
  "grade_12",
  "unspecified",
] as const;

export type ShortPlanGradeLevel = (typeof shortPlanGradeLevels)[number];
export type ShortPlanActivityCount = 3 | 4 | 5 | 6 | 7 | 8;
export type ShortPlanDurationDays = 7 | 14;

export type ShortPlanBuilderValue = Readonly<{
  gradeLevel: ShortPlanGradeLevel;
  learningGoal: string;
  activityCount: ShortPlanActivityCount;
  durationDays: ShortPlanDurationDays;
}>;

export type ShortPlanExample = Readonly<{
  id: "pinyin" | "multiplication" | "science";
  label: string;
  subject: "chinese" | "math" | "science" | "english" | "general";
  value: ShortPlanBuilderValue;
}>;

export const shortPlanExamples: readonly ShortPlanExample[] = Object.freeze([
  Object.freeze({
    id: "pinyin",
    label: "试填拼音目标",
    subject: "chinese",
    value: Object.freeze({
      gradeLevel: "grade_1",
      learningGoal: "练习 b、p、m、f 的基础拼读；可以示范，不做发音评分。",
      activityCount: 4,
      durationDays: 7,
    }),
  }),
  Object.freeze({
    id: "multiplication",
    label: "试填乘法目标",
    subject: "math",
    value: Object.freeze({
      gradeLevel: "grade_2",
      learningGoal:
        "熟悉 2～5 的乘法口诀，优先使用生活或角色冒险情境，每次只问一道。",
      activityCount: 4,
      durationDays: 7,
    }),
  }),
  Object.freeze({
    id: "science",
    label: "试填科学目标",
    subject: "science",
    value: Object.freeze({
      gradeLevel: "grade_3",
      learningGoal:
        "认识太阳系八颗行星的顺序，并用三个简短问题复习各自的一个特点。",
      activityCount: 4,
      durationDays: 7,
    }),
  }),
]);

export type ShortPlanDraftItemView = Readonly<{
  id: string;
  title: string;
  detail: string;
  typeLabel: string;
  reviewFields?: readonly Readonly<{
    label: string;
    value: string | readonly string[];
  }>[];
}>;

export type ShortPlanDraftView = Readonly<{
  contentRevisionId: string;
  title: string;
  goal: string;
  durationDays: ShortPlanDurationDays;
  source: "model_generated" | "legacy_reviewed";
  items: readonly ShortPlanDraftItemView[];
  pendingSupportMessage: string | null;
}>;

type ShortLearningPlanBuilderProps = {
  value: ShortPlanBuilderValue;
  disabled?: boolean;
  generationState: "idle" | "generating" | "failed" | "ready";
  generationError?: string | null;
  generationResultUnknown?: boolean;
  draft: ShortPlanDraftView | null;
  draftPublished?: boolean;
  publishing?: boolean;
  onChange: (value: ShortPlanBuilderValue) => void;
  onApplyExample: (example: ShortPlanExample) => void;
  onGenerate: () => void;
  onPublish: () => void;
};

export function ShortLearningPlanBuilder({
  value,
  disabled = false,
  generationState,
  generationError,
  generationResultUnknown = false,
  draft,
  draftPublished = false,
  publishing = false,
  onChange,
  onApplyExample,
  onGenerate,
  onPublish,
}: ShortLearningPlanBuilderProps) {
  const goalError = validateShortPlanGoal(value.learningGoal);
  const gradeError =
    value.gradeLevel === "unspecified"
      ? "生成计划前，请先选择一个参考阶段。"
      : null;
  const busy = generationState === "generating" || publishing;

  return (
    <fieldset className="short-plan-builder" disabled={disabled || busy}>
      <legend>短期学习计划</legend>
      <div className="short-plan-heading">
        <div>
          <strong>告诉系统最近想练什么</strong>
          <p>
            可以填写任意具体学习目标。年级只用来调整表达，不代表系统判断孩子的能力；大模型生成的草稿需要成人确认后才会启用。
          </p>
        </div>
        <div className="short-plan-examples" aria-label="学习目标示例">
          {shortPlanExamples.map((example) => (
            <button
              key={example.id}
              type="button"
              onClick={() => onApplyExample(example)}
            >
              {example.label}
            </button>
          ))}
        </div>
      </div>

      <div className="short-plan-fields">
        <label>
          <span>参考阶段</span>
          <select
            value={value.gradeLevel}
            onChange={(event) =>
              onChange({
                ...value,
                gradeLevel: event.target.value as ShortPlanGradeLevel,
              })
            }
          >
            {shortPlanGradeLevels.map((gradeLevel) => (
              <option key={gradeLevel} value={gradeLevel}>
                {shortPlanGradeLabel(gradeLevel)}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>活动数（建议 3～5 个）</span>
          <select
            value={value.activityCount}
            onChange={(event) =>
              onChange({
                ...value,
                activityCount: Number(
                  event.target.value,
                ) as ShortPlanActivityCount,
              })
            }
          >
            <option value={3}>3 个</option>
            <option value={4}>4 个</option>
            <option value={5}>5 个</option>
            <option value={6}>6 个</option>
            <option value={7}>7 个</option>
            <option value={8}>8 个</option>
          </select>
        </label>
        <label>
          <span>计划时长</span>
          <select
            value={value.durationDays}
            onChange={(event) =>
              onChange({
                ...value,
                durationDays: Number(
                  event.target.value,
                ) as ShortPlanDurationDays,
              })
            }
          >
            <option value={7}>7 天</option>
            <option value={14}>14 天</option>
          </select>
        </label>
      </div>
      {gradeError && <small className="field-error">{gradeError}</small>}

      <label className="short-plan-goal-field">
        <span>具体学习目标</span>
        <textarea
          value={value.learningGoal}
          maxLength={300}
          rows={4}
          aria-describedby="short-plan-goal-guidance"
          aria-invalid={goalError ? "true" : undefined}
          placeholder="例如：熟悉 2～5 的乘法口诀，每次只问一道简单应用题。"
          onChange={(event) =>
            onChange({ ...value, learningGoal: event.target.value })
          }
        />
        <small id="short-plan-goal-guidance">
          只写学习内容，不要填写孩子姓名、学校、老师、健康、情绪或家庭经历等隐私。目标会发送给管理员配置的教学计划生成模型。
        </small>
        {goalError && value.learningGoal.length > 0 && (
          <small className="field-error">{goalError}</small>
        )}
      </label>

      <div className="short-plan-support-note" role="note">
        {shortPlanSupportMessage(value.learningGoal)}
      </div>

      {generationResultUnknown ? (
        <div className="short-plan-generation-error" role="alert">
          <strong>模型结果仍不确定</strong>
          <span>
            {generationError ??
              "供应商可能已计费，系统未自动重试。如确认再次生成，请先修改并保存学习设置形成新版本。"}
          </span>
        </div>
      ) : generationState === "failed" ? (
        <div className="short-plan-generation-error" role="alert">
          <strong>这次没有生成草稿</strong>
          <span>
            {generationError ??
              "现有学习设置没有变化。可以修改目标后重试，或继续使用基础主题设置。"}
          </span>
        </div>
      ) : null}

      <div className="short-plan-generate-row">
        <p>
          需要管理员先在“模型设置”绑定并启用“教学计划生成模型”。生成时不会联网检索；确认草稿前，不会替换当前正在使用的学习内容。
          每次生成会调用管理员配置的文本模型，可能产生一次模型费用；网络结果未知时只会检查同一请求，不会自动再次调用模型。要再次生成，请先修改并保存学习设置形成新版本。
        </p>
        <button
          type="button"
          className="short-plan-generate-button"
          disabled={
            disabled || busy || Boolean(goalError) || Boolean(gradeError)
          }
          onClick={onGenerate}
        >
          {generationState === "generating"
            ? generationResultUnknown
              ? "正在检查已有结果…"
              : "大模型正在生成…"
            : generationResultUnknown
              ? "检查已有结果"
              : generationState === "failed"
                ? "重新生成"
                : "生成短期计划"}
        </button>
      </div>

      {draft && generationState === "ready" && (
        <ShortPlanDraftPreview
          draft={draft}
          published={draftPublished}
          publishing={publishing}
          onPublish={onPublish}
        />
      )}

      {generationState === "generating" && (
        <div className="short-plan-generation-status" role="status">
          <strong>大模型正在生成计划草稿</strong>
          <span>当前不联网检索；完成后请成人逐项预览并确认。</span>
        </div>
      )}
    </fieldset>
  );
}

export function ShortPlanDraftPreview({
  draft,
  published = false,
  publishing = false,
  onPublish,
}: {
  draft: ShortPlanDraftView;
  published?: boolean;
  publishing?: boolean;
  onPublish: () => void;
}) {
  return (
    <section
      className="short-plan-preview"
      aria-labelledby="short-plan-preview-title"
    >
      <div className="short-plan-preview-heading">
        <div>
          <p>{published ? "当前已启用" : "待成人确认"}</p>
          <h3 id="short-plan-preview-title">{draft.title}</h3>
          <span>{draft.goal}</span>
        </div>
        <span className="short-plan-preview-count">
          {draft.items.length} 个活动 · {draft.durationDays} 天
        </span>
      </div>

      {draft.source === "model_generated" ? (
        <div className="short-plan-source-note" role="note">
          <strong>来源：模型生成 · 未联网</strong>
          <span>
            内容可能有事实错误，也没有引用外部资料。请家长逐项核对题目、答案、讲解和年龄适配性后再启用。
          </span>
        </div>
      ) : (
        <div className="short-plan-source-note" role="note">
          <strong>来源：旧版已审核内容</strong>
          <span>这是升级前发布的活动，不代表本次调用了教学计划生成模型。</span>
        </div>
      )}

      {draft.pendingSupportMessage && (
        <div className="short-plan-pending-support" role="status">
          <strong>生成说明</strong>
          <span>{draft.pendingSupportMessage}</span>
        </div>
      )}

      <ol className="short-plan-preview-items">
        {draft.items.map((item) => (
          <li key={item.id}>
            <span className="short-plan-item-index" aria-hidden="true" />
            <div>
              <span>{item.typeLabel}</span>
              <strong>{item.title}</strong>
              <p>{item.detail}</p>
              {item.reviewFields && item.reviewFields.length > 0 && (
                <dl className="short-plan-review-fields">
                  {item.reviewFields.map((field, index) => (
                    <div key={`${field.label}-${index}`}>
                      <dt>{field.label}</dt>
                      <dd>
                        {typeof field.value === "string" ? (
                          field.value
                        ) : (
                          <ul>
                            {field.value.map((entry, entryIndex) => (
                              <li key={`${entry}-${entryIndex}`}>{entry}</li>
                            ))}
                          </ul>
                        )}
                      </dd>
                    </div>
                  ))}
                </dl>
              )}
            </div>
          </li>
        ))}
      </ol>

      <div className="short-plan-review-boundary">
        <p>
          请确认内容范围合适。启用后每次通话最多出现一个活动；孩子仍可随时跳过，系统不会记录分数或能力评价。
        </p>
        {published ? (
          <span className="short-plan-published-badge">已确认</span>
        ) : (
          <button type="button" disabled={publishing} onClick={onPublish}>
            {publishing ? "正在启用…" : "确认并启用"}
          </button>
        )}
      </div>
    </section>
  );
}

export function validateShortPlanGoal(goal: string): string | null {
  const normalized = goal.trim();
  if (!normalized) return "请先填写一个具体学习目标。";
  if (normalized.length < 4) return "目标再具体一点，至少写 4 个字。";
  if (normalized.length > 300) return "学习目标最多 300 个字。";
  return null;
}

export function shortPlanSupportMessage(goal: string): string {
  return goal.trim()
    ? "教学计划生成模型会把这个目标转换为可预览的活动草稿。模型可能出错，当前也不会联网核对，请成人确认后再启用。"
    : "可以填写拼音、数学、语言、科学或其他具体学习内容；生成需要管理员先配置教学计划生成模型。";
}

export function shortPlanRecommendedSubject(
  goal: string,
): "chinese" | "math" | null {
  const normalized = goal.trim().toLowerCase();
  const kinds = shortPlanGoalKinds(normalized);
  if (kinds.pinyin === kinds.multiplication) return null;
  if (kinds.pinyin) return "chinese";
  if (kinds.multiplication) return "math";
  return null;
}

function shortPlanGoalKinds(goal: string) {
  return {
    pinyin: /拼音|拼读|声母|韵母|音节|四声/.test(goal),
    multiplication: /乘法|口诀|×|乘以/.test(goal),
  };
}

export function shortPlanGradeLabel(gradeLevel: ShortPlanGradeLevel): string {
  switch (gradeLevel) {
    case "preschool":
      return "学前";
    case "grade_1":
      return "小学一年级";
    case "grade_2":
      return "小学二年级";
    case "grade_3":
      return "小学三年级";
    case "grade_4":
      return "小学四年级";
    case "grade_5":
      return "小学五年级";
    case "grade_6":
      return "小学六年级";
    case "grade_7":
      return "初中一年级";
    case "grade_8":
      return "初中二年级";
    case "grade_9":
      return "初中三年级";
    case "grade_10":
      return "高中一年级";
    case "grade_11":
      return "高中二年级";
    case "grade_12":
      return "高中三年级";
    case "unspecified":
      return "请选择参考阶段";
  }
}
