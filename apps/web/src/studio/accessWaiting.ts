/**
 * Threads waiting for the person to allow access, as the coordinator shows
 * them: a card with the thread and what it asks for, and one line saying
 * which machine it wants and why. Wording comes from the shared copy helpers.
 */
import type { OrchestrationV2PendingAccessRequest } from "@specweave-studio/contracts";
import type { StudioFleetRemoteWorker } from "@specweave-studio/contracts/studioFleet";
import {
  accessRequestWaitingSentence,
  accessRequestWaitingSubtitle,
} from "@specweave-studio/client-runtime/access-request";
import type { EnvironmentThreadShell } from "@specweave-studio/client-runtime/state/shell";
import * as DateTime from "effect/DateTime";

import { shortMachineName } from "./shellModel";

export interface AccessWaitingThread {
  readonly thread: EnvironmentThreadShell;
  readonly title: string;
  readonly subtitle: string;
  /** Follows the thread link: "is waiting for you to allow access to M4, so it can …". */
  readonly sentence: string;
  readonly access: OrchestrationV2PendingAccessRequest;
}

/** The access request a thread waits on, or null when it waits on nothing of the kind. */
export function pendingAccessRequest(
  thread: Pick<EnvironmentThreadShell, "source">,
): OrchestrationV2PendingAccessRequest | null {
  const request = thread.source?.pendingRuntimeRequest ?? null;
  return request?.kind === "permission" && request.access !== undefined ? request.access : null;
}

/**
 * The machine an access request is for: the subject's own machine when it
 * names one, else the machine the thread runs on, else "this computer".
 */
export function accessWaitingMachineLabel(
  access: OrchestrationV2PendingAccessRequest,
  threadMachineLabel: string | null | undefined,
): string {
  const host = access.subjects.find((subject) => subject.hostLabel?.trim())?.hostLabel?.trim();
  if (host) return host;
  const machine = threadMachineLabel?.trim() ? shortMachineName(threadMachineLabel) : "";
  return machine || "this computer";
}

/**
 * The threads of this project's workers on other machines, as far as their
 * hosts' thread lists are loaded here. A disposed worker no longer asks.
 */
export function remoteWorkerThreads(
  shells: ReadonlyArray<EnvironmentThreadShell>,
  workers: ReadonlyArray<
    Pick<StudioFleetRemoteWorker, "environmentId" | "remoteThreadId" | "state">
  >,
): ReadonlyArray<EnvironmentThreadShell> {
  const wanted = new Set(
    workers.flatMap((worker) =>
      worker.remoteThreadId === null || worker.state === "disposed"
        ? []
        : [`${worker.environmentId}:${worker.remoteThreadId}`],
    ),
  );
  if (wanted.size === 0) return [];
  return shells.filter((shell) => wanted.has(`${shell.environmentId}:${shell.id}`));
}

/**
 * Every thread waiting on an access request, oldest ask first so the lines
 * read in the order the threads asked. `machineOf` names the machine a thread
 * runs on (its nickname when the user set one).
 */
export function accessWaitingThreads(
  threads: ReadonlyArray<EnvironmentThreadShell>,
  machineOf: (thread: EnvironmentThreadShell) => string | null,
): ReadonlyArray<AccessWaitingThread> {
  const waiting: Array<AccessWaitingThread & { readonly askedAt: number }> = [];
  // A worker on another machine can be listed twice: once here, once by its host.
  const seen = new Set<string>();
  for (const thread of threads) {
    if (thread.archivedAt) continue;
    const key = `${thread.environmentId}:${thread.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const access = pendingAccessRequest(thread);
    if (access === null) continue;
    const createdAt: unknown = thread.source?.pendingRuntimeRequest?.createdAt;
    const askedAt = DateTime.isDateTime(createdAt)
      ? DateTime.toEpochMillis(createdAt)
      : Date.parse(String(createdAt));
    waiting.push({
      thread,
      title: thread.title.trim() || "Untitled thread",
      subtitle: accessRequestWaitingSubtitle(access.subjects),
      sentence: accessRequestWaitingSentence(
        accessWaitingMachineLabel(access, machineOf(thread)),
        access.reason,
      ),
      access,
      askedAt: Number.isFinite(askedAt) ? askedAt : 0,
    });
  }
  return waiting
    .toSorted((left, right) => left.askedAt - right.askedAt)
    .map(({ askedAt: _askedAt, ...entry }) => entry);
}
