CREATE TABLE "conversation_runtime_snapshots" (
  "conversation_id" uuid PRIMARY KEY NOT NULL,
  "snapshot" jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "conversation_runtime_snapshots" ADD CONSTRAINT "conversation_runtime_snapshots_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;
