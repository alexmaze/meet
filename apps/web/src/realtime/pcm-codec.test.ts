import { describe, expect, it } from "vitest";

import {
  decodePcm16Base64,
  encodePcm16Base64,
  Pcm16Packetizer,
  resamplePcm16,
  StreamingFloat32ToPcm16Resampler,
} from "./pcm-codec.js";

describe("PCM codec", () => {
  it("round-trips signed little-endian PCM16 samples", () => {
    const samples = new Int16Array([-32768, -1000, 0, 1000, 32767]);
    expect([...decodePcm16Base64(encodePcm16Base64(samples))]).toEqual([
      -32768, -1000, 0, 1000, 32767,
    ]);
  });

  it("keeps resampling phase across AudioWorklet blocks", () => {
    const resampler = new StreamingFloat32ToPcm16Resampler(48_000, 16_000);
    const first = resampler.push(new Float32Array(128).fill(0.25));
    const second = resampler.push(new Float32Array(352).fill(0.25));

    expect(first.length + second.length).toBe(160);
    expect([...first, ...second].every((sample) => sample === 8192)).toBe(true);
  });

  it("forms deterministic 20ms packets independent of capture blocks", () => {
    const packetizer = new Pcm16Packetizer(320);
    expect(packetizer.push(new Int16Array(100).fill(1))).toEqual([]);
    const packets = packetizer.push(new Int16Array(540).fill(2));

    expect(packets).toHaveLength(2);
    expect(packets[0]?.length).toBe(320);
    expect(packets[1]?.length).toBe(320);
    expect(packets[0]?.[99]).toBe(1);
    expect(packets[0]?.[100]).toBe(2);
  });

  it("resamples 24k provider PCM for a 48k output context", () => {
    const result = resamplePcm16(new Int16Array([1000, -1000]), 24_000, 48_000);

    expect(result).toHaveLength(4);
    expect(result[0]).toBe(1000);
    expect(result[3]).toBe(-1000);
  });
});
