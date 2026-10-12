import { describe, expect, it, vi } from "vite-plus/test";

import { encodeWavPcm16, resampleLinear, UtteranceDetector } from "./audio.ts";
import {
  VoiceCallController,
  type VoiceCallDependencies,
  type VoiceCallState,
} from "./controller.ts";
import { speakableText } from "./speakableText.ts";

const RATE = 16_000;
const FRAME = 320; // 20 ms

function frame(level: number): Float32Array {
  const samples = new Float32Array(FRAME);
  for (let index = 0; index < FRAME; index += 1) samples[index] = index % 2 === 0 ? level : -level;
  return samples;
}

function feed(detector: UtteranceDetector, level: number, ms: number) {
  const events = [];
  for (let elapsed = 0; elapsed < ms; elapsed += 20) events.push(...detector.push(frame(level)));
  return events;
}

describe("encodeWavPcm16", () => {
  it("writes a 16-bit mono RIFF header and clamps samples", () => {
    const wav = encodeWavPcm16(new Float32Array([0, 1, -1, 2]), RATE);
    const view = new DataView(wav.buffer);
    expect(new TextDecoder().decode(wav.slice(0, 4))).toBe("RIFF");
    expect(new TextDecoder().decode(wav.slice(8, 12))).toBe("WAVE");
    expect(view.getUint32(24, true)).toBe(RATE);
    expect(view.getUint16(34, true)).toBe(16);
    expect(view.getUint32(40, true)).toBe(8);
    expect(view.getInt16(46, true)).toBe(0x7fff);
    expect(view.getInt16(48, true)).toBe(-0x8000);
    expect(view.getInt16(50, true)).toBe(0x7fff);
  });
});

describe("resampleLinear", () => {
  it("downsamples 48 kHz to 16 kHz", () => {
    const output = resampleLinear(new Float32Array(4_800).fill(0.5), 48_000, 16_000);
    expect(output.length).toBe(1_600);
    expect(output[10]).toBeCloseTo(0.5);
  });
});

describe("UtteranceDetector", () => {
  it("ignores silence and short clicks", () => {
    const detector = new UtteranceDetector(RATE);
    expect(feed(detector, 0.001, 1_000)).toEqual([]);
    expect(feed(detector, 0.2, 60)).toEqual([]);
    expect(feed(detector, 0.001, 500)).toEqual([]);
  });

  it("emits speech-start, then the utterance after trailing silence, with pre-roll", () => {
    const detector = new UtteranceDetector(RATE);
    feed(detector, 0.001, 600);
    const start = feed(detector, 0.2, 400);
    expect(start.map((event) => event.type)).toEqual(["speech-start"]);
    expect(feed(detector, 0.001, 1_000)).toEqual([]);
    const end = feed(detector, 0.001, 200);
    expect(end).toHaveLength(1);
    const utterance = end[0];
    if (utterance?.type !== "utterance") throw new Error("expected utterance");
    // 400 ms voice + 1.1 s silence + pre-roll
    expect(utterance.samples.length / RATE).toBeGreaterThan(1.5);
    expect(detector.isSpeaking).toBe(false);
  });

  it("caps an utterance at the maximum length", () => {
    const detector = new UtteranceDetector(RATE, { maxUtteranceMs: 1_000 });
    const events = feed(detector, 0.2, 1_400);
    // Speech that keeps going opens the next utterance right away.
    expect(events.map((event) => event.type)).toEqual([
      "speech-start",
      "utterance",
      "speech-start",
    ]);
  });
});

describe("speakableText", () => {
  it("drops code, tables and URLs, keeps link labels", () => {
    const text = speakableText(
      [
        "## Status",
        "The **release** shipped. See [PR 135](https://github.com/x/y/pull/135).",
        "```bash",
        "npm test",
        "```",
        "| a | b |",
        "|---|---|",
        "| 1 | 2 |",
        "- first item",
        "- `second` item",
      ].join("\n"),
    );
    expect(text).toBe(
      "Status. The release shipped. See PR 135. first item. second item. The rest is in the chat.",
    );
  });

  it("cuts long replies at a sentence boundary", () => {
    const text = speakableText("One sentence here. ".repeat(80), 100);
    expect(text.endsWith("here. The rest is in the chat.")).toBe(true);
    expect(text.length).toBeLessThan(140);
  });

  it("returns empty text for an empty reply", () => {
    expect(speakableText("   ")).toBe("");
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

function harness(overrides: Partial<VoiceCallDependencies> = {}) {
  let push: ((frame: Float32Array) => void) | null = null;
  const states: VoiceCallState[] = [];
  const close = vi.fn();
  const dependencies: VoiceCallDependencies = {
    openMicrophone: async (onFrame) => {
      push = onFrame;
      return { sampleRate: RATE, close };
    },
    transcribe: vi.fn(async () => "what is the status"),
    ask: vi.fn(async () => "Everything **shipped**."),
    synthesize: vi.fn(async () => new Uint8Array([1, 2, 3])),
    play: vi.fn(async () => undefined),
    onStateChange: (state) => states.push(state),
    ...overrides,
  };
  const controller = new VoiceCallController(dependencies);
  const speak = (level: number, ms: number) => {
    for (let elapsed = 0; elapsed < ms; elapsed += 20) push?.(frame(level));
  };
  const utterance = () => {
    speak(0.001, 400);
    speak(0.2, 400);
    speak(0.001, 1_200);
  };
  return { controller, dependencies, states, close, speak, utterance };
}

const flush = async () => {
  for (let tick = 0; tick < 20; tick += 1) await Promise.resolve();
};

describe("VoiceCallController", () => {
  it("runs one full turn: listen, transcribe, ask, speak, listen", async () => {
    const { controller, dependencies, states, utterance } = harness();
    await controller.start();
    expect(controller.getState().phase).toBe("listening");
    utterance();
    await flush();
    await flush();
    expect(dependencies.transcribe).toHaveBeenCalledOnce();
    expect(dependencies.ask).toHaveBeenCalledWith("what is the status", expect.any(AbortSignal));
    expect(dependencies.synthesize).toHaveBeenCalledWith(
      "Everything shipped.",
      expect.any(AbortSignal),
    );
    expect(states.map((state) => state.phase)).toEqual([
      "connecting",
      "listening",
      "transcribing",
      "thinking",
      "speaking",
      "listening",
    ]);
    expect(controller.getState()).toMatchObject({
      heard: "what is the status",
      spoken: "Everything shipped.",
    });
  });

  it("skips the coordinator when nothing was understood", async () => {
    const { controller, dependencies, utterance } = harness({
      transcribe: vi.fn(async () => "  "),
    });
    await controller.start();
    utterance();
    await flush();
    expect(dependencies.ask).not.toHaveBeenCalled();
    expect(controller.getState().phase).toBe("listening");
  });

  it("stops reading the reply when the caller talks over it", async () => {
    const playback = deferred<void>();
    let playSignal: AbortSignal | null = null;
    const { controller, utterance, speak } = harness({
      play: vi.fn((_audio, signal) => {
        playSignal = signal;
        signal.addEventListener("abort", () => playback.resolve());
        return playback.promise;
      }),
    });
    await controller.start();
    utterance();
    await flush();
    await flush();
    expect(controller.getState().phase).toBe("speaking");
    speak(0.2, 300);
    expect(playSignal).not.toBeNull();
    expect((playSignal as unknown as AbortSignal).aborted).toBe(true);
    await flush();
    expect(controller.getState().phase).toBe("listening");
  });

  it("lets a barge-in during synthesis own the call, with no overlapping turn", async () => {
    const synthesis = deferred<Uint8Array>();
    const secondAnswer = deferred<string>();
    const ask = vi
      .fn<VoiceCallDependencies["ask"]>()
      .mockResolvedValueOnce("First answer.")
      .mockReturnValueOnce(secondAnswer.promise);
    const { controller, dependencies, utterance } = harness({
      ask,
      synthesize: vi
        .fn<VoiceCallDependencies["synthesize"]>()
        .mockReturnValueOnce(synthesis.promise)
        .mockResolvedValue(new Uint8Array([1])),
    });
    await controller.start();
    utterance();
    await flush();
    await flush();
    expect(controller.getState().phase).toBe("speaking");
    // The caller talks over the reply while it is still being synthesized.
    utterance();
    await flush();
    expect(controller.getState().phase).toBe("thinking");
    synthesis.resolve(new Uint8Array([1]));
    await flush();
    // The first turn finishing must not put the call back to listening mid-turn.
    expect(controller.getState().phase).toBe("thinking");
    expect(dependencies.play).not.toHaveBeenCalled();
    secondAnswer.resolve("Second answer.");
    await flush();
    await flush();
    expect(dependencies.play).toHaveBeenCalledOnce();
    expect(controller.getState()).toMatchObject({ phase: "listening", spoken: "Second answer." });
  });

  it("ignores the microphone while muted", async () => {
    const { controller, dependencies, utterance } = harness();
    await controller.start();
    controller.setMuted(true);
    utterance();
    await flush();
    expect(dependencies.transcribe).not.toHaveBeenCalled();
  });

  it("keeps the call going after a transcription error", async () => {
    const { controller, utterance } = harness({
      transcribe: vi.fn(async () => {
        throw new Error("Speech model is downloading.");
      }),
    });
    await controller.start();
    utterance();
    await flush();
    expect(controller.getState()).toMatchObject({
      phase: "listening",
      notice: "Speech model is downloading.",
    });
  });

  it("ends cleanly mid-turn and closes the microphone", async () => {
    const answer = deferred<string>();
    const { controller, close, dependencies, utterance } = harness({
      ask: vi.fn(() => answer.promise),
    });
    await controller.start();
    utterance();
    await flush();
    expect(controller.getState().phase).toBe("thinking");
    controller.end();
    answer.resolve("late reply");
    await flush();
    expect(close).toHaveBeenCalledOnce();
    expect(dependencies.synthesize).not.toHaveBeenCalled();
    expect(controller.getState().phase).toBe("ended");
  });

  it("reports a microphone failure as an error", async () => {
    const { controller } = harness({
      openMicrophone: async () => {
        throw new Error("Microphone access was denied.");
      },
    });
    await controller.start();
    expect(controller.getState()).toMatchObject({
      phase: "error",
      error: "Microphone access was denied.",
    });
    expect(controller.active).toBe(false);
  });
});
