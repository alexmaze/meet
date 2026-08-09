import type {
  ConversationPolicy,
  PersonaDefinition,
  VisualProfile,
} from "@meet/protocol";
import { and, asc, eq, isNull, or, sql } from "drizzle-orm";

import { getBuiltinCharacterPreset } from "./character-presets.js";
import type { Database } from "./client.js";
import {
  characterAuditEvents,
  characters,
  providerProfiles,
  userAccounts,
  voiceProfiles,
  type CharacterRecord,
  type ProviderProfileRecord,
  type UserAccount,
  type VoiceProfileRecord,
} from "./schema.js";

export type CharacterAggregate = {
  character: CharacterRecord;
  providerProfile: ProviderProfileRecord;
  voiceProfile: VoiceProfileRecord;
};

export type CharacterCatalog = {
  providers: ProviderProfileRecord[];
  voices: VoiceProfileRecord[];
};

export type EditableCharacterValues = {
  name: string;
  description: string;
  persona: PersonaDefinition;
  openingLine: string | null;
  providerProfileId: string;
  voiceProfileId: string;
  conversationPolicy: ConversationPolicy;
  visualProfile: VisualProfile;
};

type MutationFailureKind =
  "not_found" | "forbidden" | "invalid_profile" | "revision_conflict";

export type CreateCharacterResult =
  | { kind: "created"; character: CharacterAggregate }
  | { kind: "forbidden" | "invalid_profile" };

export type UpdateCharacterResult =
  | { kind: "updated" | "unchanged"; character: CharacterAggregate }
  | { kind: MutationFailureKind };

export type DeleteCharacterResult =
  | { kind: "deleted" }
  | {
      kind:
        "not_found" | "forbidden" | "builtin_protected" | "revision_conflict";
    };

export type CopyCharacterResult =
  | { kind: "copied"; character: CharacterAggregate }
  | { kind: "not_found" | "forbidden" };

export type RestoreCharacterResult =
  | { kind: "restored"; character: CharacterAggregate }
  | { kind: "not_found" | "forbidden" | "not_builtin" };

export async function listVisibleCharacters(
  db: Database,
  actorUserId: string,
): Promise<CharacterAggregate[]> {
  return db
    .select(characterAggregateSelection)
    .from(characters)
    .innerJoin(
      providerProfiles,
      eq(characters.providerProfileId, providerProfiles.id),
    )
    .innerJoin(
      voiceProfiles,
      and(
        eq(characters.voiceProfileId, voiceProfiles.id),
        eq(voiceProfiles.providerProfileId, providerProfiles.id),
      ),
    )
    .where(visibleCharacterWhere(actorUserId))
    .orderBy(
      sql`case when ${characters.visibility} = 'builtin' then 0 when ${characters.visibility} = 'family' then 1 else 2 end`,
      asc(characters.name),
      asc(characters.id),
    );
}

export async function findVisibleCharacter(
  db: Database,
  actorUserId: string,
  characterId: string,
): Promise<CharacterAggregate | null> {
  const [character] = await db
    .select(characterAggregateSelection)
    .from(characters)
    .innerJoin(
      providerProfiles,
      eq(characters.providerProfileId, providerProfiles.id),
    )
    .innerJoin(
      voiceProfiles,
      and(
        eq(characters.voiceProfileId, voiceProfiles.id),
        eq(voiceProfiles.providerProfileId, providerProfiles.id),
      ),
    )
    .where(
      and(eq(characters.id, characterId), visibleCharacterWhere(actorUserId)),
    )
    .limit(1);
  return character ?? null;
}

export async function listCharacterCatalog(
  db: Database,
): Promise<CharacterCatalog> {
  const [providers, voices] = await Promise.all([
    db
      .select()
      .from(providerProfiles)
      .orderBy(asc(providerProfiles.displayName)),
    db.select().from(voiceProfiles).orderBy(asc(voiceProfiles.displayName)),
  ]);
  return { providers, voices };
}

export async function createCharacter(
  db: Database,
  input: EditableCharacterValues & {
    id?: string;
    actorUserId: string;
    createdAt?: Date;
  },
): Promise<CreateCharacterResult> {
  const createdAt = input.createdAt ?? new Date();
  return db.transaction(async (tx) => {
    const actor = await findActiveActor(tx, input.actorUserId, true);
    if (!actor || actor.accountType === "child") return { kind: "forbidden" };

    const profilePair = await findProfilePair(
      tx,
      input.providerProfileId,
      input.voiceProfileId,
    );
    if (!profilePair) return { kind: "invalid_profile" };

    const [created] = await tx
      .insert(characters)
      .values({
        ...(input.id === undefined ? {} : { id: input.id }),
        systemKey: null,
        systemVersion: null,
        ownerUserId: actor.id,
        visibility: actor.accountType === "admin" ? "family" : "private",
        name: input.name.trim(),
        description: input.description.trim(),
        persona: input.persona,
        openingLine: input.openingLine?.trim() || null,
        providerProfileId: input.providerProfileId,
        voiceProfileId: input.voiceProfileId,
        conversationPolicy: input.conversationPolicy,
        visualProfile: input.visualProfile,
        revision: 1,
        createdAt,
        updatedAt: createdAt,
      })
      .returning();
    if (!created) throw new Error("Failed to create character.");

    await tx.insert(characterAuditEvents).values({
      eventType: "created",
      actorUserId: actor.id,
      characterId: created.id,
      details: { revision: 1, visibility: created.visibility },
      createdAt,
    });

    return {
      kind: "created",
      character: { character: created, ...profilePair },
    };
  });
}

export async function updateCharacter(
  db: Database,
  input: {
    actorUserId: string;
    characterId: string;
    expectedRevision: number;
    changes: Partial<EditableCharacterValues>;
    updatedAt?: Date;
  },
): Promise<UpdateCharacterResult> {
  const updatedAt = input.updatedAt ?? new Date();
  return db.transaction(async (tx) => {
    const access = await lockWritableCharacter(
      tx,
      input.actorUserId,
      input.characterId,
    );
    if (access.kind !== "allowed") return access;
    if (access.character.revision !== input.expectedRevision) {
      return { kind: "revision_conflict" };
    }

    const providerProfileId =
      input.changes.providerProfileId ?? access.character.providerProfileId;
    const voiceProfileId =
      input.changes.voiceProfileId ?? access.character.voiceProfileId;
    const profilePair = await findProfilePair(
      tx,
      providerProfileId,
      voiceProfileId,
    );
    if (!profilePair) return { kind: "invalid_profile" };

    const nextRevision = access.character.revision + 1;
    const [updated] = await tx
      .update(characters)
      .set({
        ...input.changes,
        ...(input.changes.name === undefined
          ? {}
          : { name: input.changes.name.trim() }),
        ...(input.changes.description === undefined
          ? {}
          : { description: input.changes.description.trim() }),
        ...(input.changes.openingLine === undefined
          ? {}
          : { openingLine: input.changes.openingLine?.trim() || null }),
        revision: nextRevision,
        updatedAt,
      })
      .where(
        and(
          eq(characters.id, access.character.id),
          eq(characters.revision, input.expectedRevision),
          isNull(characters.deletedAt),
        ),
      )
      .returning();
    if (!updated) return { kind: "revision_conflict" };

    await tx.insert(characterAuditEvents).values({
      eventType: "updated",
      actorUserId: access.actor.id,
      characterId: updated.id,
      details: {
        previousRevision: access.character.revision,
        revision: nextRevision,
      },
      createdAt: updatedAt,
    });

    return {
      kind: "updated",
      character: { character: updated, ...profilePair },
    };
  });
}

export async function updateCharacterVisibility(
  db: Database,
  input: {
    actorUserId: string;
    characterId: string;
    expectedRevision: number;
    visibility: "private" | "family";
    updatedAt?: Date;
  },
): Promise<UpdateCharacterResult> {
  const updatedAt = input.updatedAt ?? new Date();
  return db.transaction(async (tx) => {
    const actor = await findActiveActor(tx, input.actorUserId, true);
    if (!actor || actor.accountType !== "adult") return { kind: "forbidden" };
    const target = await lockCharacter(tx, input.characterId);
    if (!target || target.deletedAt) return { kind: "not_found" };
    if (target.visibility === "private" && target.ownerUserId !== actor.id) {
      return { kind: "not_found" };
    }
    if (target.visibility === "builtin" || target.ownerUserId !== actor.id) {
      return { kind: "forbidden" };
    }
    if (target.revision !== input.expectedRevision) {
      return { kind: "revision_conflict" };
    }
    const profilePair = await findProfilePair(
      tx,
      target.providerProfileId,
      target.voiceProfileId,
    );
    if (!profilePair) throw new Error("Character profile pair is missing.");
    if (target.visibility === input.visibility) {
      return {
        kind: "unchanged",
        character: { character: target, ...profilePair },
      };
    }

    const nextRevision = target.revision + 1;
    const [updated] = await tx
      .update(characters)
      .set({
        visibility: input.visibility,
        revision: nextRevision,
        updatedAt,
      })
      .where(
        and(
          eq(characters.id, target.id),
          eq(characters.revision, input.expectedRevision),
          isNull(characters.deletedAt),
        ),
      )
      .returning();
    if (!updated) return { kind: "revision_conflict" };

    await tx.insert(characterAuditEvents).values({
      eventType: "visibility_changed",
      actorUserId: actor.id,
      characterId: target.id,
      details: {
        previousVisibility: target.visibility,
        visibility: input.visibility,
        previousRevision: target.revision,
        revision: nextRevision,
      },
      createdAt: updatedAt,
    });

    return {
      kind: "updated",
      character: { character: updated, ...profilePair },
    };
  });
}

export async function copyCharacter(
  db: Database,
  input: {
    actorUserId: string;
    sourceCharacterId: string;
    id?: string;
    createdAt?: Date;
  },
): Promise<CopyCharacterResult> {
  const createdAt = input.createdAt ?? new Date();
  return db.transaction(async (tx) => {
    const actor = await findActiveActor(tx, input.actorUserId, true);
    if (!actor || actor.accountType === "child") return { kind: "forbidden" };
    const source = await lockCharacter(tx, input.sourceCharacterId);
    if (!source || source.deletedAt) return { kind: "not_found" };
    if (source.visibility === "private" && source.ownerUserId !== actor.id) {
      return { kind: "not_found" };
    }

    const profilePair = await findProfilePair(
      tx,
      source.providerProfileId,
      source.voiceProfileId,
    );
    if (!profilePair) throw new Error("Source character profile is missing.");

    const [created] = await tx
      .insert(characters)
      .values({
        ...(input.id === undefined ? {} : { id: input.id }),
        systemKey: null,
        systemVersion: null,
        ownerUserId: actor.id,
        visibility: actor.accountType === "admin" ? "family" : "private",
        name: copyName(source.name),
        description: source.description,
        persona: source.persona,
        openingLine: source.openingLine,
        providerProfileId: source.providerProfileId,
        voiceProfileId: source.voiceProfileId,
        conversationPolicy: source.conversationPolicy,
        visualProfile: source.visualProfile,
        revision: 1,
        createdAt,
        updatedAt: createdAt,
      })
      .returning();
    if (!created) throw new Error("Failed to copy character.");

    await tx.insert(characterAuditEvents).values({
      eventType: "copied",
      actorUserId: actor.id,
      characterId: created.id,
      details: {
        sourceCharacterId: source.id,
        sourceRevision: source.revision,
        revision: 1,
        visibility: created.visibility,
      },
      createdAt,
    });
    return {
      kind: "copied",
      character: { character: created, ...profilePair },
    };
  });
}

export async function restoreBuiltinCharacter(
  db: Database,
  input: {
    actorUserId: string;
    characterId: string;
    restoredAt?: Date;
  },
): Promise<RestoreCharacterResult> {
  const restoredAt = input.restoredAt ?? new Date();
  return db.transaction(async (tx) => {
    const actor = await findActiveActor(tx, input.actorUserId, true);
    if (!actor || actor.accountType !== "admin") return { kind: "forbidden" };
    const target = await lockCharacter(tx, input.characterId);
    if (!target || target.deletedAt) return { kind: "not_found" };
    if (target.visibility === "private" && target.ownerUserId !== actor.id) {
      return { kind: "not_found" };
    }
    if (target.visibility !== "builtin" || !target.systemKey) {
      return { kind: "not_builtin" };
    }
    const preset = getBuiltinCharacterPreset(target.systemKey);
    if (!preset || preset.id !== target.id) {
      throw new Error("Builtin character preset is missing or mismatched.");
    }
    const profilePair = await findProfilePair(
      tx,
      preset.providerProfileId,
      preset.voiceProfileId,
    );
    if (!profilePair) throw new Error("Builtin profile pair is missing.");

    const nextRevision = target.revision + 1;
    const [restored] = await tx
      .update(characters)
      .set({
        systemVersion: preset.systemVersion,
        name: preset.name,
        description: preset.description,
        persona: preset.persona,
        openingLine: preset.openingLine,
        providerProfileId: preset.providerProfileId,
        voiceProfileId: preset.voiceProfileId,
        conversationPolicy: preset.conversationPolicy,
        visualProfile: preset.visualProfile,
        revision: nextRevision,
        updatedAt: restoredAt,
      })
      .where(
        and(
          eq(characters.id, target.id),
          eq(characters.revision, target.revision),
          eq(characters.visibility, "builtin"),
          isNull(characters.deletedAt),
        ),
      )
      .returning();
    if (!restored)
      throw new Error("Builtin character changed while restoring.");

    await tx.insert(characterAuditEvents).values({
      eventType: "restored",
      actorUserId: actor.id,
      characterId: restored.id,
      details: {
        systemKey: preset.systemKey,
        systemVersion: preset.systemVersion,
        previousRevision: target.revision,
        revision: nextRevision,
      },
      createdAt: restoredAt,
    });
    return {
      kind: "restored",
      character: { character: restored, ...profilePair },
    };
  });
}

export async function deleteCharacter(
  db: Database,
  input: {
    actorUserId: string;
    characterId: string;
    expectedRevision: number;
    deletedAt?: Date;
  },
): Promise<DeleteCharacterResult> {
  const deletedAt = input.deletedAt ?? new Date();
  return db.transaction(async (tx) => {
    const actor = await findActiveActor(tx, input.actorUserId, true);
    if (!actor || actor.accountType === "child") return { kind: "forbidden" };
    const target = await lockCharacter(tx, input.characterId);
    if (!target || target.deletedAt) return { kind: "not_found" };
    if (target.visibility === "private" && target.ownerUserId !== actor.id) {
      return { kind: "not_found" };
    }
    if (target.visibility === "builtin") return { kind: "builtin_protected" };
    if (target.ownerUserId !== actor.id) return { kind: "forbidden" };
    if (target.revision !== input.expectedRevision) {
      return { kind: "revision_conflict" };
    }

    const nextRevision = target.revision + 1;
    const [deleted] = await tx
      .update(characters)
      .set({ deletedAt, updatedAt: deletedAt, revision: nextRevision })
      .where(
        and(
          eq(characters.id, target.id),
          eq(characters.revision, input.expectedRevision),
          isNull(characters.deletedAt),
        ),
      )
      .returning({ id: characters.id });
    if (!deleted) return { kind: "revision_conflict" };

    await tx.insert(characterAuditEvents).values({
      eventType: "deleted",
      actorUserId: actor.id,
      characterId: target.id,
      details: {
        previousRevision: target.revision,
        revision: nextRevision,
        visibility: target.visibility,
      },
      createdAt: deletedAt,
    });
    return { kind: "deleted" };
  });
}

function visibleCharacterWhere(actorUserId: string) {
  return and(
    isNull(characters.deletedAt),
    or(
      eq(characters.visibility, "builtin"),
      eq(characters.visibility, "family"),
      and(
        eq(characters.visibility, "private"),
        eq(characters.ownerUserId, actorUserId),
      ),
    ),
  );
}

const characterAggregateSelection = {
  character: characters,
  providerProfile: providerProfiles,
  voiceProfile: voiceProfiles,
};

type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

async function findActiveActor(
  tx: Transaction,
  actorUserId: string,
  lock: boolean,
): Promise<UserAccount | null> {
  const baseQuery = tx
    .select()
    .from(userAccounts)
    .where(
      and(eq(userAccounts.id, actorUserId), eq(userAccounts.status, "active")),
    );
  const rows = lock
    ? await baseQuery.for("update").limit(1)
    : await baseQuery.limit(1);
  return rows[0] ?? null;
}

async function lockCharacter(
  tx: Transaction,
  characterId: string,
): Promise<CharacterRecord | null> {
  const [character] = await tx
    .select()
    .from(characters)
    .where(eq(characters.id, characterId))
    .for("update")
    .limit(1);
  return character ?? null;
}

async function lockWritableCharacter(
  tx: Transaction,
  actorUserId: string,
  characterId: string,
): Promise<
  | { kind: "allowed"; actor: UserAccount; character: CharacterRecord }
  | { kind: "not_found" | "forbidden" }
> {
  const actor = await findActiveActor(tx, actorUserId, true);
  if (!actor || actor.accountType === "child") return { kind: "forbidden" };
  const target = await lockCharacter(tx, characterId);
  if (!target || target.deletedAt) return { kind: "not_found" };
  if (target.visibility === "private" && target.ownerUserId !== actor.id) {
    return { kind: "not_found" };
  }
  if (target.visibility === "builtin") {
    return actor.accountType === "admin"
      ? { kind: "allowed", actor, character: target }
      : { kind: "forbidden" };
  }
  return target.ownerUserId === actor.id
    ? { kind: "allowed", actor, character: target }
    : { kind: "forbidden" };
}

async function findProfilePair(
  tx: Transaction,
  providerProfileId: string,
  voiceProfileId: string,
): Promise<{
  providerProfile: ProviderProfileRecord;
  voiceProfile: VoiceProfileRecord;
} | null> {
  const [pair] = await tx
    .select({ providerProfile: providerProfiles, voiceProfile: voiceProfiles })
    .from(providerProfiles)
    .innerJoin(
      voiceProfiles,
      and(
        eq(voiceProfiles.id, voiceProfileId),
        eq(voiceProfiles.providerProfileId, providerProfiles.id),
      ),
    )
    .where(eq(providerProfiles.id, providerProfileId))
    .limit(1);
  return pair ?? null;
}

function copyName(name: string): string {
  const suffix = " 副本";
  return `${name.slice(0, 80 - suffix.length)}${suffix}`;
}
