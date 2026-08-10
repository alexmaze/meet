const PCM16_MAX = 32_767;
const PCM16_MIN = -32_768;

export function decodePcm16Base64(input: string): Int16Array {
  const binary = atob(input);
  if (binary.length % 2 !== 0) {
    throw new Error("PCM16 音频字节数必须是偶数。");
  }

  const samples = new Int16Array(binary.length / 2);
  for (let index = 0; index < samples.length; index += 1) {
    const byteIndex = index * 2;
    const low = binary.charCodeAt(byteIndex);
    const high = binary.charCodeAt(byteIndex + 1);
    const unsigned = low | (high << 8);
    samples[index] = unsigned >= 0x8000 ? unsigned - 0x10000 : unsigned;
  }
  return samples;
}

export function encodePcm16Base64(samples: Int16Array): string {
  const bytes = new Uint8Array(samples.length * 2);
  for (let index = 0; index < samples.length; index += 1) {
    const value = samples[index] ?? 0;
    bytes[index * 2] = value & 0xff;
    bytes[index * 2 + 1] = (value >>> 8) & 0xff;
  }

  let binary = "";
  const blockSize = 0x4000;
  for (let offset = 0; offset < bytes.length; offset += blockSize) {
    const block = bytes.subarray(offset, offset + blockSize);
    for (const byte of block) {
      binary += String.fromCharCode(byte);
    }
  }
  return btoa(binary);
}

export function floatToPcm16(value: number): number {
  const clamped = Math.max(-1, Math.min(1, value));
  return Math.round(clamped < 0 ? clamped * -PCM16_MIN : clamped * PCM16_MAX);
}

/**
 * Streaming linear resampler used for microphone capture. It retains the final
 * source sample between AudioWorklet render quanta, so packet boundaries do not
 * change the resampling phase.
 */
export class StreamingFloat32ToPcm16Resampler {
  private readonly step: number;
  private source: number[] = [];
  private sourcePosition = 0;

  constructor(
    readonly sourceSampleRate: number,
    readonly targetSampleRate: number,
  ) {
    if (
      !Number.isFinite(sourceSampleRate) ||
      !Number.isFinite(targetSampleRate) ||
      sourceSampleRate <= 0 ||
      targetSampleRate <= 0
    ) {
      throw new Error("音频采样率必须是正数。");
    }
    this.step = sourceSampleRate / targetSampleRate;
  }

  push(input: Float32Array): Int16Array {
    for (const sample of input) {
      this.source.push(sample);
    }

    const output: number[] = [];
    while (Math.floor(this.sourcePosition) + 1 < this.source.length) {
      const index = Math.floor(this.sourcePosition);
      const fraction = this.sourcePosition - index;
      const first = this.source[index] ?? 0;
      const second = this.source[index + 1] ?? first;
      output.push(floatToPcm16(first + (second - first) * fraction));
      this.sourcePosition += this.step;
    }

    // Retain the final source sample because the next interpolation can span
    // the current and following AudioWorklet blocks. sourcePosition may jump
    // past this block while downsampling, so clamp the number actually removed.
    const consumed = Math.min(
      Math.floor(this.sourcePosition),
      Math.max(0, this.source.length - 1),
    );
    if (consumed > 0) {
      this.source.splice(0, consumed);
      this.sourcePosition -= consumed;
    }
    return Int16Array.from(output);
  }

  reset(): void {
    this.source = [];
    this.sourcePosition = 0;
  }
}

/** Stateless conversion is deliberate for provider output chunks: a response
 * boundary can never interpolate one response's last sample into the next one.
 */
export function resamplePcm16(
  input: Int16Array,
  sourceSampleRate: number,
  targetSampleRate: number,
): Int16Array {
  if (input.length === 0 || sourceSampleRate === targetSampleRate) {
    return input.slice();
  }
  if (sourceSampleRate <= 0 || targetSampleRate <= 0) {
    throw new Error("音频采样率必须是正数。");
  }

  const outputLength = Math.max(
    1,
    Math.round((input.length * targetSampleRate) / sourceSampleRate),
  );
  const output = new Int16Array(outputLength);
  const step = sourceSampleRate / targetSampleRate;
  for (let outputIndex = 0; outputIndex < outputLength; outputIndex += 1) {
    const position = Math.min(outputIndex * step, input.length - 1);
    const firstIndex = Math.floor(position);
    const secondIndex = Math.min(firstIndex + 1, input.length - 1);
    const fraction = position - firstIndex;
    const first = input[firstIndex] ?? 0;
    const second = input[secondIndex] ?? first;
    output[outputIndex] = Math.round(first + (second - first) * fraction);
  }
  return output;
}

export class Pcm16Packetizer {
  private chunks: Int16Array[] = [];
  private firstChunkOffset = 0;
  private sampleCount = 0;

  constructor(readonly packetSamples: number) {
    if (!Number.isInteger(packetSamples) || packetSamples <= 0) {
      throw new Error("PCM 分包样本数必须是正整数。");
    }
  }

  push(samples: Int16Array): Int16Array[] {
    if (samples.length > 0) {
      this.chunks.push(samples.slice());
      this.sampleCount += samples.length;
    }

    const packets: Int16Array[] = [];
    while (this.sampleCount >= this.packetSamples) {
      const packet = new Int16Array(this.packetSamples);
      let packetOffset = 0;

      while (packetOffset < packet.length) {
        const chunk = this.chunks[0];
        if (!chunk) {
          throw new Error("PCM 分包缓冲区状态无效。");
        }
        const available = chunk.length - this.firstChunkOffset;
        const count = Math.min(available, packet.length - packetOffset);
        packet.set(
          chunk.subarray(this.firstChunkOffset, this.firstChunkOffset + count),
          packetOffset,
        );
        packetOffset += count;
        this.firstChunkOffset += count;
        this.sampleCount -= count;

        if (this.firstChunkOffset === chunk.length) {
          this.chunks.shift();
          this.firstChunkOffset = 0;
        }
      }
      packets.push(packet);
    }
    return packets;
  }

  reset(): void {
    this.chunks = [];
    this.firstChunkOffset = 0;
    this.sampleCount = 0;
  }
}
