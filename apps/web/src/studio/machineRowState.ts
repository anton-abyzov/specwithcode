/**
 * What one row of the machine menu says about a machine that has the project. A row has
 * exactly one state, the first that matches, and may carry notes. It never shows a role:
 * the only fact about the coordinator is which machine holds its conversation.
 * Kept free of UI imports so the menu, the fixtures and tests share one rule.
 *
 * @module machineRowState
 */
import type { CopyRole } from "./projectDomain";
import { copyRoleLabel } from "./workersOnlyCopy";

/** Words on a row: an English phrase and its `{slot}` values, translated where shown. */
export interface MachineRowText {
  readonly text: string;
  readonly values?: Readonly<Record<string, string>>;
}

/**
 * A machine's part as the menu reads it: its `copyRoles` role in a linked project,
 * `independent` for the same repository added there on its own (`orchestratorCopies`), or
 * `single` for a project that is on one machine only.
 */
export type MachineRowRole = CopyRole | "independent" | "single";

/**
 * Whether this window can show the machine. open: connected. offline: not connected now,
 * but this window holds what the machine last had. never-opened: the project lists the
 * machine and this window has never loaded it. refused: the machine refuses this window
 * (the connection stopped for good, or this build cannot talk to it).
 */
export type MachineReach = "open" | "offline" | "never-opened" | "refused";

export type MachineRowKind =
  | "cannot-open"
  | "separate"
  | "extra-coordinator"
  | "handing-off"
  | "coordinator"
  | "plain";

export interface MachineRowState {
  readonly kind: MachineRowKind;
  /** False only for a machine this window cannot open: the row is greyed. */
  readonly pressable: boolean;
  /** The row's one state in words; null for a machine with nothing to say. */
  readonly label: MachineRowText | null;
  /** The one step on the row: connect the machine, or fix its extra coordinator. */
  readonly action: "connect" | "fix" | null;
  /** Notes on a pressable row, in the order they are shown. */
  readonly notes: readonly MachineRowText[];
}

export interface MachineRowInput {
  /** The machine's name as the menu shows it. */
  readonly machine: string;
  readonly role: MachineRowRole;
  readonly reach: MachineReach;
  /** When this window last saw an offline machine, in words ("2h ago"); null when unknown. */
  readonly lastSeen?: string | null;
  /** The machine kept a coordinator conversation from before, as history. */
  readonly keptConversation?: boolean;
}

/** The row for one machine: the first state that matches, then its notes. */
export function machineRowState(input: MachineRowInput): MachineRowState {
  if (input.reach === "never-opened" || input.reach === "refused")
    return {
      kind: "cannot-open",
      pressable: false,
      label: { text: "This window cannot open {machine}", values: { machine: input.machine } },
      action: "connect",
      notes: [],
    };
  const notes: MachineRowText[] = [];
  if (input.reach === "offline")
    notes.push(
      input.lastSeen
        ? { text: "Offline · last seen {time}", values: { time: input.lastSeen } }
        : { text: "Offline" },
    );
  if (input.keptConversation) notes.push({ text: "Old conversation kept" });
  const row = (
    kind: MachineRowKind,
    label: MachineRowText | null,
    action: MachineRowState["action"] = null,
  ): MachineRowState => ({ kind, pressable: true, label, action, notes });
  switch (input.role) {
    case "independent":
      return row("separate", { text: "Separate project" });
    case "also-main":
      return row("extra-coordinator", copyRoleLabel("also-main"), "fix");
    case "moving":
      return row("handing-off", copyRoleLabel("moving"));
    case "main":
      return row("coordinator", copyRoleLabel("main"));
    case "copy":
    case "single":
      return row("plain", null);
  }
}

/**
 * The window's reach of a machine that has a row, from its connection: a machine whose
 * connection stopped for good or that this build cannot talk to refuses this window; any
 * other machine that is not connected is offline and opens what this window last saved.
 */
export function machineReach(
  connection: { readonly phase: string } | null | undefined,
): MachineReach {
  if (!connection) return "never-opened";
  if (connection.phase === "error" || connection.phase === "unsupported") return "refused";
  return connection.phase === "connected" ? "open" : "offline";
}
