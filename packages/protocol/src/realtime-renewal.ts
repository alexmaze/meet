import { z } from "zod";

const eventIdSchema = z.string().min(1).max(160);

/** Local relay controls; none of these frames may reach a model provider. */
export const realtimeRenewalClientFrameSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("relay.renewal_prepare"),
      event_id: eventIdSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("relay.renewal_cancel"),
      event_id: eventIdSchema,
    })
    .strict(),
]);

export const realtimeRenewalServerFrameSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("relay.renewal_due"),
      reason: z.enum(["connection_age", "context_refresh"]),
      remainingMs: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      type: z.literal("relay.renewal_ready"),
      event_id: eventIdSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("relay.renewal_deferred"),
      event_id: eventIdSchema,
    })
    .strict(),
]);

export type RealtimeRenewalClientFrame = z.infer<
  typeof realtimeRenewalClientFrameSchema
>;
export type RealtimeRenewalServerFrame = z.infer<
  typeof realtimeRenewalServerFrameSchema
>;
