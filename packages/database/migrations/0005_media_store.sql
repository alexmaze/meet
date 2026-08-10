CREATE TYPE "public"."media_object_kind" AS ENUM('call_recording', 'conversation_image', 'character_avatar', 'avatar_preview');--> statement-breakpoint
CREATE TYPE "public"."media_object_status" AS ENUM('available', 'pending_deletion', 'deleted');--> statement-breakpoint
CREATE TYPE "public"."media_retention" AS ENUM('temporary', 'retained');--> statement-breakpoint
CREATE TABLE "media_objects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"conversation_id" uuid,
	"kind" "media_object_kind" NOT NULL,
	"object_key" varchar(512) NOT NULL,
	"content_type" varchar(160) NOT NULL,
	"size_bytes" integer NOT NULL,
	"checksum_sha256" varchar(64) NOT NULL,
	"retention" "media_retention" NOT NULL,
	"status" "media_object_status" DEFAULT 'available' NOT NULL,
	"expires_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "media_objects_size_nonnegative" CHECK ("media_objects"."size_bytes" >= 0),
	CONSTRAINT "media_objects_key_not_blank" CHECK (length(btrim("media_objects"."object_key")) > 0),
	CONSTRAINT "media_objects_content_type_not_blank" CHECK (length(btrim("media_objects"."content_type")) > 0),
	CONSTRAINT "media_objects_checksum_sha256_format" CHECK ("media_objects"."checksum_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "media_objects_retention_expiry_match" CHECK ((
        ("media_objects"."retention" = 'temporary' AND "media_objects"."expires_at" IS NOT NULL)
        OR
        ("media_objects"."retention" = 'retained' AND "media_objects"."expires_at" IS NULL)
      )),
	CONSTRAINT "media_objects_conversation_kind_match" CHECK ((
        ("media_objects"."kind" IN ('call_recording', 'conversation_image') AND "media_objects"."conversation_id" IS NOT NULL)
        OR
        ("media_objects"."kind" IN ('character_avatar', 'avatar_preview') AND "media_objects"."conversation_id" IS NULL)
      )),
	CONSTRAINT "media_objects_deletion_state_match" CHECK ((
        ("media_objects"."status" IN ('available', 'pending_deletion') AND "media_objects"."deleted_at" IS NULL)
        OR
        ("media_objects"."status" = 'deleted' AND "media_objects"."deleted_at" IS NOT NULL)
      ))
);
--> statement-breakpoint
ALTER TABLE "media_objects" ADD CONSTRAINT "media_objects_owner_user_id_user_accounts_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."user_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_objects" ADD CONSTRAINT "media_objects_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "media_objects_object_key_unique" ON "media_objects" USING btree ("object_key");--> statement-breakpoint
CREATE INDEX "media_objects_owner_created_idx" ON "media_objects" USING btree ("owner_user_id","created_at");--> statement-breakpoint
CREATE INDEX "media_objects_conversation_created_idx" ON "media_objects" USING btree ("conversation_id","created_at");--> statement-breakpoint
CREATE INDEX "media_objects_expiration_idx" ON "media_objects" USING btree ("expires_at") WHERE "media_objects"."status" = 'available' AND "media_objects"."retention" = 'temporary';
