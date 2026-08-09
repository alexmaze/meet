import { sql } from "drizzle-orm";
import {
  check,
  index,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
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
