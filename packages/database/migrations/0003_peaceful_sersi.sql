CREATE TYPE "public"."conversation_message_role" AS ENUM('user', 'assistant');--> statement-breakpoint
CREATE TYPE "public"."conversation_message_status" AS ENUM('completed', 'interrupted');--> statement-breakpoint
CREATE TYPE "public"."conversation_mode" AS ENUM('normal', 'temporary');--> statement-breakpoint
CREATE TYPE "public"."conversation_status" AS ENUM('active', 'completed');--> statement-breakpoint
CREATE TABLE "conversation_messages" (
	"id" uuid PRIMARY KEY NOT NULL,
	"conversation_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"role" "conversation_message_role" NOT NULL,
	"status" "conversation_message_status" DEFAULT 'completed' NOT NULL,
	"text" text NOT NULL,
	"provider_event_id" varchar(200),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversation_messages_sequence_positive" CHECK ("conversation_messages"."sequence" > 0),
	CONSTRAINT "conversation_messages_text_not_blank" CHECK (length(btrim("conversation_messages"."text")) > 0)
);
--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"character_id" uuid NOT NULL,
	"mode" "conversation_mode" NOT NULL,
	"status" "conversation_status" DEFAULT 'active' NOT NULL,
	"provider" realtime_provider NOT NULL,
	"model" varchar(120) NOT NULL,
	"voice" varchar(120) NOT NULL,
	"message_count" integer DEFAULT 0 NOT NULL,
	"last_sequence" integer DEFAULT 0 NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversations_counters_nonnegative" CHECK ("conversations"."message_count" >= 0 AND "conversations"."last_sequence" >= 0),
	CONSTRAINT "conversations_status_times_match" CHECK ((
        ("conversations"."status" = 'active' AND "conversations"."ended_at" IS NULL)
        OR
        ("conversations"."status" = 'completed' AND "conversations"."ended_at" IS NOT NULL)
      )),
	CONSTRAINT "conversations_end_after_start" CHECK ("conversations"."ended_at" IS NULL OR "conversations"."ended_at" >= "conversations"."started_at"),
	CONSTRAINT "conversations_model_not_blank" CHECK (length(btrim("conversations"."model")) > 0),
	CONSTRAINT "conversations_voice_not_blank" CHECK (length(btrim("conversations"."voice")) > 0)
);
--> statement-breakpoint
ALTER TABLE "conversation_messages" ADD CONSTRAINT "conversation_messages_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_messages" ADD CONSTRAINT "conversation_messages_user_id_user_accounts_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_user_id_user_accounts_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_character_id_characters_id_fk" FOREIGN KEY ("character_id") REFERENCES "public"."characters"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "conversation_messages_conversation_sequence_unique" ON "conversation_messages" USING btree ("conversation_id","sequence");--> statement-breakpoint
CREATE UNIQUE INDEX "conversation_messages_provider_event_unique" ON "conversation_messages" USING btree ("conversation_id","provider_event_id") WHERE "conversation_messages"."provider_event_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "conversation_messages_user_created_idx" ON "conversation_messages" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "conversations_user_updated_idx" ON "conversations" USING btree ("user_id","updated_at");--> statement-breakpoint
CREATE INDEX "conversations_user_character_updated_idx" ON "conversations" USING btree ("user_id","character_id","updated_at");