import type { EnvironmentId } from "@specweave-studio/contracts";
import * as Schema from "effect/Schema";

/**
 * What the card knows about a machine it lists:
 * - "online": it answers, through SpecWithCode Connect or this app's own connection.
 * - "checking": SpecWithCode Connect has not answered for it yet.
 * - "not-answering": SpecWithCode Connect says it is offline or could not ask it.
 * - "not-connected": saved in this app, not connected, and not on the account's list.
 */
export type JoinCardMachineState = "online" | "checking" | "not-answering" | "not-connected";

export interface JoinCardMachine {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly state: JoinCardMachineState;
  /** "macOS", "Linux" or "Windows", only when the machine reported it. */
  readonly os: string | null;
  /** The SpecWithCode version it reported, if it did. */
  readonly version: string | null;
  /** Listed by the SpecWithCode Connect account and not yet opened in this app. */
  readonly accountOnly: boolean;
  /** On the SpecWithCode Connect account's list, opened in this app or not. */
  readonly onAccount: boolean;
}

interface MachineFacts {
  readonly platform?: { readonly os?: string | undefined } | undefined;
  readonly serverVersion?: string | undefined;
}

/** The plain name of an operating system a machine reported, or null for one this build cannot name. */
export function platformName(os: string | undefined): string | null {
  return os === "darwin" ? "macOS" : os === "linux" ? "Linux" : os === "windows" ? "Windows" : null;
}

/**
 * The machines the card offers, saved ones first. Nothing is guessed: the
 * operating system and version show only when the machine itself reported them.
 */
export function joinCardMachines(input: {
  /** Machines this app has saved, minus this one and the ones already allowed. */
  readonly saved: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly label: string;
    readonly connected: boolean;
    readonly facts: MachineFacts | null;
  }>;
  /** Every machine the SpecWithCode Connect account lists, with what it answered. */
  readonly discovered: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly label: string;
    readonly availability: "checking" | "online" | "offline" | "error";
    readonly facts: MachineFacts | null;
  }>;
  /** Account machines not saved in this app and not yet allowed (`accountMachinesToOffer`). */
  readonly accountOnly: ReadonlyArray<EnvironmentId>;
  readonly name: (environmentId: EnvironmentId, label: string) => string;
}): JoinCardMachine[] {
  const found = new Map(input.discovered.map((entry) => [entry.environmentId, entry]));
  const fromAccount = (availability: "checking" | "online" | "offline" | "error") =>
    availability === "online"
      ? "online"
      : availability === "checking"
        ? "checking"
        : "not-answering";
  const row = (
    environmentId: EnvironmentId,
    label: string,
    state: JoinCardMachineState,
    facts: MachineFacts | null,
    accountOnly: boolean,
    onAccount: boolean,
  ): JoinCardMachine => ({
    environmentId,
    label: input.name(environmentId, label),
    state,
    os: platformName(facts?.platform?.os),
    version: facts?.serverVersion ?? null,
    accountOnly,
    onAccount,
  });
  return [
    ...input.saved.map((machine) => {
      const account = found.get(machine.environmentId);
      return row(
        machine.environmentId,
        machine.label,
        // This app's own connection is the better witness than a status read a moment ago.
        machine.connected
          ? "online"
          : account
            ? fromAccount(account.availability)
            : "not-connected",
        machine.facts ?? account?.facts ?? null,
        false,
        account !== undefined,
      );
    }),
    ...input.accountOnly.flatMap((environmentId) => {
      const account = found.get(environmentId);
      return account
        ? [
            row(
              environmentId,
              account.label,
              fromAccount(account.availability),
              account.facts,
              true,
              true,
            ),
          ]
        : [];
    }),
  ];
}

/** A machine that does not answer is listed, so the owner sees it, but cannot be chosen. */
export function canChooseJoinCardMachine(machine: JoinCardMachine): boolean {
  return machine.state !== "not-answering";
}

/** Machines whose card the owner folded with "Not now", on this device. */
export const JOIN_CARD_FOLDED_STORAGE_KEY = "studio:machines-join-card-folded:v1";

export const JoinCardFoldedSchema = Schema.Struct({
  environments: Schema.Array(Schema.String),
});

export type JoinCardFoldedState = typeof JoinCardFoldedSchema.Type;

export const EMPTY_JOIN_CARD_FOLDED_STATE: JoinCardFoldedState = { environments: [] };

export function withJoinCardFolded(
  state: JoinCardFoldedState,
  environmentId: string,
  folded: boolean,
): JoinCardFoldedState {
  const has = state.environments.includes(environmentId);
  if (folded === has) return state;
  return {
    environments: folded
      ? [...state.environments, environmentId]
      : state.environments.filter((id) => id !== environmentId),
  };
}

/**
 * What the card knows about SpecWithCode Connect on this machine:
 * - "none": this build has no SpecWithCode Connect.
 * - "loading": the sign-in is still being read.
 * - "signed-out": nobody is signed in here.
 * - "signed-in": `connectOn` is null until this machine says whether its Connect switch is on.
 */
export type JoinCardConnect =
  | { readonly kind: "none" }
  | { readonly kind: "loading" }
  | { readonly kind: "signed-out" }
  | {
      readonly kind: "signed-in";
      readonly account: string | null;
      readonly connectOn: boolean | null;
    };

export function joinCardConnect(input: {
  readonly loaded: boolean;
  readonly signedIn: boolean;
  /** The email the account shows, when the sign-in carries one. */
  readonly account: string | null;
  /** This machine's link to SpecWithCode Connect; null while unread or unreadable. */
  readonly link: {
    readonly linked: boolean;
    readonly managedTunnelActive?: boolean | undefined;
  } | null;
}): JoinCardConnect {
  if (!input.loaded) return { kind: "loading" };
  if (!input.signedIn) return { kind: "signed-out" };
  return {
    kind: "signed-in",
    account: input.account,
    // An older server reports only `linked`; a newer one says whether other machines can reach it.
    connectOn: input.link ? (input.link.managedTunnelActive ?? input.link.linked) : null,
  };
}
