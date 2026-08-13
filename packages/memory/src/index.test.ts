import { describe, expect, it, vi } from "vitest";

import {
  EmbeddedMem0SemanticMemoryStore,
  ManagedEmbeddedMem0SemanticMemoryStoreResolver,
} from "./index.js";

const options = {
  databaseUrl: "postgresql://meet:test@127.0.0.1:5432/meet",
  embedding: {
    mode: "external" as const,
    apiKey: "test",
    model: "text-embedding-3-small",
    dimensions: 1_536,
  },
};

describe("EmbeddedMem0SemanticMemoryStore", () => {
  it("lists the actual Mem0 records within an account and optional character scope", async () => {
    const getAll = vi.fn(async () => ({
      results: [
        {
          id: "external-list-1",
          memory: "用户喜欢围棋。",
          metadata: { meet_memory_id: "local-list-1" },
        },
      ],
    }));
    const store = new EmbeddedMem0SemanticMemoryStore({
      ...options,
      client: {
        getAll,
        search: vi.fn(),
        add: vi.fn(),
        update: vi.fn(),
        delete: vi.fn(),
      } as never,
    });

    await expect(
      store.list({
        userId: "user-list-1",
        characterId: "character-list-1",
        limit: 100,
      }),
    ).resolves.toEqual([
      {
        externalId: "external-list-1",
        localMemoryId: "local-list-1",
        content: "用户喜欢围棋。",
      },
    ]);
    expect(getAll).toHaveBeenCalledWith({
      filters: {
        user_id: "user-list-1",
        agent_id: "character-list-1",
      },
      topK: 100,
    });
  });

  it("scopes semantic search to the account and character", async () => {
    const search = vi.fn(async () => ({
      results: [
        {
          id: "external-1",
          memory: "用户喜欢围棋。",
          score: 0.91,
          metadata: { meet_memory_id: "local-1" },
        },
      ],
    }));
    const store = new EmbeddedMem0SemanticMemoryStore({
      ...options,
      client: {
        search,
        add: vi.fn(),
        update: vi.fn(),
        delete: vi.fn(),
      } as never,
    });

    await expect(
      store.search({
        userId: "user-1",
        characterId: "character-1",
        query: "平时喜欢什么？",
        limit: 8,
        threshold: 0.4,
      }),
    ).resolves.toEqual([
      {
        externalId: "external-1",
        localMemoryId: "local-1",
        content: "用户喜欢围棋。",
        score: 0.91,
      },
    ]);
    expect(search).toHaveBeenCalledWith("平时喜欢什么？", {
      filters: { user_id: "user-1", agent_id: "character-1" },
      topK: 8,
      threshold: 0.4,
    });
  });

  it("stores canonical memories without asking Mem0 to infer new facts", async () => {
    const add = vi.fn(async () => ({ results: [{ id: "external-2" }] }));
    const search = vi.fn(async () => ({ results: [] }));
    const store = new EmbeddedMem0SemanticMemoryStore({
      ...options,
      client: {
        search,
        add,
        update: vi.fn(),
        delete: vi.fn(),
      } as never,
    });
    await expect(
      store.upsert({
        id: "local-2",
        userId: "user-2",
        characterId: "character-2",
        content: "用户周五有考试。",
        sourceConversationId: "conversation-2",
        contentFingerprint: "fingerprint-2",
      }),
    ).resolves.toBe("external-2");
    expect(search).toHaveBeenCalledWith("用户周五有考试。", {
      filters: {
        user_id: "user-2",
        agent_id: "character-2",
        meet_memory_id: "local-2",
      },
      topK: 1,
      threshold: 0,
    });
    expect(add).toHaveBeenCalledWith(
      [{ role: "user", content: "用户周五有考试。" }],
      expect.objectContaining({
        userId: "user-2",
        agentId: "character-2",
        infer: false,
        metadata: expect.objectContaining({ meet_memory_id: "local-2" }),
      }),
    );
  });

  it("updates an existing external memory instead of creating a duplicate", async () => {
    const update = vi.fn(async () => ({ message: "updated" }));
    const add = vi.fn();
    const store = new EmbeddedMem0SemanticMemoryStore({
      ...options,
      client: {
        search: vi.fn(),
        add,
        update,
        delete: vi.fn(),
      } as never,
    });
    await expect(
      store.upsert(
        {
          id: "local-3",
          userId: "user-3",
          characterId: "character-3",
          content: "更新后的记忆。",
          contentFingerprint: "fingerprint-3",
        },
        "external-3",
      ),
    ).resolves.toBe("external-3");
    expect(update).toHaveBeenCalledWith(
      "external-3",
      expect.objectContaining({ text: "更新后的记忆。" }),
    );
    expect(add).not.toHaveBeenCalled();
  });

  it("recreates a missing mapped memory and treats missing deletes as done", async () => {
    const add = vi.fn(async () => ({ results: [{ id: "external-new" }] }));
    const client = {
      search: vi.fn(),
      add,
      update: vi.fn(async () => {
        throw new Error("Memory with ID external-old not found");
      }),
      delete: vi.fn(async () => {
        throw new Error("Memory with ID external-old not found");
      }),
    };
    const store = new EmbeddedMem0SemanticMemoryStore({
      ...options,
      client: client as never,
    });
    const record = {
      id: "local-4",
      userId: "user-4",
      characterId: "character-4",
      content: "需要重建的记忆。",
      contentFingerprint: "fingerprint-4",
    };
    await expect(store.upsert(record, "external-old")).resolves.toBe(
      "external-new",
    );
    await expect(store.delete("external-old")).resolves.toBeUndefined();
    expect(add).toHaveBeenCalledTimes(1);
  });

  it("validates the local collection and embedding configuration", () => {
    expect(
      () =>
        new EmbeddedMem0SemanticMemoryStore({
          ...options,
          collectionName: "invalid-name",
        }),
    ).toThrow("collection name");
    expect(
      () =>
        new EmbeddedMem0SemanticMemoryStore({
          ...options,
          embedding: { ...options.embedding, dimensions: 0 },
        }),
    ).toThrow("out of range");
  });

  it("changes the index revision when the embedding index changes", () => {
    const first = new EmbeddedMem0SemanticMemoryStore(options);
    const same = new EmbeddedMem0SemanticMemoryStore({ ...options });
    const changed = new EmbeddedMem0SemanticMemoryStore({
      ...options,
      collectionName: "meet_mem0_memories_v2",
    });
    expect(first.indexRevision).toBe(same.indexRevision);
    expect(changed.indexRevision).not.toBe(first.indexRevision);
  });

  it("reloads managed credentials without rebuilding an unchanged index", async () => {
    let embedding = {
      mode: "external" as const,
      apiKey: "first-key",
      baseUrl: "https://embedding.example.com/v1",
      model: "text-embedding-3-small",
      dimensions: 1_536,
    };
    const resolver = new ManagedEmbeddedMem0SemanticMemoryStoreResolver({
      databaseUrl: options.databaseUrl,
      loadConfiguration: async () => embedding,
    });
    const first = await resolver.resolve();
    expect(await resolver.resolve()).toBe(first);

    embedding = { ...embedding, apiKey: "rotated-key" };
    const credentialRotated = await resolver.resolve();
    expect(credentialRotated).not.toBe(first);
    expect(credentialRotated?.indexRevision).toBe(first?.indexRevision);

    embedding = { ...embedding, dimensions: 3_072 };
    const indexChanged = await resolver.resolve();
    expect(indexChanged?.indexRevision).not.toBe(first?.indexRevision);
    await resolver.close();
  });
});
