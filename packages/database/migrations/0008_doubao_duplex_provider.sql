INSERT INTO "provider_profiles" ("id", "system_key", "provider", "model", "display_name", "capabilities") VALUES
('31c9ad8e-0e8b-4e2d-8c14-318d36d617b2', 'provider.doubao.seeduplex-1.2.6.1', 'doubao', '1.2.6.1', '豆包实时语音 3.0 全双工', $json${"audioInput":true,"textInput":true,"imageInput":false}$json$::jsonb)
ON CONFLICT ("system_key") DO NOTHING;--> statement-breakpoint
INSERT INTO "voice_profiles" ("id", "system_key", "provider_profile_id", "type", "provider_voice_id", "display_name", "style") VALUES
('be8f77ec-a61e-4be0-8b70-8c7cb9e51201', 'voice.doubao.vivi-jupiter', '31c9ad8e-0e8b-4e2d-8c14-318d36d617b2', 'preset', 'zh_female_vv_jupiter_bigtts', 'Vivi', $json${"pace":"normal","energy":"medium","warmth":"medium","emotionInstruction":"自然、有亲和力，适合日常陪伴和角色对话。"}$json$::jsonb),
('be8f77ec-a61e-4be0-8b70-8c7cb9e51202', 'voice.doubao.xiaohe-jupiter', '31c9ad8e-0e8b-4e2d-8c14-318d36d617b2', 'preset', 'zh_female_xiaohe_jupiter_bigtts', '小何', $json${"pace":"normal","energy":"medium","warmth":"high","emotionInstruction":"亲切、温暖、表达清晰，适合耐心交流。"}$json$::jsonb),
('be8f77ec-a61e-4be0-8b70-8c7cb9e51203', 'voice.doubao.yunzhou-jupiter', '31c9ad8e-0e8b-4e2d-8c14-318d36d617b2', 'preset', 'zh_male_yunzhou_jupiter_bigtts', '云舟', $json${"pace":"normal","energy":"medium","warmth":"medium","emotionInstruction":"沉稳自然、有角色感，回应不过度播音化。"}$json$::jsonb),
('be8f77ec-a61e-4be0-8b70-8c7cb9e51204', 'voice.doubao.xiaotian-jupiter', '31c9ad8e-0e8b-4e2d-8c14-318d36d617b2', 'preset', 'zh_male_xiaotian_jupiter_bigtts', '小天', $json${"pace":"normal","energy":"high","warmth":"medium","emotionInstruction":"明快、有活力，保持自然口语节奏。"}$json$::jsonb)
ON CONFLICT ("system_key") DO NOTHING;
