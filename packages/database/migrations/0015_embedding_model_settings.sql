ALTER TYPE "public"."model_connection_adapter" RENAME TO "model_connection_adapter_old";--> statement-breakpoint
CREATE TYPE "public"."model_connection_adapter" AS ENUM('qwen_realtime', 'doubao_realtime', 'openai_chat_completions', 'openai_embeddings', 'builtin_fastembed');--> statement-breakpoint
ALTER TABLE "model_connections" ALTER COLUMN "adapter" TYPE "public"."model_connection_adapter" USING "adapter"::text::"public"."model_connection_adapter";--> statement-breakpoint
DROP TYPE "public"."model_connection_adapter_old";--> statement-breakpoint

ALTER TABLE "provider_profiles" ALTER COLUMN "kind" DROP DEFAULT;--> statement-breakpoint
ALTER TYPE "public"."model_profile_kind" RENAME TO "model_profile_kind_old";--> statement-breakpoint
CREATE TYPE "public"."model_profile_kind" AS ENUM('realtime_voice', 'text', 'embedding');--> statement-breakpoint
ALTER TABLE "provider_profiles" ALTER COLUMN "kind" TYPE "public"."model_profile_kind" USING "kind"::text::"public"."model_profile_kind";--> statement-breakpoint
ALTER TABLE "provider_profiles" ALTER COLUMN "kind" SET DEFAULT 'realtime_voice';--> statement-breakpoint
DROP TYPE "public"."model_profile_kind_old";--> statement-breakpoint

ALTER TYPE "public"."model_purpose" RENAME TO "model_purpose_old";--> statement-breakpoint
CREATE TYPE "public"."model_purpose" AS ENUM('realtime_default', 'conversation_summary', 'memory_extraction', 'memory_embedding');--> statement-breakpoint
ALTER TABLE "model_purpose_bindings" ALTER COLUMN "purpose" TYPE "public"."model_purpose" USING "purpose"::text::"public"."model_purpose";--> statement-breakpoint
ALTER TABLE "ai_work_items" DROP CONSTRAINT "ai_work_items_analysis_purpose";--> statement-breakpoint
ALTER TABLE "ai_work_items" ALTER COLUMN "purpose" TYPE "public"."model_purpose" USING "purpose"::text::"public"."model_purpose";--> statement-breakpoint
ALTER TABLE "ai_work_items" ADD CONSTRAINT "ai_work_items_analysis_purpose" CHECK ("purpose" IN ('conversation_summary', 'memory_extraction'));--> statement-breakpoint
DROP TYPE "public"."model_purpose_old";--> statement-breakpoint

ALTER TABLE "provider_profiles" ADD COLUMN "embedding_dimensions" integer;
