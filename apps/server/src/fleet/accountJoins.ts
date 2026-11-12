// @effect-diagnostics-next-line nodeBuiltinImport:off - a random temp name keeps two writers from sharing one file.
import * as NodeCrypto from "node:crypto";
// @effect-diagnostics-next-line nodeBuiltinImport:off - the note is written owner-only through an exclusive create and an atomic rename.
import * as NodeFSP from "node:fs/promises";

import type { StudioFleetAccountJoin } from "@specweave-studio/contracts/studioFleet";
import * as DateTime from "effect/DateTime";

import { join } from "../nodePath.ts";

/**
 * Machines that joined this one through the owner's SpecWithCode Connect
 * account, newest last. Kept beside the fleet file and never inside it: older
 * builds read every key of a fleet entry strictly, and this is only a notice.
 */
export const FLEET_ACCOUNT_JOINS_FILE = "studio-fleet-account-joins.json";
/** A join older than this is no longer news. */
export const ACCOUNT_JOIN_NEWS_MS = 7 * 24 * 60 * 60 * 1000;
const KEPT = 10;

const currentMillis = () => DateTime.toEpochMillis(DateTime.nowUnsafe());
const iso = (millis: number) => DateTime.formatIso(DateTime.makeUnsafe(millis));
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function parse(value: unknown, now: number): ReadonlyArray<StudioFleetAccountJoin> {
  if (!isRecord(value) || !Array.isArray(value.joins)) return [];
  return value.joins.flatMap((entry): ReadonlyArray<StudioFleetAccountJoin> => {
    if (!isRecord(entry)) return [];
    const { id, label, joinedAt } = entry;
    if (typeof id !== "string" || typeof label !== "string" || typeof joinedAt !== "string")
      return [];
    const at = Date.parse(joinedAt);
    if (!Number.isFinite(at) || at > now || now - at > ACCOUNT_JOIN_NEWS_MS) return [];
    return [{ id, label, joinedAt: iso(at) }];
  });
}

/** The recent joins; an unreadable or missing file is no joins, never a failure. */
export async function readAccountJoins(
  baseDir: string,
  now: number = currentMillis(),
): Promise<ReadonlyArray<StudioFleetAccountJoin>> {
  try {
    const source = await NodeFSP.readFile(join(baseDir, FLEET_ACCOUNT_JOINS_FILE), "utf8");
    return parse(JSON.parse(source), now);
  } catch {
    return [];
  }
}

let writing: Promise<void> = Promise.resolve();

/**
 * Notes that a machine joined, replacing an earlier note for the same machine.
 * Written through a new file and a rename; one write at a time in this process.
 */
export function recordAccountJoin(
  baseDir: string,
  input: { readonly id: string; readonly label: string },
  now: number = currentMillis(),
): Promise<void> {
  const next = writing.then(async () => {
    const kept = (await readAccountJoins(baseDir, now)).filter((entry) => entry.id !== input.id);
    const joins = [...kept, { id: input.id, label: input.label, joinedAt: iso(now) }].slice(-KEPT);
    const target = join(baseDir, FLEET_ACCOUNT_JOINS_FILE);
    const temp = join(
      baseDir,
      `.${FLEET_ACCOUNT_JOINS_FILE}.${NodeCrypto.randomBytes(6).toString("hex")}.tmp`,
    );
    try {
      await NodeFSP.writeFile(temp, `${JSON.stringify({ joins }, null, 2)}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      await NodeFSP.rename(temp, target);
    } catch (error) {
      await NodeFSP.rm(temp, { force: true }).catch(() => undefined);
      throw error;
    }
  });
  writing = next.catch(() => undefined);
  return next;
}
