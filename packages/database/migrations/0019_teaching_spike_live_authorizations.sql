CREATE TABLE "teaching_spike_live_authorizations" (
	"run_id" uuid PRIMARY KEY NOT NULL,
	"plan_hash" varchar(64) NOT NULL,
	"plan_json" jsonb NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"report_hash" varchar(64),
	"report_json" jsonb,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "teaching_spike_live_authorizations_plan_hash_format" CHECK ("teaching_spike_live_authorizations"."plan_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "teaching_spike_live_authorizations_plan_json_object" CHECK (jsonb_typeof("teaching_spike_live_authorizations"."plan_json") = 'object'),
	CONSTRAINT "teaching_spike_live_authorizations_report_hash_format" CHECK ("teaching_spike_live_authorizations"."report_hash" IS NULL OR "teaching_spike_live_authorizations"."report_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "teaching_spike_live_authorizations_report_json_object" CHECK ("teaching_spike_live_authorizations"."report_json" IS NULL OR jsonb_typeof("teaching_spike_live_authorizations"."report_json") = 'object'),
	CONSTRAINT "teaching_spike_live_authorizations_report_terminal_pair" CHECK (("teaching_spike_live_authorizations"."report_hash" IS NULL AND "teaching_spike_live_authorizations"."report_json" IS NULL AND "teaching_spike_live_authorizations"."finished_at" IS NULL) OR ("teaching_spike_live_authorizations"."report_hash" IS NOT NULL AND "teaching_spike_live_authorizations"."report_json" IS NOT NULL AND "teaching_spike_live_authorizations"."finished_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE INDEX "teaching_spike_live_authorizations_expiry_idx" ON "teaching_spike_live_authorizations" USING btree ("expires_at");
