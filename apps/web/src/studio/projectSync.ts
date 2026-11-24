/**
 * Project sync from a window: the five calls, each made on the machine it changes or reads,
 * and what the window remembers of each machine's last status for the machine menu.
 *
 * Sync is Git first. Each machine fetches from its own remote and fast-forwards; nothing
 * is fetched from the other machine and nothing is pushed. Extras are sent by the machine
 * that has them, straight to the other one.
 *
 * @module projectSync
 */
import {
  createEnvironmentRpcCommand,
  runAtomCommand,
  squashAtomCommandFailure,
  type AtomCommand,
} from "@specweave-studio/client-runtime/state/runtime";
import {
  PROJECT_SYNC_RPC_METHODS as M,
  type EnvironmentId,
  type ProjectId,
  type ProjectSyncExtraItem,
  type ProjectSyncFetchResult,
  type ProjectSyncInventoryResult,
  type ProjectSyncRunInput,
  type ProjectSyncRunResult,
  type ProjectSyncSendExtrasResult,
  type ProjectSyncStatusResult,
} from "@specweave-studio/contracts";
import { useSyncExternalStore } from "react";

import { isUnknownSyncCall } from "../components/studio/projectSyncDialog.logic";
import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";

const projectSync = {
  status: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "project-sync:status",
    tag: M.projectSyncStatus,
  }),
  inventory: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "project-sync:inventory",
    tag: M.projectSyncInventory,
  }),
  fetch: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "project-sync:fetch",
    tag: M.projectSyncFetch,
  }),
  run: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "project-sync:run",
    tag: M.projectSyncRun,
  }),
  sendExtras: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "project-sync:send-extras",
    tag: M.projectSyncSendExtras,
  }),
};

/** A project on one machine: where a call goes. */
export interface SyncMachine {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  /** The machine's name as the window shows it. */
  readonly label: string;
}

export const syncMachineKey = (machine: Pick<SyncMachine, "environmentId" | "projectId">) =>
  `${machine.environmentId}:${machine.projectId}`;

/** An answer, or the cause of the failure as the call gave it. */
export type SyncOutcome<A> =
  | { readonly ok: true; readonly value: A }
  | { readonly ok: false; readonly cause: unknown };

/** The calls the Sync dialog makes. A fixture or a test passes its own. */
export interface ProjectSyncApi {
  status(machine: SyncMachine): Promise<SyncOutcome<ProjectSyncStatusResult>>;
  /** Aborting `signal` stops the call on the machine too, and its lock on the project. */
  fetch(machine: SyncMachine, signal?: AbortSignal): Promise<SyncOutcome<ProjectSyncFetchResult>>;
  /** `fetchId` names this machine's fetch: what is "only here" is judged as of it. */
  inventory(
    machine: SyncMachine,
    fetchId?: string,
    signal?: AbortSignal,
  ): Promise<SyncOutcome<ProjectSyncInventoryResult>>;
  /** Always with the fetch id of this machine's own fetch: a run goes by nothing else. */
  run(
    machine: SyncMachine,
    input: Omit<ProjectSyncRunInput, "projectId" | "fetchId"> & { readonly fetchId: string },
  ): Promise<SyncOutcome<ProjectSyncRunResult>>;
  /** Asks `source` to send its ticked extras to `target`. */
  sendExtras(
    source: SyncMachine,
    target: SyncMachine,
    input: { readonly operationId: string; readonly items: ReadonlyArray<ProjectSyncExtraItem> },
  ): Promise<SyncOutcome<ProjectSyncSendExtrasResult>>;
}

async function call<W extends { environmentId: EnvironmentId }, A, E>(
  rpc: AtomCommand<W, A, E>,
  value: W,
  signal?: AbortSignal,
): Promise<SyncOutcome<A>> {
  // The dialog and the menu say what failed in their own words: no toast.
  const result = await runAtomCommand(appAtomRegistry, rpc, value, {
    label: rpc.label,
    reportFailure: false,
    reportDefect: false,
    ...(signal ? { signal } : {}),
  });
  return result._tag === "Success"
    ? { ok: true, value: result.value }
    : { ok: false, cause: squashAtomCommandFailure(result) };
}

const on = (machine: SyncMachine) => ({
  environmentId: machine.environmentId,
  input: { projectId: machine.projectId },
});

export const projectSyncApi: ProjectSyncApi = {
  status: (machine) => call(projectSync.status, on(machine)),
  fetch: (machine, signal) => call(projectSync.fetch, on(machine), signal),
  inventory: (machine, fetchId, signal) =>
    call(
      projectSync.inventory,
      {
        environmentId: machine.environmentId,
        input: { projectId: machine.projectId, ...(fetchId ? { fetchId } : {}) },
      },
      signal,
    ),
  run: (machine, input) =>
    call(projectSync.run, {
      environmentId: machine.environmentId,
      input: { projectId: machine.projectId, ...input },
    }),
  sendExtras: (source, target, input) =>
    call(projectSync.sendExtras, {
      environmentId: source.environmentId,
      input: {
        projectId: source.projectId,
        targetEnvironmentId: target.environmentId,
        operationId: input.operationId,
        items: input.items,
      },
    }),
};

// ---------------------------------------------------------------------------
// The last status of each machine, kept in memory for the machine menu
// ---------------------------------------------------------------------------

/** How long a status is taken as current before the menu asks again. */
export const SYNC_STATUS_FRESH_MS = 60_000;

/**
 * What this window last learned of one machine's project. `needs-update`: its app answered
 * that it does not know Sync. Nothing is kept past a restart of the window.
 */
export type SyncStatusRead =
  | {
      readonly kind: "status";
      readonly status: ProjectSyncStatusResult;
      readonly at: number;
      /** The machine was asked again since and did not answer: this is what it said at `at`. */
      readonly stale?: boolean;
    }
  | { readonly kind: "needs-update"; readonly at: number };

/** Whether a read is shown with its time: older than a minute, or not confirmed since. */
export const syncReadIsOld = (read: SyncStatusRead, now: number): boolean =>
  (read.kind === "status" && read.stale === true) || now - read.at >= SYNC_STATUS_FRESH_MS;

const reads = new Map<string, SyncStatusRead>();
const pending = new Set<string>();
const listeners = new Set<() => void>();
let version = 0;

const changed = () => {
  version += 1;
  for (const listener of listeners) listener();
};

/** The last read of a machine's project in this session; undefined when none succeeded. */
export const syncStatusRead = (key: string): SyncStatusRead | undefined => reads.get(key);

/**
 * Reads the status of each listed machine that has none newer than a minute. A machine
 * that cannot be asked keeps what was read before, so an offline machine still shows its
 * last status with its time; one that never answered has nothing, which reads as "Not
 * checked yet".
 */
export async function refreshSyncStatus(
  machines: ReadonlyArray<SyncMachine>,
  api: Pick<ProjectSyncApi, "status"> = projectSyncApi,
  now: () => number = Date.now,
): Promise<void> {
  await Promise.all(
    machines.map(async (machine) => {
      const key = syncMachineKey(machine);
      const last = reads.get(key);
      if (pending.has(key) || (last && now() - last.at < SYNC_STATUS_FRESH_MS)) return;
      pending.add(key);
      try {
        const result = await api.status(machine);
        if (result.ok) reads.set(key, { kind: "status", status: result.value, at: now() });
        else if (isUnknownSyncCall(result.cause))
          reads.set(key, { kind: "needs-update", at: now() });
        else if (last?.kind === "status" && !last.stale) reads.set(key, { ...last, stale: true });
        else return;
        changed();
      } finally {
        pending.delete(key);
      }
    }),
  );
}

/** Forgets a machine's status, so the next menu opening reads it again (after a sync). */
export function forgetSyncStatus(keys: ReadonlyArray<string>): void {
  let dropped = false;
  for (const key of keys) dropped = reads.delete(key) || dropped;
  if (dropped) changed();
}

/** For tests: the memory is module state. */
export function resetSyncStatusForTest(): void {
  reads.clear();
  pending.clear();
  changed();
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** Re-renders when a status is read; returns the reader for a machine key. */
export function useSyncStatusReads(): (key: string) => SyncStatusRead | undefined {
  useSyncExternalStore(
    subscribe,
    () => version,
    () => version,
  );
  return syncStatusRead;
}
