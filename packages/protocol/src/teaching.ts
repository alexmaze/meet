import { z } from "zod";

export const teachingSubjectSchema = z.enum([
  "english",
  "math",
  "science",
  "chinese",
  "general",
]);
export type TeachingSubject = z.infer<typeof teachingSubjectSchema>;

export const teachingGradeLevelSchema = z.enum([
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
]);
export type TeachingGradeLevel = z.infer<typeof teachingGradeLevelSchema>;

export const teachingPlanGenerationGradeLevelSchema =
  teachingGradeLevelSchema.refine(
    (gradeLevel): boolean => gradeLevel !== "unspecified",
    { message: "生成短期学习计划前必须明确选择年级。" },
  );

/**
 * Reviewed expression guidance used by the deterministic content compiler.
 * It changes wording complexity only; it must never be used to infer ability.
 */
export function teachingGradeExpressionGuidance(
  gradeLevel: TeachingGradeLevel,
): string {
  switch (gradeLevel) {
    case "preschool":
      return "表达边界：面向学龄前儿童，每句话尽量短，只用日常词语，一次只说一个动作或问题；不提年级、成绩或能力。";
    case "grade_1":
    case "grade_2":
      return "表达边界：使用小学低年级能理解的短句和具体例子，一次只说一个步骤；不提成绩或能力。";
    case "grade_3":
    case "grade_4":
      return "表达边界：使用小学中年级能理解的清楚短句，最多给一个必要步骤和一个具体例子；不提成绩或能力。";
    case "grade_5":
    case "grade_6":
      return "表达边界：使用小学高年级能理解的简洁表述，可以说明一个原因，但不要扩展到计划外知识；不提成绩或能力。";
    case "grade_7":
    case "grade_8":
    case "grade_9":
      return "表达边界：使用初中阶段能理解的清楚表述，可以说明必要概念与一层因果，但不要扩展到计划外知识；不提成绩或能力。";
    case "grade_10":
    case "grade_11":
    case "grade_12":
      return "表达边界：使用高中阶段能理解的准确、简洁表述，可以说明必要概念、条件和一层推理，但不要扩展到计划外知识；不提成绩或能力。";
    case "unspecified":
      return "表达边界：使用中性、简短、具体的儿童友好表述；不推断年龄、年级、成绩或能力。";
  }
}

export const teachingPlanDurationDaysSchema = z.union([
  z.literal(7),
  z.literal(14),
]);
export type TeachingPlanDurationDays = z.infer<
  typeof teachingPlanDurationDaysSchema
>;

export const DEFAULT_TEACHING_ACTIVITY_COUNT = 4 as const;
export const DEFAULT_TEACHING_PLAN_DURATION_DAYS = 7 as const;
export const TEACHING_LEARNING_GOAL_MAX_CHARACTERS = 300 as const;

export const teachingLearningGoalSchema = z
  .string()
  .trim()
  .min(1)
  .max(TEACHING_LEARNING_GOAL_MAX_CHARACTERS)
  .nullable();

export const teachingDifficultySchema = z.enum([
  "starter",
  "growing",
  "challenge",
]);
export type TeachingDifficulty = z.infer<typeof teachingDifficultySchema>;

export const teachingTriggerModeSchema = z.enum(["on_request", "gentle"]);
export type TeachingTriggerMode = z.infer<typeof teachingTriggerModeSchema>;

const learningPlanConfigurationCoreShape = {
  enabled: z.boolean(),
  subject: teachingSubjectSchema,
  difficulty: teachingDifficultySchema,
  triggerMode: teachingTriggerModeSchema,
};

const learningPlanConfigurationShape = {
  ...learningPlanConfigurationCoreShape,
  gradeLevel: teachingGradeLevelSchema,
  learningGoal: teachingLearningGoalSchema,
  activityCount: z.number().int().min(3).max(8),
  durationDays: teachingPlanDurationDaysSchema,
};

const learningPlanConfigurationInputShape = {
  ...learningPlanConfigurationCoreShape,
  gradeLevel: teachingGradeLevelSchema.default("unspecified"),
  learningGoal: teachingLearningGoalSchema.default(null),
  activityCount: learningPlanConfigurationShape.activityCount.default(
    DEFAULT_TEACHING_ACTIVITY_COUNT,
  ),
  durationDays: learningPlanConfigurationShape.durationDays.default(
    DEFAULT_TEACHING_PLAN_DURATION_DAYS,
  ),
};

export const learningPlanConfigurationSchema = z
  .object(learningPlanConfigurationShape)
  .strict();
export type LearningPlanConfiguration = z.infer<
  typeof learningPlanConfigurationSchema
>;

export const childCharacterLearningPlanSchema = z
  .object({
    id: z.uuid(),
    childUserId: z.uuid(),
    characterId: z.uuid(),
    ...learningPlanConfigurationShape,
    activeContentRevisionId: z.uuid().nullable(),
    activeContentActivatedAt: z.iso.datetime().nullable(),
    revision: z.number().int().positive(),
    createdByUserId: z.uuid(),
    updatedByUserId: z.uuid(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .strict();
export type ChildCharacterLearningPlan = z.infer<
  typeof childCharacterLearningPlanSchema
>;

export const learningPlanTargetChildSchema = z
  .object({
    id: z.uuid(),
    displayName: z.string().trim().min(1).max(80),
  })
  .strict();
export type LearningPlanTargetChild = z.infer<
  typeof learningPlanTargetChildSchema
>;

export const learningPlanTargetUnavailableReasonSchema = z.enum([
  "provider_unsupported",
  "configuration_not_approved",
  "realtime_unavailable",
]);
export type LearningPlanTargetUnavailableReason = z.infer<
  typeof learningPlanTargetUnavailableReasonSchema
>;

export const learningPlanTargetTeachingAvailabilitySchema =
  z.discriminatedUnion("available", [
    z.object({ available: z.literal(true) }).strict(),
    z
      .object({
        available: z.literal(false),
        reason: learningPlanTargetUnavailableReasonSchema,
      })
      .strict(),
  ]);
export type LearningPlanTargetTeachingAvailability = z.infer<
  typeof learningPlanTargetTeachingAvailabilitySchema
>;

export const learningPlanTargetCharacterSchema = z
  .object({
    id: z.uuid(),
    name: z.string().trim().min(1).max(80),
    teachingAvailability: learningPlanTargetTeachingAvailabilitySchema,
  })
  .strict();
export type LearningPlanTargetCharacter = z.infer<
  typeof learningPlanTargetCharacterSchema
>;

export const learningPlanTargetsResponseSchema = z
  .object({
    children: z.array(learningPlanTargetChildSchema),
    characters: z.array(learningPlanTargetCharacterSchema),
  })
  .strict();
export type LearningPlanTargetsResponse = z.infer<
  typeof learningPlanTargetsResponseSchema
>;

export const learningPlanListQuerySchema = z
  .object({ childUserId: z.uuid() })
  .strict();

export const learningPlanListResponseSchema = z
  .object({ learningPlans: z.array(childCharacterLearningPlanSchema) })
  .strict();
export type LearningPlanListResponse = z.infer<
  typeof learningPlanListResponseSchema
>;

export const learningPlanParamsSchema = z
  .object({
    childUserId: z.uuid(),
    characterId: z.uuid(),
  })
  .strict();

export const putLearningPlanRequestSchema = z
  .object({
    expectedRevision: z.number().int().positive().nullable(),
    ...learningPlanConfigurationInputShape,
  })
  .strict();
export type PutLearningPlanRequest = z.infer<
  typeof putLearningPlanRequestSchema
>;

export const learningPlanResponseSchema = z
  .object({ learningPlan: childCharacterLearningPlanSchema })
  .strict();

export const teachingPlanGenerationStatusSchema = z.enum([
  "queued",
  "running",
  "succeeded",
  "failed",
  "superseded",
]);
export type TeachingPlanGenerationStatus = z.infer<
  typeof teachingPlanGenerationStatusSchema
>;

export const teachingPlanGenerationModeSchema = z.enum([
  "auto",
  "controlled_template",
  "text_model",
]);
export type TeachingPlanGenerationMode = z.infer<
  typeof teachingPlanGenerationModeSchema
>;

export const teachingPlanGeneratorSourceSchema = z.enum([
  "controlled_template",
  "text_model",
]);
export type TeachingPlanGeneratorSource = z.infer<
  typeof teachingPlanGeneratorSourceSchema
>;

export const teachingPlanGenerationErrorCodeSchema = z.enum([
  "generator_not_configured",
  "model_configuration_changed",
  "model_request_failed",
  "model_result_unknown",
  "invalid_generation_input",
  "invalid_model_output",
  "content_compilation_failed",
  "plan_revision_changed",
  "worker_interrupted",
  "unsupported_goal",
  "needs_clarification",
]);
export type TeachingPlanGenerationErrorCode = z.infer<
  typeof teachingPlanGenerationErrorCodeSchema
>;

const teachingContentItemKeySchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);

const teachingContentItemCommonShape = {
  key: teachingContentItemKeySchema,
  order: z.number().int().min(1).max(8),
};

export const reviewedTeachingCatalogItemIdSchema = z.enum([
  "english-space-orbit-v1",
  "math-space-supplies-v1",
  "science-space-gravity-v1",
]);
export type ReviewedTeachingCatalogItemId = z.infer<
  typeof reviewedTeachingCatalogItemIdSchema
>;

export const teachingPinyinInitialSchema = z.enum([
  "b",
  "p",
  "m",
  "f",
  "d",
  "t",
  "n",
  "l",
  "g",
  "k",
  "h",
  "j",
  "q",
  "x",
  "zh",
  "ch",
  "sh",
  "r",
  "z",
  "c",
  "s",
  "y",
  "w",
]);
export type TeachingPinyinInitial = z.infer<typeof teachingPinyinInitialSchema>;

export const teachingPinyinFinalSchema = z.enum([
  "a",
  "o",
  "e",
  "i",
  "u",
  "ü",
  "ai",
  "ei",
  "ao",
  "ou",
  "an",
  "en",
  "ang",
  "eng",
  "ong",
]);
export type TeachingPinyinFinal = z.infer<typeof teachingPinyinFinalSchema>;

export type ControlledTeachingGoalClassification =
  | Readonly<{
      kind: "pinyin";
      practiceMode: "blend" | "tone_demo";
      initials: readonly TeachingPinyinInitial[];
      finals: readonly TeachingPinyinFinal[];
      tones: readonly number[];
    }>
  | Readonly<{ kind: "multiplication" }>;

const CONTROLLED_PINYIN_BLEND_INITIALS = new Set<TeachingPinyinInitial>([
  "b",
  "p",
  "m",
  "f",
]);
const CONTROLLED_PINYIN_BLEND_FINALS = new Set<TeachingPinyinFinal>([
  "a",
  "o",
  "i",
  "u",
]);
const CONTROLLED_PINYIN_TONE_FINALS = new Set<TeachingPinyinFinal>(["a", "o"]);
const REVIEWED_CONTROLLED_PINYIN_BLEND_PAIRS = [
  ["b", "a"],
  ["b", "o"],
  ["p", "a"],
  ["p", "o"],
  ["m", "a"],
  ["m", "i"],
  ["f", "a"],
  ["f", "u"],
] as const satisfies readonly (readonly [
  TeachingPinyinInitial,
  TeachingPinyinFinal,
])[];
const ALL_PINYIN_INITIALS = new Set<TeachingPinyinInitial>(
  teachingPinyinInitialSchema.options,
);
const ALL_PINYIN_FINALS = new Set<TeachingPinyinFinal>(
  teachingPinyinFinalSchema.options,
);
const SINGLE_CHARACTER_PINYIN_SYMBOLS = new Set<string>([
  ...teachingPinyinInitialSchema.options.filter(
    (symbol) => symbol.length === 1,
  ),
  ...teachingPinyinFinalSchema.options.filter((symbol) => symbol.length === 1),
]);
const NON_SYMBOL_PINYIN_WORDS = new Set([
  "pinyin",
  "grade",
  "initial",
  "initials",
  "final",
  "finals",
  "tone",
  "tones",
]);

/**
 * Classifies only goal families that the reviewed local content can honor.
 * Explicit, unsupported pinyin symbols fail closed instead of being replaced
 * by a different reviewed tuple. The returned value never contains goal text.
 */
export function classifyControlledTeachingGoal(
  subject: TeachingSubject,
  learningGoal: string,
  activityCount: number = DEFAULT_TEACHING_ACTIVITY_COUNT,
): ControlledTeachingGoalClassification | null {
  if (typeof learningGoal !== "string") return null;
  const goal = learningGoal.normalize("NFKC").trim().replace(/\s+/gu, " ");
  if (
    !goal ||
    goal.length > TEACHING_LEARNING_GOAL_MAX_CHARACTERS ||
    !Number.isInteger(activityCount) ||
    activityCount < 3 ||
    activityCount > 8
  ) {
    return null;
  }

  const hasPinyinSignal =
    /拼音|拼读|声母|韵母|声调|四声|(?:^|[^a-z])b\s*p\s*m\s*f(?:$|[^a-z])/iu.test(
      goal,
    );
  const hasMultiplicationSignal =
    /乘法|九九|乘法表|times?\s+tables?|multiplication/iu.test(goal);
  if (hasPinyinSignal === hasMultiplicationSignal) return null;

  if (hasMultiplicationSignal) {
    return subject === "math" && hasControlledMultiplicationRange(goal)
      ? Object.freeze({ kind: "multiplication" })
      : null;
  }
  if (subject !== "chinese") return null;

  const symbols = parseExplicitPinyinSymbols(goal);
  if (!symbols) return null;
  const initials = uniquePinyinSymbols(
    symbols.filter((symbol): symbol is TeachingPinyinInitial =>
      ALL_PINYIN_INITIALS.has(symbol as TeachingPinyinInitial),
    ),
  );
  const finals = uniquePinyinSymbols(
    symbols.filter((symbol): symbol is TeachingPinyinFinal =>
      ALL_PINYIN_FINALS.has(symbol as TeachingPinyinFinal),
    ),
  );
  const tonePractice = /声调|四声|音调/u.test(goal);

  if (tonePractice) {
    if (
      initials.length > 0 ||
      finals.some((final) => !CONTROLLED_PINYIN_TONE_FINALS.has(final))
    ) {
      return null;
    }
    const selectedFinals: TeachingPinyinFinal[] =
      finals.length > 0 ? finals : ["a", "o"];
    const classification = Object.freeze({
      kind: "pinyin",
      practiceMode: "tone_demo",
      initials: Object.freeze([]),
      finals: Object.freeze(selectedFinals),
      tones: Object.freeze([1, 2, 3, 4]),
    } as const satisfies ControlledTeachingGoalClassification);
    return hasEnoughReviewedPinyinActivities(classification, activityCount)
      ? classification
      : null;
  }

  if (
    initials.some(
      (initial) => !CONTROLLED_PINYIN_BLEND_INITIALS.has(initial),
    ) ||
    finals.some((final) => !CONTROLLED_PINYIN_BLEND_FINALS.has(final)) ||
    (finals.length > 0 && initials.length === 0)
  ) {
    return null;
  }
  const selectedInitials: TeachingPinyinInitial[] =
    initials.length > 0 ? initials : ["b", "p", "m", "f"];
  const classification = Object.freeze({
    kind: "pinyin",
    practiceMode: "blend",
    initials: Object.freeze(selectedInitials),
    finals: Object.freeze(finals),
    tones: Object.freeze([]),
  } as const satisfies ControlledTeachingGoalClassification);
  return hasEnoughReviewedPinyinActivities(classification, activityCount)
    ? classification
    : null;
}

function parseExplicitPinyinSymbols(
  goal: string,
): Array<TeachingPinyinInitial | TeachingPinyinFinal> | null {
  const symbols: Array<TeachingPinyinInitial | TeachingPinyinFinal> = [];
  for (const rawToken of goal.match(/[a-zü]+/giu) ?? []) {
    const token = rawToken.toLocaleLowerCase("en-US");
    if (NON_SYMBOL_PINYIN_WORDS.has(token)) continue;
    if (ALL_PINYIN_INITIALS.has(token as TeachingPinyinInitial)) {
      symbols.push(token as TeachingPinyinInitial);
      continue;
    }
    if (ALL_PINYIN_FINALS.has(token as TeachingPinyinFinal)) {
      symbols.push(token as TeachingPinyinFinal);
      continue;
    }
    const compactSymbols = [...token];
    if (
      compactSymbols.length > 1 &&
      compactSymbols.every((symbol) =>
        SINGLE_CHARACTER_PINYIN_SYMBOLS.has(symbol),
      )
    ) {
      symbols.push(
        ...(compactSymbols as Array<
          TeachingPinyinInitial | TeachingPinyinFinal
        >),
      );
      continue;
    }
    return null;
  }
  return symbols;
}

function uniquePinyinSymbols<T extends string>(symbols: readonly T[]): T[] {
  return [...new Set(symbols)];
}

function hasEnoughReviewedPinyinActivities(
  classification: Extract<
    ControlledTeachingGoalClassification,
    { kind: "pinyin" }
  >,
  activityCount: number,
): boolean {
  if (classification.practiceMode === "tone_demo") {
    return (
      classification.finals.length * classification.tones.length >=
      activityCount
    );
  }
  return (
    REVIEWED_CONTROLLED_PINYIN_BLEND_PAIRS.filter(
      ([initial, final]) =>
        classification.initials.includes(initial) &&
        (classification.finals.length === 0 ||
          classification.finals.includes(final)),
    ).length >= activityCount
  );
}

function hasControlledMultiplicationRange(goal: string): boolean {
  if (/九九乘法/u.test(goal)) return true;
  const rangePattern =
    /([0-9]{1,2}|[一二三四五六七八九])\s*(?:-|~|～|—|–|－|到|至)\s*([0-9]{1,2}|[一二三四五六七八九])/gu;
  const matches = [...goal.matchAll(rangePattern)];
  if (matches.length > 1) return false;
  const match = matches[0];
  if (match) {
    const start = parseControlledSmallInteger(match[1]);
    const end = parseControlledSmallInteger(match[2]);
    return (
      start !== null && end !== null && start >= 1 && end <= 9 && start <= end
    );
  }

  const withoutGrade = goal.replace(
    /(?:学前|[一二三四五六1-6]\s*年级|grade\s*[1-6])/giu,
    " ",
  );
  const tokens = [...withoutGrade.matchAll(/[0-9]{1,2}|[一二三四五六七八九]/gu)]
    .map((entry) => parseControlledSmallInteger(entry[0]))
    .filter((value): value is number => value !== null);
  const uniqueTokens = [...new Set(tokens)];
  return (
    uniqueTokens.length === 0 ||
    (uniqueTokens.length === 1 &&
      uniqueTokens[0]! >= 1 &&
      uniqueTokens[0]! <= 9)
  );
}

function parseControlledSmallInteger(value: string | undefined): number | null {
  if (!value) return null;
  const chineseDigits: Readonly<Record<string, number>> = {
    一: 1,
    二: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9,
  };
  const chinese = chineseDigits[value];
  if (chinese !== undefined) return chinese;
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : null;
}

const reviewedCatalogTeachingContentItemSchema = z
  .object({
    ...teachingContentItemCommonShape,
    kind: z.literal("reviewed_catalog_ref"),
    catalogItemId: reviewedTeachingCatalogItemIdSchema,
  })
  .strict();

const pinyinPracticeTeachingContentItemSchema = z
  .object({
    ...teachingContentItemCommonShape,
    kind: z.literal("pinyin_practice"),
    practiceMode: z.enum(["blend", "recognize", "tone_demo"]),
    initial: teachingPinyinInitialSchema.nullable(),
    final: teachingPinyinFinalSchema,
    tone: z.number().int().min(0).max(4),
  })
  .strict();

const multiplicationFactTeachingContentItemSchema = z
  .object({
    ...teachingContentItemCommonShape,
    kind: z.literal("multiplication_fact"),
    multiplicand: z.number().int().min(1).max(9),
    multiplier: z.number().int().min(1).max(9),
    product: z.number().int().min(1).max(81),
    scenario: z.enum(["supplies", "energy", "formation", "equipment"]),
  })
  .strict();

export const MODEL_GENERATED_TEACHING_ACTIVITY_MAX_VISIBLE_CHARACTERS =
  1_200 as const;
export const MODEL_GENERATED_TEACHING_PLAN_MAX_VISIBLE_CHARACTERS =
  6_000 as const;

const MODEL_GENERATED_TEXT_FORBIDDEN_PATTERN =
  /(?:(?:https?|ftp):\/\/|www\.|<\s*\/?\s*(?:system|assistant|developer)\b|(?:system|assistant|developer)\s*[:：]|系统提示|(?:忽略|无视|覆盖|绕过).{0,12}(?:规则|指令|提示)|\b(?:ignore|override|bypass)\b.{0,32}\b(?:instructions?|prompts?|rules?)\b)/iu;

function modelGeneratedVisibleTextSchema(maxCharacters: number) {
  return z
    .string()
    .trim()
    .min(1)
    .max(maxCharacters)
    .refine((value) => !containsControlCharacter(value), {
      message: "儿童可见文本不能包含控制字符。",
    })
    .refine((value) => !MODEL_GENERATED_TEXT_FORBIDDEN_PATTERN.test(value), {
      message: "儿童可见文本不能包含网址、角色伪装或覆盖指令。",
    });
}

function containsControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f);
  });
}

const modelGeneratedTeachingActivityCommonShape = {
  ...teachingContentItemCommonShape,
  kind: z.literal("model_generated_activity"),
  title: modelGeneratedVisibleTextSchema(60),
  objective: modelGeneratedVisibleTextSchema(160),
  knowledgeSource: z.literal("model_only"),
};

const modelGeneratedExplainAndReflectActivitySchema = z
  .object({
    ...modelGeneratedTeachingActivityCommonShape,
    activityType: z.literal("explain_and_reflect"),
    teachingText: modelGeneratedVisibleTextSchema(520),
    reflectionPrompt: modelGeneratedVisibleTextSchema(240),
    exampleResponse: modelGeneratedVisibleTextSchema(240),
    feedbackText: modelGeneratedVisibleTextSchema(200),
  })
  .strict();

const modelGeneratedChoiceIdSchema = z.enum(["a", "b", "c", "d"]);
const modelGeneratedMultipleChoiceActivitySchema = z
  .object({
    ...modelGeneratedTeachingActivityCommonShape,
    activityType: z.literal("multiple_choice"),
    questionText: modelGeneratedVisibleTextSchema(280),
    choices: z
      .array(
        z
          .object({
            id: modelGeneratedChoiceIdSchema,
            text: modelGeneratedVisibleTextSchema(160),
          })
          .strict(),
      )
      .min(2)
      .max(4),
    correctChoiceId: modelGeneratedChoiceIdSchema,
    answerExplanation: modelGeneratedVisibleTextSchema(360),
    hintText: modelGeneratedVisibleTextSchema(180),
  })
  .strict();

const modelGeneratedShortAnswerActivitySchema = z
  .object({
    ...modelGeneratedTeachingActivityCommonShape,
    activityType: z.literal("short_answer"),
    questionText: modelGeneratedVisibleTextSchema(280),
    acceptedAnswers: z.array(modelGeneratedVisibleTextSchema(80)).min(1).max(6),
    answerExplanation: modelGeneratedVisibleTextSchema(360),
    hintText: modelGeneratedVisibleTextSchema(180),
  })
  .strict();

export const modelGeneratedTeachingActivitySchema = z
  .discriminatedUnion("activityType", [
    modelGeneratedExplainAndReflectActivitySchema,
    modelGeneratedMultipleChoiceActivitySchema,
    modelGeneratedShortAnswerActivitySchema,
  ])
  .superRefine((activity, context) => {
    if (
      modelGeneratedActivityVisibleCharacterCount(activity) >
      MODEL_GENERATED_TEACHING_ACTIVITY_MAX_VISIBLE_CHARACTERS
    ) {
      context.addIssue({
        code: "custom",
        message: "单个活动的儿童可见文本超过总预算。",
      });
    }
    if (activity.activityType === "multiple_choice") {
      const choiceIds = new Set(activity.choices.map((choice) => choice.id));
      const choiceTexts = new Set(
        activity.choices.map((choice) => normalizeVisibleText(choice.text)),
      );
      if (
        choiceIds.size !== activity.choices.length ||
        choiceTexts.size !== activity.choices.length
      ) {
        context.addIssue({
          code: "custom",
          path: ["choices"],
          message: "选项 ID 和文本不能重复。",
        });
      }
      if (!choiceIds.has(activity.correctChoiceId)) {
        context.addIssue({
          code: "custom",
          path: ["correctChoiceId"],
          message: "正确选项必须存在于选项列表中。",
        });
      }
    }
    if (activity.activityType === "short_answer") {
      const answers = new Set(
        activity.acceptedAnswers.map(normalizeVisibleText),
      );
      if (answers.size !== activity.acceptedAnswers.length) {
        context.addIssue({
          code: "custom",
          path: ["acceptedAnswers"],
          message: "可接受答案不能重复。",
        });
      }
    }
  });
export type ModelGeneratedTeachingActivity = z.infer<
  typeof modelGeneratedTeachingActivitySchema
>;

function normalizeVisibleText(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase("zh-CN");
}

function modelGeneratedActivityVisibleCharacterCount(
  activity: z.infer<
    | typeof modelGeneratedExplainAndReflectActivitySchema
    | typeof modelGeneratedMultipleChoiceActivitySchema
    | typeof modelGeneratedShortAnswerActivitySchema
  >,
): number {
  const common = activity.title.length + activity.objective.length;
  switch (activity.activityType) {
    case "explain_and_reflect":
      return (
        common +
        activity.teachingText.length +
        activity.reflectionPrompt.length +
        activity.exampleResponse.length +
        activity.feedbackText.length
      );
    case "multiple_choice":
      return (
        common +
        activity.questionText.length +
        activity.choices.reduce((sum, choice) => sum + choice.text.length, 0) +
        activity.answerExplanation.length +
        activity.hintText.length
      );
    case "short_answer":
      return (
        common +
        activity.questionText.length +
        activity.acceptedAnswers.reduce(
          (sum, answer) => sum + answer.length,
          0,
        ) +
        activity.answerExplanation.length +
        activity.hintText.length
      );
  }
}

const legacyTeachingPlanContentItemBaseSchema = z.discriminatedUnion("kind", [
  reviewedCatalogTeachingContentItemSchema,
  pinyinPracticeTeachingContentItemSchema,
  multiplicationFactTeachingContentItemSchema,
]);

const legacyTeachingPlanContentItemSchema =
  legacyTeachingPlanContentItemBaseSchema.superRefine(
    validateLegacyTeachingPlanContentItem,
  );

export const teachingPlanContentItemSchema = z.union([
  legacyTeachingPlanContentItemSchema,
  modelGeneratedTeachingActivitySchema,
]);
export type TeachingPlanContentItem = z.infer<
  typeof teachingPlanContentItemSchema
>;

function validateLegacyTeachingPlanContentItem(
  item: z.infer<typeof legacyTeachingPlanContentItemBaseSchema>,
  context: z.RefinementCtx,
): void {
  if (item.kind === "pinyin_practice") {
    const tuple = [
      item.practiceMode,
      item.initial ?? "none",
      item.final,
      item.tone,
    ].join(":");
    if (!REVIEWED_PINYIN_ACTIVITY_TUPLES.has(tuple)) {
      context.addIssue({
        code: "custom",
        path: ["final"],
        message: "拼音活动必须使用已经审核的完整活动组合。",
      });
    }
  }
  if (
    item.kind === "multiplication_fact" &&
    item.product !== item.multiplicand * item.multiplier
  ) {
    context.addIssue({
      code: "custom",
      path: ["product"],
      message: "乘法内容的结果必须由两个因数确定。",
    });
  }
}

const REVIEWED_PINYIN_ACTIVITY_TUPLES = new Set([
  "blend:b:a:0",
  "blend:b:o:0",
  "blend:p:a:0",
  "blend:p:o:0",
  "blend:m:a:0",
  "blend:m:i:0",
  "blend:f:a:0",
  "blend:f:u:0",
  "tone_demo:none:a:1",
  "tone_demo:none:a:2",
  "tone_demo:none:a:3",
  "tone_demo:none:a:4",
  "tone_demo:none:o:1",
  "tone_demo:none:o:2",
  "tone_demo:none:o:3",
  "tone_demo:none:o:4",
]);

const REVIEWED_CATALOG_SUBJECTS: Readonly<
  Record<ReviewedTeachingCatalogItemId, TeachingSubject>
> = {
  "english-space-orbit-v1": "english",
  "math-space-supplies-v1": "math",
  "science-space-gravity-v1": "science",
};

export const generatedTeachingPlanSchemaVersionSchema = z.literal(
  "generated-teaching-plan-v1",
);
export const controlledTeachingContentCompilerVersionSchema = z.literal(
  "controlled-teaching-content-v1",
);
export const MODEL_GENERATED_TEACHING_PLAN_SCHEMA_VERSION =
  "generated-teaching-plan-v2" as const;
export const MODEL_GENERATED_TEACHING_CONTENT_COMPILER_VERSION =
  "model-generated-teaching-content-v2" as const;
export const modelGeneratedTeachingPlanSchemaVersionSchema = z.literal(
  MODEL_GENERATED_TEACHING_PLAN_SCHEMA_VERSION,
);
export const modelGeneratedTeachingContentCompilerVersionSchema = z.literal(
  MODEL_GENERATED_TEACHING_CONTENT_COMPILER_VERSION,
);

const legacyGeneratedTeachingPlanDraftShape = {
  schemaVersion: generatedTeachingPlanSchemaVersionSchema,
  compilerVersion: controlledTeachingContentCompilerVersionSchema,
  title: z.string().trim().min(1).max(80),
  normalizedGoal: z.string().trim().min(1).max(200),
  subject: teachingSubjectSchema,
  difficulty: teachingDifficultySchema,
  gradeLevel: teachingPlanGenerationGradeLevelSchema,
  activityCount: z.number().int().min(3).max(8),
  durationDays: teachingPlanDurationDaysSchema,
  activities: z.array(legacyTeachingPlanContentItemSchema).min(3).max(8),
};

const legacyGeneratedTeachingPlanDraftBaseSchema = z
  .object(legacyGeneratedTeachingPlanDraftShape)
  .strict();

export const legacyGeneratedTeachingPlanDraftSchema =
  legacyGeneratedTeachingPlanDraftBaseSchema.superRefine(
    validateLegacyTeachingPlanDraft,
  );

const modelGeneratedTeachingPlanDraftShape = {
  schemaVersion: modelGeneratedTeachingPlanSchemaVersionSchema,
  compilerVersion: modelGeneratedTeachingContentCompilerVersionSchema,
  title: modelGeneratedVisibleTextSchema(80),
  normalizedGoal: modelGeneratedVisibleTextSchema(200),
  subject: teachingSubjectSchema,
  difficulty: teachingDifficultySchema,
  gradeLevel: teachingPlanGenerationGradeLevelSchema,
  activityCount: z.number().int().min(3).max(8),
  durationDays: teachingPlanDurationDaysSchema,
  activities: z.array(modelGeneratedTeachingActivitySchema).min(3).max(8),
};

const modelGeneratedTeachingPlanDraftBaseSchema = z
  .object(modelGeneratedTeachingPlanDraftShape)
  .strict();

export const modelGeneratedTeachingPlanDraftSchema =
  modelGeneratedTeachingPlanDraftBaseSchema.superRefine(
    validateModelGeneratedTeachingPlanDraft,
  );

export const generatedTeachingPlanDraftSchema = z.union([
  legacyGeneratedTeachingPlanDraftSchema,
  modelGeneratedTeachingPlanDraftSchema,
]);
export type GeneratedTeachingPlanDraft = z.infer<
  typeof generatedTeachingPlanDraftSchema
>;

const legacyLearningPlanContentRevisionSchema = z
  .object({
    contentRevisionId: z.uuid(),
    revision: z.number().int().positive(),
    ...legacyGeneratedTeachingPlanDraftShape,
    createdAt: z.iso.datetime(),
  })
  .strict()
  .superRefine(validateLegacyTeachingPlanDraft);

const modelGeneratedLearningPlanContentRevisionSchema = z
  .object({
    contentRevisionId: z.uuid(),
    revision: z.number().int().positive(),
    ...modelGeneratedTeachingPlanDraftShape,
    createdAt: z.iso.datetime(),
  })
  .strict()
  .superRefine(validateModelGeneratedTeachingPlanDraft);

export const learningPlanContentRevisionSchema = z.union([
  legacyLearningPlanContentRevisionSchema,
  modelGeneratedLearningPlanContentRevisionSchema,
]);
export type LearningPlanContentRevision = z.infer<
  typeof learningPlanContentRevisionSchema
>;

function validateLegacyTeachingPlanDraft(
  draft: z.infer<typeof legacyGeneratedTeachingPlanDraftBaseSchema>,
  context: z.RefinementCtx,
): void {
  if (draft.activities.length !== draft.activityCount) {
    context.addIssue({
      code: "custom",
      path: ["activities"],
      message: "活动数量必须与计划配置一致。",
    });
  }
  const keys = new Set<string>();
  const activityFingerprints = new Set<string>();
  draft.activities.forEach((activity, index) => {
    if (keys.has(activity.key)) {
      context.addIssue({
        code: "custom",
        path: ["activities", index, "key"],
        message: "活动 key 不能重复。",
      });
    }
    keys.add(activity.key);
    const fingerprint = teachingActivityFingerprint(activity);
    if (activityFingerprints.has(fingerprint)) {
      context.addIssue({
        code: "custom",
        path: ["activities", index],
        message: "学习活动内容不能重复。",
      });
    }
    activityFingerprints.add(fingerprint);
    if (activity.order !== index + 1) {
      context.addIssue({
        code: "custom",
        path: ["activities", index, "order"],
        message: "活动顺序必须从 1 连续递增。",
      });
    }
    if (activity.kind === "pinyin_practice" && draft.subject !== "chinese") {
      context.addIssue({
        code: "custom",
        path: ["activities", index, "kind"],
        message: "拼音活动只能用于语文计划。",
      });
    }
    if (activity.kind === "multiplication_fact" && draft.subject !== "math") {
      context.addIssue({
        code: "custom",
        path: ["activities", index, "kind"],
        message: "乘法活动只能用于数学计划。",
      });
    }
    if (
      activity.kind === "reviewed_catalog_ref" &&
      REVIEWED_CATALOG_SUBJECTS[activity.catalogItemId] !== draft.subject
    ) {
      context.addIssue({
        code: "custom",
        path: ["activities", index, "catalogItemId"],
        message: "审核目录内容必须与计划学科一致。",
      });
    }
  });
}

function validateModelGeneratedTeachingPlanDraft(
  draft: z.infer<typeof modelGeneratedTeachingPlanDraftBaseSchema>,
  context: z.RefinementCtx,
): void {
  if (draft.activities.length !== draft.activityCount) {
    context.addIssue({
      code: "custom",
      path: ["activities"],
      message: "活动数量必须与计划配置一致。",
    });
  }
  const keys = new Set<string>();
  const fingerprints = new Set<string>();
  let visibleCharacters = draft.title.length + draft.normalizedGoal.length;
  draft.activities.forEach((activity, index) => {
    if (keys.has(activity.key)) {
      context.addIssue({
        code: "custom",
        path: ["activities", index, "key"],
        message: "活动 key 不能重复。",
      });
    }
    keys.add(activity.key);
    if (activity.order !== index + 1) {
      context.addIssue({
        code: "custom",
        path: ["activities", index, "order"],
        message: "活动顺序必须从 1 连续递增。",
      });
    }
    const fingerprint = modelGeneratedActivityFingerprint(activity);
    if (fingerprints.has(fingerprint)) {
      context.addIssue({
        code: "custom",
        path: ["activities", index],
        message: "模型生成的学习活动不能重复。",
      });
    }
    fingerprints.add(fingerprint);
    visibleCharacters += modelGeneratedActivityVisibleCharacterCount(activity);
  });
  if (
    visibleCharacters > MODEL_GENERATED_TEACHING_PLAN_MAX_VISIBLE_CHARACTERS
  ) {
    context.addIssue({
      code: "custom",
      path: ["activities"],
      message: "短期学习计划的儿童可见文本超过总预算。",
    });
  }
}

function teachingActivityFingerprint(
  activity: TeachingPlanContentItem,
): string {
  switch (activity.kind) {
    case "reviewed_catalog_ref":
      return `catalog:${activity.catalogItemId}`;
    case "pinyin_practice":
      return [
        "pinyin",
        activity.practiceMode,
        activity.initial ?? "none",
        activity.final,
        activity.tone,
      ].join(":");
    case "multiplication_fact":
      return `multiplication:${Math.min(
        activity.multiplicand,
        activity.multiplier,
      )}:${Math.max(activity.multiplicand, activity.multiplier)}`;
    case "model_generated_activity":
      return modelGeneratedActivityFingerprint(activity);
  }
}

function modelGeneratedActivityFingerprint(
  activity: ModelGeneratedTeachingActivity,
): string {
  const { key: _key, order: _order, ...semanticContent } = activity;
  return JSON.stringify(semanticContent);
}

export const requestLearningPlanGenerationSchema = z
  .object({
    expectedPlanRevision: z.number().int().positive(),
    clientRequestId: z.uuid(),
    generationMode: z.literal("text_model").default("text_model"),
  })
  .strict();
export const learningPlanGenerationRequestSchema =
  requestLearningPlanGenerationSchema;
export type RequestLearningPlanGeneration = z.infer<
  typeof requestLearningPlanGenerationSchema
>;

const legacyTeachingPlanGenerationInputSnapshotSchema = z
  .object({
    schemaVersion: z.literal("teaching-plan-generation-input-v2"),
    generationMode: teachingPlanGenerationModeSchema,
    generatorSource: teachingPlanGeneratorSourceSchema,
    subject: teachingSubjectSchema,
    difficulty: teachingDifficultySchema,
    gradeLevel: teachingPlanGenerationGradeLevelSchema,
    goalHash: z.string().regex(/^[0-9a-f]{64}$/),
    activityCount: z.number().int().min(3).max(8),
    durationDays: teachingPlanDurationDaysSchema,
  })
  .strict();

export const modelTeachingPlanGenerationInputSnapshotSchema = z
  .object({
    schemaVersion: z.literal("teaching-plan-generation-input-v3"),
    generationMode: z.literal("text_model"),
    generatorSource: z.literal("text_model"),
    subject: teachingSubjectSchema,
    difficulty: teachingDifficultySchema,
    gradeLevel: teachingPlanGenerationGradeLevelSchema,
    goalHash: z.string().regex(/^[0-9a-f]{64}$/),
    activityCount: z.number().int().min(3).max(8),
    durationDays: teachingPlanDurationDaysSchema,
  })
  .strict();

export const teachingPlanGenerationInputSnapshotSchema = z.discriminatedUnion(
  "schemaVersion",
  [
    legacyTeachingPlanGenerationInputSnapshotSchema,
    modelTeachingPlanGenerationInputSnapshotSchema,
  ],
);
export type TeachingPlanGenerationInputSnapshot = z.infer<
  typeof teachingPlanGenerationInputSnapshotSchema
>;

export const teachingPlanGenerationExecutionInputSchema = z
  .object({
    generationMode: z.literal("text_model"),
    generatorSource: z.literal("text_model"),
    subject: teachingSubjectSchema,
    difficulty: teachingDifficultySchema,
    gradeLevel: teachingPlanGenerationGradeLevelSchema,
    learningGoal: z
      .string()
      .trim()
      .min(1)
      .max(TEACHING_LEARNING_GOAL_MAX_CHARACTERS),
    activityCount: z.number().int().min(3).max(8),
    durationDays: teachingPlanDurationDaysSchema,
  })
  .strict();
export type TeachingPlanGenerationExecutionInput = z.infer<
  typeof teachingPlanGenerationExecutionInputSchema
>;

export const teachingPlanGenerationSchema = z
  .object({
    id: z.uuid(),
    expectedPlanRevision: z.number().int().positive(),
    generatorSource: teachingPlanGeneratorSourceSchema,
    status: teachingPlanGenerationStatusSchema,
    errorCode: teachingPlanGenerationErrorCodeSchema.nullable(),
    contentRevisionId: z.uuid().nullable(),
    requestedAt: z.iso.datetime(),
    completedAt: z.iso.datetime().nullable(),
  })
  .strict()
  .superRefine((generation, context) => {
    const succeeded = generation.status === "succeeded";
    const failed = generation.status === "failed";
    if (succeeded !== (generation.contentRevisionId !== null)) {
      context.addIssue({
        code: "custom",
        path: ["contentRevisionId"],
        message: "只有成功的生成任务可以关联内容版本。",
      });
    }
    if (failed !== (generation.errorCode !== null)) {
      context.addIssue({
        code: "custom",
        path: ["errorCode"],
        message: "只有失败的生成任务必须包含错误码。",
      });
    }
    const terminal = ["succeeded", "failed", "superseded"].includes(
      generation.status,
    );
    if (terminal !== (generation.completedAt !== null)) {
      context.addIssue({
        code: "custom",
        path: ["completedAt"],
        message: "终态任务必须包含完成时间。",
      });
    }
  });
export type TeachingPlanGeneration = z.infer<
  typeof teachingPlanGenerationSchema
>;

export const learningPlanGenerationResponseSchema = z
  .object({
    generation: teachingPlanGenerationSchema,
    draft: learningPlanContentRevisionSchema.nullable(),
  })
  .strict()
  .superRefine((response, context) => {
    if (
      (response.generation.status === "succeeded") !==
      (response.draft !== null)
    ) {
      context.addIssue({
        code: "custom",
        path: ["draft"],
        message: "只有成功的生成任务必须返回草稿。",
      });
    }
    if (
      response.draft &&
      response.draft.contentRevisionId !== response.generation.contentRevisionId
    ) {
      context.addIssue({
        code: "custom",
        path: ["draft", "contentRevisionId"],
        message: "草稿必须属于当前生成任务。",
      });
    }
  });
export type LearningPlanGenerationResponse = z.infer<
  typeof learningPlanGenerationResponseSchema
>;

export const learningPlanGenerationParamsSchema = z
  .object({
    childUserId: z.uuid(),
    characterId: z.uuid(),
    generationId: z.uuid(),
  })
  .strict();

export const publishLearningPlanContentRequestSchema = z
  .object({
    expectedPlanRevision: z.number().int().positive(),
    contentRevisionId: z.uuid(),
    reviewConfirmed: z.literal(true),
  })
  .strict();
export type PublishLearningPlanContentRequest = z.infer<
  typeof publishLearningPlanContentRequestSchema
>;

export const learningPlanContentProgressSchema = z
  .object({
    scheduled: z.number().int().nonnegative(),
    total: z.number().int().min(3).max(8),
    exhausted: z.boolean(),
  })
  .strict()
  .refine((progress) => progress.scheduled <= progress.total, {
    message: "已安排活动数不能超过计划总数。",
  });

export const learningPlanContentResponseSchema = z
  .object({
    activeContent: learningPlanContentRevisionSchema.nullable(),
    latestDraft: learningPlanContentRevisionSchema.nullable(),
    progress: learningPlanContentProgressSchema.nullable(),
    expiresAt: z.iso.datetime().nullable(),
  })
  .strict()
  .superRefine((response, context) => {
    if ((response.activeContent === null) !== (response.progress === null)) {
      context.addIssue({
        code: "custom",
        path: ["progress"],
        message: "只有已发布内容可以包含进度。",
      });
    }
    if ((response.activeContent === null) !== (response.expiresAt === null)) {
      context.addIssue({
        code: "custom",
        path: ["expiresAt"],
        message: "只有已发布内容可以包含到期时间。",
      });
    }
  });
export type LearningPlanContentResponse = z.infer<
  typeof learningPlanContentResponseSchema
>;

export const publishLearningPlanContentResponseSchema = z
  .object({
    learningPlan: childCharacterLearningPlanSchema,
    activeContent: learningPlanContentRevisionSchema,
  })
  .strict();
export type PublishLearningPlanContentResponse = z.infer<
  typeof publishLearningPlanContentResponseSchema
>;

export const childTeachingAvailabilityParamsSchema = z
  .object({ characterId: z.uuid() })
  .strict();

export const childTeachingUnavailableReasonSchema = z.enum([
  "no_enabled_plan",
  "character_unavailable",
  "provider_unsupported",
]);
export type ChildTeachingUnavailableReason = z.infer<
  typeof childTeachingUnavailableReasonSchema
>;

export const teachingProviderCapabilitySchema = z.literal(
  "dynamic_instructions_next_safe_turn",
);
export type TeachingProviderCapability = z.infer<
  typeof teachingProviderCapabilitySchema
>;

export const TEACHING_DISCLOSURE_VERSION = "teaching-disclosure-v1" as const;
export const teachingDisclosureVersionSchema = z.literal(
  TEACHING_DISCLOSURE_VERSION,
);
export type TeachingDisclosureVersion = z.infer<
  typeof teachingDisclosureVersionSchema
>;

export const childTeachingAvailabilitySchema = z.discriminatedUnion("enabled", [
  z
    .object({
      enabled: z.literal(false),
      reason: childTeachingUnavailableReasonSchema,
    })
    .strict(),
  z
    .object({
      enabled: z.literal(true),
      providerCapability: teachingProviderCapabilitySchema,
      subject: teachingSubjectSchema,
      difficulty: teachingDifficultySchema,
      triggerMode: teachingTriggerModeSchema,
      disclosureVersion: teachingDisclosureVersionSchema,
      configurationRevision: z.number().int().positive(),
    })
    .strict(),
]);
export type ChildTeachingAvailability = z.infer<
  typeof childTeachingAvailabilitySchema
>;

export const childTeachingAvailabilityResponseSchema = z
  .object({ teaching: childTeachingAvailabilitySchema })
  .strict();

export const teachingConversationParamsSchema = z
  .object({ conversationId: z.uuid() })
  .strict();

export const prepareConversationTeachingChoiceSchema = z.enum([
  "enabled",
  "chat_only",
]);

export const prepareConversationTeachingRequestSchema = z.discriminatedUnion(
  "choice",
  [
    z
      .object({
        choice: z.literal("enabled"),
        expectedConfigurationRevision: z.number().int().positive(),
        acknowledgedDisclosureVersion: teachingDisclosureVersionSchema,
      })
      .strict(),
    z.object({ choice: z.literal("chat_only") }).strict(),
  ],
);
export type PrepareConversationTeachingRequest = z.infer<
  typeof prepareConversationTeachingRequestSchema
>;
export const muteConversationTeachingRequestSchema = z.object({}).strict();

export const safeRelayTeachingStateSchema = z.discriminatedUnion("state", [
  z
    .object({
      state: z.literal("unavailable"),
      revision: z.number().int().nonnegative(),
      canRequest: z.literal(false),
      canMute: z.literal(false),
    })
    .strict(),
  z
    .object({
      state: z.literal("available"),
      revision: z.number().int().nonnegative(),
      canRequest: z.literal(true),
      canMute: z.literal(true),
    })
    .strict(),
  z
    .object({
      state: z.literal("active"),
      revision: z.number().int().nonnegative(),
      canRequest: z.literal(false),
      canMute: z.literal(true),
    })
    .strict(),
  z
    .object({
      state: z.literal("restoring"),
      revision: z.number().int().nonnegative(),
      canRequest: z.literal(false),
      canMute: z.literal(false),
    })
    .strict(),
  z
    .object({
      state: z.literal("muted"),
      revision: z.number().int().nonnegative(),
      canRequest: z.literal(false),
      canMute: z.literal(false),
    })
    .strict(),
  z
    .object({
      state: z.literal("completed"),
      revision: z.number().int().nonnegative(),
      canRequest: z.literal(false),
      canMute: z.literal(false),
    })
    .strict(),
]);
export type SafeRelayTeachingState = z.infer<
  typeof safeRelayTeachingStateSchema
>;

export const conversationTeachingStateResponseSchema = z
  .object({ teaching: safeRelayTeachingStateSchema })
  .strict();
export type ConversationTeachingStateResponse = z.infer<
  typeof conversationTeachingStateResponseSchema
>;

const realtimeTeachingEventIdSchema = z.string().min(1).max(200);

export const realtimeTeachingClientControlFrameSchema = z.discriminatedUnion(
  "type",
  [
    z
      .object({
        type: z.literal("relay.teaching.request"),
        event_id: realtimeTeachingEventIdSchema,
      })
      .strict(),
    z
      .object({
        type: z.literal("relay.teaching.mute"),
        event_id: realtimeTeachingEventIdSchema,
      })
      .strict(),
    z
      .object({
        type: z.literal("relay.teaching.audio_gate_ack"),
        event_id: realtimeTeachingEventIdSchema,
        revision: z.number().int().positive(),
      })
      .strict(),
  ],
);
export type RealtimeTeachingClientControlFrame = z.infer<
  typeof realtimeTeachingClientControlFrameSchema
>;

const realtimeTeachingServerStateFrameSchema = z.discriminatedUnion("state", [
  z
    .object({
      type: z.literal("relay.teaching.state"),
      revision: z.number().int().nonnegative(),
      state: z.literal("unavailable"),
      canRequest: z.literal(false),
      canMute: z.literal(false),
    })
    .strict(),
  z
    .object({
      type: z.literal("relay.teaching.state"),
      revision: z.number().int().nonnegative(),
      state: z.literal("available"),
      canRequest: z.literal(true),
      canMute: z.literal(true),
    })
    .strict(),
  z
    .object({
      type: z.literal("relay.teaching.state"),
      revision: z.number().int().nonnegative(),
      state: z.literal("active"),
      canRequest: z.literal(false),
      canMute: z.literal(true),
    })
    .strict(),
  z
    .object({
      type: z.literal("relay.teaching.state"),
      revision: z.number().int().nonnegative(),
      state: z.literal("restoring"),
      canRequest: z.literal(false),
      canMute: z.literal(false),
    })
    .strict(),
  z
    .object({
      type: z.literal("relay.teaching.state"),
      revision: z.number().int().nonnegative(),
      state: z.literal("muted"),
      canRequest: z.literal(false),
      canMute: z.literal(false),
    })
    .strict(),
  z
    .object({
      type: z.literal("relay.teaching.state"),
      revision: z.number().int().nonnegative(),
      state: z.literal("completed"),
      canRequest: z.literal(false),
      canMute: z.literal(false),
    })
    .strict(),
]);

export const realtimeTeachingServerControlFrameSchema = z.union([
  realtimeTeachingServerStateFrameSchema,
  z
    .object({
      type: z.literal("relay.teaching.audio_gate"),
      revision: z.number().int().positive(),
      open: z.boolean(),
    })
    .strict(),
]);
export type RealtimeTeachingServerControlFrame = z.infer<
  typeof realtimeTeachingServerControlFrameSchema
>;
