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

const sources = new Map<string, ReadonlyMap<string, string>>();
let union: ReadonlyMap<string, string> | null = null;

/** Replaces what one view knows. */
export function publishRemoteWorkerLaunchers(
  sourceId: string,
  map: ReadonlyMap<string, string>,
): void {
  sources.set(sourceId, map);
  union = null;
}

/** Drops what one view published, when it goes away. */
export function withdrawRemoteWorkerLaunchers(sourceId: string): void {
  if (sources.delete(sourceId)) union = null;
}

/**
 * Every published source together. A worker two sources name differently
 * keeps the coordinator of the source whose id sorts first, so the outcome
 * does not depend on which view mounted or published first. "overview" sorts
 * before "sidebar", and Overview reads every visible project, so it is the
 * fuller of the two.
 */
export function currentRemoteWorkerLaunchers(): ReadonlyMap<string, string> {
  if (union !== null) return union;
  const next = new Map<string, string>();
  for (const [, map] of [...sources].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
    for (const [worker, coordinator] of map) if (!next.has(worker)) next.set(worker, coordinator);
  union = next;
  return next;
}

/** Publishes the launchers of these members for as long as the calling view is mounted. */
export function usePublishRemoteWorkerLaunchers(
  sourceId: string,
  members: readonly AttentionMember[],
): void {
  const map = useMemo(() => remoteWorkerLaunchers(members), [members]);
  useEffect(() => {
    publishRemoteWorkerLaunchers(sourceId, map);
  }, [sourceId, map]);
  useEffect(() => () => withdrawRemoteWorkerLaunchers(sourceId), [sourceId]);
}

export function __resetRemoteWorkerLaunchersForTests(): void {
  sources.clear();
  union = null;
}
