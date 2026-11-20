/**
 * What asks the storage sweep (storageCleanup.ts) to run, and how much of it.
 *
 * An event about one chat asks for a pass over that chat's folders only: a run
 * completing, a pull request newly merging, a chat resolved, archived or
 * deleted. A pass over every folder is left to the hourly schedule, a change
 * of the cleanup settings and the disk turning low. Before, every such event
 * ran the Git checks of every folder, back to back.
 *
 * @module storageCleanupTriggers
 */
import type { OrchestrationV2DomainEvent, ServerSettings } from "@specweave-studio/contracts";

import { anyWorktreePolicy } from "./worktreeCleanupRules.ts";

/**
 * How many merged pull requests are remembered so a later sync of the same one
 * does not ask for a sweep again. Past it the oldest are forgotten: forgetting
 * one costs at most one extra sweep.
 */
export const MERGED_PULL_REQUESTS_REMEMBERED = 10_000;

/**
 * Merged pull requests already seen, by chat and pull request. A sync rewrites
 * every link of the chat, so an old merged link would otherwise ask for a sweep
 * on each update of any other pull request the chat holds.
 */
export class MergedPullRequests {
  private readonly keys = new Set<string>();
  private readonly limit: number;
  constructor(limit = MERGED_PULL_REQUESTS_REMEMBERED) {
    this.limit = limit;
  }

  /** Records the chat's merged links; true when one of them was not seen merged before. */
  note(
    threadId: string,
    links: ReadonlyArray<{
      readonly host: string;
      readonly repository: string;
      readonly number: number;
      readonly snapshot: { readonly state: string } | null;
    }>,
  ): boolean {
    let newlyMerged = false;
    for (const link of links) {
      if (link.snapshot?.state !== "merged") continue;
      const key = `${threadId}\0${link.host}\0${link.repository}\0${link.number}`;
      if (this.keys.has(key)) continue;
      newlyMerged = true;
      this.keys.add(key);
      // A Set iterates in insertion order, so the first key is the oldest.
      if (this.keys.size > this.limit) {
        const oldest = this.keys.values().next();
        if (oldest.done !== true) this.keys.delete(oldest.value);
      }
    }
    return newlyMerged;
  }
}

/**
 * The chat whose folders an event may have finished, or null when the event
 * asks for nothing: a run completed, a pull request newly merged, a chat
 * resolved, archived or deleted, a session of a deleted chat ending.
 */
export function sweepThreadAfterEvent(
  event: OrchestrationV2DomainEvent,
  settings: ServerSettings,
  merged: MergedPullRequests,
  /** Some rule that is switched on can remove a chat's worktree. */
  rulesOn: boolean,
): string | null {
  if (event.type === "thread.deleted")
    return anyWorktreePolicy(settings, (rules) => rules.worktreeOnDelete) ? event.threadId : null;
  // A deleted chat's folder waits for its session to stop; other session
  // updates (ready, running) finish nothing.
  if (event.type === "provider-session.updated")
    return event.payload.status === "stopped" &&
      anyWorktreePolicy(settings, (rules) => rules.worktreeOnDelete)
      ? event.threadId
      : null;
  // Recorded whatever the rules say, so switching a rule on later does not
  // turn every old merge into a new one.
  const newlyMerged =
    event.type === "thread.pull-request-synced" &&
    merged.note(event.payload.id, event.payload.pullRequests ?? []);
  if (!rulesOn) return null;
  if (event.type === "thread.settled" || event.type === "thread.archived") return event.threadId;
  if (newlyMerged) return event.threadId;
  // A chat nobody resolves is finished when its run completes.
  if (
    event.type === "run.updated" &&
    event.payload.status === "completed" &&
    anyWorktreePolicy(settings, (rules) => rules.worktreeOnMerge)
  )
    return event.threadId;
  return null;
}

/** What the next sweep covers: every folder, or the folders of some chats. */
export class SweepScope {
  private all = false;
  private readonly threads = new Set<string>();

  addAll(): void {
    this.all = true;
    this.threads.clear();
  }

  addThread(threadId: string): void {
    if (!this.all) this.threads.add(threadId);
  }

  get empty(): boolean {
    return !this.all && this.threads.size === 0;
  }

  /** Hands over what was asked for and starts again: null is every folder. */
  take(): ReadonlySet<string> | null {
    const taken = this.all ? null : new Set(this.threads);
    this.all = false;
    this.threads.clear();
    return taken;
  }
}

export const LOW_DISK_BACKOFF_FIRST_MS = 2 * 60_000;
export const LOW_DISK_BACKOFF_MAX_MS = 3_600_000;

/**
 * Low disk asks for a pass over every folder. While such passes remove
 * nothing there is nothing more to free, so each empty pass doubles the wait
 * before low disk may ask again, from 2 minutes to an hour. A pass that
 * removes something, or the disk returning to ok, starts over.
 */
export class LowDiskBackoff {
  private waitMs = 0;
  private notBefore = Number.NEGATIVE_INFINITY;

  /** Whether low disk may ask for a pass at `now`. */
  allows(now: number): boolean {
    return now >= this.notBefore;
  }

  /** A pass over every folder ended at `now` having removed `removed` folders or files. */
  notePass(removed: number, now: number): void {
    if (removed > 0) return this.reset();
    this.waitMs =
      this.waitMs === 0
        ? LOW_DISK_BACKOFF_FIRST_MS
        : Math.min(this.waitMs * 2, LOW_DISK_BACKOFF_MAX_MS);
    this.notBefore = now + this.waitMs;
  }

  reset(): void {
    this.waitMs = 0;
    this.notBefore = Number.NEGATIVE_INFINITY;
  }
}
