import {
  apiErrorSchema,
  appendConversationMessagesRequestSchema,
  appendConversationMessagesResponseSchema,
  completeConversationRequestSchema,
  conversationDetailResponseSchema,
  conversationListResponseSchema,
  conversationResponseSchema,
  createConversationRequestSchema,
  deleteConversationResponseSchema,
  type AppendConversationMessagesRequest,
  type ConversationMessage,
  type ConversationSummary,
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
}> {
  const body = await requestJson(conversationUrl(conversationId), { signal });
  return parseWith(conversationDetailResponseSchema, body);
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

export async function completeConversation(
  conversationId: string,
  lastSequence: number,
): Promise<ConversationSummary> {
  const body = await requestJson(
    `${conversationUrl(conversationId)}/complete`,
    {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify(
        completeConversationRequestSchema.parse({ lastSequence }),
      ),
    },
  );
  return parseWith(conversationResponseSchema, body).conversation;
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

function conversationUrl(conversationId: string): string {
  return `/api/conversations/${encodeURIComponent(conversationId)}`;
}

async function requestJson(
  input: RequestInfo | URL,
  init: RequestInit = {},
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(input, {
      credentials: "same-origin",
      cache: init.method ? undefined : "no-store",
      ...init,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw error;
    }
    throw new ConversationApiError(null);
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new ConversationApiError(response.status);
  }
  if (!response.ok) {
    const parsed = apiErrorSchema.safeParse(body);
    throw new ConversationApiError(
      response.status,
      parsed.success ? parsed.data.code : undefined,
    );
  }
  return body;
}

type SafeParseSchema<T> = {
  safeParse: (
    input: unknown,
  ) => { success: true; data: T } | { success: false; error: unknown };
};

function parseWith<T>(schema: SafeParseSchema<T>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    throw new ConversationApiError(null, "INVALID_CONVERSATION_RESPONSE");
  }
  return parsed.data;
}
