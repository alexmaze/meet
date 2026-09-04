CREATE TYPE "public"."teaching_subject" AS ENUM('english', 'math', 'science');
--> statement-breakpoint
CREATE TYPE "public"."teaching_difficulty" AS ENUM('starter', 'growing', 'challenge');
--> statement-breakpoint
CREATE TYPE "public"."teaching_trigger_mode" AS ENUM('on_request', 'gentle');
--> statement-breakpoint
CREATE TYPE "public"."conversation_teaching_state" AS ENUM('unavailable', 'available', 'active', 'restoring', 'muted', 'completed');
--> statement-breakpoint
CREATE TYPE "public"."conversation_teaching_mute_reason" AS ENUM('temporary_conversation', 'child_request', 'plan_disabled');
--> statement-breakpoint
CREATE TYPE "public"."teaching_event_type" AS ENUM('prepared', 'child_muted', 'plan_disabled', 'invitation_claimed', 'restoring', 'completed');
--> statement-breakpoint
CREATE TABLE "child_character_learning_plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"child_user_id" uuid NOT NULL,
	"character_id" uuid NOT NULL,
	"enabled" boolean NOT NULL,
	"subject" "teaching_subject" NOT NULL,
	"difficulty" "teaching_difficulty" NOT NULL,
	"trigger_mode" "teaching_trigger_mode" NOT NULL,
	"last_triggered_at" timestamp with time zone,
	"content_cursor" integer DEFAULT 0 NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	"updated_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "child_character_learning_plans_revision_positive" CHECK ("child_character_learning_plans"."revision" > 0),
	CONSTRAINT "child_character_learning_plans_content_cursor_nonnegative" CHECK ("child_character_learning_plans"."content_cursor" >= 0)
);
--> statement-breakpoint
CREATE TABLE "conversation_teaching_states" (
	"conversation_id" uuid PRIMARY KEY NOT NULL,
	"learning_plan_id" uuid,
	"learning_plan_revision" integer,
	"subject" "teaching_subject",
	"difficulty" "teaching_difficulty",
	"trigger_mode" "teaching_trigger_mode",
	"disclosure_version" varchar(40),
	"state" "conversation_teaching_state" NOT NULL,
	"mute_reason" "conversation_teaching_mute_reason",
	"valid_user_turns" integer DEFAULT 0 NOT NULL,
	"invitation_count" integer DEFAULT 0 NOT NULL,
	"active_content_item_id" varchar(160),
	"revision" integer DEFAULT 1 NOT NULL,
	"prepared_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversation_teaching_states_revision_positive" CHECK ("conversation_teaching_states"."revision" > 0),
	CONSTRAINT "conversation_teaching_states_counters_bounded" CHECK ("conversation_teaching_states"."valid_user_turns" >= 0 AND "conversation_teaching_states"."invitation_count" >= 0 AND "conversation_teaching_states"."invitation_count" <= 1),
	CONSTRAINT "conversation_teaching_states_snapshot_complete" CHECK ((("conversation_teaching_states"."learning_plan_id" IS NULL AND "conversation_teaching_states"."learning_plan_revision" IS NULL AND "conversation_teaching_states"."subject" IS NULL AND "conversation_teaching_states"."difficulty" IS NULL AND "conversation_teaching_states"."trigger_mode" IS NULL AND "conversation_teaching_states"."disclosure_version" IS NULL) OR ("conversation_teaching_states"."learning_plan_id" IS NOT NULL AND "conversation_teaching_states"."learning_plan_revision" IS NOT NULL AND "conversation_teaching_states"."learning_plan_revision" > 0 AND "conversation_teaching_states"."subject" IS NOT NULL AND "conversation_teaching_states"."difficulty" IS NOT NULL AND "conversation_teaching_states"."trigger_mode" IS NOT NULL AND "conversation_teaching_states"."disclosure_version" IS NOT NULL))),
	CONSTRAINT "conversation_teaching_states_disclosure_version_supported" CHECK ("conversation_teaching_states"."disclosure_version" IS NULL OR "conversation_teaching_states"."disclosure_version" = 'teaching-disclosure-v1'),
	CONSTRAINT "conversation_teaching_states_state_matches_snapshot" CHECK ((("conversation_teaching_states"."state" IN ('available', 'active', 'completed') AND "conversation_teaching_states"."learning_plan_id" IS NOT NULL AND "conversation_teaching_states"."mute_reason" IS NULL) OR ("conversation_teaching_states"."state" = 'restoring' AND "conversation_teaching_states"."learning_plan_id" IS NOT NULL) OR ("conversation_teaching_states"."state" = 'unavailable' AND "conversation_teaching_states"."learning_plan_id" IS NULL AND "conversation_teaching_states"."mute_reason" IS NULL) OR ("conversation_teaching_states"."state" = 'muted' AND "conversation_teaching_states"."mute_reason" IS NOT NULL))),
	CONSTRAINT "conversation_teaching_states_active_item_matches_state" CHECK ((("conversation_teaching_states"."state" IN ('active', 'restoring') AND "conversation_teaching_states"."active_content_item_id" IS NOT NULL AND "conversation_teaching_states"."invitation_count" = 1) OR ("conversation_teaching_states"."state" = 'muted' AND ("conversation_teaching_states"."active_content_item_id" IS NULL OR "conversation_teaching_states"."invitation_count" = 1)) OR ("conversation_teaching_states"."state" IN ('available', 'unavailable') AND "conversation_teaching_states"."active_content_item_id" IS NULL AND "conversation_teaching_states"."invitation_count" = 0) OR ("conversation_teaching_states"."state" = 'completed' AND "conversation_teaching_states"."active_content_item_id" IS NULL AND "conversation_teaching_states"."invitation_count" = 1))),
	CONSTRAINT "conversation_teaching_states_active_item_not_blank" CHECK ("conversation_teaching_states"."active_content_item_id" IS NULL OR length(btrim("conversation_teaching_states"."active_content_item_id")) > 0)
);
--> statement-breakpoint
CREATE TABLE "teaching_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"learning_plan_id" uuid,
	"event_type" "teaching_event_type" NOT NULL,
	"actor_user_id" uuid,
	"state_revision" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "teaching_events_state_revision_positive" CHECK ("teaching_events"."state_revision" > 0)
);
--> statement-breakpoint
ALTER TABLE "child_character_learning_plans" ADD CONSTRAINT "child_character_learning_plans_child_user_id_user_accounts_id_fk" FOREIGN KEY ("child_user_id") REFERENCES "public"."user_accounts"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "child_character_learning_plans" ADD CONSTRAINT "child_character_learning_plans_character_id_characters_id_fk" FOREIGN KEY ("character_id") REFERENCES "public"."characters"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "child_character_learning_plans" ADD CONSTRAINT "child_character_learning_plans_created_by_user_id_user_accounts_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user_accounts"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "child_character_learning_plans" ADD CONSTRAINT "child_character_learning_plans_updated_by_user_id_user_accounts_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."user_accounts"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "conversation_teaching_states" ADD CONSTRAINT "conversation_teaching_states_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "conversation_teaching_states" ADD CONSTRAINT "conversation_teaching_states_learning_plan_id_child_character_learning_plans_id_fk" FOREIGN KEY ("learning_plan_id") REFERENCES "public"."child_character_learning_plans"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "teaching_events" ADD CONSTRAINT "teaching_events_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "teaching_events" ADD CONSTRAINT "teaching_events_learning_plan_id_child_character_learning_plans_id_fk" FOREIGN KEY ("learning_plan_id") REFERENCES "public"."child_character_learning_plans"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "teaching_events" ADD CONSTRAINT "teaching_events_actor_user_id_user_accounts_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."user_accounts"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "child_character_learning_plans_child_character_unique" ON "child_character_learning_plans" USING btree ("child_user_id", "character_id");
--> statement-breakpoint
CREATE INDEX "child_character_learning_plans_child_enabled_idx" ON "child_character_learning_plans" USING btree ("child_user_id", "enabled", "updated_at");
--> statement-breakpoint
CREATE INDEX "child_character_learning_plans_character_enabled_idx" ON "child_character_learning_plans" USING btree ("character_id", "enabled");
--> statement-breakpoint
CREATE INDEX "conversation_teaching_states_plan_state_idx" ON "conversation_teaching_states" USING btree ("learning_plan_id", "state");
--> statement-breakpoint
CREATE UNIQUE INDEX "teaching_events_conversation_type_revision_unique" ON "teaching_events" USING btree ("conversation_id", "event_type", "state_revision");
--> statement-breakpoint
CREATE INDEX "teaching_events_conversation_created_idx" ON "teaching_events" USING btree ("conversation_id", "created_at");
