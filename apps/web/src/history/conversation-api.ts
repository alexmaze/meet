import {
  apiErrorSchema,
  appendConversationMessagesRequestSchema,
  appendConversationMessagesResponseSchema,
  conversationDetailResponseSchema,
  conversationContinuityDetailResponseSchema,
  conversationListResponseSchema,
  conversationResponseSchema,
  createConversationRequestSchema,
  deleteConversationResponseSchema,
  type AppendConversationMessagesRequest,
  type ConversationMessage,
  type ConversationSummary,
  type ConversationContinuityStatus,
  type CreateConversationRequest,
} from "@meet/protocol";

export class ConversationApiError extends Error {
  constructor(
    readonly status: number | null,
    readonly code = "CONVERSATION_REQUEST_FAILED",
  ) {
    super("通话记录请求失败");
    this.name = "ConversationApiError";
  }
}

const jsonHeaders = {
  Accept: "application/json",
  "Content-Type": "application/json",
};

export async function createConversation(
  input: CreateConversationRequest,
): Promise<ConversationSummary> {
  const body = await requestJson("/api/conversations", {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify(createConversationRequestSchema.parse(input)),
  });
  return parseWith(conversationResponseSchema, body).conversation;
}

export async function listConversations(
  signal?: AbortSignal,
): Promise<ConversationSummary[]> {
  const body = await requestJson("/api/conversations", { signal });
  return parseWith(conversationListResponseSchema, body).conversations;
}

export async function getConversation(
  conversationId: string,
  signal?: AbortSignal,
): Promise<{
  conversation: ConversationSummary;
  messages: ConversationMessage[];
  continuity?: ConversationContinuityStatus;
}> {
  const body = await requestJson(conversationUrl(conversationId), { signal });
  const continuity = conversationContinuityDetailResponseSchema.safeParse(body);
  return continuity.success
    ? continuity.data
    : parseWith(conversationDetailResponseSchema, body);
}

export async function appendConversationMessages(
  conversationId: string,
  input: AppendConversationMessagesRequest,
): Promise<number> {
  const body = await requestJson(
    `${conversationUrl(conversationId)}/messages`,
    {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify(
        appendConversationMessagesRequestSchema.parse(input),
      ),
    },
  );
  return parseWith(appendConversationMessagesResponseSchema, body)
    .acknowledgedSequence;
}

export async function deleteConversation(
  conversationId: string,
): Promise<void> {
  const body = await requestJson(conversationUrl(conversationId), {
    method: "DELETE",
    headers: { Accept: "application/json" },
  });
  parseWith(deleteConversationResponseSchema, body);
}

export function conversationUrl(conversationId: string): string {
  return `/api/conversations/${encodeURIComponent(conversationId)}`;
}

export async function requestJson(
  input: RequestInfo | URL,
  init: RequestInit = {},
): Promise<unknown> {
  const controller = new AbortController();
  const timeout = globalThis.setTimeout(() => controller.abort(), 12_000);
  const cancel = () => controller.abort();
  init.signal?.addEventListener("abort", cancel, { once: true });
  if (init.signal?.aborted) controller.abort();
  let status: number | null = null;
  try {
    const response = await fetch(input, {
      credentials: "same-origin",
      cache: init.method ? undefined : "no-store",
      ...init,
      signal: controller.signal,
    });
    status = response.status;
    const body: unknown = await response.json();
    if (!response.ok) {
      const parsed = apiErrorSchema.safeParse(body);
      throw new ConversationApiError(
        response.status,
        parsed.success ? parsed.data.code : undefined,
      );
    }
    return body;
  } catch (error) {
    if (error instanceof ConversationApiError) throw error;
    if (
      init.signal?.aborted &&
      error instanceof DOMException &&
      error.name === "AbortError"
    )
      throw error;
    throw new ConversationApiError(status);
  } finally {
    globalThis.clearTimeout(timeout);
    init.signal?.removeEventListener("abort", cancel);
  }
}

type SafeParseSchema<T> = {
  safeParse: (
    input: unknown,
  ) => { success: true; data: T } | { success: false; error: unknown };
};

export function parseWith<T>(schema: SafeParseSchema<T>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    throw new ConversationApiError(null, "INVALID_CONVERSATION_RESPONSE");
  }
  return parsed.data;
}
