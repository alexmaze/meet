UPDATE "voice_profiles" AS "voice"
SET
  "status" = 'enabled',
  "verified_at" = "profile"."verified_at",
  "revision" = "voice"."revision" + 1,
  "updated_at" = now()
FROM "provider_profiles" AS "profile"
WHERE
  "voice"."provider_profile_id" = "profile"."id"
  AND "voice"."source" = 'builtin'
  AND "profile"."kind" = 'realtime_voice'
  AND "profile"."status" = 'enabled'
  AND "profile"."verified_at" IS NOT NULL
  AND (
    "voice"."status" <> 'enabled'
    OR "voice"."verified_at" IS NULL
  );
