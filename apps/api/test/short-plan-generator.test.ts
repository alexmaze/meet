import { modelGeneratedTeachingPlanDraftSchema } from "@meet/protocol";
import type { z } from "zod";
import { describe, expect, it, vi } from "vitest";

import {
  SHORT_PLAN_MODEL_RESPONSE_MAX_BYTES,
  ShortPlanGenerator,
  type ResolveShortPlanTextRuntime,
  type ShortPlanGenerationInput,
  type ShortPlanTextRuntime,
  type ShortPlanTextRuntimeSelector,
} from "../src/teaching/short-plan-generator.js";

const profileId = "4d1c2e31-ad0e-4fa9-9ae8-ae3497069116";
const connectionId = "4d1c2e31-ad0e-4fa9-9ae8-ae3497069117";
type ModelGeneratedTeachingPlanDraft = z.infer<
  typeof modelGeneratedTeachingPlanDraftSchema
>;

describe("ShortPlanGenerator", () => {
  it("always requires the configured text binding and never falls back to a local template", async () => {
    const resolveTextRuntime = vi.fn<ResolveShortPlanTextRuntime>(async () =>
      Promise.resolve(null),
    );
    const fetchFunction = vi.fn() as unknown as typeof globalThis.fetch;
    const generator = new ShortPlanGenerator({
      resolveTextRuntime,
      fetchFunction,
    });

    const prepared = await generator.prepare({
      ...baseInput(),
      generationMode: "auto",
      subject: "math",
      learningGoal: "练习 2 的乘法口诀",
    });

    expect(prepared).toEqual({
      kind: "failed",
      errorCode: "generator_not_configured",
    });
    expect(resolveTextRuntime).toHaveBeenCalledOnce();
    expect(fetchFunction).not.toHaveBeenCalled();
  });

  it("uses one verified qwen-flash call to produce a strict reviewable v2 plan", async () => {
    const runtime = textRuntime();
    const resolveTextRuntime = vi.fn(async () => runtime);
    const fetchFunction = vi.fn(async () =>
      jsonResponse(completionPayload(modelPlanOutput())),
    ) as unknown as typeof globalThis.fetch;
    const generator = new ShortPlanGenerator({
      resolveTextRuntime,
      fetchFunction,
      requestTimeoutMs: 2_000,
    });

    const prepared = await generator.prepare(baseInput());

    expect(prepared.kind).toBe("prepared");
    if (prepared.kind !== "prepared") return;
    expect(prepared.metadata).toEqual({
      generatorSource: "text_model",
      modelProfileId: profileId,
      modelProfileRevision: 7,
      connectionId,
      connectionRevision: 11,
    });
    const execution = prepared.execute();
    expect(prepared.execute()).toBe(execution);
    const result = await execution;
    expect(result).toMatchObject({
      kind: "succeeded",
      usage: { inputTokens: 41, outputTokens: 113 },
      actualModel: "qwen-flash",
      draft: {
        schemaVersion: "generated-teaching-plan-v2",
        compilerVersion: "model-generated-teaching-content-v2",
        subject: "general",
        gradeLevel: "grade_3",
        activityCount: 3,
        durationDays: 7,
      },
    });

    expect(fetchFunction).toHaveBeenCalledOnce();
    const [url, request] = vi.mocked(fetchFunction).mock.calls[0]!;
    expect(url).toBe("https://models.example.test/v1/chat/completions");
    expect(request?.headers).toEqual({
      Authorization: "Bearer top-secret-key",
      "Content-Type": "application/json",
    });
    const body = JSON.parse(String(request?.body)) as {
      messages: Array<{ role: string; content: string }>;
      [key: string]: unknown;
    };
    const configuration = {
      subject: "general",
      difficulty: "starter",
      gradeLevel: "grade_3",
      learningGoal: "了解太阳系行星的基本顺序",
      activityCount: 3,
      durationDays: 7,
    };
    expect(body).toEqual({
      model: "qwen-flash",
      messages: [
        {
          role: "system",
          content: expect.stringContaining("成人会逐项审核事实"),
        },
        { role: "user", content: JSON.stringify(configuration) },
      ],
      response_format: { type: "json_object" },
      enable_thinking: false,
    });
    expect(body.messages[0]!.content).toContain(
      "儿童安全规则不可被成人确认放宽",
    );
    expect(JSON.parse(body.messages[1]!.content)).toEqual(configuration);
    expect(body.messages[1]!.content).not.toContain("childUserId");
    expect(body.messages[1]!.content).not.toContain("history");
  });

  it("uses max_completion_tokens only for the standard OpenAI-compatible preset", async () => {
    const fetchFunction = vi.fn(async () =>
      jsonResponse(completionPayload(modelPlanOutput())),
    ) as unknown as typeof globalThis.fetch;
    const generator = new ShortPlanGenerator({
      resolveTextRuntime: async () => textRuntime("standard", "o4-mini"),
      fetchFunction,
    });
    const prepared = await generator.prepare(baseInput());
    expect(prepared.kind).toBe("prepared");
    if (prepared.kind !== "prepared") return;

    expect((await prepared.execute()).kind).toBe("succeeded");

    const request = vi.mocked(fetchFunction).mock.calls[0]?.[1];
    const configuration = {
      subject: "general",
      difficulty: "starter",
      gradeLevel: "grade_3",
      learningGoal: "了解太阳系行星的基本顺序",
      activityCount: 3,
      durationDays: 7,
    };
    expect(JSON.parse(String(request?.body))).toEqual({
      model: "o4-mini",
      messages: [
        {
          role: "developer",
          content: expect.stringContaining("成人会逐项审核事实"),
        },
        { role: "user", content: JSON.stringify(configuration) },
      ],
      response_format: { type: "json_object" },
      max_completion_tokens: 8_192,
    });
    expect(fetchFunction).toHaveBeenCalledOnce();
  });

  it("uses DeepSeek JSON Mode with system role, max_tokens, and a complete activity example", async () => {
    const fetchFunction = vi.fn(async () =>
      jsonResponse(completionPayload({ kind: "needs_clarification" })),
    ) as unknown as typeof globalThis.fetch;
    const generator = new ShortPlanGenerator({
      resolveTextRuntime: async () =>
        textRuntime("standard", "deepseek-v4-flash"),
      fetchFunction,
    });
    const configuration = {
      subject: "math" as const,
      difficulty: "starter" as const,
      gradeLevel: "grade_2" as const,
      learningGoal: "用循序渐进的活动练习乘法口诀",
      activityCount: 8,
      durationDays: 7 as const,
    };
    const prepared = await generator.prepare({
      generationMode: "text_model",
      ...configuration,
    });
    expect(prepared.kind).toBe("prepared");
    if (prepared.kind !== "prepared") return;

    expect(await prepared.execute()).toEqual({
      kind: "failed",
      errorCode: "needs_clarification",
    });
    expect(fetchFunction).toHaveBeenCalledOnce();

    const request = vi.mocked(fetchFunction).mock.calls[0]?.[1];
    const body = JSON.parse(String(request?.body)) as {
      messages: Array<{ role: string; content: string }>;
      [key: string]: unknown;
    };
    const systemPrompt = body.messages[0]?.content ?? "";
    expect(body).toEqual({
      model: "deepseek-v4-flash",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: JSON.stringify(configuration) },
      ],
      response_format: { type: "json_object" },
      max_tokens: 8_192,
    });
    expect(systemPrompt).toContain("JSON（json）");
    expect(systemPrompt).toContain(
      "activities 的元素数量必须严格等于用户 JSON 输入中的 activityCount",
    );
    expect(systemPrompt).toContain("从 1 到 activityCount 连续递增");
    expect(systemPrompt).toContain("^[a-z0-9]+(?:-[a-z0-9]+)*$");
    expect(systemPrompt).toContain("整份计划可见文本合计最多 6000 字符");

    const exampleMarker = "下面是包含三种 activityType 的完整合法 JSON 示例";
    const exampleStart = systemPrompt.indexOf(
      "{",
      systemPrompt.indexOf(exampleMarker),
    );
    const exampleEnd = systemPrompt.indexOf("\nJSON 示例结束。", exampleStart);
    expect(exampleStart).toBeGreaterThan(-1);
    expect(exampleEnd).toBeGreaterThan(exampleStart);
    const example = JSON.parse(
      systemPrompt.slice(exampleStart, exampleEnd),
    ) as {
      kind: string;
      title: string;
      normalizedGoal: string;
      activities: unknown[];
    };
    expect(example.kind).toBe("plan");
    expect(example.activities).toHaveLength(3);
    expect(
      example.activities.map(
        (activity) => (activity as { activityType: string }).activityType,
      ),
    ).toEqual(["explain_and_reflect", "multiple_choice", "short_answer"]);
    const { kind: _kind, ...examplePlan } = example;
    expect(
      modelGeneratedTeachingPlanDraftSchema.safeParse({
        schemaVersion: "generated-teaching-plan-v2",
        compilerVersion: "model-generated-teaching-content-v2",
        subject: "general",
        difficulty: "starter",
        gradeLevel: "grade_3",
        activityCount: 3,
        durationDays: 7,
        ...examplePlan,
      }).success,
    ).toBe(true);
  });

  it("accepts eight distinct DeepSeek activities and injects the authoritative plan fields", async () => {
    const fetchFunction = vi.fn(async () =>
      jsonResponse(
        completionPayload(modelPlanOutput(modelDraftWithEightActivities())),
      ),
    ) as unknown as typeof globalThis.fetch;
    const generator = new ShortPlanGenerator({
      resolveTextRuntime: async () =>
        textRuntime("standard", "DeepSeek_V4-Flash"),
      fetchFunction,
    });
    const prepared = await generator.prepare({
      ...baseInput(),
      activityCount: 8,
      durationDays: 14,
    });
    expect(prepared.kind).toBe("prepared");
    if (prepared.kind !== "prepared") return;

    const result = await prepared.execute();

    expect(result).toMatchObject({
      kind: "succeeded",
      draft: {
        schemaVersion: "generated-teaching-plan-v2",
        compilerVersion: "model-generated-teaching-content-v2",
        subject: "general",
        difficulty: "starter",
        gradeLevel: "grade_3",
        activityCount: 8,
        durationDays: 14,
      },
    });
    if (result.kind !== "succeeded") return;
    expect(result.draft.activities).toHaveLength(8);
    expect(result.draft.activities.map((activity) => activity.order)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8,
    ]);
    expect(
      new Set(result.draft.activities.map((activity) => activity.key)).size,
    ).toBe(8);
    expect(fetchFunction).toHaveBeenCalledOnce();
  });

  it.each([
    ["unsupported", "unsupported_goal"],
    ["needs_clarification", "needs_clarification"],
  ] as const)(
    "maps the strict %s decision to a fixed safe error",
    async (kind, errorCode) => {
      const generator = generatorForOutput({ kind });
      const prepared = await generator.prepare(baseInput());
      expect(prepared.kind).toBe("prepared");
      if (prepared.kind !== "prepared") return;

      expect(await prepared.execute()).toEqual({ kind: "failed", errorCode });
    },
  );

  it("rejects extra model DSL fields without exposing raw output or adult input", async () => {
    const rawGoal = "private-adult-goal-marker";
    const rawOutput = "raw-model-output-marker";
    const generator = generatorForOutput({
      ...modelPlanOutput(),
      explanation: rawOutput,
    });
    const prepared = await generator.prepare({
      ...baseInput(),
      learningGoal: rawGoal,
    });
    expect(prepared.kind).toBe("prepared");
    if (prepared.kind !== "prepared") return;

    const result = await prepared.execute();

    expect(result).toEqual({
      kind: "failed",
      errorCode: "invalid_model_output",
    });
    expect(JSON.stringify(result)).not.toMatch(
      /private|raw-model|top-secret/iu,
    );
  });

  it("rejects model attempts to provide or override server-authoritative fields", async () => {
    const generator = generatorForOutput({
      ...modelPlanOutput(),
      schemaVersion: "generated-teaching-plan-v1",
      subject: "science",
      difficulty: "advanced",
      gradeLevel: "grade_12",
      activityCount: 8,
      durationDays: 14,
    });
    const prepared = await generator.prepare(baseInput());
    expect(prepared.kind).toBe("prepared");
    if (prepared.kind !== "prepared") return;

    expect(await prepared.execute()).toEqual({
      kind: "failed",
      errorCode: "invalid_model_output",
    });
  });

  it("rejects locally detected child-safety violations after protocol parsing", async () => {
    const safeDraft = modelDraft();
    const first = safeDraft.activities[0]!;
    if (first.activityType !== "explain_and_reflect") {
      throw new Error("Unexpected test fixture activity.");
    }
    const unsafeDraft = modelDraft({
      activities: [
        { ...first, feedbackText: "如果你不回答，我就不再喜欢你。" },
        ...safeDraft.activities.slice(1),
      ],
    });
    const generator = generatorForOutput(modelPlanOutput(unsafeDraft));
    const prepared = await generator.prepare(baseInput());
    expect(prepared.kind).toBe("prepared");
    if (prepared.kind !== "prepared") return;

    expect(await prepared.execute()).toEqual({
      kind: "failed",
      errorCode: "unsupported_goal",
    });
  });

  it.each([
    "你家的详细住址是什么？",
    "你在哪所学校、哪个班级？",
    "你家长平时用什么号码联系别人？",
    "把家长手机号码写下来。",
    "说说你就读的学校叫什么。",
    "请说出你每天放学后回到哪里。",
    "Write down your parent's phone number.",
    "Write down your parent’s phone number.",
    "Say the name of your school.",
    "Type your home address.",
  ])(
    "rejects a direct child-PII request in a complete draft: %s",
    async (text) => {
      const safeDraft = modelDraft();
      const first = safeDraft.activities[0]!;
      if (first.activityType !== "explain_and_reflect") {
        throw new Error("Unexpected test fixture activity.");
      }
      const generator = generatorForOutput(
        modelPlanOutput(
          modelDraft({
            activities: [
              { ...first, reflectionPrompt: text },
              ...safeDraft.activities.slice(1),
            ],
          }),
        ),
      );
      const prepared = await generator.prepare(baseInput());
      expect(prepared.kind).toBe("prepared");
      if (prepared.kind !== "prepared") return;

      expect(await prepared.execute()).toEqual({
        kind: "failed",
        errorCode: "unsupported_goal",
      });
    },
  );

  it("allows a non-soliciting personal-information safety lesson", async () => {
    const safeDraft = modelDraft();
    const first = safeDraft.activities[0]!;
    if (first.activityType !== "explain_and_reflect") {
      throw new Error("Unexpected test fixture activity.");
    }
    const generator = generatorForOutput(
      modelPlanOutput(
        modelDraft({
          activities: [
            {
              ...first,
              teachingText:
                "住址、学校和联系方式属于个人信息，不应向陌生人透露。",
              reflectionPrompt: "为什么保护个人信息很重要？",
              exampleResponse: "这样可以减少个人信息被滥用的风险。",
            },
            ...safeDraft.activities.slice(1),
          ],
        }),
      ),
    );
    const prepared = await generator.prepare(baseInput());
    expect(prepared.kind).toBe("prepared");
    if (prepared.kind !== "prepared") return;

    expect((await prepared.execute()).kind).toBe("succeeded");
  });

  it("allows a complete English privacy-protection lesson", async () => {
    const safeDraft = modelDraft();
    const first = safeDraft.activities[0]!;
    if (first.activityType !== "explain_and_reflect") {
      throw new Error("Unexpected test fixture activity.");
    }
    const generator = generatorForOutput(
      modelPlanOutput(
        modelDraft({
          activities: [
            {
              ...first,
              teachingText:
                "Learn why you should not share your address or phone number.",
              reflectionPrompt: "Why is it important to protect private data?",
              exampleResponse: "It helps keep personal information safe.",
            },
            ...safeDraft.activities.slice(1),
          ],
        }),
      ),
    );
    const prepared = await generator.prepare(baseInput());
    expect(prepared.kind).toBe("prepared");
    if (prepared.kind !== "prepared") return;

    expect((await prepared.execute()).kind).toBe("succeeded");
  });

  it.each([
    ["child name", "孩子姓名：张小明，练习三位数加法。"],
    ["parent name", "家长姓名：李小红，安排一周阅读练习。"],
    ["school and class", "孩子就读于春苗小学，在三年级二班。"],
    ["home address", "家庭地址：北京市朝阳区春风路 8 号。"],
    ["current location", "孩子当前位置：北京市朝阳区少年宫东门。"],
    ["phone number", "家长联系电话：13800138000。"],
    ["WeChat ID", "家长微信号：parent_123。"],
    ["email address", "家长邮箱：parent@example.com。"],
    ["identity number", "孩子身份证号：11010120150307123X。"],
    ["solicited route", "请说出你每天放学后回到哪里。"],
    ["English parent phone", "Write down your parent's phone number."],
    ["English curly parent phone", "Write down your parent’s phone number."],
    ["English school name", "Say the name of your school."],
    ["English home address", "Type your home address."],
    [
      "English child name and school",
      "Child name: Alice; attends Spring Elementary School.",
    ],
  ])(
    "rejects a concrete adult goal containing %s before resolving or fetching",
    async (_label, learningGoal) => {
      const resolveTextRuntime = vi.fn(async () => textRuntime());
      const fetchFunction = vi.fn() as unknown as typeof globalThis.fetch;
      const generator = new ShortPlanGenerator({
        resolveTextRuntime,
        fetchFunction,
      });

      const prepared = await generator.prepare({
        ...baseInput(),
        learningGoal,
      });

      expect(prepared).toEqual({
        kind: "failed",
        errorCode: "unsupported_goal",
      });
      expect(resolveTextRuntime).not.toHaveBeenCalled();
      expect(fetchFunction).not.toHaveBeenCalled();
      expect(JSON.stringify(prepared)).not.toContain(learningGoal);
    },
  );

  it.each([
    "学习保护个人信息，不向陌生人透露姓名、学校、住址和联系方式。",
    "说说学校里的消防安全规则。",
    "说说一年级学过的拼音。",
    "Learn why you should not share your address or phone number.",
  ])(
    "allows a non-identifying adult learning goal: %s",
    async (learningGoal) => {
      const fetchFunction = vi.fn(async () =>
        jsonResponse(completionPayload(modelPlanOutput())),
      ) as unknown as typeof globalThis.fetch;
      const generator = new ShortPlanGenerator({
        resolveTextRuntime: async () => textRuntime(),
        fetchFunction,
      });

      const prepared = await generator.prepare({
        ...baseInput(),
        learningGoal,
      });
      expect(prepared.kind).toBe("prepared");
      if (prepared.kind !== "prepared") return;

      expect((await prepared.execute()).kind).toBe("succeeded");
      expect(fetchFunction).toHaveBeenCalledOnce();
    },
  );

  it("strips unknown provider envelope and usage metadata", async () => {
    const privateMarker = "provider-private-marker";
    const completion = completionPayload(modelPlanOutput());
    const choice = completion.choices[0]!;
    const generator = generatorForCompletion({
      ...completion,
      provider_extension: privateMarker,
      usage: {
        ...completion.usage,
        provider_usage_extension: privateMarker,
        prompt_tokens_details: {
          cached_tokens: 3,
          provider_detail_extension: privateMarker,
        },
      },
      choices: [
        {
          ...choice,
          provider_choice_extension: privateMarker,
          message: {
            ...choice.message,
            provider_message_extension: privateMarker,
          },
        },
      ],
    });
    const prepared = await generator.prepare(baseInput());
    expect(prepared.kind).toBe("prepared");
    if (prepared.kind !== "prepared") return;

    const result = await prepared.execute();

    expect(result).toMatchObject({
      kind: "succeeded",
      usage: { inputTokens: 41, outputTokens: 113 },
    });
    expect(JSON.stringify(result)).not.toContain(privateMarker);
  });

  it("fails a length-truncated completion without retrying", async () => {
    const fetchFunction = vi.fn(async () =>
      jsonResponse(completionPayload(modelPlanOutput(), "length")),
    ) as unknown as typeof globalThis.fetch;
    const generator = new ShortPlanGenerator({
      resolveTextRuntime: async () => textRuntime(),
      fetchFunction,
    });
    const prepared = await generator.prepare(baseInput());
    expect(prepared.kind).toBe("prepared");
    if (prepared.kind !== "prepared") return;

    expect(await prepared.execute()).toEqual({
      kind: "failed",
      errorCode: "invalid_model_output",
    });
    expect(fetchFunction).toHaveBeenCalledOnce();
  });

  it.each(["", "   ", null] as const)(
    "fails DeepSeek empty content without retrying: %j",
    async (content) => {
      const completion = completionPayload(modelPlanOutput());
      (completion.choices[0]!.message as { content: unknown }).content =
        content;
      const fetchFunction = vi.fn(async () =>
        jsonResponse(completion),
      ) as unknown as typeof globalThis.fetch;
      const generator = new ShortPlanGenerator({
        resolveTextRuntime: async () =>
          textRuntime("standard", "deepseek-v4-flash"),
        fetchFunction,
      });
      const prepared = await generator.prepare(baseInput());
      expect(prepared.kind).toBe("prepared");
      if (prepared.kind !== "prepared") return;

      expect(await prepared.execute()).toEqual({
        kind: "failed",
        errorCode: "invalid_model_output",
      });
      expect(fetchFunction).toHaveBeenCalledOnce();
    },
  );

  it("rejects an oversized response from content-length before parsing", async () => {
    const fetchFunction = vi.fn(
      async () =>
        new Response("{}", {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "Content-Length": String(SHORT_PLAN_MODEL_RESPONSE_MAX_BYTES + 1),
          },
        }),
    ) as unknown as typeof globalThis.fetch;
    const generator = new ShortPlanGenerator({
      resolveTextRuntime: async () => textRuntime(),
      fetchFunction,
    });
    const prepared = await generator.prepare(baseInput());
    expect(prepared.kind).toBe("prepared");
    if (prepared.kind !== "prepared") return;

    expect(await prepared.execute()).toEqual({
      kind: "failed",
      errorCode: "invalid_model_output",
    });
    expect(fetchFunction).toHaveBeenCalledOnce();
  });

  it("stops a streamed body at the explicit byte limit", async () => {
    const fetchFunction = vi.fn(
      async () =>
        new Response(" ".repeat(SHORT_PLAN_MODEL_RESPONSE_MAX_BYTES + 1), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    ) as unknown as typeof globalThis.fetch;
    const generator = new ShortPlanGenerator({
      resolveTextRuntime: async () => textRuntime(),
      fetchFunction,
    });
    const prepared = await generator.prepare(baseInput());
    expect(prepared.kind).toBe("prepared");
    if (prepared.kind !== "prepared") return;

    expect(await prepared.execute()).toEqual({
      kind: "failed",
      errorCode: "invalid_model_output",
    });
  });

  it.each([
    [
      "timeout after dispatch",
      async () =>
        Promise.reject(new DOMException("private timeout", "AbortError")),
      "model_result_unknown",
    ],
    [
      "network interruption",
      async () => Promise.reject(new Error("secret raw error")),
      "model_result_unknown",
    ],
    [
      "HTTP 5xx",
      async () => new Response("private upstream body", { status: 500 }),
      "model_result_unknown",
    ],
    [
      "HTTP 4xx",
      async () => new Response("private upstream body", { status: 400 }),
      "model_request_failed",
    ],
    [
      "wrong media type",
      async () => new Response("private upstream body", { status: 200 }),
      "invalid_model_output",
    ],
  ] as const)(
    "maps %s to %s with one call and no raw leakage",
    async (_name, fetchImpl, errorCode) => {
      const fetchFunction = vi.fn(
        fetchImpl,
      ) as unknown as typeof globalThis.fetch;
      const generator = new ShortPlanGenerator({
        resolveTextRuntime: async () => textRuntime(),
        fetchFunction,
      });
      const prepared = await generator.prepare({
        ...baseInput(),
        learningGoal: "raw-private-goal",
      });
      expect(prepared.kind).toBe("prepared");
      if (prepared.kind !== "prepared") return;

      const result = await prepared.execute();

      expect(result).toEqual({ kind: "failed", errorCode });
      expect(fetchFunction).toHaveBeenCalledOnce();
      expect(JSON.stringify(result)).not.toMatch(/secret|private|upstream/iu);
    },
  );

  it("marks an interrupted 2xx response body unknown without retrying", async () => {
    const interruptedBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"choices":'));
        controller.error(new Error("private stream interruption"));
      },
    });
    const fetchFunction = vi.fn(
      async () =>
        new Response(interruptedBody, {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    ) as unknown as typeof globalThis.fetch;
    const generator = new ShortPlanGenerator({
      resolveTextRuntime: async () => textRuntime(),
      fetchFunction,
    });
    const prepared = await generator.prepare(baseInput());
    expect(prepared.kind).toBe("prepared");
    if (prepared.kind !== "prepared") return;

    const result = await prepared.execute();

    expect(result).toEqual({
      kind: "failed",
      errorCode: "model_result_unknown",
    });
    expect(fetchFunction).toHaveBeenCalledOnce();
    expect(JSON.stringify(result)).not.toContain("private stream");
  });

  it.each([
    [undefined, 60_000],
    [2_345, 2_345],
  ] as const)(
    "uses the configured timeout %s as %i ms",
    async (configuredTimeout, expectedTimeout) => {
      const timeout = vi.spyOn(AbortSignal, "timeout");
      try {
        const generator = new ShortPlanGenerator({
          resolveTextRuntime: async () => textRuntime(),
          fetchFunction: async () =>
            jsonResponse(completionPayload(modelPlanOutput())),
          ...(configuredTimeout === undefined
            ? {}
            : { requestTimeoutMs: configuredTimeout }),
        });
        const prepared = await generator.prepare(baseInput());
        expect(prepared.kind).toBe("prepared");
        if (prepared.kind !== "prepared") return;

        expect((await prepared.execute()).kind).toBe("succeeded");
        expect(timeout).toHaveBeenCalledWith(expectedTimeout);
      } finally {
        timeout.mockRestore();
      }
    },
  );

  it("rejects an unspecified grade before resolving or charging", async () => {
    const resolveTextRuntime = vi.fn(async () => textRuntime());
    const fetchFunction = vi.fn() as unknown as typeof globalThis.fetch;
    const generator = new ShortPlanGenerator({
      resolveTextRuntime,
      fetchFunction,
    });

    const prepared = await generator.prepare({
      ...baseInput(),
      gradeLevel: "unspecified",
    });

    expect(prepared).toEqual({
      kind: "failed",
      errorCode: "invalid_generation_input",
    });
    expect(resolveTextRuntime).not.toHaveBeenCalled();
    expect(fetchFunction).not.toHaveBeenCalled();
  });

  it("re-resolves a pinned binding and refuses revision drift before charging", async () => {
    const selector: ShortPlanTextRuntimeSelector = {
      modelProfileId: profileId,
      modelProfileRevision: 7,
      connectionId,
      connectionRevision: 10,
    };
    const resolveTextRuntime = vi.fn(async () => textRuntime());
    const fetchFunction = vi.fn() as unknown as typeof globalThis.fetch;
    const generator = new ShortPlanGenerator({
      resolveTextRuntime,
      fetchFunction,
    });

    const prepared = await generator.preparePinned(baseInput(), {
      expectedSource: "text_model",
      expectedBinding: selector,
    });

    expect(resolveTextRuntime).toHaveBeenCalledWith(selector);
    expect(prepared).toEqual({
      kind: "failed",
      errorCode: "model_configuration_changed",
    });
    expect(fetchFunction).not.toHaveBeenCalled();
  });

  it("never executes a legacy controlled binding", async () => {
    const resolveTextRuntime = vi.fn(async () => textRuntime());
    const fetchFunction = vi.fn() as unknown as typeof globalThis.fetch;
    const generator = new ShortPlanGenerator({
      resolveTextRuntime,
      fetchFunction,
    });

    const prepared = await generator.preparePinned(baseInput(), {
      expectedSource: "controlled_template",
      expectedBinding: null,
    });

    expect(prepared).toEqual({
      kind: "failed",
      errorCode: "model_configuration_changed",
    });
    expect(resolveTextRuntime).not.toHaveBeenCalled();
    expect(fetchFunction).not.toHaveBeenCalled();
  });
});

function baseInput(): ShortPlanGenerationInput {
  return {
    generationMode: "text_model",
    subject: "general",
    difficulty: "starter",
    gradeLevel: "grade_3",
    learningGoal: "了解太阳系行星的基本顺序",
    activityCount: 3,
    durationDays: 7,
  };
}

function modelDraft(
  overrides: Partial<ModelGeneratedTeachingPlanDraft> = {},
): ModelGeneratedTeachingPlanDraft {
  return modelGeneratedTeachingPlanDraftSchema.parse({
    schemaVersion: "generated-teaching-plan-v2",
    compilerVersion: "model-generated-teaching-content-v2",
    title: "太阳系三步学习计划",
    normalizedGoal: "认识太阳系行星的基本顺序和特点。",
    subject: "general",
    difficulty: "starter",
    gradeLevel: "grade_3",
    activityCount: 3,
    durationDays: 7,
    activities: [
      {
        kind: "model_generated_activity",
        key: "planet-order",
        order: 1,
        title: "行星顺序",
        objective: "认识八大行星离太阳由近到远的顺序。",
        knowledgeSource: "model_only",
        activityType: "explain_and_reflect",
        teachingText:
          "八大行星离太阳由近到远依次排列，可以先分成靠近太阳和远离太阳两组来记。",
        reflectionPrompt: "你能说出排在地球前面的两颗行星吗？",
        exampleResponse: "水星和金星。",
        feedbackText: "先对照顺序找到地球，再向前数两颗即可。",
      },
      {
        kind: "model_generated_activity",
        key: "earth-neighbor",
        order: 2,
        title: "地球的邻居",
        objective: "辨认地球轨道两侧相邻的行星。",
        knowledgeSource: "model_only",
        activityType: "multiple_choice",
        questionText: "哪两颗行星在顺序上紧邻地球？",
        choices: [
          { id: "a", text: "金星和火星" },
          { id: "b", text: "木星和土星" },
          { id: "c", text: "水星和海王星" },
        ],
        correctChoiceId: "a",
        answerExplanation: "地球前面是金星，后面是火星。",
        hintText: "先回忆地球在八大行星中的位置。",
      },
      {
        kind: "model_generated_activity",
        key: "outer-planet",
        order: 3,
        title: "最远的行星",
        objective: "记住八大行星中离太阳最远的一颗。",
        knowledgeSource: "model_only",
        activityType: "short_answer",
        questionText: "八大行星中，哪一颗离太阳最远？",
        acceptedAnswers: ["海王星"],
        answerExplanation: "按八大行星的顺序，海王星排在最后。",
        hintText: "想一想八大行星顺序的最后一个名字。",
      },
    ],
    ...overrides,
  });
}

function modelPlanOutput(draft = modelDraft()) {
  return {
    kind: "plan" as const,
    title: draft.title,
    normalizedGoal: draft.normalizedGoal,
    activities: draft.activities,
  };
}

function modelDraftWithEightActivities(): ModelGeneratedTeachingPlanDraft {
  const base = modelDraft();
  const shortAnswer = base.activities[2];
  if (shortAnswer?.activityType !== "short_answer") {
    throw new Error("Unexpected test fixture activity.");
  }
  const additionalActivities = [4, 5, 6, 7, 8].map((order) => ({
    ...shortAnswer,
    key: `planet-review-${order}`,
    order,
    title: `行星复习第${order}步`,
    objective: `完成第${order}个不同的行星顺序复习任务。`,
    questionText: `请说出行星顺序复习中的第${order}个提示词。`,
    acceptedAnswers: [`提示词${order}`],
    answerExplanation: `这一题的参考答案是提示词${order}。`,
    hintText: `回忆带有数字${order}的提示。`,
  }));
  return modelGeneratedTeachingPlanDraftSchema.parse({
    ...base,
    title: "太阳系八步学习计划",
    activityCount: 8,
    activities: [...base.activities, ...additionalActivities],
  });
}

function textRuntime(
  compatibilityPreset: string | null = "dashscope",
  model = "qwen-flash",
): ShortPlanTextRuntime {
  return {
    profile: {
      id: profileId,
      connectionId,
      revision: 7,
      kind: "text",
      status: "enabled",
      verifiedAt: new Date("2026-08-15T08:00:00.000Z"),
      model,
    },
    connection: {
      id: connectionId,
      revision: 11,
      adapter: "openai_chat_completions",
      status: "enabled",
      verifiedAt: new Date("2026-08-15T08:00:00.000Z"),
      endpoint: "https://models.example.test/v1/",
      apiKey: "top-secret-key",
      compatibilityPreset,
    },
  };
}

function completionPayload(
  output: unknown,
  finishReason: "stop" | "length" = "stop",
) {
  return {
    id: "chatcmpl-test",
    object: "chat.completion",
    created: 1_787_000_000,
    model: "qwen-flash",
    system_fingerprint: null,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: JSON.stringify(output) },
        finish_reason: finishReason,
        logprobs: null,
      },
    ],
    usage: { prompt_tokens: 41, completion_tokens: 113, total_tokens: 154 },
  };
}

function generatorForOutput(output: unknown): ShortPlanGenerator {
  return generatorForCompletion(completionPayload(output));
}

function generatorForCompletion(completion: unknown): ShortPlanGenerator {
  return new ShortPlanGenerator({
    resolveTextRuntime: async () => textRuntime(),
    fetchFunction: async () => jsonResponse(completion),
  });
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
