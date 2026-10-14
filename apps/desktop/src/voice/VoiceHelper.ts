// @effect-diagnostics globalTimers:off -- Request timeouts and idle exit run at child-process callback boundaries outside any Effect fiber.
// @effect-diagnostics nodeBuiltinImport:off -- This desktop-only client owns a long-lived helper process.
import type * as NodeChildProcess from "node:child_process";

/**
 * Client for the studio-voice helper (native/voice/main.swift): one JSON
 * request per line on stdin, one reply per line on stdout. The helper stays
 * up during a call so the speech model stays warm, and exits when idle.
 */
export type VoiceHelperSpawn = () => NodeChildProcess.ChildProcessWithoutNullStreams;

export type VoiceHelperReply = {
  readonly id: number;
  readonly ok: boolean;
  readonly error?: string;
  readonly text?: string;
  readonly speech?: string;
  readonly voices?: readonly { id: string; name: string; language: string; quality: number }[];
};

type Job = {
  readonly id: number;
  readonly payload: Record<string, unknown>;
  readonly timeoutMs: number;
  /** Fails a request still queued this long, e.g. behind a speech model download. */
  waitTimer: ReturnType<typeof setTimeout> | null;
  readonly resolve: (reply: VoiceHelperReply) => void;
  readonly reject: (error: Error) => void;
};

export const VOICE_HELPER_REQUEST_TIMEOUT_MS = 120_000;
export const VOICE_HELPER_IDLE_EXIT_MS = 5 * 60_000;

export class VoiceHelperError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "VoiceHelperError";
    this.code = code;
  }
}

const HELPER_MESSAGES: Record<string, string> = {
  "local-recognition-unavailable":
    "On-device recognition is unavailable for this language on this Mac. Choose a supported system language or type your message.",
  "unsupported-locale": "Speech recognition does not support this language on this Mac.",
  "speech-not-authorized":
    "Speech recognition is turned off for SpecWithCode in System Settings › Privacy & Security.",
};

/**
 * The helper answers one request at a time, so requests queue here. A request
 * gets its timeout once while queued and again once sent, so a long model
 * download fails the waiting request without stopping the helper. A sent
 * request that times out stops the stuck helper and fails alone; the queue
 * carries on with a fresh one.
 */
export class VoiceHelper {
  private readonly spawn: VoiceHelperSpawn;
  private readonly idleExitMs: number;
  private readonly timeoutMs: number;
  private child: NodeChildProcess.ChildProcessWithoutNullStreams | null = null;
  private buffer = "";
  private nextId = 1;
  private readonly queue: Job[] = [];
  private current: { readonly job: Job; readonly timer: ReturnType<typeof setTimeout> } | null =
    null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    spawn: VoiceHelperSpawn,
    options: { readonly idleExitMs?: number; readonly timeoutMs?: number } = {},
  ) {
    this.spawn = spawn;
    this.idleExitMs = options.idleExitMs ?? VOICE_HELPER_IDLE_EXIT_MS;
    this.timeoutMs = options.timeoutMs ?? VOICE_HELPER_REQUEST_TIMEOUT_MS;
  }

  request(
    payload: Record<string, unknown>,
    options: { readonly timeoutMs?: number } = {},
  ): Promise<VoiceHelperReply> {
    this.clearIdleTimer();
    return new Promise<VoiceHelperReply>((resolve, reject) => {
      const timeoutMs = options.timeoutMs ?? this.timeoutMs;
      const job: Job = {
        id: this.nextId++,
        payload,
        timeoutMs,
        waitTimer: null,
        resolve: (reply) => {
          if (reply.ok) resolve(reply);
          else {
            const code = reply.error ?? "failed";
            reject(
              new VoiceHelperError(
                code,
                HELPER_MESSAGES[code] ?? `On-device speech failed: ${code}`,
              ),
            );
          }
        },
        reject,
      };
      job.waitTimer = setTimeout(() => {
        const index = this.queue.indexOf(job);
        if (index < 0) return;
        this.queue.splice(index, 1);
        reject(
          new VoiceHelperError(
            "busy",
            "On-device speech is still getting ready. Try again shortly.",
          ),
        );
      }, timeoutMs);
      this.queue.push(job);
      this.pump();
    });
  }

  stop(): void {
    this.clearIdleTimer();
    const stopped = new VoiceHelperError("stopped", "On-device speech stopped.");
    const current = this.current;
    this.current = null;
    if (current) {
      clearTimeout(current.timer);
      current.job.reject(stopped);
    }
    for (const job of this.queue.splice(0)) {
      if (job.waitTimer) clearTimeout(job.waitTimer);
      job.reject(stopped);
    }
    this.killChild();
  }

  private pump(): void {
    if (this.current) return;
    const job = this.queue.shift();
    if (!job) {
      this.armIdleTimer();
      return;
    }
    if (job.waitTimer) clearTimeout(job.waitTimer);
    job.waitTimer = null;
    const child = this.ensureChild();
    const timer = setTimeout(() => {
      if (this.current?.job !== job) return;
      this.current = null;
      job.reject(new VoiceHelperError("timeout", "On-device speech took too long."));
      // The helper is stuck on this request; start the rest on a fresh one.
      this.killChild();
      this.pump();
    }, job.timeoutMs);
    this.current = { job, timer };
    child.stdin.write(`${JSON.stringify({ ...job.payload, id: job.id })}\n`);
  }

  private killChild(): void {
    const child = this.child;
    this.child = null;
    this.buffer = "";
    if (child && child.exitCode === null) child.kill();
  }

  private ensureChild(): NodeChildProcess.ChildProcessWithoutNullStreams {
    if (this.child && this.child.exitCode === null) return this.child;
    const child = this.spawn();
    this.child = child;
    this.buffer = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (this.child === child) this.onData(chunk);
    });
    child.stderr.resume();
    const onGone = () => {
      if (this.child !== child) return;
      this.child = null;
      const current = this.current;
      this.current = null;
      if (current) {
        clearTimeout(current.timer);
        current.job.reject(
          new VoiceHelperError("exited", "On-device speech stopped unexpectedly."),
        );
      }
      this.pump();
    };
    child.on("exit", onGone);
    child.on("error", onGone);
    child.stdin.on("error", () => undefined);
    return child;
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let newline = this.buffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      newline = this.buffer.indexOf("\n");
      if (line.length === 0) continue;
      let reply: VoiceHelperReply;
      try {
        reply = JSON.parse(line) as VoiceHelperReply;
      } catch {
        continue;
      }
      const current = this.current;
      if (!current || current.job.id !== reply.id) continue;
      this.current = null;
      clearTimeout(current.timer);
      current.job.resolve(reply);
      this.pump();
    }
  }

  private armIdleTimer(): void {
    this.clearIdleTimer();
    this.idleTimer = setTimeout(() => this.stop(), this.idleExitMs);
    this.idleTimer.unref?.();
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }
}
