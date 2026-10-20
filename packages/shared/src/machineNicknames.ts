import {
  MACHINE_NICKNAME_MAX_LENGTH,
  type MachineNickname,
  type MachineNicknames,
} from "@specweave-studio/contracts";
import { DateTime } from "effect";

/** Trims, collapses inner whitespace and caps a typed name at 16 characters. */
export function normalizeMachineNickname(name: string): string {
  return name.trim().replace(/\s+/g, " ").slice(0, MACHINE_NICKNAME_MAX_LENGTH).trim();
}

const stamp = (entry: MachineNickname): number => {
  const parsed = Date.parse(entry.updatedAt);
  return Number.isFinite(parsed) ? parsed : 0;
};

/**
 * Last writer wins. Equal stamps fall back to the name so every machine
 * picks the same entry whichever order the renames arrive in.
 */
export function newerMachineNickname(
  current: MachineNickname | undefined,
  incoming: MachineNickname | undefined,
): MachineNickname | undefined {
  if (incoming === undefined) return current;
  if (current === undefined) return incoming;
  const difference = stamp(incoming) - stamp(current);
  if (difference !== 0) return difference > 0 ? incoming : current;
  return incoming.name > current.name ? incoming : current;
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
    (key) => b[key]?.name === a[key]!.name && b[key]?.updatedAt === a[key]!.updatedAt,
  );
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
