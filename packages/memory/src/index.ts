import type {
  Memory as OssMemory,
  MemoryItem as Mem0Memory,
  Message,
} from "mem0ai/oss";
import type { FlagEmbedding as LocalEmbeddingModel } from "fastembed";
import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";

export type SemanticMemoryHit = {
  externalId: string;
  localMemoryId?: string;
  content: string;
  score?: number;
};

export type SemanticMemoryRecord = {
  id: string;
  userId: string;
  characterId: string;
  content: string;
  sourceConversationId?: string | null;
  contentFingerprint: string;
};

export interface SemanticMemoryStore {
  readonly indexRevision?: string;
  list?(input: {
    userId: string;
    characterId?: string;
    limit: number;
  }): Promise<SemanticMemoryHit[]>;
  search(input: {
    userId: string;
    characterId: string;
    query: string;
    limit: number;
    threshold?: number;
  }): Promise<SemanticMemoryHit[]>;
  upsert(
    memory: SemanticMemoryRecord,
    externalId?: string | null,
  ): Promise<string>;
  delete(externalId: string): Promise<void>;
  close?(): Promise<void>;
}

export interface SemanticMemoryStoreResolver {
  resolve(): Promise<SemanticMemoryStore | undefined>;
  close?(): Promise<void>;
}

export type SemanticMemoryStoreSource =
  SemanticMemoryStore | SemanticMemoryStoreResolver;

export async function resolveSemanticMemoryStore(
  source?: SemanticMemoryStoreSource,
): Promise<SemanticMemoryStore | undefined> {
  return source && "resolve" in source ? source.resolve() : source;
}

type Mem0OssClient = Pick<
  OssMemory,
  "add" | "getAll" | "search" | "update" | "delete"
>;

type MemoryEmbeddingAction = "add" | "update" | "search";

type Mem0Embedder = {
  embed(text: string, memoryAction?: MemoryEmbeddingAction): Promise<number[]>;
  embedBatch(
    texts: string[],
    memoryAction?: MemoryEmbeddingAction,
  ): Promise<number[][]>;
};

export type EmbeddedMem0SemanticMemoryStoreOptions = {
  databaseUrl: string;
  embedding: ManagedEmbeddingConfiguration;
  localEmbeddingCacheDirectory?: string;
  collectionName?: string;
  requestTimeoutMs?: number;
  client?: Mem0OssClient;
};

const LOCAL_MEMORY_ID_METADATA_KEY = "meet_memory_id";
export const DEFAULT_MEM0_COLLECTION_NAME = "meet_mem0_memories";

export type ManagedEmbeddingConfiguration =
  | {
      mode: "external";
      apiKey: string;
      baseUrl: string;
      model: string;
      dimensions: number;
    }
  | {
      mode: "builtin";
      model: string;
      dimensions: number;
    };

export class ManagedEmbeddedMem0SemanticMemoryStoreResolver implements SemanticMemoryStoreResolver {
  private current?: EmbeddedMem0SemanticMemoryStore;
  private currentConfigurationFingerprint?: string;

  constructor(
    private readonly options: {
      databaseUrl: string;
      loadConfiguration: () => Promise<
        ManagedEmbeddingConfiguration | undefined
      >;
      requestTimeoutMs?: number;
      builtinRequestTimeoutMs?: number;
      localEmbeddingCacheDirectory?: string;
    },
  ) {}

  async resolve(): Promise<SemanticMemoryStore | undefined> {
    const embedding = await this.options.loadConfiguration();
    if (!embedding) {
      await this.close();
      return undefined;
    }
    const configurationFingerprint = createHash("sha256")
      .update(JSON.stringify(embedding))
      .digest("hex");
    if (
      this.current &&
      configurationFingerprint === this.currentConfigurationFingerprint
    ) {
      return this.current;
    }
    const candidate = new EmbeddedMem0SemanticMemoryStore({
      databaseUrl: this.options.databaseUrl,
      embedding,
      collectionName: collectionNameForEmbedding(embedding),
      requestTimeoutMs:
        embedding.mode === "builtin"
          ? (this.options.builtinRequestTimeoutMs ?? 30_000)
          : this.options.requestTimeoutMs,
      localEmbeddingCacheDirectory: this.options.localEmbeddingCacheDirectory,
    });
    const previous = this.current;
    this.current = candidate;
    this.currentConfigurationFingerprint = configurationFingerprint;
    await previous?.close();
    return candidate;
  }

  async close(): Promise<void> {
    await this.current?.close();
    this.current = undefined;
    this.currentConfigurationFingerprint = undefined;
  }
}

export function collectionNameForEmbedding(
  embedding: ManagedEmbeddingConfiguration,
): string {
  const suffix = createHash("sha256")
    .update(
      JSON.stringify({
        mode: embedding.mode,
        baseUrl:
          embedding.mode === "external"
            ? normalizeUrl(embedding.baseUrl)
            : undefined,
        model: embedding.model,
        dimensions: embedding.dimensions,
      }),
    )
    .digest("hex")
    .slice(0, 16);
  return `${DEFAULT_MEM0_COLLECTION_NAME}_${suffix}`;
}

export class EmbeddedMem0SemanticMemoryStore implements SemanticMemoryStore {
  readonly indexRevision: string;
  private client: Mem0OssClient | undefined;
  private readonly requestTimeoutMs: number;

  constructor(
    private readonly options: EmbeddedMem0SemanticMemoryStoreOptions,
  ) {
    validateOptions(options);
    this.indexRevision = fingerprintIndexConfiguration(options);
    this.client = options.client;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 2_000;
  }

  async search(input: {
    userId: string;
    characterId: string;
    query: string;
    limit: number;
    threshold?: number;
  }): Promise<SemanticMemoryHit[]> {
    const response = await this.withTimeout(
      (await this.getClient()).search(input.query, {
        filters: entityFilters(input.userId, input.characterId),
        topK: input.limit,
        threshold: input.threshold,
      }),
      "search",
    );
    return response.results.flatMap((memory) => {
      const hit = toSemanticMemoryHit(memory);
      return hit ? [hit] : [];
    });
  }

  async list(input: {
    userId: string;
    characterId?: string;
    limit: number;
  }): Promise<SemanticMemoryHit[]> {
    const response = await this.withTimeout(
      (await this.getClient()).getAll({
        filters: entityFilters(input.userId, input.characterId),
        topK: input.limit,
      }),
      "list",
    );
    return response.results.flatMap((memory) => {
      const hit = toSemanticMemoryHit(memory);
      return hit ? [hit] : [];
    });
  }

  async upsert(
    memory: SemanticMemoryRecord,
    externalId?: string | null,
  ): Promise<string> {
    const metadata = memoryMetadata(memory);
    const client = await this.getClient();
    const resolvedExternalId =
      externalId ?? (await this.findExternalId(client, memory));
    if (resolvedExternalId) {
      try {
        await this.withTimeout(
          client.update(resolvedExternalId, {
            text: memory.content,
            metadata,
          }),
          "update",
        );
        return resolvedExternalId;
      } catch (error) {
        if (!isMemoryNotFound(error)) throw error;
      }
    }

    const messages: Message[] = [{ role: "user", content: memory.content }];
    const created = await this.withTimeout(
      client.add(messages, {
        userId: memory.userId,
        agentId: memory.characterId,
        infer: false,
        metadata,
      }),
      "add",
    );
    const createdMemory = created.results[0];
    if (!createdMemory?.id) {
      throw new Error("Embedded Mem0 did not return a memory id.");
    }
    return createdMemory.id;
  }

  async delete(externalId: string): Promise<void> {
    try {
      await this.withTimeout(
        (await this.getClient()).delete(externalId),
        "delete",
      );
    } catch (error) {
      if (!isMemoryNotFound(error)) throw error;
    }
  }

  async close(): Promise<void> {
    const internal = this.client as
      | {
          _initPromise?: Promise<unknown>;
          vectorStore?: { client?: { end?: () => Promise<void> } };
          _entityStore?: { client?: { end?: () => Promise<void> } };
        }
      | undefined;
    await internal?._initPromise?.catch(() => undefined);
    const connections = [
      internal?.vectorStore?.client,
      internal?._entityStore?.client,
    ].filter(
      (client): client is { end: () => Promise<void> } =>
        typeof client?.end === "function",
    );
    await Promise.allSettled(connections.map((client) => client.end()));
    this.client = undefined;
  }

  private async findExternalId(
    client: Mem0OssClient,
    memory: SemanticMemoryRecord,
  ): Promise<string | undefined> {
    const existing = await this.withTimeout(
      client.search(memory.content, {
        filters: {
          ...entityFilters(memory.userId, memory.characterId),
          [LOCAL_MEMORY_ID_METADATA_KEY]: memory.id,
        },
        topK: 1,
        threshold: 0,
      }),
      "lookup",
    );
    return existing.results[0]?.id;
  }

  private async getClient(): Promise<Mem0OssClient> {
    if (!this.client) {
      const { Memory } = await import("mem0ai/oss");
      const embedding = this.options.embedding;
      const embedder =
        embedding.mode === "builtin"
          ? {
              provider: "langchain",
              config: {
                model: createLocalEmbeddingAdapter(
                  embedding.model,
                  this.options.localEmbeddingCacheDirectory,
                ),
              },
            }
          : {
              provider: "openai",
              config: {
                apiKey: embedding.apiKey,
                model: embedding.model,
                baseURL: normalizeUrl(embedding.baseUrl),
                embeddingDims: embedding.dimensions,
              },
            };
      const client = new Memory({
        version: "v1.1",
        disableHistory: true,
        embedder,
        vectorStore: {
          provider: "pgvector",
          config: {
            connectionString: this.options.databaseUrl,
            collectionName:
              this.options.collectionName ?? DEFAULT_MEM0_COLLECTION_NAME,
            dimension: embedding.dimensions,
            embeddingModelDims: embedding.dimensions,
            diskann: false,
            hnsw: false,
          },
        },
        // infer:false means this client never invokes the LLM. The OSS SDK still
        // constructs one eagerly, so provide the same compatible connection.
        llm: {
          provider: "openai",
          config: {
            apiKey: embedding.mode === "external" ? embedding.apiKey : "unused",
            model: "meet-mem0-inference-disabled",
            baseURL:
              embedding.mode === "external"
                ? normalizeUrl(embedding.baseUrl)
                : "http://127.0.0.1",
          },
        },
      });
      if (embedding.mode === "builtin") {
        // Mem0's public configuration only accepts registered provider names.
        // Replace the eagerly created LangChain wrapper with the same in-process
        // adapter so Mem0 can pass add/update/search intent through to FastEmbed.
        // This is required by E5 and the pre-v1.5 BGE models, whose query and
        // passage prefixes must differ.
        (client as unknown as { embedder: Mem0Embedder }).embedder =
          createLocalMem0Embedder(
            embedding.model,
            this.options.localEmbeddingCacheDirectory,
          );
      }
      this.client = client;
    }
    return this.client;
  }

  private async withTimeout<T>(promise: Promise<T>, operation: string) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error(`Embedded Mem0 ${operation} timed out.`)),
            this.requestTimeoutMs,
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

function entityFilters(userId: string, characterId?: string) {
  return {
    user_id: userId,
    ...(characterId ? { agent_id: characterId } : {}),
  };
}

function memoryMetadata(memory: SemanticMemoryRecord) {
  return {
    [LOCAL_MEMORY_ID_METADATA_KEY]: memory.id,
    meet_content_fingerprint: memory.contentFingerprint,
    meet_source_conversation_id: memory.sourceConversationId ?? null,
  };
}

function toSemanticMemoryHit(memory: Mem0Memory): SemanticMemoryHit | null {
  if (!memory.id || !memory.memory?.trim()) return null;
  return {
    externalId: memory.id,
    localMemoryId: readLocalMemoryId(memory.metadata),
    content: memory.memory.trim(),
    score: typeof memory.score === "number" ? memory.score : undefined,
  };
}

function readLocalMemoryId(metadata: unknown): string | undefined {
  if (!metadata || typeof metadata !== "object") return undefined;
  const value = (metadata as Record<string, unknown>)[
    LOCAL_MEMORY_ID_METADATA_KEY
  ];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function normalizeUrl(url: string | undefined): string | undefined {
  const normalized = url?.trim().replace(/\/+$/, "");
  return normalized || undefined;
}

function isMemoryNotFound(error: unknown): boolean {
  return (
    error instanceof Error &&
    (/Memory with ID .* not found/i.test(error.message) ||
      error.name === "MemoryNotFoundError")
  );
}

function validateOptions(options: EmbeddedMem0SemanticMemoryStoreOptions) {
  if (!options.databaseUrl.trim()) {
    throw new Error("Embedded Mem0 requires a PostgreSQL connection string.");
  }
  if (
    options.embedding.mode === "external" &&
    !options.embedding.apiKey.trim()
  ) {
    throw new Error("Embedded Mem0 requires an embedding API key.");
  }
  if (!options.embedding.model.trim()) {
    throw new Error("Embedded Mem0 requires an embedding model.");
  }
  if (!Number.isInteger(options.embedding.dimensions)) {
    throw new Error("Embedded Mem0 embedding dimensions must be an integer.");
  }
  if (
    options.embedding.dimensions < 1 ||
    options.embedding.dimensions > 4_096
  ) {
    throw new Error("Embedded Mem0 embedding dimensions are out of range.");
  }
  const collectionName = options.collectionName ?? DEFAULT_MEM0_COLLECTION_NAME;
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(collectionName)) {
    throw new Error("Embedded Mem0 collection name is invalid.");
  }
}

function fingerprintIndexConfiguration(
  options: EmbeddedMem0SemanticMemoryStoreOptions,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        provider: "mem0ai-oss-pgvector-v1",
        collectionName: options.collectionName ?? DEFAULT_MEM0_COLLECTION_NAME,
        embeddingMode: options.embedding.mode,
        embeddingBaseUrl:
          options.embedding.mode === "external"
            ? (normalizeUrl(options.embedding.baseUrl) ?? "")
            : "",
        embeddingModel: options.embedding.model.trim(),
        embeddingDimensions: options.embedding.dimensions,
      }),
    )
    .digest("hex");
}

const localEmbeddingModels = new Map<string, Promise<LocalEmbeddingModel>>();

function createLocalEmbeddingAdapter(model: string, cacheDirectory?: string) {
  const embedder = createLocalMem0Embedder(model, cacheDirectory);
  return {
    embedQuery: (text: string) => embedder.embed(text, "search"),
    embedDocuments: (texts: string[]) => embedder.embedBatch(texts, "add"),
  };
}

function createLocalMem0Embedder(
  model: string,
  cacheDirectory?: string,
): Mem0Embedder {
  return {
    embed: async (text, memoryAction) =>
      (await embedLocally(model, [text], cacheDirectory, memoryAction))[0] ??
      [],
    embedBatch: (texts, memoryAction) =>
      embedLocally(model, texts, cacheDirectory, memoryAction),
  };
}

export async function testBuiltinEmbeddingModel(input: {
  model: string;
  dimensions: number;
  cacheDirectory?: string;
}): Promise<void> {
  const [embedding] = await embedLocally(
    input.model,
    ["Meet 内置 Embedding 配置测试"],
    input.cacheDirectory,
  );
  if (embedding?.length !== input.dimensions) {
    throw new Error(
      "Builtin embedding model returned an unexpected dimension.",
    );
  }
}

async function embedLocally(
  model: string,
  texts: string[],
  cacheDirectory?: string,
  memoryAction?: MemoryEmbeddingAction,
): Promise<number[][]> {
  const cacheKey = `${cacheDirectory ?? "local_cache"}:${model}`;
  let modelPromise = localEmbeddingModels.get(cacheKey);
  if (!modelPromise) {
    modelPromise = Promise.all([
      import("fastembed"),
      cacheDirectory
        ? mkdir(cacheDirectory, { recursive: true })
        : Promise.resolve(),
    ]).then(([{ FlagEmbedding }]) =>
      FlagEmbedding.init({
        model: model as never,
        cacheDir: cacheDirectory,
        showDownloadProgress: false,
      }),
    );
    localEmbeddingModels.set(cacheKey, modelPromise);
    modelPromise.catch(() => localEmbeddingModels.delete(cacheKey));
  }
  const instance = await modelPromise;
  if (memoryAction === "search") {
    return Promise.all(texts.map((text) => instance.queryEmbed(text)));
  }
  const embeddings: number[][] = [];
  const batches =
    memoryAction !== undefined
      ? instance.passageEmbed(texts)
      : instance.embed(texts);
  for await (const batch of batches) embeddings.push(...batch);
  return embeddings;
}
