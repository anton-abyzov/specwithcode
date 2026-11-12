// @effect-diagnostics nodeBuiltinImport:off -- These tests use a real temporary voice folder.
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeStream from "node:stream";

import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  helperFailure,
  LinuxSpeech,
  linuxSpeechAssets,
  LinuxSpeechError,
  type RunCommand,
  whisperAudioContext,
  whisperLanguage,
} from "./linuxSpeech.ts";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFS>();
  return { ...actual, createWriteStream: vi.fn(actual.createWriteStream) };
});

let dir: string;
let whisperPath: string;

beforeEach(async () => {
  dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "linux-speech-"));
  whisperPath = NodePath.join(dir, "whisper-cli");
  await NodeFSP.writeFile(whisperPath, "");
});
afterEach(async () => {
  await NodeFSP.rm(dir, { recursive: true, force: true });
});

const voiceDir = () => NodePath.join(dir, "voice");

/** A real asset list has real hashes, so serve bytes only through a matching stub. */
function fetchFailingAll() {
  return vi.fn(async () => new Response("nope", { status: 503 }));
}

async function placeAllAssets() {
  await NodeFSP.mkdir(NodePath.join(voiceDir(), "piper"), { recursive: true });
  await NodeFSP.writeFile(NodePath.join(voiceDir(), "piper", "piper"), "");
  for (const asset of linuxSpeechAssets("x64")) {
    if (asset.extractTo) continue;
    const handle = await NodeFSP.open(NodePath.join(voiceDir(), asset.file), "w");
    await handle.truncate(asset.bytes);
    await handle.close();
  }
}

function engine(overrides: Partial<ConstructorParameters<typeof LinuxSpeech>[0]> = {}) {
  return new LinuxSpeech({
    voiceDir: voiceDir(),
    whisperPath,
    arch: "x64",
    threads: 4,
    freeBytes: async () => Number.MAX_SAFE_INTEGER,
    ...overrides,
  });
}

describe("assets", () => {
  it("pins every download to an immutable location and a hash", () => {
    for (const arch of ["x64", "arm64"]) {
      for (const asset of linuxSpeechAssets(arch)) {
        expect(asset.sha256).toMatch(/^[0-9a-f]{64}$/);
        expect(asset.url).toMatch(/\/(resolve\/[0-9a-f]{40}|releases\/download\/2023\.11\.14-2)\//);
      }
    }
  });

  it("reports what is left to download", async () => {
    const total = linuxSpeechAssets("x64").reduce((sum, asset) => sum + asset.bytes, 0);
    expect(await engine().missingBytes()).toBe(total);
    await placeAllAssets();
    expect(await engine().missingBytes()).toBe(0);
  });

  it("makes no network call once everything is present", async () => {
    await placeAllAssets();
    const doFetch = fetchFailingAll();
    const run: RunCommand = vi.fn(async () => " hello\n");
    const text = await engine({ fetch: doFetch as never, run }).transcribe("/a.wav", "");
    expect(text).toBe("hello");
    expect(doFetch).not.toHaveBeenCalled();
  });

  it("discards a download whose hash does not match and leaves nothing behind", async () => {
    const speech = engine({
      fetch: (async () => new Response(new Uint8Array([1, 2, 3]))) as never,
    });
    await expect(speech.prepare()).rejects.toThrow(/checksum/);
    expect(await NodeFSP.readdir(voiceDir())).toEqual([]);
  });

  it("keeps earlier good files and retries only what is missing", async () => {
    await placeAllAssets();
    const model = linuxSpeechAssets("x64")[0]!;
    await NodeFSP.rm(NodePath.join(voiceDir(), model.file));
    expect(await engine().missingBytes()).toBe(model.bytes);
  });

  it("reports a failed request without leaving a partial file", async () => {
    await expect(engine({ fetch: fetchFailingAll() as never }).prepare()).rejects.toThrow(
      /HTTP 503/,
    );
    expect(await NodeFSP.readdir(voiceDir())).toEqual([]);
  });

  it.skipIf(process.getuid?.() === 0)(
    "fails instead of hanging when writing fails",
    async () => {
      const writeStream = vi.mocked(NodeFS.createWriteStream);
      writeStream.mockClear();
      writeStream.mockImplementationOnce(
        () =>
          new NodeStream.Writable({
            write(_chunk, _encoding, callback) {
              callback(Object.assign(new Error("No space left on device"), { code: "ENOSPC" }));
            },
          }) as NodeFS.WriteStream,
      );
      const fetch = vi.fn(async () => new Response("speech file"));
      const speech = engine({ fetch: fetch as never });
      try {
        await expect(speech.prepare()).rejects.toThrow(/Could not download/);
        expect(writeStream).toHaveBeenCalledTimes(1);
        expect(await NodeFSP.readdir(voiceDir())).toEqual([]);
        // The retry runs a fresh download and reaches checksum validation.
        await expect(speech.prepare()).rejects.toThrow(/checksum/);
        expect(fetch).toHaveBeenCalledTimes(2);
      } finally {
        writeStream.mockReset();
      }
    },
    20_000,
  );

  it("removes a partial download left by an earlier run", async () => {
    await NodeFSP.mkdir(voiceDir(), { recursive: true });
    await NodeFSP.writeFile(NodePath.join(voiceDir(), "model.bin.abc.partial"), "left");
    await expect(engine({ fetch: fetchFailingAll() as never }).prepare()).rejects.toThrow(/503/);
    expect(await NodeFSP.readdir(voiceDir())).toEqual([]);
  });

  it("stops a download that runs past the file's size", async () => {
    const model = linuxSpeechAssets("x64")[0]!;
    const chunk = new Uint8Array(1024 * 1024);
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        sent += chunk.byteLength;
        if (sent > model.bytes * 2) controller.close();
        else controller.enqueue(chunk);
      },
    });
    const speech = engine({ fetch: (async () => new Response(body)) as never });
    await expect(speech.prepare()).rejects.toThrow(/discarded/);
    expect(sent).toBeLessThanOrEqual(model.bytes + 32 * chunk.byteLength);
    expect(await NodeFSP.readdir(voiceDir())).toEqual([]);
  }, 60_000);

  it("never downloads from a phrase or a reply, only from prepare", async () => {
    const doFetch = fetchFailingAll();
    const speech = engine({ fetch: doFetch as never });
    await expect(speech.transcribe("/a.wav", "")).rejects.toThrow(/Start voice again/);
    await expect(speech.speak("Hi", "/out.wav", 0.5)).rejects.toThrow(/Start voice again/);
    expect(doFetch).not.toHaveBeenCalled();
  });

  it("refuses when the disk lacks room, before downloading", async () => {
    const doFetch = fetchFailingAll();
    const speech = engine({ fetch: doFetch as never, freeBytes: async () => 1024 });
    await expect(speech.prepare()).rejects.toThrow(/free disk space/);
    expect(doFetch).not.toHaveBeenCalled();
  });
});

describe("support", () => {
  it("is available when the helper is bundled", async () => {
    expect(await engine({ arch: "arm64" }).unsupportedReason()).toBeNull();
  });

  it("explains a missing helper and an unsupported architecture", async () => {
    expect(
      await engine({ whisperPath: NodePath.join(dir, "none"), arch: "arm64" }).unsupportedReason(),
    ).toMatch(/not in this build/);
    expect(await engine({ arch: "riscv64" }).unsupportedReason()).toMatch(/64-bit/);
  });
});

describe("running helpers", () => {
  beforeEach(placeAllAssets);

  it("passes the vocabulary prompt and detects the language when given none", async () => {
    const run = vi.fn<RunCommand>(async () => " first line\n second line\n");
    const text = await engine({ run }).transcribe("/a.wav", "SpecWeave, Postiz.");
    expect(text).toBe("first line second line");
    const [command, args] = run.mock.calls[0]!;
    expect(command).toBe(whisperPath);
    expect(args).toEqual(expect.arrayContaining(["-l", "auto", "-t", "4", "-f", "/a.wav"]));
    expect(args.slice(args.indexOf("--prompt"))).toEqual(["--prompt", "SpecWeave, Postiz."]);
  });

  it("uses the language chosen in Settings instead of detecting it", async () => {
    const run = vi.fn<RunCommand>(async () => "");
    await engine({ run }).transcribe("/a.wav", "", { language: "ru-RU" });
    const args = run.mock.calls[0]![1];
    expect(args[args.indexOf("-l") + 1]).toBe("ru");
  });

  it("lets the speech detector hear the recording first", async () => {
    const run = vi.fn<RunCommand>(async () => "");
    await engine({ run }).transcribe("/a.wav", "");
    const args = run.mock.calls[0]![1];
    expect(args.slice(args.indexOf("--vad"), args.indexOf("--vad") + 3)).toEqual([
      "--vad",
      "--vad-model",
      NodePath.join(voiceDir(), "ggml-silero-v5.1.2.bin"),
    ]);
  });

  it("still recognizes speech when the detector could not be downloaded", async () => {
    await NodeFSP.rm(NodePath.join(voiceDir(), "ggml-silero-v5.1.2.bin"));
    const run = vi.fn<RunCommand>(async () => "hello");
    const speech = engine({ run, fetch: fetchFailingAll() as never });
    expect(await speech.missingBytes()).toBe(885_098);
    expect(await speech.isSetUp()).toBe(true);
    await expect(speech.prepare()).resolves.toBeUndefined();
    expect(await speech.transcribe("/a.wav", "")).toBe("hello");
    expect(run.mock.calls[0]![1]).not.toContain("--vad");
  });

  it("asks for the detector once, not on every call after a failed download", async () => {
    await NodeFSP.rm(NodePath.join(voiceDir(), "ggml-silero-v5.1.2.bin"));
    const speech = engine({ fetch: fetchFailingAll() as never });
    await speech.prepare();
    expect(await speech.missingBytes()).toBe(0);
    // The next start of the app offers it again.
    expect(await engine().missingBytes()).toBe(885_098);
  });

  it("is not set up while a required file is missing", async () => {
    const model = linuxSpeechAssets("x64")[0]!;
    await NodeFSP.rm(NodePath.join(voiceDir(), model.file));
    expect(await engine().isSetUp()).toBe(false);
  });

  it("omits an empty prompt", async () => {
    const run = vi.fn<RunCommand>(async () => "");
    await engine({ run }).transcribe("/a.wav", "");
    expect(run.mock.calls[0]![1]).not.toContain("--prompt");
  });

  it("runs one recognition at a time, in order, and survives a failure", async () => {
    const order: string[] = [];
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const run = vi.fn<RunCommand>(async (_command, args) => {
      const file = args[args.indexOf("-f") + 1]!;
      order.push(`start ${file}`);
      if (file === "/1.wav") await gate;
      order.push(`end ${file}`);
      if (file === "/2.wav") throw new Error("boom");
      return file;
    });
    const speech = engine({ run });
    const first = speech.transcribe("/1.wav", "");
    const second = speech.transcribe("/2.wav", "");
    const third = speech.transcribe("/3.wav", "");
    release();
    await expect(first).resolves.toBe("/1.wav");
    await expect(second).rejects.toThrow("Speech recognition failed");
    await expect(third).resolves.toBe("/3.wav");
    expect(order).toEqual([
      "start /1.wav",
      "end /1.wav",
      "start /2.wav",
      "end /2.wav",
      "start /3.wav",
      "end /3.wav",
    ]);
  });

  it("never lets a helper's command line, with the vocabulary, reach the message", async () => {
    const run = vi.fn<RunCommand>(async () => {
      throw new Error("Command failed: whisper-cli --prompt PrivateName");
    });
    const failed = await engine({ run })
      .transcribe("/a.wav", "PrivateName.")
      .catch((error: Error) => error);
    expect((failed as Error).message).toBe("Speech recognition failed. Try again.");
  });

  it("keeps why a helper failed for the log, without its command line", async () => {
    const run = vi.fn<RunCommand>(async () => {
      throw Object.assign(new Error("Command failed: whisper-cli --prompt PrivateName"), {
        code: 3,
      });
    });
    const failed = await engine({ run })
      .transcribe("/a.wav", "PrivateName.")
      .catch((error: unknown) => error);
    expect(failed).toBeInstanceOf(LinuxSpeechError);
    expect((failed as LinuxSpeechError).detail).toBe("exit 3");
  });

  it("sizes the encoder window to a short phrase and leaves a long one alone", async () => {
    const run = vi.fn<RunCommand>(async () => "");
    const speech = engine({ run });
    await speech.transcribe("/a.wav", "", { language: "en-US", seconds: 3.96 });
    await speech.transcribe("/b.wav", "", { language: "en-US", seconds: 12 });
    await speech.transcribe("/c.wav", "", { language: "en-US", seconds: 40 });
    await speech.transcribe("/d.wav", "");
    const context = (call: number) => {
      const args = run.mock.calls[call]![1];
      return args.includes("-ac") ? args[args.indexOf("-ac") + 1] : null;
    };
    expect([context(0), context(1), context(2), context(3)]).toEqual(["512", "728", null, null]);
  });

  it("does not start a recognition already cancelled", async () => {
    const run = vi.fn<RunCommand>(async () => "");
    const abort = new AbortController();
    abort.abort();
    await expect(
      engine({ run }).transcribe("/a.wav", "", { signal: abort.signal }),
    ).rejects.toBeDefined();
    expect(run).not.toHaveBeenCalled();
  });

  it("speaks through Piper on stdin at the chosen pace", async () => {
    const run = vi.fn<RunCommand>(async () => "");
    await engine({ run }).speak("Hello\n\nthere", "/out.wav", 0.52);
    const [command, args, options] = run.mock.calls[0]!;
    expect(command).toBe(NodePath.join(voiceDir(), "piper", "piper"));
    expect(args.slice(args.indexOf("--length_scale"))).toEqual(["--length_scale", "0.904"]);
    expect(options.stdin).toBe("Hello there\n");
  });
});

describe("whisperLanguage", () => {
  it("takes the bare language code and detects anything else", () => {
    expect(whisperLanguage("de-DE")).toBe("de");
    expect(whisperLanguage("pt_BR")).toBe("pt");
    expect(whisperLanguage("EN")).toBe("en");
    expect(whisperLanguage("")).toBe("auto");
    expect(whisperLanguage(undefined)).toBe("auto");
    expect(whisperLanguage("not a tag")).toBe("auto");
  });

  it("detects for `und` and for a language the model does not know", () => {
    expect(whisperLanguage("und")).toBe("auto");
    expect(whisperLanguage("xx-XX")).toBe("auto");
    expect(whisperLanguage("nb-NO")).toBe("no");
    expect(whisperLanguage("haw")).toBe("haw");
  });
});

describe("whisperAudioContext", () => {
  it("never goes below the floor, keeps a margin, and stops at the full window", () => {
    expect(whisperAudioContext(0.85)).toBe(512);
    expect(whisperAudioContext(7.68)).toBe(512);
    expect(whisperAudioContext(10)).toBe(628);
    expect(whisperAudioContext(27.44)).toBe(null);
    expect(whisperAudioContext(60)).toBe(null);
    expect(whisperAudioContext(0)).toBe(null);
    expect(whisperAudioContext(undefined)).toBe(null);
  });
});

describe("helperFailure", () => {
  it("names the failure without quoting the command", () => {
    expect(helperFailure(Object.assign(new Error("x"), { killed: true, signal: "SIGTERM" }))).toBe(
      "timeout",
    );
    expect(helperFailure(Object.assign(new Error("x"), { signal: "SIGKILL" }))).toBe(
      "signal SIGKILL",
    );
    expect(helperFailure(Object.assign(new Error("x"), { code: "ENOENT" }))).toBe("ENOENT");
    expect(helperFailure(Object.assign(new Error("x"), { name: "AbortError" }))).toBe("cancelled");
    expect(helperFailure(new Error("Command failed: whisper-cli --prompt PrivateName"))).toBe(
      "failed",
    );
  });
});
