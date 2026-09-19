import { z } from "zod";

export const pairingCodeSchema = z
  .string()
  .trim()
  .regex(/^\d{6}$/, "配对码须为 6 位数字。");

export type PairingCode = z.infer<typeof pairingCodeSchema>;

export const createPairingSessionRequestSchema = z
  .object({
    displayName: z.string().trim().min(1).max(80).optional(),
  })
  .strict();

export type CreatePairingSessionRequest = z.infer<
  typeof createPairingSessionRequestSchema
>;

export const createPairingSessionResponseSchema = z
  .object({
    pairingSessionId: z.uuid(),
    code: pairingCodeSchema,
    expiresAt: z.iso.datetime(),
  })
  .strict();

export type CreatePairingSessionResponse = z.infer<
  typeof createPairingSessionResponseSchema
>;

export const pairingSessionPendingStatusSchema = z
  .object({
    status: z.literal("pending"),
    pairingSessionId: z.uuid(),
    expiresAt: z.iso.datetime(),
  })
  .strict();

export const pairingSessionClaimedStatusSchema = z
  .object({
    status: z.literal("claimed"),
    pairingSessionId: z.uuid(),
    deviceId: z.uuid(),
    deviceCredential: z.string().min(1).max(256),
    expiresAt: z.iso.datetime(),
  })
  .strict();

export const pairingSessionStatusResponseSchema = z.discriminatedUnion(
  "status",
  [pairingSessionPendingStatusSchema, pairingSessionClaimedStatusSchema],
);

export type PairingSessionStatusResponse = z.infer<
  typeof pairingSessionStatusResponseSchema
>;

export const bindDeviceRequestSchema = z
  .object({
    code: pairingCodeSchema,
  })
  .strict();

export type BindDeviceRequest = z.infer<typeof bindDeviceRequestSchema>;

export const companionDeviceSummarySchema = z
  .object({
    id: z.uuid(),
    displayName: z.string().trim().min(1).max(80),
    selectedCharacterId: z.uuid().nullable(),
    lastSeenAt: z.iso.datetime(),
    createdAt: z.iso.datetime(),
  })
  .strict();

export type CompanionDeviceSummary = z.infer<
  typeof companionDeviceSummarySchema
>;

export const companionDeviceListResponseSchema = z
  .object({
    devices: z.array(companionDeviceSummarySchema),
  })
  .strict();

export type CompanionDeviceListResponse = z.infer<
  typeof companionDeviceListResponseSchema
>;

export const bindDeviceResponseSchema = z
  .object({
    device: companionDeviceSummarySchema,
  })
  .strict();

export type BindDeviceResponse = z.infer<typeof bindDeviceResponseSchema>;

export const updateDeviceMeRequestSchema = z
  .object({
    selectedCharacterId: z.uuid().nullable(),
  })
  .strict();

export type UpdateDeviceMeRequest = z.infer<typeof updateDeviceMeRequestSchema>;

export const updateDeviceMeResponseSchema = z
  .object({
    device: companionDeviceSummarySchema,
  })
  .strict();

export type UpdateDeviceMeResponse = z.infer<
  typeof updateDeviceMeResponseSchema
>;

export const deviceIdParamsSchema = z
  .object({
    id: z.uuid(),
  })
  .strict();

export const pairingSessionIdParamsSchema = z
  .object({
    id: z.uuid(),
  })
  .strict();

export const revokeDeviceResponseSchema = z
  .object({
    ok: z.literal(true),
  })
  .strict();
