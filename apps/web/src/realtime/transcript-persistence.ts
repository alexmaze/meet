import type {
  AppendConversationMessagesRequest,
  ConversationWriter,
} from "@meet/protocol";
import type { PendingEndOperation } from "../history/pending-end-operation.js";
import { ConversationApiError } from "../history/conversation-api.js";

export type PendingPersistedMessage =
  AppendConversationMessagesRequest["messages"][number];
export type ConversationPersistence = {
  id: string;
  writer: ConversationWriter;
  endOperation: PendingEndOperation | null;
  nextSequence: number;
  acknowledgedSequence: number;
  pending: PendingPersistedMessage[];
  flushing: Promise<void> | null;
};

/** An acknowledged prefix can be removed. Failed or ambiguous writes always retain the original IDs. */
export function flushTranscriptQueue(
  persistence: ConversationPersistence,
  append: (
    conversationId: string,
    input: AppendConversationMessagesRequest,
  ) => Promise<number>,
  onAcknowledged: (message: PendingPersistedMessage) => void,
  wait: (milliseconds: number) => Promise<void>,
): Promise<void> {
  if (persistence.flushing) return persistence.flushing;
  const flush = (async () => {
    while (persistence.pending.length > 0) {
      const message = persistence.pending[0]!;
      let saved = false;
      let failure: unknown;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          const acknowledged = await append(persistence.id, {
            writer: persistence.writer,
            messages: [message],
          });
          if (acknowledged < message.sequence)
            throw new ConversationApiError(
              null,
              "CONVERSATION_ACKNOWLEDGEMENT_INCOMPLETE",
            );
          persistence.acknowledgedSequence = Math.max(
            persistence.acknowledgedSequence,
            acknowledged,
          );
          // Explicit abandonment may clear the in-memory queue while a write is in flight.
          if (persistence.pending[0]?.id === message.id)
            persistence.pending.shift();
          onAcknowledged(message);
          saved = true;
          break;
        } catch (error) {
          failure = error;
          if (
            error instanceof ConversationApiError &&
            error.status !== null &&
            error.status >= 400 &&
            error.status < 500
          )
            break;
          if (attempt < 2) await wait(500 * 2 ** attempt);
        }
      }
      if (!saved) throw failure;
    }
  })().finally(() => {
    if (persistence.flushing === flush) persistence.flushing = null;
  });
  persistence.flushing = flush;
  return flush;
}
