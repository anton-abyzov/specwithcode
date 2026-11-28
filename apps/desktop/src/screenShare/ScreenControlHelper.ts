// @effect-diagnostics globalTimers:off -- The helper's start and release waits are plain timers at the native boundary.
// @effect-diagnostics nodeBuiltinImport:off -- The input helper runs as a child process of the app.
/**
 * Starts and talks to the input helper (`native/screen-control/main.swift`,
 * 1519) for one control session: commands down its stdin, replies up its
 * stdout, nothing else. It is started as an ordinary child of the app, so
 * macOS charges its events to the app's Accessibility grant.
 */
import * as NodeChildProcess from "node:child_process";

import type { ScreenShareTypingBlock } from "@specweave-studio/contracts";

import {
  CONTROL_BROWSER_BUNDLE_IDS,
  parseHelperLine,
  type HelperEvent,
  type ScreenControlLink,
  type ScreenControlStart,
} from "./screenControl.logic.ts";

export const SCREEN_CONTROL_HELPER_NAME = "studio-screen-control";
/** How long the helper may take to say it is ready. */
const READY_MS = 3_000;
/** How long a release may take before the app goes on without the helper's word. */
const RELEASE_MS = 500;
/** After stdin closes, how long before the helper is killed. */
const EXIT_MS = 1_000;

const BLOCKS: ReadonlySet<string> = new Set(["secure_input", "system_prompt", "browser", "locked"]);

type Spawn = (path: string) => NodeChildProcess.ChildProcessWithoutNullStreams;

const defaultSpawn: Spawn = (path) =>
  NodeChildProcess.spawn(path, [], { stdio: ["pipe", "pipe", "pipe"], env: {} });

export function startScreenControlHelper(input: {
  readonly path: string;
  readonly onBlocked: (blocked: ScreenShareTypingBlock | null) => void;
  /** The helper went away without `stop`. */
  readonly onExit: () => void;
  readonly spawn?: Spawn;
  /** Off for the helper that itself lets go of an earlier one's keys. */
  readonly rescue?: boolean;
}): Promise<ScreenControlStart> {
  return new Promise((resolve) => {
    let child: NodeChildProcess.ChildProcessWithoutNullStreams;
    try {
      child = (input.spawn ?? defaultSpawn)(input.path);
    } catch {
      return resolve({ kind: "unavailable" });
    }
    let started = false;
    let stopped = false;
    let buffered = "";
    let releaseWaiters: Array<() => void> = [];
    // Each release the helper has not answered yet, oldest first. It answers each one
    // once and in order, so a reply settles only the oldest; a release that timed out
    // stays here until its reply comes.
    const unanswered: Array<{
      readonly keys: ReadonlyArray<string>;
      readonly buttons: ReadonlyArray<string>;
      readonly settle: () => void;
    }> = [];
    const write = (command: unknown) => {
      if (stopped || child.stdin.destroyed) return;
      try {
        child.stdin.write(`${JSON.stringify(command)}\n`);
      } catch {
        // A helper that went away is reported by its exit.
      }
    };
    const stop = () => {
      if (stopped) return;
      stopped = true;
      for (const waiter of releaseWaiters) waiter();
      releaseWaiters = [];
      child.stdin.end();
      // Then SIGTERM, then SIGKILL: a helper never outlives its session by more than two seconds.
      const term = setTimeout(() => child.kill("SIGTERM"), EXIT_MS);
      const kill = setTimeout(() => child.kill("SIGKILL"), EXIT_MS * 2);
      child.once("exit", () => {
        clearTimeout(term);
        clearTimeout(kill);
      });
    };
    const readyTimer = setTimeout(() => {
      if (started) return;
      stop();
      resolve({ kind: "unavailable" });
    }, READY_MS);
    const link: ScreenControlLink = {
      post: (events: ReadonlyArray<HelperEvent>) => {
        if (events.length > 0) write({ t: "input", events });
      },
      release: (held) =>
        new Promise<void>((done) => {
          if (stopped) return done();
          const timer = setTimeout(finish, RELEASE_MS);
          function finish() {
            clearTimeout(timer);
            releaseWaiters = releaseWaiters.filter((waiter) => waiter !== finish);
            done();
          }
          releaseWaiters.push(finish);
          unanswered.push({ keys: held.keys, buttons: held.buttons, settle: finish });
          write({ t: "release", keys: held.keys, buttons: held.buttons });
        }),
      stop,
    };
    child.stderr.resume();
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffered += chunk;
      if (buffered.length > 64 * 1024) buffered = buffered.slice(-64 * 1024);
      let newline = buffered.indexOf("\n");
      while (newline >= 0) {
        const message = parseHelperLine(buffered.slice(0, newline));
        buffered = buffered.slice(newline + 1);
        newline = buffered.indexOf("\n");
        if (message === null) continue;
        if (message.t === "ready" && !started) {
          started = true;
          clearTimeout(readyTimer);
          if (!message.trusted) {
            stop();
            resolve({ kind: "no_permission" });
            continue;
          }
          write({ t: "config", browsers: CONTROL_BROWSER_BUNDLE_IDS });
          resolve({ kind: "ok", link });
        } else if (message.t === "gate" && started && !stopped) {
          input.onBlocked(
            message.blocked !== null && BLOCKS.has(message.blocked)
              ? (message.blocked as ScreenShareTypingBlock)
              : null,
          );
        } else if (message.t === "released") {
          unanswered.shift()?.settle();
        }
      }
    });
    child.once("error", () => {
      clearTimeout(readyTimer);
      if (!started) resolve({ kind: "unavailable" });
    });
    child.once("exit", () => {
      clearTimeout(readyTimer);
      const unexpected = !stopped;
      // Gone, stopped or not, before it answered a release: the session no longer holds
      // those keys, so a fresh helper lets go of them. What the session still holds it
      // lets go of itself.
      if (started && (input.rescue ?? true) && unanswered.length > 0) {
        const keys = new Set(unanswered.flatMap((entry) => entry.keys));
        const buttons = new Set(unanswered.flatMap((entry) => entry.buttons));
        void releaseWithFreshHelper(
          input.path,
          { keys: [...keys], buttons: [...buttons] },
          input.spawn,
        ).catch(() => undefined);
      }
      unanswered.length = 0;
      stopped = true;
      for (const waiter of releaseWaiters) waiter();
      releaseWaiters = [];
      if (!started) return resolve({ kind: "unavailable" });
      if (unexpected) input.onExit();
    });
  });
}

/**
 * Lets go of keys and buttons a helper pressed and did not let go of, because
 * it went away: a fresh helper starts, releases them, and exits.
 */
export async function releaseWithFreshHelper(
  path: string,
  held: { readonly keys: ReadonlyArray<string>; readonly buttons: ReadonlyArray<string> },
  spawn?: Spawn,
): Promise<void> {
  if (held.keys.length === 0 && held.buttons.length === 0) return;
  const started = await startScreenControlHelper({
    path,
    onBlocked: () => {},
    onExit: () => {},
    rescue: false,
    ...(spawn === undefined ? {} : { spawn }),
  });
  if (started.kind !== "ok") return;
  await started.link.release(held);
  started.link.stop();
}
