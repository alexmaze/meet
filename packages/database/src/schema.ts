import { sql } from "drizzle-orm";
import type {
  ConversationPolicy,
  ConversationRuntimeSnapshot,
  PersonaDefinition,
  ProviderCapabilities,
  TeachingPlanContentItem,
  TeachingPlanGenerationInputSnapshot,
  VisualProfile,
  VoiceStyle,
} from "@meet/protocol";
import {
  check,
  boolean,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  real,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
  text,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";

function activeTeachingContentForeignColumns(): [AnyPgColumn, AnyPgColumn] {
  return [teachingContentRevisions.id, teachingContentRevisions.learningPlanId];
}

function generatedTeachingContentForeignColumns(): [AnyPgColumn, AnyPgColumn] {
  return [
    teachingContentRevisions.id,
    teachingContentRevisions.generationRequestId,
  ];
}

export const accountTypeEnum = pgEnum("user_account_type", [
  "admin",
  "adult",
  "child",
]);

export const accountStatusEnum = pgEnum("user_account_status", [
  "active",
  "disabled",
]);

export const guardianHistoryAccessEnum = pgEnum("guardian_history_access", [
  "allowed",
  "denied",
]);

export const loginSessionRevocationReasonEnum = pgEnum(
  "login_session_revocation_reason",
  ["logout", "password_reset", "account_disabled", "admin_revoked"],
);

export const securityActorTypeEnum = pgEnum("security_actor_type", [
  "user",
  "server_command",
  "system",
]);

export const accountSecurityEventTypeEnum = pgEnum(
  "account_security_event_type",
  [
    "initial_admin_created",
    "member_account_created",
    "guardian_history_access_changed",
    "account_status_changed",
    "password_changed",
    "password_reset",
    "sessions_revoked",
  ],
);

export const realtimeProviderEnum = pgEnum("realtime_provider", [
  "qwen",
  "doubao",
  "openai",
  "gemini",
  "elevenlabs",
]);

export const modelConnectionAdapterEnum = pgEnum("model_connection_adapter", [
  "qwen_realtime",
  "doubao_realtime",
  "openai_chat_completions",
  "openai_embeddings",
  "builtin_fastembed",
]);

export const modelProfileKindEnum = pgEnum("model_profile_kind", [
  "realtime_voice",
  "text",
  "embedding",
]);

export const modelConfigurationStatusEnum = pgEnum(
  "model_configuration_status",
  ["draft", "enabled", "disabled"],
);

export const modelPurposeEnum = pgEnum("model_purpose", [
  "realtime_default",
  "conversation_summary",
  "memory_extraction",
  "memory_embedding",
  "teaching_plan_generation",
]);

export const aiWorkStatusEnum = pgEnum("ai_work_status", [
  "waiting_configuration",
  "queued",
  "completed",
  "failed",
]);

export const modelConfigurationAuditActionEnum = pgEnum(
  "model_configuration_audit_action",
  [
    "connection_created",
    "connection_updated",
    "connection_promoted",
    "model_created",
    "model_updated",
    "model_tested",
    "model_status_changed",
    "model_deleted",
    "voice_created",
    "voice_tested",
    "voice_deleted",
    "binding_changed",
  ],
);

export const voiceProfileTypeEnum = pgEnum("voice_profile_type", [
  "preset",
  "cloned",
]);

export const characterVisibilityEnum = pgEnum("character_visibility", [
  "builtin",
  "family",
  "private",
]);

export const characterAuditEventTypeEnum = pgEnum(
  "character_audit_event_type",
  ["created", "updated", "visibility_changed", "copied", "deleted", "restored"],
);

export const teachingSubjectEnum = pgEnum("teaching_subject", [
  "english",
  "math",
  "science",
  "chinese",
  "general",
]);

export const teachingGradeLevelEnum = pgEnum("teaching_grade_level", [
  "preschool",
  "grade_1",
  "grade_2",
  "grade_3",
  "grade_4",
  "grade_5",
  "grade_6",
  "grade_7",
  "grade_8",
  "grade_9",
  "grade_10",
  "grade_11",
  "grade_12",
  "unspecified",
]);

export const teachingDifficultyEnum = pgEnum("teaching_difficulty", [
  "starter",
  "growing",
  "challenge",
]);

export const teachingTriggerModeEnum = pgEnum("teaching_trigger_mode", [
  "on_request",
  "gentle",
]);

export const conversationTeachingStateEnum = pgEnum(
  "conversation_teaching_state",
  ["unavailable", "available", "active", "restoring", "muted", "completed"],
);

export const conversationTeachingMuteReasonEnum = pgEnum(
  "conversation_teaching_mute_reason",
  ["temporary_conversation", "child_request", "plan_disabled"],
);

export const teachingEventTypeEnum = pgEnum("teaching_event_type", [
  "prepared",
  "child_muted",
  "plan_disabled",
  "invitation_claimed",
  "restoring",
  "completed",
]);

export const teachingPlanGenerationStatusEnum = pgEnum(
  "teaching_plan_generation_status",
  ["queued", "running", "succeeded", "failed", "superseded"],
);

export const teachingPlanGenerationModeEnum = pgEnum(
  "teaching_plan_generation_mode",
  ["auto", "controlled_template", "text_model"],
);

export const teachingPlanGeneratorSourceEnum = pgEnum(
  "teaching_plan_generator_source",
  ["controlled_template", "text_model"],
);

export const teachingContentItemKindEnum = pgEnum(
  "teaching_content_item_kind",
  [
    "reviewed_catalog_ref",
    "pinyin_practice",
    "multiplication_fact",
    "model_generated_activity",
  ],
);

export const conversationModeEnum = pgEnum("conversation_mode", [
  "normal",
  "temporary",
]);

export const conversationStatusEnum = pgEnum("conversation_status", [
  "active",
  "completed",
]);

export const conversationMessageRoleEnum = pgEnum("conversation_message_role", [
  "user",
  "assistant",
]);

export const conversationMessageStatusEnum = pgEnum(
  "conversation_message_status",
  ["completed", "interrupted"],
);

export const characterMemoryStatusEnum = pgEnum("character_memory_status", [
  "active",
  "suggested",
  "rejected",
  "deleted",
]);

export const mediaObjectKindEnum = pgEnum("media_object_kind", [
  "call_recording",
  "conversation_image",
  "character_avatar",
  "avatar_preview",
]);

export const mediaRetentionEnum = pgEnum("media_retention", [
  "temporary",
  "retained",
]);

export const mediaObjectStatusEnum = pgEnum("media_object_status", [
  "available",
  "pending_deletion",
  "deleted",
]);

export const userAccounts = pgTable(
  "user_accounts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    username: varchar("username", { length: 64 }).notNull(),
    usernameCanonical: varchar("username_canonical", { length: 256 }).notNull(),
    displayName: varchar("display_name", { length: 80 }).notNull(),
    accountType: accountTypeEnum("account_type").notNull(),
    status: accountStatusEnum("status").notNull().default("active"),
    guardianHistoryAccess: guardianHistoryAccessEnum(
      "guardian_history_access",
    ).default("allowed"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("user_accounts_username_canonical_unique").on(
      table.usernameCanonical,
    ),
    check(
      "user_accounts_username_not_blank",
      sql`length(btrim(${table.username})) > 0`,
    ),
    check(
      "user_accounts_username_canonical_not_blank",
      sql`length(${table.usernameCanonical}) > 0`,
    ),
    check(
      "user_accounts_display_name_not_blank",
      sql`length(btrim(${table.displayName})) > 0`,
    ),
    check(
      "user_accounts_guardian_access_matches_type",
      sql`(
        (${table.accountType} = 'child' AND ${table.guardianHistoryAccess} IS NOT NULL)
        OR
        (${table.accountType} <> 'child' AND ${table.guardianHistoryAccess} IS NULL)
      )`,
    ),
  ],
);

export const passwordCredentials = pgTable(
  "password_credentials",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => userAccounts.id, { onDelete: "cascade" }),
    passwordHash: text("password_hash").notNull(),
    passwordChangedAt: timestamp("password_changed_at", {
      withTimezone: true,
    })
      .notNull()
      .defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({
      name: "password_credentials_pkey",
      columns: [table.userId],
    }),
    check(
      "password_credentials_hash_not_blank",
      sql`length(${table.passwordHash}) > 0`,
    ),
  ],
);

export const loginSessions = pgTable(
  "login_sessions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => userAccounts.id, { onDelete: "cascade" }),
    tokenHash: varchar("token_hash", { length: 64 }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revocationReason: loginSessionRevocationReasonEnum("revocation_reason"),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("login_sessions_token_hash_unique").on(table.tokenHash),
    index("login_sessions_user_id_idx").on(table.userId),
    index("login_sessions_active_user_expires_idx")
      .on(table.userId, table.expiresAt)
      .where(sql`${table.revokedAt} IS NULL`),
    check(
      "login_sessions_expiry_after_creation",
      sql`${table.expiresAt} > ${table.createdAt}`,
    ),
    check(
      "login_sessions_revocation_fields_match",
      sql`(
        (${table.revokedAt} IS NULL AND ${table.revocationReason} IS NULL)
        OR
        (${table.revokedAt} IS NOT NULL AND ${table.revocationReason} IS NOT NULL)
      )`,
    ),
    check(
      "login_sessions_revocation_after_creation",
      sql`${table.revokedAt} IS NULL OR ${table.revokedAt} >= ${table.createdAt}`,
    ),
  ],
);

export const accountSecurityAuditEvents = pgTable(
  "account_security_audit_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    eventType: accountSecurityEventTypeEnum("event_type").notNull(),
    actorType: securityActorTypeEnum("actor_type").notNull(),
    actorUserId: uuid("actor_user_id").references(() => userAccounts.id, {
      onDelete: "set null",
    }),
    targetUserId: uuid("target_user_id")
      .notNull()
      .references(() => userAccounts.id, { onDelete: "restrict" }),
    loginSessionId: uuid("login_session_id").references(
      () => loginSessions.id,
      { onDelete: "set null" },
    ),
    details: jsonb("details")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("account_security_audit_target_created_idx").on(
      table.targetUserId,
      table.createdAt,
    ),
    index("account_security_audit_actor_created_idx").on(
      table.actorUserId,
      table.createdAt,
    ),
    check(
      "account_security_audit_actor_matches_type",
      sql`(
        (${table.actorType} = 'user' AND ${table.actorUserId} IS NOT NULL)
        OR
        (${table.actorType} <> 'user' AND ${table.actorUserId} IS NULL)
      )`,
    ),
  ],
);

export const modelConnections = pgTable(
  "model_connections",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    adapter: modelConnectionAdapterEnum("adapter").notNull(),
    displayName: varchar("display_name", { length: 120 }).notNull(),
    endpoint: text("endpoint"),
    apiKey: text("api_key"),
    pendingEndpoint: text("pending_endpoint"),
    pendingApiKey: text("pending_api_key"),
    compatibilityPreset: varchar("compatibility_preset", { length: 40 }),
    pendingCompatibilityPreset: varchar("pending_compatibility_preset", {
      length: 40,
    }),
    status: modelConfigurationStatusEnum("status").notNull().default("draft"),
    revision: integer("revision").notNull().default(1),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    createdByUserId: uuid("created_by_user_id")
      .notNull()
      .references(() => userAccounts.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      "model_connections_display_name_not_blank",
      sql`length(btrim(${table.displayName})) > 0`,
    ),
    check("model_connections_revision_positive", sql`${table.revision} > 0`),
    check(
      "model_connections_has_configuration",
      sql`${table.adapter} = 'builtin_fastembed' OR (${table.endpoint} IS NOT NULL AND ${table.apiKey} IS NOT NULL) OR (${table.pendingEndpoint} IS NOT NULL AND ${table.pendingApiKey} IS NOT NULL)`,
    ),
  ],
);

export const providerProfiles = pgTable(
  "provider_profiles",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    systemKey: varchar("system_key", { length: 120 }).notNull(),
    provider: realtimeProviderEnum("provider").notNull(),
    model: varchar("model", { length: 120 }).notNull(),
    displayName: varchar("display_name", { length: 120 }).notNull(),
    capabilities: jsonb("capabilities").$type<ProviderCapabilities>().notNull(),
    connectionId: uuid("connection_id").references(() => modelConnections.id, {
      onDelete: "restrict",
    }),
    kind: modelProfileKindEnum("kind").notNull().default("realtime_voice"),
    status: modelConfigurationStatusEnum("status").notNull().default("draft"),
    revision: integer("revision").notNull().default(1),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    embeddingDimensions: integer("embedding_dimensions"),
    everEnabled: boolean("ever_enabled").notNull().default(false),
    createdByUserId: uuid("created_by_user_id").references(
      () => userAccounts.id,
      { onDelete: "set null" },
    ),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("provider_profiles_system_key_unique").on(table.systemKey),
    uniqueIndex("provider_profiles_connection_kind_model_unique").on(
      table.connectionId,
      table.kind,
      table.model,
    ),
    check(
      "provider_profiles_system_key_not_blank",
      sql`length(btrim(${table.systemKey})) > 0`,
    ),
    check(
      "provider_profiles_model_not_blank",
      sql`length(btrim(${table.model})) > 0`,
    ),
    check("provider_profiles_revision_positive", sql`${table.revision} > 0`),
    check(
      "provider_profiles_embedding_dimensions_valid",
      sql`(${table.kind} = 'embedding' AND ${table.embeddingDimensions} BETWEEN 1 AND 4096) OR (${table.kind} <> 'embedding' AND ${table.embeddingDimensions} IS NULL)`,
    ),
  ],
);

export const voiceProfiles = pgTable(
  "voice_profiles",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    systemKey: varchar("system_key", { length: 120 }).notNull(),
    providerProfileId: uuid("provider_profile_id")
      .notNull()
      .references(() => providerProfiles.id, { onDelete: "restrict" }),
    type: voiceProfileTypeEnum("type").notNull(),
    providerVoiceId: varchar("provider_voice_id", { length: 120 }).notNull(),
    displayName: varchar("display_name", { length: 120 }).notNull(),
    style: jsonb("style").$type<VoiceStyle>().notNull().default({}),
    source: varchar("source", { length: 20 }).notNull().default("builtin"),
    status: modelConfigurationStatusEnum("status").notNull().default("draft"),
    revision: integer("revision").notNull().default(1),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    createdByUserId: uuid("created_by_user_id").references(
      () => userAccounts.id,
      { onDelete: "set null" },
    ),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("voice_profiles_system_key_unique").on(table.systemKey),
    uniqueIndex("voice_profiles_provider_voice_unique").on(
      table.providerProfileId,
      table.providerVoiceId,
    ),
    check(
      "voice_profiles_system_key_not_blank",
      sql`length(btrim(${table.systemKey})) > 0`,
    ),
    check(
      "voice_profiles_provider_voice_not_blank",
      sql`length(btrim(${table.providerVoiceId})) > 0`,
    ),
    check("voice_profiles_revision_positive", sql`${table.revision} > 0`),
    check(
      "voice_profiles_source_valid",
      sql`${table.source} IN ('builtin', 'custom')`,
    ),
  ],
);

export const teachingSpikeLiveAuthorizations = pgTable(
  "teaching_spike_live_authorizations",
  {
    runId: uuid("run_id").primaryKey(),
    planHash: varchar("plan_hash", { length: 64 }).notNull(),
    planJson: jsonb("plan_json").$type<unknown>().notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    reportHash: varchar("report_hash", { length: 64 }),
    reportJson: jsonb("report_json").$type<unknown>(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("teaching_spike_live_authorizations_expiry_idx").on(table.expiresAt),
    check(
      "teaching_spike_live_authorizations_plan_hash_format",
      sql`${table.planHash} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "teaching_spike_live_authorizations_plan_json_object",
      sql`jsonb_typeof(${table.planJson}) = 'object'`,
    ),
    check(
      "teaching_spike_live_authorizations_report_hash_format",
      sql`${table.reportHash} IS NULL OR ${table.reportHash} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "teaching_spike_live_authorizations_report_json_object",
      sql`${table.reportJson} IS NULL OR jsonb_typeof(${table.reportJson}) = 'object'`,
    ),
    check(
      "teaching_spike_live_authorizations_report_terminal_pair",
      sql`(${table.reportHash} IS NULL AND ${table.reportJson} IS NULL AND ${table.finishedAt} IS NULL) OR (${table.reportHash} IS NOT NULL AND ${table.reportJson} IS NOT NULL AND ${table.finishedAt} IS NOT NULL)`,
    ),
  ],
);

export const modelPurposeBindings = pgTable("model_purpose_bindings", {
  purpose: modelPurposeEnum("purpose").primaryKey(),
  modelProfileId: uuid("model_profile_id")
    .notNull()
    .references(() => providerProfiles.id, { onDelete: "restrict" }),
  updatedByUserId: uuid("updated_by_user_id")
    .notNull()
    .references(() => userAccounts.id, { onDelete: "restrict" }),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const modelConfigurationAuditEvents = pgTable(
  "model_configuration_audit_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    action: modelConfigurationAuditActionEnum("action").notNull(),
    actorUserId: uuid("actor_user_id")
      .notNull()
      .references(() => userAccounts.id, { onDelete: "restrict" }),
    entityType: varchar("entity_type", { length: 40 }).notNull(),
    entityId: uuid("entity_id").notNull(),
    details: jsonb("details")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("model_configuration_audit_entity_created_idx").on(
      table.entityType,
      table.entityId,
      table.createdAt,
    ),
  ],
);

export const characters = pgTable(
  "characters",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    systemKey: varchar("system_key", { length: 120 }),
    systemVersion: integer("system_version"),
    ownerUserId: uuid("owner_user_id").references(() => userAccounts.id, {
      onDelete: "restrict",
    }),
    visibility: characterVisibilityEnum("visibility").notNull(),
    name: varchar("name", { length: 80 }).notNull(),
    description: varchar("description", { length: 600 }).notNull(),
    persona: jsonb("persona").$type<PersonaDefinition>().notNull(),
    openingLine: varchar("opening_line", { length: 500 }),
    providerProfileId: uuid("provider_profile_id")
      .notNull()
      .references(() => providerProfiles.id, { onDelete: "restrict" }),
    voiceProfileId: uuid("voice_profile_id")
      .notNull()
      .references(() => voiceProfiles.id, { onDelete: "restrict" }),
    conversationPolicy: jsonb("conversation_policy")
      .$type<ConversationPolicy>()
      .notNull(),
    visualProfile: jsonb("visual_profile").$type<VisualProfile>().notNull(),
    revision: integer("revision").notNull().default(1),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("characters_system_key_unique").on(table.systemKey),
    index("characters_owner_visibility_idx").on(
      table.ownerUserId,
      table.visibility,
    ),
    index("characters_visibility_active_idx")
      .on(table.visibility, table.updatedAt)
      .where(sql`${table.deletedAt} IS NULL`),
    check("characters_revision_positive", sql`${table.revision} > 0`),
    check("characters_name_not_blank", sql`length(btrim(${table.name})) > 0`),
    check(
      "characters_system_fields_match",
      sql`(
        (${table.visibility} = 'builtin' AND ${table.systemKey} IS NOT NULL AND ${table.systemVersion} IS NOT NULL AND ${table.systemVersion} > 0 AND ${table.ownerUserId} IS NULL)
        OR
        (${table.visibility} <> 'builtin' AND ${table.systemKey} IS NULL AND ${table.systemVersion} IS NULL AND ${table.ownerUserId} IS NOT NULL)
      )`,
    ),
    check(
      "characters_builtin_not_deleted",
      sql`${table.visibility} <> 'builtin' OR ${table.deletedAt} IS NULL`,
    ),
  ],
);

export const characterAuditEvents = pgTable(
  "character_audit_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    eventType: characterAuditEventTypeEnum("event_type").notNull(),
    actorUserId: uuid("actor_user_id").references(() => userAccounts.id, {
      onDelete: "set null",
    }),
    characterId: uuid("character_id").references(() => characters.id, {
      onDelete: "set null",
    }),
    details: jsonb("details")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("character_audit_character_created_idx").on(
      table.characterId,
      table.createdAt,
    ),
    index("character_audit_actor_created_idx").on(
      table.actorUserId,
      table.createdAt,
    ),
  ],
);

export const childCharacterLearningPlans = pgTable(
  "child_character_learning_plans",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    childUserId: uuid("child_user_id")
      .notNull()
      .references(() => userAccounts.id, { onDelete: "cascade" }),
    characterId: uuid("character_id")
      .notNull()
      .references(() => characters.id, { onDelete: "restrict" }),
    enabled: boolean("enabled").notNull(),
    subject: teachingSubjectEnum("subject").notNull(),
    difficulty: teachingDifficultyEnum("difficulty").notNull(),
    triggerMode: teachingTriggerModeEnum("trigger_mode").notNull(),
    gradeLevel: teachingGradeLevelEnum("grade_level")
      .notNull()
      .default("unspecified"),
    learningGoal: varchar("learning_goal", { length: 300 }),
    activityCount: integer("activity_count").notNull().default(4),
    durationDays: integer("duration_days").notNull().default(7),
    activeContentRevisionId: uuid("active_content_revision_id"),
    activeContentActivatedAt: timestamp("active_content_activated_at", {
      withTimezone: true,
    }),
    lastTriggeredAt: timestamp("last_triggered_at", { withTimezone: true }),
    contentCursor: integer("content_cursor").notNull().default(0),
    revision: integer("revision").notNull().default(1),
    createdByUserId: uuid("created_by_user_id")
      .notNull()
      .references(() => userAccounts.id, { onDelete: "restrict" }),
    updatedByUserId: uuid("updated_by_user_id")
      .notNull()
      .references(() => userAccounts.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("child_character_learning_plans_child_character_unique").on(
      table.childUserId,
      table.characterId,
    ),
    index("child_character_learning_plans_child_enabled_idx").on(
      table.childUserId,
      table.enabled,
      table.updatedAt,
    ),
    index("child_character_learning_plans_character_enabled_idx").on(
      table.characterId,
      table.enabled,
    ),
    foreignKey({
      name: "child_character_learning_plans_active_own_revision_fk",
      columns: [table.activeContentRevisionId, table.id],
      get foreignColumns(): [AnyPgColumn, AnyPgColumn] {
        return activeTeachingContentForeignColumns();
      },
    }).onDelete("no action"),
    check(
      "child_character_learning_plans_revision_positive",
      sql`${table.revision} > 0`,
    ),
    check(
      "child_character_learning_plans_content_cursor_nonnegative",
      sql`${table.contentCursor} >= 0`,
    ),
    check(
      "child_character_learning_plans_learning_goal_not_blank",
      sql`${table.learningGoal} IS NULL OR length(btrim(${table.learningGoal})) > 0`,
    ),
    check(
      "child_character_learning_plans_activity_count_bounded",
      sql`${table.activityCount} BETWEEN 3 AND 8`,
    ),
    check(
      "child_character_learning_plans_duration_days_supported",
      sql`${table.durationDays} IN (7, 14)`,
    ),
    check(
      "child_character_learning_plans_active_content_pair",
      sql`(${table.activeContentRevisionId} IS NULL AND ${table.activeContentActivatedAt} IS NULL) OR (${table.activeContentRevisionId} IS NOT NULL AND ${table.activeContentActivatedAt} IS NOT NULL)`,
    ),
  ],
);

export const teachingPlanGenerationRequests = pgTable(
  "teaching_plan_generation_requests",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    learningPlanId: uuid("learning_plan_id")
      .notNull()
      .references(() => childCharacterLearningPlans.id, {
        onDelete: "cascade",
      }),
    clientRequestId: uuid("client_request_id").notNull(),
    expectedPlanRevision: integer("expected_plan_revision").notNull(),
    generationMode: teachingPlanGenerationModeEnum("generation_mode")
      .notNull()
      .default("text_model"),
    generatorSource:
      teachingPlanGeneratorSourceEnum("generator_source").notNull(),
    status: teachingPlanGenerationStatusEnum("status")
      .notNull()
      .default("queued"),
    inputSnapshot: jsonb("input_snapshot")
      .$type<TeachingPlanGenerationInputSnapshot>()
      .notNull(),
    inputHash: varchar("input_hash", { length: 64 }).notNull(),
    modelProfileId: uuid("model_profile_id").references(
      () => providerProfiles.id,
      { onDelete: "restrict" },
    ),
    modelProfileRevision: integer("model_profile_revision"),
    connectionId: uuid("connection_id").references(() => modelConnections.id, {
      onDelete: "restrict",
    }),
    connectionRevision: integer("connection_revision"),
    outputContentRevisionId: uuid("output_content_revision_id"),
    actualModel: varchar("actual_model", { length: 120 }),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    errorCode: varchar("error_code", { length: 80 }),
    requestedByUserId: uuid("requested_by_user_id")
      .notNull()
      .references(() => userAccounts.id, { onDelete: "restrict" }),
    requestedAt: timestamp("requested_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("teaching_plan_generation_requests_plan_client_unique").on(
      table.learningPlanId,
      table.clientRequestId,
    ),
    uniqueIndex("teaching_plan_generation_requests_one_active_per_plan")
      .on(table.learningPlanId)
      .where(sql`${table.status} IN ('queued', 'running')`),
    index("teaching_plan_generation_requests_status_requested_idx").on(
      table.status,
      table.requestedAt,
    ),
    foreignKey({
      name: "teaching_plan_generation_requests_output_own_revision_fk",
      columns: [table.outputContentRevisionId, table.id],
      get foreignColumns(): [AnyPgColumn, AnyPgColumn] {
        return generatedTeachingContentForeignColumns();
      },
    }).onDelete("no action"),
    check(
      "teaching_plan_generation_requests_expected_revision_positive",
      sql`${table.expectedPlanRevision} > 0`,
    ),
    check(
      "teaching_plan_generation_requests_runtime_matches_source",
      sql`(
        ${table.generatorSource} = 'controlled_template'
        AND ${table.modelProfileId} IS NULL
        AND ${table.modelProfileRevision} IS NULL
        AND ${table.connectionId} IS NULL
        AND ${table.connectionRevision} IS NULL
      ) OR (
        ${table.generatorSource} = 'text_model'
        AND ${table.modelProfileId} IS NOT NULL
        AND ${table.modelProfileRevision} IS NOT NULL
        AND ${table.modelProfileRevision} > 0
        AND ${table.connectionId} IS NOT NULL
        AND ${table.connectionRevision} IS NOT NULL
        AND ${table.connectionRevision} > 0
      )`,
    ),
    check(
      "teaching_plan_generation_requests_mode_matches_source",
      sql`${table.generationMode} = 'auto' OR (${table.generationMode} = 'controlled_template' AND ${table.generatorSource} = 'controlled_template') OR (${table.generationMode} = 'text_model' AND ${table.generatorSource} = 'text_model')`,
    ),
    check(
      "teaching_plan_generation_requests_input_json_object",
      sql`jsonb_typeof(${table.inputSnapshot}) = 'object'`,
    ),
    check(
      "teaching_plan_generation_requests_input_identity_matches",
      sql`${table.inputSnapshot} ? 'schemaVersion' AND ${table.inputSnapshot} ? 'generationMode' AND ${table.inputSnapshot} ? 'generatorSource' AND ${table.inputSnapshot} ? 'goalHash' AND NOT (${table.inputSnapshot} ? 'learningGoal') AND jsonb_typeof(${table.inputSnapshot}->'schemaVersion') = 'string' AND jsonb_typeof(${table.inputSnapshot}->'generationMode') = 'string' AND jsonb_typeof(${table.inputSnapshot}->'generatorSource') = 'string' AND jsonb_typeof(${table.inputSnapshot}->'goalHash') = 'string' AND ${table.inputSnapshot}->>'schemaVersion' IN ('teaching-plan-generation-input-v2', 'teaching-plan-generation-input-v3') AND ${table.inputSnapshot}->>'generationMode' = ${table.generationMode}::text AND ${table.inputSnapshot}->>'generatorSource' = ${table.generatorSource}::text AND ${table.inputSnapshot}->>'goalHash' ~ '^[0-9a-f]{64}$' AND (${table.inputSnapshot}->>'schemaVersion' <> 'teaching-plan-generation-input-v3' OR (${table.generationMode} = 'text_model' AND ${table.generatorSource} = 'text_model'))`,
    ),
    check(
      "teaching_plan_generation_requests_input_hash_format",
      sql`${table.inputHash} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "teaching_plan_generation_requests_terminal_time",
      sql`(${table.status} IN ('succeeded', 'failed', 'superseded')) = (${table.completedAt} IS NOT NULL)`,
    ),
    check(
      "teaching_plan_generation_requests_output_matches_status",
      sql`(${table.status} = 'succeeded') = (${table.outputContentRevisionId} IS NOT NULL)`,
    ),
    check(
      "teaching_plan_generation_requests_error_matches_status",
      sql`(${table.status} = 'failed') = (${table.errorCode} IS NOT NULL)`,
    ),
    check(
      "teaching_plan_generation_requests_error_supported",
      sql`${table.errorCode} IS NULL OR ${table.errorCode} IN ('generator_not_configured', 'model_configuration_changed', 'model_request_failed', 'model_result_unknown', 'invalid_generation_input', 'invalid_model_output', 'content_compilation_failed', 'plan_revision_changed', 'worker_interrupted', 'unsupported_goal', 'needs_clarification')`,
    ),
    check(
      "teaching_plan_generation_requests_usage_nonnegative",
      sql`(${table.inputTokens} IS NULL OR ${table.inputTokens} >= 0) AND (${table.outputTokens} IS NULL OR ${table.outputTokens} >= 0)`,
    ),
    check(
      "teaching_plan_generation_requests_times_ordered",
      sql`(${table.startedAt} IS NULL OR ${table.startedAt} >= ${table.requestedAt}) AND (${table.completedAt} IS NULL OR ${table.completedAt} >= ${table.requestedAt})`,
    ),
  ],
);

export const teachingContentRevisions = pgTable(
  "teaching_content_revisions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    learningPlanId: uuid("learning_plan_id")
      .notNull()
      .references(() => childCharacterLearningPlans.id, {
        onDelete: "cascade",
      }),
    revision: integer("revision").notNull(),
    generationRequestId: uuid("generation_request_id")
      .notNull()
      .references(() => teachingPlanGenerationRequests.id, {
        onDelete: "no action",
      }),
    schemaVersion: varchar("schema_version", { length: 60 }).notNull(),
    compilerVersion: varchar("compiler_version", { length: 60 }).notNull(),
    title: varchar("title", { length: 80 }).notNull(),
    normalizedGoal: varchar("normalized_goal", { length: 200 }).notNull(),
    subject: teachingSubjectEnum("subject").notNull(),
    difficulty: teachingDifficultyEnum("difficulty").notNull(),
    gradeLevel: teachingGradeLevelEnum("grade_level").notNull(),
    activityCount: integer("activity_count").notNull(),
    durationDays: integer("duration_days").notNull(),
    contentHash: varchar("content_hash", { length: 64 }).notNull(),
    createdByUserId: uuid("created_by_user_id")
      .notNull()
      .references(() => userAccounts.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("teaching_content_revisions_plan_revision_unique").on(
      table.learningPlanId,
      table.revision,
    ),
    uniqueIndex("teaching_content_revisions_generation_unique").on(
      table.generationRequestId,
    ),
    uniqueIndex("teaching_content_revisions_id_plan_unique").on(
      table.id,
      table.learningPlanId,
    ),
    uniqueIndex("teaching_content_revisions_id_generation_unique").on(
      table.id,
      table.generationRequestId,
    ),
    check(
      "teaching_content_revisions_revision_positive",
      sql`${table.revision} > 0`,
    ),
    check(
      "teaching_content_revisions_versions_supported",
      sql`(${table.schemaVersion} = 'generated-teaching-plan-v1' AND ${table.compilerVersion} = 'controlled-teaching-content-v1') OR (${table.schemaVersion} = 'generated-teaching-plan-v2' AND ${table.compilerVersion} = 'model-generated-teaching-content-v2')`,
    ),
    check(
      "teaching_content_revisions_text_not_blank",
      sql`length(btrim(${table.title})) > 0 AND length(btrim(${table.normalizedGoal})) > 0`,
    ),
    check(
      "teaching_content_revisions_activity_count_bounded",
      sql`${table.activityCount} BETWEEN 3 AND 8`,
    ),
    check(
      "teaching_content_revisions_duration_days_supported",
      sql`${table.durationDays} IN (7, 14)`,
    ),
    check(
      "teaching_content_revisions_content_hash_format",
      sql`${table.contentHash} ~ '^[0-9a-f]{64}$'`,
    ),
  ],
);

export const teachingContentItems = pgTable(
  "teaching_content_items",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    contentRevisionId: uuid("content_revision_id")
      .notNull()
      .references(() => teachingContentRevisions.id, { onDelete: "cascade" }),
    itemKey: varchar("item_key", { length: 64 }).notNull(),
    position: integer("position").notNull(),
    kind: teachingContentItemKindEnum("kind").notNull(),
    structuredContent: jsonb("structured_content")
      .$type<TeachingPlanContentItem>()
      .notNull(),
    compiledDirective: text("compiled_directive").notNull(),
    directiveHash: varchar("directive_hash", { length: 64 }).notNull(),
    maximumAssistantResponses: integer("maximum_assistant_responses")
      .notNull()
      .default(2),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("teaching_content_items_revision_key_unique").on(
      table.contentRevisionId,
      table.itemKey,
    ),
    uniqueIndex("teaching_content_items_revision_position_unique").on(
      table.contentRevisionId,
      table.position,
    ),
    check(
      "teaching_content_items_position_bounded",
      sql`${table.position} BETWEEN 1 AND 8`,
    ),
    check(
      "teaching_content_items_json_object",
      sql`jsonb_typeof(${table.structuredContent}) = 'object'`,
    ),
    check(
      "teaching_content_items_json_identity_matches",
      sql`${table.structuredContent} ? 'kind' AND ${table.structuredContent} ? 'key' AND ${table.structuredContent} ? 'order' AND jsonb_typeof(${table.structuredContent}->'kind') = 'string' AND jsonb_typeof(${table.structuredContent}->'key') = 'string' AND jsonb_typeof(${table.structuredContent}->'order') = 'number' AND ${table.structuredContent}->>'kind' = ${table.kind}::text AND ${table.structuredContent}->>'key' = ${table.itemKey} AND ${table.structuredContent}->'order' = to_jsonb(${table.position})`,
    ),
    check(
      "teaching_content_items_structured_content_bounded",
      sql`octet_length(${table.structuredContent}::text) <= 16000`,
    ),
    check(
      "teaching_content_items_model_source_fixed",
      sql`${table.kind}::text <> 'model_generated_activity' OR (${table.structuredContent}->>'knowledgeSource' = 'model_only' AND NOT (${table.structuredContent} ? 'source') AND NOT (${table.structuredContent} ? 'sources') AND NOT (${table.structuredContent} ? 'url') AND NOT (${table.structuredContent} ? 'urls') AND NOT (${table.structuredContent} ? 'sourceUrl') AND NOT (${table.structuredContent} ? 'sourceUrls') AND NOT (${table.structuredContent} ? 'citation') AND NOT (${table.structuredContent} ? 'citations') AND NOT (${table.structuredContent} ? 'provenance'))`,
    ),
    check(
      "teaching_content_items_compiled_directive_bounded",
      sql`length(btrim(${table.compiledDirective})) > 0 AND length(${table.compiledDirective}) <= 4000`,
    ),
    check(
      "teaching_content_items_directive_hash_format",
      sql`${table.directiveHash} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "teaching_content_items_response_limit_fixed",
      sql`${table.maximumAssistantResponses} = 2`,
    ),
  ],
);

export const conversations = pgTable(
  "conversations",
  {
    id: uuid("id").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => userAccounts.id, { onDelete: "cascade" }),
    characterId: uuid("character_id")
      .notNull()
      .references(() => characters.id, { onDelete: "restrict" }),
    mode: conversationModeEnum("mode").notNull(),
    status: conversationStatusEnum("status").notNull().default("active"),
    provider: realtimeProviderEnum("provider").notNull(),
    model: varchar("model", { length: 120 }).notNull(),
    voice: varchar("voice", { length: 120 }).notNull(),
    messageCount: integer("message_count").notNull().default(0),
    lastSequence: integer("last_sequence").notNull().default(0),
    startedAt: timestamp("started_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("conversations_user_updated_idx").on(table.userId, table.updatedAt),
    index("conversations_user_character_updated_idx").on(
      table.userId,
      table.characterId,
      table.updatedAt,
    ),
    check(
      "conversations_counters_nonnegative",
      sql`${table.messageCount} >= 0 AND ${table.lastSequence} >= 0`,
    ),
    check(
      "conversations_status_times_match",
      sql`(
        (${table.status} = 'active' AND ${table.endedAt} IS NULL)
        OR
        (${table.status} = 'completed' AND ${table.endedAt} IS NOT NULL)
      )`,
    ),
    check(
      "conversations_end_after_start",
      sql`${table.endedAt} IS NULL OR ${table.endedAt} >= ${table.startedAt}`,
    ),
    check(
      "conversations_model_not_blank",
      sql`length(btrim(${table.model})) > 0`,
    ),
    check(
      "conversations_voice_not_blank",
      sql`length(btrim(${table.voice})) > 0`,
    ),
  ],
);

export const conversationRuntimeSnapshots = pgTable(
  "conversation_runtime_snapshots",
  {
    conversationId: uuid("conversation_id")
      .primaryKey()
      .references(() => conversations.id, { onDelete: "cascade" }),
    snapshot: jsonb("snapshot").$type<ConversationRuntimeSnapshot>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
);

export const conversationTeachingStates = pgTable(
  "conversation_teaching_states",
  {
    conversationId: uuid("conversation_id")
      .primaryKey()
      .references(() => conversations.id, { onDelete: "cascade" }),
    learningPlanId: uuid("learning_plan_id").references(
      () => childCharacterLearningPlans.id,
      { onDelete: "restrict" },
    ),
    learningPlanRevision: integer("learning_plan_revision"),
    subject: teachingSubjectEnum("subject"),
    difficulty: teachingDifficultyEnum("difficulty"),
    triggerMode: teachingTriggerModeEnum("trigger_mode"),
    disclosureVersion: varchar("disclosure_version", { length: 40 }),
    contentRevisionId: uuid("content_revision_id"),
    contentCatalogVersion: varchar("content_catalog_version", { length: 40 }),
    state: conversationTeachingStateEnum("state").notNull(),
    muteReason: conversationTeachingMuteReasonEnum("mute_reason"),
    validUserTurns: integer("valid_user_turns").notNull().default(0),
    invitationCount: integer("invitation_count").notNull().default(0),
    activeContentItemId: varchar("active_content_item_id", { length: 160 }),
    revision: integer("revision").notNull().default(1),
    preparedAt: timestamp("prepared_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("conversation_teaching_states_plan_state_idx").on(
      table.learningPlanId,
      table.state,
    ),
    foreignKey({
      name: "conversation_teaching_states_content_own_plan_fk",
      columns: [table.contentRevisionId, table.learningPlanId],
      foreignColumns: [
        teachingContentRevisions.id,
        teachingContentRevisions.learningPlanId,
      ],
    }).onDelete("no action"),
    check(
      "conversation_teaching_states_revision_positive",
      sql`${table.revision} > 0`,
    ),
    check(
      "conversation_teaching_states_counters_bounded",
      sql`${table.validUserTurns} >= 0 AND ${table.invitationCount} >= 0 AND ${table.invitationCount} <= 1`,
    ),
    check(
      "conversation_teaching_states_snapshot_complete",
      sql`(
        (${table.learningPlanId} IS NULL AND ${table.learningPlanRevision} IS NULL AND ${table.subject} IS NULL AND ${table.difficulty} IS NULL AND ${table.triggerMode} IS NULL AND ${table.disclosureVersion} IS NULL AND ${table.contentRevisionId} IS NULL AND ${table.contentCatalogVersion} IS NULL)
        OR
        (${table.learningPlanId} IS NOT NULL AND ${table.learningPlanRevision} IS NOT NULL AND ${table.learningPlanRevision} > 0 AND ${table.subject} IS NOT NULL AND ${table.difficulty} IS NOT NULL AND ${table.triggerMode} IS NOT NULL AND ${table.disclosureVersion} IS NOT NULL AND ${table.contentCatalogVersion} IS NOT NULL)
      )`,
    ),
    check(
      "conversation_teaching_states_disclosure_version_supported",
      sql`${table.disclosureVersion} IS NULL OR ${table.disclosureVersion} = 'teaching-disclosure-v1'`,
    ),
    check(
      "conversation_teaching_states_content_source_supported",
      sql`(${table.contentCatalogVersion} IS NULL AND ${table.contentRevisionId} IS NULL) OR (${table.contentCatalogVersion} = 'reviewed-v1' AND ${table.contentRevisionId} IS NULL) OR (${table.contentCatalogVersion} IN ('generated-v1', 'generated-v2') AND ${table.contentRevisionId} IS NOT NULL)`,
    ),
    check(
      "conversation_teaching_states_state_matches_snapshot",
      sql`(
        (${table.state} IN ('available', 'active', 'completed') AND ${table.learningPlanId} IS NOT NULL AND ${table.muteReason} IS NULL)
        OR
        (${table.state} = 'restoring' AND ${table.learningPlanId} IS NOT NULL)
        OR
        (${table.state} = 'unavailable' AND ${table.learningPlanId} IS NULL AND ${table.muteReason} IS NULL)
        OR
        (${table.state} = 'muted' AND ${table.muteReason} IS NOT NULL)
      )`,
    ),
    check(
      "conversation_teaching_states_active_item_matches_state",
      sql`(
        (${table.state} IN ('active', 'restoring') AND ${table.activeContentItemId} IS NOT NULL AND ${table.invitationCount} = 1)
        OR
        (${table.state} = 'muted' AND (${table.activeContentItemId} IS NULL OR ${table.invitationCount} = 1))
        OR
        (${table.state} IN ('available', 'unavailable') AND ${table.activeContentItemId} IS NULL AND ${table.invitationCount} = 0)
        OR
        (${table.state} = 'completed' AND ${table.activeContentItemId} IS NULL AND ${table.invitationCount} = 1)
      )`,
    ),
    check(
      "conversation_teaching_states_active_item_not_blank",
      sql`${table.activeContentItemId} IS NULL OR length(btrim(${table.activeContentItemId})) > 0`,
    ),
  ],
);

export const teachingEvents = pgTable(
  "teaching_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    learningPlanId: uuid("learning_plan_id").references(
      () => childCharacterLearningPlans.id,
      { onDelete: "set null" },
    ),
    eventType: teachingEventTypeEnum("event_type").notNull(),
    actorUserId: uuid("actor_user_id").references(() => userAccounts.id, {
      onDelete: "set null",
    }),
    stateRevision: integer("state_revision").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("teaching_events_conversation_type_revision_unique").on(
      table.conversationId,
      table.eventType,
      table.stateRevision,
    ),
    index("teaching_events_conversation_created_idx").on(
      table.conversationId,
      table.createdAt,
    ),
    check(
      "teaching_events_state_revision_positive",
      sql`${table.stateRevision} > 0`,
    ),
  ],
);

export const conversationMessages = pgTable(
  "conversation_messages",
  {
    id: uuid("id").primaryKey(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => userAccounts.id, { onDelete: "cascade" }),
    sequence: integer("sequence").notNull(),
    role: conversationMessageRoleEnum("role").notNull(),
    status: conversationMessageStatusEnum("status")
      .notNull()
      .default("completed"),
    text: text("text").notNull(),
    providerEventId: varchar("provider_event_id", { length: 200 }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("conversation_messages_conversation_sequence_unique").on(
      table.conversationId,
      table.sequence,
    ),
    uniqueIndex("conversation_messages_provider_event_unique")
      .on(table.conversationId, table.providerEventId)
      .where(sql`${table.providerEventId} IS NOT NULL`),
    index("conversation_messages_user_created_idx").on(
      table.userId,
      table.createdAt,
    ),
    check(
      "conversation_messages_sequence_positive",
      sql`${table.sequence} > 0`,
    ),
    check(
      "conversation_messages_text_not_blank",
      sql`length(btrim(${table.text})) > 0`,
    ),
  ],
);

export const mediaObjects = pgTable(
  "media_objects",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    ownerUserId: uuid("owner_user_id")
      .notNull()
      .references(() => userAccounts.id, { onDelete: "restrict" }),
    conversationId: uuid("conversation_id").references(() => conversations.id, {
      onDelete: "restrict",
    }),
    kind: mediaObjectKindEnum("kind").notNull(),
    objectKey: varchar("object_key", { length: 512 }).notNull(),
    contentType: varchar("content_type", { length: 160 }).notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    checksumSha256: varchar("checksum_sha256", { length: 64 }).notNull(),
    retention: mediaRetentionEnum("retention").notNull(),
    status: mediaObjectStatusEnum("status").notNull().default("available"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("media_objects_object_key_unique").on(table.objectKey),
    index("media_objects_owner_created_idx").on(
      table.ownerUserId,
      table.createdAt,
    ),
    index("media_objects_conversation_created_idx").on(
      table.conversationId,
      table.createdAt,
    ),
    index("media_objects_expiration_idx")
      .on(table.expiresAt)
      .where(
        sql`${table.status} = 'available' AND ${table.retention} = 'temporary'`,
      ),
    check("media_objects_size_nonnegative", sql`${table.sizeBytes} >= 0`),
    check(
      "media_objects_key_not_blank",
      sql`length(btrim(${table.objectKey})) > 0`,
    ),
    check(
      "media_objects_content_type_not_blank",
      sql`length(btrim(${table.contentType})) > 0`,
    ),
    check(
      "media_objects_checksum_sha256_format",
      sql`${table.checksumSha256} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "media_objects_retention_expiry_match",
      sql`(
        (${table.retention} = 'temporary' AND ${table.expiresAt} IS NOT NULL)
        OR
        (${table.retention} = 'retained' AND ${table.expiresAt} IS NULL)
      )`,
    ),
    check(
      "media_objects_conversation_kind_match",
      sql`(
        (${table.kind} IN ('call_recording', 'conversation_image') AND ${table.conversationId} IS NOT NULL)
        OR
        (${table.kind} IN ('character_avatar', 'avatar_preview') AND ${table.conversationId} IS NULL)
      )`,
    ),
    check(
      "media_objects_deletion_state_match",
      sql`(
        (${table.status} IN ('available', 'pending_deletion') AND ${table.deletedAt} IS NULL)
        OR
        (${table.status} = 'deleted' AND ${table.deletedAt} IS NOT NULL)
      )`,
    ),
  ],
);

export const aiWorkItems = pgTable(
  "ai_work_items",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    purpose: modelPurposeEnum("purpose").notNull(),
    modelProfileId: uuid("model_profile_id").references(
      () => providerProfiles.id,
      { onDelete: "restrict" },
    ),
    status: aiWorkStatusEnum("status")
      .notNull()
      .default("waiting_configuration"),
    completedSequence: integer("completed_sequence").notNull(),
    lastErrorCode: varchar("last_error_code", { length: 120 }),
    queuedAt: timestamp("queued_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("ai_work_items_conversation_purpose_unique").on(
      table.conversationId,
      table.purpose,
    ),
    index("ai_work_items_status_purpose_idx").on(table.status, table.purpose),
    check(
      "ai_work_items_analysis_purpose",
      sql`${table.purpose} IN ('conversation_summary', 'memory_extraction')`,
    ),
    check(
      "ai_work_items_binding_matches_status",
      sql`(${table.status} = 'waiting_configuration' AND ${table.modelProfileId} IS NULL) OR (${table.status} <> 'waiting_configuration' AND ${table.modelProfileId} IS NOT NULL)`,
    ),
  ],
);

export const conversationSummaries = pgTable(
  "conversation_summaries",
  {
    conversationId: uuid("conversation_id")
      .primaryKey()
      .references(() => conversations.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => userAccounts.id, { onDelete: "cascade" }),
    characterId: uuid("character_id")
      .notNull()
      .references(() => characters.id, { onDelete: "restrict" }),
    content: text("content").notNull(),
    sourceMessageCount: integer("source_message_count").notNull(),
    sourceLastSequence: integer("source_last_sequence").notNull(),
    analyzerModel: varchar("analyzer_model", { length: 120 }).notNull(),
    analyzerProfileId: uuid("analyzer_profile_id").references(
      () => providerProfiles.id,
      { onDelete: "restrict" },
    ),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("conversation_summaries_user_character_updated_idx").on(
      table.userId,
      table.characterId,
      table.updatedAt,
    ),
    check(
      "conversation_summaries_content_not_blank",
      sql`length(btrim(${table.content})) > 0`,
    ),
    check(
      "conversation_summaries_source_counters_nonnegative",
      sql`${table.sourceMessageCount} >= 0 AND ${table.sourceLastSequence} >= 0`,
    ),
    check(
      "conversation_summaries_analyzer_model_not_blank",
      sql`length(btrim(${table.analyzerModel})) > 0`,
    ),
  ],
);

export type ConversationSummaryCheckpointStatus =
  "waiting_configuration" | "queued" | "completed" | "failed";

export const conversationSummaryCheckpoints = pgTable(
  "conversation_summary_checkpoints",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    sourceLastSequence: integer("source_last_sequence").notNull(),
    sourceMessageCount: integer("source_message_count").notNull(),
    status: varchar("status", { length: 32 })
      .$type<ConversationSummaryCheckpointStatus>()
      .notNull(),
    modelProfileId: uuid("model_profile_id").references(
      () => providerProfiles.id,
      { onDelete: "restrict" },
    ),
    content: text("content"),
    analyzerModel: varchar("analyzer_model", { length: 120 }),
    lastErrorCode: varchar("last_error_code", { length: 120 }),
    queuedAt: timestamp("queued_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex(
      "conversation_summary_checkpoints_conversation_sequence_unique",
    ).on(table.conversationId, table.sourceLastSequence),
    index("conversation_summary_checkpoints_status_idx").on(table.status),
    index(
      "conversation_summary_checkpoints_conversation_status_sequence_idx",
    ).on(table.conversationId, table.status, table.sourceLastSequence),
    check(
      "conversation_summary_checkpoints_source_counters_positive",
      sql`${table.sourceLastSequence} > 0 AND ${table.sourceMessageCount} > 0`,
    ),
    check(
      "conversation_summary_checkpoints_status_valid",
      sql`${table.status} IN ('waiting_configuration', 'queued', 'completed', 'failed')`,
    ),
    check(
      "conversation_summary_checkpoints_binding_matches_status",
      sql`(${table.status} = 'waiting_configuration' AND ${table.modelProfileId} IS NULL) OR (${table.status} <> 'waiting_configuration' AND ${table.modelProfileId} IS NOT NULL)`,
    ),
    check(
      "conversation_summary_checkpoints_content_matches_status",
      sql`(${table.status} = 'completed' AND ${table.content} IS NOT NULL AND length(btrim(${table.content})) > 0 AND ${table.analyzerModel} IS NOT NULL AND ${table.completedAt} IS NOT NULL) OR (${table.status} <> 'completed' AND ${table.content} IS NULL AND ${table.completedAt} IS NULL)`,
    ),
    check(
      "conversation_summary_checkpoints_queue_time_matches_status",
      sql`(${table.status} = 'waiting_configuration' AND ${table.queuedAt} IS NULL) OR (${table.status} <> 'waiting_configuration' AND ${table.queuedAt} IS NOT NULL)`,
    ),
  ],
);

export const characterMemories = pgTable(
  "character_memories",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => userAccounts.id, { onDelete: "cascade" }),
    characterId: uuid("character_id")
      .notNull()
      .references(() => characters.id, { onDelete: "restrict" }),
    sourceConversationId: uuid("source_conversation_id").references(
      () => conversations.id,
      { onDelete: "set null" },
    ),
    contentFingerprint: varchar("content_fingerprint", {
      length: 64,
    }).notNull(),
    content: text("content").notNull(),
    sourceExcerpt: text("source_excerpt").notNull(),
    confidence: real("confidence").notNull(),
    analyzerModel: varchar("analyzer_model", { length: 120 }),
    analyzerProfileId: uuid("analyzer_profile_id").references(
      () => providerProfiles.id,
      { onDelete: "restrict" },
    ),
    status: characterMemoryStatusEnum("status").notNull(),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("character_memories_user_character_fingerprint_unique").on(
      table.userId,
      table.characterId,
      table.contentFingerprint,
    ),
    index("character_memories_user_status_updated_idx").on(
      table.userId,
      table.status,
      table.updatedAt,
    ),
    index("character_memories_user_character_status_idx").on(
      table.userId,
      table.characterId,
      table.status,
    ),
    check(
      "character_memories_content_not_blank",
      sql`length(btrim(${table.content})) > 0`,
    ),
    check(
      "character_memories_source_excerpt_not_blank",
      sql`length(btrim(${table.sourceExcerpt})) > 0`,
    ),
    check(
      "character_memories_confidence_range",
      sql`${table.confidence} >= 0 AND ${table.confidence} <= 1`,
    ),
  ],
);

export type MemoryIndexStatus = "pending" | "synced" | "failed";

export const memoryIndexEntries = pgTable(
  "memory_index_entries",
  {
    memoryId: uuid("memory_id")
      .primaryKey()
      .references(() => characterMemories.id, { onDelete: "cascade" }),
    provider: varchar("provider", { length: 32 }).notNull().default("mem0"),
    externalId: varchar("external_id", { length: 256 }),
    indexedFingerprint: varchar("indexed_fingerprint", { length: 64 }),
    indexRevision: varchar("index_revision", { length: 64 }),
    status: varchar("status", { length: 32 })
      .$type<MemoryIndexStatus>()
      .notNull()
      .default("pending"),
    attemptCount: integer("attempt_count").notNull().default(0),
    lastErrorCode: varchar("last_error_code", { length: 120 }),
    syncedAt: timestamp("synced_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("memory_index_entries_external_id_unique").on(table.externalId),
    index("memory_index_entries_status_updated_idx").on(
      table.status,
      table.updatedAt,
    ),
    check(
      "memory_index_entries_provider_valid",
      sql`${table.provider} = 'mem0'`,
    ),
    check(
      "memory_index_entries_status_valid",
      sql`${table.status} IN ('pending', 'synced', 'failed')`,
    ),
    check(
      "memory_index_entries_attempt_count_nonnegative",
      sql`${table.attemptCount} >= 0`,
    ),
  ],
);

export const relationshipTransferImports = pgTable(
  "relationship_transfer_imports",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    targetUserId: uuid("target_user_id")
      .notNull()
      .references(() => userAccounts.id, { onDelete: "cascade" }),
    targetCharacterId: uuid("target_character_id")
      .notNull()
      .references(() => characters.id, { onDelete: "restrict" }),
    transferId: uuid("transfer_id").notNull(),
    packageChecksum: varchar("package_checksum", { length: 64 }).notNull(),
    sourceCharacterName: varchar("source_character_name", {
      length: 80,
    }).notNull(),
    sourceCharacterSystemKey: varchar("source_character_system_key", {
      length: 120,
    }),
    importedConversationCount: integer("imported_conversation_count")
      .notNull()
      .default(0),
    skippedConversationCount: integer("skipped_conversation_count")
      .notNull()
      .default(0),
    importedMemoryCount: integer("imported_memory_count").notNull().default(0),
    skippedMemoryCount: integer("skipped_memory_count").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("relationship_transfer_imports_user_transfer_unique").on(
      table.targetUserId,
      table.transferId,
    ),
    index("relationship_transfer_imports_user_character_created_idx").on(
      table.targetUserId,
      table.targetCharacterId,
      table.createdAt,
    ),
    check(
      "relationship_transfer_imports_checksum_format",
      sql`${table.packageChecksum} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "relationship_transfer_imports_source_name_not_blank",
      sql`length(btrim(${table.sourceCharacterName})) > 0`,
    ),
    check(
      "relationship_transfer_imports_counts_nonnegative",
      sql`${table.importedConversationCount} >= 0 AND ${table.skippedConversationCount} >= 0 AND ${table.importedMemoryCount} >= 0 AND ${table.skippedMemoryCount} >= 0`,
    ),
  ],
);

export const relationshipTransferConversationOrigins = pgTable(
  "relationship_transfer_conversation_origins",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    transferImportId: uuid("transfer_import_id")
      .notNull()
      .references(() => relationshipTransferImports.id, {
        onDelete: "cascade",
      }),
    targetUserId: uuid("target_user_id")
      .notNull()
      .references(() => userAccounts.id, { onDelete: "cascade" }),
    targetCharacterId: uuid("target_character_id")
      .notNull()
      .references(() => characters.id, { onDelete: "restrict" }),
    sourceConversationId: uuid("source_conversation_id").notNull(),
    importedConversationId: uuid("imported_conversation_id").references(
      () => conversations.id,
      { onDelete: "set null" },
    ),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex(
      "relationship_transfer_origins_user_character_source_unique",
    ).on(
      table.targetUserId,
      table.targetCharacterId,
      table.sourceConversationId,
    ),
    uniqueIndex("relationship_transfer_origins_conversation_unique")
      .on(table.importedConversationId)
      .where(sql`${table.importedConversationId} IS NOT NULL`),
    index("relationship_transfer_origins_import_idx").on(
      table.transferImportId,
    ),
  ],
);

export const companionDevices = pgTable(
  "companion_devices",
  {
    id: uuid("id").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => userAccounts.id, { onDelete: "cascade" }),
    displayName: varchar("display_name", { length: 80 }).notNull(),
    selectedCharacterId: uuid("selected_character_id").references(
      () => characters.id,
      { onDelete: "set null" },
    ),
    serial: varchar("serial", { length: 64 }),
    firmwareVersion: varchar("firmware_version", { length: 32 }),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("companion_devices_user_id_idx").on(table.userId),
    check(
      "companion_devices_display_name_not_blank",
      sql`length(btrim(${table.displayName})) > 0`,
    ),
  ],
);

export const devicePairingSessions = pgTable(
  "device_pairing_sessions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    codeHash: varchar("code_hash", { length: 64 }).notNull(),
    devicePublicId: uuid("device_public_id").notNull(),
    displayName: varchar("display_name", { length: 80 }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    claimedByUserId: uuid("claimed_by_user_id").references(
      () => userAccounts.id,
      { onDelete: "set null" },
    ),
    pendingDeviceCredential: text("pending_device_credential"),
    credentialDeliveredAt: timestamp("credential_delivered_at", {
      withTimezone: true,
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("device_pairing_sessions_code_hash_unique").on(table.codeHash),
    uniqueIndex("device_pairing_sessions_device_public_id_unique").on(
      table.devicePublicId,
    ),
    index("device_pairing_sessions_expires_at_idx").on(table.expiresAt),
    check(
      "device_pairing_sessions_display_name_not_blank",
      sql`length(btrim(${table.displayName})) > 0`,
    ),
    check(
      "device_pairing_sessions_expiry_after_creation",
      sql`${table.expiresAt} > ${table.createdAt}`,
    ),
    check(
      "device_pairing_sessions_claim_fields_match",
      sql`(
        (${table.claimedAt} IS NULL AND ${table.claimedByUserId} IS NULL AND ${table.pendingDeviceCredential} IS NULL)
        OR
        (${table.claimedAt} IS NOT NULL AND ${table.claimedByUserId} IS NOT NULL)
      )`,
    ),
  ],
);

export const deviceCredentials = pgTable(
  "device_credentials",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    deviceId: uuid("device_id")
      .notNull()
      .references(() => companionDevices.id, { onDelete: "cascade" }),
    tokenHash: varchar("token_hash", { length: 64 }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("device_credentials_token_hash_unique").on(table.tokenHash),
    index("device_credentials_device_id_idx").on(table.deviceId),
    index("device_credentials_active_device_expires_idx")
      .on(table.deviceId, table.expiresAt)
      .where(sql`${table.revokedAt} IS NULL`),
    check(
      "device_credentials_expiry_after_creation",
      sql`${table.expiresAt} > ${table.createdAt}`,
    ),
    check(
      "device_credentials_revocation_after_creation",
      sql`${table.revokedAt} IS NULL OR ${table.revokedAt} >= ${table.createdAt}`,
    ),
  ],
);

export type UserAccount = typeof userAccounts.$inferSelect;
export type NewUserAccount = typeof userAccounts.$inferInsert;
export type PasswordCredential = typeof passwordCredentials.$inferSelect;
export type NewPasswordCredential = typeof passwordCredentials.$inferInsert;
export type LoginSession = typeof loginSessions.$inferSelect;
export type NewLoginSession = typeof loginSessions.$inferInsert;
export type CompanionDeviceRecord = typeof companionDevices.$inferSelect;
export type NewCompanionDeviceRecord = typeof companionDevices.$inferInsert;
export type DevicePairingSessionRecord =
  typeof devicePairingSessions.$inferSelect;
export type NewDevicePairingSessionRecord =
  typeof devicePairingSessions.$inferInsert;
export type DeviceCredentialRecord = typeof deviceCredentials.$inferSelect;
export type NewDeviceCredentialRecord = typeof deviceCredentials.$inferInsert;
export type AccountSecurityAuditEvent =
  typeof accountSecurityAuditEvents.$inferSelect;
export type NewAccountSecurityAuditEvent =
  typeof accountSecurityAuditEvents.$inferInsert;
export type ProviderProfileRecord = typeof providerProfiles.$inferSelect;
export type NewProviderProfileRecord = typeof providerProfiles.$inferInsert;
export type ModelConnectionRecord = typeof modelConnections.$inferSelect;
export type NewModelConnectionRecord = typeof modelConnections.$inferInsert;
export type VoiceProfileRecord = typeof voiceProfiles.$inferSelect;
export type NewVoiceProfileRecord = typeof voiceProfiles.$inferInsert;
export type TeachingSpikeLiveAuthorizationRecord =
  typeof teachingSpikeLiveAuthorizations.$inferSelect;
export type NewTeachingSpikeLiveAuthorizationRecord =
  typeof teachingSpikeLiveAuthorizations.$inferInsert;
export type CharacterRecord = typeof characters.$inferSelect;
export type NewCharacterRecord = typeof characters.$inferInsert;
export type CharacterAuditEvent = typeof characterAuditEvents.$inferSelect;
export type NewCharacterAuditEvent = typeof characterAuditEvents.$inferInsert;
export type ChildCharacterLearningPlanRecord =
  typeof childCharacterLearningPlans.$inferSelect;
export type NewChildCharacterLearningPlanRecord =
  typeof childCharacterLearningPlans.$inferInsert;
export type TeachingPlanGenerationRequestRecord =
  typeof teachingPlanGenerationRequests.$inferSelect;
export type NewTeachingPlanGenerationRequestRecord =
  typeof teachingPlanGenerationRequests.$inferInsert;
export type TeachingContentRevisionRecord =
  typeof teachingContentRevisions.$inferSelect;
export type NewTeachingContentRevisionRecord =
  typeof teachingContentRevisions.$inferInsert;
export type TeachingContentItemRecord =
  typeof teachingContentItems.$inferSelect;
export type NewTeachingContentItemRecord =
  typeof teachingContentItems.$inferInsert;
export type ConversationRecord = typeof conversations.$inferSelect;
export type NewConversationRecord = typeof conversations.$inferInsert;
export type ConversationRuntimeSnapshotRecord =
  typeof conversationRuntimeSnapshots.$inferSelect;
export type ConversationTeachingStateRecord =
  typeof conversationTeachingStates.$inferSelect;
export type TeachingEventRecord = typeof teachingEvents.$inferSelect;
export type ConversationMessageRecord =
  typeof conversationMessages.$inferSelect;
export type NewConversationMessageRecord =
  typeof conversationMessages.$inferInsert;
export type MediaObjectRecord = typeof mediaObjects.$inferSelect;
export type NewMediaObjectRecord = typeof mediaObjects.$inferInsert;
export type ConversationSummaryRecord =
  typeof conversationSummaries.$inferSelect;
export type NewConversationSummaryRecord =
  typeof conversationSummaries.$inferInsert;
export type ConversationSummaryCheckpointRecord =
  typeof conversationSummaryCheckpoints.$inferSelect;
export type AiWorkItemRecord = typeof aiWorkItems.$inferSelect;
export type NewAiWorkItemRecord = typeof aiWorkItems.$inferInsert;
export type CharacterMemoryRecord = typeof characterMemories.$inferSelect;
export type NewCharacterMemoryRecord = typeof characterMemories.$inferInsert;
export type MemoryIndexEntryRecord = typeof memoryIndexEntries.$inferSelect;
