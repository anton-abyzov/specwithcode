// @effect-diagnostics nodeBuiltinImport:off - the walk runs in a node:worker_threads worker.
/**
 * Measures the app's home folder off the event loop: `walkTreeSync` runs in a
 * short-lived worker thread, which the caller can cancel (a shared flag the
 * walk polls, then `terminate`). The event loop
 * only waits for one message.
 *
 * @module homeUsage/measure
 */
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeWorkerThreads from "node:worker_threads";

import type {
  StorageHomeUsage,
  StorageHomeUsageLevel,
  StorageHomeUsagePart,
} from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { walkTreeSync, type WalkInput, type WalkPartInput, type WalkResult } from "./walkTree.ts";

/** Measured at most this often: a full walk reads every entry once. */
export const HOME_USAGE_INTERVAL_MS = 6 * 3_600_000;
/** A walk that takes longer stops and reports what it counted. */
export const HOME_USAGE_DEADLINE_MS = 10 * 60_000;
export const HOME_USAGE_MAX_ENTRIES = 5_000_000;
/** A part that grows by at least this much, and by half, between measurements is abnormal. */
export const ABNORMAL_GROWTH_BYTES = 10e9;
export const ABNORMAL_GROWTH_RATIO = 0.5;

/** Names the app's home folder takes in a user's home (`~/.specwithcode`, legacy `~/.specweave-studio`). */
const HOME_FOLDER_NAMES = new Set([".specwithcode", ".specweave-studio"]);

export class HomeUsageMeasureError extends Schema.TaggedError<HomeUsageMeasureError>()(
  "HomeUsageMeasureError",
  { reason: Schema.String },
) {
  override get message(): string {
    return `Could not measure the app folder: ${this.reason}`;
  }
}

export interface HomeUsageLayout {
  readonly root: string;
  readonly parts: ReadonlyArray<WalkPartInput>;
  /** The scratch folder, whose children the scratch retention decides. */
  readonly scratchDir: string;
}

/**
 * What to measure for an identity home (`<home>/<identity>`): its parent when
 * that is the app's home folder, so backups and release trees beside the
 * identities count too, else the identity folder alone. Null when the root
 * would be the user's home, an ancestor of it or a file-system root: the walk
 * never reaches `~/Library` or anything else outside the app's folder.
 */
export function homeUsageLayout(input: {
  readonly baseDir: string;
  readonly stateDir: string;
  readonly worktreesDir: string;
  readonly logsDir: string;
  readonly userHome?: string;
}): HomeUsageLayout | null {
  const baseDir = NodePath.resolve(input.baseDir);
  const parent = NodePath.dirname(baseDir);
  const root = HOME_FOLDER_NAMES.has(NodePath.basename(parent)) ? parent : baseDir;
  const userHome = NodePath.resolve(input.userHome ?? NodeOS.homedir());
  const within = (outer: string, inner: string) => {
    const relative = NodePath.relative(outer, inner);
    return (
      relative === "" ||
      (relative !== ".." &&
        !relative.startsWith(`..${NodePath.sep}`) &&
        !NodePath.isAbsolute(relative))
    );
  };
  if (NodePath.dirname(root) === root || within(root, userHome)) return null;
  const inRoot = (target: string) => {
    const resolved = NodePath.resolve(target);
    return within(root, resolved) && resolved !== root ? [resolved] : [];
  };
  const stateDir = NodePath.resolve(input.stateDir);
  const scratchDir = NodePath.join(baseDir, "scratch");
  return {
    root,
    scratchDir,
    // The entry limit and deadline are shared by the whole walk, so the small
    // parts and scratch (whose ages retention needs) go first and worktrees,
    // the part that can hold millions of entries, go last before the rest.
    parts: [
      {
        key: "database",
        paths: ["statev2.sqlite", "statev2.sqlite-wal", "statev2.sqlite-shm"].flatMap((name) =>
          inRoot(NodePath.join(stateDir, name)),
        ),
      },
      { key: "logs", paths: inRoot(input.logsDir) },
      { key: "scratch", paths: inRoot(scratchDir), children: true },
      { key: "evidence", paths: inRoot(NodePath.join(baseDir, "evidence")) },
      { key: "backups", paths: root === baseDir ? [] : inRoot(NodePath.join(root, "backups")) },
      {
        key: "release",
        paths: root === baseDir ? [] : inRoot(NodePath.join(root, "release.noindex")),
      },
      { key: "worktrees", paths: inRoot(input.worktreesDir), countCheckouts: true },
    ],
  };
}

/** Sleep per 1024 entries: about 50 s over the 5 million entry limit. */
const WALK_PAUSE_MS = 10;

/** The worker: receives the walk as source, polls a shared flag for a stop. */
const workerSource = (walkSource: string) => `
"use strict";
const { parentPort, workerData } = require("node:worker_threads");
const fs = require("node:fs");
const path = require("node:path");
const walkTreeSync = (${walkSource});
const flag = new Int32Array(workerData.stop);
// A short sleep every 1024 entries keeps the walk from saturating the disk; a stop wakes it.
const pause = () => { Atomics.wait(flag, 0, 0, ${WALK_PAUSE_MS}); };
try {
  const result = walkTreeSync(workerData.input, fs, path, () => Atomics.load(flag, 0) === 1, () => Date.now(), pause);
  parentPort.postMessage({ ok: true, result });
} catch (error) {
  parentPort.postMessage({ ok: false, error: String((error && error.message) || error) });
}
`;

/**
 * Runs one walk in a worker thread. Interrupting the effect asks the walk to
 * stop and terminates the worker.
 */
export const measureTree = (input: WalkInput) =>
  Effect.callback<WalkResult, HomeUsageMeasureError>((resume) => {
    const stop = new SharedArrayBuffer(4);
    const flag = new Int32Array(stop);
    let worker: NodeWorkerThreads.Worker;
    try {
      worker = new NodeWorkerThreads.Worker(workerSource(walkTreeSync.toString()), {
        eval: true,
        workerData: { input, stop },
      });
    } catch (cause) {
      resume(Effect.fail(new HomeUsageMeasureError({ reason: String(cause) })));
      return Effect.void;
    }
    // A walk never holds up shutdown; interrupting it stops the worker anyway.
    worker.unref();
    let settled = false;
    const settle = (effect: Effect.Effect<WalkResult, HomeUsageMeasureError>) => {
      if (settled) return;
      settled = true;
      resume(effect);
    };
    worker.on(
      "message",
      (message: { ok: true; result: WalkResult } | { ok: false; error: string }) => {
        settle(
          message.ok
            ? Effect.succeed(message.result)
            : Effect.fail(new HomeUsageMeasureError({ reason: message.error })),
        );
        void worker.terminate();
      },
    );
    worker.on("error", (error) =>
      settle(Effect.fail(new HomeUsageMeasureError({ reason: String(error) }))),
    );
    worker.on("exit", (code) =>
      settle(Effect.fail(new HomeUsageMeasureError({ reason: `worker exited with ${code}` }))),
    );
    // The flag stops the walk at its next check; terminate ends the thread
    // even if it is inside a slow read (that read finishes in the kernel).
    return Effect.sync(() => {
      settled = true;
      Atomics.store(flag, 0, 1);
      Atomics.notify(flag, 0);
      void worker.terminate();
    });
  });

/** Whether a measurement is due, given when the last one was taken (null: never). */
export function homeUsageDue(lastAt: number | null, now: number): boolean {
  if (lastAt === null || !Number.isFinite(lastAt) || lastAt > now) return true;
  return now - lastAt >= HOME_USAGE_INTERVAL_MS;
}

/** Parts that grew abnormally since `previous`, with how much. */
export function abnormalGrowth(
  parts: ReadonlyArray<{ readonly key: string; readonly bytes: number }>,
  previous: StorageHomeUsage | null,
): ReadonlyMap<string, number> {
  const grown = new Map<string, number>();
  if (previous === null || !previous.complete) return grown;
  const before = new Map(previous.parts.map((part) => [part.key, part.bytes]));
  for (const part of parts) {
    const was = before.get(part.key);
    if (was === undefined) continue;
    const grew = part.bytes - was;
    if (grew >= ABNORMAL_GROWTH_BYTES && grew >= was * ABNORMAL_GROWTH_RATIO)
      grown.set(part.key, grew);
  }
  return grown;
}

/** The level for a measurement: over the warning size first, then abnormal growth. */
export function homeUsageLevel(
  totalBytes: number,
  warnAboveBytes: number | null,
  grownParts: number,
): StorageHomeUsageLevel {
  if (warnAboveBytes !== null && totalBytes > warnAboveBytes) return "large";
  return grownParts > 0 ? "growing" : "ok";
}

const wireBytes = (bytes: number) =>
  Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, Math.round(bytes)));

/** A walk as the report clients see, largest parts first. */
export function homeUsageReport(input: {
  readonly root: string;
  readonly walk: WalkResult;
  readonly warnAboveGb: number | null;
  readonly previous: StorageHomeUsage | null;
  readonly checkedAt: string;
}): StorageHomeUsage {
  const { walk } = input;
  // An incomplete walk only undercounts, so it cannot show growth that is not there.
  const grown = abnormalGrowth(walk.parts, input.previous);
  const warnAboveBytes = input.warnAboveGb === null ? null : input.warnAboveGb * 1e9;
  const parts = walk.parts
    .filter((part) => part.bytes > 0)
    .map((part): StorageHomeUsagePart => ({
      key: part.key,
      bytes: wireBytes(part.bytes),
      ...(grown.has(part.key) ? { grewBytes: wireBytes(grown.get(part.key)!) } : {}),
    }))
    .toSorted((left, right) => right.bytes - left.bytes);
  return {
    level: homeUsageLevel(walk.totalBytes, warnAboveBytes, grown.size),
    path: input.root,
    totalBytes: wireBytes(walk.totalBytes),
    warnAboveBytes: warnAboveBytes === null ? null : wireBytes(warnAboveBytes),
    parts,
    worktreeCount: walk.parts.find((part) => part.key === "worktrees")?.checkouts ?? 0,
    complete: walk.complete,
    checkedAt: input.checkedAt,
  };
}
