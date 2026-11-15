import { useAtomValue } from "@effect/atom-react";
import { WS_METHODS } from "@specweave-studio/contracts";
import { Atom } from "effect/reactivity";

import { appAtomRegistry } from "./atomRegistry";

export const SLOW_RPC_ACK_THRESHOLD_MS = 15_000;
/**
 * Some requests are slow by design — they shell out to a package manager on the
 * server and only respond once the install finishes. Warning about those after
 * 15s is noise, so they get a much longer leash.
 */
export const LONG_RUNNING_RPC_ACK_THRESHOLD_MS = 120_000;
export const MAX_TRACKED_RPC_ACK_REQUESTS = 256;
let slowRpcAckThresholdMs = SLOW_RPC_ACK_THRESHOLD_MS;

export interface SlowRpcAckRequest {
  readonly requestId: string;
  /** The machine the request went to; null when the caller did not say. */
  readonly environmentId: string | null;
  readonly startedAt: string;
  readonly startedAtMs: number;
  readonly tag: string;
  readonly thresholdMs: number;
}

interface PendingRpcAckRequest {
  readonly request: SlowRpcAckRequest;
  readonly timeoutId: ReturnType<typeof setTimeout>;
}

const pendingRpcAckRequests = new Map<string, PendingRpcAckRequest>();
const untrackedRpcAckMethods = new Set<string>([WS_METHODS.serverGetUsageSummary]);
const longRunningRpcAckMethods = new Set<string>([
  WS_METHODS.serverUpdateProvider,
  WS_METHODS.serverRefreshProviders,
  WS_METHODS.serverUpdateServer,
  WS_METHODS.serverPrepareServiceUpdate,
]);

const slowRpcAckRequestsAtom = Atom.make<ReadonlyArray<SlowRpcAckRequest>>([]).pipe(
  Atom.keepAlive,
  Atom.withLabel("slow-rpc-ack-requests"),
);

function setSlowRpcAckRequests(requests: ReadonlyArray<SlowRpcAckRequest>) {
  appAtomRegistry.set(slowRpcAckRequestsAtom, [...requests]);
}

function getSlowRpcAckRequestsValue(): ReadonlyArray<SlowRpcAckRequest> {
  return appAtomRegistry.get(slowRpcAckRequestsAtom);
}

function shouldTrackRpcAck(method: string): boolean {
  return (
    !method.includes("subscribe") &&
    !method.startsWith("pullRequests.") &&
    !untrackedRpcAckMethods.has(method)
  );
}

function rpcAckThresholdMs(method: string): number {
  return longRunningRpcAckMethods.has(method)
    ? Math.max(slowRpcAckThresholdMs, LONG_RUNNING_RPC_ACK_THRESHOLD_MS)
    : slowRpcAckThresholdMs;
}

export function getSlowRpcAckRequests(): ReadonlyArray<SlowRpcAckRequest> {
  return getSlowRpcAckRequestsValue();
}

/** Slow requests of one machine, so a warning can name the machine that is slow. */
export interface SlowRpcAckGroup {
  readonly environmentId: string | null;
  readonly requests: ReadonlyArray<SlowRpcAckRequest>;
}

/** Slow requests grouped by the machine they went to, in order of each machine's first one. */
export function groupSlowRpcAckRequests(
  requests: ReadonlyArray<SlowRpcAckRequest>,
): ReadonlyArray<SlowRpcAckGroup> {
  const groups = new Map<string | null, SlowRpcAckRequest[]>();
  for (const request of requests) {
    const group = groups.get(request.environmentId);
    if (group) group.push(request);
    else groups.set(request.environmentId, [request]);
  }
  return [...groups].map(([environmentId, grouped]) => ({ environmentId, requests: grouped }));
}

/**
 * Starts the slow-request timer for one in-flight unary RPC. `method` is the
 * bare WS method (used to decide whether and how long to wait); `tag` is the
 * human-readable label shown in the toast, which defaults to the method;
 * `environmentId` is the machine that should answer.
 */
export function trackRpcRequestSent(
  requestId: string,
  method: string,
  tag = method,
  environmentId: string | null = null,
): void {
  if (!shouldTrackRpcAck(method)) {
    return;
  }

  clearTrackedRpcRequest(requestId);
  evictOldestPendingRpcRequestIfNeeded();

  const startedAtMs = Date.now();
  const thresholdMs = rpcAckThresholdMs(method);
  const request: SlowRpcAckRequest = {
    requestId,
    environmentId,
    startedAt: new Date(startedAtMs).toISOString(),
    startedAtMs,
    tag,
    thresholdMs,
  };
  const timeoutId = setTimeout(() => {
    pendingRpcAckRequests.delete(requestId);
    appendSlowRpcAckRequest(request);
  }, thresholdMs);

  pendingRpcAckRequests.set(requestId, {
    request,
    timeoutId,
  });
}

export function acknowledgeRpcRequest(requestId: string): void {
  clearTrackedRpcRequest(requestId);
  const slowRequests = getSlowRpcAckRequestsValue();
  if (!slowRequests.some((request) => request.requestId === requestId)) {
    return;
  }

  setSlowRpcAckRequests(slowRequests.filter((request) => request.requestId !== requestId));
}

function clearAllTrackedRpcRequests(): void {
  for (const pending of pendingRpcAckRequests.values()) {
    clearTimeout(pending.timeoutId);
  }
  pendingRpcAckRequests.clear();
  setSlowRpcAckRequests([]);
}

function clearTrackedRpcRequest(requestId: string): void {
  const pending = pendingRpcAckRequests.get(requestId);
  if (!pending) {
    return;
  }

  clearTimeout(pending.timeoutId);
  pendingRpcAckRequests.delete(requestId);
}

function appendSlowRpcAckRequest(request: SlowRpcAckRequest): void {
  const requests = [...getSlowRpcAckRequestsValue(), request];
  if (requests.length <= MAX_TRACKED_RPC_ACK_REQUESTS) {
    setSlowRpcAckRequests(requests);
    return;
  }

  setSlowRpcAckRequests(requests.slice(-MAX_TRACKED_RPC_ACK_REQUESTS));
}

function evictOldestPendingRpcRequestIfNeeded(): void {
  while (pendingRpcAckRequests.size >= MAX_TRACKED_RPC_ACK_REQUESTS) {
    const oldestRequestId = pendingRpcAckRequests.keys().next().value;
    if (oldestRequestId === undefined) {
      return;
    }

    clearTrackedRpcRequest(oldestRequestId);
  }
}

export function resetRequestLatencyStateForTests(): void {
  slowRpcAckThresholdMs = SLOW_RPC_ACK_THRESHOLD_MS;
  clearAllTrackedRpcRequests();
}

export function useSlowRpcAckRequests(): ReadonlyArray<SlowRpcAckRequest> {
  return useAtomValue(slowRpcAckRequestsAtom);
}
