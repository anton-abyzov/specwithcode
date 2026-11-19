/**
 * What the machine menu needs for Sync and Add: which machines the project can be synced
 * with and why one cannot, whether a paired machine lacks the project, and each row's sync
 * fact from the machines' last status.
 *
 * @module useProjectSyncMenu
 */
import type { EnvironmentProject } from "@specweave-studio/client-runtime/state/shell";
import {
  AuthSourceControlWriteScope,
  type EnvironmentId,
  type ProjectId,
} from "@specweave-studio/contracts";
import { useState } from "react";

import { useEnvironmentsScopeAccess, type EnvironmentScopeAccess } from "../../state/session";
import {
  machineSyncFact,
  type MachineReach,
  type MachineRowText,
  type MachineSyncFact,
} from "../../studio/machineRowState";
import {
  checkoutKeyEnvironmentId,
  type OrchestratorCopy,
} from "../../studio/projectCoordinatorMachine";
import { isProjectFolder } from "../../studio/projectMachineFolders";
import {
  refreshSyncStatus,
  syncMachineKey,
  syncReadIsOld,
  useSyncStatusReads,
  type SyncMachine,
  type SyncStatusRead,
} from "../../studio/projectSync";
import { addableMachineIds } from "../../studio/addableMachines";
import { useRetiredMachineRecords } from "../settings/useReplacedMachineRecords";
import type { SyncTarget } from "./ProjectSyncDialog";

/**
 * Opens the folder dialog: "add" for a machine without the project, or "sync" with a
 * machine's key and the measured copy, which is "Compare all files…".
 */
export type SyncAsk = (mode: "add" | "sync", target?: string, method?: "copy") => void;

export interface SyncMenuRow {
  readonly sync: MachineSyncFact | null;
  readonly needsUpdate?: { readonly version: string | null } | null;
}

/**
 * Why Sync cannot run on a machine, or null when it can. The first that matches. `named`
 * false is for a row that already shows the machine's name: a reason whose subject is the
 * machine is then said without it.
 */
export function syncBlockedOn(
  input: {
    readonly machine: string;
    readonly reach: MachineReach;
    readonly read: SyncStatusRead | undefined;
    readonly version: string | null;
    readonly access: EnvironmentScopeAccess | undefined;
  },
  named = true,
): MachineRowText | null {
  const { machine } = input;
  if (input.reach === "offline")
    return named ? { text: "{machine} offline", values: { machine } } : { text: "Offline" };
  // Never loaded here, or it refuses this window: the words its row uses.
  if (input.reach !== "open")
    return { text: "This window cannot open {machine}", values: { machine } };
  if (input.read?.kind === "needs-update") {
    if (!named)
      return input.version
        ? { text: "Needs update · {version}", values: { version: input.version } }
        : { text: "Needs update" };
    return input.version
      ? {
          text: "{machine}: Needs update · {version}",
          values: { machine, version: input.version },
        }
      : { text: "{machine}: Needs update", values: { machine } };
  }
  // A grant that has not loaded is not a refusal: the call says so if it is one.
  if (input.access === "denied")
    return { text: "This window can only read {machine}", values: { machine } };
  return null;
}

/** A row's fact against the machine shown, from what the window last read of both. */
export function syncRowFact(input: {
  readonly shown: SyncStatusRead | undefined;
  readonly other: SyncStatusRead | undefined;
  readonly shownName: string;
  /** The other machine is offline: its status is the last one read in this session. */
  readonly offline: boolean;
  readonly version: string | null;
  readonly now?: number;
}): SyncMenuRow {
  const { shown, other } = input;
  const status = (read: SyncStatusRead | undefined) =>
    read?.kind === "status" ? read.status : null;
  const now = input.now ?? Date.now();
  // A comparison is as old as its older side: the time said is that side's.
  const sides = [shown, other].filter((read) => read?.kind === "status");
  const dated =
    sides.length === 2 && (input.offline || sides.some((read) => syncReadIsOld(read!, now)));
  const oldest = Math.min(...sides.map((read) => read!.at));
  return {
    sync: machineSyncFact({
      shown: status(shown),
      other: status(other),
      shownName: input.shownName,
      // Its time is said whenever either status is not a current one: the machine is
      // offline, a read is older than a minute, or the last time a machine was asked it did
      // not answer.
      asOf: dated
        ? new Date(oldest).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
        : null,
    }),
    needsUpdate: other?.kind === "needs-update" ? { version: input.version } : null,
  };
}

const environmentIdOf = (key: string) => checkoutKeyEnvironmentId(key) as EnvironmentId;
const projectIdOf = (key: string) =>
  key.slice(checkoutKeyEnvironmentId(key).length + 1) as ProjectId;

export function useProjectSyncMenu(input: {
  readonly project: EnvironmentProject;
  /** The machine shown, as the menu names it. */
  readonly label: string;
  readonly current: string;
  readonly copies: readonly OrchestratorCopy[];
  readonly unknown: ReadonlyArray<{ readonly key: string; readonly machine: string }>;
  readonly environments: ReadonlyArray<{ readonly environmentId: EnvironmentId }>;
  readonly projects: readonly EnvironmentProject[];
  readonly reachOf: (key: string) => MachineReach;
  readonly versionOf: (environmentId: EnvironmentId) => string | null;
  /** Null when this window may not operate the project or the project is personal. */
  readonly ask: SyncAsk | null;
  /**
   * The window can read the project and may not operate it: the sync facts show, and
   * "Sync…" is greyed with why. False for a personal project, which is never synced.
   */
  readonly readOnly?: boolean;
}) {
  const { project, ask, current } = input;
  const facts = ask !== null || input.readOnly === true;
  const [open, setOpen] = useState(false);
  const readOf = useSyncStatusReads();
  const retired = useRetiredMachineRecords();
  const shown: SyncMachine = {
    environmentId: project.environmentId,
    projectId: project.id,
    label: input.label,
  };
  // A second folder of the project on the machine shown is not another machine.
  const elsewhere = input.copies.filter(
    (copy) =>
      isProjectFolder(copy.folder) &&
      copy.key !== current &&
      checkoutKeyEnvironmentId(copy.key) !== project.environmentId,
  );
  // Sync is between the linked machines of one project. A machine that has the repository
  // as a project of its own cannot receive extras: it is listed, greyed, until it is linked.
  const others = elsewhere
    .filter((copy) => copy.role !== "independent")
    .map((copy) => ({
      key: copy.key,
      machine: {
        environmentId: environmentIdOf(copy.key),
        projectId: projectIdOf(copy.key),
        label: copy.machine,
      } satisfies SyncMachine,
    }));
  const access = useEnvironmentsScopeAccess(
    [shown.environmentId, ...others.map((item) => item.machine.environmentId)],
    AuthSourceControlWriteScope,
  );
  const blockedOn = (machine: SyncMachine, key: string, named = true) =>
    syncBlockedOn(
      {
        machine: machine.label,
        reach: input.reachOf(key),
        read: readOf(syncMachineKey(machine)),
        version: input.versionOf(machine.environmentId),
        access: access.get(machine.environmentId),
      },
      named,
    );
  const targets: SyncTarget[] = others.map((item) => ({
    machine: item.machine,
    blocked: blockedOn(item.machine, item.key),
    note: blockedOn(item.machine, item.key, false),
  }));
  const separate: SyncTarget[] = elsewhere
    .filter((copy) => copy.role === "independent")
    .map((copy) => ({
      machine: {
        environmentId: environmentIdOf(copy.key),
        projectId: projectIdOf(copy.key),
        label: copy.machine,
      },
      blocked: { text: "Separate project" },
    }));
  const shownBlocked = blockedOn(shown, current);
  // Greyed when the machine shown cannot sync, or when no other machine can.
  const syncBlocked: MachineRowText | null =
    shownBlocked ??
    // A window that may not operate the machine shown can read it, and no more.
    (ask === null
      ? { text: "This window can only read {machine}", values: { machine: input.label } }
      : targets.every((target) => target.blocked !== null)
        ? (targets[0]?.blocked ?? null)
        : null);

  // A paired machine lacks the project by the rule the dialog lists machines with. A linked
  // machine this window never opened has the project and is not offered.
  const known = new Set(input.unknown.map((ref) => checkoutKeyEnvironmentId(ref.key) as string));
  const lacking =
    addableMachineIds({
      project,
      machineIds: input.environments
        .map((item) => item.environmentId as string)
        .filter((id) => !known.has(id)),
      projects: input.projects,
      retired,
    }).length > 0;

  const syncOf = (key: string): SyncMenuRow => {
    if (!facts) return { sync: null };
    const environmentId = environmentIdOf(key);
    const read = readOf(key);
    const version = input.versionOf(environmentId);
    if (key === current || environmentId === project.environmentId)
      return {
        sync: null,
        needsUpdate: read?.kind === "needs-update" ? { version } : null,
      };
    return syncRowFact({
      shown: readOf(syncMachineKey(shown)),
      other: read,
      shownName: input.label,
      offline: input.reachOf(key) === "offline",
      version,
    });
  };

  return {
    onSync: facts && targets.length > 0 ? () => setOpen(true) : null,
    syncBlocked: facts && targets.length > 0 ? syncBlocked : null,
    onAdd: ask !== null && lacking ? () => ask("add") : null,
    syncOf,
    /** Opening the menu reads the status of every machine that can be asked. */
    onMenuOpenChange: (next: boolean) => {
      if (!next || !facts) return;
      void refreshSyncStatus([
        ...(input.reachOf(current) === "open" ? [shown] : []),
        ...others.filter((item) => input.reachOf(item.key) === "open").map((item) => item.machine),
      ]);
    },
    dialog:
      open && ask !== null
        ? {
            shown,
            // Live: the dialog stops a plan when either machine can no longer sync.
            shownBlocked,
            targets: [...targets, ...separate],
            onClose: () => setOpen(false),
            onCompare: ask
              ? (target: SyncMachine) => ask("sync", syncMachineKey(target), "copy")
              : null,
          }
        : null,
  };
}
