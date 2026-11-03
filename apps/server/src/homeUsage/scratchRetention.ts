/**
 * Retention for `<identity>/scratch`: the service deletes folders there that
 * nothing uses and nothing changed in for `scratchAfterDays`, copying
 * nothing. The decision is `decideScratchPrune`, the same one
 * `specweave-studio scratch prune` makes; ages come from the home folder walk
 * (off the event loop), live paths from the running processes' working
 * folders, and every candidate must also pass the orphan-worktree sweep's
 * ownership check (any thread, deleted ones included, session, terminal or
 * project). Right before removal the folder's age, the process folders and
 * its owners are read again; any change keeps it.
 *
 * @module homeUsage/scratchRetention
 */
import * as Effect from "effect/Effect";

import {
  DAY_MS,
  decideScratchPrune,
  type ScratchDecision,
  type ScratchEntry,
  type ScratchLivePath,
} from "../scratchPrune.ts";
import type { WalkChild } from "./walkTree.ts";

export interface ScratchRemoval {
  readonly name: string;
  readonly path: string;
  readonly bytes: number;
}

/** Spellings to match live paths against: the real path first. */
const spellings = (
  roots: ReadonlyArray<string>,
  name: string,
  join: (a: string, b: string) => string,
) =>
  roots.map((root) => join(root, name)).filter((value, index, all) => all.indexOf(value) === index);

/** Decides every measured child of the scratch folder. */
export function decideScratchRetention(input: {
  /** The scratch folder's real path first, then any other spelling. */
  readonly scratchRoots: ReadonlyArray<string>;
  readonly children: ReadonlyArray<WalkChild>;
  /** Working folders of running processes. */
  readonly processCwds: ReadonlyArray<string>;
  readonly afterDays: number;
  readonly now: number;
  readonly foldCase: boolean;
  readonly join: (left: string, right: string) => string;
}): ReadonlyArray<ScratchDecision> {
  const entries = input.children.map((child): ScratchEntry => ({
    name: child.name,
    paths: spellings(input.scratchRoots, child.name, input.join),
    kind: child.kind,
    age:
      child.newestMs === null
        ? { known: false, reason: "not fully measured" }
        : { known: true, newestMs: child.newestMs, entries: 0 },
  }));
  const livePaths: ReadonlyArray<ScratchLivePath> = input.processCwds.map((cwd) => ({
    paths: [cwd],
    owner: "a running process",
  }));
  return decideScratchPrune({
    scratchRoots: input.scratchRoots,
    entries,
    livePaths,
    now: input.now,
    olderThanMs: input.afterDays * DAY_MS,
    foldCase: input.foldCase,
  });
}

/**
 * Removes the scratch folders `children` (from the home walk) allows, after
 * every recheck. `measureChildren` measures the named children again (in the
 * worker); `isOwned` is the orphan sweep's ownership check; `remove` deletes
 * one folder. Unknown process folders remove nothing.
 */
export const runScratchRetention = Effect.fn("ScratchRetention.run")(function* <E1, E2, E3>(input: {
  readonly scratchRoots: ReadonlyArray<string>;
  readonly children: ReadonlyArray<WalkChild>;
  readonly afterDays: number | null;
  readonly now: Effect.Effect<number>;
  readonly foldCase: boolean;
  readonly join: (left: string, right: string) => string;
  readonly processCwds: Effect.Effect<ReadonlyArray<string> | null>;
  readonly measureChildren: (
    names: ReadonlyArray<string>,
  ) => Effect.Effect<ReadonlyArray<WalkChild>, E1>;
  readonly isOwned: (path: string) => Effect.Effect<boolean, E2>;
  readonly remove: (path: string) => Effect.Effect<void, E3>;
}) {
  const removed: Array<ScratchRemoval> = [];
  if (input.afterDays === null || input.scratchRoots.length === 0) return removed;
  const afterDays = input.afterDays;
  const decide = (children: ReadonlyArray<WalkChild>, cwds: ReadonlyArray<string>, now: number) =>
    decideScratchRetention({
      scratchRoots: input.scratchRoots,
      children,
      processCwds: cwds,
      afterDays,
      now,
      foldCase: input.foldCase,
      join: input.join,
    });
  const firstCwds = yield* input.processCwds;
  if (firstCwds === null) {
    yield* Effect.logDebug("scratch retention skipped: running processes' folders are unknown");
    return removed;
  }
  const candidates: Array<ScratchDecision> = [];
  for (const decision of decide(input.children, firstCwds, yield* input.now)) {
    if (decision.action !== "remove") continue;
    if (yield* input.isOwned(decision.path)) continue;
    candidates.push(decision);
  }
  if (candidates.length === 0) return removed;
  // The walk may be hours old: measure the candidates and read processes again.
  const fresh = yield* input.measureChildren(candidates.map((decision) => decision.name));
  const cwds = yield* input.processCwds;
  if (cwds === null) return removed;
  const now = yield* input.now;
  const byName = new Map(fresh.map((child) => [child.name, child]));
  for (const candidate of candidates) {
    const child = byName.get(candidate.name);
    if (child === undefined) continue;
    const [recheck] = decide([child], cwds, now);
    if (recheck === undefined || recheck.action !== "remove") {
      yield* Effect.logDebug("scratch retention kept a folder that changed", {
        path: candidate.path,
        reason: recheck?.reason ?? "gone",
      });
      continue;
    }
    // Owners last, right before removal.
    if (yield* input.isOwned(recheck.path)) continue;
    yield* input.remove(recheck.path);
    removed.push({ name: child.name, path: recheck.path, bytes: child.bytes });
    yield* Effect.logInfo("storage cleanup removed an old scratch folder", {
      path: recheck.path,
      bytes: child.bytes,
      reason: recheck.reason,
    });
  }
  return removed;
});
