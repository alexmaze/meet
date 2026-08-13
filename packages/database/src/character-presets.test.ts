import {
  conversationPolicySchema,
  personaDefinitionSchema,
  providerCapabilitiesSchema,
  visualProfileSchema,
  voiceStyleSchema,
} from "@meet/protocol";
import { describe, expect, it } from "vitest";

import {
  BUILTIN_CHARACTER_IDS,
  BUILTIN_CHARACTER_PRESETS,
  BUILTIN_VOICE_PROFILES,
  DEFAULT_PROVIDER_PROFILE,
  DEFAULT_QWEN_PROVIDER_PROFILE_ID,
  DOUBAO_DUPLEX_PROVIDER_PROFILE,
  DOUBAO_DUPLEX_PROVIDER_PROFILE_ID,
  DOUBAO_VOICE_PROFILES,
  getBuiltinCharacterPreset,
} from "./character-presets.js";

describe("built-in character presets", () => {
  it("installs three stable, valid, directly callable presets", () => {
    expect(BUILTIN_CHARACTER_PRESETS).toHaveLength(3);
    expect(BUILTIN_CHARACTER_PRESETS.map(({ id }) => id)).toEqual(
      Object.values(BUILTIN_CHARACTER_IDS),
    );
    expect(new Set(BUILTIN_CHARACTER_PRESETS.map(({ id }) => id)).size).toBe(3);
    expect(
      new Set(BUILTIN_CHARACTER_PRESETS.map(({ systemKey }) => systemKey)).size,
    ).toBe(3);

    for (const preset of BUILTIN_CHARACTER_PRESETS) {
      expect(preset.systemVersion).toBe(1);
      expect(personaDefinitionSchema.safeParse(preset.persona).success).toBe(
        true,
      );
      expect(
        conversationPolicySchema.safeParse(preset.conversationPolicy).success,
      ).toBe(true);
      expect(visualProfileSchema.safeParse(preset.visualProfile).success).toBe(
        true,
      );
      expect(preset.providerProfileId).toBe(DEFAULT_QWEN_PROVIDER_PROFILE_ID);
      expect(
        BUILTIN_VOICE_PROFILES.some(
          (voice) =>
            voice.id === preset.voiceProfileId &&
            voice.providerProfileId === preset.providerProfileId,
        ),
      ).toBe(true);
      expect(getBuiltinCharacterPreset(preset.systemKey)).toBe(preset);
    }
  });

  it("uses the current Qwen Audio profile and all five system voice ids", () => {
    expect(DEFAULT_PROVIDER_PROFILE).toMatchObject({
      provider: "qwen",
      model: "qwen-audio-3.0-realtime-plus",
    });
    expect(
      providerCapabilitiesSchema.safeParse(
        DEFAULT_PROVIDER_PROFILE.capabilities,
      ).success,
    ).toBe(true);
    expect(
      BUILTIN_VOICE_PROFILES.map(({ providerVoiceId }) => providerVoiceId),
    ).toEqual([
      "longanqian",
      "longanlufeng",
      "longanlingxi",
      "longanlingxin",
      "longanxiaoxin",
    ]);
    for (const voice of BUILTIN_VOICE_PROFILES) {
      expect(voiceStyleSchema.safeParse(voice.style).success).toBe(true);
      expect(voice.providerProfileId).toBe(DEFAULT_QWEN_PROVIDER_PROFILE_ID);
    }
  });

  it("exposes the Doubao full-duplex profile without changing the default", () => {
    expect(DOUBAO_DUPLEX_PROVIDER_PROFILE).toMatchObject({
      id: DOUBAO_DUPLEX_PROVIDER_PROFILE_ID,
      provider: "doubao",
      model: "1.2.6.1",
    });
    expect(
      DOUBAO_VOICE_PROFILES.map(({ providerVoiceId }) => providerVoiceId),
    ).toEqual([
      "zh_female_vv_jupiter_bigtts",
      "zh_female_xiaohe_jupiter_bigtts",
      "zh_male_yunzhou_jupiter_bigtts",
      "zh_male_xiaotian_jupiter_bigtts",
    ]);
    expect(
      DOUBAO_VOICE_PROFILES.every(
        ({ providerProfileId }) =>
          providerProfileId === DOUBAO_DUPLEX_PROVIDER_PROFILE_ID,
      ),
    ).toBe(true);
    expect(DEFAULT_PROVIDER_PROFILE.provider).toBe("qwen");
  });
});
