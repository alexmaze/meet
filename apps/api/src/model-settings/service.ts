import {
  createManagedVoice,
  createModelConnection,
  createModelProfile,
  deleteModelProfile,
  DEFAULT_PROVIDER_PROFILE,
  DOUBAO_DUPLEX_PROVIDER_PROFILE_ID,
  findResolvedModelRuntime,
  listModelSettings,
  markModelTestSucceeded,
  modelPurposeBindings,
  setModelPurposeBinding,
  stageModelConnectionUpdate,
  updateModelProfile,
  voiceProfiles,
  type Database,
  type ModelConnectionRecord,
  type ProviderProfileRecord,
} from "@meet/database";
import {
  BUILTIN_EMBEDDING_MODELS,
  modelSettingsResponseSchema,
  type CreateModelConnectionRequest,
  type CreateModelProfileRequest,
  type ModelPurpose,
  type ModelSettingsResponse,
  type UpdateModelConnectionRequest,
  type UpdateModelProfileRequest,
  type UserAccount,
} from "@meet/protocol";
import { testBuiltinEmbeddingModel } from "@meet/memory";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import type { AppConfig } from "../config.js";
import {
  generateDoubaoVoicePreview,
  type DoubaoVoicePreviewError,
} from "../doubao-voice-preview.js";
import type { DoubaoWebSocketFactory } from "../doubao-websocket.js";
import {
  generateQwenVoicePreview,
  type QwenVoicePreviewError,
} from "../qwen-voice-preview.js";
import type { QwenWebSocketFactory } from "../qwen-websocket.js";
import { normalizeQwenRealtimeEndpoint } from "../qwen.js";

type FetchFunction = typeof globalThis.fetch;

export class ModelSettingsServiceError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly statusCode: number,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export class ModelSettingsService {
  constructor(
    private readonly db: Database | null,
    private readonly fetchFunction: FetchFunction = globalThis.fetch,
    private readonly qwenWebSocketFactory?: QwenWebSocketFactory,
    private readonly doubaoWebSocketFactory?: DoubaoWebSocketFactory,
    private readonly enqueueWaiting?: (
      purpose: ModelPurpose,
      modelProfileId: string,
    ) => Promise<void>,
    private readonly explicitLegacyTestConfig?: AppConfig,
    private readonly localEmbeddingCacheDirectory = "./data/embedding-models",
  ) {}

  assertAdmin(actor: UserAccount): void {
    if (actor.accountType !== "admin") {
      throw new ModelSettingsServiceError(
        "MODEL_SETTINGS_FORBIDDEN",
        "只有管理员可以管理模型设置。",
        403,
      );
    }
  }

  async list(actor: UserAccount): Promise<ModelSettingsResponse> {
    this.assertAdmin(actor);
    const snapshot = await listModelSettings(this.requireDb());
    return modelSettingsResponseSchema.parse({
      connections: snapshot.connections.map(toConnection),
      models: snapshot.models.map((profile) => ({
        id: profile.id,
        connectionId: profile.connectionId,
        kind: profile.kind,
        provider:
          profile.provider === "openai"
            ? "openai_compatible"
            : profile.provider,
        model: profile.model,
        displayName: profile.displayName,
        status: profile.status,
        revision: profile.revision,
        verifiedAt: profile.verifiedAt?.toISOString() ?? null,
        embeddingDimensions: profile.embeddingDimensions,
        referenceCount: profile.referenceCount,
        characterReferenceCount: profile.characterReferenceCount,
        purposeReferenceCount: profile.purposeReferenceCount,
        queuedReferenceCount: profile.queuedReferenceCount,
        createdAt: profile.createdAt.toISOString(),
        updatedAt: profile.updatedAt.toISOString(),
      })),
      voices: snapshot.voices.map((voice) => ({
        id: voice.id,
        modelProfileId: voice.providerProfileId,
        providerVoiceId: voice.providerVoiceId,
        displayName: voice.displayName,
        source: voice.source,
        status: voice.status,
        revision: voice.revision,
        verifiedAt: voice.verifiedAt?.toISOString() ?? null,
      })),
      bindings: (
        [
          "realtime_default",
          "conversation_summary",
          "memory_extraction",
          "memory_embedding",
        ] as const
      ).map((purpose) => ({
        purpose,
        modelProfileId:
          snapshot.bindings.find((binding) => binding.purpose === purpose)
            ?.modelProfileId ?? null,
      })),
      work: snapshot.work,
    });
  }

  async createConnection(
    actor: UserAccount,
    input: CreateModelConnectionRequest,
  ) {
    this.assertAdmin(actor);
    if (input.endpoint) assertEndpoint(input.adapter, input.endpoint);
    return toConnection(
      await createModelConnection(this.requireDb(), actor.id, input),
    );
  }

  async updateConnection(
    actor: UserAccount,
    connectionId: string,
    input: UpdateModelConnectionRequest,
  ): Promise<void> {
    this.assertAdmin(actor);
    const snapshot = await listModelSettings(this.requireDb());
    const connection = snapshot.connections.find(
      (candidate) => candidate.id === connectionId,
    );
    if (!connection) throw notFound();
    if (connection.adapter === "builtin_fastembed") {
      if (
        input.endpoint !== undefined ||
        input.apiKey !== undefined ||
        input.compatibilityPreset !== undefined
      ) {
        throw new ModelSettingsServiceError(
          "BUILTIN_EMBEDDING_CONNECTION_READ_ONLY",
          "内置 Embedding 连接没有端点或密钥配置。",
          400,
        );
      }
    } else if (input.endpoint) {
      assertEndpoint(connection.adapter, input.endpoint);
    }
    const result = await stageModelConnectionUpdate(
      this.requireDb(),
      actor.id,
      connectionId,
      input,
    );
    if (result === "not_found") throw notFound();
    if (result === "conflict") throw conflict();
  }

  async createModel(actor: UserAccount, input: CreateModelProfileRequest) {
    this.assertAdmin(actor);
    const profile = await createModelProfile(this.requireDb(), actor.id, input);
    if (!profile) {
      throw new ModelSettingsServiceError(
        "MODEL_ADAPTER_MISMATCH",
        "该连接不能承载这种模型。",
        400,
      );
    }
    if (profile.kind === "realtime_voice") {
      for (const voice of knownVoices(profile.provider)) {
        await createManagedVoice(
          this.requireDb(),
          actor.id,
          profile.id,
          voice,
          "builtin",
        );
      }
    }
    return profile.id;
  }

  async updateModel(
    actor: UserAccount,
    profileId: string,
    input: UpdateModelProfileRequest,
  ): Promise<void> {
    this.assertAdmin(actor);
    const runtime = await findResolvedModelRuntime(
      this.requireDb(),
      profileId,
      { requireEnabled: false },
    );
    if (!runtime) throw notFound();
    if (
      runtime.connection.adapter === "builtin_fastembed" &&
      (input.model !== undefined || input.embeddingDimensions !== undefined)
    ) {
      const model = input.model ?? runtime.profile.model;
      const dimensions =
        input.embeddingDimensions ?? runtime.profile.embeddingDimensions;
      if (!isBuiltinEmbeddingModel(model, dimensions)) {
        throw new ModelSettingsServiceError(
          "BUILTIN_EMBEDDING_MODEL_INVALID",
          "内置模式只能使用应用内支持的模型与固定维度。",
          400,
        );
      }
    }
    const result = await updateModelProfile(
      this.requireDb(),
      actor.id,
      profileId,
      input,
    );
    if (result === "not_found") throw notFound();
    if (result === "conflict") throw conflict();
    if (result === "not_verified") {
      throw new ModelSettingsServiceError(
        "MODEL_NOT_VERIFIED",
        "模型通过连接测试后才能启用。",
        409,
      );
    }
    if (input.status === "enabled" && this.enqueueWaiting) {
      const bindings = await this.requireDb()
        .select({ purpose: modelPurposeBindings.purpose })
        .from(modelPurposeBindings)
        .where(eq(modelPurposeBindings.modelProfileId, profileId));
      for (const binding of bindings) {
        await this.enqueueWaiting(binding.purpose, profileId);
      }
    }
  }

  async deleteModel(actor: UserAccount, profileId: string): Promise<void> {
    this.assertAdmin(actor);
    const result = await deleteModelProfile(
      this.requireDb(),
      actor.id,
      profileId,
    );
    if (result === "not_found") throw notFound();
    if (result === "referenced") {
      throw new ModelSettingsServiceError(
        "MODEL_IN_USE",
        "该模型已经启用或仍被角色、用途或任务引用，只能停用。",
        409,
      );
    }
  }

  async createVoice(
    actor: UserAccount,
    profileId: string,
    input: { providerVoiceId: string; displayName: string },
  ): Promise<string> {
    this.assertAdmin(actor);
    const voice = await createManagedVoice(
      this.requireDb(),
      actor.id,
      profileId,
      input,
    );
    if (!voice) throw notFound();
    return voice.id;
  }

  async testModel(
    actor: UserAccount,
    profileId: string,
    voiceProfileId?: string,
  ): Promise<void> {
    this.assertAdmin(actor);
    const runtime = await findResolvedModelRuntime(
      this.requireDb(),
      profileId,
      {
        requireEnabled: false,
      },
    );
    if (!runtime) throw notFound();
    const connection = candidateConnection(runtime.connection);
    if (
      connection.adapter !== "builtin_fastembed" &&
      (!connection.endpoint || !connection.apiKey)
    ) {
      throw new ModelSettingsServiceError(
        "MODEL_CONNECTION_INCOMPLETE",
        "请先填写连接端点与 API 密钥。",
        409,
      );
    }
    try {
      if (runtime.profile.kind === "text") {
        await testTextModel(connection, runtime.profile, this.fetchFunction);
      } else if (runtime.profile.kind === "embedding") {
        await testEmbeddingModel(
          connection,
          runtime.profile,
          this.fetchFunction,
          this.localEmbeddingCacheDirectory,
        );
      } else {
        if (!voiceProfileId) {
          throw new ModelSettingsServiceError(
            "VOICE_REQUIRED",
            "实时模型测试需要选择一个测试音色。",
            400,
          );
        }
        const [voice] = await this.requireDb()
          .select()
          .from(voiceProfiles)
          .where(
            and(
              eq(voiceProfiles.id, voiceProfileId),
              eq(voiceProfiles.providerProfileId, profileId),
            ),
          )
          .limit(1);
        if (!voice) throw notFound();
        await this.testRealtime(
          runtime.profile,
          connection,
          voice.providerVoiceId,
        );
      }
    } catch (error) {
      if (error instanceof ModelSettingsServiceError) throw error;
      throw new ModelSettingsServiceError(
        "MODEL_TEST_FAILED",
        "模型连接测试失败，请检查端点、密钥、模型 ID、向量维度或音色权限。",
        409,
        { cause: sanitizeUpstreamError(error) },
      );
    }
    await markModelTestSucceeded(
      this.requireDb(),
      actor.id,
      profileId,
      voiceProfileId,
    );
    if (runtime.profile.kind === "embedding" && this.enqueueWaiting) {
      const [binding] = await this.requireDb()
        .select({ purpose: modelPurposeBindings.purpose })
        .from(modelPurposeBindings)
        .where(
          and(
            eq(modelPurposeBindings.purpose, "memory_embedding"),
            eq(modelPurposeBindings.modelProfileId, profileId),
          ),
        )
        .limit(1);
      if (binding) {
        await this.enqueueWaiting("memory_embedding", profileId);
      }
    }
  }

  async bind(
    actor: UserAccount,
    purpose: ModelPurpose,
    modelProfileId: string,
  ): Promise<void> {
    this.assertAdmin(actor);
    const result = await setModelPurposeBinding(
      this.requireDb(),
      actor.id,
      purpose,
      modelProfileId,
    );
    if (result === "invalid_model") {
      throw new ModelSettingsServiceError(
        "MODEL_BINDING_INVALID",
        "用途只能绑定对应类型且已经启用的模型。",
        409,
      );
    }
    await this.enqueueWaiting?.(purpose, modelProfileId);
  }

  async resolveRuntime(profileId: string, requireEnabled = true) {
    if (!this.db) {
      const legacy = this.legacyTestRuntime(profileId);
      if (legacy) return legacy;
    }
    const runtime = await findResolvedModelRuntime(
      this.requireDb(),
      profileId,
      {
        requireEnabled,
      },
    );
    if (!runtime) throw notFound();
    const connection = candidateConnection(runtime.connection);
    if (!connection.endpoint || !connection.apiKey) {
      throw new ModelSettingsServiceError(
        "MODEL_CONNECTION_INCOMPLETE",
        "模型连接尚未配置完成。",
        409,
      );
    }
    return { profile: runtime.profile, connection };
  }

  async providerAvailability() {
    if (!this.db && this.explicitLegacyTestConfig) {
      const qwen = this.explicitLegacyTestConfig.qwen;
      const doubao = this.explicitLegacyTestConfig.doubao;
      return [
        {
          provider: "qwen" as const,
          enabled: qwen.enabled,
          configured: Boolean(qwen.enabled && qwen.apiKey && qwen.endpoint),
        },
        {
          provider: "doubao" as const,
          enabled: Boolean(doubao?.enabled),
          configured: Boolean(doubao?.enabled && doubao.apiKey),
        },
      ];
    }
    const snapshot = await listModelSettings(this.requireDb());
    return (["qwen", "doubao"] as const).map((provider) => {
      const profiles = snapshot.models.filter(
        (profile) =>
          profile.provider === provider && profile.kind === "realtime_voice",
      );
      return {
        provider,
        enabled: profiles.some((profile) => profile.status === "enabled"),
        configured: profiles.some(
          (profile) => profile.status === "enabled" && profile.connectionId,
        ),
      };
    });
  }

  private async testRealtime(
    profile: ProviderProfileRecord,
    connection: ActiveConnection,
    voice: string,
  ): Promise<void> {
    if (connection.adapter === "qwen_realtime") {
      await generateQwenVoicePreview({
        config: {
          enabled: true,
          apiKey: connection.apiKey,
          endpoint: connection.endpoint,
          region: "cn-beijing",
          model: profile.model,
          voice,
          instructions: "请用自然中文简短说出固定测试句。",
          requestTimeoutMs: 15_000,
        } as AppConfig["qwen"],
        model: profile.model as AppConfig["qwen"]["model"],
        voice,
        webSocketFactory: this.qwenWebSocketFactory,
      });
      return;
    }
    if (connection.adapter === "doubao_realtime") {
      await generateDoubaoVoicePreview({
        config: {
          enabled: true,
          apiKey: connection.apiKey,
          model: profile.model,
          requestTimeoutMs: 15_000,
        } as NonNullable<AppConfig["doubao"]>,
        model: profile.model as NonNullable<AppConfig["doubao"]>["model"],
        voice,
        webSocketFactory: this.doubaoWebSocketFactory,
      });
      return;
    }
    throw new ModelSettingsServiceError(
      "MODEL_ADAPTER_MISMATCH",
      "该连接不是实时语音连接。",
      400,
    );
  }

  private legacyTestRuntime(profileId: string) {
    const config = this.explicitLegacyTestConfig;
    if (!config) return null;
    const doubao = config.doubao;
    if (
      profileId === DOUBAO_DUPLEX_PROVIDER_PROFILE_ID &&
      doubao?.enabled &&
      doubao.apiKey
    ) {
      return {
        profile: { id: profileId } as ProviderProfileRecord,
        connection: {
          adapter: "doubao_realtime" as const,
          endpoint:
            "wss://openspeech.bytedance.com/api/v3/duplex/realtime/dialogue",
          apiKey: doubao.apiKey,
          compatibilityPreset: null,
        },
      };
    }
    if (
      profileId === DEFAULT_PROVIDER_PROFILE.id &&
      config.qwen.enabled &&
      config.qwen.apiKey &&
      config.qwen.endpoint
    ) {
      return {
        profile: { id: profileId } as ProviderProfileRecord,
        connection: {
          adapter: "qwen_realtime" as const,
          endpoint: config.qwen.endpoint,
          apiKey: config.qwen.apiKey,
          compatibilityPreset: null,
        },
      };
    }
    return null;
  }

  private requireDb(): Database {
    if (!this.db) {
      throw new ModelSettingsServiceError(
        "MODEL_SETTINGS_UNAVAILABLE",
        "模型设置服务尚未连接数据库。",
        503,
      );
    }
    return this.db;
  }
}

type ActiveConnection = {
  adapter: ModelConnectionRecord["adapter"];
  endpoint: string;
  apiKey: string;
  compatibilityPreset: string | null;
};

function candidateConnection(
  connection: ModelConnectionRecord,
): ActiveConnection {
  return {
    adapter: connection.adapter,
    endpoint: connection.pendingEndpoint ?? connection.endpoint ?? "",
    apiKey: connection.pendingApiKey ?? connection.apiKey ?? "",
    compatibilityPreset:
      connection.pendingCompatibilityPreset ?? connection.compatibilityPreset,
  };
}

function toConnection(record: ModelConnectionRecord) {
  return {
    id: record.id,
    adapter: record.adapter,
    displayName: record.displayName,
    endpoint: record.pendingEndpoint ?? record.endpoint,
    compatibilityPreset:
      record.adapter === "openai_chat_completions"
        ? ((record.pendingCompatibilityPreset ??
            record.compatibilityPreset ??
            "standard") as "standard" | "dashscope")
        : null,
    status: record.status,
    hasCredential: Boolean(record.apiKey || record.pendingApiKey),
    hasPendingChanges: Boolean(
      record.pendingEndpoint ||
      record.pendingApiKey ||
      record.pendingCompatibilityPreset,
    ),
    revision: record.revision,
    verifiedAt: record.verifiedAt?.toISOString() ?? null,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

function assertEndpoint(
  adapter: CreateModelConnectionRequest["adapter"],
  value: string,
): void {
  const url = new URL(value);
  if (adapter === "qwen_realtime") {
    try {
      normalizeQwenRealtimeEndpoint(value);
    } catch {
      throw new ModelSettingsServiceError(
        "MODEL_ENDPOINT_INVALID",
        "千问 Endpoint 必须是 HTTPS Origin 或合法主机名，不能包含路径或查询参数。",
        400,
      );
    }
    return;
  }
  if (
    adapter === "openai_chat_completions" ||
    adapter === "openai_embeddings"
  ) {
    if (url.protocol !== "https:") {
      throw new ModelSettingsServiceError(
        "MODEL_ENDPOINT_INVALID",
        "OpenAI-compatible Base URL 必须使用 HTTPS。",
        400,
      );
    }
    return;
  }
  if (url.protocol !== "https:" && url.protocol !== "wss:") {
    throw new ModelSettingsServiceError(
      "MODEL_ENDPOINT_INVALID",
      "实时模型端点必须使用 HTTPS 或 WSS。",
      400,
    );
  }
}

async function testTextModel(
  connection: ActiveConnection,
  profile: ProviderProfileRecord,
  fetchFunction: FetchFunction,
): Promise<void> {
  if (connection.adapter !== "openai_chat_completions") {
    throw new ModelSettingsServiceError(
      "MODEL_ADAPTER_MISMATCH",
      "该连接不是文本模型连接。",
      400,
    );
  }
  const response = await fetchFunction(
    `${connection.endpoint.replace(/\/$/, "")}/chat/completions`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${connection.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: profile.model,
        messages: [
          { role: "system", content: "请只按 JSON 格式返回测试结果。" },
          { role: "user", content: '返回 {"ok":true}。' },
        ],
        response_format: { type: "json_object" },
        temperature: 0,
        ...(connection.compatibilityPreset === "dashscope"
          ? { enable_thinking: false }
          : {}),
      }),
      signal: AbortSignal.timeout(15_000),
    },
  );
  if (!response.ok)
    throw new Error(`Text model test returned ${response.status}.`);
  const payload = z
    .object({
      choices: z
        .array(z.object({ message: z.object({ content: z.string() }) }))
        .min(1),
    })
    .parse(await response.json());
  const content = payload.choices[0]?.message.content;
  const parsed = z
    .object({ ok: z.literal(true) })
    .parse(JSON.parse(content ?? ""));
  if (!parsed.ok) throw new Error("Text model test JSON was invalid.");
}

async function testEmbeddingModel(
  connection: ActiveConnection,
  profile: ProviderProfileRecord,
  fetchFunction: FetchFunction,
  localEmbeddingCacheDirectory: string,
): Promise<void> {
  const dimensions = profile.embeddingDimensions;
  if (!dimensions) {
    throw new ModelSettingsServiceError(
      "EMBEDDING_DIMENSIONS_REQUIRED",
      "Embedding 模型必须配置向量维度。",
      400,
    );
  }
  if (connection.adapter === "builtin_fastembed") {
    if (!isBuiltinEmbeddingModel(profile.model, dimensions)) {
      throw new ModelSettingsServiceError(
        "BUILTIN_EMBEDDING_MODEL_INVALID",
        "内置 Embedding 模型或维度不受支持。",
        400,
      );
    }
    await testBuiltinEmbeddingModel({
      model: profile.model,
      dimensions,
      cacheDirectory: localEmbeddingCacheDirectory,
    });
    return;
  }
  if (connection.adapter !== "openai_embeddings") {
    throw new ModelSettingsServiceError(
      "MODEL_ADAPTER_MISMATCH",
      "该连接不是 Embedding 连接。",
      400,
    );
  }
  const response = await fetchFunction(
    `${connection.endpoint.replace(/\/$/, "")}/embeddings`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${connection.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: profile.model,
        input: "Meet embedding configuration test",
        encoding_format: "float",
        dimensions,
      }),
      signal: AbortSignal.timeout(15_000),
    },
  );
  if (!response.ok) {
    throw new Error(`Embedding model test returned ${response.status}.`);
  }
  const payload = z
    .object({
      data: z
        .array(
          z.object({
            embedding: z.array(z.number()).min(1),
          }),
        )
        .min(1),
    })
    .parse(await response.json());
  if (payload.data[0]?.embedding.length !== dimensions) {
    throw new Error("Embedding model returned an unexpected dimension.");
  }
}

function isBuiltinEmbeddingModel(
  model: string,
  dimensions: number | null,
): boolean {
  return BUILTIN_EMBEDDING_MODELS.some(
    (candidate) =>
      candidate.id === model && candidate.dimensions === dimensions,
  );
}

function knownVoices(
  provider: ProviderProfileRecord["provider"],
): Array<{ providerVoiceId: string; displayName: string }> {
  if (provider === "qwen") {
    return [
      ["longanqian", "芊悦"],
      ["longanlingxin", "灵心"],
      ["longanlingxi", "灵犀"],
      ["longanxiaoxin", "小新"],
      ["longanlufeng", "陆风"],
    ].map(([providerVoiceId, displayName]) => ({
      providerVoiceId: providerVoiceId!,
      displayName: displayName!,
    }));
  }
  if (provider === "doubao") {
    return [
      ["zh_female_vv_jupiter_bigtts", "Vivi"],
      ["zh_female_xiaohe_jupiter_bigtts", "小何"],
      ["zh_male_yunzhou_jupiter_bigtts", "云舟"],
      ["zh_male_xiaotian_jupiter_bigtts", "小天"],
    ].map(([providerVoiceId, displayName]) => ({
      providerVoiceId: providerVoiceId!,
      displayName: displayName!,
    }));
  }
  return [];
}

function notFound() {
  return new ModelSettingsServiceError(
    "MODEL_SETTINGS_NOT_FOUND",
    "没有找到对应的模型配置。",
    404,
  );
}

function conflict() {
  return new ModelSettingsServiceError(
    "MODEL_SETTINGS_CONFLICT",
    "模型设置已经更新，请刷新后重试。",
    409,
  );
}

function sanitizeUpstreamError(error: unknown): Error {
  if (error instanceof Error) return new Error(error.name);
  return new Error("Upstream model test failed");
}

export type ModelTestError = QwenVoicePreviewError | DoubaoVoicePreviewError;
