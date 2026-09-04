CREATE TABLE "relationship_transfer_imports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"target_user_id" uuid NOT NULL,
	"target_character_id" uuid NOT NULL,
	"transfer_id" uuid NOT NULL,
	"package_checksum" varchar(64) NOT NULL,
	"source_character_name" varchar(80) NOT NULL,
	"source_character_system_key" varchar(120),
	"imported_conversation_count" integer DEFAULT 0 NOT NULL,
	"skipped_conversation_count" integer DEFAULT 0 NOT NULL,
	"imported_memory_count" integer DEFAULT 0 NOT NULL,
	"skipped_memory_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "relationship_transfer_imports_checksum_format" CHECK ("relationship_transfer_imports"."package_checksum" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "relationship_transfer_imports_source_name_not_blank" CHECK (length(btrim("relationship_transfer_imports"."source_character_name")) > 0),
	CONSTRAINT "relationship_transfer_imports_counts_nonnegative" CHECK ("relationship_transfer_imports"."imported_conversation_count" >= 0 AND "relationship_transfer_imports"."skipped_conversation_count" >= 0 AND "relationship_transfer_imports"."imported_memory_count" >= 0 AND "relationship_transfer_imports"."skipped_memory_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "relationship_transfer_conversation_origins" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"transfer_import_id" uuid NOT NULL,
	"target_user_id" uuid NOT NULL,
	"target_character_id" uuid NOT NULL,
	"source_conversation_id" uuid NOT NULL,
	"imported_conversation_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "relationship_transfer_imports" ADD CONSTRAINT "relationship_transfer_imports_target_user_id_user_accounts_id_fk" FOREIGN KEY ("target_user_id") REFERENCES "public"."user_accounts"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "relationship_transfer_imports" ADD CONSTRAINT "relationship_transfer_imports_target_character_id_characters_id_fk" FOREIGN KEY ("target_character_id") REFERENCES "public"."characters"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "relationship_transfer_conversation_origins" ADD CONSTRAINT "relationship_transfer_conversation_origins_transfer_import_id_relationship_transfer_imports_id_fk" FOREIGN KEY ("transfer_import_id") REFERENCES "public"."relationship_transfer_imports"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "relationship_transfer_conversation_origins" ADD CONSTRAINT "relationship_transfer_conversation_origins_target_user_id_user_accounts_id_fk" FOREIGN KEY ("target_user_id") REFERENCES "public"."user_accounts"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "relationship_transfer_conversation_origins" ADD CONSTRAINT "relationship_transfer_conversation_origins_target_character_id_characters_id_fk" FOREIGN KEY ("target_character_id") REFERENCES "public"."characters"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "relationship_transfer_conversation_origins" ADD CONSTRAINT "relationship_transfer_conversation_origins_imported_conversation_id_conversations_id_fk" FOREIGN KEY ("imported_conversation_id") REFERENCES "public"."conversations"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "relationship_transfer_imports_user_transfer_unique" ON "relationship_transfer_imports" USING btree ("target_user_id", "transfer_id");
--> statement-breakpoint
CREATE INDEX "relationship_transfer_imports_user_character_created_idx" ON "relationship_transfer_imports" USING btree ("target_user_id", "target_character_id", "created_at");
--> statement-breakpoint
CREATE UNIQUE INDEX "relationship_transfer_origins_user_character_source_unique" ON "relationship_transfer_conversation_origins" USING btree ("target_user_id", "target_character_id", "source_conversation_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "relationship_transfer_origins_conversation_unique" ON "relationship_transfer_conversation_origins" USING btree ("imported_conversation_id") WHERE "relationship_transfer_conversation_origins"."imported_conversation_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "relationship_transfer_origins_import_idx" ON "relationship_transfer_conversation_origins" USING btree ("transfer_import_id");
