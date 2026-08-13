import { sql } from "drizzle-orm";
import type {
  ConversationPolicy,
  PersonaDefinition,
  ProviderCapabilities,
  VisualProfile,
  VoiceStyle,
} from "@meet/protocol";
import {
  check,
  boolean,
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
} from "drizzle-orm/pg-core";

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
]);

export const modelProfileKindEnum = pgEnum("model_profile_kind", [
  "realtime_voice",
  "text",
]);

export const modelConfigurationStatusEnum = pgEnum(
  "model_configuration_status",
  ["draft", "enabled", "disabled"],
);

export const modelPurposeEnum = pgEnum("model_purpose", [
  "realtime_default",
  "conversation_summary",
  "memory_extraction",
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
      sql`(${table.endpoint} IS NOT NULL AND ${table.apiKey} IS NOT NULL) OR (${table.pendingEndpoint} IS NOT NULL AND ${table.pendingApiKey} IS NOT NULL)`,
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

export type UserAccount = typeof userAccounts.$inferSelect;
export type NewUserAccount = typeof userAccounts.$inferInsert;
export type PasswordCredential = typeof passwordCredentials.$inferSelect;
export type NewPasswordCredential = typeof passwordCredentials.$inferInsert;
export type LoginSession = typeof loginSessions.$inferSelect;
export type NewLoginSession = typeof loginSessions.$inferInsert;
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
export type CharacterRecord = typeof characters.$inferSelect;
export type NewCharacterRecord = typeof characters.$inferInsert;
export type CharacterAuditEvent = typeof characterAuditEvents.$inferSelect;
export type NewCharacterAuditEvent = typeof characterAuditEvents.$inferInsert;
export type ConversationRecord = typeof conversations.$inferSelect;
export type NewConversationRecord = typeof conversations.$inferInsert;
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
export type AiWorkItemRecord = typeof aiWorkItems.$inferSelect;
export type NewAiWorkItemRecord = typeof aiWorkItems.$inferInsert;
export type CharacterMemoryRecord = typeof characterMemories.$inferSelect;
export type NewCharacterMemoryRecord = typeof characterMemories.$inferInsert;
