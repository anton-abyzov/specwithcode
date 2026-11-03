// @effect-diagnostics nodeBuiltinImport:off -- Linux speech drives local helper processes and owns its asset folder.
// @effect-diagnostics globalTimers:off -- Download stall and process timeouts run at stream callback boundaries outside any Effect fiber.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeStreamPromises from "node:stream/promises";

/**
 * Free local speech for the Linux app: whisper.cpp (bundled) turns speech into
 * text and Piper reads replies aloud. A process runs per request, so nothing
 * stays in memory between phrases. The model and Piper download once, after the
 * user's consent, from pinned URLs; after that no network call is ever made.
 */
export type SpeechAsset = {
  readonly id: string;
  readonly url: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly file: string;
  /** Unpacked into this folder of the voice directory, and the archive removed. */
  readonly extractTo?: string;
};

const WHISPER_MODELS =
  "https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1";
const PIPER_VOICES =
  "https://huggingface.co/rhasspy/piper-voices/resolve/e7229f7d33a10e145e109b886d661984201ac3c4";
const PIPER_RELEASE = "https://github.com/rhasspy/piper/releases/download/2023.11.14-2";

const PIPER_ARCHIVES: Record<string, { name: string; sha256: string; bytes: number }> = {
  x64: {
    name: "piper_linux_x86_64.tar.gz",
    sha256: "a50cb45f355b7af1f6d758c1b360717877ba0a398cc8cbe6d2a7a3a26e225992",
    bytes: 26_460_462,
  },
  arm64: {
    name: "piper_linux_aarch64.tar.gz",
    sha256: "fea0fd2d87c54dbc7078d0f878289f404bd4d6eea6e7444a77835d1537ab88eb",
    bytes: 26_004_717,
  },
};

const MODEL_FILE = "ggml-small-q5_1.bin";
const VOICE_FILE = "en_US-lessac-medium.onnx";
const PIPER_FOLDER = "piper";

export function linuxSpeechAssets(arch: string): readonly SpeechAsset[] {
  const piper = PIPER_ARCHIVES[arch];
  return [
    {
      id: "model",
      url: `${WHISPER_MODELS}/${MODEL_FILE}`,
      sha256: "ae85e4a935d7a567bd102fe55afc16bb595bdb618e11b2fc7591bc08120411bb",
      bytes: 190_085_487,
      file: MODEL_FILE,
    },
    ...(piper
      ? [
          {
            id: "piper",
            url: `${PIPER_RELEASE}/${piper.name}`,
            sha256: piper.sha256,
            bytes: piper.bytes,
            file: piper.name,
            extractTo: PIPER_FOLDER,
          },
        ]
      : []),
    {
      id: "voice",
      url: `${PIPER_VOICES}/en/en_US/lessac/medium/${VOICE_FILE}`,
      sha256: "5efe09e69902187827af646e1a6e9d269dee769f9877d17b16b1b46eeaaf019f",
      bytes: 63_201_294,
      file: VOICE_FILE,
    },
    {
      id: "voice-config",
      url: `${PIPER_VOICES}/en/en_US/lessac/medium/${VOICE_FILE}.json`,
      sha256: "efe19c417bed055f2d69908248c6ba650fa135bc868b0e6abb3da181dab690a0",
      bytes: 4_885,
      file: `${VOICE_FILE}.json`,
    },
  ];
}

/** Room kept free after a download, on top of what unpacked Piper needs. */
const DISK_MARGIN_BYTES = 512 * 1024 * 1024;
const DOWNLOAD_STALL_MS = 60_000;
const TRANSCRIBE_TIMEOUT_MS = 120_000;
const SPEAK_TIMEOUT_MS = 60_000;
const NATURAL_RATE = 0.47;

export class LinuxSpeechError extends Error {
  override readonly name = "LinuxSpeechError";
}

export type RunOptions = {
  readonly cwd?: string;
  readonly stdin?: string;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
};
export type RunCommand = (
  command: string,
  args: readonly string[],
  options: RunOptions,
) => Promise<string>;

/** Runs a helper at lower priority, so speech never starves the rest of the desktop. */
export const runCommand: RunCommand = (command, args, options) =>
  new Promise((resolve, reject) => {
    const child = NodeChildProcess.execFile(
      command,
      [...args],
      {
        ...(options.cwd ? { cwd: options.cwd } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
        timeout: options.timeoutMs,
        maxBuffer: 8 * 1024 * 1024,
      },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    );
    child.stdin?.on("error", () => undefined);
    child.stdin?.end(options.stdin ?? "");
    if (child.pid !== undefined) {
      try {
        NodeOS.setPriority(child.pid, 5);
      } catch {
        // Priority is a courtesy; the process may already have exited.
      }
    }
  });

export type LinuxSpeechOptions = {
  readonly voiceDir: string;
  readonly whisperPath: string;
  readonly arch: string;
  readonly fetch?: typeof fetch;
  readonly run?: RunCommand;
  readonly threads?: number;
  readonly freeBytes?: (path: string) => Promise<number>;
};

async function statfsFreeBytes(path: string): Promise<number> {
  const stats = await NodeFSP.statfs(path);
  return Number(stats.bavail) * Number(stats.bsize);
}

async function fileSize(path: string): Promise<number | null> {
  try {
    return (await NodeFSP.stat(path)).size;
  } catch {
    return null;
  }
}

export class LinuxSpeech {
  private readonly options: LinuxSpeechOptions;
  private readonly assets: readonly SpeechAsset[];
  private readonly doFetch: typeof fetch;
  private readonly run: RunCommand;
  private readonly threads: number;
  private readonly freeBytes: (path: string) => Promise<number>;
  private preparing: Promise<void> | null = null;
  private cpuReason: Promise<string | null> | null = null;
  private downloaded = 0;
  private downloadTotal = 0;
  /** One recognition at a time keeps memory flat and text in the order it was spoken. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(options: LinuxSpeechOptions) {
    this.options = options;
    this.assets = linuxSpeechAssets(options.arch);
    this.doFetch = options.fetch ?? fetch;
    this.run = options.run ?? runCommand;
    this.threads =
      options.threads ?? Math.min(8, Math.max(1, Math.floor(NodeOS.availableParallelism() / 2)));
    this.freeBytes = options.freeBytes ?? statfsFreeBytes;
  }

  private pathOf(file: string): string {
    return NodePath.join(this.options.voiceDir, file);
  }

  private async isPresent(asset: SpeechAsset): Promise<boolean> {
    if (asset.extractTo) {
      return (await fileSize(this.pathOf(NodePath.join(asset.extractTo, "piper")))) !== null;
    }
    // Hashed when it arrived; the size catches a file truncated since.
    return (await fileSize(this.pathOf(asset.file))) === asset.bytes;
  }

  private async missingAssets(): Promise<SpeechAsset[]> {
    const present = await Promise.all(this.assets.map((asset) => this.isPresent(asset)));
    return this.assets.filter((_, index) => !present[index]);
  }

  /** What the first use still has to download, for the consent text. */
  async missingBytes(): Promise<number> {
    return (await this.missingAssets()).reduce((sum, asset) => sum + asset.bytes, 0);
  }

  /** Download progress from 0 to 100 while preparing; null otherwise. */
  progressPercent(): number | null {
    if (this.preparing === null || this.downloadTotal === 0) return null;
    return Math.min(100, Math.floor((this.downloaded / this.downloadTotal) * 100));
  }

  /** Why speech cannot run here at all, in words for the user. */
  async unsupportedReason(): Promise<string | null> {
    const arch = this.options.arch;
    if (!PIPER_ARCHIVES[arch]) {
      return "Voice needs a 64-bit Intel, AMD or ARM computer.";
    }
    if ((await fileSize(this.options.whisperPath)) === null) {
      return "Speech recognition is not in this build. Update SpecWithCode and try again.";
    }
    if (arch === "x64") {
      // Asked every half second while setup shows; the processor does not change.
      this.cpuReason ??= NodeFSP.readFile("/proc/cpuinfo", "utf8")
        .catch(() => "")
        .then((info) =>
          info && !/\bavx2\b/.test(info) ? "Speech recognition needs a processor with AVX2." : null,
        );
      return this.cpuReason;
    }
    return null;
  }

  /** Downloads whatever is missing. Concurrent callers share one run. */
  prepare(): Promise<void> {
    this.preparing ??= this.prepareMissing().finally(() => {
      this.preparing = null;
      this.downloaded = 0;
      this.downloadTotal = 0;
    });
    return this.preparing;
  }

  private async prepareMissing(): Promise<void> {
    const missing = await this.missingAssets();
    if (missing.length === 0) return;
    const { voiceDir } = this.options;
    await NodeFSP.mkdir(voiceDir, { recursive: true, mode: 0o700 });
    // Quitting mid-download leaves these behind; only this single run can own one.
    for (const entry of await NodeFSP.readdir(voiceDir)) {
      if (entry.endsWith(".partial")) {
        await NodeFSP.rm(NodePath.join(voiceDir, entry), { recursive: true, force: true });
      }
    }
    this.downloadTotal = missing.reduce((sum, asset) => sum + asset.bytes, 0);
    const available = await this.freeBytes(voiceDir);
    if (available < this.downloadTotal * 2 + DISK_MARGIN_BYTES) {
      const needed = Math.ceil((this.downloadTotal * 2 + DISK_MARGIN_BYTES) / (1024 * 1024));
      throw new LinuxSpeechError(`Voice needs ${needed} MB of free disk space to set up.`);
    }
    for (const asset of missing) {
      await this.download(asset);
      if (asset.extractTo) await this.extract(asset);
    }
  }

  private async download(asset: SpeechAsset): Promise<void> {
    const destination = this.pathOf(asset.file);
    const partial = `${destination}.${NodeCrypto.randomUUID()}.partial`;
    const abort = new AbortController();
    let stall: ReturnType<typeof setTimeout> | null = null;
    const watch = () => {
      if (stall !== null) clearTimeout(stall);
      stall = setTimeout(() => abort.abort(), DOWNLOAD_STALL_MS);
    };
    try {
      watch();
      const response = await this.doFetch(asset.url, { signal: abort.signal });
      if (!response.ok || response.body === null) {
        throw new LinuxSpeechError(`Could not download speech files (HTTP ${response.status}).`);
      }
      const hash = NodeCrypto.createHash("sha256");
      let receivedBytes = 0;
      const received = (chunk: Uint8Array) => {
        watch();
        receivedBytes += chunk.byteLength;
        if (receivedBytes > asset.bytes) {
          throw new LinuxSpeechError(
            "A downloaded speech file did not match its checksum, so it was discarded. Try again.",
          );
        }
        hash.update(chunk);
        this.downloaded += chunk.byteLength;
      };
      // pipeline rejects on a write error; a full disk must not hang setup.
      await NodeStreamPromises.pipeline(
        response.body as unknown as AsyncIterable<Uint8Array>,
        async function* (source: AsyncIterable<Uint8Array>) {
          for await (const chunk of source) {
            received(chunk);
            yield chunk;
          }
        },
        NodeFS.createWriteStream(partial, { mode: 0o600 }),
      );
      if (hash.digest("hex") !== asset.sha256) {
        throw new LinuxSpeechError(
          "A downloaded speech file did not match its checksum, so it was discarded. Try again.",
        );
      }
      await NodeFSP.rename(partial, destination);
    } catch (error) {
      if (error instanceof LinuxSpeechError) throw error;
      throw new LinuxSpeechError(
        "Could not download speech files. Check your connection and try again.",
        { cause: error },
      );
    } finally {
      if (stall !== null) clearTimeout(stall);
      await NodeFSP.rm(partial, { force: true });
    }
  }

  private async extract(asset: SpeechAsset): Promise<void> {
    const archive = this.pathOf(asset.file);
    const target = this.pathOf(asset.extractTo!);
    const staging = `${target}.${NodeCrypto.randomUUID()}.partial`;
    await NodeFSP.mkdir(staging, { recursive: true, mode: 0o700 });
    try {
      // The archive's hash was checked above; its single top folder is "piper".
      await this.run("tar", ["-xzf", archive, "-C", staging, "--no-same-owner"], {
        timeoutMs: 120_000,
      });
      await NodeFSP.rm(target, { recursive: true, force: true });
      await NodeFSP.rename(NodePath.join(staging, PIPER_FOLDER), target);
    } catch (error) {
      throw new LinuxSpeechError("Could not unpack the local voice.", { cause: error });
    } finally {
      await NodeFSP.rm(staging, { recursive: true, force: true });
      await NodeFSP.rm(archive, { force: true });
    }
  }

  /** Downloads only ever follow the consent dialog, so a file gone mid-session just stops here. */
  private async requireAssets(): Promise<void> {
    if ((await this.missingAssets()).length > 0) {
      throw new LinuxSpeechError("Speech files are missing. Start voice again to set them up.");
    }
  }

  /**
   * A helper's own error quotes its whole command line, vocabulary included, and
   * would reach the error bar, so only this fixed message leaves here.
   */
  private async runHelper(
    message: string,
    command: string,
    args: readonly string[],
    options: RunOptions,
  ): Promise<string> {
    try {
      return await this.run(command, args, options);
    } catch (cause) {
      throw new LinuxSpeechError(message, { cause });
    }
  }

  /** Transcribes a 16 kHz mono WAV; the language is detected from the speech. */
  transcribe(wavPath: string, prompt: string, signal?: AbortSignal): Promise<string> {
    const job = this.queue.then(async () => {
      signal?.throwIfAborted();
      await this.requireAssets();
      const stdout = await this.runHelper(
        "Speech recognition failed. Try again.",
        this.options.whisperPath,
        [
          "-m",
          this.pathOf(MODEL_FILE),
          "-f",
          wavPath,
          "-t",
          String(this.threads),
          "-l",
          "auto",
          "-nt",
          "-np",
          "-sns",
          ...(prompt ? ["--prompt", prompt] : []),
        ],
        { timeoutMs: TRANSCRIBE_TIMEOUT_MS, ...(signal ? { signal } : {}) },
      );
      return stdout
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .join(" ");
    });
    this.queue = job.catch(() => undefined);
    return job;
  }

  /** Writes spoken `text` to a WAV file. `rate` is the voice settings' pace, 0.35 to 0.6. */
  async speak(
    text: string,
    outputPath: string,
    rate?: number,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.requireAssets();
    const lengthScale = (NATURAL_RATE / (rate ?? NATURAL_RATE)).toFixed(3);
    const folder = this.pathOf(PIPER_FOLDER);
    await this.runHelper(
      "Could not read the reply aloud.",
      NodePath.join(folder, "piper"),
      [
        "--model",
        this.pathOf(VOICE_FILE),
        "--config",
        this.pathOf(`${VOICE_FILE}.json`),
        "--output_file",
        outputPath,
        "--length_scale",
        lengthScale,
      ],
      {
        cwd: folder,
        // Piper reads one utterance per line.
        stdin: `${text.replace(/\s+/g, " ").trim()}\n`,
        timeoutMs: SPEAK_TIMEOUT_MS,
        ...(signal ? { signal } : {}),
      },
    );
  }
}
