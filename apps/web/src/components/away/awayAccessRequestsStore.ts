/**
 * Away access requests per connected machine, shared by the app-wide watcher
 * (which loads them and raises a toast when one arrives) and the Settings >
 * Machines cards (which approve on that machine's own server).
 */
import type { AwayAccessRequestRecord, EnvironmentId } from "@specweave-studio/contracts";
import { create } from "zustand";

import { awayRpc, runAway } from "./awayRpc";

interface AccessRequestsState {
  readonly byEnvironment: ReadonlyMap<EnvironmentId, readonly AwayAccessRequestRecord[]>;
  /** Request ids already announced in this window, so each toast shows once. */
  readonly announced: ReadonlySet<string>;
}

export const useAwayAccessRequestsStore = create<AccessRequestsState>(() => ({
  byEnvironment: new Map(),
  announced: new Set(),
}));

export function setEnvironmentAccessRequests(
  environmentId: EnvironmentId,
  requests: readonly AwayAccessRequestRecord[],
) {
  useAwayAccessRequestsStore.setState((state) => {
    const next = new Map(state.byEnvironment);
    next.set(environmentId, requests);
    return { byEnvironment: next };
  });
}

export function markAccessRequestsAnnounced(requestIds: readonly string[]) {
  if (requestIds.length === 0) return;
  useAwayAccessRequestsStore.setState((state) => ({
    announced: new Set([...state.announced, ...requestIds]),
  }));
}

/** Loads one machine's requests into the store; a failure keeps what it had. */
export async function loadEnvironmentAccessRequests(
  environmentId: EnvironmentId,
): Promise<readonly AwayAccessRequestRecord[] | null> {
  const next = await runAway(awayRpc.accessRequests, { environmentId, input: {} });
  if (!next.ok) return null;
  setEnvironmentAccessRequests(environmentId, next.value.requests);
  return next.value.requests;
}

export function useEnvironmentAccessRequests(
  environmentId: EnvironmentId,
): readonly AwayAccessRequestRecord[] {
  return useAwayAccessRequestsStore((state) => state.byEnvironment.get(environmentId) ?? EMPTY);
}

const EMPTY: readonly AwayAccessRequestRecord[] = [];
