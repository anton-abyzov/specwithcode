import {
  isBuiltInAgentSkill,
  type ProjectSkillRow,
  type ProjectSkillsSnapshot,
} from "@specweave-studio/contracts";

import { normalizeSearchText } from "~/lib/utils";
import { projectSkillLevel } from "../settings/ProjectSkillsSettings.logic";
import { skillAvailabilityState } from "./SkillAvailability";

/** One machine's read of its own skills, as "Available on" already makes it. */
export interface SkillMatrixMachine {
  readonly id: string;
  readonly label: string;
  /** The machine the page is set up for. */
  readonly current: boolean;
  /** False when no project on that machine can carry the read. */
  readonly linked: boolean;
  readonly connected: boolean;
  readonly error: string | null;
  readonly pending: boolean;
  readonly successful: boolean;
  readonly snapshot: ProjectSkillsSnapshot | null;
}

/**
 * Why a machine's answer about one skill is not known:
 * `checking` a read is running, `unlinked` no project there can carry the read,
 * `failed` the read failed, `incomplete` the read answered but some agent or
 * skill folder did not, so a skill it does not list may still be there.
 */
export type SkillMatrixUnknownReason =
  | "checking"
  | "unlinked"
  | "failed"
  | "incomplete"
  /** An agent there keeps one machine-wide list and its folders were not scanned. */
  | "machine-list";

/**
 * One skill on one machine. Only `missing` says the machine was read and does
 * not have a skill it could install; an unread machine is `offline`,
 * `needs-sign-in` or `unknown` with its reason.
 */
export type SkillMatrixCell =
  | {
      readonly kind: "installed";
      readonly version: string | null;
      readonly differs: boolean;
      /** Levels the copies sit at there, such as `project` and `user`; absent when none is known. */
      readonly scopes?: ReadonlyArray<string>;
      /** A newer version known for this skill. */
      readonly update?: string;
    }
  | { readonly kind: "missing" }
  /** A skill that comes with an agent or its account: its absence is not a gap to fill. */
  | { readonly kind: "unreported" }
  | { readonly kind: "offline" }
  | { readonly kind: "needs-sign-in" }
  | { readonly kind: "unknown"; readonly reason: SkillMatrixUnknownReason };

export type SkillMatrixColumnState =
  | "read"
  | "partial"
  | "checking"
  | "offline"
  | "unlinked"
  | "needs-sign-in"
  | "failed";

export interface SkillMatrixColumn {
  readonly id: string;
  readonly label: string;
  readonly current: boolean;
  readonly state: SkillMatrixColumnState;
  /** When that machine read its skills; null when it was not read. */
  readonly readAt: string | null;
}

export interface SkillMatrixRow {
  readonly name: string;
  /** Ships with the agent or its account on every machine that has it. */
  readonly builtIn: boolean;
  readonly cells: ReadonlyArray<SkillMatrixCell>;
}

export interface SkillMatrix {
  readonly columns: ReadonlyArray<SkillMatrixColumn>;
  readonly rows: ReadonlyArray<SkillMatrixRow>;
}

const SIGN_IN = /sign[- ]?in|signed in|unauthori[sz]ed|\b401\b/i;

function columnState(machine: SkillMatrixMachine): SkillMatrixColumnState {
  if (!machine.connected) return "offline";
  if (!machine.linked) return "unlinked";
  if (machine.error) return SIGN_IN.test(machine.error) ? "needs-sign-in" : "failed";
  if (machine.pending || !machine.successful || !machine.snapshot) return "checking";
  // A scan that could not open some skill folders reads like an unfinished one.
  return machine.snapshot.providers.every(
    (provider) => ["ok", "unsupported"].includes(provider.state) && provider.incomplete !== true,
  )
    ? "read"
    : "partial";
}

const isRowBuiltIn = (row: ProjectSkillRow) =>
  row.providers.length > 0 && row.providers.every((presence) => isBuiltInAgentSkill(presence));

/** `1.10.0` is newer than `1.9.2`; anything that is not dotted numbers never compares. */
function isNewer(candidate: string, installed: string): boolean {
  const parse = (value: string) =>
    /^\d+(\.\d+)*$/.test(value.trim()) ? value.trim().split(".").map(Number) : null;
  const next = parse(candidate);
  const current = parse(installed);
  if (!next || !current) return false;
  for (let index = 0; index < Math.max(next.length, current.length); index += 1) {
    const delta = (next[index] ?? 0) - (current[index] ?? 0);
    if (delta !== 0) return delta > 0;
  }
  return false;
}

const LEVEL_RANK = ["project", "user", "plugin", "bundled", "system"];

/** The levels a row's copies sit at, project first; levels the agent did not name are left out. */
function scopesOf(row: ProjectSkillRow): ReadonlyArray<string> {
  const levels = new Set(
    row.providers.map((presence) => projectSkillLevel(presence.scope, presence.path)),
  );
  levels.delete("other");
  levels.delete("agent");
  const rank = (level: string) => {
    const index = LEVEL_RANK.indexOf(level);
    return index === -1 ? LEVEL_RANK.length : index;
  };
  return [...levels].toSorted(
    (left, right) => rank(left) - rank(right) || left.localeCompare(right),
  );
}

function cellFor(
  machine: SkillMatrixMachine,
  state: SkillMatrixColumnState,
  name: string,
  builtIn: boolean,
  latest: string | undefined,
): SkillMatrixCell {
  if (state === "offline") return { kind: "offline" };
  if (state === "needs-sign-in") return { kind: "needs-sign-in" };
  if (state === "checking" || state === "unlinked" || state === "failed")
    return { kind: "unknown", reason: state };
  if (state !== "read" && state !== "partial") return { kind: "unknown", reason: "failed" };
  const availability = skillAvailabilityState({
    connected: true,
    error: null,
    successful: true,
    pending: false,
    snapshot: machine.snapshot,
    name,
    skillId: null,
  });
  const row = availability.row;
  if (row && row.providers.length > 0) {
    const versions = [
      ...new Set(row.providers.map((presence) => presence.fileVersion).filter(Boolean)),
    ];
    const version = versions.length === 1 ? versions[0]! : (row.lock?.version ?? null);
    const single = versions.length <= 1 ? version : versions.join(" / ");
    const scopes = scopesOf(row);
    return {
      kind: "installed",
      version: single,
      differs: row.divergent || versions.length > 1,
      ...(scopes.length > 0 ? { scopes } : {}),
      ...(latest && version && versions.length <= 1 && isNewer(latest, version)
        ? { update: latest }
        : {}),
    };
  }
  // A scan that did not finish cannot say the skill is absent.
  if (state === "partial" || availability.state !== "missing")
    return { kind: "unknown", reason: "incomplete" };
  // What ships with an agent depends on its version and account (claude.ai sync,
  // Codex system skills), and an older app does not read those folders at all:
  // nobody can install one, so its absence is never "Not on".
  if (builtIn) return { kind: "unreported" };
  // An agent that keeps one list for the whole machine, whose folders the app
  // did not scan either, may hold the skill for this folder without saying so.
  if (
    machine.snapshot?.providers.some(
      (provider) => provider.state === "unsupported" && provider.discovery !== "folder-scan",
    )
  )
    return { kind: "unknown", reason: "machine-list" };
  return { kind: "missing" };
}

/**
 * The read-only "Across machines" table: every skill any read machine reports,
 * against every machine. Installable skills come first, then the ones built
 * into an agent, each group by name.
 */
export function buildSkillMatrix(
  machines: ReadonlyArray<SkillMatrixMachine>,
  /** Newer versions in the current machine's sources; applied to its column only. */
  options: { readonly latest?: ReadonlyMap<string, string> } = {},
): SkillMatrix {
  const states = machines.map(columnState);
  const names = new Map<string, { builtIn: boolean }>();
  machines.forEach((machine, index) => {
    if (states[index] !== "read" && states[index] !== "partial") return;
    for (const row of machine.snapshot?.rows ?? []) {
      if (row.providers.length === 0) continue;
      const prior = names.get(row.name);
      // Built in only when every machine that has it got it from an agent.
      names.set(row.name, { builtIn: (prior?.builtIn ?? true) && isRowBuiltIn(row) });
    }
  });
  const rows = [...names.entries()]
    .sort(
      ([leftName, left], [rightName, right]) =>
        Number(left.builtIn) - Number(right.builtIn) || leftName.localeCompare(rightName),
    )
    .map(([name, kind]) => ({
      name,
      builtIn: kind.builtIn,
      cells: machines.map((machine, index) =>
        cellFor(
          machine,
          states[index]!,
          name,
          kind.builtIn,
          // The versions come from this machine's own sources; another machine may track
          // a different repo or a pin, so its column never borrows them.
          machine.current ? options.latest?.get(name) : undefined,
        ),
      ),
    }));
  return {
    columns: machines.map((machine, index) => ({
      id: machine.id,
      label: machine.label,
      current: machine.current,
      state: states[index]!,
      readAt:
        states[index] === "read" || states[index] === "partial"
          ? (machine.snapshot?.checkedAt ?? null)
          : null,
    })),
    rows,
  };
}

/**
 * Rows whose name holds every word of `query`. Run it on the whole matrix, then
 * page the result, so a skill on a later page is still found.
 */
export function filterSkillMatrixRows(
  rows: ReadonlyArray<SkillMatrixRow>,
  query: string,
): ReadonlyArray<SkillMatrixRow> {
  const tokens = normalizeSearchText(query).split(" ").filter(Boolean);
  if (tokens.length === 0) return rows;
  return rows.filter((row) => {
    const haystack = normalizeSearchText(row.name);
    return tokens.every((token) => haystack.includes(token));
  });
}
