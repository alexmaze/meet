ALTER TYPE "public"."teaching_subject" ADD VALUE IF NOT EXISTS 'chinese';
--> statement-breakpoint
ALTER TYPE "public"."model_purpose" ADD VALUE IF NOT EXISTS 'teaching_plan_generation';
--> statement-breakpoint
CREATE TYPE "public"."teaching_grade_level" AS ENUM('preschool', 'grade_1', 'grade_2', 'grade_3', 'grade_4', 'grade_5', 'grade_6', 'unspecified');
--> statement-breakpoint
CREATE TYPE "public"."teaching_plan_generation_mode" AS ENUM('auto', 'controlled_template', 'text_model');
--> statement-breakpoint
CREATE TYPE "public"."teaching_plan_generator_source" AS ENUM('controlled_template', 'text_model');
--> statement-breakpoint
CREATE TYPE "public"."teaching_plan_generation_status" AS ENUM('queued', 'running', 'succeeded', 'failed', 'superseded');
--> statement-breakpoint
CREATE TYPE "public"."teaching_content_item_kind" AS ENUM('reviewed_catalog_ref', 'pinyin_practice', 'multiplication_fact');
--> statement-breakpoint

ALTER TABLE "child_character_learning_plans" ADD COLUMN "grade_level" "teaching_grade_level" DEFAULT 'unspecified' NOT NULL;
--> statement-breakpoint
ALTER TABLE "child_character_learning_plans" ADD COLUMN "learning_goal" varchar(300);
--> statement-breakpoint
ALTER TABLE "child_character_learning_plans" ADD COLUMN "activity_count" integer DEFAULT 4 NOT NULL;
--> statement-breakpoint
ALTER TABLE "child_character_learning_plans" ADD COLUMN "duration_days" integer DEFAULT 7 NOT NULL;
--> statement-breakpoint
ALTER TABLE "child_character_learning_plans" ADD COLUMN "active_content_revision_id" uuid;
--> statement-breakpoint
ALTER TABLE "child_character_learning_plans" ADD COLUMN "active_content_activated_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "child_character_learning_plans" ADD CONSTRAINT "child_character_learning_plans_learning_goal_not_blank" CHECK ("learning_goal" IS NULL OR length(btrim("learning_goal")) > 0);
--> statement-breakpoint
ALTER TABLE "child_character_learning_plans" ADD CONSTRAINT "child_character_learning_plans_activity_count_bounded" CHECK ("activity_count" BETWEEN 3 AND 8);
--> statement-breakpoint
ALTER TABLE "child_character_learning_plans" ADD CONSTRAINT "child_character_learning_plans_duration_days_supported" CHECK ("duration_days" IN (7, 14));
--> statement-breakpoint
ALTER TABLE "child_character_learning_plans" ADD CONSTRAINT "child_character_learning_plans_active_content_pair" CHECK (("active_content_revision_id" IS NULL AND "active_content_activated_at" IS NULL) OR ("active_content_revision_id" IS NOT NULL AND "active_content_activated_at" IS NOT NULL));
--> statement-breakpoint

CREATE TABLE "teaching_plan_generation_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"learning_plan_id" uuid NOT NULL,
	"client_request_id" uuid NOT NULL,
	"expected_plan_revision" integer NOT NULL,
	"generation_mode" "teaching_plan_generation_mode" DEFAULT 'auto' NOT NULL,
	"generator_source" "teaching_plan_generator_source" NOT NULL,
	"status" "teaching_plan_generation_status" DEFAULT 'queued' NOT NULL,
	"input_snapshot" jsonb NOT NULL,
	"input_hash" varchar(64) NOT NULL,
	"model_profile_id" uuid,
	"model_profile_revision" integer,
	"connection_id" uuid,
	"connection_revision" integer,
	"output_content_revision_id" uuid,
	"actual_model" varchar(120),
	"input_tokens" integer,
	"output_tokens" integer,
	"error_code" varchar(80),
	"requested_by_user_id" uuid NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "teaching_plan_generation_requests_expected_revision_positive" CHECK ("expected_plan_revision" > 0),
	CONSTRAINT "teaching_plan_generation_requests_runtime_matches_source" CHECK (("generator_source" = 'controlled_template' AND "model_profile_id" IS NULL AND "model_profile_revision" IS NULL AND "connection_id" IS NULL AND "connection_revision" IS NULL) OR ("generator_source" = 'text_model' AND "model_profile_id" IS NOT NULL AND "model_profile_revision" IS NOT NULL AND "model_profile_revision" > 0 AND "connection_id" IS NOT NULL AND "connection_revision" IS NOT NULL AND "connection_revision" > 0)),
	CONSTRAINT "teaching_plan_generation_requests_mode_matches_source" CHECK ("generation_mode" = 'auto' OR ("generation_mode" = 'controlled_template' AND "generator_source" = 'controlled_template') OR ("generation_mode" = 'text_model' AND "generator_source" = 'text_model')),
	CONSTRAINT "teaching_plan_generation_requests_input_json_object" CHECK (jsonb_typeof("input_snapshot") = 'object'),
	CONSTRAINT "teaching_plan_generation_requests_input_identity_matches" CHECK ("input_snapshot" ? 'schemaVersion' AND "input_snapshot" ? 'generationMode' AND "input_snapshot" ? 'generatorSource' AND "input_snapshot" ? 'goalHash' AND NOT ("input_snapshot" ? 'learningGoal') AND jsonb_typeof("input_snapshot"->'schemaVersion') = 'string' AND jsonb_typeof("input_snapshot"->'generationMode') = 'string' AND jsonb_typeof("input_snapshot"->'generatorSource') = 'string' AND jsonb_typeof("input_snapshot"->'goalHash') = 'string' AND "input_snapshot"->>'schemaVersion' = 'teaching-plan-generation-input-v2' AND "input_snapshot"->>'generationMode' = "generation_mode"::text AND "input_snapshot"->>'generatorSource' = "generator_source"::text AND "input_snapshot"->>'goalHash' ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "teaching_plan_generation_requests_input_hash_format" CHECK ("input_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "teaching_plan_generation_requests_terminal_time" CHECK (("status" IN ('succeeded', 'failed', 'superseded')) = ("completed_at" IS NOT NULL)),
	CONSTRAINT "teaching_plan_generation_requests_output_matches_status" CHECK (("status" = 'succeeded') = ("output_content_revision_id" IS NOT NULL)),
	CONSTRAINT "teaching_plan_generation_requests_error_matches_status" CHECK (("status" = 'failed') = ("error_code" IS NOT NULL)),
	CONSTRAINT "teaching_plan_generation_requests_error_supported" CHECK ("error_code" IS NULL OR "error_code" IN ('generator_not_configured', 'model_configuration_changed', 'model_request_failed', 'invalid_generation_input', 'invalid_model_output', 'content_compilation_failed', 'plan_revision_changed', 'worker_interrupted', 'unsupported_goal', 'needs_clarification')),
	CONSTRAINT "teaching_plan_generation_requests_usage_nonnegative" CHECK (("input_tokens" IS NULL OR "input_tokens" >= 0) AND ("output_tokens" IS NULL OR "output_tokens" >= 0)),
	CONSTRAINT "teaching_plan_generation_requests_times_ordered" CHECK (("started_at" IS NULL OR "started_at" >= "requested_at") AND ("completed_at" IS NULL OR "completed_at" >= "requested_at"))
);
--> statement-breakpoint
ALTER TABLE "teaching_plan_generation_requests" ADD CONSTRAINT "teaching_plan_generation_requests_learning_plan_id_child_character_learning_plans_id_fk" FOREIGN KEY ("learning_plan_id") REFERENCES "public"."child_character_learning_plans"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "teaching_plan_generation_requests" ADD CONSTRAINT "teaching_plan_generation_requests_model_profile_id_provider_profiles_id_fk" FOREIGN KEY ("model_profile_id") REFERENCES "public"."provider_profiles"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "teaching_plan_generation_requests" ADD CONSTRAINT "teaching_plan_generation_requests_connection_id_model_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."model_connections"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "teaching_plan_generation_requests" ADD CONSTRAINT "teaching_plan_generation_requests_requested_by_user_id_user_accounts_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."user_accounts"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "teaching_plan_generation_requests_plan_client_unique" ON "teaching_plan_generation_requests" USING btree ("learning_plan_id", "client_request_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "teaching_plan_generation_requests_one_active_per_plan" ON "teaching_plan_generation_requests" USING btree ("learning_plan_id") WHERE "status" IN ('queued', 'running');
--> statement-breakpoint
CREATE INDEX "teaching_plan_generation_requests_status_requested_idx" ON "teaching_plan_generation_requests" USING btree ("status", "requested_at");
--> statement-breakpoint

CREATE TABLE "teaching_content_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"learning_plan_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"generation_request_id" uuid NOT NULL,
	"schema_version" varchar(60) NOT NULL,
	"compiler_version" varchar(60) NOT NULL,
	"title" varchar(80) NOT NULL,
	"normalized_goal" varchar(200) NOT NULL,
	"subject" "teaching_subject" NOT NULL,
	"difficulty" "teaching_difficulty" NOT NULL,
	"grade_level" "teaching_grade_level" NOT NULL,
	"activity_count" integer NOT NULL,
	"duration_days" integer NOT NULL,
	"content_hash" varchar(64) NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "teaching_content_revisions_revision_positive" CHECK ("revision" > 0),
	CONSTRAINT "teaching_content_revisions_versions_supported" CHECK ("schema_version" = 'generated-teaching-plan-v1' AND "compiler_version" = 'controlled-teaching-content-v1'),
	CONSTRAINT "teaching_content_revisions_text_not_blank" CHECK (length(btrim("title")) > 0 AND length(btrim("normalized_goal")) > 0),
	CONSTRAINT "teaching_content_revisions_activity_count_bounded" CHECK ("activity_count" BETWEEN 3 AND 8),
	CONSTRAINT "teaching_content_revisions_duration_days_supported" CHECK ("duration_days" IN (7, 14)),
	CONSTRAINT "teaching_content_revisions_content_hash_format" CHECK ("content_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "teaching_content_revisions" ADD CONSTRAINT "teaching_content_revisions_learning_plan_id_child_character_learning_plans_id_fk" FOREIGN KEY ("learning_plan_id") REFERENCES "public"."child_character_learning_plans"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "teaching_content_revisions" ADD CONSTRAINT "teaching_content_revisions_generation_request_id_teaching_plan_generation_requests_id_fk" FOREIGN KEY ("generation_request_id") REFERENCES "public"."teaching_plan_generation_requests"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "teaching_content_revisions" ADD CONSTRAINT "teaching_content_revisions_created_by_user_id_user_accounts_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user_accounts"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "teaching_content_revisions_plan_revision_unique" ON "teaching_content_revisions" USING btree ("learning_plan_id", "revision");
--> statement-breakpoint
CREATE UNIQUE INDEX "teaching_content_revisions_generation_unique" ON "teaching_content_revisions" USING btree ("generation_request_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "teaching_content_revisions_id_plan_unique" ON "teaching_content_revisions" USING btree ("id", "learning_plan_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "teaching_content_revisions_id_generation_unique" ON "teaching_content_revisions" USING btree ("id", "generation_request_id");
--> statement-breakpoint

CREATE TABLE "teaching_content_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"content_revision_id" uuid NOT NULL,
	"item_key" varchar(64) NOT NULL,
	"position" integer NOT NULL,
	"kind" "teaching_content_item_kind" NOT NULL,
	"structured_content" jsonb NOT NULL,
	"compiled_directive" text NOT NULL,
	"directive_hash" varchar(64) NOT NULL,
	"maximum_assistant_responses" integer DEFAULT 2 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "teaching_content_items_position_bounded" CHECK ("position" BETWEEN 1 AND 8),
	CONSTRAINT "teaching_content_items_json_object" CHECK (jsonb_typeof("structured_content") = 'object'),
	CONSTRAINT "teaching_content_items_json_identity_matches" CHECK ("structured_content" ? 'kind' AND "structured_content" ? 'key' AND "structured_content" ? 'order' AND jsonb_typeof("structured_content"->'kind') = 'string' AND jsonb_typeof("structured_content"->'key') = 'string' AND jsonb_typeof("structured_content"->'order') = 'number' AND "structured_content"->>'kind' = "kind"::text AND "structured_content"->>'key' = "item_key" AND "structured_content"->'order' = to_jsonb("position")),
	CONSTRAINT "teaching_content_items_compiled_directive_bounded" CHECK (length(btrim("compiled_directive")) > 0 AND length("compiled_directive") <= 4000),
	CONSTRAINT "teaching_content_items_directive_hash_format" CHECK ("directive_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "teaching_content_items_response_limit_fixed" CHECK ("maximum_assistant_responses" = 2)
);
--> statement-breakpoint
ALTER TABLE "teaching_content_items" ADD CONSTRAINT "teaching_content_items_content_revision_id_teaching_content_revisions_id_fk" FOREIGN KEY ("content_revision_id") REFERENCES "public"."teaching_content_revisions"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "teaching_content_items_revision_key_unique" ON "teaching_content_items" USING btree ("content_revision_id", "item_key");
--> statement-breakpoint
CREATE UNIQUE INDEX "teaching_content_items_revision_position_unique" ON "teaching_content_items" USING btree ("content_revision_id", "position");
--> statement-breakpoint

ALTER TABLE "teaching_plan_generation_requests" ADD CONSTRAINT "teaching_plan_generation_requests_output_own_revision_fk" FOREIGN KEY ("output_content_revision_id", "id") REFERENCES "public"."teaching_content_revisions"("id", "generation_request_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "child_character_learning_plans" ADD CONSTRAINT "child_character_learning_plans_active_own_revision_fk" FOREIGN KEY ("active_content_revision_id", "id") REFERENCES "public"."teaching_content_revisions"("id", "learning_plan_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint

ALTER TABLE "conversation_teaching_states" DROP CONSTRAINT "conversation_teaching_states_snapshot_complete";
--> statement-breakpoint
ALTER TABLE "conversation_teaching_states" ADD COLUMN "content_revision_id" uuid;
--> statement-breakpoint
ALTER TABLE "conversation_teaching_states" ADD COLUMN "content_catalog_version" varchar(40);
--> statement-breakpoint
UPDATE "conversation_teaching_states" SET "content_catalog_version" = 'reviewed-v1' WHERE "learning_plan_id" IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "conversation_teaching_states" ADD CONSTRAINT "conversation_teaching_states_content_own_plan_fk" FOREIGN KEY ("content_revision_id", "learning_plan_id") REFERENCES "public"."teaching_content_revisions"("id", "learning_plan_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "conversation_teaching_states" ADD CONSTRAINT "conversation_teaching_states_snapshot_complete" CHECK ((("learning_plan_id" IS NULL AND "learning_plan_revision" IS NULL AND "subject" IS NULL AND "difficulty" IS NULL AND "trigger_mode" IS NULL AND "disclosure_version" IS NULL AND "content_revision_id" IS NULL AND "content_catalog_version" IS NULL) OR ("learning_plan_id" IS NOT NULL AND "learning_plan_revision" IS NOT NULL AND "learning_plan_revision" > 0 AND "subject" IS NOT NULL AND "difficulty" IS NOT NULL AND "trigger_mode" IS NOT NULL AND "disclosure_version" IS NOT NULL AND "content_catalog_version" IS NOT NULL)));
--> statement-breakpoint
ALTER TABLE "conversation_teaching_states" ADD CONSTRAINT "conversation_teaching_states_content_source_supported" CHECK (("content_catalog_version" IS NULL AND "content_revision_id" IS NULL) OR ("content_catalog_version" = 'reviewed-v1' AND "content_revision_id" IS NULL) OR ("content_catalog_version" = 'generated-v1' AND "content_revision_id" IS NOT NULL));
