import {
  companionDevices,
  deviceCredentials,
  devicePairingSessions,
  userAccounts,
  type Database,
} from "@meet/database";
import { and, desc, eq, gt, isNull } from "drizzle-orm";

import type { AuthUserRecord } from "../auth/repository.js";
import type {
  AuthenticateDeviceCredentialResult,
  ClaimPairingSessionInput,
  ClaimPairingSessionResult,
  CompanionDeviceRecord,
  CreatePairingSessionInput,
  DeliverPairingCredentialResult,
  DevicePairingSessionRecord,
  DeviceRepository,
} from "./repository.js";

export class PostgresDeviceRepository implements DeviceRepository {
  constructor(private readonly db: Database) {}

  async createPairingSession(
    input: CreatePairingSessionInput,
  ): Promise<DevicePairingSessionRecord> {
    const [row] = await this.db
      .insert(devicePairingSessions)
      .values({
        id: input.id,
        codeHash: input.codeHash,
        devicePublicId: input.devicePublicId,
        displayName: input.displayName,
        expiresAt: input.expiresAt,
        createdAt: input.createdAt,
      })
      .returning();
    if (!row) {
      throw new Error("Failed to create device pairing session.");
    }
    return toPairingSession(row);
  }

  async findPairingSessionById(
    id: string,
  ): Promise<DevicePairingSessionRecord | null> {
    const [row] = await this.db
      .select()
      .from(devicePairingSessions)
      .where(eq(devicePairingSessions.id, id))
      .limit(1);
    return row ? toPairingSession(row) : null;
  }

  async claimPairingSession(
    input: ClaimPairingSessionInput,
  ): Promise<ClaimPairingSessionResult> {
    return this.db.transaction(async (tx) => {
      const [session] = await tx
        .select()
        .from(devicePairingSessions)
        .where(eq(devicePairingSessions.codeHash, input.codeHash))
        .limit(1);
      if (!session) return { kind: "not_found" };
      if (session.claimedAt) return { kind: "already_claimed" };
      if (session.expiresAt.getTime() <= input.claimedAt.getTime()) {
        return { kind: "expired" };
      }

      const existing = await tx
        .select()
        .from(companionDevices)
        .where(eq(companionDevices.id, session.devicePublicId))
        .limit(1);
      const existingDevice = existing[0] ?? null;

      let device: CompanionDeviceRecord;
      if (existingDevice) {
        await tx
          .update(deviceCredentials)
          .set({ revokedAt: input.claimedAt })
          .where(
            and(
              eq(deviceCredentials.deviceId, existingDevice.id),
              isNull(deviceCredentials.revokedAt),
            ),
          );
        const [updated] = await tx
          .update(companionDevices)
          .set({
            userId: input.userId,
            displayName: session.displayName,
            updatedAt: input.claimedAt,
            lastSeenAt: input.claimedAt,
          })
          .where(eq(companionDevices.id, existingDevice.id))
          .returning();
        if (!updated) return { kind: "not_found" };
        device = toDevice(updated);
      } else {
        const [created] = await tx
          .insert(companionDevices)
          .values({
            id: session.devicePublicId,
            userId: input.userId,
            displayName: session.displayName,
            selectedCharacterId: null,
            lastSeenAt: input.claimedAt,
            createdAt: input.claimedAt,
            updatedAt: input.claimedAt,
          })
          .returning();
        if (!created) return { kind: "not_found" };
        device = toDevice(created);
      }

      await tx.insert(deviceCredentials).values({
        id: input.credentialId,
        deviceId: device.id,
        tokenHash: input.credentialTokenHash,
        expiresAt: input.credentialExpiresAt,
        createdAt: input.claimedAt,
      });

      const [claimed] = await tx
        .update(devicePairingSessions)
        .set({
          claimedAt: input.claimedAt,
          claimedByUserId: input.userId,
          pendingDeviceCredential: input.credentialPlaintext,
          credentialDeliveredAt: null,
        })
        .where(
          and(
            eq(devicePairingSessions.id, session.id),
            isNull(devicePairingSessions.claimedAt),
          ),
        )
        .returning();
      if (!claimed) return { kind: "already_claimed" };

      return {
        kind: "claimed",
        device,
        credentialExpiresAt: input.credentialExpiresAt,
      };
    });
  }

  async deliverPairingCredential(
    pairingSessionId: string,
    deliveredAt: Date,
  ): Promise<DeliverPairingCredentialResult> {
    return this.db.transaction(async (tx) => {
      const [session] = await tx
        .select()
        .from(devicePairingSessions)
        .where(eq(devicePairingSessions.id, pairingSessionId))
        .limit(1);
      if (!session) return { kind: "not_found" };
      if (!session.claimedAt) {
        if (session.expiresAt.getTime() <= deliveredAt.getTime()) {
          return { kind: "expired" };
        }
        return {
          kind: "pending",
          pairingSessionId: session.id,
          expiresAt: session.expiresAt,
        };
      }
      if (
        session.credentialDeliveredAt ||
        !session.pendingDeviceCredential
      ) {
        return { kind: "delivered" };
      }

      const credential = session.pendingDeviceCredential;
      const [updated] = await tx
        .update(devicePairingSessions)
        .set({
          pendingDeviceCredential: null,
          credentialDeliveredAt: deliveredAt,
        })
        .where(
          and(
            eq(devicePairingSessions.id, session.id),
            isNull(devicePairingSessions.credentialDeliveredAt),
          ),
        )
        .returning();
      if (!updated || !credential) return { kind: "delivered" };

      const [credentialRow] = await tx
        .select({ expiresAt: deviceCredentials.expiresAt })
        .from(deviceCredentials)
        .where(eq(deviceCredentials.deviceId, session.devicePublicId))
        .orderBy(desc(deviceCredentials.createdAt))
        .limit(1);

      return {
        kind: "claimed",
        pairingSessionId: session.id,
        deviceId: session.devicePublicId,
        deviceCredential: credential,
        expiresAt: credentialRow?.expiresAt ?? session.expiresAt,
      };
    });
  }

  async listDevicesForUser(userId: string): Promise<CompanionDeviceRecord[]> {
    const rows = await this.db
      .select()
      .from(companionDevices)
      .where(eq(companionDevices.userId, userId))
      .orderBy(desc(companionDevices.createdAt));
    return rows.map(toDevice);
  }

  async findDeviceForUser(
    userId: string,
    deviceId: string,
  ): Promise<CompanionDeviceRecord | null> {
    const [row] = await this.db
      .select()
      .from(companionDevices)
      .where(
        and(
          eq(companionDevices.id, deviceId),
          eq(companionDevices.userId, userId),
        ),
      )
      .limit(1);
    return row ? toDevice(row) : null;
  }

  async revokeDevice(
    userId: string,
    deviceId: string,
    revokedAt: Date,
  ): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const [device] = await tx
        .select()
        .from(companionDevices)
        .where(
          and(
            eq(companionDevices.id, deviceId),
            eq(companionDevices.userId, userId),
          ),
        )
        .limit(1);
      if (!device) return false;
      await tx
        .update(deviceCredentials)
        .set({ revokedAt })
        .where(
          and(
            eq(deviceCredentials.deviceId, deviceId),
            isNull(deviceCredentials.revokedAt),
          ),
        );
      await tx
        .delete(companionDevices)
        .where(eq(companionDevices.id, deviceId));
      return true;
    });
  }

  async updateDeviceSelection(input: {
    deviceId: string;
    userId: string;
    selectedCharacterId?: string | null;
    serial?: string;
    firmwareVersion?: string;
    updatedAt: Date;
  }): Promise<CompanionDeviceRecord | null> {
    const patch: {
      updatedAt: Date;
      selectedCharacterId?: string | null;
      serial?: string;
      firmwareVersion?: string;
    } = { updatedAt: input.updatedAt };
    if (input.selectedCharacterId !== undefined) {
      patch.selectedCharacterId = input.selectedCharacterId;
    }
    if (input.serial !== undefined) {
      patch.serial = input.serial;
    }
    if (input.firmwareVersion !== undefined) {
      patch.firmwareVersion = input.firmwareVersion;
    }
    const [row] = await this.db
      .update(companionDevices)
      .set(patch)
      .where(
        and(
          eq(companionDevices.id, input.deviceId),
          eq(companionDevices.userId, input.userId),
        ),
      )
      .returning();
    return row ? toDevice(row) : null;
  }

  async findUserByDeviceCredentialTokenHash(
    tokenHash: string,
    now: Date,
  ): Promise<AuthenticateDeviceCredentialResult> {
    const [result] = await this.db
      .select({
        user: userAccounts,
        deviceId: companionDevices.id,
      })
      .from(deviceCredentials)
      .innerJoin(
        companionDevices,
        eq(companionDevices.id, deviceCredentials.deviceId),
      )
      .innerJoin(userAccounts, eq(userAccounts.id, companionDevices.userId))
      .where(
        and(
          eq(deviceCredentials.tokenHash, tokenHash),
          isNull(deviceCredentials.revokedAt),
          gt(deviceCredentials.expiresAt, now),
        ),
      )
      .limit(1);
    if (!result) return null;
    return {
      user: toAuthUser(result.user),
      deviceId: result.deviceId,
    };
  }

  async touchDeviceLastSeen(deviceId: string, seenAt: Date): Promise<void> {
    await this.db
      .update(companionDevices)
      .set({ lastSeenAt: seenAt, updatedAt: seenAt })
      .where(eq(companionDevices.id, deviceId));
  }
}

function toPairingSession(
  row: typeof devicePairingSessions.$inferSelect,
): DevicePairingSessionRecord {
  return {
    id: row.id,
    codeHash: row.codeHash,
    devicePublicId: row.devicePublicId,
    displayName: row.displayName,
    expiresAt: row.expiresAt,
    claimedAt: row.claimedAt,
    claimedByUserId: row.claimedByUserId,
    pendingDeviceCredential: row.pendingDeviceCredential,
    credentialDeliveredAt: row.credentialDeliveredAt,
    createdAt: row.createdAt,
  };
}

function toDevice(
  row: typeof companionDevices.$inferSelect,
): CompanionDeviceRecord {
  return {
    id: row.id,
    userId: row.userId,
    displayName: row.displayName,
    selectedCharacterId: row.selectedCharacterId,
    serial: row.serial ?? null,
    firmwareVersion: row.firmwareVersion ?? null,
    lastSeenAt: row.lastSeenAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toAuthUser(
  user: typeof userAccounts.$inferSelect,
): AuthUserRecord {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    accountType: user.accountType,
    status: user.status,
    guardianHistoryAccess: user.guardianHistoryAccess,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}
