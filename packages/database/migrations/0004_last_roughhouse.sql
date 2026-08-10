CREATE TYPE "public"."character_memory_status" AS ENUM('active', 'suggested', 'rejected', 'deleted');--> statement-breakpoint
CREATE TABLE "character_memories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"character_id" uuid NOT NULL,
	"source_conversation_id" uuid,
	"content_fingerprint" varchar(64) NOT NULL,
	"content" text NOT NULL,
	"source_excerpt" text NOT NULL,
	"confidence" real NOT NULL,
	"status" character_memory_status NOT NULL,
	"reviewed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "character_memories_content_not_blank" CHECK (length(btrim("character_memories"."content")) > 0),
	CONSTRAINT "character_memories_source_excerpt_not_blank" CHECK (length(btrim("character_memories"."source_excerpt")) > 0),
	CONSTRAINT "character_memories_confidence_range" CHECK ("character_memories"."confidence" >= 0 AND "character_memories"."confidence" <= 1)
);
--> statement-breakpoint
CREATE TABLE "conversation_summaries" (
	"conversation_id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"character_id" uuid NOT NULL,
	"content" text NOT NULL,
	"source_message_count" integer NOT NULL,
	"source_last_sequence" integer NOT NULL,
	"analyzer_model" varchar(120) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversation_summaries_content_not_blank" CHECK (length(btrim("conversation_summaries"."content")) > 0),
	CONSTRAINT "conversation_summaries_source_counters_nonnegative" CHECK ("conversation_summaries"."source_message_count" >= 0 AND "conversation_summaries"."source_last_sequence" >= 0),
	CONSTRAINT "conversation_summaries_analyzer_model_not_blank" CHECK (length(btrim("conversation_summaries"."analyzer_model")) > 0)
);
--> statement-breakpoint
ALTER TABLE "character_memories" ADD CONSTRAINT "character_memories_user_id_user_accounts_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "character_memories" ADD CONSTRAINT "character_memories_character_id_characters_id_fk" FOREIGN KEY ("character_id") REFERENCES "public"."characters"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "character_memories" ADD CONSTRAINT "character_memories_source_conversation_id_conversations_id_fk" FOREIGN KEY ("source_conversation_id") REFERENCES "public"."conversations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_summaries" ADD CONSTRAINT "conversation_summaries_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_summaries" ADD CONSTRAINT "conversation_summaries_user_id_user_accounts_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_summaries" ADD CONSTRAINT "conversation_summaries_character_id_characters_id_fk" FOREIGN KEY ("character_id") REFERENCES "public"."characters"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "character_memories_user_character_fingerprint_unique" ON "character_memories" USING btree ("user_id","character_id","content_fingerprint");--> statement-breakpoint
CREATE INDEX "character_memories_user_status_updated_idx" ON "character_memories" USING btree ("user_id","status","updated_at");--> statement-breakpoint
CREATE INDEX "character_memories_user_character_status_idx" ON "character_memories" USING btree ("user_id","character_id","status");--> statement-breakpoint
CREATE INDEX "conversation_summaries_user_character_updated_idx" ON "conversation_summaries" USING btree ("user_id","character_id","updated_at");