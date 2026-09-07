import {
  conversationContinuityStatusSchema,
  conversationOverviewResponseSchema,
  prepareConversationRequestSchema,
  prepareConversationResponseSchema,
  completeConversationRequestSchema,
  completeConversationResponseSchema,
  conversationHeartbeatRequestSchema,
  type ConversationContinuityStatus,
  type ConversationWriter,
  type PrepareConversationRequest,
  type CompleteConversationRequest,
} from "@meet/protocol";
import {
  ConversationApiError,
  conversationUrl,
  parseWith,
  requestJson,
} from "./conversation-api.js";
import {
  getConversationClientId,
  getPendingEndOperation,
  savePendingEndOperation,
  clearPendingEndOperation,
} from "./pending-end-operation.js";
export * from "./pending-end-operation.js";

const headers = {
  Accept: "application/json",
  "Content-Type": "application/json",
};
export async function getConversationStatus(
  conversationId: string,
  requestId?: string,
  signal?: AbortSignal,
) {
  const query = new URLSearchParams({ clientId: getConversationClientId() });
  if (requestId) query.set("requestId", requestId);
  return parseWith(
    conversationContinuityStatusSchema,
    await requestJson(`${conversationUrl(conversationId)}/status?${query}`, {
      signal,
    }),
  );
}
export const getStatus = getConversationStatus;
export async function listOverview(characterId?: string, signal?: AbortSignal) {
  const query = new URLSearchParams({ clientId: getConversationClientId() });
  if (characterId) query.set("characterId", characterId);
  return parseWith(
    conversationOverviewResponseSchema,
    await requestJson(`/api/conversations/overview?${query}`, { signal }),
  );
}
export async function prepareConversation(
  conversationId: string,
  input: PrepareConversationRequest,
) {
  return parseWith(
    prepareConversationResponseSchema,
    await requestJson(`${conversationUrl(conversationId)}/prepare`, {
      method: "POST",
      headers,
      body: JSON.stringify(prepareConversationRequestSchema.parse(input)),
    }),
  );
}
export async function heartbeatConversation(
  conversationId: string,
  writer: ConversationWriter,
) {
  return parseWith(
    conversationContinuityStatusSchema,
    await requestJson(`${conversationUrl(conversationId)}/heartbeat`, {
      method: "POST",
      headers,
      body: JSON.stringify(
        conversationHeartbeatRequestSchema.parse({ writer }),
      ),
    }),
  );
}
export async function completeConversation(
  conversationId: string,
  input: CompleteConversationRequest,
) {
  return parseWith(
    completeConversationResponseSchema,
    await requestJson(`${conversationUrl(conversationId)}/complete`, {
      method: "POST",
      headers,
      body: JSON.stringify(completeConversationRequestSchema.parse(input)),
    }),
  );
}
/** Does not connect a model or open a microphone. Missing text requires an explicit discard. */
export async function finishSavedConversation(
  status: ConversationContinuityStatus,
  userId: string,
  options: { discardMissing?: boolean } = {},
) {
  const id = status.conversation.id;
  const savedOperation = getPendingEndOperation(id, userId);
  const current = await getConversationStatus(
    id,
    savedOperation?.requestId ?? status.endRequestId ?? undefined,
  );
  if (current.conversation.status === "completed") {
    clearPendingEndOperation(id, userId);
    return current;
  }
  const operation = savedOperation ?? {
    conversationId: id,
    requestId: current.endRequestId ?? crypto.randomUUID(),
    lastSequence:
      current.endTargetSequence ?? current.conversation.lastSequence,
  };
  savePendingEndOperation(userId, operation);
  if (
    operation.lastSequence > current.conversation.lastSequence &&
    !options.discardMissing
  ) {
    throw new ConversationApiError(409, "CONVERSATION_MESSAGES_MISSING");
  }
  const prepared = await prepareConversation(id, {
    clientId: getConversationClientId(),
    requestId: crypto.randomUUID(),
    intent: "finish",
  });
  const result = await confirmConversationFinish(id, {
    writer: prepared.writer,
    requestId: operation.requestId,
    lastSequence: operation.lastSequence,
    discardMissing: options.discardMissing ?? false,
  });
  clearPendingEndOperation(id, userId);
  return result;
}

/** Resolve an unknown finish result without creating a second end operation. */
export async function confirmConversationFinish(
  conversationId: string,
  input: CompleteConversationRequest,
): Promise<ConversationContinuityStatus> {
  try {
    return (await completeConversation(conversationId, input)).status;
  } catch (error) {
    const status = await getConversationStatus(conversationId, input.requestId);
    if (status.conversation.status !== "completed") throw error;
    return status;
  }
}
