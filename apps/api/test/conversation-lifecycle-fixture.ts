import { vi } from "vitest";
import type { ConversationAggregate } from "@meet/database";
import type { ConversationRepository } from "../src/conversations/repository.js";

export function conversationLifecycleRepositoryFixture(
  aggregate?: ConversationAggregate,
): Pick<
  ConversationRepository,
  | "prepare"
  | "readLifecycle"
  | "overview"
  | "heartbeatWriter"
  | "attachConnection"
  | "heartbeatConnection"
  | "detachConnection"
> {
  return {
    prepare: vi.fn(async (_userId, _conversationId, input) => ({
      kind: "prepared" as const,
      writer: { clientId: input.clientId, epoch: 1 },
      hasConnected: false,
      runtimeSnapshot: null,
    })),
    readLifecycle: vi.fn(async () =>
      aggregate
        ? {
            aggregate,
            control: null,
            operation: null,
            characterAvailable: true,
            summary: { status: null, content: null },
            memory: { status: null, activeCount: 0, suggestedCount: 0 },
          }
        : null,
    ),
    overview: vi.fn(async () => ({ pending: [], recent: [] })),
    heartbeatWriter: vi.fn(async () => ({ kind: "renewed" as const })),
    attachConnection: vi.fn(async () => ({
      kind: "attached" as const,
      initial: true,
    })),
    heartbeatConnection: vi.fn(async () => ({ kind: "renewed" as const })),
    detachConnection: vi.fn(async () => undefined),
  };
}
