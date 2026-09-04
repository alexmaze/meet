import type {
  LearningPlanContentRevision,
  LearningPlanTargetCharacter,
} from "@meet/protocol";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ShortPlanDraftPreview } from "./ShortLearningPlanBuilder.js";
import {
  getTeachingTargetAvailabilityMessage,
  generationFailureMessage,
  normalizeLearningGoalForSave,
  resolveLearningPlanGenerationReadId,
  resolveLearningPlanGenerationRequestIdentity,
  shouldConfirmPublishedShortPlanRemoval,
  teachingSubjectOptions,
  TeachingCharacterSelector,
  toShortPlanDraftView,
} from "./TeachingPlansPanel.js";

const supportedCharacterId = "c437c71e-f209-4f7d-8f98-1c1e239d4202";
const unsupportedCharacterId = "b437c71e-f209-4f7d-8f98-1c1e239d4202";
const unapprovedCharacterId = "a437c71e-f209-4f7d-8f98-1c1e239d4202";
const unavailableCharacterId = "9437c71e-f209-4f7d-8f98-1c1e239d4202";

const characters: LearningPlanTargetCharacter[] = [
  {
    id: supportedCharacterId,
    name: "奥特曼",
    teachingAvailability: { available: true },
  },
  {
    id: unsupportedCharacterId,
    name: "豆包伙伴",
    teachingAvailability: {
      available: false,
      reason: "provider_unsupported",
    },
  },
  {
    id: unapprovedCharacterId,
    name: "未批准的千问角色",
    teachingAvailability: {
      available: false,
      reason: "configuration_not_approved",
    },
  },
  {
    id: unavailableCharacterId,
    name: "尚未配置好的角色",
    teachingAvailability: {
      available: false,
      reason: "realtime_unavailable",
    },
  },
];

describe("TeachingCharacterSelector", () => {
  it("keeps every public character selectable and explains an unsupported selection", () => {
    const markup = renderToStaticMarkup(
      <TeachingCharacterSelector
        characters={characters}
        selectedCharacterId={unsupportedCharacterId}
        onChange={() => undefined}
      />,
    );

    for (const character of characters) {
      expect(markup).toContain(character.name);
      expect(markup).toContain(`value="${character.id}"`);
    }
    expect(markup).not.toContain("<option disabled");
    expect(markup).toContain("暂不支持学习小支线");
    expect(markup).toContain("仍可保存");
  });

  it("gives each unavailable state a distinct, actionable explanation", () => {
    const providerUnsupported = getTeachingTargetAvailabilityMessage({
      available: false,
      reason: "provider_unsupported",
    });
    const configurationNotApproved = getTeachingTargetAvailabilityMessage({
      available: false,
      reason: "configuration_not_approved",
    });
    const realtimeUnavailable = getTeachingTargetAvailabilityMessage({
      available: false,
      reason: "realtime_unavailable",
    });

    expect(providerUnsupported).toContain("暂不支持学习小支线");
    expect(configurationNotApproved).toContain("尚未批准");
    expect(realtimeUnavailable).toContain("实时模型、连接或音色");
    for (const message of [
      providerUnsupported,
      configurationNotApproved,
      realtimeUnavailable,
    ]) {
      expect(message).toContain("仍可保存");
    }
    expect(
      new Set([
        providerUnsupported,
        configurationNotApproved,
        realtimeUnavailable,
      ]).size,
    ).toBe(3);
    expect(
      getTeachingTargetAvailabilityMessage({ available: true }),
    ).toBeNull();
  });
});

describe("short learning-plan presentation", () => {
  it("offers a general subject for goals outside the four school subjects", () => {
    expect(teachingSubjectOptions).toContainEqual({
      value: "general",
      label: "综合 / 其他",
    });
  });

  it("requires an explicit confirmation only when removing a published goal", () => {
    const activeContentRevisionId = "2072f06d-c71a-47b3-94fe-35e1204b5b55";
    expect(
      shouldConfirmPublishedShortPlanRemoval({
        activeContentRevisionId,
        persistedLearningGoal: "练习拼音拼读",
        nextLearningGoal: null,
      }),
    ).toBe(true);
    expect(
      shouldConfirmPublishedShortPlanRemoval({
        activeContentRevisionId,
        persistedLearningGoal: "练习拼音拼读",
        nextLearningGoal: "练习拼音声调",
      }),
    ).toBe(false);
    expect(
      shouldConfirmPublishedShortPlanRemoval({
        activeContentRevisionId: null,
        persistedLearningGoal: null,
        nextLearningGoal: null,
      }),
    ).toBe(false);
  });

  it("turns strict content items into an adult-readable preview without prompt text", () => {
    const content: LearningPlanContentRevision = {
      contentRevisionId: "2072f06d-c71a-47b3-94fe-35e1204b5b55",
      revision: 1,
      schemaVersion: "generated-teaching-plan-v1",
      compilerVersion: "controlled-teaching-content-v1",
      title: "拼音与乘法预览",
      normalizedGoal: "练习一个受控内容序列",
      subject: "chinese",
      difficulty: "starter",
      gradeLevel: "grade_1",
      activityCount: 3,
      durationDays: 7,
      activities: [
        {
          kind: "pinyin_practice",
          key: "blend-ba",
          order: 1,
          practiceMode: "blend",
          initial: "b",
          final: "a",
          tone: 0,
        },
        {
          kind: "pinyin_practice",
          key: "recognize-ma",
          order: 2,
          practiceMode: "recognize",
          initial: "m",
          final: "a",
          tone: 0,
        },
        {
          kind: "pinyin_practice",
          key: "tone-ma-three",
          order: 3,
          practiceMode: "tone_demo",
          initial: "m",
          final: "a",
          tone: 3,
        },
      ],
      createdAt: "2026-08-15T08:02:00.000Z",
    };

    const preview = toShortPlanDraftView(content);

    expect(preview.goal).toContain("小学一年级");
    expect(preview.source).toBe("legacy_reviewed");
    expect(preview.items.map((item) => item.title)).toEqual([
      "b + a = ba",
      "辨认音节 ma",
      "ma 的第 3 声",
    ]);
    expect(preview.items[0]?.detail).toContain("不做发音评分");
    expect(JSON.stringify(preview)).not.toContain("prompt");
    expect(JSON.stringify(preview)).not.toContain("directive");
  });

  it("expands every child-visible field from a model-generated plan for adult review", () => {
    const content: LearningPlanContentRevision = {
      contentRevisionId: "3072f06d-c71a-47b3-94fe-35e1204b5b55",
      revision: 2,
      schemaVersion: "generated-teaching-plan-v2",
      compilerVersion: "model-generated-teaching-content-v2",
      title: "太阳系入门小计划",
      normalizedGoal: "认识八颗行星的顺序和基本特点",
      subject: "general",
      difficulty: "starter",
      gradeLevel: "grade_3",
      activityCount: 3,
      durationDays: 7,
      activities: [
        {
          kind: "model_generated_activity",
          key: "planet-overview",
          order: 1,
          title: "从太阳出发",
          objective: "先建立八颗行星的整体顺序。",
          knowledgeSource: "model_only",
          activityType: "explain_and_reflect",
          teachingText:
            "从太阳向外依次是水星、金星、地球、火星、木星、土星、天王星和海王星。",
          reflectionPrompt: "你能从地球开始，说出后面的两颗行星吗？",
          exampleResponse: "火星和木星。",
          feedbackText: "可以先记住地球旁边是金星和火星。",
        },
        {
          kind: "model_generated_activity",
          key: "largest-planet",
          order: 2,
          title: "最大的行星",
          objective: "辨认太阳系中体积最大的行星。",
          knowledgeSource: "model_only",
          activityType: "multiple_choice",
          questionText: "太阳系中体积最大的行星是哪一颗？",
          choices: [
            { id: "a", text: "地球" },
            { id: "b", text: "木星" },
            { id: "c", text: "火星" },
          ],
          correctChoiceId: "b",
          answerExplanation: "参考答案是木星，它的体积在八颗行星中最大。",
          hintText: "想一想名字里带“木”的那颗气态巨行星。",
        },
        {
          kind: "model_generated_activity",
          key: "earth-neighbors",
          order: 3,
          title: "地球的邻居",
          objective: "回忆地球轨道内外相邻的行星。",
          knowledgeSource: "model_only",
          activityType: "short_answer",
          questionText: "离地球轨道最近的内侧和外侧行星分别是什么？",
          acceptedAnswers: ["金星和火星", "金星、火星"],
          answerExplanation: "参考答案是金星和火星。",
          hintText: "从太阳向外的顺序中找到地球前后各一颗。",
        },
      ],
      createdAt: "2026-08-29T08:02:00.000Z",
    };

    const preview = toShortPlanDraftView(content);
    const serialized = JSON.stringify(preview);
    const markup = renderToStaticMarkup(
      <ShortPlanDraftPreview draft={preview} onPublish={() => undefined} />,
    );

    expect(preview.items.map((item) => item.typeLabel)).toEqual([
      "讲解与思考",
      "选择题",
      "简答题",
    ]);
    expect(preview.source).toBe("model_generated");
    for (const expectedText of [
      "从太阳向外依次是水星",
      "你能从地球开始",
      "火星和木星",
      "太阳系中体积最大的行星是哪一颗",
      "A. 地球",
      "B. 木星",
      "参考答案是木星",
      "离地球轨道最近的内侧和外侧行星",
      "金星和火星",
      "从太阳向外的顺序中找到地球前后各一颗",
    ]) {
      expect(serialized).toContain(expectedText);
      expect(markup).toContain(expectedText);
    }
    expect(serialized).not.toContain("knowledgeSource");
    expect(serialized).not.toContain("directive");
    expect(markup).toContain("来源：模型生成 · 未联网");
    expect(markup).toContain("内容可能有事实错误");
  });

  it("explains fail-closed generation errors without implying child ability", () => {
    expect(generationFailureMessage("generator_not_configured")).toContain(
      "教学计划生成",
    );
    expect(generationFailureMessage("invalid_model_output")).toContain(
      "严格结构",
    );
    expect(generationFailureMessage("invalid_model_output")).toContain(
      "空内容",
    );
    expect(generationFailureMessage("invalid_model_output")).toContain(
      "不会自动重试",
    );
    expect(generationFailureMessage("content_compilation_failed")).toContain(
      "安全编译",
    );
    expect(generationFailureMessage("model_result_unknown")).toContain(
      "供应商可能已计费，系统未自动重试",
    );
    expect(generationFailureMessage("unsupported_goal")).toContain("具体");
    expect(generationFailureMessage("needs_clarification")).toContain(
      "不够明确",
    );
    for (const code of [
      "generator_not_configured",
      "invalid_model_output",
      "content_compilation_failed",
    ] as const) {
      expect(generationFailureMessage(code)).not.toMatch(
        /落后|能力差|不聪明|掌握度|分数/,
      );
    }
  });
});

describe("short learning-plan request helpers", () => {
  it("normalizes an empty saved goal to null while preserving trimmed content", () => {
    expect(normalizeLearningGoalForSave(null)).toBeNull();
    expect(normalizeLearningGoalForSave("   \n  ")).toBeNull();
    expect(normalizeLearningGoalForSave("  练习 b、p、m、f 的基础拼读  ")).toBe(
      "练习 b、p、m、f 的基础拼读",
    );
  });

  it("reuses the request id only for the same saved plan target and revision", () => {
    let nextId = 0;
    const createClientRequestId = () => `request-${++nextId}`;
    const first = resolveLearningPlanGenerationRequestIdentity(
      null,
      {
        childUserId: "child-a",
        characterId: "character-a",
        planRevision: 3,
      },
      createClientRequestId,
    );

    const networkUnknownRetry = resolveLearningPlanGenerationRequestIdentity(
      first,
      {
        childUserId: "child-a",
        characterId: "character-a",
        planRevision: 3,
      },
      createClientRequestId,
    );
    expect(networkUnknownRetry).toBe(first);
    expect(networkUnknownRetry.clientRequestId).toBe("request-1");
    expect(networkUnknownRetry.generationId).toBeNull();
    expect(networkUnknownRetry.resultUnknown).toBe(false);

    const knownUnknownResult = {
      ...networkUnknownRetry,
      generationId: "generation-a",
      resultUnknown: true,
    };
    expect(
      resolveLearningPlanGenerationReadId(knownUnknownResult, {
        childUserId: "child-a",
        characterId: "character-a",
      }),
    ).toBe("generation-a");
    expect(
      resolveLearningPlanGenerationReadId(knownUnknownResult, {
        childUserId: "child-a",
        characterId: "character-b",
      }),
    ).toBeNull();

    const revised = resolveLearningPlanGenerationRequestIdentity(
      first,
      {
        childUserId: "child-a",
        characterId: "character-a",
        planRevision: 4,
      },
      createClientRequestId,
    );
    expect(revised.clientRequestId).toBe("request-2");
    expect(revised.generationId).toBeNull();
    expect(revised.resultUnknown).toBe(false);

    const switchedCharacter = resolveLearningPlanGenerationRequestIdentity(
      revised,
      {
        childUserId: "child-a",
        characterId: "character-b",
        planRevision: 4,
      },
      createClientRequestId,
    );
    expect(switchedCharacter.clientRequestId).toBe("request-3");

    const switchedChild = resolveLearningPlanGenerationRequestIdentity(
      switchedCharacter,
      {
        childUserId: "child-b",
        characterId: "character-b",
        planRevision: 4,
      },
      createClientRequestId,
    );
    expect(switchedChild.clientRequestId).toBe("request-4");
  });
});
