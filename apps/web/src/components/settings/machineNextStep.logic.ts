/**
 * What Settings > Machines says about this machine before anything else: its
 * link to SpecWithCode Connect, its role, its version, three facts, and the one
 * step to take next. Pure, so the page, the phone card and their tests agree.
 */

/** This machine's link to SpecWithCode Connect. */
export type MachineConnect =
  /** A build without SpecWithCode Connect. */
  | { readonly kind: "unavailable" }
  | { readonly kind: "loading" }
  /** The link could not be read, so the page does not guess. */
  | { readonly kind: "unknown" }
  | { readonly kind: "signed-out" }
  | { readonly kind: "off"; readonly account: string | null }
  | { readonly kind: "on"; readonly account: string | null };

export function machineConnect(input: {
  /** SpecWithCode Connect is configured in this build. */
  readonly configured: boolean;
  readonly authLoaded: boolean;
  readonly signedIn: boolean;
  /** The email the account shows, when the sign-in carries one. */
  readonly account: string | null;
  /** The machine's own link state; null while unread or unreadable. */
  readonly link: {
    readonly linked: boolean;
    readonly managedTunnelActive?: boolean | undefined;
  } | null;
  /** The link state is being read for the first time. */
  readonly linkPending: boolean;
}): MachineConnect {
  if (!input.configured) return { kind: "unavailable" };
  const account = input.signedIn ? input.account : null;
  // The machine says it is on: true whoever is signed in to this window.
  // A server from before the field links only with its own tunnel.
  if (input.link && (input.link.managedTunnelActive ?? input.link.linked)) {
    return { kind: "on", account };
  }
  if (!input.authLoaded) return { kind: "loading" };
  if (!input.signedIn) return { kind: "signed-out" };
  if (input.link === null) return input.linkPending ? { kind: "loading" } : { kind: "unknown" };
  return { kind: "off", account };
}

/**
 * Phones on the account: a count, "loading" while the list is read, null when
 * this window cannot read it (it is not signed in to the account).
 */
export type MachinePhones = number | "loading" | null;

export type MachineNextStep =
  | { readonly kind: "loading" }
  /** `canAct` is false when this window cannot do it; the page then says where to. */
  | { readonly kind: "sign-in"; readonly canAct: boolean }
  | { readonly kind: "turn-on"; readonly canAct: boolean }
  | { readonly kind: "add-phone" }
  | { readonly kind: "done" };

/**
 * The one step the page highlights, in this order: sign in to SpecWithCode
 * Connect, turn it on for this machine, add your phone, none.
 */
export function machineNextStep(input: {
  readonly connect: MachineConnect;
  /** This window may sign in and switch Connect for this machine. */
  readonly canChangeConnect: boolean;
  /** Team rules keep this machine off SpecWithCode Connect. */
  readonly connectLocked: boolean;
  /** Team rules keep phones off this machine. */
  readonly phonesLocked: boolean;
  readonly phones: MachinePhones;
  /** "Not now" was chosen on the phone step for this machine. */
  readonly phoneStepDismissed: boolean;
}): MachineNextStep {
  const { connect } = input;
  if (connect.kind === "unavailable" || connect.kind === "unknown") return { kind: "done" };
  if (connect.kind === "loading") return { kind: "loading" };
  if (connect.kind !== "on") {
    // A step the rules forbid is not a next step.
    if (input.connectLocked) return { kind: "done" };
    return {
      kind: connect.kind === "signed-out" ? "sign-in" : "turn-on",
      canAct: input.canChangeConnect,
    };
  }
  if (input.phonesLocked || input.phoneStepDismissed) return { kind: "done" };
  if (input.phones === "loading") return { kind: "loading" };
  // A list this window cannot read is not a reason to ask for a phone.
  return input.phones === 0 ? { kind: "add-phone" } : { kind: "done" };
}

/** The headline of a step; null where the page shows none. */
export function machineNextStepTitle(step: MachineNextStep): string | null {
  switch (step.kind) {
    case "sign-in":
      return "Sign in to SpecWithCode Connect";
    case "turn-on":
      return "Turn on SpecWithCode Connect for this machine";
    case "add-phone":
      return "Add your phone";
    case "done":
      return "You are set";
    case "loading":
      return null;
  }
}

export type MachineRole =
  | { readonly kind: "main" }
  /** `of` is the first machine that may run work here; `more` counts the rest. */
  | { readonly kind: "helper"; readonly of: string; readonly more: number }
  | { readonly kind: "not-set-up" };

/** The parts of a Machines page row the role is read from. */
export interface MachineRoleRow {
  readonly label: string;
  readonly seen: { readonly state: string };
  /** Work this machine may start there. */
  readonly workers: { readonly status: "allowed" | "expiring" | "not-allowed" } | null;
  /** Work that machine may start here. */
  readonly workHere: { readonly status: "active" | "revoked" | "expired" } | null;
}

/**
 * First run asks no role question, so the role is read from who may run work
 * where. A machine others run work on is a helper, unless it also runs work
 * on others and was not set up as a helper. A machine set up to join one that
 * no machine may run work on yet is not set up.
 */
export function machineRole(input: {
  readonly rows: ReadonlyArray<MachineRoleRow>;
  /** The answer an earlier version's first run saved, if any. */
  readonly chosen: "main" | "joined" | null;
}): MachineRole {
  const others = input.rows.filter((row) => row.seen.state !== "this-machine");
  const runsWorkHere = others.filter((row) => row.workHere?.status === "active");
  const runsWorkThere = others.some(
    (row) => row.workers?.status === "allowed" || row.workers?.status === "expiring",
  );
  const first = runsWorkHere[0];
  if (first === undefined)
    return input.chosen === "joined" ? { kind: "not-set-up" } : { kind: "main" };
  if (runsWorkThere && input.chosen !== "joined") return { kind: "main" };
  return { kind: "helper", of: first.label, more: runsWorkHere.length - 1 };
}

/** A phrase and the values that fill its `{name}` slots, translated where it is shown. */
export interface MachinePhrase {
  readonly text: string;
  readonly values?: Readonly<Record<string, string | number>>;
}

export function machineRoleLabel(role: MachineRole): MachinePhrase {
  switch (role.kind) {
    case "main":
      return { text: "Main machine" };
    case "not-set-up":
      return { text: "Not set up" };
    case "helper":
      if (role.more === 0) return { text: "Helper for {machine}", values: { machine: role.of } };
      return {
        text: "Helper for {machine} and {count} more",
        values: { machine: role.of, count: role.more },
      };
  }
}

export type MachineVersionState =
  | { readonly kind: "unknown" }
  | { readonly kind: "current"; readonly version: string }
  | { readonly kind: "update"; readonly version: string; readonly to: string };

export function machineVersionState(input: {
  /** The version the machine reports; null until its settings are read. */
  readonly serverVersion: string | null;
  /** Set when the machine runs an older version than this window. */
  readonly mismatch: { readonly serverVersion: string; readonly clientVersion: string } | null;
}): MachineVersionState {
  if (input.mismatch) {
    return {
      kind: "update",
      version: input.mismatch.serverVersion,
      to: input.mismatch.clientVersion,
    };
  }
  return input.serverVersion === null
    ? { kind: "unknown" }
    : { kind: "current", version: input.serverVersion };
}

export function machineVersionLabel(state: MachineVersionState): MachinePhrase | null {
  switch (state.kind) {
    case "unknown":
      return null;
    case "current":
      return { text: "{version}, up to date", values: { version: state.version } };
    case "update":
      return {
        text: "{version}, update to {next} available",
        values: { version: state.version, next: state.to },
      };
  }
}

export interface MachineFact extends MachinePhrase {
  readonly key: "connect" | "phone" | "machines";
  /** Drawn with a check mark: this part is in place. */
  readonly ok: boolean;
}

/** The three facts under the machine's name, always in this order. */
export function machineFacts(input: {
  readonly connect: MachineConnect;
  readonly connectLocked: boolean;
  readonly phones: MachinePhones;
  /** Other machines this app lists. */
  readonly otherMachines: number;
}): readonly [MachineFact, MachineFact, MachineFact] {
  return [
    { key: "connect", ...connectFact(input.connect, input.connectLocked) },
    // Signed out and off, no phone reaches this machine through Connect.
    { key: "phone", ...phoneFact(input.connect.kind === "signed-out" ? 0 : input.phones) },
    input.otherMachines === 0
      ? { key: "machines", ok: false, text: "Other machines: none" }
      : {
          key: "machines",
          ok: true,
          text: "Other machines: {count}",
          values: { count: input.otherMachines },
        },
  ];
}

function connectFact(connect: MachineConnect, locked: boolean): Omit<MachineFact, "key"> {
  switch (connect.kind) {
    case "on":
      return connect.account === null
        ? { ok: true, text: "Connect: on" }
        : { ok: true, text: "Connect: linked as {account}", values: { account: connect.account } };
    case "unavailable":
      return { ok: false, text: "Connect: not in this build" };
    case "loading":
      return { ok: false, text: "Connect: checking…" };
    case "unknown":
      return { ok: false, text: "Connect: could not check" };
    case "signed-out":
      return locked
        ? { ok: false, text: "Connect: off by your team's rules" }
        : { ok: false, text: "Connect: not signed in" };
    case "off":
      return locked
        ? { ok: false, text: "Connect: off by your team's rules" }
        : { ok: false, text: "Connect: off for this machine" };
  }
}

function phoneFact(phones: MachinePhones): Omit<MachineFact, "key"> {
  if (phones === "loading") return { ok: false, text: "Phone: checking…" };
  // Phones are listed by account, so a window that is not signed in cannot count them.
  if (phones === null) return { ok: false, text: "Phone: sign in to see" };
  if (phones === 0) return { ok: false, text: "Phone: none yet" };
  return phones === 1
    ? { ok: true, text: "Phone: 1 linked" }
    : { ok: true, text: "Phones: {count} linked", values: { count: phones } };
}

/** The client setting's shape: machines whose phone step was put off, by environment id. */
export type PhoneStepDismissed = Readonly<Record<string, boolean>>;

export function isPhoneStepDismissed(
  dismissed: PhoneStepDismissed,
  environmentId: string | null,
): boolean {
  return environmentId !== null && dismissed[environmentId] === true;
}

/** The setting with this machine's phone step put off, other machines untouched. */
export function withPhoneStepDismissed(
  dismissed: PhoneStepDismissed,
  environmentId: string,
): PhoneStepDismissed {
  return dismissed[environmentId] === true ? dismissed : { ...dismissed, [environmentId]: true };
}

/** The account's phone list as the page counts it. */
export function machinePhones(input: {
  /** The signed-in account's relay id; null when this window is not signed in. */
  readonly accountId: string | null;
  readonly phones: ReadonlyArray<unknown> | null;
  readonly pending: boolean;
}): MachinePhones {
  if (input.accountId === null) return null;
  if (input.phones !== null) return input.phones.length;
  // A failed read leaves the count unknown, not zero.
  return input.pending ? "loading" : null;
}
