import { describe, expect, it } from "vitest";

import {
  bindDeviceRequestSchema,
  companionDeviceListResponseSchema,
  companionDeviceSummarySchema,
  createPairingSessionResponseSchema,
  pairingSessionStatusResponseSchema,
  updateDeviceMeRequestSchema,
  deviceFirmwareQuerySchema,
  deviceFirmwareResponseSchema,
} from "./devices.js";

const deviceId = "4d1c2e31-ad0e-4fa9-9ae8-ae3497069210";
const sessionId = "4d1c2e31-ad0e-4fa9-9ae8-ae3497069211";
const characterId = "4d1c2e31-ad0e-4fa9-9ae8-ae3497069212";

describe("devices protocol", () => {
  it("parses create pairing session responses", () => {
    expect(
      createPairingSessionResponseSchema.parse({
        pairingSessionId: sessionId,
        code: "123456",
        expiresAt: "2026-09-14T00:05:00.000Z",
      }),
    ).toEqual({
      pairingSessionId: sessionId,
      code: "123456",
      expiresAt: "2026-09-14T00:05:00.000Z",
    });
  });

  it("parses pending and claimed pairing status", () => {
    expect(
      pairingSessionStatusResponseSchema.parse({
        status: "pending",
        pairingSessionId: sessionId,
        expiresAt: "2026-09-14T00:05:00.000Z",
      }).status,
    ).toBe("pending");

    expect(
      pairingSessionStatusResponseSchema.parse({
        status: "claimed",
        pairingSessionId: sessionId,
        deviceId,
        deviceCredential: "device-credential-token",
        expiresAt: "2027-09-14T00:00:00.000Z",
      }),
    ).toMatchObject({
      status: "claimed",
      deviceId,
      deviceCredential: "device-credential-token",
    });
  });

  it("parses bind requests and device summaries", () => {
    expect(bindDeviceRequestSchema.parse({ code: "654321" })).toEqual({
      code: "654321",
    });
    expect(
      companionDeviceSummarySchema.parse({
        id: deviceId,
        displayName: "客厅音箱",
        selectedCharacterId: characterId,
        lastSeenAt: "2026-09-14T01:00:00.000Z",
        createdAt: "2026-09-14T00:00:00.000Z",
      }).displayName,
    ).toBe("客厅音箱");
    expect(
      companionDeviceListResponseSchema.parse({
        devices: [
          {
            id: deviceId,
            displayName: "客厅音箱",
            selectedCharacterId: null,
            lastSeenAt: "2026-09-14T01:00:00.000Z",
            createdAt: "2026-09-14T00:00:00.000Z",
          },
        ],
      }).devices,
    ).toHaveLength(1);
  });

  it("parses update device me requests", () => {
    expect(
      updateDeviceMeRequestSchema.parse({
        selectedCharacterId: characterId,
      }),
    ).toEqual({ selectedCharacterId: characterId });
    expect(
      updateDeviceMeRequestSchema.parse({ selectedCharacterId: null }),
    ).toEqual({ selectedCharacterId: null });
    expect(
      updateDeviceMeRequestSchema.parse({
        serial: "MEET-AABBCC",
        firmwareVersion: "0.2.0",
      }),
    ).toEqual({ serial: "MEET-AABBCC", firmwareVersion: "0.2.0" });
  });

  it("parses firmware query and response", () => {
    expect(
      deviceFirmwareQuerySchema.parse({
        current: "0.2.0",
        serial: "MEET-AABBCC",
      }),
    ).toEqual({ current: "0.2.0", serial: "MEET-AABBCC" });
    expect(
      deviceFirmwareResponseSchema.parse({
        available: true,
        version: "0.2.1",
        url: "https://example.com/meet.bin",
        sha256: "aa".repeat(32),
        size: 1024,
        force: false,
      }),
    ).toMatchObject({ available: true, version: "0.2.1" });
  });
});
