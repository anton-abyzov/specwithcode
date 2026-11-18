import {
  CLAUDE_AI_SKILL_SCOPE,
  isBuiltInAgentSkill,
  type ProjectSkillRow,
  type ProjectSkillsSnapshot,
} from "@specweave-studio/contracts";

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
 * One skill on one machine. Only `missing` says the machine was read and does
 * not have a skill it could install; an unread machine is `offline`,
 * `needs-sign-in` or `unknown`.
 */
export type SkillMatrixCell =
  | {
      readonly kind: "installed";
      readonly version: string | null;
      readonly differs: boolean;
      /** A newer version known for this skill. */
      readonly update?: string;
    }
  | { readonly kind: "missing" }
  /** A skill that comes with an agent's account: its absence is not a gap to fill. */
  | { readonly kind: "unreported" }
  | { readonly kind: "offline" }
  | { readonly kind: "needs-sign-in" }
  | { readonly kind: "unknown" };

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
  return machine.snapshot.providers.every((provider) =>
    ["ok", "unsupported"].includes(provider.state),
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

function cellFor(
  machine: SkillMatrixMachine,
  state: SkillMatrixColumnState,
  name: string,
  claudeAi: boolean,
  latest: string | undefined,
): SkillMatrixCell {
  if (state === "offline") return { kind: "offline" };
  if (state === "needs-sign-in") return { kind: "needs-sign-in" };
  if (state !== "read" && state !== "partial") return { kind: "unknown" };
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
    return {
      kind: "installed",
      version: single,
      differs: row.divergent || versions.length > 1,
      ...(latest && version && versions.length <= 1 && isNewer(latest, version)
        ? { update: latest }
        : {}),
    };
  }
  // A scan that did not finish cannot say the skill is absent.
  if (state === "partial" || availability.state !== "missing") return { kind: "unknown" };
  // What claude.ai syncs depends on the account, an older app does not read that
  // folder at all, and a folder it could not open looks the same as an empty one.
  if (claudeAi) return { kind: "unreported" };
  return { kind: "missing" };
}

/**
 * The read-only "Across machines" table: every skill any read machine reports,
 * against every machine. Installable skills come first, then the ones built
 * into an agent, each group by name.
 */
export function buildSkillMatrix(
  machines: ReadonlyArray<SkillMatrixMachine>,
  options: { readonly latest?: ReadonlyMap<string, string> } = {},
): SkillMatrix {
  const states = machines.map(columnState);
  const names = new Map<string, { builtIn: boolean; claudeAi: boolean }>();
  machines.forEach((machine, index) => {
    if (states[index] !== "read" && states[index] !== "partial") return;
    for (const row of machine.snapshot?.rows ?? []) {
      if (row.providers.length === 0) continue;
      const prior = names.get(row.name);
      const builtIn = isRowBuiltIn(row);
      const claudeAi = row.providers.every((presence) => presence.scope === CLAUDE_AI_SKILL_SCOPE);
      names.set(row.name, {
        builtIn: (prior?.builtIn ?? true) && builtIn,
        claudeAi: (prior?.claudeAi ?? true) && claudeAi,
      });
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
        cellFor(machine, states[index]!, name, kind.claudeAi, options.latest?.get(name)),
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
