import { describe, expect, it } from "vitest";

import { buildTextModelTestRequestBody } from "../src/model-settings/service.js";

describe("text model test request compatibility", () => {
  const systemPrompt =
    '请只输出 JSON（json）对象，不要输出 Markdown、注释或其他文字。完整 JSON 示例：{"ok":true}';
  const userPrompt = "请按上述 JSON 格式返回连通性测试结果。";

  it("uses the DashScope JSON request shape without a token cap", () => {
    expect(
      buildTextModelTestRequestBody({
        model: "qwen-flash",
        compatibilityPreset: "dashscope",
      }),
    ).toEqual({
      model: "qwen-flash",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      response_format: { type: "json_object" },
      enable_thinking: false,
    });
  });

  it("uses DeepSeek JSON Mode with system role and max_tokens", () => {
    expect(
      buildTextModelTestRequestBody({
        model: "deepseek-v4-flash",
        compatibilityPreset: "standard",
      }),
    ).toEqual({
      model: "deepseek-v4-flash",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      response_format: { type: "json_object" },
      max_tokens: 128,
    });
  });

  it("recognizes case-insensitive DeepSeek model-id separators", () => {
    for (const model of ["DeepSeek_V4", "deepseek/v4", "deepseek.v4"]) {
      expect(
        buildTextModelTestRequestBody({
          model,
          compatibilityPreset: "standard",
        }),
      ).toMatchObject({
        messages: [{ role: "system" }, { role: "user" }],
        max_tokens: 128,
      });
    }
  });

  it("uses the standard developer-role request without legacy parameters", () => {
    expect(
      buildTextModelTestRequestBody({
        model: "o4-mini",
        compatibilityPreset: "standard",
      }),
    ).toEqual({
      model: "o4-mini",
      messages: [
        { role: "developer", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      response_format: { type: "json_object" },
    });
  });
});
