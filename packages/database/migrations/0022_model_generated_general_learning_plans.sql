ALTER TYPE "public"."teaching_subject" ADD VALUE IF NOT EXISTS 'general';
--> statement-breakpoint
ALTER TYPE "public"."teaching_grade_level" ADD VALUE IF NOT EXISTS 'grade_7';
--> statement-breakpoint
ALTER TYPE "public"."teaching_grade_level" ADD VALUE IF NOT EXISTS 'grade_8';
--> statement-breakpoint
ALTER TYPE "public"."teaching_grade_level" ADD VALUE IF NOT EXISTS 'grade_9';
--> statement-breakpoint
ALTER TYPE "public"."teaching_grade_level" ADD VALUE IF NOT EXISTS 'grade_10';
--> statement-breakpoint
ALTER TYPE "public"."teaching_grade_level" ADD VALUE IF NOT EXISTS 'grade_11';
--> statement-breakpoint
ALTER TYPE "public"."teaching_grade_level" ADD VALUE IF NOT EXISTS 'grade_12';
--> statement-breakpoint
ALTER TYPE "public"."teaching_content_item_kind" ADD VALUE IF NOT EXISTS 'model_generated_activity';
--> statement-breakpoint

ALTER TABLE "teaching_plan_generation_requests" ALTER COLUMN "generation_mode" SET DEFAULT 'text_model';
--> statement-breakpoint
ALTER TABLE "teaching_plan_generation_requests" DROP CONSTRAINT "teaching_plan_generation_requests_error_supported";
--> statement-breakpoint
ALTER TABLE "teaching_plan_generation_requests" ADD CONSTRAINT "teaching_plan_generation_requests_error_supported" CHECK (
  "error_code" IS NULL
  OR "error_code" IN (
    'generator_not_configured',
    'model_configuration_changed',
    'model_request_failed',
    'model_result_unknown',
    'invalid_generation_input',
    'invalid_model_output',
    'content_compilation_failed',
    'plan_revision_changed',
    'worker_interrupted',
    'unsupported_goal',
    'needs_clarification'
  )
);
--> statement-breakpoint
ALTER TABLE "teaching_plan_generation_requests" DROP CONSTRAINT "teaching_plan_generation_requests_input_identity_matches";
--> statement-breakpoint
ALTER TABLE "teaching_plan_generation_requests" ADD CONSTRAINT "teaching_plan_generation_requests_input_identity_matches" CHECK (
  "input_snapshot" ? 'schemaVersion'
  AND "input_snapshot" ? 'generationMode'
  AND "input_snapshot" ? 'generatorSource'
  AND "input_snapshot" ? 'goalHash'
  AND NOT ("input_snapshot" ? 'learningGoal')
  AND jsonb_typeof("input_snapshot"->'schemaVersion') = 'string'
  AND jsonb_typeof("input_snapshot"->'generationMode') = 'string'
  AND jsonb_typeof("input_snapshot"->'generatorSource') = 'string'
  AND jsonb_typeof("input_snapshot"->'goalHash') = 'string'
  AND "input_snapshot"->>'schemaVersion' IN ('teaching-plan-generation-input-v2', 'teaching-plan-generation-input-v3')
  AND "input_snapshot"->>'generationMode' = "generation_mode"::text
  AND "input_snapshot"->>'generatorSource' = "generator_source"::text
  AND "input_snapshot"->>'goalHash' ~ '^[0-9a-f]{64}$'
  AND (
    "input_snapshot"->>'schemaVersion' <> 'teaching-plan-generation-input-v3'
    OR ("generation_mode" = 'text_model' AND "generator_source" = 'text_model')
  )
);
--> statement-breakpoint

ALTER TABLE "teaching_content_revisions" DROP CONSTRAINT "teaching_content_revisions_versions_supported";
--> statement-breakpoint
ALTER TABLE "teaching_content_revisions" ADD CONSTRAINT "teaching_content_revisions_versions_supported" CHECK (
  ("schema_version" = 'generated-teaching-plan-v1' AND "compiler_version" = 'controlled-teaching-content-v1')
  OR
  ("schema_version" = 'generated-teaching-plan-v2' AND "compiler_version" = 'model-generated-teaching-content-v2')
);
--> statement-breakpoint

ALTER TABLE "teaching_content_items" ADD CONSTRAINT "teaching_content_items_structured_content_bounded" CHECK (octet_length("structured_content"::text) <= 16000);
--> statement-breakpoint
ALTER TABLE "teaching_content_items" ADD CONSTRAINT "teaching_content_items_model_source_fixed" CHECK (
  "kind"::text <> 'model_generated_activity'
  OR (
    "structured_content"->>'knowledgeSource' = 'model_only'
    AND NOT ("structured_content" ? 'source')
    AND NOT ("structured_content" ? 'sources')
    AND NOT ("structured_content" ? 'url')
    AND NOT ("structured_content" ? 'urls')
    AND NOT ("structured_content" ? 'sourceUrl')
    AND NOT ("structured_content" ? 'sourceUrls')
    AND NOT ("structured_content" ? 'citation')
    AND NOT ("structured_content" ? 'citations')
    AND NOT ("structured_content" ? 'provenance')
  )
);
--> statement-breakpoint

ALTER TABLE "conversation_teaching_states" DROP CONSTRAINT "conversation_teaching_states_content_source_supported";
--> statement-breakpoint
ALTER TABLE "conversation_teaching_states" ADD CONSTRAINT "conversation_teaching_states_content_source_supported" CHECK (
  ("content_catalog_version" IS NULL AND "content_revision_id" IS NULL)
  OR ("content_catalog_version" = 'reviewed-v1' AND "content_revision_id" IS NULL)
  OR ("content_catalog_version" IN ('generated-v1', 'generated-v2') AND "content_revision_id" IS NOT NULL)
);
