import {
  aiWorkItems,
  loadCompletedConversationForAnalysis,
  type Database,
  upsertConversationSummary,
  upsertExtractedMemories,
} from "@meet/database";
import {
  conversationFinalizeJobSchema,
  memoryExtractJobSchema,
  type ConversationFinalizeJob,
  type MemoryExtractJob,
} from "@meet/jobs";

import type { ConversationAnalyzer, MemoryCandidate } from "./analyzer.js";
import type { ConversationAnalyzerResolver } from "./model-resolver.js";
import { eq } from "drizzle-orm";

export type WorkerHandlers = ReturnType<typeof createWorkerHandlers>;

export function createWorkerHandlers(
  db: Database,
  analyzerSource: ConversationAnalyzer | ConversationAnalyzerResolver,
) {
  return {
    finalizeConversation: async (value: unknown): Promise<void> => {
      const job = conversationFinalizeJobSchema.parse(value);
      await runTracked(db, job.workItemId, async () => {
        const analyzer = await resolveAnalyzer(
          analyzerSource,
          job.modelProfileId,
        );
        const source = await loadSource(db, job);
        if (!source) return;
        const summary = await analyzer.summarize({
          characterName: source.characterName,
          messages: source.messages,
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
  };
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
