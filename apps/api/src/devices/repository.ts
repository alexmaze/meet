import type { CompanionDeviceSummary, UserAccount } from "@meet/protocol";

import type { AuthUserRecord } from "../auth/repository.js";

export type DevicePairingSessionRecord = {
  id: string;
  codeHash: string;
  devicePublicId: string;
  displayName: string;
  expiresAt: Date;
  claimedAt: Date | null;
  claimedByUserId: string | null;
  pendingDeviceCredential: string | null;
  credentialDeliveredAt: Date | null;
  createdAt: Date;
};

export type CompanionDeviceRecord = {
  id: string;
  userId: string;
  displayName: string;
  selectedCharacterId: string | null;
  serial: string | null;
  firmwareVersion: string | null;
  lastSeenAt: Date;
  createdAt: Date;
  updatedAt: Date;
};

export type DeviceCredentialRecord = {
  id: string;
  deviceId: string;
  tokenHash: string;
  expiresAt: Date;
  revokedAt: Date | null;
  createdAt: Date;
};

export type CreatePairingSessionInput = {
  id: string;
  codeHash: string;
  devicePublicId: string;
  displayName: string;
  expiresAt: Date;
  createdAt: Date;
};

export type ClaimPairingSessionInput = {
  codeHash: string;
  userId: string;
  claimedAt: Date;
  credentialId: string;
  credentialTokenHash: string;
  credentialPlaintext: string;
  credentialExpiresAt: Date;
};

export type ClaimPairingSessionResult =
  | {
      kind: "claimed";
      device: CompanionDeviceRecord;
      credentialExpiresAt: Date;
    }
  | { kind: "not_found" }
  | { kind: "expired" }
  | { kind: "already_claimed" };

export type DeliverPairingCredentialResult =
  | {
      kind: "pending";
      pairingSessionId: string;
      expiresAt: Date;
    }
  | {
      kind: "claimed";
      pairingSessionId: string;
      deviceId: string;
      deviceCredential: string;
      expiresAt: Date;
    }
  | { kind: "delivered" }
  | { kind: "not_found" }
  | { kind: "expired" };

export type AuthenticateDeviceCredentialResult = {
  user: AuthUserRecord;
  deviceId: string;
} | null;

export interface DeviceRepository {
  createPairingSession(
    input: CreatePairingSessionInput,
  ): Promise<DevicePairingSessionRecord>;
  findPairingSessionById(
    id: string,
  ): Promise<DevicePairingSessionRecord | null>;
  claimPairingSession(
    input: ClaimPairingSessionInput,
  ): Promise<ClaimPairingSessionResult>;
  deliverPairingCredential(
    pairingSessionId: string,
    deliveredAt: Date,
  ): Promise<DeliverPairingCredentialResult>;
  listDevicesForUser(userId: string): Promise<CompanionDeviceRecord[]>;
  findDeviceForUser(
    userId: string,
    deviceId: string,
  ): Promise<CompanionDeviceRecord | null>;
  revokeDevice(
    userId: string,
    deviceId: string,
    revokedAt: Date,
  ): Promise<boolean>;
  updateDeviceSelection(input: {
    deviceId: string;
    userId: string;
    selectedCharacterId?: string | null;
    serial?: string;
    firmwareVersion?: string;
    updatedAt: Date;
  }): Promise<CompanionDeviceRecord | null>;
  findUserByDeviceCredentialTokenHash(
    tokenHash: string,
    now: Date,
  ): Promise<AuthenticateDeviceCredentialResult>;
  touchDeviceLastSeen(deviceId: string, seenAt: Date): Promise<void>;
}

export function toDeviceSummary(
  device: CompanionDeviceRecord,
): CompanionDeviceSummary {
  return {
    id: device.id,
    displayName: device.displayName,
    selectedCharacterId: device.selectedCharacterId,
    serial: device.serial,
    firmwareVersion: device.firmwareVersion,
    lastSeenAt: device.lastSeenAt.toISOString(),
    createdAt: device.createdAt.toISOString(),
  };
}

export function toPublicUser(user: AuthUserRecord): UserAccount {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    accountType: user.accountType,
    status: user.status,
    guardianHistoryAccess: user.guardianHistoryAccess,
    createdAt: user.createdAt.toISOString(),
    updatedAt: user.updatedAt.toISOString(),
  };
}
