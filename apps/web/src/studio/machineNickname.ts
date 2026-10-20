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
  mergeMachineNicknames,
  nextMachineNicknameStamp,
  normalizeMachineNickname,
  sameMachineNicknames,
} from "@specweave-studio/shared/machineNicknames";
import * as Option from "effect/Option";
import { Atom } from "effect/reactivity";
import { useCallback } from "react";

import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentServerConfigsAtom } from "../state/server";
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
