CREATE TABLE "companion_devices" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"display_name" varchar(80) NOT NULL,
	"selected_character_id" uuid,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "companion_devices_display_name_not_blank" CHECK (length(btrim("companion_devices"."display_name")) > 0)
);
--> statement-breakpoint
CREATE TABLE "device_pairing_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code_hash" varchar(64) NOT NULL,
	"device_public_id" uuid NOT NULL,
	"display_name" varchar(80) NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"claimed_at" timestamp with time zone,
	"claimed_by_user_id" uuid,
	"pending_device_credential" text,
	"credential_delivered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "device_pairing_sessions_display_name_not_blank" CHECK (length(btrim("device_pairing_sessions"."display_name")) > 0),
	CONSTRAINT "device_pairing_sessions_expiry_after_creation" CHECK ("device_pairing_sessions"."expires_at" > "device_pairing_sessions"."created_at"),
	CONSTRAINT "device_pairing_sessions_claim_fields_match" CHECK ((("device_pairing_sessions"."claimed_at" IS NULL AND "device_pairing_sessions"."claimed_by_user_id" IS NULL AND "device_pairing_sessions"."pending_device_credential" IS NULL) OR ("device_pairing_sessions"."claimed_at" IS NOT NULL AND "device_pairing_sessions"."claimed_by_user_id" IS NOT NULL)))
);
--> statement-breakpoint
CREATE TABLE "device_credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"device_id" uuid NOT NULL,
	"token_hash" varchar(64) NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "device_credentials_expiry_after_creation" CHECK ("device_credentials"."expires_at" > "device_credentials"."created_at"),
	CONSTRAINT "device_credentials_revocation_after_creation" CHECK ("device_credentials"."revoked_at" IS NULL OR "device_credentials"."revoked_at" >= "device_credentials"."created_at")
);
--> statement-breakpoint
ALTER TABLE "companion_devices" ADD CONSTRAINT "companion_devices_user_id_user_accounts_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user_accounts"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "companion_devices" ADD CONSTRAINT "companion_devices_selected_character_id_characters_id_fk" FOREIGN KEY ("selected_character_id") REFERENCES "public"."characters"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "device_pairing_sessions" ADD CONSTRAINT "device_pairing_sessions_claimed_by_user_id_user_accounts_id_fk" FOREIGN KEY ("claimed_by_user_id") REFERENCES "public"."user_accounts"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "device_credentials" ADD CONSTRAINT "device_credentials_device_id_companion_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."companion_devices"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "companion_devices_user_id_idx" ON "companion_devices" USING btree ("user_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "device_pairing_sessions_code_hash_unique" ON "device_pairing_sessions" USING btree ("code_hash");
--> statement-breakpoint
CREATE UNIQUE INDEX "device_pairing_sessions_device_public_id_unique" ON "device_pairing_sessions" USING btree ("device_public_id");
--> statement-breakpoint
CREATE INDEX "device_pairing_sessions_expires_at_idx" ON "device_pairing_sessions" USING btree ("expires_at");
--> statement-breakpoint
CREATE UNIQUE INDEX "device_credentials_token_hash_unique" ON "device_credentials" USING btree ("token_hash");
--> statement-breakpoint
CREATE INDEX "device_credentials_device_id_idx" ON "device_credentials" USING btree ("device_id");
--> statement-breakpoint
CREATE INDEX "device_credentials_active_device_expires_idx" ON "device_credentials" USING btree ("device_id","expires_at") WHERE "device_credentials"."revoked_at" IS NULL;
