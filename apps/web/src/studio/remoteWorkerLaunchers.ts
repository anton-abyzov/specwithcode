/**
 * The coordinator machine of each remote worker thread, as the views that
 * already read remote workers (the sidebar, Overview) last saw it. Alerts read
 * it here at delivery time, so they pick the same owner machine as those views
 * without keeping a remote worker poll of their own alive.
 *
 * @module remoteWorkerLaunchers
 */
import {
  remoteWorkerLaunchers,
  type AttentionMember,
} from "@specweave-studio/client-runtime/state/projectAttention";
import { useEffect, useMemo } from "react";

interface Published {
  readonly map: ReadonlyMap<string, string>;
  readonly complete: boolean;
}

// Insertion order is publish order: a source keeps its place when it publishes again.
const sources = new Map<string, Published>();
const settleWaiters = new Set<() => void>();
let union: ReadonlyMap<string, string> | null = null;

const anyComplete = () => [...sources.values()].some((source) => source.complete);

/** Replaces what one view knows; `complete` once every remote worker reading it needs is in. */
export function publishRemoteWorkerLaunchers(
  sourceId: string,
  map: ReadonlyMap<string, string>,
  complete: boolean,
): void {
  sources.set(sourceId, { map, complete });
  union = null;
  if (complete) for (const wake of [...settleWaiters]) wake();
}

/** Drops what one view published, when it goes away. */
export function withdrawRemoteWorkerLaunchers(sourceId: string): void {
  if (sources.delete(sourceId)) union = null;
}

/**
 * Every published source together. A worker two sources name differently keeps
 * the coordinator of the source that published first.
 */
export function currentRemoteWorkerLaunchers(): ReadonlyMap<string, string> {
  if (union !== null) return union;
  const next = new Map<string, string>();
  for (const source of sources.values())
    for (const [worker, coordinator] of source.map)
      if (!next.has(worker)) next.set(worker, coordinator);
  union = next;
  return next;
}

/**
 * Resolves once some source has every reading it needs, or after `timeoutMs`
 * when none does (also when nothing is published at all). Never rejects.
 */
export function remoteWorkerLaunchersSettled(timeoutMs: number): Promise<void> {
  if (anyComplete()) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer);
      settleWaiters.delete(done);
      resolve();
    };
    const timer = setTimeout(done, timeoutMs);
    settleWaiters.add(done);
  });
}

/** Publishes the launchers of these members for as long as the calling view is mounted. */
export function usePublishRemoteWorkerLaunchers(
  sourceId: string,
  members: readonly AttentionMember[],
): void {
  const map = useMemo(() => remoteWorkerLaunchers(members), [members]);
  // A member reads false until its remote worker reading is in; a member
  // without remote workers to read has nothing pending.
  const complete = members.every((member) => member.remoteWorkersComplete !== false);
  useEffect(() => {
    publishRemoteWorkerLaunchers(sourceId, map, complete);
  }, [sourceId, map, complete]);
  useEffect(() => () => withdrawRemoteWorkerLaunchers(sourceId), [sourceId]);
}

export function __resetRemoteWorkerLaunchersForTests(): void {
  sources.clear();
  union = null;
  for (const wake of [...settleWaiters]) wake();
}
