/**
 * Machine nicknames: the short name the user gives each machine ("M4",
 * "Mini 2"). They are stored in every server's `machineNicknames` setting,
 * keyed by environmentId (never the host name), and servers swap them with
 * their paired machines, so every device shows the same name.
 *
 * Thread rows, the coordinator switcher, notices and the phone name machines
 * with `machineNickname(environmentId)` (outside React) or
 * `useMachineNickname(environmentId)` / `useMachineNicknames()` (in React).
 */
import { useAtomValue } from "@effect/atom-react";
import type { MachineNickname, MachineNicknames, ServerConfig } from "@specweave-studio/contracts";
import {
  machineNicknameHolder,
  mergeMachineNicknames,
  nextMachineNicknameStamp,
  normalizeMachineNickname,
  sameMachineNicknames,
} from "@specweave-studio/shared/machineNicknames";
import * as Option from "effect/Option";
import { Atom } from "effect/reactivity";
import { useCallback, useMemo } from "react";

import { environmentCatalog } from "../connection/catalog";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentServerConfigsAtom } from "../state/server";
import { readSkippedFleetEnvironments } from "./fleetAutoConnect";
import { fleetMachinesAtom, removedMachinesAtom } from "./knownMachines";
import { shortMachineName } from "./shellModel";

const EMPTY: MachineNicknames = {};

/** The newest nickname of every machine across the servers this device reaches. */
export function mergeServerNicknames(configs: Iterable<ServerConfig>): MachineNicknames {
  let merged = EMPTY;
  for (const config of configs) {
    merged = mergeMachineNicknames(merged, config.settings.machineNicknames);
  }
  return merged;
}

/**
 * The name to show for a machine: its nickname, else its host label without
 * the owner ("Anton's MacBook M4MAX" reads "MacBook M4MAX"), else its id.
 */
export function resolveMachineNickname(
  nicknames: MachineNicknames,
  environmentId: string,
  fallbackLabel?: string | null,
): string {
  const name = normalizeMachineNickname(nicknames[environmentId]?.name ?? "");
  if (name !== "") return name;
  const label = fallbackLabel?.trim() ?? "";
  return label === "" ? environmentId : shortMachineName(label);
}

interface MachineNameSources {
  readonly nicknames: MachineNicknames;
  /** Each connected machine's own host label, for callers that pass none. */
  readonly labels: ReadonlyMap<string, string>;
}

const NO_SOURCES: MachineNameSources = { nicknames: EMPTY, labels: new Map() };

const sameLabels = (a: ReadonlyMap<string, string>, b: ReadonlyMap<string, string>) =>
  a.size === b.size && [...a].every(([id, label]) => b.get(id) === label);

export const machineNameSourcesAtom = Atom.make((get): MachineNameSources => {
  const configs = [...get(environmentServerConfigsAtom).values()];
  const next: MachineNameSources = {
    nicknames: mergeServerNicknames(configs),
    labels: new Map(
      configs.map((config) => [config.environment.environmentId, config.environment.label]),
    ),
  };
  const previous = Option.getOrNull(get.self<MachineNameSources>());
  return previous !== null &&
    sameMachineNicknames(previous.nicknames, next.nicknames) &&
    sameLabels(previous.labels, next.labels)
    ? previous
    : next;
}).pipe(Atom.withLabel("machine-name-sources"));

// Some embedders (and test doubles) hand back no value; the default name still shows.
const sourcesOf = (value: unknown): MachineNameSources =>
  typeof value === "object" &&
  value !== null &&
  "labels" in value &&
  value.labels instanceof Map &&
  "nicknames" in value &&
  typeof value.nicknames === "object" &&
  value.nicknames !== null
    ? (value as MachineNameSources)
    : NO_SOURCES;

export function useMachineNameSources(): MachineNameSources {
  return sourcesOf(useAtomValue(machineNameSourcesAtom));
}

/** A machine's name outside React: notices, toasts, plain functions. */
export function machineNickname(environmentId: string, fallbackLabel?: string | null): string {
  const { nicknames, labels } = sourcesOf(appAtomRegistry.get(machineNameSourcesAtom));
  return resolveMachineNickname(
    nicknames,
    environmentId,
    fallbackLabel ?? labels.get(environmentId),
  );
}

/** Resolves any machine's name; re-renders when a nickname or host label changes. */
export function useMachineNicknames(): (
  environmentId: string,
  fallbackLabel?: string | null,
) => string {
  const { nicknames, labels } = useMachineNameSources();
  return useCallback(
    (environmentId, fallbackLabel) =>
      resolveMachineNickname(nicknames, environmentId, fallbackLabel ?? labels.get(environmentId)),
    [nicknames, labels],
  );
}

export function useMachineNickname(
  environmentId: string | null | undefined,
  fallbackLabel?: string | null,
): string {
  const resolve = useMachineNicknames();
  return environmentId ? resolve(environmentId, fallbackLabel) : (fallbackLabel?.trim() ?? "");
}

/** Every machine saved on this device, enabled or not, with the label it was saved under. */
export const savedMachineLabelsAtom = Atom.make((get): ReadonlyMap<string, string> => {
  const catalog: unknown = get(environmentCatalog.catalogValueAtom);
  const entries =
    typeof catalog === "object" && catalog !== null && "entries" in catalog
      ? (catalog as { entries: unknown }).entries
      : null;
  const next = new Map<string, string>();
  if (entries instanceof Map) {
    for (const [id, entry] of entries as ReadonlyMap<string, { target?: { label?: string } }>) {
      next.set(id, entry.target?.label ?? "");
    }
  }
  const previous = Option.getOrNull(get.self<ReadonlyMap<string, string>>());
  return previous !== null && sameLabels(previous, next) ? previous : next;
}).pipe(Atom.withLabel("saved-machine-labels"));

const mapOf = (value: unknown): ReadonlyMap<string, string> =>
  value instanceof Map ? (value as ReadonlyMap<string, string>) : NO_LABELS;
const setOf = (value: unknown): ReadonlySet<string> =>
  value instanceof Set ? (value as ReadonlySet<string>) : NO_IDS;
const NO_LABELS: ReadonlyMap<string, string> = new Map();
const NO_IDS: ReadonlySet<string> = new Set();

export interface KnownMachineSources {
  /** Saved on this device, by id, with the label each was saved under. */
  readonly saved: ReadonlyMap<string, string>;
  /** Named by a fleet list this session. */
  readonly fleet: ReadonlyMap<string, string>;
  /** Removed here: this session, or skipped by automatic connection before. */
  readonly removed: ReadonlySet<string>;
}

/** What, besides connected machines, makes a machine known here; re-renders as it changes. */
export function useKnownMachineSources(): KnownMachineSources {
  const saved = mapOf(useAtomValue(savedMachineLabelsAtom));
  const fleet = mapOf(useAtomValue(fleetMachinesAtom));
  const removedNow = setOf(useAtomValue(removedMachinesAtom));
  return useMemo(() => {
    const removed = new Set(removedNow);
    for (const id of readSkippedFleetEnvironments()) removed.add(id);
    // A machine saved here again was connected by hand; it counts.
    for (const id of saved.keys()) removed.delete(id);
    return { saved, fleet, removed };
  }, [saved, fleet, removedNow]);
}

/**
 * The machines this device knows, each with its computer name: connected, saved
 * here, or named by a fleet list and not removed here. A synced nickname alone is
 * not one. A machine that joined again under a new id leaves its old id's
 * nickname in every server's settings, and that leftover must not hold a name
 * ("Another machine is already called m5" with no such machine in view).
 */
export function knownMachineLabels(
  input: KnownMachineSources & { readonly labels: ReadonlyMap<string, string> },
): ReadonlyMap<string, string> {
  const known = new Map(input.labels);
  for (const [id, label] of input.saved) {
    if (!known.has(id) || known.get(id) === "") known.set(id, label);
  }
  for (const [id, label] of input.fleet) {
    if (!known.has(id) && !input.removed.has(id)) known.set(id, label);
  }
  return known;
}

export interface MachineNameHolder {
  readonly environmentId: string;
  /** The name it shows. */
  readonly name: string;
  /** Its computer name, or "" when none is known. */
  readonly label: string;
}

/**
 * Another known machine already shown under a name, compared without case, or
 * null. Only machines in `known` count, never a leftover nickname.
 */
export function findMachineNameHolder(
  nicknames: MachineNicknames,
  known: ReadonlyMap<string, string>,
  environmentId: string,
  name: string,
): MachineNameHolder | null {
  const shown = new Map<string, string>();
  for (const [id, label] of known) shown.set(id, resolveMachineNickname(nicknames, id, label));
  const holder = machineNicknameHolder(shown, environmentId, name);
  return holder === null
    ? null
    : { environmentId: holder, name: shown.get(holder) ?? name, label: known.get(holder) ?? "" };
}

/**
 * Finds another known machine already shown under a name (ignoring case), so a
 * rename can say so before it duplicates one, such as an old record of the same
 * computer. Returns that machine, the name it shows and its computer name, or null.
 */
export function useMachineNameHolder(): (
  environmentId: string,
  name: string,
) => MachineNameHolder | null {
  const { nicknames, labels } = useMachineNameSources();
  const sources = useKnownMachineSources();
  const known = useMemo(() => knownMachineLabels({ ...sources, labels }), [sources, labels]);
  return useCallback(
    (environmentId, name) => findMachineNameHolder(nicknames, known, environmentId, name),
    [nicknames, known],
  );
}

/** The nickname the user set, or null when the machine shows its default name. */
export function useCustomMachineNickname(environmentId: string | null | undefined): string | null {
  const { nicknames } = useMachineNameSources();
  if (!environmentId) return null;
  const name = normalizeMachineNickname(nicknames[environmentId]?.name ?? "");
  return name === "" ? null : name;
}

/** The patch that renames a machine; an empty name restores its default. */
export function machineNicknamePatch(
  nicknames: MachineNicknames,
  environmentId: string,
  name: string,
  now?: number,
): { readonly machineNicknames: Record<string, MachineNickname> } {
  return {
    machineNicknames: {
      [environmentId]: {
        name: normalizeMachineNickname(name),
        updatedAt: nextMachineNicknameStamp(nicknames[environmentId], now ?? Date.now()),
      },
    },
  };
}

export type RenameMachineLock = "unsupported" | "no-access" | null;

export function renameMachineLockText(lock: RenameMachineLock): string | null {
  switch (lock) {
    case "unsupported":
      return "Update SpecWithCode on your machines to rename them.";
    case "no-access":
      return "This device can't change settings on your machines.";
    case null:
      return null;
  }
}
