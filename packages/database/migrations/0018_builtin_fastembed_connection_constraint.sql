ALTER TABLE "model_connections" DROP CONSTRAINT "model_connections_has_configuration";--> statement-breakpoint
ALTER TABLE "model_connections" ADD CONSTRAINT "model_connections_has_configuration" CHECK ("adapter" = 'builtin_fastembed' OR ("endpoint" IS NOT NULL AND "api_key" IS NOT NULL) OR ("pending_endpoint" IS NOT NULL AND "pending_api_key" IS NOT NULL));
