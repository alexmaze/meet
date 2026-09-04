import {
  BUILTIN_EMBEDDING_MODELS,
  type CreateModelConnectionRequest,
  type CreateModelProfileRequest,
  type ModelPurpose,
  type UpdateModelConnectionRequest,
  type UpdateModelProfileRequest,
} from "@meet/protocol";
import { randomUUID } from "node:crypto";
import {
  and,
  asc,
  count,
  eq,
  inArray,
  isNotNull,
  isNull,
  sql,
} from "drizzle-orm";

import type { Database } from "./client.js";
import {
  aiWorkItems,
  characters,
  conversationSummaryCheckpoints,
  modelConfigurationAuditEvents,
  modelConnections,
  modelPurposeBindings,
  providerProfiles,
  teachingPlanGenerationRequests,
  voiceProfiles,
  type ModelConnectionRecord,
  type ProviderProfileRecord,
  type VoiceProfileRecord,
} from "./schema.js";

export type ModelSettingsSnapshot = {
  connections: ModelConnectionRecord[];
  models: Array<
    ProviderProfileRecord & {
      referenceCount: number;
      characterReferenceCount: number;
      purposeReferenceCount: number;
      queuedReferenceCount: number;
    }
  >;
  voices: VoiceProfileRecord[];
  bindings: Array<{
    purpose: ModelPurpose;
    modelProfileId: string;
  }>;
  work: { waiting: number; failed: number };
};

export type ResolvedModelRuntime = {
  profile: ProviderProfileRecord;
  connection: ModelConnectionRecord;
};

export type ResolvedMemoryEmbeddingConfiguration =
  | {
      mode: "external";
      apiKey: string;
      baseUrl: string;
      model: string;
      dimensions: number;
    }
  | {
      mode: "builtin";
      model: string;
      dimensions: number;
    };

export async function listModelSettings(
  db: Database,
): Promise<ModelSettingsSnapshot> {
  const [connections, models, voices, bindings, workCounts, checkpointCounts] =
    await Promise.all([
      db
        .select()
        .from(modelConnections)
        .orderBy(asc(modelConnections.displayName)),
      db
        .select({
          profile: providerProfiles,
          characterReferences: count(characters.id),
        })
        .from(providerProfiles)
        .leftJoin(
          characters,
          and(
            eq(characters.providerProfileId, providerProfiles.id),
            isNull(characters.deletedAt),
          ),
        )
        .groupBy(providerProfiles.id)
        .orderBy(asc(providerProfiles.kind), asc(providerProfiles.displayName)),
      db.select().from(voiceProfiles).orderBy(asc(voiceProfiles.displayName)),
      db.select().from(modelPurposeBindings),
      db
        .select({ status: aiWorkItems.status, value: count() })
        .from(aiWorkItems)
        .where(inArray(aiWorkItems.status, ["waiting_configuration", "failed"]))
        .groupBy(aiWorkItems.status),
      db
        .select({
          status: conversationSummaryCheckpoints.status,
          value: count(),
        })
        .from(conversationSummaryCheckpoints)
        .where(
          inArray(conversationSummaryCheckpoints.status, [
            "waiting_configuration",
            "failed",
          ]),
        )
        .groupBy(conversationSummaryCheckpoints.status),
    ]);
  const bindingCounts = new Map<string, number>();
  for (const binding of bindings) {
    bindingCounts.set(
      binding.modelProfileId,
      (bindingCounts.get(binding.modelProfileId) ?? 0) + 1,
    );
  }
  const workReferenceRows = await db
    .select({ modelProfileId: aiWorkItems.modelProfileId, value: count() })
    .from(aiWorkItems)
    .where(isNotNull(aiWorkItems.modelProfileId))
    .groupBy(aiWorkItems.modelProfileId);
  const checkpointReferenceRows = await db
    .select({
      modelProfileId: conversationSummaryCheckpoints.modelProfileId,
      value: count(),
    })
    .from(conversationSummaryCheckpoints)
    .where(isNotNull(conversationSummaryCheckpoints.modelProfileId))
    .groupBy(conversationSummaryCheckpoints.modelProfileId);
  const generationReferenceRows = await db
    .select({
      modelProfileId: teachingPlanGenerationRequests.modelProfileId,
      value: count(),
    })
    .from(teachingPlanGenerationRequests)
    .where(isNotNull(teachingPlanGenerationRequests.modelProfileId))
    .groupBy(teachingPlanGenerationRequests.modelProfileId);
  const workReferences = new Map<string, number>(
    workReferenceRows.flatMap((row) =>
      row.modelProfileId ? [[row.modelProfileId, Number(row.value)]] : [],
    ),
  );
  for (const row of checkpointReferenceRows) {
    if (!row.modelProfileId) continue;
    workReferences.set(
      row.modelProfileId,
      (workReferences.get(row.modelProfileId) ?? 0) + Number(row.value),
    );
  }
  for (const row of generationReferenceRows) {
    if (!row.modelProfileId) continue;
    workReferences.set(
      row.modelProfileId,
      (workReferences.get(row.modelProfileId) ?? 0) + Number(row.value),
    );
  }
  return {
    connections,
    models: models.map(({ profile, characterReferences }) => {
      const characterReferenceCount = Number(characterReferences);
      const purposeReferenceCount = bindingCounts.get(profile.id) ?? 0;
      const queuedReferenceCount = workReferences.get(profile.id) ?? 0;
      return {
        ...profile,
        characterReferenceCount,
        purposeReferenceCount,
        queuedReferenceCount,
        referenceCount:
          characterReferenceCount +
          purposeReferenceCount +
          queuedReferenceCount,
      };
    }),
    voices,
    bindings: bindings.map((binding) => ({
      purpose: binding.purpose,
      modelProfileId: binding.modelProfileId,
    })),
    work: {
      waiting:
        Number(
          workCounts.find((row) => row.status === "waiting_configuration")
            ?.value ?? 0,
        ) +
        Number(
          checkpointCounts.find((row) => row.status === "waiting_configuration")
            ?.value ?? 0,
        ),
      failed:
        Number(workCounts.find((row) => row.status === "failed")?.value ?? 0) +
        Number(
          checkpointCounts.find((row) => row.status === "failed")?.value ?? 0,
        ),
    },
  };
}

export async function createModelConnection(
  db: Database,
  actorUserId: string,
  input: CreateModelConnectionRequest,
): Promise<ModelConnectionRecord> {
  const now = new Date();
  return db.transaction(async (tx) => {
    const [created] = await tx
      .insert(modelConnections)
      .values({
        adapter: input.adapter,
        displayName: input.displayName,
        pendingEndpoint: input.endpoint,
        pendingApiKey: input.apiKey,
        pendingCompatibilityPreset:
          input.adapter === "openai_chat_completions"
            ? (input.compatibilityPreset ?? "standard")
            : null,
        status: "draft",
        createdByUserId: actorUserId,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    if (!created) throw new Error("Model connection was not created.");
    await audit(
      tx,
      actorUserId,
      "connection_created",
      "connection",
      created.id,
      {
        adapter: created.adapter,
        revision: created.revision,
      },
    );
    return created;
  });
}

export async function stageModelConnectionUpdate(
  db: Database,
  actorUserId: string,
  connectionId: string,
  input: UpdateModelConnectionRequest,
): Promise<"updated" | "not_found" | "conflict"> {
  return db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(modelConnections)
      .where(eq(modelConnections.id, connectionId))
      .for("update")
      .limit(1);
    if (!current) return "not_found";
    if (current.revision !== input.revision) return "conflict";
    if (current.adapter === "builtin_fastembed") {
      const [updated] = await tx
        .update(modelConnections)
        .set({
          displayName: input.displayName ?? current.displayName,
          revision: current.revision + 1,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(modelConnections.id, connectionId),
            eq(modelConnections.revision, input.revision),
          ),
        )
        .returning();
      if (!updated) return "conflict";
      await audit(
        tx,
        actorUserId,
        "connection_updated",
        "connection",
        connectionId,
        { revision: updated.revision },
      );
      return "updated";
    }
    const endpoint =
      input.endpoint ?? current.pendingEndpoint ?? current.endpoint;
    const apiKey =
      input.apiKey === undefined || input.apiKey === ""
        ? (current.pendingApiKey ?? current.apiKey)
        : input.apiKey;
    if (!endpoint || !apiKey) return "not_found";
    const [updated] = await tx
      .update(modelConnections)
      .set({
        displayName: input.displayName ?? current.displayName,
        pendingEndpoint: endpoint,
        pendingApiKey: apiKey,
        pendingCompatibilityPreset:
          input.compatibilityPreset ??
          current.pendingCompatibilityPreset ??
          current.compatibilityPreset,
        revision: current.revision + 1,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(modelConnections.id, connectionId),
          eq(modelConnections.revision, input.revision),
        ),
      )
      .returning();
    if (!updated) return "conflict";
    await audit(
      tx,
      actorUserId,
      "connection_updated",
      "connection",
      connectionId,
      {
        revision: updated.revision,
        credentialChanged: input.apiKey !== undefined && input.apiKey !== "",
        endpointChanged: input.endpoint !== undefined,
      },
    );
    return "updated";
  });
}

export async function createModelProfile(
  db: Database,
  actorUserId: string,
  input: CreateModelProfileRequest,
): Promise<ProviderProfileRecord | null> {
  const [connection] = await db
    .select()
    .from(modelConnections)
    .where(eq(modelConnections.id, input.connectionId))
    .limit(1);
  if (!connection || !kindMatchesAdapter(input.kind, connection.adapter)) {
    return null;
  }
  if (
    connection.adapter === "builtin_fastembed" &&
    !BUILTIN_EMBEDDING_MODELS.some(
      ({ id, dimensions }) =>
        input.model === id && input.embeddingDimensions === dimensions,
    )
  ) {
    return null;
  }
  const id = randomUUID();
  const provider = providerForAdapter(connection.adapter);
  return db.transaction(async (tx) => {
    const [legacyProfile] = await tx
      .select()
      .from(providerProfiles)
      .where(
        and(
          isNull(providerProfiles.connectionId),
          eq(providerProfiles.provider, provider),
          eq(providerProfiles.kind, input.kind),
          eq(providerProfiles.model, input.model),
        ),
      )
      .for("update")
      .limit(1);
    if (legacyProfile) {
      const [attached] = await tx
        .update(providerProfiles)
        .set({
          connectionId: input.connectionId,
          displayName: input.displayName,
          status: "draft",
          verifiedAt: null,
          revision: legacyProfile.revision + 1,
          createdByUserId: actorUserId,
          updatedAt: new Date(),
        })
        .where(eq(providerProfiles.id, legacyProfile.id))
        .returning();
      if (!attached) throw new Error("Legacy model profile was not attached.");
      await audit(tx, actorUserId, "model_created", "model", attached.id, {
        attachedLegacyProfile: true,
        connectionId: attached.connectionId,
        revision: attached.revision,
      });
      return attached;
    }
    const [created] = await tx
      .insert(providerProfiles)
      .values({
        id,
        systemKey: `custom.model.${id}`,
        provider,
        model: input.model,
        displayName: input.displayName,
        capabilities:
          input.kind === "realtime_voice"
            ? { audioInput: true, textInput: true, imageInput: false }
            : { audioInput: false, textInput: true, imageInput: false },
        embeddingDimensions: input.embeddingDimensions ?? null,
        connectionId: input.connectionId,
        kind: input.kind,
        status: "draft",
        revision: 1,
        createdByUserId: actorUserId,
      })
      .returning();
    if (!created) throw new Error("Model profile was not created.");
    await audit(tx, actorUserId, "model_created", "model", created.id, {
      kind: created.kind,
      connectionId: created.connectionId,
      revision: created.revision,
    });
    return created;
  });
}

export async function updateModelProfile(
  db: Database,
  actorUserId: string,
  profileId: string,
  input: UpdateModelProfileRequest,
): Promise<"updated" | "not_found" | "conflict" | "not_verified"> {
  return db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(providerProfiles)
      .where(eq(providerProfiles.id, profileId))
      .for("update")
      .limit(1);
    if (!current) return "not_found";
    if (current.revision !== input.revision) return "conflict";
    if (input.status === "enabled" && !current.verifiedAt)
      return "not_verified";
    const modelChanged =
      input.model !== undefined && input.model !== current.model;
    const dimensionsChanged =
      input.embeddingDimensions !== undefined &&
      input.embeddingDimensions !== current.embeddingDimensions;
    const configurationChanged = modelChanged || dimensionsChanged;
    const nextStatus = configurationChanged
      ? "draft"
      : (input.status ?? current.status);
    const [updated] = await tx
      .update(providerProfiles)
      .set({
        model: input.model ?? current.model,
        displayName: input.displayName ?? current.displayName,
        embeddingDimensions:
          input.embeddingDimensions ?? current.embeddingDimensions,
        status: nextStatus,
        verifiedAt: configurationChanged ? null : current.verifiedAt,
        everEnabled: current.everEnabled || nextStatus === "enabled",
        revision: current.revision + 1,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(providerProfiles.id, profileId),
          eq(providerProfiles.revision, input.revision),
        ),
      )
      .returning();
    if (!updated) return "conflict";
    await audit(
      tx,
      actorUserId,
      input.status === undefined ? "model_updated" : "model_status_changed",
      "model",
      profileId,
      {
        revision: updated.revision,
        status: updated.status,
        modelChanged,
        dimensionsChanged,
      },
    );
    return "updated";
  });
}

export async function deleteModelProfile(
  db: Database,
  actorUserId: string,
  profileId: string,
): Promise<"deleted" | "not_found" | "referenced"> {
  return db.transaction(async (tx) => {
    const [profile] = await tx
      .select()
      .from(providerProfiles)
      .where(eq(providerProfiles.id, profileId))
      .for("update")
      .limit(1);
    if (!profile) return "not_found";
    const refs = Number(
      (
        await tx
          .select({ value: count() })
          .from(characters)
          .where(eq(characters.providerProfileId, profileId))
      )[0]?.value ?? 0,
    );
    const bindingRefs = Number(
      (
        await tx
          .select({ value: count() })
          .from(modelPurposeBindings)
          .where(eq(modelPurposeBindings.modelProfileId, profileId))
      )[0]?.value ?? 0,
    );
    const workRefs = Number(
      (
        await tx
          .select({ value: count() })
          .from(aiWorkItems)
          .where(eq(aiWorkItems.modelProfileId, profileId))
      )[0]?.value ?? 0,
    );
    const checkpointRefs = Number(
      (
        await tx
          .select({ value: count() })
          .from(conversationSummaryCheckpoints)
          .where(eq(conversationSummaryCheckpoints.modelProfileId, profileId))
      )[0]?.value ?? 0,
    );
    const generationRefs = Number(
      (
        await tx
          .select({ value: count() })
          .from(teachingPlanGenerationRequests)
          .where(eq(teachingPlanGenerationRequests.modelProfileId, profileId))
      )[0]?.value ?? 0,
    );
    if (
      profile.everEnabled ||
      refs > 0 ||
      bindingRefs > 0 ||
      workRefs > 0 ||
      checkpointRefs > 0 ||
      generationRefs > 0
    ) {
      return "referenced";
    }
    await tx
      .delete(voiceProfiles)
      .where(eq(voiceProfiles.providerProfileId, profileId));
    await tx.delete(providerProfiles).where(eq(providerProfiles.id, profileId));
    await audit(tx, actorUserId, "model_deleted", "model", profileId, {});
    return "deleted";
  });
}

export async function createManagedVoice(
  db: Database,
  actorUserId: string,
  modelProfileId: string,
  input: { providerVoiceId: string; displayName: string },
  source: "builtin" | "custom" = "custom",
): Promise<VoiceProfileRecord | null> {
  const [profile] = await db
    .select()
    .from(providerProfiles)
    .where(
      and(
        eq(providerProfiles.id, modelProfileId),
        eq(providerProfiles.kind, "realtime_voice"),
      ),
    )
    .limit(1);
  if (!profile) return null;
  const id = randomUUID();
  return db.transaction(async (tx) => {
    const [voice] = await tx
      .insert(voiceProfiles)
      .values({
        id,
        systemKey: `custom.voice.${id}`,
        providerProfileId: modelProfileId,
        type: "preset",
        providerVoiceId: input.providerVoiceId,
        displayName: input.displayName,
        style: {},
        source,
        status: "draft",
        revision: 1,
        createdByUserId: actorUserId,
      })
      .onConflictDoNothing({
        target: [
          voiceProfiles.providerProfileId,
          voiceProfiles.providerVoiceId,
        ],
      })
      .returning();
    if (!voice) {
      const [existing] = await tx
        .select()
        .from(voiceProfiles)
        .where(
          and(
            eq(voiceProfiles.providerProfileId, modelProfileId),
            eq(voiceProfiles.providerVoiceId, input.providerVoiceId),
          ),
        )
        .limit(1);
      if (!existing) throw new Error("Voice profile was not created.");
      return existing;
    }
    await audit(tx, actorUserId, "voice_created", "voice", voice.id, {
      modelProfileId,
    });
    return voice;
  });
}

export async function markModelTestSucceeded(
  db: Database,
  actorUserId: string,
  profileId: string,
  voiceProfileId?: string,
): Promise<"updated" | "not_found"> {
  return db.transaction(async (tx) => {
    const [profile] = await tx
      .select()
      .from(providerProfiles)
      .where(eq(providerProfiles.id, profileId))
      .for("update")
      .limit(1);
    if (!profile?.connectionId) return "not_found";
    const [connection] = await tx
      .select()
      .from(modelConnections)
      .where(eq(modelConnections.id, profile.connectionId))
      .for("update")
      .limit(1);
    if (!connection) return "not_found";
    const endpoint = connection.pendingEndpoint ?? connection.endpoint;
    const apiKey = connection.pendingApiKey ?? connection.apiKey;
    if (connection.adapter !== "builtin_fastembed" && (!endpoint || !apiKey)) {
      return "not_found";
    }
    const now = new Date();
    await tx
      .update(modelConnections)
      .set({
        endpoint,
        apiKey,
        compatibilityPreset:
          connection.pendingCompatibilityPreset ??
          connection.compatibilityPreset ??
          (connection.adapter === "openai_chat_completions"
            ? "standard"
            : null),
        pendingEndpoint: null,
        pendingApiKey: null,
        pendingCompatibilityPreset: null,
        status: "enabled",
        verifiedAt: now,
        revision: connection.revision + 1,
        updatedAt: now,
      })
      .where(eq(modelConnections.id, connection.id));
    await tx
      .update(providerProfiles)
      .set({ verifiedAt: now, revision: profile.revision + 1, updatedAt: now })
      .where(eq(providerProfiles.id, profile.id));
    if (profile.kind === "realtime_voice") {
      await tx
        .update(voiceProfiles)
        .set({
          verifiedAt: now,
          status: "enabled",
          revision: sql`${voiceProfiles.revision} + 1`,
          updatedAt: now,
        })
        .where(
          and(
            eq(voiceProfiles.providerProfileId, profile.id),
            eq(voiceProfiles.source, "builtin"),
          ),
        );
    }
    if (voiceProfileId) {
      await tx
        .update(voiceProfiles)
        .set({
          verifiedAt: now,
          status: "enabled",
          revision: sql`${voiceProfiles.revision} + 1`,
          updatedAt: now,
        })
        .where(
          and(
            eq(voiceProfiles.id, voiceProfileId),
            eq(voiceProfiles.providerProfileId, profile.id),
            eq(voiceProfiles.source, "custom"),
          ),
        );
    }
    await audit(
      tx,
      actorUserId,
      "connection_promoted",
      "connection",
      connection.id,
      {
        revision: connection.revision + 1,
        testedModelProfileId: profile.id,
      },
    );
    await audit(tx, actorUserId, "model_tested", "model", profile.id, {
      revision: profile.revision + 1,
      voiceProfileId,
    });
    return "updated";
  });
}

export async function setModelPurposeBinding(
  db: Database,
  actorUserId: string,
  purpose: ModelPurpose,
  modelProfileId: string,
): Promise<"updated" | "invalid_model"> {
  return db.transaction(async (tx) => {
    const [profile] = await tx
      .select()
      .from(providerProfiles)
      .where(
        and(
          eq(providerProfiles.id, modelProfileId),
          eq(providerProfiles.status, "enabled"),
        ),
      )
      .limit(1);
    const expectedKind =
      purpose === "realtime_default"
        ? "realtime_voice"
        : purpose === "memory_embedding"
          ? "embedding"
          : "text";
    if (!profile || profile.kind !== expectedKind) return "invalid_model";
    await tx
      .insert(modelPurposeBindings)
      .values({ purpose, modelProfileId, updatedByUserId: actorUserId })
      .onConflictDoUpdate({
        target: modelPurposeBindings.purpose,
        set: {
          modelProfileId,
          updatedByUserId: actorUserId,
          updatedAt: new Date(),
        },
      });
    await audit(tx, actorUserId, "binding_changed", "model", modelProfileId, {
      purpose,
    });
    return "updated";
  });
}

export async function findResolvedModelRuntime(
  db: Database,
  profileId: string,
  options: { requireEnabled?: boolean } = {},
): Promise<ResolvedModelRuntime | null> {
  const [row] = await db
    .select({ profile: providerProfiles, connection: modelConnections })
    .from(providerProfiles)
    .innerJoin(
      modelConnections,
      eq(providerProfiles.connectionId, modelConnections.id),
    )
    .where(
      and(
        eq(providerProfiles.id, profileId),
        options.requireEnabled === false
          ? undefined
          : and(
              eq(providerProfiles.status, "enabled"),
              eq(modelConnections.status, "enabled"),
            ),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function findResolvedModelRuntimeForPurpose(
  db: Database,
  purpose: ModelPurpose,
): Promise<ResolvedModelRuntime | null> {
  const [row] = await db
    .select({ profile: providerProfiles, connection: modelConnections })
    .from(modelPurposeBindings)
    .innerJoin(
      providerProfiles,
      and(
        eq(modelPurposeBindings.modelProfileId, providerProfiles.id),
        eq(providerProfiles.status, "enabled"),
      ),
    )
    .innerJoin(
      modelConnections,
      and(
        eq(providerProfiles.connectionId, modelConnections.id),
        eq(modelConnections.status, "enabled"),
      ),
    )
    .where(eq(modelPurposeBindings.purpose, purpose))
    .limit(1);
  return row ?? null;
}

export async function resolveMemoryEmbeddingConfiguration(
  db: Database,
): Promise<ResolvedMemoryEmbeddingConfiguration | undefined> {
  const runtime = await findResolvedModelRuntimeForPurpose(
    db,
    "memory_embedding",
  );
  if (
    !runtime ||
    runtime.profile.kind !== "embedding" ||
    !runtime.profile.embeddingDimensions
  ) {
    return undefined;
  }
  if (runtime.connection.adapter === "builtin_fastembed") {
    return {
      mode: "builtin",
      model: runtime.profile.model,
      dimensions: runtime.profile.embeddingDimensions,
    };
  }
  if (
    runtime.connection.adapter !== "openai_embeddings" ||
    !runtime.connection.endpoint ||
    !runtime.connection.apiKey
  ) {
    return undefined;
  }
  return {
    mode: "external",
    apiKey: runtime.connection.apiKey,
    baseUrl: runtime.connection.endpoint,
    model: runtime.profile.model,
    dimensions: runtime.profile.embeddingDimensions,
  };
}

export async function findDefaultRealtimeProfileId(
  db: Database,
): Promise<string | null> {
  const [binding] = await db
    .select({ modelProfileId: modelPurposeBindings.modelProfileId })
    .from(modelPurposeBindings)
    .innerJoin(
      providerProfiles,
      and(
        eq(modelPurposeBindings.modelProfileId, providerProfiles.id),
        eq(providerProfiles.status, "enabled"),
      ),
    )
    .where(eq(modelPurposeBindings.purpose, "realtime_default"))
    .limit(1);
  return binding?.modelProfileId ?? null;
}

function providerForAdapter(
  adapter: ModelConnectionRecord["adapter"],
): ProviderProfileRecord["provider"] {
  if (adapter === "qwen_realtime") return "qwen";
  if (adapter === "doubao_realtime") return "doubao";
  return "openai";
}

function kindMatchesAdapter(
  kind: CreateModelProfileRequest["kind"],
  adapter: ModelConnectionRecord["adapter"],
): boolean {
  if (adapter === "openai_chat_completions") return kind === "text";
  if (adapter === "openai_embeddings" || adapter === "builtin_fastembed") {
    return kind === "embedding";
  }
  return kind === "realtime_voice";
}

type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

async function audit(
  tx: Transaction,
  actorUserId: string,
  action: typeof modelConfigurationAuditEvents.$inferInsert.action,
  entityType: string,
  entityId: string,
  details: Record<string, unknown>,
) {
  await tx.insert(modelConfigurationAuditEvents).values({
    actorUserId,
    action,
    entityType,
    entityId,
    details,
  });
}
