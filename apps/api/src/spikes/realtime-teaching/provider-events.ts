import {
  doubaoRealtimeModelSchema,
  type DoubaoRealtimeModel,
} from "@meet/protocol";
import { z } from "zod";

import { buildDoubaoSessionConfig } from "../../doubao-session.js";

const spikeEventIdSchema = z.string().trim().min(1).max(160);
const spikeInstructionsSchema = z.string().trim().min(1).max(12_000);

export const qwenInstructionsPatchEventSchema = z
  .object({
    event_id: spikeEventIdSchema,
    type: z.literal("session.update"),
    session: z.object({ instructions: spikeInstructionsSchema }).strict(),
  })
  .strict();

export type QwenInstructionsPatchEvent = z.infer<
  typeof qwenInstructionsPatchEventSchema
>;

const doubaoSessionConfigSchema = z
  .object({
    type: z.literal("realtime"),
    model: doubaoRealtimeModelSchema,
    instructions: spikeInstructionsSchema,
    audio: z
      .object({
        input: z
          .object({
            format: z
              .object({ type: z.literal("pcm"), rate: z.literal(16_000) })
              .strict(),
          })
          .strict(),
        output: z
          .object({
            format: z
              .object({
                type: z.literal("pcm_s16le"),
                rate: z.literal(24_000),
              })
              .strict(),
            voice: z.string().trim().min(1).max(160),
            speed: z.literal(0),
            loudness: z.literal(0),
          })
          .strict(),
      })
      .strict(),
  })
  .strict();

export const doubaoInstructionsUpdateEventSchema = z
  .object({
    event_id: spikeEventIdSchema,
    type: z.literal("session.update"),
    session: doubaoSessionConfigSchema,
  })
  .strict();

export type DoubaoInstructionsUpdateEvent = z.infer<
  typeof doubaoInstructionsUpdateEventSchema
>;

export const qwenInstructionsUpdatedAckSchema = z
  .object({
    event_id: z.string().optional(),
    type: z.literal("session.updated"),
    session: z
      .object({ instructions: z.string().optional() })
      .passthrough()
      .optional(),
  })
  .passthrough();

export const doubaoInstructionsUpdatedAckSchema = z
  .object({
    event_id: z.string().optional(),
    type: z.literal("session.updated"),
    session: z.object({}).passthrough().optional(),
  })
  .passthrough();

export function buildQwenInstructionsPatchEvent(input: {
  eventId: string;
  instructions: string;
}): QwenInstructionsPatchEvent {
  const instructions = requireInstructions(input.instructions);
  if (instructions.length > 12_000) {
    throw new TeachingSpikeProviderEventError("INSTRUCTIONS_TOO_LARGE");
  }
  return qwenInstructionsPatchEventSchema.parse({
    event_id: requireEventId(input.eventId),
    type: "session.update",
    session: { instructions },
  });
}

export function buildDoubaoInstructionsUpdateEvent(input: {
  eventId: string;
  model: DoubaoRealtimeModel;
  voice: string;
  instructions: string;
}): DoubaoInstructionsUpdateEvent {
  const instructions = requireInstructions(input.instructions);
  if (instructions.length > 12_000) {
    throw new TeachingSpikeProviderEventError("INSTRUCTIONS_TOO_LARGE");
  }
  const session = buildDoubaoSessionConfig(input.model, {
    voice: input.voice,
    instructions,
  });
  return doubaoInstructionsUpdateEventSchema.parse({
    event_id: requireEventId(input.eventId),
    type: "session.update",
    session,
  });
}

function requireEventId(value: string): string {
  const eventId = value.trim();
  if (!eventId || eventId.length > 160) {
    throw new TeachingSpikeProviderEventError("INVALID_EVENT_ID");
  }
  return eventId;
}

function requireInstructions(value: string): string {
  const instructions = value.trim();
  if (!instructions) {
    throw new TeachingSpikeProviderEventError("EMPTY_INSTRUCTIONS");
  }
  return instructions;
}

export class TeachingSpikeProviderEventError extends Error {
  constructor(
    public readonly code:
      "INVALID_EVENT_ID" | "EMPTY_INSTRUCTIONS" | "INSTRUCTIONS_TOO_LARGE",
  ) {
    super(code);
    this.name = "TeachingSpikeProviderEventError";
  }
}
