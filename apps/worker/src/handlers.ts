import {
  aiWorkItems,
  completeConversationSummaryCheckpoint,
  failConversationSummaryCheckpoint,
  loadConversationCheckpointForAnalysis,
  loadCompletedConversationForAnalysis,
  loadMemoryForIndex,
  markMemoryIndexFailed,
  markMemoryIndexSynced,
  type Database,
  type MemoryIndexHook,
  upsertConversationSummary,
  upsertExtractedMemories,
} from "@meet/database";
import {
  conversationFinalizeJobSchema,
  conversationCheckpointJobSchema,
  memoryExtractJobSchema,
  memoryIndexSyncJobSchema,
  type ConversationFinalizeJob,
  type MemoryExtractJob,
} from "@meet/jobs";
import {
  resolveSemanticMemoryStore,
  type SemanticMemoryStoreSource,
} from "@meet/memory";

import type { ConversationAnalyzer, MemoryCandidate } from "./analyzer.js";
import type { ConversationAnalyzerResolver } from "./model-resolver.js";
import { eq } from "drizzle-orm";

export type WorkerHandlers = ReturnType<typeof createWorkerHandlers>;

export function createWorkerHandlers(
  db: Database,
  analyzerSource: ConversationAnalyzer | ConversationAnalyzerResolver,
  options: {
    memoryIndexHook?: MemoryIndexHook;
    semanticMemoryStore?: SemanticMemoryStoreSource;
  } = {},
) {
  return {
    checkpointConversation: async (value: unknown): Promise<void> => {
      const job = conversationCheckpointJobSchema.parse(value);
      try {
        const analyzer = await resolveAnalyzer(
          analyzerSource,
          job.modelProfileId,
        );
        const source = await loadConversationCheckpointForAnalysis(db, {
          checkpointId: job.checkpointId,
          conversationId: job.conversationId,
          userId: job.userId,
          targetSequence: job.targetSequence,
        });
        if (!source) return;
        const summary = await analyzer.summarize({
          characterName: source.characterName,
          previousSummary: source.previousSummary ?? undefined,
          messages: source.messages,
        });
        await completeConversationSummaryCheckpoint(db, {
          checkpointId: job.checkpointId,
          content: summary,
          analyzerModel: analyzer.model,
        });
      } catch (error) {
        await failConversationSummaryCheckpoint(db, job.checkpointId);
        throw error;
      }
    },
    finalizeConversation: async (value: unknown): Promise<void> => {
      const job = conversationFinalizeJobSchema.parse(value);
      await runTracked(db, job.workItemId, async () => {
        const analyzer = await resolveAnalyzer(
          analyzerSource,
          job.modelProfileId,
        );
        const source = await loadSource(db, job);
        if (!source) return;
        const remainingMessages = selectMessagesAfterCheckpoint(
          source.messages,
          source.checkpoint?.sourceLastSequence,
        );
        const summary = await analyzer.summarize({
          characterName: source.characterName,
          previousSummary: source.checkpoint?.content,
          messages: remainingMessages,
        });
        await upsertConversationSummary(db, {
          conversationId: source.conversation.id,
          userId: source.conversation.userId,
          characterId: source.conversation.characterId,
          content: summary,
          sourceMessageCount: source.conversation.messageCount,
          sourceLastSequence: source.conversation.lastSequence,
          analyzerModel: analyzer.model,
          analyzerProfileId: job.modelProfileId,
        });
      });
    },
    extractMemories: async (value: unknown): Promise<void> => {
      const job = memoryExtractJobSchema.parse(value);
      await runTracked(db, job.workItemId, async () => {
        const analyzer = await resolveAnalyzer(
          analyzerSource,
          job.modelProfileId,
        );
        const source = await loadSource(db, job);
        if (!source || source.conversation.mode === "temporary") return;
        const candidates = await analyzer.extractMemories({
          characterName: source.characterName,
          messages: source.messages,
        });
        await upsertExtractedMemories(db, {
          conversationId: source.conversation.id,
          userId: source.conversation.userId,
          characterId: source.conversation.characterId,
          analyzerModel: analyzer.model,
          analyzerProfileId: job.modelProfileId,
          onIndex: options.memoryIndexHook,
          memories: candidates.flatMap((candidate) => {
            const status = classifyMemoryCandidate(candidate);
            return status
              ? [
                  {
                    content: candidate.content,
                    sourceExcerpt: candidate.sourceExcerpt,
                    confidence: candidate.confidence,
                    status,
                  },
                ]
              : [];
          }),
        });
      });
    },
    syncMemoryIndex: async (value: unknown): Promise<void> => {
      const job = memoryIndexSyncJobSchema.parse(value);
      const store = await resolveSemanticMemoryStore(
        options.semanticMemoryStore,
      );
      if (!store) return;
      const source = await loadMemoryForIndex(db, job.memoryId);
      if (!source) return;
      try {
        if (source.memory.status === "active") {
          if (
            source.index?.status === "synced" &&
            source.index.externalId &&
            source.index.indexedFingerprint ===
              source.memory.contentFingerprint &&
            source.index.indexRevision === store.indexRevision
          ) {
            return;
          }
          const reusableExternalId =
            source.index?.indexRevision === store.indexRevision
              ? source.index?.externalId
              : null;
          const externalId = await store.upsert(
            {
              id: source.memory.id,
              userId: source.memory.userId,
              characterId: source.memory.characterId,
              content: source.memory.content,
              sourceConversationId: source.memory.sourceConversationId,
              contentFingerprint: source.memory.contentFingerprint,
            },
            reusableExternalId,
          );
          await markMemoryIndexSynced(db, {
            memoryId: source.memory.id,
            externalId,
            indexedFingerprint: source.memory.contentFingerprint,
            indexRevision: store.indexRevision ?? "unknown",
          });
          return;
        }
        if (source.index?.externalId) {
          await store.delete(source.index.externalId);
        }
        await markMemoryIndexSynced(db, {
          memoryId: source.memory.id,
          externalId: null,
          indexedFingerprint: null,
          indexRevision: store.indexRevision ?? "unknown",
        });
      } catch (error) {
        await markMemoryIndexFailed(
          db,
          source.memory.id,
          memoryIndexErrorCode(error),
        );
        throw error;
      }
    },
  };
}

function memoryIndexErrorCode(error: unknown): string {
  if (error && typeof error === "object" && "errorCode" in error) {
    const code = (error as { errorCode?: unknown }).errorCode;
    if (typeof code === "string" && /^[A-Z0-9_:-]{1,120}$/i.test(code)) {
      return code;
    }
  }
  return "MEM0_SYNC_FAILED";
}

export function selectMessagesAfterCheckpoint<T extends { sequence: number }>(
  messages: T[],
  sourceLastSequence?: number,
): T[] {
  return sourceLastSequence === undefined
    ? messages
    : messages.filter(({ sequence }) => sequence > sourceLastSequence);
}

async function runTracked(
  db: Database,
  workItemId: string | undefined,
  action: () => Promise<void>,
): Promise<void> {
  try {
    await action();
    await markWork(db, workItemId, "completed");
  } catch (error) {
    await markWork(db, workItemId, "failed");
    throw error;
  }
}

async function resolveAnalyzer(
  source: ConversationAnalyzer | ConversationAnalyzerResolver,
  modelProfileId?: string,
): Promise<ConversationAnalyzer> {
  if ("resolve" in source) {
    if (!modelProfileId)
      throw new Error("AI work item has no text model binding.");
    return source.resolve(modelProfileId);
  }
  return source;
}

async function markWork(
  db: Database,
  workItemId: string | undefined,
  status: "completed" | "failed",
): Promise<void> {
  if (!workItemId) return;
  await db
    .update(aiWorkItems)
    .set({
      status,
      completedAt: status === "completed" ? new Date() : null,
      lastErrorCode: status === "failed" ? "MODEL_TASK_FAILED" : null,
      updatedAt: new Date(),
    })
    .where(eq(aiWorkItems.id, workItemId));
}

export function classifyMemoryCandidate(
  candidate: MemoryCandidate,
): "active" | "suggested" | null {
  if (candidate.stability !== "stable") return null;
  return candidate.evidence === "explicit" && candidate.confidence >= 0.9
    ? "active"
    : "suggested";
}

async function loadSource(
  db: Database,
  job: ConversationFinalizeJob | MemoryExtractJob,
) {
  return loadCompletedConversationForAnalysis(db, {
    conversationId: job.conversationId,
    userId: job.userId,
    completedSequence: job.completedSequence,
  });
}
