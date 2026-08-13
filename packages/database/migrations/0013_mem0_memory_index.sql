CREATE TABLE "memory_index_entries" (
	"memory_id" uuid PRIMARY KEY NOT NULL,
	"provider" varchar(32) DEFAULT 'mem0' NOT NULL,
	"external_id" varchar(256),
	"indexed_fingerprint" varchar(64),
	"status" varchar(32) DEFAULT 'pending' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"last_error_code" varchar(120),
	"synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memory_index_entries_provider_valid" CHECK ("memory_index_entries"."provider" = 'mem0'),
	CONSTRAINT "memory_index_entries_status_valid" CHECK ("memory_index_entries"."status" IN ('pending', 'synced', 'failed')),
	CONSTRAINT "memory_index_entries_attempt_count_nonnegative" CHECK ("memory_index_entries"."attempt_count" >= 0)
);
--> statement-breakpoint
ALTER TABLE "memory_index_entries" ADD CONSTRAINT "memory_index_entries_memory_id_character_memories_id_fk" FOREIGN KEY ("memory_id") REFERENCES "public"."character_memories"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "memory_index_entries_external_id_unique" ON "memory_index_entries" USING btree ("external_id");
--> statement-breakpoint
CREATE INDEX "memory_index_entries_status_updated_idx" ON "memory_index_entries" USING btree ("status","updated_at");
