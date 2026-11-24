/**
 * "Use my Percy on <machine>" (1448 D-12 to D-16): what the switch, its
 * confirmation and the machines table say and send. Pure: the calls themselves
 * are in `personalShareCommands.ts`.
 *
 * @module personalShare
 */
import type {
  EnvironmentId,
  PersonalLinkSetSharedInput,
  PersonalShareMachineState,
  PersonalShareStatus,
} from "@specweave-studio/contracts";

/** The switch's anchor in Settings > General; the sidebar offer links to it. */
export const PERCY_SHARED_SETTING_ID = "percy-shared";

/** What the switch does, shown under it. */
export const PERCY_SHARED_DESCRIPTION =
  "Percy's memory, instructions, name and attached repositories are kept the same on every machine of your Connect account that has this switch on. Chats started on {machine} can be listed and opened on those machines and on phones you allowed there. Gmail, Calendar and Drive access stays with each machine.";

/** A sentence and its values, translated where it is shown. */
export interface Phrase {
  readonly text: string;
  readonly values?: Readonly<Record<string, string>>;
}

/** Another machine's state for the shared Percy, in a person's words. */
export function shareMachineStateText(state: PersonalShareMachineState, machine: string): Phrase {
  switch (state) {
    case "joined":
      return { text: "On" };
    case "waiting":
      return { text: "Waiting for {machine} to answer", values: { machine } };
    case "switch_off":
      return { text: "Off" };
    case "not_confirmed":
      return { text: "Not added on this machine yet" };
    case "no_grant":
      return { text: "Not allowed to run work with this machine yet" };
    case "legacy_grant":
      return { text: "Not one of your own machines' grants" };
    case "other_account":
      return { text: "Signed in to another Connect account" };
    case "older_version":
      return { text: "Needs an update" };
    case "offline":
      return { text: "Offline" };
  }
}

/** Why the switch cannot be turned on, with the way out; null when it can. */
export function shareRefusalText(
  refusal: PersonalShareStatus["refusal"],
  machine: string,
): Phrase | null {
  switch (refusal) {
    case "not_connected":
      return {
        text: "Sign in to SpecWithCode Connect on {machine} first: Percy belongs to your Connect account.",
        values: { machine },
      };
    case "assistant_off":
      return { text: "Turn the personal assistant on above first." };
    case null:
      return null;
  }
}

/** Why this window cannot change the switch, or null when it can. */
export function shareAccessBlockedText(
  access: "granted" | "denied" | "signed-out" | "unknown" | "no-machine",
  machine: string,
): Phrase | null {
  switch (access) {
    case "granted":
      return null;
    case "denied":
      return {
        text: "This connection cannot change settings on {machine}. Turn it on in the app on {machine}.",
        values: { machine },
      };
    case "signed-out":
      return {
        text: "This window is signed out of {machine}. Reload the page to sign in again.",
        values: { machine },
      };
    case "unknown":
      return {
        text: "Waiting to confirm this window's access to {machine}.",
        values: { machine },
      };
    case "no-machine":
      return {
        text: "This window has no machine of its own. Open SpecWithCode on a machine and turn it on in Settings > General there.",
      };
  }
}

/** One machine's assistant, as far as the confirmation needs it. */
export interface ShareSeat {
  readonly environmentId: string;
  readonly title: string;
  /** Already in a link with another machine. */
  readonly linked: boolean;
  /** From `personalLink.preview`; null when it could not be read. */
  readonly memoryFileCount: number | null;
}

/**
 * Where the link starts (1448 D-15). `join`: a link exists, nothing to choose.
 * `choose`: two or more separate assistants, so the owner picks whose name,
 * instructions and repositories lead. `single`: the only assistant leads.
 * `new`: no assistant anywhere, this machine makes the first.
 */
export type ShareStartPlan =
  | { readonly kind: "join" }
  | {
      readonly kind: "choose";
      readonly options: readonly ShareSeat[];
      readonly defaultEnvironmentId: string;
      readonly defaultName: string;
    }
  | { readonly kind: "single"; readonly environmentId: string }
  | { readonly kind: "new"; readonly environmentId: string };

export const DEFAULT_SHARED_ASSISTANT_NAME = "Percy";

/** Whether the window can make this seat the start: this machine, or one it may change. */
export const shareSeatStartable = (
  ownEnvironmentId: string,
  writable: ReadonlySet<string>,
  environmentId: string,
): boolean => environmentId === ownEnvironmentId || writable.has(environmentId);

export function shareStartPlan(input: {
  readonly ownEnvironmentId: string;
  /** The assistants of this machine and of every ticked machine. */
  readonly seats: readonly ShareSeat[];
  /** Machines whose settings the window may change; only those and this one can be the default. */
  readonly writable?: ReadonlySet<string>;
}): ShareStartPlan {
  const { seats } = input;
  if (seats.some((seat) => seat.linked)) return { kind: "join" };
  if (seats.length === 0) return { kind: "new", environmentId: input.ownEnvironmentId };
  if (seats.length === 1) return { kind: "single", environmentId: seats[0]!.environmentId };
  // The most memory files leads among the seats the window can start from;
  // this machine wins a tie, then the first listed.
  const startable =
    input.writable === undefined
      ? seats
      : seats.filter((seat) =>
          shareSeatStartable(input.ownEnvironmentId, input.writable!, seat.environmentId),
        );
  const leading = startable.length > 0 ? startable : seats;
  let lead = leading[0]!;
  for (const seat of leading) {
    const more = (seat.memoryFileCount ?? -1) - (lead.memoryFileCount ?? -1);
    if (
      more > 0 ||
      (more === 0 &&
        seat.environmentId === input.ownEnvironmentId &&
        lead.environmentId !== input.ownEnvironmentId)
    )
      lead = seat;
  }
  const names = new Set(seats.map((seat) => seat.title.trim()));
  return {
    kind: "choose",
    options: seats,
    defaultEnvironmentId: lead.environmentId,
    defaultName:
      names.size === 1
        ? [...names][0]! || DEFAULT_SHARED_ASSISTANT_NAME
        : DEFAULT_SHARED_ASSISTANT_NAME,
  };
}

export interface ShareCall {
  readonly environmentId: EnvironmentId;
  readonly input: PersonalLinkSetSharedInput;
}

/**
 * The machines another machine has confirmed, as its own
 * `personalLink.shareStatus` lists them: every one except a machine it reports
 * as not added there. What the window sends it keeps all of these, so a turn
 * on from here never takes back what the owner confirmed on that machine.
 */
export function confirmedMachinesOf(status: PersonalShareStatus): EnvironmentId[] {
  // The machine's own stored list, when its build sends it.
  if (status.confirmedMachines !== undefined) return [...status.confirmedMachines];
  return status.machines
    .filter((machine) => machine.state !== "not_confirmed")
    .map((machine) => machine.environmentId);
}

/** A machine's list with machines added: each once, kept in order, never the machine itself. */
export function withConfirmedMachines(
  self: EnvironmentId,
  existing: readonly EnvironmentId[],
  adding: readonly EnvironmentId[],
): EnvironmentId[] {
  return [...new Set([...existing, ...adding])].filter((id) => id !== self);
}

/**
 * The `personalLink.setShared` calls one confirmation makes: this machine
 * first, then every ticked machine the window can change. This machine gets
 * exactly the ticked machines. Another machine keeps the machines it already
 * confirmed (`remoteMachines`, read from it just before) and gets this machine
 * and the other ticked ones added; one whose list could not be read is left
 * as it is and named in `unread`. The machine the link starts from gets
 * `start: true` and the name; the others get `start: false`. With no start (a
 * link exists), or a start on a machine the window cannot change, `start` is
 * left out so each machine keeps its value. `manual` are ticked machines the
 * window cannot change: the owner turns those on in their own Settings.
 */
export function shareConfirmCalls(input: {
  readonly ownEnvironmentId: EnvironmentId;
  readonly ticked: readonly EnvironmentId[];
  readonly writable: ReadonlySet<string>;
  /** Each writable ticked machine's confirmed machines, from its own status. */
  readonly remoteMachines: ReadonlyMap<string, readonly EnvironmentId[]>;
  readonly startEnvironmentId: string | null;
  readonly name: string | null;
}): {
  readonly calls: readonly ShareCall[];
  readonly manual: readonly EnvironmentId[];
  readonly unread: readonly EnvironmentId[];
} {
  const own = input.ownEnvironmentId;
  const ticked = [...new Set(input.ticked)].filter((id) => id !== own);
  const reachable = ticked.filter((id) => input.writable.has(id));
  const name = input.name?.trim() ?? "";
  // A start the window cannot write is never sent: each machine keeps its own value.
  const start =
    input.startEnvironmentId !== null &&
    shareSeatStartable(own, new Set(reachable), input.startEnvironmentId)
      ? input.startEnvironmentId
      : null;
  const callFor = (environmentId: EnvironmentId, machines: EnvironmentId[]): ShareCall => {
    const starts = environmentId === start;
    return {
      environmentId,
      input: {
        enabled: true,
        machines,
        ...(start === null ? {} : { start: starts }),
        ...(starts && name.length > 0 ? { name } : {}),
      },
    };
  };
  const unread = reachable.filter((id) => !input.remoteMachines.has(id));
  return {
    calls: [
      callFor(own, ticked),
      ...reachable.flatMap((id) => {
        const existing = input.remoteMachines.get(id);
        return existing === undefined
          ? []
          : [callFor(id, withConfirmedMachines(id, existing, [own, ...ticked]))];
      }),
    ],
    manual: ticked.filter((id) => !input.writable.has(id)),
    unread,
  };
}

/** What a row of the machines table offers: turn it on from here, or say where to. */
export type ShareRowAction = "turn-on" | "manual" | null;

export interface ShareMachineRow {
  readonly environmentId: string;
  readonly label: string;
  readonly own: boolean;
  readonly state: Phrase;
  readonly on: boolean;
  readonly detail: string | null;
  readonly runsRoutines: boolean;
  readonly lastSyncedAt: string | null;
  readonly action: ShareRowAction;
}

/**
 * The machines table: this machine first, then every machine its server
 * names. A machine whose switch is off or that is not added here can be
 * turned on from this window when the window may change its settings;
 * otherwise the row says to do it there (1448 AC-22).
 */
export function shareMachineRows(input: {
  readonly status: PersonalShareStatus;
  readonly labelOf: (environmentId: string, fallback: string | null) => string;
  /** The machine that runs the link's routines, as the window's project list knows it. */
  readonly runnerEnvironmentId: string | null;
  readonly canTurnOn: (environmentId: string) => boolean;
}): ShareMachineRow[] {
  const { status } = input;
  const runner =
    status.routineOwner && status.linked ? status.environmentId : input.runnerEnvironmentId;
  const newest = status.machines
    .flatMap((machine) => (machine.lastSyncedAt ? [machine.lastSyncedAt] : []))
    .toSorted()
    .at(-1);
  const own: ShareMachineRow = {
    environmentId: status.environmentId,
    label: input.labelOf(status.environmentId, status.machineLabel),
    own: true,
    state: { text: status.enabled ? "On" : "Off" },
    on: status.enabled,
    detail: null,
    runsRoutines: status.enabled && runner === status.environmentId,
    lastSyncedAt: status.enabled ? (newest ?? null) : null,
    action: null,
  };
  const others = status.machines
    .filter((machine) => machine.environmentId !== status.environmentId)
    .map((machine): ShareMachineRow => {
      const label = input.labelOf(machine.environmentId, machine.label);
      const offered = machine.state === "switch_off" || machine.state === "not_confirmed";
      return {
        environmentId: machine.environmentId,
        label,
        own: false,
        state: shareMachineStateText(machine.state, label),
        on: machine.state === "joined",
        detail: machine.detail ?? null,
        runsRoutines: machine.state === "joined" && runner === machine.environmentId,
        lastSyncedAt: machine.lastSyncedAt ?? null,
        action: offered ? (input.canTurnOn(machine.environmentId) ? "turn-on" : "manual") : null,
      };
    });
  return [own, ...others];
}

type RestorePoint = PersonalShareStatus["restorePoints"][number];

const newestPoint = (
  status: PersonalShareStatus | null,
  reason: RestorePoint["reason"],
): RestorePoint | null =>
  (status?.restorePoints ?? [])
    .filter((point) => point.reason === reason)
    .toSorted((a, b) => a.savedAt.localeCompare(b.savedAt))
    .at(-1) ?? null;

/** The newest copy saved before a link: what "Undo the merge" goes back to. */
export function newestBeforeLinkRestorePoint(
  status: PersonalShareStatus | null,
): RestorePoint | null {
  return newestPoint(status, "before-link");
}

/**
 * What Settings offers to put back on this machine (1448 D-16, AC-19), and
 * the copy it sends to `personalLink.undo`. `undo-merge` goes back to the
 * newest copy saved before a link: offered while the switch is on or a link
 * exists, and while the switch is off with no undo since that copy. `put-back`
 * goes back to the newest copy saved before an undo: offered once an undo is
 * the last thing done here, so the state the undo replaced can return.
 */
export type ShareRestoreAction =
  | { readonly kind: "undo-merge"; readonly point: RestorePoint }
  | { readonly kind: "put-back"; readonly point: RestorePoint };

export function shareRestoreAction(status: PersonalShareStatus | null): ShareRestoreAction | null {
  if (status === null) return null;
  const beforeLink = newestPoint(status, "before-link");
  const beforeUndo = newestPoint(status, "before-undo");
  if (status.enabled || status.linked)
    return beforeLink ? { kind: "undo-merge", point: beforeLink } : null;
  if (beforeUndo && (beforeLink === null || beforeUndo.savedAt > beforeLink.savedAt))
    return { kind: "put-back", point: beforeUndo };
  return beforeLink ? { kind: "undo-merge", point: beforeLink } : null;
}
