import {
  apiErrorSchema,
  childTeachingAvailabilityResponseSchema,
  conversationTeachingStateResponseSchema,
  learningPlanContentResponseSchema,
  learningPlanGenerationResponseSchema,
  learningPlanListResponseSchema,
  learningPlanResponseSchema,
  learningPlanTargetsResponseSchema,
  muteConversationTeachingRequestSchema,
  publishLearningPlanContentRequestSchema,
  publishLearningPlanContentResponseSchema,
  prepareConversationTeachingRequestSchema,
  putLearningPlanRequestSchema,
  requestLearningPlanGenerationSchema,
  type ChildCharacterLearningPlan,
  type ChildTeachingAvailability,
  type LearningPlanContentResponse,
  type LearningPlanGenerationResponse,
  type LearningPlanTargetsResponse,
  type PublishLearningPlanContentRequest,
  type PublishLearningPlanContentResponse,
  type RequestLearningPlanGeneration,
  type SafeRelayTeachingState,
  type PutLearningPlanRequest,
  type PrepareConversationTeachingRequest,
} from "@meet/protocol";

export class TeachingApiError extends Error {
  constructor(
    readonly status: number | null,
    readonly code = "TEACHING_REQUEST_FAILED",
  ) {
    super("学习小支线请求失败");
    this.name = "TeachingApiError";
  }
}

const jsonHeaders = {
  Accept: "application/json",
  "Content-Type": "application/json",
};

export async function getLearningPlanTargets(
  signal?: AbortSignal,
): Promise<LearningPlanTargetsResponse> {
  const body = await requestJson("/api/teaching/targets", { signal });
  return parseResponse(learningPlanTargetsResponseSchema, body);
}

export async function listLearningPlans(
  childUserId: string,
  signal?: AbortSignal,
): Promise<ChildCharacterLearningPlan[]> {
  const query = new URLSearchParams({ childUserId });
  const body = await requestJson(`/api/teaching/plans?${query.toString()}`, {
    signal,
  });
  return parseResponse(learningPlanListResponseSchema, body).learningPlans;
}

export async function putLearningPlan(
  childUserId: string,
  characterId: string,
  input: PutLearningPlanRequest,
): Promise<ChildCharacterLearningPlan> {
  const body = await requestJson(learningPlanUrl(childUserId, characterId), {
    method: "PUT",
    headers: jsonHeaders,
    body: JSON.stringify(putLearningPlanRequestSchema.parse(input)),
  });
  return parseResponse(learningPlanResponseSchema, body).learningPlan;
}

export async function requestLearningPlanGeneration(
  childUserId: string,
  characterId: string,
  input: RequestLearningPlanGeneration,
): Promise<LearningPlanGenerationResponse> {
  const body = await requestJson(
    `${learningPlanUrl(childUserId, characterId)}/generations`,
    {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify(requestLearningPlanGenerationSchema.parse(input)),
    },
  );
  return parseResponse(learningPlanGenerationResponseSchema, body);
}

export async function getLearningPlanGeneration(
  childUserId: string,
  characterId: string,
  generationId: string,
  signal?: AbortSignal,
): Promise<LearningPlanGenerationResponse> {
  const body = await requestJson(
    `${learningPlanUrl(childUserId, characterId)}/generations/${encodeURIComponent(generationId)}`,
    { signal },
  );
  return parseResponse(learningPlanGenerationResponseSchema, body);
}

export async function getLearningPlanContent(
  childUserId: string,
  characterId: string,
  signal?: AbortSignal,
): Promise<LearningPlanContentResponse> {
  const body = await requestJson(
    `${learningPlanUrl(childUserId, characterId)}/content`,
    { signal },
  );
  return parseResponse(learningPlanContentResponseSchema, body);
}

export async function publishLearningPlanContent(
  childUserId: string,
  characterId: string,
  input: PublishLearningPlanContentRequest,
): Promise<PublishLearningPlanContentResponse> {
  const body = await requestJson(
    `${learningPlanUrl(childUserId, characterId)}/content/publish`,
    {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify(
        publishLearningPlanContentRequestSchema.parse(input),
      ),
    },
  );
  return parseResponse(publishLearningPlanContentResponseSchema, body);
}

export async function getTeachingAvailability(
  characterId: string,
  signal?: AbortSignal,
): Promise<ChildTeachingAvailability> {
  const body = await requestJson(
    `/api/teaching/availability/${encodeURIComponent(characterId)}`,
    { signal },
  );
  return parseResponse(childTeachingAvailabilityResponseSchema, body).teaching;
}

export async function prepareConversationTeaching(
  conversationId: string,
  input: PrepareConversationTeachingRequest,
): Promise<SafeRelayTeachingState> {
  const body = await requestJson(
    `${conversationTeachingUrl(conversationId)}/prepare`,
    {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify(
        prepareConversationTeachingRequestSchema.parse(input),
      ),
    },
  );
  return parseResponse(conversationTeachingStateResponseSchema, body).teaching;
}

export async function muteConversationTeaching(
  conversationId: string,
): Promise<SafeRelayTeachingState> {
  const body = await requestJson(
    `${conversationTeachingUrl(conversationId)}/mute`,
    {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify(muteConversationTeachingRequestSchema.parse({})),
    },
  );
  return parseResponse(conversationTeachingStateResponseSchema, body).teaching;
}

export async function persistThenMuteTeaching(
  conversationId: string,
  actions: {
    sendRelayMute: () => void;
    stopOnFailure: () => void | Promise<void>;
    persist?: (conversationId: string) => Promise<SafeRelayTeachingState>;
  },
): Promise<SafeRelayTeachingState> {
  try {
    const state = await (actions.persist ?? muteConversationTeaching)(
      conversationId,
    );
    actions.sendRelayMute();
    return state;
  } catch (error) {
    try {
      await actions.stopOnFailure();
    } catch {
      // Preserve the persistence/relay error that made continued audio unsafe.
    }
    throw error;
  }
}

function learningPlanUrl(childUserId: string, characterId: string): string {
  return `/api/teaching/plans/${encodeURIComponent(childUserId)}/${encodeURIComponent(characterId)}`;
}

function conversationTeachingUrl(conversationId: string): string {
  return `/api/conversations/${encodeURIComponent(conversationId)}/teaching`;
}

async function requestJson(
  url: string,
  init: RequestInit = {},
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, {
      credentials: "same-origin",
      cache: "no-store",
      ...init,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw error;
    }
    throw new TeachingApiError(null);
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new TeachingApiError(response.status, "INVALID_TEACHING_RESPONSE");
  }
  if (!response.ok) {
    const parsedError = apiErrorSchema.safeParse(body);
    throw new TeachingApiError(
      response.status,
      parsedError.success ? parsedError.data.code : undefined,
    );
  }
  return body;
}

function parseResponse<T>(
  schema: {
    safeParse: (
      value: unknown,
    ) => { success: true; data: T } | { success: false };
  },
  input: unknown,
): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    throw new TeachingApiError(null, "INVALID_TEACHING_RESPONSE");
  }
  return parsed.data;
}
