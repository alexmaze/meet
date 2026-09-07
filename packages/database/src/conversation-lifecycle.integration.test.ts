import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { ConversationWriter } from "@meet/protocol";
import { createDatabaseClient, type DatabaseClient } from "./client.js";
import {
  appendConversationMessages,
  completeConversation,
  createConversation,
  deleteOwnedConversation,
  loadConversationRealtimeContext,
} from "./conversation-operations.js";
import {
  attachConversationConnection,
  cleanupExpiredEmptyConversations,
  CONVERSATION_LEASE_MS,
  detachConversationConnection,
  heartbeatConversationConnection,
  heartbeatConversationWriter,
  listConversationOverviewIds,
  prepareConversation,
  readConversationLifecycle,
} from "./conversation-lifecycle-operations.js";
import {
  characterFavorites,
  characters,
  conversationMessages,
  conversations,
  userAccounts,
} from "./schema.js";

const testUrl = process.env.DATABASE_CONTINUITY_TEST_URL;
// Never fall back to DATABASE_URL or the application's .env deployment.
if (testUrl) {
  const url = new URL(testUrl);
  if (
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
    !url.pathname.endsWith("_test")
  ) {
    throw new Error(
      "DATABASE_CONTINUITY_TEST_URL must target an explicit local *_test database.",
    );
  }
}

describe.skipIf(!testUrl)(
  "conversation lifecycle in isolated PostgreSQL",
  () => {
    let client: DatabaseClient;
    const userId = randomUUID();
    const anotherUserId = randomUUID();
    let characterId: string;
    let conversationId: string;
    let now: Date;
    const conversationIds: string[] = [];
    beforeAll(async () => {
      client = createDatabaseClient({
        connectionString: testUrl!,
        pool: { max: 8 },
      });
      await client.db.insert(userAccounts).values(
        [userId, anotherUserId].map((id) => ({
          id,
          username: `test-${id}`,
          usernameCanonical: `test-${id}`,
          displayName: "隔离验收成员",
          accountType: "adult" as const,
          guardianHistoryAccess: null,
        })),
      );
      const [preset] = await client.db.select().from(characters).limit(1);
      if (!preset)
        throw new Error(
          "Migrate the isolated database before running this test.",
        );
      characterId = randomUUID();
      await client.db.insert(characters).values({
        ...preset,
        id: characterId,
        systemKey: null,
        systemVersion: null,
        ownerUserId: userId,
        visibility: "family",
        name: "隔离通话测试角色",
      });
    });
    beforeEach(async () => {
      now = new Date();
      conversationId = randomUUID();
      conversationIds.push(conversationId);
      await client.db
        .update(characters)
        .set({ visibility: "family", deletedAt: null })
        .where(eq(characters.id, characterId));
      await createConversation(client.db, {
        id: conversationId,
        actorUserId: userId,
        characterId,
        mode: "normal",
        startedAt: now,
      });
    });
    afterAll(async () => {
      if (!client) return;
      if (conversationIds.length)
        await client.db
          .delete(conversations)
          .where(inArray(conversations.id, conversationIds));
      if (characterId)
        await client.db
          .delete(characters)
          .where(eq(characters.id, characterId));
      await client.db
        .delete(userAccounts)
        .where(inArray(userAccounts.id, [userId, anotherUserId]));
      await client.close();
    });
    const time = (offset: number) => new Date(now.getTime() + offset);
    async function claim(
      clientId = randomUUID(),
      intent: "connect" | "finish" = "connect",
      at = now,
      requestId = randomUUID(),
    ) {
      const result = await prepareConversation(client.db, {
        actorUserId: userId,
        conversationId,
        clientId,
        intent,
        requestId,
        now: at,
      });
      if (result.kind !== "prepared")
        throw new Error(`claim failed: ${result.kind}`);
      return result;
    }
    const message = (sequence: number) => ({
      id: randomUUID(),
      sequence,
      role: "user" as const,
      status: "completed" as const,
      text: `第 ${sequence} 条确定文字`,
      providerEventId: null,
      createdAt: time(sequence * 100).toISOString(),
    });
    const append = (
      writer: ConversationWriter,
      messages: ReturnType<typeof message>[],
      at = now,
    ) =>
      appendConversationMessages(client.db, {
        actorUserId: userId,
        conversationId,
        writer,
        messages,
        updatedAt: at,
      });
    const finish = (
      writer: ConversationWriter,
      requestId: string,
      lastSequence: number,
      at = now,
      discardMissing = false,
      onCompleted?: Parameters<typeof completeConversation>[1]["onCompleted"],
    ) =>
      completeConversation(client.db, {
        actorUserId: userId,
        conversationId,
        writer,
        requestId,
        lastSequence,
        discardMissing,
        endedAt: at,
        onCompleted,
      });

    it("serializes simultaneous claims and allows only one socket even for the same writer", async () => {
      const clients = [randomUUID(), randomUUID()];
      const outcomes = await Promise.all(
        clients.map((clientId) =>
          prepareConversation(client.db, {
            actorUserId: userId,
            conversationId,
            clientId,
            intent: "connect",
            requestId: randomUUID(),
            now,
          }),
        ),
      );
      expect(outcomes.map((value) => value.kind).sort()).toEqual([
        "in_use",
        "prepared",
      ]);
      const winner = outcomes.find((value) => value.kind === "prepared");
      if (!winner || winner.kind !== "prepared") throw new Error("no winner");
      const sockets = await Promise.all(
        [randomUUID(), randomUUID()].map((connectionId) =>
          attachConversationConnection(client.db, {
            actorUserId: userId,
            conversationId,
            writer: winner.writer,
            connectionId,
            now,
          }),
        ),
      );
      expect(sockets.map((value) => value.kind).sort()).toEqual([
        "attached",
        "in_use",
      ]);
    });

    it("requires writer fencing on the existing HTTP persistence path", async () => {
      const { writer } = await claim();
      expect(await append(undefined as never, [message(1)])).toMatchObject({
        kind: "writer_stale",
      });
      expect(
        await append({ ...writer, epoch: writer.epoch + 1 }, [message(1)]),
      ).toMatchObject({ kind: "writer_stale" });
      const entry = message(1);
      expect(await append(writer, [entry])).toMatchObject({
        kind: "appended",
        acknowledgedSequence: 1,
      });
      expect(await append(writer, [entry])).toMatchObject({
        kind: "unchanged",
        acknowledgedSequence: 1,
      });
      expect(
        await append(writer, [{ ...entry, text: "不能覆盖" }]),
      ).toMatchObject({ kind: "sequence_conflict" });
    });

    it("reconciles a lost message ACK after lease expiry with the original message identity", async () => {
      const { writer } = await claim();
      const entry = message(1);
      await append(writer, [entry]);
      expect(
        await append(writer, [entry], time(CONVERSATION_LEASE_MS + 1)),
      ).toMatchObject({ kind: "writer_stale" });
      const recovered = await claim(
        writer.clientId,
        "connect",
        time(CONVERSATION_LEASE_MS + 1),
      );
      expect(recovered.writer.epoch).toBe(writer.epoch + 1);
      expect(
        await append(
          recovered.writer,
          [entry],
          time(CONVERSATION_LEASE_MS + 2),
        ),
      ).toMatchObject({ kind: "unchanged", acknowledgedSequence: 1 });
      expect(
        await client.db
          .select()
          .from(conversationMessages)
          .where(eq(conversationMessages.conversationId, conversationId)),
      ).toHaveLength(1);
    });

    it("continues the same missing-tail end request after a different page acquires a new epoch", async () => {
      const first = await claim();
      await append(first.writer, [message(1)]);
      const requestId = randomUUID();
      expect(await finish(first.writer, requestId, 2)).toMatchObject({
        kind: "messages_missing",
      });
      const pending = await readConversationLifecycle(
        client.db,
        conversationId,
        requestId,
      );
      expect(pending?.operation).toMatchObject({
        targetSequence: 2,
        completedAt: null,
      });
      const later = time(CONVERSATION_LEASE_MS + 1);
      const next = await claim(randomUUID(), "finish", later);
      expect(
        await finish(first.writer, requestId, 2, later, true),
      ).toMatchObject({ kind: "writer_stale" });
      const completedHook = vi.fn(async () => undefined);
      expect(
        await finish(next.writer, requestId, 2, later, true, completedHook),
      ).toMatchObject({ kind: "completed" });
      expect(
        await finish(
          next.writer,
          requestId,
          2,
          time(CONVERSATION_LEASE_MS * 3),
          true,
          completedHook,
        ),
      ).toMatchObject({ kind: "unchanged" });
      expect(completedHook).toHaveBeenCalledTimes(1);
      expect(
        (await readConversationLifecycle(client.db, conversationId, requestId))
          ?.aggregate.conversation,
      ).toMatchObject({ status: "completed", lastSequence: 1 });
    });

    it("never reopens completed conversations and protects against a concurrent last append", async () => {
      const { writer } = await claim();
      await append(writer, [message(1)]);
      const hook = vi.fn(async () => undefined);
      const [end, tail] = await Promise.all([
        finish(writer, randomUUID(), 1, now, false, hook),
        append(writer, [message(2)]),
      ]);
      if (end.kind === "completed") expect(tail.kind).toBe("completed");
      else {
        expect(end.kind).toBe("sequence_conflict");
        expect(tail.kind).toBe("appended");
        expect(
          (await finish(writer, randomUUID(), 2, now, false, hook)).kind,
        ).toBe("completed");
      }
      expect(hook).toHaveBeenCalledTimes(1);
      expect(
        (
          await prepareConversation(client.db, {
            actorUserId: userId,
            conversationId,
            clientId: writer.clientId,
            requestId: randomUUID(),
            intent: "connect",
            now,
          })
        ).kind,
      ).toBe("already_completed");
      expect((await append(writer, [message(3)])).kind).toBe("completed");
    });

    it("sums only confirmed connected segments and preserves last activity when finalized hours later", async () => {
      const { writer } = await claim();
      const connectionId = randomUUID();
      await attachConversationConnection(client.db, {
        actorUserId: userId,
        conversationId,
        writer,
        connectionId,
        now,
      });
      await heartbeatConversationConnection(client.db, {
        actorUserId: userId,
        conversationId,
        writer,
        connectionId,
        now: time(1_000),
        active: true,
        activity: true,
      });
      await heartbeatConversationConnection(client.db, {
        actorUserId: userId,
        conversationId,
        writer,
        connectionId,
        now: time(10_000),
        active: true,
        activity: true,
      });
      await detachConversationConnection(client.db, {
        actorUserId: userId,
        conversationId,
        writer,
        connectionId,
        now: time(12_000),
      });
      const resumed = await claim(randomUUID(), "connect", time(3_600_000));
      const second = randomUUID();
      await attachConversationConnection(client.db, {
        actorUserId: userId,
        conversationId,
        writer: resumed.writer,
        connectionId: second,
        now: time(3_600_000),
      });
      await heartbeatConversationConnection(client.db, {
        actorUserId: userId,
        conversationId,
        writer: resumed.writer,
        connectionId: second,
        now: time(3_601_000),
        active: true,
        activity: true,
      });
      await heartbeatConversationConnection(client.db, {
        actorUserId: userId,
        conversationId,
        writer: resumed.writer,
        connectionId: second,
        now: time(3_606_000),
        active: true,
        activity: true,
      });
      // A delayed detach from the first socket cannot disconnect the resumed socket.
      await detachConversationConnection(client.db, {
        actorUserId: userId,
        conversationId,
        writer,
        connectionId,
        now: time(3_606_000),
      });
      expect(
        (await readConversationLifecycle(client.db, conversationId))?.control
          ?.connectionId,
      ).toBe(second);
      await detachConversationConnection(client.db, {
        actorUserId: userId,
        conversationId,
        writer: resumed.writer,
        connectionId: second,
        now: time(3_607_000),
      });
      const closer = await claim(randomUUID(), "finish", time(7_200_000));
      await finish(closer.writer, randomUUID(), 0, time(7_200_000));
      const value = await readConversationLifecycle(client.db, conversationId);
      expect(value?.control?.connectedDurationMs).toBe(14_000);
      expect(value?.aggregate.conversation.endedAt).toEqual(time(3_606_000));
      expect(value?.control?.finalizedAt).toEqual(time(7_200_000));
    });

    it("rechecks character visibility for recovery while preserving the owner's right to finish", async () => {
      const { writer } = await claim();
      await append(writer, [message(1)]);
      await client.db
        .update(characters)
        .set({ visibility: "private", ownerUserId: anotherUserId })
        .where(eq(characters.id, characterId));
      const later = time(CONVERSATION_LEASE_MS + 1);
      expect(
        (
          await prepareConversation(client.db, {
            actorUserId: userId,
            conversationId,
            clientId: randomUUID(),
            requestId: randomUUID(),
            intent: "connect",
            now: later,
          })
        ).kind,
      ).toBe("character_unavailable");
      const closer = await claim(randomUUID(), "finish", later);
      expect((await finish(closer.writer, randomUUID(), 1, later)).kind).toBe(
        "completed",
      );
      await client.db
        .update(characters)
        .set({ ownerUserId: userId })
        .where(eq(characters.id, characterId));
    });

    it("keeps temporary recovery local to its own saved content", async () => {
      await client.db
        .update(conversations)
        .set({ mode: "temporary" })
        .where(eq(conversations.id, conversationId));
      const { writer } = await claim();
      await append(writer, [message(1)]);
      const context = await loadConversationRealtimeContext(client.db, {
        actorUserId: userId,
        conversationId,
        characterId,
      });
      expect(context?.mode).toBe("temporary");
      expect(context?.messages).toHaveLength(1);
      expect(context?.summaries).toEqual([]);
      expect(context?.memories).toEqual([]);
      expect(
        context?.messages.every(
          (item) => item.conversationId === conversationId,
        ),
      ).toBe(true);
    });

    it("never recreates deleted data and cascades control receipts and favorites", async () => {
      const { writer } = await claim();
      await client.db
        .insert(characterFavorites)
        .values({ userId, characterId })
        .onConflictDoNothing();
      expect(
        await deleteOwnedConversation(client.db, userId, conversationId),
      ).toBe(true);
      expect(
        await readConversationLifecycle(client.db, conversationId),
      ).toBeNull();
      expect((await finish(writer, randomUUID(), 0)).kind).toBe("not_found");
      expect((await append(writer, [message(1)])).kind).toBe("not_found");
      // Favorites are independent of a single conversation and remain valid.
      expect(
        await client.db
          .select()
          .from(characterFavorites)
          .where(
            and(
              eq(characterFavorites.userId, userId),
              eq(characterFavorites.characterId, characterId),
            ),
          ),
      ).toHaveLength(1);
    });

    it("cleans up expired empty startup attempts without occupying pending or recent sections", async () => {
      const { writer } = await claim();
      expect(
        (
          await heartbeatConversationWriter(client.db, {
            actorUserId: userId,
            conversationId,
            writer,
            now: time(CONVERSATION_LEASE_MS + 1),
          })
        ).kind,
      ).toBe("writer_stale");
      await cleanupExpiredEmptyConversations(
        client.db,
        userId,
        time(CONVERSATION_LEASE_MS + 1),
      );
      const value = await readConversationLifecycle(client.db, conversationId);
      expect(value?.aggregate.conversation.status).toBe("completed");
      const overview = await listConversationOverviewIds(client.db, userId);
      expect(overview.pending).not.toContain(conversationId);
      expect(overview.recent).not.toContain(conversationId);
    });

    it("allows independent calls but rolls back an entire conflicting message batch", async () => {
      const first = await claim();
      const source = message(1);
      await append(first.writer, [source]);
      const secondId = randomUUID();
      conversationIds.push(secondId);
      await createConversation(client.db, {
        id: secondId,
        actorUserId: userId,
        characterId,
        mode: "normal",
        startedAt: now,
      });
      const second = await prepareConversation(client.db, {
        actorUserId: userId,
        conversationId: secondId,
        clientId: randomUUID(),
        requestId: randomUUID(),
        intent: "connect",
        now,
      });
      expect(second.kind).toBe("prepared");
      if (second.kind !== "prepared") throw new Error("no second writer");
      const result = await appendConversationMessages(client.db, {
        actorUserId: userId,
        conversationId: secondId,
        writer: second.writer,
        messages: [message(1), { ...source, sequence: 2 }],
        updatedAt: now,
      });
      expect(result.kind).toBe("sequence_conflict");
      expect(
        await client.db
          .select()
          .from(conversationMessages)
          .where(eq(conversationMessages.conversationId, secondId)),
      ).toHaveLength(0);
      expect(
        (await readConversationLifecycle(client.db, secondId))?.aggregate
          .conversation,
      ).toMatchObject({ lastSequence: 0, messageCount: 0 });
    });

    it("rolls back completion if durable background work cannot be enqueued", async () => {
      const { writer } = await claim();
      await append(writer, [message(1)]);
      const requestId = randomUUID();
      await expect(
        finish(writer, requestId, 1, now, false, async () => {
          throw new Error("isolated queue failure");
        }),
      ).rejects.toThrow("isolated queue failure");
      const state = await readConversationLifecycle(
        client.db,
        conversationId,
        requestId,
      );
      expect(state?.aggregate.conversation.status).toBe("active");
      expect(state?.operation).toBeNull();
      expect(state?.control?.endRequestId).toBeNull();
      expect((await finish(writer, requestId, 1)).kind).toBe("completed");
    });

    it("does not let old prepare receipts reclaim a newer writer epoch", async () => {
      const clientId = randomUUID();
      const requestId = randomUUID();
      const first = await claim(clientId, "connect", now, requestId);
      await append(first.writer, [message(1)]);
      const second = await claim(
        randomUUID(),
        "connect",
        time(CONVERSATION_LEASE_MS + 1),
      );
      const result = await prepareConversation(client.db, {
        actorUserId: userId,
        conversationId,
        clientId,
        requestId,
        intent: "connect",
        now: time(CONVERSATION_LEASE_MS + 2),
      });
      expect(result.kind).toBe("writer_stale");
      expect(
        (await readConversationLifecycle(client.db, conversationId))?.control,
      ).toMatchObject({
        writerClientId: second.writer.clientId,
        writerEpoch: second.writer.epoch,
      });
    });

    it("selects each normally completed character only once in the overview", async () => {
      const { writer } = await claim();
      await append(writer, [message(1)]);
      await finish(writer, randomUUID(), 1);
      const secondId = randomUUID();
      conversationIds.push(secondId);
      await createConversation(client.db, {
        id: secondId,
        actorUserId: userId,
        characterId,
        mode: "normal",
        startedAt: now,
      });
      const second = await prepareConversation(client.db, {
        actorUserId: userId,
        conversationId: secondId,
        clientId: randomUUID(),
        requestId: randomUUID(),
        intent: "connect",
        now,
      });
      if (second.kind !== "prepared") throw new Error("no second writer");
      await appendConversationMessages(client.db, {
        actorUserId: userId,
        conversationId: secondId,
        writer: second.writer,
        messages: [message(1)],
        updatedAt: now,
      });
      await completeConversation(client.db, {
        actorUserId: userId,
        conversationId: secondId,
        writer: second.writer,
        requestId: randomUUID(),
        lastSequence: 1,
        discardMissing: false,
        endedAt: now,
      });
      const overview = await listConversationOverviewIds(client.db, userId);
      expect(overview.recent).toHaveLength(1);
      const detail = await listConversationOverviewIds(
        client.db,
        userId,
        characterId,
      );
      expect(detail.recent.length).toBeGreaterThanOrEqual(2);
      expect(detail.recent.length).toBeLessThanOrEqual(4);
    });
  },
);
