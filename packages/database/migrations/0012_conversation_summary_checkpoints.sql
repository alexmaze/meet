CREATE TABLE "conversation_summary_checkpoints" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"source_last_sequence" integer NOT NULL,
	"source_message_count" integer NOT NULL,
	"status" varchar(32) NOT NULL,
	"model_profile_id" uuid,
	"content" text,
	"analyzer_model" varchar(120),
	"last_error_code" varchar(120),
	"queued_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversation_summary_checkpoints_source_counters_positive" CHECK ("conversation_summary_checkpoints"."source_last_sequence" > 0 AND "conversation_summary_checkpoints"."source_message_count" > 0),
	CONSTRAINT "conversation_summary_checkpoints_status_valid" CHECK ("conversation_summary_checkpoints"."status" IN ('waiting_configuration', 'queued', 'completed', 'failed')),
	CONSTRAINT "conversation_summary_checkpoints_binding_matches_status" CHECK (("conversation_summary_checkpoints"."status" = 'waiting_configuration' AND "conversation_summary_checkpoints"."model_profile_id" IS NULL) OR ("conversation_summary_checkpoints"."status" <> 'waiting_configuration' AND "conversation_summary_checkpoints"."model_profile_id" IS NOT NULL)),
	CONSTRAINT "conversation_summary_checkpoints_content_matches_status" CHECK (("conversation_summary_checkpoints"."status" = 'completed' AND "conversation_summary_checkpoints"."content" IS NOT NULL AND length(btrim("conversation_summary_checkpoints"."content")) > 0 AND "conversation_summary_checkpoints"."analyzer_model" IS NOT NULL AND "conversation_summary_checkpoints"."completed_at" IS NOT NULL) OR ("conversation_summary_checkpoints"."status" <> 'completed' AND "conversation_summary_checkpoints"."content" IS NULL AND "conversation_summary_checkpoints"."completed_at" IS NULL)),
	CONSTRAINT "conversation_summary_checkpoints_queue_time_matches_status" CHECK (("conversation_summary_checkpoints"."status" = 'waiting_configuration' AND "conversation_summary_checkpoints"."queued_at" IS NULL) OR ("conversation_summary_checkpoints"."status" <> 'waiting_configuration' AND "conversation_summary_checkpoints"."queued_at" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "conversation_summary_checkpoints" ADD CONSTRAINT "conversation_summary_checkpoints_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "conversation_summary_checkpoints" ADD CONSTRAINT "conversation_summary_checkpoints_model_profile_id_provider_profiles_id_fk" FOREIGN KEY ("model_profile_id") REFERENCES "public"."provider_profiles"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "conversation_summary_checkpoints_conversation_sequence_unique" ON "conversation_summary_checkpoints" USING btree ("conversation_id", "source_last_sequence");
--> statement-breakpoint
CREATE INDEX "conversation_summary_checkpoints_status_idx" ON "conversation_summary_checkpoints" USING btree ("status");
--> statement-breakpoint
CREATE INDEX "conversation_summary_checkpoints_conversation_status_sequence_idx" ON "conversation_summary_checkpoints" USING btree ("conversation_id", "status", "source_last_sequence");
