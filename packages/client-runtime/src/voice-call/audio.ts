/** Sample rate the on-device transcriber is fed; speech carries nothing useful above 8 kHz. */
export const VOICE_CALL_SAMPLE_RATE = 16_000;

/** Linear-interpolation resample. Good enough for speech going to a recognizer. */
export function resampleLinear(
  samples: Float32Array,
  fromRate: number,
  toRate: number,
): Float32Array {
  if (fromRate === toRate || samples.length === 0) return samples;
  const ratio = fromRate / toRate;
  const length = Math.max(1, Math.floor(samples.length / ratio));
  const output = new Float32Array(length);
  for (let index = 0; index < length; index += 1) {
    const position = index * ratio;
    const left = Math.floor(position);
    const right = Math.min(left + 1, samples.length - 1);
    const fraction = position - left;
    output[index] = (samples[left] ?? 0) * (1 - fraction) + (samples[right] ?? 0) * fraction;
  }
  return output;
}

/** 16-bit PCM mono WAV, the format the desktop helper reads. */
export function encodeWavPcm16(samples: Float32Array, sampleRate: number): Uint8Array {
  const dataBytes = samples.length * 2;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);
  const writeAscii = (offset: number, text: string) => {
    for (let index = 0; index < text.length; index += 1) {
      view.setUint8(offset + index, text.charCodeAt(index));
    }
  };
  writeAscii(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(8, "WAVE");
  writeAscii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(36, "data");
  view.setUint32(40, dataBytes, true);
  for (let index = 0; index < samples.length; index += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[index] ?? 0));
    view.setInt16(44 + index * 2, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
  }
  return new Uint8Array(buffer);
}

export function rootMeanSquare(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (const sample of samples) sum += sample * sample;
  return Math.sqrt(sum / samples.length);
}

export type UtteranceDetectorOptions = {
  /** RMS above this counts as voice once the noise floor is accounted for. */
  readonly minimumLevel: number;
  /** Voice must last this long before an utterance starts (filters clicks and coughs). */
  readonly startAfterMs: number;
  /** Silence this long ends the utterance. */
  readonly endAfterSilenceMs: number;
  /** Hard cap on a single utterance. */
  readonly maxUtteranceMs: number;
  /** Audio kept from before the start so the first syllable is not clipped. */
  readonly preRollMs: number;
};

export const DEFAULT_UTTERANCE_DETECTOR_OPTIONS: UtteranceDetectorOptions = {
  minimumLevel: 0.012,
  startAfterMs: 160,
  endAfterSilenceMs: 1_100,
  maxUtteranceMs: 60_000,
  preRollMs: 300,
};

export type UtteranceEvent =
  | { readonly type: "speech-start" }
  | { readonly type: "utterance"; readonly samples: Float32Array; readonly sampleRate: number };

/**
 * Energy-based voice activity detection over fixed-size frames. The threshold adapts to
 * the room: it sits a few times above a slowly tracked noise floor.
 */
export class UtteranceDetector {
  private readonly options: UtteranceDetectorOptions;
  private readonly sampleRate: number;
  private noiseFloor = 0.004;
  private voicedMs = 0;
  private silentMs = 0;
  private speaking = false;
  private utteranceMs = 0;
  private preRoll: Float32Array[] = [];
  private preRollMs = 0;
  private chunks: Float32Array[] = [];

  constructor(sampleRate: number, options: Partial<UtteranceDetectorOptions> = {}) {
    this.sampleRate = sampleRate;
    this.options = { ...DEFAULT_UTTERANCE_DETECTOR_OPTIONS, ...options };
  }

  get isSpeaking(): boolean {
    return this.speaking;
  }

  threshold(): number {
    return Math.max(this.options.minimumLevel, this.noiseFloor * 3);
  }

  reset(): void {
    this.voicedMs = 0;
    this.silentMs = 0;
    this.speaking = false;
    this.utteranceMs = 0;
    this.preRoll = [];
    this.preRollMs = 0;
    this.chunks = [];
  }

  /** Feeds one frame; returns the events it caused. */
  push(frame: Float32Array): UtteranceEvent[] {
    const frameMs = (frame.length / this.sampleRate) * 1000;
    const level = rootMeanSquare(frame);
    const voiced = level >= this.threshold();
    const events: UtteranceEvent[] = [];

    if (!this.speaking) {
      if (!voiced) {
        // Track the floor only while nobody talks, so speech never raises it.
        this.noiseFloor = this.noiseFloor * 0.95 + level * 0.05;
      }
      this.preRoll.push(frame);
      this.preRollMs += frameMs;
      while (this.preRollMs > this.options.preRollMs + this.options.startAfterMs) {
        const dropped = this.preRoll.shift();
        if (!dropped) break;
        this.preRollMs -= (dropped.length / this.sampleRate) * 1000;
      }
      this.voicedMs = voiced ? this.voicedMs + frameMs : 0;
      if (this.voicedMs >= this.options.startAfterMs) {
        this.speaking = true;
        this.silentMs = 0;
        this.chunks = this.preRoll;
        this.utteranceMs = this.preRollMs;
        this.preRoll = [];
        this.preRollMs = 0;
        events.push({ type: "speech-start" });
      }
      return events;
    }

    this.chunks.push(frame);
    this.utteranceMs += frameMs;
    this.silentMs = voiced ? 0 : this.silentMs + frameMs;
    if (
      this.silentMs >= this.options.endAfterSilenceMs ||
      this.utteranceMs >= this.options.maxUtteranceMs
    ) {
      events.push({
        type: "utterance",
        samples: concatFrames(this.chunks),
        sampleRate: this.sampleRate,
      });
      this.reset();
    }
    return events;
  }
}

function concatFrames(frames: readonly Float32Array[]): Float32Array {
  const length = frames.reduce((total, frame) => total + frame.length, 0);
  const output = new Float32Array(length);
  let offset = 0;
  for (const frame of frames) {
    output.set(frame, offset);
    offset += frame.length;
  }
  return output;
}
