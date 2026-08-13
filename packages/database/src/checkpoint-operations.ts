import { and, desc, eq, gt, gte, inArray, lt, lte } from "drizzle-orm";

import type { Database } from "./client.js";
import {
  characters,
  conversationMessages,
  conversationSummaryCheckpoints,
  conversations,
  type ConversationMessageRecord,
  type ConversationRecord,
  type ConversationSummaryCheckpointRecord,
} from "./schema.js";

export type ConversationCheckpointForAnalysis = {
  checkpoint: ConversationSummaryCheckpointRecord;
  conversation: ConversationRecord;
  characterName: string;
  previousSummary: string | null;
  messages: ConversationMessageRecord[];
};

export async function loadConversationCheckpointForAnalysis(
  db: Database,
  input: {
    checkpointId: string;
    conversationId: string;
    userId: string;
    targetSequence: number;
  },
): Promise<ConversationCheckpointForAnalysis | null> {
  const [target] = await db
    .select({
      checkpoint: conversationSummaryCheckpoints,
      conversation: conversations,
      characterName: characters.name,
    })
    .from(conversationSummaryCheckpoints)
    .innerJoin(
      conversations,
      eq(conversationSummaryCheckpoints.conversationId, conversations.id),
    )
    .innerJoin(characters, eq(conversations.characterId, characters.id))
    .where(
      and(
        eq(conversationSummaryCheckpoints.id, input.checkpointId),
        eq(conversationSummaryCheckpoints.conversationId, input.conversationId),
        eq(
          conversationSummaryCheckpoints.sourceLastSequence,
          input.targetSequence,
        ),
        inArray(conversationSummaryCheckpoints.status, ["queued", "failed"]),
        eq(conversations.userId, input.userId),
        gte(conversations.lastSequence, input.targetSequence),
      ),
    )
    .limit(1);
  if (!target) return null;

  const [previous] = await db
    .select({
      content: conversationSummaryCheckpoints.content,
      sourceLastSequence: conversationSummaryCheckpoints.sourceLastSequence,
    })
    .from(conversationSummaryCheckpoints)
    .where(
      and(
        eq(conversationSummaryCheckpoints.conversationId, input.conversationId),
        eq(conversationSummaryCheckpoints.status, "completed"),
        lt(
          conversationSummaryCheckpoints.sourceLastSequence,
          input.targetSequence,
        ),
      ),
    )
    .orderBy(desc(conversationSummaryCheckpoints.sourceLastSequence))
    .limit(1);
  const previousSequence = previous?.sourceLastSequence ?? 0;
  const messages = await db
    .select()
    .from(conversationMessages)
    .where(
      and(
        eq(conversationMessages.conversationId, input.conversationId),
        gt(conversationMessages.sequence, previousSequence),
        lte(conversationMessages.sequence, input.targetSequence),
      ),
    )
    .orderBy(conversationMessages.sequence);
  return {
    ...target,
    previousSummary: previous?.content ?? null,
    messages,
  };
}

export async function completeConversationSummaryCheckpoint(
  db: Database,
  input: {
    checkpointId: string;
    content: string;
    analyzerModel: string;
    completedAt?: Date;
  },
): Promise<void> {
  const completedAt = input.completedAt ?? new Date();
  await db
    .update(conversationSummaryCheckpoints)
    .set({
      status: "completed",
      content: input.content.trim(),
      analyzerModel: input.analyzerModel,
      lastErrorCode: null,
      completedAt,
      updatedAt: completedAt,
    })
    .where(
      and(
        eq(conversationSummaryCheckpoints.id, input.checkpointId),
        inArray(conversationSummaryCheckpoints.status, ["queued", "failed"]),
      ),
    );
}

export async function failConversationSummaryCheckpoint(
  db: Database,
  checkpointId: string,
  errorCode = "MODEL_TASK_FAILED",
): Promise<void> {
  await db
    .update(conversationSummaryCheckpoints)
    .set({
      status: "failed",
      content: null,
      analyzerModel: null,
      lastErrorCode: errorCode,
      completedAt: null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(conversationSummaryCheckpoints.id, checkpointId),
        inArray(conversationSummaryCheckpoints.status, ["queued", "failed"]),
      ),
    );
}
