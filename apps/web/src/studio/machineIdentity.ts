/**
 * Machine identity: the color and icon a machine is told apart by, beside its
 * nickname. Both are stored with the nickname (`machineNicknames`, keyed by
 * environmentId) and reach paired machines the same way. Until someone picks
 * them, the color follows from the machine's id (no two known machines share
 * one) and the icon from the kind of hardware it is.
 *
 * The short label is what a chip keeps when it runs out of room, never the
 * icon alone (`assignMachineShortLabels`).
 *
 * A color is a palette id; `index.css` maps each id to tokens that pass
 * contrast in light and dark (`[data-machine-color]`). Surfaces that wear it
 * always show the machine's name or icon as well, never the color alone.
 */
import { useAtomValue } from "@effect/atom-react";
import {
  MACHINE_COLOR_IDS,
  resolveEnvironmentMachineKind,
  type EnvironmentMachineKind,
  type MachineColorId,
  type MachineNickname,
  type MachineNicknames,
} from "@specweave-studio/contracts";
import {
  assignMachineColors,
  nextMachineNicknameStamp,
  normalizeMachineNickname,
  normalizeMachineShortName,
} from "@specweave-studio/shared/machineNicknames";
import {
  assignMachineShortLabels,
  foldMachineShortLabel,
  pickMachineShortLabel,
} from "@specweave-studio/shared/machineShortLabel";
import * as Option from "effect/Option";
import { Atom } from "effect/reactivity";
import { createContext, useCallback, useMemo } from "react";

import { environmentServerConfigsAtom } from "../state/server";
import { fleetMachinesAtom } from "./knownMachines";
import {
  resolveMachineNickname,
  useKnownMachineSources,
  useMachineNameSources,
} from "./machineNickname";

export const MACHINE_COLOR_LABELS: Record<MachineColorId, string> = {
  violet: "Violet",
  teal: "Teal",
  amber: "Amber",
  rose: "Rose",
  blue: "Blue",
  green: "Green",
  orange: "Orange",
  slate: "Slate",
};

export { MACHINE_COLOR_IDS };

export interface MachineIdentity {
  readonly environmentId: string;
  readonly name: string;
  readonly color: MachineColorId;
  readonly icon: EnvironmentMachineKind;
  /**
   * Two or three characters, unique among the machines this device knows: what a
   * chip keeps when it runs out of room. Without a chosen label it follows the
   * machine's name, so a device that names a machine differently may differ.
   */
  readonly short: string;
  /** The label it would have with none chosen, for the rename dialog's placeholder. */
  readonly derivedShort: string;
}

/** The kind of hardware each connected machine reports, for its default icon. */
const machineKindsAtom = Atom.make((get): ReadonlyMap<string, EnvironmentMachineKind> => {
  const next = new Map<string, EnvironmentMachineKind>();
  for (const config of get(environmentServerConfigsAtom).values()) {
    next.set(config.environment.environmentId, resolveEnvironmentMachineKind(config));
  }
  const previous = Option.getOrNull(get.self<ReadonlyMap<string, EnvironmentMachineKind>>());
  return previous !== null &&
    previous.size === next.size &&
    [...next].every(([id, kind]) => previous.get(id) === kind)
    ? previous
    : next;
}).pipe(Atom.withLabel("machine-kinds"));

interface MachineIdentitySources {
  readonly nicknames: MachineNicknames;
  readonly labels: ReadonlyMap<string, string>;
  readonly kinds: ReadonlyMap<string, EnvironmentMachineKind>;
  /** Machines a fleet list names, connected here or not (`knownMachines.ts`). */
  readonly fleet?: Iterable<string> | undefined;
  /** Machines saved on this device, connected or not, with the label each was saved under. */
  readonly saved?: ReadonlyMap<string, string> | undefined;
  /** Machines removed here, which a fleet list may still name. */
  readonly removed?: ReadonlySet<string> | undefined;
}

/**
 * Every machine this device knows of: connected, saved here, or listed by a
 * fleet and not removed here. A nickname alone does not make one: a machine
 * that joined again under a new id leaves its old id's nickname behind, and that
 * must not take a name's chip letters ("M5" going to a dead record, this machine
 * left with "M2").
 */
export function knownMachineIds(input: MachineIdentitySources): readonly string[] {
  const removed = input.removed;
  const fleet = [...(input.fleet ?? [])].filter((id) => removed === undefined || !removed.has(id));
  return [
    ...new Set([
      ...input.labels.keys(),
      ...input.kinds.keys(),
      ...fleet,
      ...(input.saved?.keys() ?? []),
    ]),
  ];
}

const machineNameOf =
  (input: MachineIdentitySources) => (environmentId: string, fallbackLabel?: string | null) =>
    resolveMachineNickname(
      input.nicknames,
      environmentId,
      fallbackLabel ?? input.labels.get(environmentId) ?? input.saved?.get(environmentId),
    );

/**
 * The chip letters a machine gets once saved under `name`: the same fleet-wide
 * assignment the app runs, over the same machines, with this one's new name and
 * no chosen letters. The rename dialog previews it before Save.
 */
export function previewMachineShortLabel(
  input: MachineIdentitySources,
  environmentId: string,
  name: string,
): string {
  const nameOf = machineNameOf(input);
  const ids = new Set(knownMachineIds(input));
  ids.add(environmentId);
  const assigned = assignMachineShortLabels(
    [...ids].map((id) =>
      id === environmentId
        ? { environmentId: id, name, short: undefined }
        : { environmentId: id, name: nameOf(id), short: input.nicknames[id]?.short },
    ),
  );
  return assigned.get(environmentId) ?? "";
}

/** Resolves any machine's identity from the nickname map and what is known of the fleet. */
export function resolveMachineIdentities(
  input: MachineIdentitySources,
): (environmentId: string, fallbackLabel?: string | null) => MachineIdentity {
  const known = [...input.labels.keys(), ...input.kinds.keys(), ...(input.fleet ?? [])];
  const colors = assignMachineColors(known, input.nicknames);
  const nameOf = machineNameOf(input);
  const shorts = assignMachineShortLabels(
    knownMachineIds(input).map((id) => ({
      environmentId: id,
      name: nameOf(id),
      short: input.nicknames[id]?.short,
    })),
  );
  // Labels already showing for every other machine, folded, so a machine resolved on
  // its own (first seen here, or named differently by the caller) never repeats one.
  const takenBesides = (environmentId: string) =>
    new Set(
      [...shorts]
        .filter(([id]) => id !== environmentId)
        .map(([, label]) => foldMachineShortLabel(label)),
    );
  const cache = new Map<string, { readonly short: string; readonly derivedShort: string }>();
  const labelsOf = (environmentId: string, name: string) => {
    const key = `${environmentId}\u0000${name}`;
    let entry = cache.get(key);
    if (entry === undefined) {
      const taken = takenBesides(environmentId);
      const chosen = input.nicknames[environmentId]?.short;
      const derivedShort = pickMachineShortLabel(name, undefined, taken);
      const short =
        name === nameOf(environmentId) && shorts.has(environmentId)
          ? shorts.get(environmentId)!
          : pickMachineShortLabel(name, chosen, taken);
      entry = { short, derivedShort };
      cache.set(key, entry);
    }
    return entry;
  };
  return (environmentId, fallbackLabel) => {
    const name = nameOf(environmentId, fallbackLabel);
    return {
      environmentId,
      name,
      // A machine first seen here (a handed-off thread's origin) still gets a stable color.
      color:
        colors.get(environmentId) ??
        assignMachineColors([...known, environmentId], input.nicknames).get(environmentId)!,
      icon: input.nicknames[environmentId]?.icon ?? input.kinds.get(environmentId) ?? "server",
      ...labelsOf(environmentId, name),
    };
  };
}

const kindsOf = (value: unknown): ReadonlyMap<string, EnvironmentMachineKind> =>
  value instanceof Map ? (value as ReadonlyMap<string, EnvironmentMachineKind>) : NO_KINDS;
const NO_KINDS: ReadonlyMap<string, EnvironmentMachineKind> = new Map();
const fleetOf = (value: unknown): ReadonlyMap<string, string> =>
  value instanceof Map ? (value as ReadonlyMap<string, string>) : NO_FLEET;
const NO_FLEET: ReadonlyMap<string, string> = new Map();

/**
 * A fleet machine never connected here is named by the fleet list's computer
 * name, as its card is; a connected machine's own label wins.
 */
export function withFleetLabels(
  labels: ReadonlyMap<string, string>,
  fleet: ReadonlyMap<string, string>,
): ReadonlyMap<string, string> {
  const missing = [...fleet].filter(([id, label]) => label !== "" && !labels.has(id));
  return missing.length === 0 ? labels : new Map([...labels, ...missing]);
}

function useMachineIdentitySources(): MachineIdentitySources {
  const { nicknames, labels: connected } = useMachineNameSources();
  const kinds = kindsOf(useAtomValue(machineKindsAtom));
  const listed = fleetOf(useAtomValue(fleetMachinesAtom));
  const { saved, removed } = useKnownMachineSources();
  return useMemo(
    () => ({
      nicknames,
      // A removed machine keeps its fleet place for colors, but no name of its own.
      labels: withFleetLabels(
        connected,
        removed.size === 0 ? listed : new Map([...listed].filter(([id]) => !removed.has(id))),
      ),
      kinds,
      fleet: [...listed.keys()],
      saved,
      removed,
    }),
    [nicknames, connected, kinds, listed, saved, removed],
  );
}

/** Previews the chip letters a machine gets once saved under a name. */
export function useMachineShortLabelPreview(): (environmentId: string, name: string) => string {
  const sources = useMachineIdentitySources();
  return useCallback(
    (environmentId, name) => previewMachineShortLabel(sources, environmentId, name),
    [sources],
  );
}

/** Resolves any machine's identity; re-renders when a nickname, color or icon changes. */
export function useMachineIdentities(): (
  environmentId: string,
  fallbackLabel?: string | null,
) => MachineIdentity {
  const sources = useMachineIdentitySources();
  return useMemo(() => resolveMachineIdentities(sources), [sources]);
}

/**
 * Which known machines wear each color, so a color picker can say a color is
 * taken ("Teal: M1") before two machines end up looking alike.
 */
export function machineColorWearers(
  input: MachineIdentitySources,
): ReadonlyMap<MachineColorId, readonly MachineIdentity[]> {
  const resolve = resolveMachineIdentities(input);
  const wearers = new Map<MachineColorId, MachineIdentity[]>();
  for (const id of knownMachineIds(input)) {
    const identity = resolve(id);
    wearers.set(identity.color, [...(wearers.get(identity.color) ?? []), identity]);
  }
  return wearers;
}

/** Every known machine's identity, for places that hold only a machine's shown name. */
export function useKnownMachineIdentities(): readonly MachineIdentity[] {
  const sources = useMachineIdentitySources();
  return useMemo(() => {
    const resolve = resolveMachineIdentities(sources);
    return knownMachineIds(sources).map((id) => resolve(id));
  }, [sources]);
}

export function useMachineColorWearers(): ReadonlyMap<MachineColorId, readonly MachineIdentity[]> {
  const sources = useMachineIdentitySources();
  return useMemo(() => machineColorWearers(sources), [sources]);
}

export function useMachineIdentity(
  environmentId: string | null | undefined,
  fallbackLabel?: string | null,
): MachineIdentity | null {
  const resolve = useMachineIdentities();
  return useMemo(
    () => (environmentId ? resolve(environmentId, fallbackLabel) : null),
    [environmentId, fallbackLabel, resolve],
  );
}

/**
 * The machine a send goes to when it is not the one being looked at: the
 * composer's Send takes its color and names it ("Send to M1"). Null on this
 * machine, where Send stays as it is.
 */
export const MachineSendTargetContext = createContext<
  (Pick<MachineIdentity, "name" | "color"> & { readonly short?: string | undefined }) | null
>(null);

/** The attribute that gives an element and its children a machine's color tokens. */
export function machineColorProps(identity: Pick<MachineIdentity, "color"> | null | undefined): {
  readonly "data-machine-color"?: MachineColorId;
} {
  return identity ? { "data-machine-color": identity.color } : {};
}

/**
 * The patch that saves a machine's name, color and icon in one entry. An empty
 * name restores the default name. The color is always written out, so choosing
 * the default again is a choice a later merge keeps. The icon is written when
 * given; without one the stored icon stays, or none, so the detected kind decides.
 */
export function machineIdentityPatch(
  nicknames: MachineNicknames,
  environmentId: string,
  identity: {
    readonly name: string;
    readonly color: MachineColorId;
    /** Absent keeps the stored one, or none, so a detected kind still decides. */
    readonly icon?: EnvironmentMachineKind | undefined;
    /** Absent keeps the stored one; empty goes back to the derived label. */
    readonly short?: string | undefined;
  },
  now?: number,
): { readonly machineNicknames: Record<string, MachineNickname> } {
  const icon = identity.icon ?? nicknames[environmentId]?.icon;
  const short =
    identity.short === undefined
      ? nicknames[environmentId]?.short
      : normalizeMachineShortName(identity.short);
  return {
    machineNicknames: {
      [environmentId]: {
        name: normalizeMachineNickname(identity.name),
        updatedAt: nextMachineNicknameStamp(nicknames[environmentId], now ?? Date.now()),
        color: identity.color,
        ...(icon === undefined ? {} : { icon }),
        ...(short === undefined ? {} : { short }),
      },
    },
  };
}
