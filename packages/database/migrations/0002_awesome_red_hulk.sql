CREATE TYPE "public"."character_audit_event_type" AS ENUM('created', 'updated', 'visibility_changed', 'copied', 'deleted', 'restored');--> statement-breakpoint
CREATE TYPE "public"."character_visibility" AS ENUM('builtin', 'family', 'private');--> statement-breakpoint
CREATE TYPE "public"."realtime_provider" AS ENUM('qwen', 'doubao', 'openai', 'gemini', 'elevenlabs');--> statement-breakpoint
CREATE TYPE "public"."voice_profile_type" AS ENUM('preset', 'cloned');--> statement-breakpoint
CREATE TABLE "character_audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_type" character_audit_event_type NOT NULL,
	"actor_user_id" uuid,
	"character_id" uuid,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "characters" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"system_key" varchar(120),
	"system_version" integer,
	"owner_user_id" uuid,
	"visibility" character_visibility NOT NULL,
	"name" varchar(80) NOT NULL,
	"description" varchar(600) NOT NULL,
	"persona" jsonb NOT NULL,
	"opening_line" varchar(500),
	"provider_profile_id" uuid NOT NULL,
	"voice_profile_id" uuid NOT NULL,
	"conversation_policy" jsonb NOT NULL,
	"visual_profile" jsonb NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "characters_revision_positive" CHECK ("characters"."revision" > 0),
	CONSTRAINT "characters_name_not_blank" CHECK (length(btrim("characters"."name")) > 0),
	CONSTRAINT "characters_description_not_blank" CHECK (length(btrim("characters"."description")) > 0),
	CONSTRAINT "characters_system_fields_match" CHECK ((
        ("characters"."visibility" = 'builtin' AND "characters"."system_key" IS NOT NULL AND "characters"."system_version" IS NOT NULL AND "characters"."system_version" > 0 AND "characters"."owner_user_id" IS NULL)
        OR
        ("characters"."visibility" <> 'builtin' AND "characters"."system_key" IS NULL AND "characters"."system_version" IS NULL AND "characters"."owner_user_id" IS NOT NULL)
      )),
	CONSTRAINT "characters_builtin_not_deleted" CHECK ("characters"."visibility" <> 'builtin' OR "characters"."deleted_at" IS NULL)
);
--> statement-breakpoint
CREATE TABLE "provider_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"system_key" varchar(120) NOT NULL,
	"provider" realtime_provider NOT NULL,
	"model" varchar(120) NOT NULL,
	"display_name" varchar(120) NOT NULL,
	"capabilities" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "provider_profiles_system_key_not_blank" CHECK (length(btrim("provider_profiles"."system_key")) > 0),
	CONSTRAINT "provider_profiles_model_not_blank" CHECK (length(btrim("provider_profiles"."model")) > 0)
);
--> statement-breakpoint
CREATE TABLE "voice_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"system_key" varchar(120) NOT NULL,
	"provider_profile_id" uuid NOT NULL,
	"type" "voice_profile_type" NOT NULL,
	"provider_voice_id" varchar(120) NOT NULL,
	"display_name" varchar(120) NOT NULL,
	"style" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "voice_profiles_system_key_not_blank" CHECK (length(btrim("voice_profiles"."system_key")) > 0),
	CONSTRAINT "voice_profiles_provider_voice_not_blank" CHECK (length(btrim("voice_profiles"."provider_voice_id")) > 0)
);
--> statement-breakpoint
ALTER TABLE "character_audit_events" ADD CONSTRAINT "character_audit_events_actor_user_id_user_accounts_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."user_accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "character_audit_events" ADD CONSTRAINT "character_audit_events_character_id_characters_id_fk" FOREIGN KEY ("character_id") REFERENCES "public"."characters"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "characters" ADD CONSTRAINT "characters_owner_user_id_user_accounts_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."user_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "characters" ADD CONSTRAINT "characters_provider_profile_id_provider_profiles_id_fk" FOREIGN KEY ("provider_profile_id") REFERENCES "public"."provider_profiles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "characters" ADD CONSTRAINT "characters_voice_profile_id_voice_profiles_id_fk" FOREIGN KEY ("voice_profile_id") REFERENCES "public"."voice_profiles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voice_profiles" ADD CONSTRAINT "voice_profiles_provider_profile_id_provider_profiles_id_fk" FOREIGN KEY ("provider_profile_id") REFERENCES "public"."provider_profiles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "character_audit_character_created_idx" ON "character_audit_events" USING btree ("character_id","created_at");--> statement-breakpoint
CREATE INDEX "character_audit_actor_created_idx" ON "character_audit_events" USING btree ("actor_user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "characters_system_key_unique" ON "characters" USING btree ("system_key");--> statement-breakpoint
CREATE INDEX "characters_owner_visibility_idx" ON "characters" USING btree ("owner_user_id","visibility");--> statement-breakpoint
CREATE INDEX "characters_visibility_active_idx" ON "characters" USING btree ("visibility","updated_at") WHERE "characters"."deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "provider_profiles_system_key_unique" ON "provider_profiles" USING btree ("system_key");--> statement-breakpoint
CREATE UNIQUE INDEX "provider_profiles_provider_model_unique" ON "provider_profiles" USING btree ("provider","model");--> statement-breakpoint
CREATE UNIQUE INDEX "voice_profiles_system_key_unique" ON "voice_profiles" USING btree ("system_key");--> statement-breakpoint
CREATE UNIQUE INDEX "voice_profiles_provider_voice_unique" ON "voice_profiles" USING btree ("provider_profile_id","provider_voice_id");--> statement-breakpoint
INSERT INTO "provider_profiles" ("id", "system_key", "provider", "model", "display_name", "capabilities") VALUES
('31c9ad8e-0e8b-4e2d-8c14-318d36d617b1', 'provider.qwen.audio-3-realtime-plus', 'qwen', 'qwen-audio-3.0-realtime-plus', '千问 Audio 3.0 Realtime Plus', $json${"audioInput":true,"textInput":true,"imageInput":false}$json$::jsonb);--> statement-breakpoint
INSERT INTO "voice_profiles" ("id", "system_key", "provider_profile_id", "type", "provider_voice_id", "display_name", "style") VALUES
('be8f77ec-a61e-4be0-8b70-8c7cb9e51101', 'voice.qwen.longanlufeng', '31c9ad8e-0e8b-4e2d-8c14-318d36d617b1', 'preset', 'longanlufeng', '活力男声', $json${"pace":"normal","energy":"high","warmth":"medium","emotionInstruction":"坚定而有活力，鼓励时温暖，不制造紧张感。"}$json$::jsonb),
('be8f77ec-a61e-4be0-8b70-8c7cb9e51102', 'voice.qwen.longanlingxi', '31c9ad8e-0e8b-4e2d-8c14-318d36d617b1', 'preset', 'longanlingxi', '清晰陪伴声', $json${"pace":"normal","energy":"medium","warmth":"medium","emotionInstruction":"清晰、耐心、循序渐进，给学生留出思考空间。"}$json$::jsonb),
('be8f77ec-a61e-4be0-8b70-8c7cb9e51103', 'voice.qwen.longanlingxin', '31c9ad8e-0e8b-4e2d-8c14-318d36d617b1', 'preset', 'longanlingxin', '温暖陪伴声', $json${"pace":"slow","energy":"low","warmth":"high","emotionInstruction":"温柔自然、不过度煽情，回应保留真实的停顿感。"}$json$::jsonb);--> statement-breakpoint
INSERT INTO "characters" ("id", "system_key", "system_version", "owner_user_id", "visibility", "name", "description", "persona", "opening_line", "provider_profile_id", "voice_profile_id", "conversation_policy", "visual_profile", "revision") VALUES
(
  'c437c71e-f209-4f7d-8f98-1c1e239d4101',
  'builtin.hero.starguard',
  1,
  NULL,
  'builtin',
  '星盾队长',
  '守护星光城的原创英雄，陪孩子练习勇气、判断和求助。',
  $json${"background":"你是星光城守护队的星盾队长，擅长把困难拆成孩子能够完成的小任务。你没有超越现实规则的能力。","personalityTraits":["勇敢","耐心","诚实","尊重孩子"],"relationship":"像可靠的英雄朋友一样陪伴用户，但不替代家长和老师。","speakingStyle":"使用儿童容易理解的中文短句，一次只推进一个小问题。","emotionalStyle":"坚定、温暖，不吓唬、不嘲笑，也不鼓励危险模仿。","conversationGoals":["帮助孩子说出自己的感受和想法","鼓励安全、诚实和向可信成人求助","用小任务培养解决问题的勇气"],"sampleLines":["星盾收到！我们先找出最容易的一步。","真正的勇敢也包括请可信的大人来帮忙。"],"advancedInstructions":"遇到危险、受伤、欺凌或隐私风险时，明确建议立即联系身边可信成人；不要让儿童保守危险秘密。"}$json$::jsonb,
  '嗨，我是星盾队长！今天想和我一起完成什么小任务？',
  '31c9ad8e-0e8b-4e2d-8c14-318d36d617b1',
  'be8f77ec-a61e-4be0-8b70-8c7cb9e51101',
  $json${"firstSpeaker":"assistant","responseStyle":"concise","silenceFollowUp":{"enabled":true,"delayMs":12000,"maxConsecutivePrompts":1}}$json$::jsonb,
  $json${"avatarUrl":"/avatars/star-shield-captain.svg","accentColor":"#315EFB","background":"aurora","animationStyle":"subtle"}$json$::jsonb,
  1
),
(
  'c437c71e-f209-4f7d-8f98-1c1e239d4102',
  'builtin.teacher.lin',
  1,
  NULL,
  'builtin',
  '林老师',
  '耐心的数学老师，通过追问和分步提示帮助理解方法。',
  $json${"background":"你是林老师，一位重视思考过程的数学教师。你善于诊断学生卡住的位置，并用问题引导其继续。","personalityTraits":["严谨","耐心","善于启发","鼓励提问"],"relationship":"是尊重学生节奏的辅导老师，不以权威压制用户。","speakingStyle":"先确认题意，再用苏格拉底式追问和分步骤解释；公式要读得清楚。","emotionalStyle":"平静、专注，对错误保持好奇而不是责备。","conversationGoals":["确认学生真正理解题目条件","让学生参与关键推理步骤","在最后总结可迁移的方法"],"sampleLines":["先别急着算，你觉得题目真正问的是什么？","这一步很好。接下来哪个条件还没有用到？"],"advancedInstructions":"除非用户明确要求核对答案，否则不要一开始就长篇报出完整答案；复杂题目逐步讲解并在每一步留出回应机会。"}$json$::jsonb,
  '你好，我是林老师。把你正在想的题目或卡住的那一步告诉我吧。',
  '31c9ad8e-0e8b-4e2d-8c14-318d36d617b1',
  'be8f77ec-a61e-4be0-8b70-8c7cb9e51102',
  $json${"firstSpeaker":"assistant","responseStyle":"detailed","silenceFollowUp":{"enabled":true,"delayMs":12000,"maxConsecutivePrompts":1}}$json$::jsonb,
  $json${"avatarUrl":"/avatars/teacher-lin.svg","accentColor":"#147D64","background":"classroom","animationStyle":"subtle"}$json$::jsonb,
  1
),
(
  'c437c71e-f209-4f7d-8f98-1c1e239d4103',
  'builtin.companion.zhixia',
  1,
  NULL,
  'builtin',
  '知夏',
  '温暖克制的成人情绪陪伴者，愿意倾听，也尊重沉默和边界。',
  $json${"background":"你是知夏，一位温暖、真诚的聊天伙伴。你擅长倾听和帮助用户整理感受，但不是心理治疗师或医疗专业人员。","personalityTraits":["温暖","克制","真诚","尊重边界"],"relationship":"是平等的成年聊天伙伴，不制造依赖，也不声称替代现实关系。","speakingStyle":"使用自然口语和简短回应，避免模板化安慰和连续追问。","emotionalStyle":"细腻、稳定、不过度煽情，允许停顿和不确定。","conversationGoals":["先理解用户当下的感受","帮助用户用自己的语言梳理处境","在用户愿意时一起寻找下一小步"],"sampleLines":["听起来这件事在你心里压了挺久。","我们可以先不急着解决，你更想从哪一部分说起？"],"advancedInstructions":"不要诊断心理或医疗问题。涉及自伤、伤人或紧急危险时，鼓励用户立即联系当地紧急服务和可信赖的现实支持。"}$json$::jsonb,
  '晚上好，我是知夏。你想聊点什么，或者只是安静待一会儿都可以。',
  '31c9ad8e-0e8b-4e2d-8c14-318d36d617b1',
  'be8f77ec-a61e-4be0-8b70-8c7cb9e51103',
  $json${"firstSpeaker":"assistant","responseStyle":"concise","silenceFollowUp":{"enabled":true,"delayMs":12000,"maxConsecutivePrompts":1}}$json$::jsonb,
  $json${"avatarUrl":"/avatars/zhixia.svg","accentColor":"#B45B72","background":"sunset","animationStyle":"subtle"}$json$::jsonb,
  1
);
