CREATE TYPE "public"."user_account_type" AS ENUM('admin', 'adult', 'child');
--> statement-breakpoint
CREATE TYPE "public"."user_account_status" AS ENUM('active', 'disabled');
--> statement-breakpoint
CREATE TYPE "public"."guardian_history_access" AS ENUM('allowed', 'denied');
--> statement-breakpoint
CREATE TYPE "public"."login_session_revocation_reason" AS ENUM('logout', 'password_reset', 'account_disabled', 'admin_revoked');
--> statement-breakpoint
CREATE TYPE "public"."security_actor_type" AS ENUM('user', 'server_command', 'system');
--> statement-breakpoint
CREATE TYPE "public"."account_security_event_type" AS ENUM('initial_admin_created', 'member_account_created', 'account_status_changed', 'password_changed', 'password_reset', 'sessions_revoked');
--> statement-breakpoint
CREATE TABLE "user_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"username" varchar(64) NOT NULL,
	"username_canonical" varchar(256) NOT NULL,
	"display_name" varchar(80) NOT NULL,
	"account_type" "user_account_type" NOT NULL,
	"status" "user_account_status" DEFAULT 'active' NOT NULL,
	"guardian_history_access" "guardian_history_access" DEFAULT 'allowed',
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_accounts_username_not_blank" CHECK (length(btrim("user_accounts"."username")) > 0),
	CONSTRAINT "user_accounts_username_canonical_not_blank" CHECK (length("user_accounts"."username_canonical") > 0),
	CONSTRAINT "user_accounts_display_name_not_blank" CHECK (length(btrim("user_accounts"."display_name")) > 0),
	CONSTRAINT "user_accounts_guardian_access_matches_type" CHECK ((
		("user_accounts"."account_type" = 'child' AND "user_accounts"."guardian_history_access" IS NOT NULL)
		OR
		("user_accounts"."account_type" <> 'child' AND "user_accounts"."guardian_history_access" IS NULL)
	))
);
--> statement-breakpoint
CREATE TABLE "password_credentials" (
	"user_id" uuid NOT NULL,
	"password_hash" text NOT NULL,
	"password_changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "password_credentials_pkey" PRIMARY KEY("user_id"),
	CONSTRAINT "password_credentials_hash_not_blank" CHECK (length("password_credentials"."password_hash") > 0)
);
--> statement-breakpoint
CREATE TABLE "login_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" varchar(64) NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"revocation_reason" "login_session_revocation_reason",
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "login_sessions_expiry_after_creation" CHECK ("login_sessions"."expires_at" > "login_sessions"."created_at"),
	CONSTRAINT "login_sessions_revocation_fields_match" CHECK ((
		("login_sessions"."revoked_at" IS NULL AND "login_sessions"."revocation_reason" IS NULL)
		OR
		("login_sessions"."revoked_at" IS NOT NULL AND "login_sessions"."revocation_reason" IS NOT NULL)
	)),
	CONSTRAINT "login_sessions_revocation_after_creation" CHECK ("login_sessions"."revoked_at" IS NULL OR "login_sessions"."revoked_at" >= "login_sessions"."created_at")
);
--> statement-breakpoint
CREATE TABLE "account_security_audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_type" "account_security_event_type" NOT NULL,
	"actor_type" "security_actor_type" NOT NULL,
	"actor_user_id" uuid,
	"target_user_id" uuid NOT NULL,
	"login_session_id" uuid,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "account_security_audit_actor_matches_type" CHECK ((
		("account_security_audit_events"."actor_type" = 'user' AND "account_security_audit_events"."actor_user_id" IS NOT NULL)
		OR
		("account_security_audit_events"."actor_type" <> 'user' AND "account_security_audit_events"."actor_user_id" IS NULL)
	))
);
--> statement-breakpoint
ALTER TABLE "password_credentials" ADD CONSTRAINT "password_credentials_user_id_user_accounts_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user_accounts"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "login_sessions" ADD CONSTRAINT "login_sessions_user_id_user_accounts_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user_accounts"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "account_security_audit_events" ADD CONSTRAINT "account_security_audit_events_actor_user_id_user_accounts_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."user_accounts"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "account_security_audit_events" ADD CONSTRAINT "account_security_audit_events_target_user_id_user_accounts_id_fk" FOREIGN KEY ("target_user_id") REFERENCES "public"."user_accounts"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "account_security_audit_events" ADD CONSTRAINT "account_security_audit_events_login_session_id_login_sessions_id_fk" FOREIGN KEY ("login_session_id") REFERENCES "public"."login_sessions"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "user_accounts_username_canonical_unique" ON "user_accounts" USING btree ("username_canonical");
--> statement-breakpoint
CREATE UNIQUE INDEX "login_sessions_token_hash_unique" ON "login_sessions" USING btree ("token_hash");
--> statement-breakpoint
CREATE INDEX "login_sessions_user_id_idx" ON "login_sessions" USING btree ("user_id");
--> statement-breakpoint
CREATE INDEX "login_sessions_active_user_expires_idx" ON "login_sessions" USING btree ("user_id", "expires_at") WHERE "login_sessions"."revoked_at" IS NULL;
--> statement-breakpoint
CREATE INDEX "account_security_audit_target_created_idx" ON "account_security_audit_events" USING btree ("target_user_id", "created_at");
--> statement-breakpoint
CREATE INDEX "account_security_audit_actor_created_idx" ON "account_security_audit_events" USING btree ("actor_user_id", "created_at");
