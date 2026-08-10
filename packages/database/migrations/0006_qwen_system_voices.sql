INSERT INTO "voice_profiles" ("id", "system_key", "provider_profile_id", "type", "provider_voice_id", "display_name", "style") VALUES
('be8f77ec-a61e-4be0-8b70-8c7cb9e51104', 'voice.qwen.longanqian', '31c9ad8e-0e8b-4e2d-8c14-318d36d617b1', 'preset', 'longanqian', '自然女声', $json${"pace":"normal","energy":"medium","warmth":"medium","emotionInstruction":"自然、亲切、清晰，适合轻松日常交流。"}$json$::jsonb),
('be8f77ec-a61e-4be0-8b70-8c7cb9e51105', 'voice.qwen.longanxiaoxin', '31c9ad8e-0e8b-4e2d-8c14-318d36d617b1', 'preset', 'longanxiaoxin', '亲切活力声', $json${"pace":"normal","energy":"high","warmth":"medium","emotionInstruction":"亲切活泼、明快自然，表达有朝气但不过分夸张。"}$json$::jsonb)
ON CONFLICT DO NOTHING;
