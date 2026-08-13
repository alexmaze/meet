import { describe, expect, it, vi } from "vitest";

import {
  QwenConversationAnalyzer,
  buildAnalysisTranscript,
} from "./analyzer.js";

describe("conversation analyzer", () => {
  it("marks interrupted assistant turns in the bounded transcript", () => {
    expect(
      buildAnalysisTranscript([
        { sequence: 1, role: "user", status: "completed", text: "我喜欢围棋" },
        {
          sequence: 2,
          role: "assistant",
          status: "interrupted",
          text: "那我们以后可以",
        },
      ]),
    ).toContain("[2] 角色（被打断）：那我们以后可以");
  });

  it("uses Qwen JSON mode without exposing credentials in the body", async () => {
    const fetchFunction = vi.fn(async (_url, init) => {
      expect(init?.headers).toMatchObject({
        Authorization: "Bearer secret-key",
      });
      expect(String(init?.body)).not.toContain("secret-key");
      expect(JSON.parse(String(init?.body))).toMatchObject({
        model: "qwen-plus",
        response_format: { type: "json_object" },
        enable_thinking: false,
      });
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: '{"summary":"用户喜欢围棋。"}' } }],
        }),
      );
    });
    const analyzer = new QwenConversationAnalyzer({
      apiKey: "secret-key",
      baseUrl: "https://dashscope.example/v1/",
      model: "qwen-plus",
      requestTimeoutMs: 10_000,
      fetchFunction,
    });

    await expect(
      analyzer.summarize({
        characterName: "知夏",
        messages: [
          {
            sequence: 1,
            role: "user",
            status: "completed",
            text: "我喜欢围棋",
          },
        ],
      }),
    ).resolves.toBe("用户喜欢围棋。");
    expect(fetchFunction).toHaveBeenCalledWith(
      "https://dashscope.example/v1/chat/completions",
      expect.any(Object),
    );
  });

  it("merges an earlier checkpoint with only the new transcript", async () => {
    const fetchFunction = vi.fn(async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as {
        messages: Array<{ role: string; content: string }>;
      };
      expect(body.messages[1]?.content).toContain(
        "已有摘要：\n用户已经完成第一题。",
      );
      expect(body.messages[1]?.content).toContain("新增转写：");
      expect(body.messages[1]?.content).toContain("[21] 用户：继续第二题");
      return new Response(
        JSON.stringify({
          choices: [
            { message: { content: '{"summary":"用户继续完成第二题。"}' } },
          ],
        }),
      );
    });
    const analyzer = new QwenConversationAnalyzer({
      apiKey: "secret-key",
      baseUrl: "https://dashscope.example/v1",
      model: "qwen-plus",
      requestTimeoutMs: 10_000,
      fetchFunction,
    });

    await expect(
      analyzer.summarize({
        characterName: "林老师",
        previousSummary: "用户已经完成第一题。",
        messages: [
          {
            sequence: 21,
            role: "user",
            status: "completed",
            text: "继续第二题",
          },
        ],
      }),
    ).resolves.toBe("用户继续完成第二题。");
  });
});
