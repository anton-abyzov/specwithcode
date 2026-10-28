import {
  encodeWavPcm16,
  resampleLinear,
  rootMeanSquare,
  UtteranceDetector,
  VOICE_CALL_SAMPLE_RATE,
  type UtteranceDetectorOptions,
} from "./audio.ts";
import { speakableText } from "./speakableText.ts";

export type VoiceCallPhase =
  | "idle"
  | "connecting"
  | "listening"
  | "transcribing"
  | "thinking"
  | "speaking"
  | "ended"
  | "error";

export type VoiceCallState = {
  readonly phase: VoiceCallPhase;
  readonly muted: boolean;
  /** What the caller last said, as transcribed. */
  readonly heard: string | null;
  /** What the coordinator last said aloud. */
  readonly spoken: string | null;
  /** A recoverable problem shown under the call controls; the call keeps going. */
  readonly notice: string | null;
  /** Set when phase is "error": the call could not continue. */
  readonly error: string | null;
};

export type VoiceCallMicrophone = {
  readonly sampleRate: number;
  close(): void;
};

export type VoiceCallDependencies = {
  /** Opens the microphone and streams mono frames until close(). */
  readonly openMicrophone: (onFrame: (frame: Float32Array) => void) => Promise<VoiceCallMicrophone>;
  /** On-device speech to text for a 16 kHz mono WAV. */
  readonly transcribe: (wav: Uint8Array, signal: AbortSignal) => Promise<string>;
  /** Sends the caller's words to the coordinator and resolves with its reply (markdown). */
  readonly ask: (text: string, signal: AbortSignal) => Promise<string | null>;
  /** On-device text to speech; resolves with encoded audio. */
  readonly synthesize: (text: string, signal: AbortSignal) => Promise<Uint8Array>;
  /** Plays audio; resolves when it finishes or the signal aborts. */
  readonly play: (audio: Uint8Array, signal: AbortSignal) => Promise<void>;
  readonly onStateChange: (state: VoiceCallState) => void;
  readonly onLevel?: (level: number) => void;
  readonly detector?: Partial<UtteranceDetectorOptions>;
};

const INITIAL_STATE: VoiceCallState = {
  phase: "idle",
  muted: false,
  heard: null,
  spoken: null,
  notice: null,
  error: null,
};

function isAbort(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === "AbortError") ||
    (error instanceof Error && error.name === "AbortError")
  );
}

/** Rejects with an AbortError as soon as the signal aborts, even if the work never settles. */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new DOMException("Aborted", "AbortError"));
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new DOMException("Aborted", "AbortError"));
    signal.addEventListener("abort", abort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

/** The same transcription failure this many times in a row means it will not recover. */
export const VOICE_CALL_REPEATED_FAILURE_LIMIT = 2;

/** Busy, slow or too-long recordings clear on their own; they never end a call. */
function isPassingFailure(message: string): boolean {
  return /try again|too long|getting ready/i.test(message);
}

function describe(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim().length > 0 ? error.message : fallback;
}

/**
 * One voice call: listen, transcribe on-device, ask the coordinator, read the reply aloud,
 * listen again. Speaking over the reply cuts it off (barge-in).
 */
export class VoiceCallController {
  private readonly dependencies: VoiceCallDependencies;
  private state: VoiceCallState = INITIAL_STATE;
  private microphone: VoiceCallMicrophone | null = null;
  private detector: UtteranceDetector | null = null;
  private callAbort: AbortController | null = null;
  private playbackAbort: AbortController | null = null;
  /** The newest utterance owns the call's phase; an older turn that outlives it stays quiet. */
  private turn = 0;
  /** The last transcription failure and how many times in a row it happened. */
  private transcribeFailure: { message: string; count: number } | null = null;

  constructor(dependencies: VoiceCallDependencies) {
    this.dependencies = dependencies;
  }

  getState(): VoiceCallState {
    return this.state;
  }

  get active(): boolean {
    return this.callAbort !== null;
  }

  async start(): Promise<void> {
    if (this.callAbort) return;
    const callAbort = new AbortController();
    this.callAbort = callAbort;
    this.setState({ ...INITIAL_STATE, phase: "connecting" });
    try {
      const microphone = await this.dependencies.openMicrophone((frame) => this.onFrame(frame));
      if (callAbort.signal.aborted) {
        microphone.close();
        return;
      }
      this.microphone = microphone;
      this.detector = new UtteranceDetector(microphone.sampleRate, this.dependencies.detector);
      this.setState({ phase: "listening" });
    } catch (error) {
      if (callAbort.signal.aborted) return;
      this.teardown();
      this.setState({ phase: "error", error: describe(error, "Could not open the microphone.") });
    }
  }

  end(): void {
    if (!this.callAbort) return;
    this.teardown();
    this.setState({ phase: "ended", notice: null });
  }

  setMuted(muted: boolean): void {
    if (muted === this.state.muted) return;
    if (muted) this.detector?.reset();
    this.setState({ muted });
  }

  /** Stops the reply being read aloud and goes back to listening. */
  interrupt(): void {
    if (this.state.phase !== "speaking") return;
    this.playbackAbort?.abort();
  }

  private teardown(): void {
    this.transcribeFailure = null;
    this.callAbort?.abort();
    this.callAbort = null;
    this.playbackAbort?.abort();
    this.playbackAbort = null;
    this.microphone?.close();
    this.microphone = null;
    this.detector = null;
    this.dependencies.onLevel?.(0);
  }

  private setState(patch: Partial<VoiceCallState>): void {
    this.state = { ...this.state, ...patch };
    this.dependencies.onStateChange(this.state);
  }

  private onFrame(frame: Float32Array): void {
    const detector = this.detector;
    if (!detector || !this.callAbort) return;
    if (this.state.muted) {
      this.dependencies.onLevel?.(0);
      return;
    }
    this.dependencies.onLevel?.(rootMeanSquare(frame));
    const phase = this.state.phase;
    if (phase !== "listening" && phase !== "speaking") return;
    for (const event of detector.push(frame)) {
      if (event.type === "speech-start") {
        if (this.state.phase === "speaking") this.playbackAbort?.abort();
        continue;
      }
      void this.handleUtterance(event.samples, event.sampleRate);
    }
  }

  private async handleUtterance(samples: Float32Array, sampleRate: number): Promise<void> {
    const callAbort = this.callAbort;
    if (!callAbort) return;
    const signal = callAbort.signal;
    const turn = ++this.turn;
    const superseded = () => signal.aborted || this.turn !== turn;
    this.setState({ phase: "transcribing", notice: null });

    let heard: string;
    try {
      const wav = encodeWavPcm16(
        resampleLinear(samples, sampleRate, VOICE_CALL_SAMPLE_RATE),
        VOICE_CALL_SAMPLE_RATE,
      );
      heard = (await this.dependencies.transcribe(wav, signal)).trim();
    } catch (error) {
      if (superseded() || isAbort(error)) return;
      const message = describe(error, "Could not understand that. Try again.");
      const count =
        this.transcribeFailure?.message === message ? this.transcribeFailure.count + 1 : 1;
      this.transcribeFailure = { message, count };
      if (count >= VOICE_CALL_REPEATED_FAILURE_LIMIT && !isPassingFailure(message)) {
        // A setting or a missing speech model fails every utterance the same
        // way; end the call with the reason instead of listening forever.
        this.teardown();
        this.setState({ phase: "error", error: message, notice: null });
        return;
      }
      this.resumeListening(message);
      return;
    }
    this.transcribeFailure = null;
    if (superseded()) return;
    if (heard.length === 0) {
      this.resumeListening(null);
      return;
    }

    this.setState({ phase: "thinking", heard });
    let reply: string | null;
    try {
      reply = await this.dependencies.ask(heard, signal);
    } catch (error) {
      if (superseded() || isAbort(error)) return;
      this.resumeListening(describe(error, "The coordinator did not answer."));
      return;
    }
    if (superseded()) return;

    const spoken = speakableText(reply ?? "");
    if (spoken.length === 0) {
      this.resumeListening(null);
      return;
    }

    const playbackAbort = new AbortController();
    this.playbackAbort = playbackAbort;
    const stop = () => playbackAbort.abort();
    signal.addEventListener("abort", stop, { once: true });
    this.detector?.reset();
    this.setState({ phase: "speaking", spoken });
    try {
      // Stop and barge-in cut a reply off while its audio is still being made, too.
      const audio = await untilAborted(
        this.dependencies.synthesize(spoken, playbackAbort.signal),
        playbackAbort.signal,
      );
      if (!playbackAbort.signal.aborted && !superseded()) {
        await this.dependencies.play(audio, playbackAbort.signal);
      }
    } catch (error) {
      if (superseded()) return;
      if (!playbackAbort.signal.aborted && !isAbort(error)) {
        this.resumeListening(describe(error, "Could not read the reply aloud. It is in the chat."));
        return;
      }
    } finally {
      signal.removeEventListener("abort", stop);
      if (this.playbackAbort === playbackAbort) this.playbackAbort = null;
    }
    // After a barge-in the caller's next utterance has its own turn and phase.
    if (superseded()) return;
    this.setState({ phase: "listening" });
  }

  private resumeListening(notice: string | null): void {
    this.detector?.reset();
    this.setState({ phase: "listening", notice });
  }
}
