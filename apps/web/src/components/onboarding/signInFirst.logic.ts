import { connectAtSignIn } from "../../cloud/connectOnboarding";

/**
 * Where the first step of setup stands on linking this machine to the
 * SpecWithCode Connect account. Each kind has one sentence and at most one
 * button, so the step always shows what is happening and the one next action.
 */
export type SignInFirstLink =
  /** Nobody is signed in yet: the link follows the sign-in. */
  | { readonly kind: "waiting" }
  /** Signed in; permissions, Team rules or the link itself are still being read. */
  | { readonly kind: "checking" }
  | { readonly kind: "linking" }
  | { readonly kind: "linked" }
  | { readonly kind: "failed"; readonly message: string | null }
  /** Not linked and not for setup to decide: the owner turns it on with one button. */
  | { readonly kind: "off" }
  | { readonly kind: "locked" }
  | { readonly kind: "no-permission" };

export interface SignInFirstLinkInput {
  /** The signed-in account's id, or null. */
  readonly account: string | null;
  /** This window's permissions on the machine have been read. */
  readonly sessionKnown: boolean;
  /** Relay read and write here, with a link target to apply them to. */
  readonly canManageLink: boolean;
  readonly rulesKnown: boolean;
  readonly rulesLockConnect: boolean;
  /** Null until the machine's link has been read. */
  readonly linkState: {
    readonly linked: boolean;
    readonly managedTunnelActive?: boolean | undefined;
  } | null;
  readonly linkStatePending: boolean;
  readonly linkStateFailed: boolean;
  readonly turnedOffAccounts: ReadonlyArray<string>;
  readonly turnedOffUnreadable: boolean;
  /** A link request made by this step is running. */
  readonly applying: boolean;
  /** The last link request made by this step failed, with what it reported. */
  readonly failure: { readonly message: string | null } | null;
  /** This step already asked for the link by itself for this account. */
  readonly triedByItself: boolean;
}

/**
 * The link's state and whether setup turns it on by itself now. Only a machine
 * that is not linked at all is turned on, and never against Team rules or the
 * owner's own choice to keep Connect off here: the same rule a sign-in
 * anywhere else in the app follows (`connectAtSignIn`).
 */
export function signInFirstLink(input: SignInFirstLinkInput): {
  readonly link: SignInFirstLink;
  readonly turnOnNow: boolean;
} {
  const show = (link: SignInFirstLink) => ({ link, turnOnNow: false });
  if (input.account === null) return show({ kind: "waiting" });
  if (input.applying) return show({ kind: "linking" });
  const linkState = input.linkState;
  // A link that only publishes activity does not make this machine reachable.
  if (linkState?.linked && (linkState.managedTunnelActive ?? true)) return show({ kind: "linked" });
  if (input.failure) return show({ kind: "failed", message: input.failure.message });
  const decision = connectAtSignIn({
    account: input.account,
    // Setup offers this step only in the desktop app, which runs the tunnel.
    desktopApp: true,
    sessionKnown: input.sessionKnown,
    canManageLink: input.canManageLink,
    rulesKnown: input.rulesKnown,
    rulesLockConnect: input.rulesLockConnect,
    linkState,
    linkStatePending: input.linkStatePending,
    linkStateFailed: input.linkStateFailed,
    turnedOffAccounts: input.turnedOffAccounts,
    turnedOffUnreadable: input.turnedOffUnreadable,
    // Pressing Sign in on this step asks for the link; an old "Don't show this
    // again" on the sign-in dialog was about that dialog.
    wizardOptOutAccounts: [],
    phoneCardPending: false,
  });
  if (decision === "wait") return show({ kind: "checking" });
  // Asked once: a link that is still not there after that is the owner's to turn on.
  if (decision === "turn-on" && !input.triedByItself) {
    return { link: { kind: "linking" }, turnOnNow: true };
  }
  if (!input.canManageLink) return show({ kind: "no-permission" });
  if (input.rulesLockConnect) return show({ kind: "locked" });
  if (input.linkStateFailed) return show({ kind: "failed", message: null });
  return show({ kind: "off" });
}

/** The owner may turn Connect on from this state with one button. */
export function canTurnOnFromSignInFirst(link: SignInFirstLink): boolean {
  return link.kind === "off" || link.kind === "failed";
}

/**
 * Machines of this account, or saved in this app, that may not start work here
 * yet. While there is one, the step's next action is the choice and its Allow.
 */
export function machinesStillToAllow(input: {
  readonly here: string;
  readonly known: ReadonlyArray<string>;
  readonly allowed: ReadonlyArray<string>;
}): number {
  const allowed = new Set(input.allowed);
  return new Set(input.known.filter((id) => id !== input.here && !allowed.has(id))).size;
}
