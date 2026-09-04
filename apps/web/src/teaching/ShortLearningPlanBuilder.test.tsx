import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  shortPlanExamples,
  ShortLearningPlanBuilder,
  ShortPlanDraftPreview,
  shortPlanRecommendedSubject,
  shortPlanSupportMessage,
  validateShortPlanGoal,
  type ShortPlanBuilderValue,
  type ShortPlanDraftView,
} from "./ShortLearningPlanBuilder.js";

const value: ShortPlanBuilderValue = {
  gradeLevel: "grade_1",
  learningGoal: "练习 b、p、m、f 的简单拼读。",
  activityCount: 4,
  durationDays: 7,
};

const draft: ShortPlanDraftView = {
  contentRevisionId: "content-revision-id",
  title: "7 天拼音小计划",
  goal: "练习 b、p、m、f 的简单拼读",
  durationDays: 7,
  source: "model_generated",
  pendingSupportMessage: null,
  items: [
    {
      id: "item-1",
      typeLabel: "拼音辨认",
      title: "认识 b 和 a",
      detail: "听一次 b + a = ba，可以跟读，也可以只听示范。",
      reviewFields: [
        { label: "题目", value: "下面哪个音节读 ba？" },
        { label: "选项", value: ["A. ba", "B. pa"] },
        { label: "参考答案", value: "A. ba" },
        { label: "答案讲解", value: "b 和 a 拼在一起读 ba。" },
      ],
    },
    {
      id: "item-2",
      typeLabel: "拼音拼读",
      title: "试试 m 和 a",
      detail: "从示范开始，不根据实时转写做发音评分。",
    },
    {
      id: "item-3",
      typeLabel: "拼音辨认",
      title: "分辨 ba 和 pa",
      detail: "只做一个选择，允许立即跳过。",
    },
  ],
};

describe("ShortLearningPlanBuilder", () => {
  it("renders grade, concrete goal, dose controls and safe examples", () => {
    const markup = renderToStaticMarkup(
      <ShortLearningPlanBuilder
        value={value}
        generationState="idle"
        draft={null}
        onChange={() => undefined}
        onApplyExample={() => undefined}
        onGenerate={() => undefined}
        onPublish={() => undefined}
      />,
    );

    expect(markup).toContain("参考阶段");
    expect(markup).toContain("具体学习目标");
    expect(markup).toContain("活动数");
    expect(markup).toContain("计划时长");
    expect(markup).toContain("初中一年级");
    expect(markup).toContain("高中三年级");
    expect(markup).toContain("生成短期计划");
    expect(markup).toContain(
      "不要填写孩子姓名、学校、老师、健康、情绪或家庭经历",
    );
    for (const example of shortPlanExamples) {
      expect(markup).toContain(example.label);
    }
    expect(shortPlanExamples[0]?.value.learningGoal).toContain(
      "b、p、m、f 的基础拼读",
    );
    expect(shortPlanExamples[0]?.value.learningGoal).toContain("不做发音评分");
    expect(shortPlanExamples[0]?.value.learningGoal).not.toMatch(
      /a、o、e|ai|ei|z、c、s/,
    );
  });

  it("renders a reviewable draft and keeps publishing explicit", () => {
    const markup = renderToStaticMarkup(
      <ShortPlanDraftPreview draft={draft} onPublish={() => undefined} />,
    );

    expect(markup).toContain("待成人确认");
    expect(markup).toContain("3 个活动 · 7 天");
    for (const item of draft.items) {
      expect(markup).toContain(item.title);
      expect(markup).toContain(item.detail);
    }
    expect(markup).toContain("下面哪个音节读 ba");
    expect(markup).toContain("A. ba");
    expect(markup).toContain("B. pa");
    expect(markup).toContain("b 和 a 拼在一起读 ba");
    expect(markup).toContain("确认并启用");
    expect(markup).toContain("不会记录分数或能力评价");
    expect(markup).toContain("来源：模型生成 · 未联网");
    expect(markup).toContain("内容可能有事实错误");
    expect(markup).toContain("请家长逐项核对");
  });

  it("explains the required model and exposes an explicit generation state", () => {
    const idleMarkup = renderToStaticMarkup(
      <ShortLearningPlanBuilder
        value={value}
        generationState="idle"
        draft={null}
        onChange={() => undefined}
        onApplyExample={() => undefined}
        onGenerate={() => undefined}
        onPublish={() => undefined}
      />,
    );
    expect(idleMarkup).toContain("绑定并启用“教学计划生成模型”");
    expect(idleMarkup).toContain("不会联网检索");
    expect(idleMarkup).toContain("可能产生一次模型费用");
    expect(idleMarkup).toContain("网络结果未知时只会检查同一请求");
    expect(idleMarkup).toContain("不会自动再次调用模型");

    const generatingMarkup = renderToStaticMarkup(
      <ShortLearningPlanBuilder
        value={value}
        generationState="generating"
        draft={null}
        onChange={() => undefined}
        onApplyExample={() => undefined}
        onGenerate={() => undefined}
        onPublish={() => undefined}
      />,
    );
    expect(generatingMarkup).toContain("大模型正在生成计划草稿");
    expect(generatingMarkup).toContain("完成后请成人逐项预览并确认");
  });

  it("shows generation failure without implying the current plan changed", () => {
    const markup = renderToStaticMarkup(
      <ShortLearningPlanBuilder
        value={value}
        generationState="failed"
        generationError="教学计划模型这次没有完成请求。"
        draft={null}
        onChange={() => undefined}
        onApplyExample={() => undefined}
        onGenerate={() => undefined}
        onPublish={() => undefined}
      />,
    );

    expect(markup).toContain("这次没有生成草稿");
    expect(markup).toContain("教学计划模型这次没有完成请求");
    expect(markup).toContain("重新生成");
  });

  it("keeps an unknown paid result on the existing request", () => {
    const markup = renderToStaticMarkup(
      <ShortLearningPlanBuilder
        value={value}
        generationState="failed"
        generationResultUnknown
        generationError="供应商可能已计费，系统未自动重试。如确认再次生成，请先修改并保存学习设置形成新版本。"
        draft={null}
        onChange={() => undefined}
        onApplyExample={() => undefined}
        onGenerate={() => undefined}
        onPublish={() => undefined}
      />,
    );

    expect(markup).toContain("模型结果仍不确定");
    expect(markup).toContain("供应商可能已计费，系统未自动重试");
    expect(markup).toContain("先修改并保存学习设置形成新版本");
    expect(markup).toContain("检查已有结果");
    expect(markup).not.toContain(">重新生成</button>");
  });

  it("requires an adult-selected reference stage before generation", () => {
    const markup = renderToStaticMarkup(
      <ShortLearningPlanBuilder
        value={{ ...value, gradeLevel: "unspecified" }}
        generationState="idle"
        draft={null}
        onChange={() => undefined}
        onApplyExample={() => undefined}
        onGenerate={() => undefined}
        onPublish={() => undefined}
      />,
    );

    expect(markup).toContain("生成计划前，请先选择一个参考阶段");
    expect(markup).toMatch(
      /<button type="button" class="short-plan-generate-button" disabled="">生成短期计划<\/button>/,
    );
  });
});

describe("short plan helpers", () => {
  it("validates a concrete but bounded goal", () => {
    expect(validateShortPlanGoal(" ")).toContain("请先填写");
    expect(validateShortPlanGoal("拼音")).toContain("至少写 4 个字");
    expect(validateShortPlanGoal("练习拼音拼读")).toBeNull();
    expect(validateShortPlanGoal("拼音和乘法口诀一起练习")).toBeNull();
    expect(validateShortPlanGoal("认识太阳系八颗行星的顺序")).toBeNull();
    expect(validateShortPlanGoal("乘法".repeat(151))).toContain("最多 300");
  });

  it("accepts arbitrary concrete goals while explaining the model boundary", () => {
    expect(shortPlanSupportMessage("练习声母和韵母")).toContain(
      "教学计划生成模型",
    );
    expect(shortPlanSupportMessage("熟悉 2～5 乘法口诀")).toContain(
      "不会联网核对",
    );
    expect(shortPlanSupportMessage("认识植物")).toContain("模型可能出错");
    expect(shortPlanSupportMessage(" ")).toContain("其他具体学习内容");
    expect(shortPlanSupportMessage(" ")).toContain("需要管理员先配置");
    expect(shortPlanRecommendedSubject("练习拼音拼读")).toBe("chinese");
    expect(shortPlanRecommendedSubject("练习 3×4 的乘法口诀")).toBe("math");
    expect(shortPlanRecommendedSubject("认识植物")).toBeNull();
    expect(shortPlanRecommendedSubject("拼音和乘法口诀")).toBeNull();
    expect(shortPlanSupportMessage("拼音和乘法口诀")).toContain(
      "可预览的活动草稿",
    );
  });
});
