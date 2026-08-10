import {
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

export type WorkerHandlers = ReturnType<typeof createWorkerHandlers>;

export function createWorkerHandlers(
  db: Database,
  analyzer: ConversationAnalyzer,
) {
  return {
    finalizeConversation: async (value: unknown): Promise<void> => {
      const job = conversationFinalizeJobSchema.parse(value);
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
      });
    },
    extractMemories: async (value: unknown): Promise<void> => {
      const job = memoryExtractJobSchema.parse(value);
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
    },
  };
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
