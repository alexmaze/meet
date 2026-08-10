import {
  Pcm16Packetizer,
  StreamingFloat32ToPcm16Resampler,
} from "./pcm-codec.js";
import type {
  GenerationPcmSink,
  TaggedPcmChunk,
} from "./interruptible-pcm-playback.js";

const MICROPHONE_PROCESSOR_NAME = "meet-microphone-capture-v1";
const PLAYBACK_PROCESSOR_NAME = "meet-interruptible-playback-v1";
const DEFAULT_INPUT_SAMPLE_RATE = 16_000;
const DEFAULT_PACKET_DURATION_MS = 20;
const DEFAULT_PLAYBACK_PREBUFFER_MS = 160;
const DEFAULT_PLAYBACK_MAX_BUFFERING_MS = 300;

type AudioContextConstructor = new (
  contextOptions?: AudioContextOptions,
) => AudioContext;

type WebkitAudioWindow = Window & {
  AudioContext?: AudioContextConstructor;
  webkitAudioContext?: AudioContextConstructor;
};

export type BrowserPcmError = {
  code: string;
  message: string;
};

export class AudioContextResumeGate {
  private attempt = 0;
  private pending: Promise<void> | null = null;

  resume(
    operation: () => Promise<void>,
    onRunning: () => void,
    onRejected: () => void,
    force = false,
  ): void {
    if (force) {
      this.attempt += 1;
      this.pending = null;
    }
    if (this.pending) {
      return;
    }

    const attempt = ++this.attempt;
    let promise: Promise<void>;
    try {
      promise = operation();
    } catch {
      onRejected();
      return;
    }
    this.pending = promise;
    void promise
      .then(() => {
        if (this.attempt === attempt) {
          onRunning();
        }
      })
      .catch(() => {
        if (this.attempt === attempt) {
          onRejected();
        }
      })
      .finally(() => {
        if (this.pending === promise) {
          this.pending = null;
        }
      });
  }

  cancel(): void {
    this.attempt += 1;
    this.pending = null;
  }
}

export type MicrophonePcmCaptureOptions = {
  deviceId?: string;
  packetDurationMs?: number;
  onPacket: (samples: Int16Array) => void;
  onError?: (error: BrowserPcmError) => void;
};

export interface PcmMicrophoneCapture {
  readonly microphoneLabel: string;
  start(): Promise<void>;
  ensureAvailable(): Promise<void>;
  setEnabled(enabled: boolean): void;
  stop(): Promise<void>;
}

export interface PcmPlaybackOutput extends GenerationPcmSink {
  readonly outputSampleRate: number;
  start(): Promise<void>;
  ensureRunning(): void;
  stop(): Promise<void>;
}

export class AudioWorkletMicrophoneCapture implements PcmMicrophoneCapture {
  private stream: MediaStream | null = null;
  private track: MediaStreamTrack | null = null;
  private context: AudioContext | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private processor: AudioWorkletNode | null = null;
  private silentGain: GainNode | null = null;
  private moduleUrl: string | null = null;
  private resampler: StreamingFloat32ToPcm16Resampler | null = null;
  private packetizer: Pcm16Packetizer | null = null;
  private enabled = false;
  private stopped = false;
  private resumeErrorReported = false;
  private readonly resumeGate = new AudioContextResumeGate();
  private pointerRetry: EventListener | null = null;
  private visibilityRetry: EventListener | null = null;

  constructor(private readonly options: MicrophonePcmCaptureOptions) {}

  get microphoneLabel(): string {
    return this.track?.label || "已授权的麦克风";
  }

  async start(): Promise<void> {
    this.stopped = false;
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new BrowserAudioError(
        "MEDIA_UNAVAILABLE",
        "当前浏览器不支持麦克风采集，请使用新版浏览器并通过 HTTPS 访问。",
      );
    }

    const Context = getAudioContextConstructor();
    if (!Context) {
      throw new BrowserAudioError(
        "WEB_AUDIO_UNAVAILABLE",
        "当前浏览器不支持实时 PCM 音频处理。",
      );
    }
    const context = new Context({ latencyHint: "interactive" });
    this.context = context;
    if (!context.audioWorklet) {
      throw new BrowserAudioError(
        "AUDIO_WORKLET_UNAVAILABLE",
        "当前浏览器不支持低延迟音频处理，请升级浏览器后重试。",
      );
    }
    this.registerResumeListeners();
    // Like playback, start the context before the first await so this remains
    // associated with the user's call-button activation.
    this.ensureRunning();
    const moduleUrl = createWorkletModuleUrl(MICROPHONE_WORKLET_SOURCE);
    this.moduleUrl = moduleUrl;
    const workletReady = context.audioWorklet.addModule(moduleUrl);

    const constraints: MediaTrackConstraints = {
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    };
    if (this.options.deviceId) {
      constraints.deviceId = { exact: this.options.deviceId };
    }

    const [streamResult, workletResult] = await Promise.allSettled([
      navigator.mediaDevices.getUserMedia({
        audio: constraints,
        video: false,
      }),
      workletReady,
    ]);
    if (streamResult.status === "fulfilled") {
      this.stream = streamResult.value;
    }
    if (this.stopped) {
      for (const streamTrack of this.stream?.getTracks() ?? []) {
        streamTrack.stop();
      }
      return;
    }
    if (streamResult.status === "rejected") {
      throw streamResult.reason;
    }
    if (workletResult.status === "rejected") {
      for (const streamTrack of streamResult.value.getTracks()) {
        streamTrack.stop();
      }
      this.stream = null;
      throw workletResult.reason;
    }
    const stream = streamResult.value;

    this.track = stream.getAudioTracks()[0] ?? null;
    if (!this.track) {
      throw new BrowserAudioError(
        "NO_AUDIO_TRACK",
        "没有获得可用的麦克风音轨。",
      );
    }
    this.track.enabled = false;

    if (this.stopped || this.context !== context) {
      return;
    }

    const packetDurationMs =
      this.options.packetDurationMs ?? DEFAULT_PACKET_DURATION_MS;
    if (packetDurationMs < 20 || packetDurationMs > 40) {
      throw new BrowserAudioError(
        "INVALID_AUDIO_PACKET_DURATION",
        "麦克风 PCM 分包时长必须在 20–40ms 之间。",
      );
    }
    this.resampler = new StreamingFloat32ToPcm16Resampler(
      context.sampleRate,
      DEFAULT_INPUT_SAMPLE_RATE,
    );
    this.packetizer = new Pcm16Packetizer(
      Math.round((DEFAULT_INPUT_SAMPLE_RATE * packetDurationMs) / 1000),
    );

    const processor = new AudioWorkletNode(context, MICROPHONE_PROCESSOR_NAME, {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
    });
    const silentGain = context.createGain();
    silentGain.gain.value = 0;
    const source = context.createMediaStreamSource(stream);
    source.connect(processor);
    processor.connect(silentGain);
    silentGain.connect(context.destination);
    processor.port.onmessage = (message: MessageEvent<unknown>) => {
      this.handleProcessorMessage(message.data);
    };
    this.source = source;
    this.processor = processor;
    this.silentGain = silentGain;
  }

  async ensureAvailable(): Promise<void> {
    if (
      this.track?.readyState === "live" &&
      this.context &&
      this.context.state !== "closed"
    ) {
      this.ensureRunning();
      return;
    }
    await this.stop();
    await this.start();
  }

  setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) {
      return;
    }
    this.enabled = enabled;
    if (this.track) {
      this.track.enabled = enabled;
    }
    if (enabled) {
      this.ensureRunning();
    }
    this.resampler?.reset();
    this.packetizer?.reset();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.enabled = false;
    this.resumeGate.cancel();
    this.removeResumeListeners();
    this.processor?.port.close();
    this.source?.disconnect();
    this.processor?.disconnect();
    this.silentGain?.disconnect();
    for (const track of this.stream?.getTracks() ?? []) {
      track.stop();
    }
    const context = this.context;
    this.stream = null;
    this.track = null;
    this.context = null;
    this.source = null;
    this.processor = null;
    this.silentGain = null;
    this.resampler = null;
    this.packetizer = null;
    if (this.moduleUrl) {
      URL.revokeObjectURL(this.moduleUrl);
      this.moduleUrl = null;
    }
    if (context && context.state !== "closed") {
      await context.close().catch(() => undefined);
    }
  }

  private ensureRunning(force = false): void {
    const context = this.context;
    if (!context || context.state === "closed" || context.state === "running") {
      if (context?.state === "running") {
        this.resumeErrorReported = false;
      }
      return;
    }
    this.resumeGate.resume(
      () => context.resume(),
      () => {
        if (this.context === context && context.state === "running") {
          this.resumeErrorReported = false;
        }
      },
      () => {
        if (!this.resumeErrorReported && this.context === context) {
          this.resumeErrorReported = true;
          this.options.onError?.({
            code: "MICROPHONE_AUDIO_CONTEXT_SUSPENDED",
            message: "麦克风音频处理被浏览器暂停，请点击页面恢复。",
          });
        }
      },
      force,
    );
  }

  private registerResumeListeners(): void {
    if (typeof document === "undefined") {
      return;
    }
    this.pointerRetry = () => this.ensureRunning(true);
    this.visibilityRetry = () => {
      if (document.visibilityState === "visible") {
        this.ensureRunning();
      }
    };
    document.addEventListener("pointerdown", this.pointerRetry, {
      capture: true,
    });
    document.addEventListener("visibilitychange", this.visibilityRetry);
  }

  private removeResumeListeners(): void {
    if (typeof document !== "undefined" && this.pointerRetry) {
      document.removeEventListener("pointerdown", this.pointerRetry, {
        capture: true,
      });
    }
    if (typeof document !== "undefined" && this.visibilityRetry) {
      document.removeEventListener("visibilitychange", this.visibilityRetry);
    }
    this.pointerRetry = null;
    this.visibilityRetry = null;
  }

  private handleProcessorMessage(input: unknown): void {
    if (!this.enabled || !(input instanceof Float32Array)) {
      return;
    }
    const resampled = this.resampler?.push(input);
    if (!resampled || !this.packetizer) {
      return;
    }
    for (const packet of this.packetizer.push(resampled)) {
      this.options.onPacket(packet);
    }
  }
}

export type AudioWorkletPcmPlaybackOptions = {
  onError?: (error: BrowserPcmError) => void;
};

export type LowLatencyQueueAdmission = {
  accepted: boolean;
  samples: Int16Array;
};

/**
 * Pure generation/availability policy shared by the browser player and tests.
 *
 * Once a chunk has been accepted for the current response generation it is
 * never discarded just to reduce latency. Only an explicit generation reset or
 * an unavailable audio context may clear queued samples.
 */
export class LowLatencyPcmQueuePolicy {
  private generation = 0;
  private available = false;
  private queuedSamples = 0;

  reset(generation: number): void {
    this.generation = generation;
    this.queuedSamples = 0;
  }

  setAvailable(available: boolean): boolean {
    const needsPhysicalClear =
      !available && (this.available || this.queuedSamples > 0);
    this.available = available;
    if (!available) {
      this.queuedSamples = 0;
    }
    return needsPhysicalClear;
  }

  admit(chunk: TaggedPcmChunk): LowLatencyQueueAdmission {
    if (!this.available || chunk.generation !== this.generation) {
      return { accepted: false, samples: new Int16Array() };
    }

    this.queuedSamples += chunk.samples.length;
    return { accepted: true, samples: chunk.samples };
  }

  consume(generation: number, samples: number): void {
    if (generation !== this.generation) {
      return;
    }
    this.queuedSamples = Math.max(0, this.queuedSamples - samples);
  }
}

export class AudioWorkletPcmPlayback implements PcmPlaybackOutput {
  private context: AudioContext | null = null;
  private processor: AudioWorkletNode | null = null;
  private moduleUrl: string | null = null;
  private generation = 0;
  private queuePolicy: LowLatencyPcmQueuePolicy | null = null;
  private autoplayErrorReported = false;
  private pointerRetry: EventListener | null = null;
  private visibilityRetry: EventListener | null = null;
  private startAttempt = 0;
  private readonly resumeGate = new AudioContextResumeGate();

  constructor(private readonly options: AudioWorkletPcmPlaybackOptions = {}) {}

  get outputSampleRate(): number {
    return this.context?.sampleRate ?? 24_000;
  }

  async start(): Promise<void> {
    const Context = getAudioContextConstructor();
    if (!Context) {
      throw new BrowserAudioError(
        "WEB_AUDIO_UNAVAILABLE",
        "当前浏览器不支持实时 PCM 音频播放。",
      );
    }

    const attempt = ++this.startAttempt;
    let context: AudioContext;
    try {
      context = new Context({ latencyHint: "interactive", sampleRate: 24_000 });
    } catch {
      context = new Context({ latencyHint: "interactive" });
    }
    this.context = context;
    this.queuePolicy = new LowLatencyPcmQueuePolicy();
    this.queuePolicy.reset(this.generation);
    context.onstatechange = () => this.handleContextAvailabilityChange();
    this.registerResumeListeners();
    // start() is called directly from the user's call button. Resume before the
    // first await so the browser can attribute it to that activation gesture.
    this.ensureRunning();

    if (!context.audioWorklet) {
      throw new BrowserAudioError(
        "AUDIO_WORKLET_UNAVAILABLE",
        "当前浏览器不支持低延迟音频播放，请升级浏览器后重试。",
      );
    }
    const moduleUrl = createWorkletModuleUrl(PLAYBACK_WORKLET_SOURCE);
    this.moduleUrl = moduleUrl;
    await context.audioWorklet.addModule(moduleUrl);
    if (attempt !== this.startAttempt || this.context !== context) {
      return;
    }

    const processor = new AudioWorkletNode(context, PLAYBACK_PROCESSOR_NAME, {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      processorOptions: {
        prebufferFrames: Math.round(
          (context.sampleRate * DEFAULT_PLAYBACK_PREBUFFER_MS) / 1000,
        ),
        maxBufferingFrames: Math.round(
          (context.sampleRate * DEFAULT_PLAYBACK_MAX_BUFFERING_MS) / 1000,
        ),
      },
    });
    processor.port.onmessage = (message: MessageEvent<unknown>) => {
      this.handleProcessorMessage(message.data);
    };
    processor.connect(context.destination);
    this.processor = processor;
    processor.port.postMessage({ type: "reset", generation: this.generation });
    this.handleContextAvailabilityChange();
  }

  reset(generation: number): void {
    this.generation = generation;
    this.queuePolicy?.reset(generation);
    this.processor?.port.postMessage({ type: "reset", generation });
  }

  enqueue(chunk: TaggedPcmChunk): boolean {
    if (!this.processor || !this.queuePolicy) {
      return false;
    }
    this.handleContextAvailabilityChange();
    const admission = this.queuePolicy.admit(chunk);
    if (!admission.accepted) {
      this.ensureRunning();
      return false;
    }

    const transferableSamples =
      admission.samples.byteOffset === 0 &&
      admission.samples.byteLength === admission.samples.buffer.byteLength
        ? admission.samples
        : admission.samples.slice();
    this.processor.port.postMessage(
      {
        type: "enqueue",
        generation: chunk.generation,
        responseId: chunk.responseId,
        samples: transferableSamples.buffer,
      },
      [transferableSamples.buffer],
    );
    this.ensureRunning();
    return true;
  }

  ensureRunning(): void {
    this.resumeContext(false);
  }

  private resumeContext(force: boolean): void {
    const context = this.context;
    if (!context) {
      return;
    }
    if (!isDocumentVisible() || context.state === "closed") {
      this.invalidatePhysicalQueue();
      return;
    }
    if (context.state === "running") {
      this.autoplayErrorReported = false;
      this.queuePolicy?.setAvailable(true);
      return;
    }
    this.invalidatePhysicalQueue();
    this.resumeGate.resume(
      () => context.resume(),
      () => {
        if (
          this.context === context &&
          context.state === "running" &&
          isDocumentVisible()
        ) {
          this.autoplayErrorReported = false;
          this.queuePolicy?.setAvailable(true);
        } else if (this.context === context) {
          this.reportPlaybackBlocked(context);
        }
      },
      () => {
        if (this.context === context) {
          this.reportPlaybackBlocked(context);
        }
      },
      force,
    );
  }

  async stop(): Promise<void> {
    this.startAttempt += 1;
    this.resumeGate.cancel();
    this.removeResumeListeners();
    this.generation += 1;
    this.queuePolicy?.reset(this.generation);
    this.queuePolicy?.setAvailable(false);
    this.processor?.port.postMessage({
      type: "reset",
      generation: this.generation,
    });
    this.processor?.port.close();
    this.processor?.disconnect();
    const context = this.context;
    if (context) {
      context.onstatechange = null;
    }
    this.processor = null;
    this.context = null;
    this.queuePolicy = null;
    if (this.moduleUrl) {
      URL.revokeObjectURL(this.moduleUrl);
      this.moduleUrl = null;
    }
    if (context && context.state !== "closed") {
      await context.close().catch(() => undefined);
    }
  }

  private handleProcessorMessage(input: unknown): void {
    if (!isRecord(input) || input.type !== "consumed") {
      return;
    }
    if (
      input.generation !== this.generation ||
      typeof input.samples !== "number"
    ) {
      return;
    }
    this.queuePolicy?.consume(input.generation, input.samples);
  }

  private registerResumeListeners(): void {
    if (typeof document === "undefined") {
      return;
    }
    if (!this.pointerRetry) {
      this.pointerRetry = () => this.resumeContext(true);
      document.addEventListener("pointerdown", this.pointerRetry, {
        capture: true,
      });
    }
    if (!this.visibilityRetry) {
      this.visibilityRetry = () => {
        if (document.visibilityState === "visible") {
          this.ensureRunning();
        } else {
          this.invalidatePhysicalQueue();
        }
      };
      document.addEventListener("visibilitychange", this.visibilityRetry);
    }
  }

  private removeResumeListeners(): void {
    if (typeof document !== "undefined" && this.pointerRetry) {
      document.removeEventListener("pointerdown", this.pointerRetry, {
        capture: true,
      });
    }
    if (typeof document !== "undefined" && this.visibilityRetry) {
      document.removeEventListener("visibilitychange", this.visibilityRetry);
    }
    this.pointerRetry = null;
    this.visibilityRetry = null;
  }

  private handleContextAvailabilityChange(): void {
    const context = this.context;
    if (!context || context.state !== "running" || !isDocumentVisible()) {
      this.invalidatePhysicalQueue();
      if (context && context.state !== "closed" && isDocumentVisible()) {
        this.ensureRunning();
      }
      return;
    }
    this.autoplayErrorReported = false;
    this.queuePolicy?.setAvailable(true);
  }

  private invalidatePhysicalQueue(): void {
    if (!this.queuePolicy?.setAvailable(false)) {
      return;
    }
    this.processor?.port.postMessage({
      type: "reset",
      generation: this.generation,
    });
  }

  private reportPlaybackBlocked(context: AudioContext): void {
    if (this.autoplayErrorReported || this.context !== context) {
      return;
    }
    this.autoplayErrorReported = true;
    this.options.onError?.({
      code: "AUDIO_PLAYBACK_BLOCKED",
      message: "浏览器阻止了声音播放，请点击页面恢复声音。",
    });
  }
}

export class BrowserAudioError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "BrowserAudioError";
  }
}

function getAudioContextConstructor(): AudioContextConstructor | null {
  if (typeof window === "undefined") {
    return null;
  }
  const audioWindow = window as WebkitAudioWindow;
  return audioWindow.AudioContext ?? audioWindow.webkitAudioContext ?? null;
}

function createWorkletModuleUrl(source: string): string {
  return URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null;
}

function isDocumentVisible(): boolean {
  return (
    typeof document === "undefined" || document.visibilityState !== "hidden"
  );
}

const MICROPHONE_WORKLET_SOURCE = `
class MeetMicrophoneCaptureProcessor extends AudioWorkletProcessor {
  process(inputs, outputs) {
    const input = inputs[0] && inputs[0][0];
    const output = outputs[0] && outputs[0][0];
    if (output) output.fill(0);
    if (input && input.length > 0) {
      const copy = new Float32Array(input);
      this.port.postMessage(copy, [copy.buffer]);
    }
    return true;
  }
}
registerProcessor("${MICROPHONE_PROCESSOR_NAME}", MeetMicrophoneCaptureProcessor);
`;

export const PLAYBACK_WORKLET_SOURCE = `
class MeetInterruptiblePlaybackProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.generation = 0;
    this.queue = [];
    this.offset = 0;
    this.bufferedFrames = 0;
    this.playing = false;
    this.bufferingFrames = 0;
    this.consumed = 0;
    const configuredPrebuffer = options && options.processorOptions
      ? options.processorOptions.prebufferFrames
      : 0;
    const configuredMaximumWait = options && options.processorOptions
      ? options.processorOptions.maxBufferingFrames
      : 0;
    this.prebufferFrames = Number.isFinite(configuredPrebuffer)
      ? Math.max(1, Math.floor(configuredPrebuffer))
      : Math.max(1, Math.round(sampleRate * ${DEFAULT_PLAYBACK_PREBUFFER_MS / 1000}));
    this.maxBufferingFrames = Number.isFinite(configuredMaximumWait)
      ? Math.max(this.prebufferFrames, Math.floor(configuredMaximumWait))
      : Math.max(this.prebufferFrames, Math.round(sampleRate * ${DEFAULT_PLAYBACK_MAX_BUFFERING_MS / 1000}));
    this.port.onmessage = ({ data }) => {
      if (!data || typeof data !== "object") return;
      if (data.type === "reset") {
        this.generation = data.generation;
        this.queue = [];
        this.offset = 0;
        this.bufferedFrames = 0;
        this.playing = false;
        this.bufferingFrames = 0;
        this.consumed = 0;
        return;
      }
      if (data.type === "enqueue" && data.generation === this.generation) {
        const samples = new Int16Array(data.samples);
        if (samples.length === 0) return;
        this.queue.push({
          generation: data.generation,
          responseId: data.responseId,
          samples,
        });
        this.bufferedFrames += samples.length;
        if (!this.playing && this.bufferedFrames >= this.prebufferFrames) {
          this.playing = true;
          this.bufferingFrames = 0;
        }
      }
    };
  }

  process(_inputs, outputs) {
    const output = outputs[0] && outputs[0][0];
    if (!output) return true;
    output.fill(0);
    if (!this.playing) {
      if (this.bufferedFrames === 0) {
        this.bufferingFrames = 0;
        return true;
      }
      this.bufferingFrames += output.length;
      if (
        this.bufferedFrames < this.prebufferFrames &&
        this.bufferingFrames < this.maxBufferingFrames
      ) {
        return true;
      }
      this.playing = true;
      this.bufferingFrames = 0;
    }
    let outputOffset = 0;
    while (outputOffset < output.length && this.queue.length > 0) {
      const chunk = this.queue[0];
      if (chunk.generation !== this.generation) {
        this.queue.shift();
        this.offset = 0;
        continue;
      }
      const remaining = chunk.samples.length - this.offset;
      const count = Math.min(remaining, output.length - outputOffset);
      for (let index = 0; index < count; index += 1) {
        output[outputOffset + index] = chunk.samples[this.offset + index] / 32768;
      }
      outputOffset += count;
      this.offset += count;
      this.bufferedFrames = Math.max(0, this.bufferedFrames - count);
      this.consumed += count;
      if (this.offset >= chunk.samples.length) {
        this.queue.shift();
        this.offset = 0;
      }
    }
    if (this.bufferedFrames === 0) {
      this.playing = false;
      this.bufferingFrames = 0;
    }
    if (this.consumed >= 1024 || (this.queue.length === 0 && this.consumed > 0)) {
      this.port.postMessage({
        type: "consumed",
        generation: this.generation,
        samples: this.consumed,
      });
      this.consumed = 0;
    }
    return true;
  }
}
registerProcessor("${PLAYBACK_PROCESSOR_NAME}", MeetInterruptiblePlaybackProcessor);
`;
