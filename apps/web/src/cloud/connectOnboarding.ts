import * as Schema from "effect/Schema";

/**
 * Accounts that opted out of the post-sign-in Studio Connect onboarding wizard
 * ("Don't show this again"). The wizard otherwise shows on every sign-in,
 * since sign-out clears the connected environments.
 */
export const CONNECT_ONBOARDING_OPT_OUT_STORAGE_KEY = "studio:connect-onboarding-opt-out:v1";

export const ConnectOnboardingOptOutSchema = Schema.Struct({
  optOutAccounts: Schema.Array(Schema.String),
});

export type ConnectOnboardingOptOutState = typeof ConnectOnboardingOptOutSchema.Type;

export const EMPTY_CONNECT_ONBOARDING_OPT_OUT_STATE: ConnectOnboardingOptOutState = {
  optOutAccounts: [],
};

/**
 * Accounts whose owner turned SpecWithCode Connect off on this machine. A
 * sign-in turns Connect on by itself, and must never undo that choice.
 */
export const CONNECT_TURNED_OFF_STORAGE_KEY = "studio:connect-turned-off:v1";

export const ConnectTurnedOffSchema = Schema.Struct({
  accounts: Schema.Array(Schema.String),
});

export type ConnectTurnedOffState = typeof ConnectTurnedOffSchema.Type;

export const EMPTY_CONNECT_TURNED_OFF_STATE: ConnectTurnedOffState = { accounts: [] };

/** The owner's latest choice for an account: off is remembered, on forgets it. */
export function withConnectChoice(
  state: ConnectTurnedOffState,
  account: string,
  on: boolean,
): ConnectTurnedOffState {
  const listed = state.accounts.includes(account);
  if (on) {
    return listed ? { accounts: state.accounts.filter((entry) => entry !== account) } : state;
  }
  return listed ? state : { accounts: [...state.accounts, account] };
}

export type ConnectAtSignIn = "wait" | "skip" | "turn-on";

export interface ConnectAtSignInInput {
  /** The account that just signed in during this session. */
  readonly account: string;
  /** The desktop app on the machine itself: the only client that runs its managed tunnel. */
  readonly desktopApp: boolean;
  /** The session's scopes and the link target are settled. */
  readonly sessionKnown: boolean;
  /** Relay read and write on this machine, with a link target to apply them to. */
  readonly canManageLink: boolean;
  /** This machine's Team rules have been read. */
  readonly rulesKnown: boolean;
  /** Team rules forbid reaching this machine over SpecWithCode Connect. */
  readonly rulesLockConnect: boolean;
  /** Null until the server's link state has been read. */
  readonly linkState: { readonly linked: boolean } | null;
  readonly linkStatePending: boolean;
  readonly linkStateFailed: boolean;
  /** The owner turned Connect off here for these accounts. */
  readonly turnedOffAccounts: ReadonlyArray<string>;
  /** These accounts chose "Don't show this again" on the wizard. */
  readonly wizardOptOutAccounts: ReadonlyArray<string>;
  /** The phone card is about to turn Connect on itself. */
  readonly phoneCardPending: boolean;
}

/**
 * Whether a sign-in that just completed turns SpecWithCode Connect on for this
 * machine by itself. Only a machine that is not linked at all is turned on:
 * a link the owner already shaped (tunnel off, another account) is theirs to
 * change, as is a choice to turn it off or to stop hearing about it.
 */
export function connectAtSignIn(input: ConnectAtSignInInput): ConnectAtSignIn {
  if (!input.desktopApp || input.phoneCardPending) return "skip";
  if (
    input.turnedOffAccounts.includes(input.account) ||
    input.wizardOptOutAccounts.includes(input.account)
  ) {
    return "skip";
  }
  if (!input.sessionKnown) return "wait";
  if (!input.canManageLink) return "skip";
  if (!input.rulesKnown) return "wait";
  if (input.rulesLockConnect || input.linkStateFailed) return "skip";
  if (input.linkState === null || input.linkStatePending) return "wait";
  return input.linkState.linked ? "skip" : "turn-on";
}
