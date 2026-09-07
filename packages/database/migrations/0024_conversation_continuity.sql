CREATE TABLE "character_favorites" (
	"user_id" uuid NOT NULL,
	"character_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "character_favorites_user_id_character_id_pk" PRIMARY KEY("user_id","character_id")
);
--> statement-breakpoint
CREATE TABLE "conversation_controls" (
	"conversation_id" uuid PRIMARY KEY NOT NULL,
	"writer_client_id" uuid,
	"writer_epoch" integer DEFAULT 0 NOT NULL,
	"lease_expires_at" timestamp with time zone,
	"connection_id" uuid,
	"connection_expires_at" timestamp with time zone,
	"connection_started_at" timestamp with time zone,
	"last_heartbeat_at" timestamp with time zone,
	"has_connected" boolean DEFAULT false NOT NULL,
	"last_activity_at" timestamp with time zone,
	"last_saved_at" timestamp with time zone,
	"connected_duration_ms" bigint DEFAULT 0 NOT NULL,
	"finalized_at" timestamp with time zone,
	"end_request_id" uuid,
	"end_target_sequence" integer,
	CONSTRAINT "conversation_controls_nonnegative" CHECK ("conversation_controls"."writer_epoch" >= 0 AND "conversation_controls"."connected_duration_ms" >= 0 AND ("conversation_controls"."end_target_sequence" IS NULL OR "conversation_controls"."end_target_sequence" >= 0)),
	CONSTRAINT "conversation_controls_writer_fields" CHECK (("conversation_controls"."writer_client_id" IS NULL AND "conversation_controls"."lease_expires_at" IS NULL) OR ("conversation_controls"."writer_client_id" IS NOT NULL AND "conversation_controls"."lease_expires_at" IS NOT NULL AND "conversation_controls"."writer_epoch" > 0)),
	CONSTRAINT "conversation_controls_connection_fields" CHECK (("conversation_controls"."connection_id" IS NULL AND "conversation_controls"."connection_expires_at" IS NULL AND "conversation_controls"."connection_started_at" IS NULL) OR ("conversation_controls"."connection_id" IS NOT NULL AND "conversation_controls"."connection_expires_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "conversation_operations" (
	"conversation_id" uuid NOT NULL,
	"request_id" uuid NOT NULL,
	"kind" varchar(12) NOT NULL,
	"client_id" uuid NOT NULL,
	"writer_epoch" integer NOT NULL,
	"intent" varchar(12) NOT NULL,
	"target_sequence" integer,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversation_operations_conversation_id_request_id_pk" PRIMARY KEY("conversation_id","request_id"),
	CONSTRAINT "conversation_operations_kind" CHECK ("conversation_operations"."kind" IN ('prepare', 'finish') AND "conversation_operations"."intent" IN ('connect', 'finish') AND "conversation_operations"."writer_epoch" > 0),
	CONSTRAINT "conversation_operations_target" CHECK (("conversation_operations"."kind" = 'prepare' AND "conversation_operations"."target_sequence" IS NULL) OR ("conversation_operations"."kind" = 'finish' AND "conversation_operations"."target_sequence" >= 0))
);
--> statement-breakpoint
ALTER TABLE "character_favorites" ADD CONSTRAINT "character_favorites_user_id_user_accounts_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "character_favorites" ADD CONSTRAINT "character_favorites_character_id_characters_id_fk" FOREIGN KEY ("character_id") REFERENCES "public"."characters"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_controls" ADD CONSTRAINT "conversation_controls_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_operations" ADD CONSTRAINT "conversation_operations_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
INSERT INTO "conversation_controls" ("conversation_id", "has_connected", "last_activity_at", "finalized_at")
SELECT c."id", c."message_count" > 0,
       COALESCE((SELECT max(m."created_at") FROM "conversation_messages" m WHERE m."conversation_id" = c."id"), c."ended_at"),
       CASE WHEN c."status" = 'completed' THEN c."ended_at" ELSE NULL END
FROM "conversations" c
ON CONFLICT ("conversation_id") DO NOTHING;
