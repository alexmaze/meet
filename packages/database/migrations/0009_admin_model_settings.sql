CREATE TYPE "public"."model_connection_adapter" AS ENUM('qwen_realtime', 'doubao_realtime', 'openai_chat_completions');--> statement-breakpoint
CREATE TYPE "public"."model_profile_kind" AS ENUM('realtime_voice', 'text');--> statement-breakpoint
CREATE TYPE "public"."model_configuration_status" AS ENUM('draft', 'enabled', 'disabled');--> statement-breakpoint
CREATE TYPE "public"."model_purpose" AS ENUM('realtime_default', 'conversation_summary', 'memory_extraction');--> statement-breakpoint
CREATE TYPE "public"."ai_work_status" AS ENUM('waiting_configuration', 'queued', 'completed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."model_configuration_audit_action" AS ENUM('connection_created', 'connection_updated', 'connection_promoted', 'model_created', 'model_updated', 'model_tested', 'model_status_changed', 'model_deleted', 'voice_created', 'voice_tested', 'voice_deleted', 'binding_changed');--> statement-breakpoint

CREATE TABLE "model_connections" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "adapter" "model_connection_adapter" NOT NULL,
  "display_name" varchar(120) NOT NULL,
  "endpoint" text,
  "api_key" text,
  "pending_endpoint" text,
  "pending_api_key" text,
  "compatibility_preset" varchar(40),
  "pending_compatibility_preset" varchar(40),
  "status" "model_configuration_status" DEFAULT 'draft' NOT NULL,
  "revision" integer DEFAULT 1 NOT NULL,
  "verified_at" timestamp with time zone,
  "created_by_user_id" uuid NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "model_connections_display_name_not_blank" CHECK (length(btrim("display_name")) > 0),
  CONSTRAINT "model_connections_revision_positive" CHECK ("revision" > 0),
  CONSTRAINT "model_connections_has_configuration" CHECK (("endpoint" IS NOT NULL AND "api_key" IS NOT NULL) OR ("pending_endpoint" IS NOT NULL AND "pending_api_key" IS NOT NULL))
);--> statement-breakpoint

ALTER TABLE "provider_profiles" ADD COLUMN "connection_id" uuid;--> statement-breakpoint
ALTER TABLE "provider_profiles" ADD COLUMN "kind" "model_profile_kind" DEFAULT 'realtime_voice' NOT NULL;--> statement-breakpoint
ALTER TABLE "provider_profiles" ADD COLUMN "status" "model_configuration_status" DEFAULT 'draft' NOT NULL;--> statement-breakpoint
ALTER TABLE "provider_profiles" ADD COLUMN "revision" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "provider_profiles" ADD COLUMN "verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "provider_profiles" ADD COLUMN "ever_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "provider_profiles" ADD COLUMN "created_by_user_id" uuid;--> statement-breakpoint
DROP INDEX "provider_profiles_provider_model_unique";--> statement-breakpoint
CREATE UNIQUE INDEX "provider_profiles_connection_kind_model_unique" ON "provider_profiles" USING btree ("connection_id", "kind", "model");--> statement-breakpoint
ALTER TABLE "provider_profiles" ADD CONSTRAINT "provider_profiles_revision_positive" CHECK ("revision" > 0);--> statement-breakpoint

ALTER TABLE "voice_profiles" ADD COLUMN "source" varchar(20) DEFAULT 'builtin' NOT NULL;--> statement-breakpoint
ALTER TABLE "voice_profiles" ADD COLUMN "status" "model_configuration_status" DEFAULT 'draft' NOT NULL;--> statement-breakpoint
ALTER TABLE "voice_profiles" ADD COLUMN "revision" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "voice_profiles" ADD COLUMN "verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "voice_profiles" ADD COLUMN "created_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "voice_profiles" ADD CONSTRAINT "voice_profiles_revision_positive" CHECK ("revision" > 0);--> statement-breakpoint
ALTER TABLE "voice_profiles" ADD CONSTRAINT "voice_profiles_source_valid" CHECK ("source" IN ('builtin', 'custom'));--> statement-breakpoint

CREATE TABLE "model_purpose_bindings" (
  "purpose" "model_purpose" PRIMARY KEY NOT NULL,
  "model_profile_id" uuid NOT NULL,
  "updated_by_user_id" uuid NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

CREATE TABLE "model_configuration_audit_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "action" "model_configuration_audit_action" NOT NULL,
  "actor_user_id" uuid NOT NULL,
  "entity_type" varchar(40) NOT NULL,
  "entity_id" uuid NOT NULL,
  "details" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX "model_configuration_audit_entity_created_idx" ON "model_configuration_audit_events" USING btree ("entity_type", "entity_id", "created_at");--> statement-breakpoint

CREATE TABLE "ai_work_items" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "conversation_id" uuid NOT NULL,
  "purpose" "model_purpose" NOT NULL,
  "model_profile_id" uuid,
  "status" "ai_work_status" DEFAULT 'waiting_configuration' NOT NULL,
  "completed_sequence" integer NOT NULL,
  "last_error_code" varchar(120),
  "queued_at" timestamp with time zone,
  "completed_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "ai_work_items_analysis_purpose" CHECK ("purpose" IN ('conversation_summary', 'memory_extraction')),
  CONSTRAINT "ai_work_items_binding_matches_status" CHECK (("status" = 'waiting_configuration' AND "model_profile_id" IS NULL) OR ("status" <> 'waiting_configuration' AND "model_profile_id" IS NOT NULL))
);--> statement-breakpoint
CREATE UNIQUE INDEX "ai_work_items_conversation_purpose_unique" ON "ai_work_items" USING btree ("conversation_id", "purpose");--> statement-breakpoint
CREATE INDEX "ai_work_items_status_purpose_idx" ON "ai_work_items" USING btree ("status", "purpose");--> statement-breakpoint

ALTER TABLE "conversation_summaries" ADD COLUMN "analyzer_profile_id" uuid;--> statement-breakpoint
ALTER TABLE "character_memories" ADD COLUMN "analyzer_model" varchar(120);--> statement-breakpoint
ALTER TABLE "character_memories" ADD COLUMN "analyzer_profile_id" uuid;--> statement-breakpoint

ALTER TABLE "model_connections" ADD CONSTRAINT "model_connections_created_by_user_id_user_accounts_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_profiles" ADD CONSTRAINT "provider_profiles_connection_id_model_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."model_connections"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_profiles" ADD CONSTRAINT "provider_profiles_created_by_user_id_user_accounts_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user_accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voice_profiles" ADD CONSTRAINT "voice_profiles_created_by_user_id_user_accounts_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user_accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_purpose_bindings" ADD CONSTRAINT "model_purpose_bindings_model_profile_id_provider_profiles_id_fk" FOREIGN KEY ("model_profile_id") REFERENCES "public"."provider_profiles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_purpose_bindings" ADD CONSTRAINT "model_purpose_bindings_updated_by_user_id_user_accounts_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."user_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_configuration_audit_events" ADD CONSTRAINT "model_configuration_audit_events_actor_user_id_user_accounts_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."user_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_work_items" ADD CONSTRAINT "ai_work_items_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_work_items" ADD CONSTRAINT "ai_work_items_model_profile_id_provider_profiles_id_fk" FOREIGN KEY ("model_profile_id") REFERENCES "public"."provider_profiles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_summaries" ADD CONSTRAINT "conversation_summaries_analyzer_profile_id_provider_profiles_id_fk" FOREIGN KEY ("analyzer_profile_id") REFERENCES "public"."provider_profiles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "character_memories" ADD CONSTRAINT "character_memories_analyzer_profile_id_provider_profiles_id_fk" FOREIGN KEY ("analyzer_profile_id") REFERENCES "public"."provider_profiles"("id") ON DELETE restrict ON UPDATE no action;
