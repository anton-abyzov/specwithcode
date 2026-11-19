import {
  MACHINE_COLOR_IDS,
  MACHINE_NICKNAME_MAX_LENGTH,
  MACHINE_SHORT_NAME_MAX_LENGTH,
  type MachineColorId,
  type MachineNickname,
  type MachineNicknames,
} from "@specweave-studio/contracts";
import { DateTime } from "effect";

import { graphemes } from "./machineShortLabel.ts";

/** Trims, collapses inner whitespace and caps a typed name at 16 characters. */
export function normalizeMachineNickname(name: string): string {
  return name.trim().replace(/\s+/g, " ").slice(0, MACHINE_NICKNAME_MAX_LENGTH).trim();
}

/**
 * A typed short label: no spaces, whole visible characters only, and within the
 * stored limit of 3 code units (an accent or emoji is never cut in half). Empty
 * means "derive one".
 */
export function normalizeMachineShortName(short: string): string {
  let out = "";
  for (const part of graphemes(short.replace(/\s+/g, "").normalize("NFC"))) {
    if (out.length + part.length > MACHINE_SHORT_NAME_MAX_LENGTH) break;
    out += part;
  }
  return out;
}

/**
 * A computer name cut to fit the 16-character name field at a word boundary
 * ("Anton M5MAX PROLED" becomes "Anton M5MAX"), so the rename dialog never
 * opens over its limit. A single long word is cut at 16.
 */
export function fitMachineNickname(name: string): string {
  const clean = name.trim().replace(/\s+/g, " ");
  if (clean.length <= MACHINE_NICKNAME_MAX_LENGTH) return clean;
  const cut = clean.slice(0, MACHINE_NICKNAME_MAX_LENGTH + 1).lastIndexOf(" ");
  return (cut > 0 ? clean.slice(0, cut) : clean.slice(0, MACHINE_NICKNAME_MAX_LENGTH)).trim();
}

/**
 * A short name to offer for a machine that has none yet, read from its
 * computer name: the Apple chip in it ("Anton M5MAX PROLED" and "Anton's
 * MacBook M4MAX" offer "M5" and "M4"). Null when the name holds no chip, so
 * nothing is offered that the person would have to undo.
 */
export function suggestMachineNickname(hostLabel: string): string | null {
  for (const word of hostLabel.split(/[\s\-_.'’]+/u)) {
    const chip = /^m(\d{1,2})(?:max|pro|ultra)?$/iu.exec(word);
    if (chip) return `M${chip[1]}`;
  }
  return null;
}

/**
 * The stamp of a name a machine gives itself: older than any name a person
 * chooses, so a rename made anywhere, before or after, always wins the merge.
 */
export const DEFAULT_MACHINE_NICKNAME_STAMP = "1970-01-01T00:00:00.000Z";

/** Stamps within the first day after the epoch belong to names a machine gave itself. */
const AUTOMATIC_STAMP_LIMIT = 86_400_000;

/** True for a name a machine gave itself, false for one a person chose. */
export function isAutomaticMachineNickname(entry: MachineNickname): boolean {
  return stamp(entry) < AUTOMATIC_STAMP_LIMIT;
}

const foldShown = (value: string) => value.trim().replace(/\s+/g, " ").toLocaleLowerCase();

/** The computer name as it shows with no nickname: "Anton's MacBook M4MAX" reads "MacBook M4MAX". */
const computerNameShown = (label: string) => {
  const trimmed = label.trim();
  const rest = trimmed.replace(/^[^\s'’]+['’]s\s+/u, "");
  return rest === "" ? trimmed : rest;
};

/**
 * The chip name a machine may give itself, or null when its computer name
 * holds no chip or the name would not tell it apart from another machine it
 * knows (`others`, id to computer name, such as its fleet list). A machine
 * clashes when a person named it that, kept a computer name that reads that,
 * or it has no name of its own choosing and its computer name holds the same
 * chip (it would name itself the same, so both keep their computer names). Two
 * that already named themselves the same settle on the lower id keeping it. A
 * name left by a machine that is not in `others` (an old registration) does
 * not count.
 */
function freeChipName(
  nicknames: MachineNicknames,
  environmentId: string,
  hostLabel: string,
  others: ReadonlyMap<string, string>,
): string | null {
  const name = suggestMachineNickname(hostLabel);
  if (name === null) return null;
  const wanted = foldShown(name);
  for (const [id, label] of others) {
    if (id === environmentId) continue;
    const entry = nicknames[id];
    if (entry === undefined || isAutomaticMachineNickname(entry)) {
      // Both named themselves the same: the lower id keeps it, so the pair
      // settles even when neither list shows the other's chip (a fleet alias).
      // Known limit: when only the lower id lists the other, the higher never
      // sees it and both keep the name until a person renames one. Yielding to
      // claims from ids off the list would fix that, but a dead registration
      // looks the same there, and a Mac that joined again would then yield to
      // its own old record.
      const claimed = entry === undefined ? "" : normalizeMachineNickname(entry.name);
      if (claimed !== "" && foldShown(claimed) === wanted && id < environmentId) return null;
      if (suggestMachineNickname(label) === name) return null;
      continue;
    }
    const chosen = normalizeMachineNickname(entry.name);
    const shown = chosen !== "" ? [chosen] : [label, computerNameShown(label)];
    if (shown.some((value) => foldShown(value) === wanted)) return null;
  }
  return name;
}

/**
 * The entry a machine writes for its own name, or null when nothing changes.
 * A machine nobody named takes the chip in its computer name ("Anton M5MAX
 * PROLED" becomes "M5"), stamped older than any choice. A name a person chose,
 * the computer name kept on purpose included, is never touched. A name the
 * machine gave itself follows what it knows: when another machine comes to
 * show the same name, it goes back to its computer name (an empty name with
 * the next automatic stamp, which syncs over the older one), and takes the
 * chip again once the name is free.
 */
export function defaultMachineNickname(
  nicknames: MachineNicknames,
  environmentId: string,
  hostLabel: string,
  others: ReadonlyMap<string, string> = new Map(),
): MachineNickname | null {
  const own = nicknames[environmentId];
  if (own !== undefined && !isAutomaticMachineNickname(own)) return null;
  const name = freeChipName(nicknames, environmentId, hostLabel, others) ?? "";
  if (own === undefined) {
    return name === "" ? null : { name, updatedAt: DEFAULT_MACHINE_NICKNAME_STAMP };
  }
  if (normalizeMachineNickname(own.name) === name) return null;
  return {
    ...own,
    name,
    updatedAt: DateTime.formatIso(DateTime.makeUnsafe(stamp(own) + 1)),
  };
}

/**
 * The id of another machine already shown under this name, compared without
 * case, or null. `names` maps each known machine id to the name it shows.
 */
export function machineNicknameHolder(
  names: ReadonlyMap<string, string>,
  environmentId: string,
  name: string,
): string | null {
  // Compared as shown, never cut to the 16-character field: a long computer name
  // differs from its first 16 characters.
  const fold = (value: string) => value.trim().replace(/\s+/g, " ").toLocaleLowerCase();
  const wanted = fold(normalizeMachineNickname(name));
  if (wanted === "") return null;
  for (const [id, shown] of names) {
    if (id !== environmentId && fold(shown) === wanted) {
      return id;
    }
  }
  return null;
}

const stamp = (entry: MachineNickname): number => {
  const parsed = Date.parse(entry.updatedAt);
  return Number.isFinite(parsed) ? parsed : 0;
};

const identityOf = (entry: MachineNickname) =>
  `${entry.color ?? ""}\u0000${entry.icon ?? ""}\u0000${entry.short ?? ""}`;

/**
 * Last writer wins. Equal stamps fall back to the name, then to the color and
 * icon, so every machine picks the same entry whichever order the changes
 * arrive in.
 *
 * A color, icon or short label is never dropped by a merge: the winner keeps its own, and
 * takes the other entry's where it states none. A paired machine on an older
 * build decodes an entry without them and sends it back stripped; that copy
 * (same stamp, or a newer rename made there) must not erase what was chosen.
 * Choosing the default again writes it out, so "absent" only ever means "not
 * stated".
 */
export function newerMachineNickname(
  current: MachineNickname | undefined,
  incoming: MachineNickname | undefined,
): MachineNickname | undefined {
  if (incoming === undefined) return current;
  if (current === undefined) return incoming;
  const difference = stamp(incoming) - stamp(current);
  const incomingWins =
    difference !== 0
      ? difference > 0
      : incoming.name !== current.name
        ? incoming.name > current.name
        : identityOf(incoming) > identityOf(current);
  const [winner, other] = incomingWins ? [incoming, current] : [current, incoming];
  const color = winner.color ?? other.color;
  const icon = winner.icon ?? other.icon;
  const short = winner.short ?? other.short;
  if (color === winner.color && icon === winner.icon && short === winner.short) return winner;
  return {
    ...winner,
    ...(color === undefined ? {} : { color }),
    ...(icon === undefined ? {} : { icon }),
    ...(short === undefined ? {} : { short }),
  };
}

export function mergeMachineNicknames(
  current: MachineNicknames,
  incoming: MachineNicknames | undefined,
): MachineNicknames {
  if (incoming === undefined) return current;
  let merged: Record<string, MachineNickname> | null = null;
  for (const [environmentId, entry] of Object.entries(incoming)) {
    const existing = current[environmentId];
    const winner = newerMachineNickname(existing, entry);
    if (winner === existing) continue;
    merged ??= { ...current };
    merged[environmentId] = winner!;
  }
  return merged ?? current;
}

export function sameMachineNicknames(a: MachineNicknames, b: MachineNicknames): boolean {
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every(
    (key) =>
      b[key]?.name === a[key]!.name &&
      b[key]?.updatedAt === a[key]!.updatedAt &&
      b[key]?.color === a[key]!.color &&
      b[key]?.icon === a[key]!.icon &&
      b[key]?.short === a[key]!.short,
  );
}

/** A stable small hash of a machine id (FNV-1a), for its default color. */
function hashMachineId(environmentId: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < environmentId.length; index += 1) {
    hash ^= environmentId.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * The color of every known machine: the one chosen for it, else a default from
 * its id, stepping past colors already taken so no two machines share one while
 * there are colors left. Machines in the nickname map settle first, from that
 * map alone, which is synced across the fleet: a device's other known machines
 * never move them, so every device shows a named machine in the same color.
 */
export function assignMachineColors(
  environmentIds: Iterable<string>,
  nicknames: MachineNicknames,
): ReadonlyMap<string, MachineColorId> {
  const named = Object.keys(nicknames).sort();
  const others = [...new Set(environmentIds)].filter((id) => !(id in nicknames)).sort();
  const colors = new Map<string, MachineColorId>();
  const taken = new Set<MachineColorId>();
  for (const id of named) {
    const chosen = nicknames[id]?.color;
    if (chosen === undefined) continue;
    colors.set(id, chosen);
    taken.add(chosen);
  }
  const count = MACHINE_COLOR_IDS.length;
  for (const id of [...named, ...others]) {
    if (colors.has(id)) continue;
    const start = hashMachineId(id) % count;
    let color = MACHINE_COLOR_IDS[start]!;
    for (let step = 0; step < count; step += 1) {
      const candidate = MACHINE_COLOR_IDS[(start + step) % count]!;
      if (!taken.has(candidate)) {
        color = candidate;
        break;
      }
    }
    colors.set(id, color);
    taken.add(color);
  }
  return colors;
}

/**
 * The stamp for a rename made now. It always beats the entry it replaces, so a
 * device whose clock runs behind the last writer's can still rename.
 */
export function nextMachineNicknameStamp(
  previous: MachineNickname | undefined,
  now: number,
): string {
  const floor = previous === undefined ? 0 : stamp(previous) + 1;
  return DateTime.formatIso(DateTime.makeUnsafe(Math.max(now, floor)));
}
