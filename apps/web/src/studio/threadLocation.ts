/**
 * Where a thread lives and where it runs, for thread lists: "M4" when one
 * machine does both, "M4 → Minis" once execution moved. Ownership never moves
 * (handoff moves execution only), so the first name is always the owner.
 */
import {
  formatUnknownExecution,
  resolveThreadExecution,
  type EnvironmentId,
  type ThreadExecutionState,
  type ThreadExecutionSummary,
} from "@specweave-studio/contracts";

export interface ThreadLocation {
  readonly ownerMachineId: string;
  readonly executionMachineId: string;
  readonly state: ThreadExecutionState;
  /** It runs on a machine other than the one it lives on. */
  readonly moved: boolean;
  /** The row chip: "M4", or "M4 → Minis". */
  readonly label: string;
  /** The tooltip and screen reader text. */
  readonly description: string;
}

export interface ThreadLocationInput {
  /** The thread shell's execution fields; absent fields mean the serving machine does both. */
  readonly summary: ThreadExecutionSummary | null | undefined;
  /** The machine this shell came from. */
  readonly servingEnvironmentId: string;
  /** A machine's short name (its nickname once the user set one). */
  readonly name: (environmentId: string, fallbackLabel?: string | null) => string;
  /** A machine's full name for the tooltip; defaults to `name`. */
  readonly fullName?: (environmentId: string, fallbackLabel?: string | null) => string;
  /** Machines this device cannot reach now. The serving machine's own state is the row's to show. */
  readonly unreachable?: ReadonlySet<string>;
  /** Formats `executionLastSeenAt` for "last seen 2:14 PM"; the local clock by default. */
  readonly formatTime?: (iso: string) => string;
}

const clockTime = (iso: string) =>
  new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

export function threadLocation(input: ThreadLocationInput): ThreadLocation {
  const serving = input.servingEnvironmentId as EnvironmentId;
  const resolved = resolveThreadExecution(input.summary ?? {}, serving, (environmentId) => ({
    reachable: environmentId === serving || !(input.unreachable?.has(environmentId) ?? false),
    lastSeenAt: null,
  }));
  const runnerLabel = resolved.executionMachineLabel;
  const shortOwner = input.name(resolved.ownerMachineId);
  const shortRunner = input.name(resolved.executionMachineId, runnerLabel);
  const full = input.fullName ?? input.name;
  const owner = full(resolved.ownerMachineId);
  const runner = full(resolved.executionMachineId, runnerLabel);
  const moved = resolved.ownerMachineId !== resolved.executionMachineId;
  const base = {
    ownerMachineId: resolved.ownerMachineId,
    executionMachineId: resolved.executionMachineId,
    state: resolved.executionState,
    moved,
    label: moved ? `${shortOwner} → ${shortRunner}` : shortOwner,
  };
  const lives = moved ? `Lives on ${owner}` : `Lives and runs on ${owner}`;
  switch (resolved.executionState) {
    case "fenced":
      return { ...base, description: `${lives} · handed off, ${runner} runs it now` };
    case "unknown": {
      const lastSeen = resolved.executionLastSeenAt;
      const unknown = formatUnknownExecution(
        runner,
        lastSeen === null ? null : (input.formatTime ?? clockTime)(lastSeen),
      );
      return { ...base, description: `Lives on ${owner} · ${unknown}` };
    }
    case "running":
      return { ...base, description: moved ? `${lives} · runs on ${runner}` : lives };
  }
}
