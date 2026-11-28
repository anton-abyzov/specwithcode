/**
 * What one row of the machine menu says about a machine that has the project. A row has
 * exactly one state, the first that matches, and may carry notes. It never shows a role:
 * every machine that has the project runs its own coordinator, so the rows are equals.
 * Kept free of UI imports so the menu, the fixtures and tests share one rule.
 *
 * @module machineRowState
 */

/** Words on a row: an English phrase and its `{slot}` values, translated where shown. */
export interface MachineRowText {
  readonly text: string;
  readonly values?: Readonly<Record<string, string>>;
}

/**
 * What a machine is to the project: `linked` for a machine of this project, `independent`
 * for the same repository added there on its own (`orchestratorCopies`), or `single` for a
 * project that is on one machine only.
 */
export type MachineRowRole = "linked" | "independent" | "single";

/**
 * Whether this window can show the machine. open: connected. offline: not connected now,
 * but this window holds what the machine last had. never-opened: the project lists the
 * machine and this window has never loaded it. refused: the machine refuses this window
 * (the connection stopped for good, or this build cannot talk to it).
 */
export type MachineReach = "open" | "offline" | "never-opened" | "refused";

export type MachineRowKind = "cannot-open" | "separate" | "plain";

/**
 * What `projectSync.status` says of a project on one machine: per repository its
 * checked-out commit and whether its working tree is clean. A local Git read, no network.
 */
export interface MachineSyncStatus {
  readonly repositories: ReadonlyArray<{
    readonly path: string;
    readonly head: string | null;
    readonly clean: boolean;
    /** The machine could not read this checkout. */
    readonly unread?: boolean | undefined;
  }>;
  /** The folder could not be scanned in full, so repositories may be missing from the list. */
  readonly scanLimited: boolean;
}

/** The one sync fact of a row: how that machine's repositories compare with the machine shown. */
export interface MachineSyncFact extends MachineRowText {
  readonly tone: "same" | "differs" | "unknown";
}

/**
 * Compares, repository by repository, a machine with the machine shown. "Same" only when
 * every repository is at the same commit on both and both working trees are clean; a
 * repository only one of them has differs. Without a status for both it is "Not checked
 * yet", never a guess, and a folder that could not be scanned in full is never "same".
 * `asOf` is set for an offline machine: the status is the last one read in this session.
 */
export function machineSyncFact(input: {
  readonly shown: MachineSyncStatus | null;
  readonly other: MachineSyncStatus | null;
  /** The machine shown, as the menu names it. */
  readonly shownName: string;
  readonly asOf?: string | null;
}): MachineSyncFact {
  const { shown, other } = input;
  if (!shown || !other) return { tone: "unknown", text: "Not checked yet" };
  const here = new Map(shown.repositories.map((item) => [item.path, item]));
  const there = new Map(other.repositories.map((item) => [item.path, item]));
  const paths = new Set([...here.keys(), ...there.keys()]);
  // What a machine could not read is no difference and no sameness: it is not known.
  if ([...here.values(), ...there.values()].some((item) => item.unread === true))
    return { tone: "unknown", text: "Could not compare: a repository could not be read" };
  let differ = 0;
  for (const path of paths) {
    const a = here.get(path);
    const b = there.get(path);
    if (!a || !b || a.head === null || a.head !== b.head || !a.clean || !b.clean) differ += 1;
  }
  const asOf = input.asOf ?? null;
  if (differ > 0) {
    const values = { k: String(differ), n: String(paths.size) };
    return asOf
      ? {
          tone: "differs",
          text: "{k} of {n} repositories differ · as of {time}",
          values: { ...values, time: asOf },
        }
      : { tone: "differs", text: "{k} of {n} repositories differ", values };
  }
  if (shown.scanLimited || other.scanLimited || paths.size === 0)
    return { tone: "unknown", text: "Not checked yet" };
  return asOf
    ? {
        tone: "same",
        text: "Same as {shown} · as of {time}",
        values: { shown: input.shownName, time: asOf },
      }
    : { tone: "same", text: "Same as {shown}", values: { shown: input.shownName } };
}

export interface MachineRowState {
  readonly kind: MachineRowKind;
  /** False only for a machine this window cannot open: the row is greyed. */
  readonly pressable: boolean;
  /** The row's one state in words; null for a machine with nothing to say. */
  readonly label: MachineRowText | null;
  /** The one step on the row: connect the machine. */
  readonly action: "connect" | null;
  /** Notes on a pressable row, in the order they are shown. */
  readonly notes: readonly MachineRowText[];
  /**
   * The row's sync fact; null for the machine shown, for a machine this window cannot open
   * and wherever the caller passes none.
   */
  readonly sync: MachineSyncFact | null;
  /** The machine this window is served by: its row says "this window" (1427). */
  readonly window?: true;
}

export interface MachineRowInput {
  /** The machine's name as the menu shows it. */
  readonly machine: string;
  readonly role: MachineRowRole;
  readonly reach: MachineReach;
  /** When this window last saw an offline machine, in words ("2h ago"); null when unknown. */
  readonly lastSeen?: string | null;
  /** The sync fact of a row for another machine than the one shown. */
  readonly sync?: MachineSyncFact | null;
  /**
   * The machine's app answered that it does not know Sync: it is from before it. Its
   * version when the window knows it.
   */
  readonly needsUpdate?: { readonly version: string | null } | null;
  /** This window is served by the machine. */
  readonly window?: boolean;
  /**
   * Why this window cannot open the machine, or what it waits for (`machineRowReason`):
   * the label of a row it cannot open, the first note of an offline row.
   */
  readonly reason?: MachineRowText | null;
}

/** The row for one machine: the first state that matches, then its notes. */
export function machineRowState(input: MachineRowInput): MachineRowState {
  if (input.reach === "never-opened" || input.reach === "refused")
    return {
      kind: "cannot-open",
      pressable: false,
      label: input.reason ?? {
        text: "This window cannot open {machine}",
        values: { machine: input.machine },
      },
      action: "connect",
      notes: [],
      sync: null,
    };
  const notes: MachineRowText[] = [];
  if (input.reach === "offline" && input.reason) notes.push(input.reason);
  if (input.reach === "offline")
    notes.push(
      input.lastSeen
        ? { text: "Offline · last seen {time}", values: { time: input.lastSeen } }
        : { text: "Offline" },
    );
  if (input.needsUpdate)
    notes.push(
      input.needsUpdate.version
        ? { text: "Needs update · {version}", values: { version: input.needsUpdate.version } }
        : { text: "Needs update" },
    );
  const row = (
    kind: MachineRowKind,
    label: MachineRowText | null,
    action: MachineRowState["action"] = null,
  ): MachineRowState => ({
    kind,
    pressable: true,
    label,
    action,
    notes,
    sync: input.sync ?? null,
    ...(input.window === true ? { window: true as const } : {}),
  });
  switch (input.role) {
    case "independent":
      return row("separate", { text: "Separate project" });
    case "linked":
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

/** The words a row uses to say why it cannot open a machine; each is in every phrase catalog. */
export const MACHINE_ROW_REASONS = {
  connecting: "Connecting to {machine}…",
  failed: "Could not connect to {machine}. Choose Connect… to try again.",
  approval: "Waiting for approval: type {code} on {machine} or on a device it allows",
  relayOffline: "{machine} is offline on SpecWithCode Connect",
  pressConnect: "Choose Connect… to open {machine}",
  signIn: "Sign in to SpecWithCode Connect on this device to open {machine}",
} as const;

/**
 * What SpecWithCode Connect says of the machine for this device: `online` or `offline` when
 * its account lists the machine, `signed-out` when this device lists no machine there,
 * `unknown` while it looks or when the account does not list the machine.
 */
export type MachineRelayState = "online" | "offline" | "signed-out" | "unknown";

/**
 * Why a row cannot open its machine, in words a phone can act on (1517): the device waits
 * for approval there (with the code to type), it is connecting, the last try failed, the
 * machine is offline on Connect, Connect… opens it, or this device must sign in to Connect.
 * An offline row only says it waits for approval; null leaves the row as it was.
 */
export function machineRowReason(input: {
  readonly machine: string;
  readonly reach: MachineReach;
  /** The code the machine waits for, when it holds this device for approval. */
  readonly approvalCode?: string | null;
  readonly connecting?: boolean;
  readonly failed?: boolean;
  readonly relay: MachineRelayState;
}): MachineRowText | null {
  const machine = { machine: input.machine };
  if (input.reach === "open") return null;
  if (input.approvalCode)
    return { text: MACHINE_ROW_REASONS.approval, values: { ...machine, code: input.approvalCode } };
  if (input.reach === "offline") return null;
  if (input.connecting) return { text: MACHINE_ROW_REASONS.connecting, values: machine };
  if (input.failed) return { text: MACHINE_ROW_REASONS.failed, values: machine };
  switch (input.relay) {
    case "offline":
      return { text: MACHINE_ROW_REASONS.relayOffline, values: machine };
    case "online":
      return { text: MACHINE_ROW_REASONS.pressConnect, values: machine };
    case "signed-out":
      return { text: MACHINE_ROW_REASONS.signIn, values: machine };
    case "unknown":
      return null;
  }
}
