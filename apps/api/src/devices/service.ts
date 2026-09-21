import type {
  CompanionDeviceSummary,
  CreatePairingSessionResponse,
  DeviceFirmwareResponse,
  PairingSessionStatusResponse,
  UpdateDeviceMeRequest,
  UserAccount,
} from "@meet/protocol";
import type { AppConfig } from "../config.js";
import { randomInt, randomUUID } from "node:crypto";

import {
  createSessionToken,
  hashSessionToken,
} from "../auth/session-token.js";
import type { DeviceRepository } from "./repository.js";
import { toDeviceSummary, toPublicUser } from "./repository.js";

export const PAIRING_CODE_TTL_MS = 5 * 60 * 1_000;
export const DEVICE_CREDENTIAL_TTL_MS = 365 * 24 * 60 * 60 * 1_000;

export type DeviceServiceErrorCode =
  | "AUTHENTICATION_REQUIRED"
  | "DEVICE_AUTH_REQUIRED"
  | "SESSION_AUTH_REQUIRED"
  | "PAIRING_SESSION_NOT_FOUND"
  | "PAIRING_CODE_INVALID"
  | "PAIRING_CODE_EXPIRED"
  | "PAIRING_ALREADY_CLAIMED"
  | "PAIRING_CREDENTIAL_DELIVERED"
  | "DEVICE_NOT_FOUND"
  | "DEVICE_SERVICE_UNAVAILABLE";

export class DeviceServiceError extends Error {
  constructor(
    readonly code: DeviceServiceErrorCode,
    message: string,
    readonly statusCode: number,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "DeviceServiceError";
  }
}

export class DeviceService {
  constructor(
    private readonly repository: DeviceRepository | null,
    private readonly now: () => Date = () => new Date(),
    private readonly firmware?: AppConfig["firmware"],
  ) {}

  async createPairingSession(input?: {
    displayName?: string;
  }): Promise<CreatePairingSessionResponse> {
    const createdAt = this.now();
    const expiresAt = new Date(createdAt.getTime() + PAIRING_CODE_TTL_MS);
    const code = createPairingCode();
    const id = randomUUID();
    const devicePublicId = randomUUID();
    const displayName = input?.displayName?.trim() || "陪伴设备";

    await this.callRepository((repository) =>
      repository.createPairingSession({
        id,
        codeHash: hashSessionToken(code),
        devicePublicId,
        displayName,
        expiresAt,
        createdAt,
      }),
    );

    return {
      pairingSessionId: id,
      code,
      expiresAt: expiresAt.toISOString(),
    };
  }

  async getPairingSession(
    pairingSessionId: string,
  ): Promise<PairingSessionStatusResponse> {
    const deliveredAt = this.now();
    const result = await this.callRepository((repository) =>
      repository.deliverPairingCredential(pairingSessionId, deliveredAt),
    );

    switch (result.kind) {
      case "pending":
        return {
          status: "pending",
          pairingSessionId: result.pairingSessionId,
          expiresAt: result.expiresAt.toISOString(),
        };
      case "claimed":
        return {
          status: "claimed",
          pairingSessionId: result.pairingSessionId,
          deviceId: result.deviceId,
          deviceCredential: result.deviceCredential,
          expiresAt: result.expiresAt.toISOString(),
        };
      case "delivered":
        throw new DeviceServiceError(
          "PAIRING_CREDENTIAL_DELIVERED",
          "配对凭证已领取，请使用设备凭证访问。",
          409,
        );
      case "expired":
        throw new DeviceServiceError(
          "PAIRING_CODE_EXPIRED",
          "配对码已过期，请在设备上重新发起配对。",
          410,
        );
      case "not_found":
        throw new DeviceServiceError(
          "PAIRING_SESSION_NOT_FOUND",
          "找不到该配对会话。",
          404,
        );
    }
  }

  async bindByCode(
    actor: UserAccount,
    code: string,
  ): Promise<CompanionDeviceSummary> {
    const claimedAt = this.now();
    const credentialPlaintext = createSessionToken();
    const result = await this.callRepository((repository) =>
      repository.claimPairingSession({
        codeHash: hashSessionToken(code),
        userId: actor.id,
        claimedAt,
        credentialId: randomUUID(),
        credentialTokenHash: hashSessionToken(credentialPlaintext),
        credentialPlaintext,
        credentialExpiresAt: new Date(
          claimedAt.getTime() + DEVICE_CREDENTIAL_TTL_MS,
        ),
      }),
    );

    switch (result.kind) {
      case "claimed":
        return toDeviceSummary(result.device);
      case "not_found":
        throw new DeviceServiceError(
          "PAIRING_CODE_INVALID",
          "配对码无效，请核对后重试。",
          404,
        );
      case "expired":
        throw new DeviceServiceError(
          "PAIRING_CODE_EXPIRED",
          "配对码已过期，请在设备上重新发起配对。",
          410,
        );
      case "already_claimed":
        throw new DeviceServiceError(
          "PAIRING_ALREADY_CLAIMED",
          "该配对码已被使用。",
          409,
        );
    }
  }

  async listDevices(actor: UserAccount): Promise<CompanionDeviceSummary[]> {
    const devices = await this.callRepository((repository) =>
      repository.listDevicesForUser(actor.id),
    );
    return devices.map(toDeviceSummary);
  }

  async revokeDevice(actor: UserAccount, deviceId: string): Promise<void> {
    const revoked = await this.callRepository((repository) =>
      repository.revokeDevice(actor.id, deviceId, this.now()),
    );
    if (!revoked) {
      throw new DeviceServiceError(
        "DEVICE_NOT_FOUND",
        "找不到该陪伴设备。",
        404,
      );
    }
  }

  async updateMe(
    actor: UserAccount,
    deviceId: string,
    input: UpdateDeviceMeRequest,
  ): Promise<CompanionDeviceSummary> {
    const updated = await this.callRepository((repository) =>
      repository.updateDeviceSelection({
        deviceId,
        userId: actor.id,
        selectedCharacterId: input.selectedCharacterId,
        serial: input.serial,
        firmwareVersion: input.firmwareVersion,
        updatedAt: this.now(),
      }),
    );
    if (!updated) {
      throw new DeviceServiceError(
        "DEVICE_NOT_FOUND",
        "找不到该陪伴设备。",
        404,
      );
    }
    return toDeviceSummary(updated);
  }

  async authenticateCredential(
    token: string | undefined,
  ): Promise<{ user: UserAccount; deviceId: string }> {
    if (!token) {
      throw new DeviceServiceError(
        "AUTHENTICATION_REQUIRED",
        "请先完成设备配对。",
        401,
      );
    }

    const result = await this.callRepository((repository) =>
      repository.findUserByDeviceCredentialTokenHash(
        hashSessionToken(token),
        this.now(),
      ),
    );
    if (!result || result.user.status !== "active") {
      throw new DeviceServiceError(
        "AUTHENTICATION_REQUIRED",
        "设备凭证已失效。",
        401,
      );
    }

    void this.callRepository((repository) =>
      repository.touchDeviceLastSeen(result.deviceId, this.now()),
    ).catch(() => undefined);

    return {
      user: toPublicUser(result.user),
      deviceId: result.deviceId,
    };
  }

  checkFirmware(current: string): DeviceFirmwareResponse {
    if (!this.firmware?.version || !this.firmware.url) {
      return {
        available: false,
        version: current,
        url: "",
        sha256: "",
        size: 0,
        force: false,
      };
    }
    return {
      available: this.firmware.version !== current,
      version: this.firmware.version,
      url: this.firmware.url,
      sha256: this.firmware.sha256,
      size: this.firmware.size,
      force: this.firmware.force,
    };
  }

  private async callRepository<T>(
    operation: (repository: DeviceRepository) => Promise<T>,
  ): Promise<T> {
    const repository = this.repository;
    if (!repository) {
      throw new DeviceServiceError(
        "DEVICE_SERVICE_UNAVAILABLE",
        "设备服务暂时不可用。",
        503,
      );
    }
    try {
      return await operation(repository);
    } catch (error) {
      if (error instanceof DeviceServiceError) throw error;
      throw new DeviceServiceError(
        "DEVICE_SERVICE_UNAVAILABLE",
        "设备服务暂时不可用。",
        503,
        { cause: error },
      );
    }
  }
}

function createPairingCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}
