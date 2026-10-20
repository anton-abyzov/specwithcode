export type PhoneConnectStep =
  | "hidden"
  | "loading"
  | "sign-in"
  | "no-permission"
  | "turn-on"
  | "ready";

export interface PhoneConnectInput {
  /** Hosted SpecWithCode Connect is configured in this build. */
  readonly configured: boolean;
  /** The desktop app, the only client that can run this Mac's managed tunnel. */
  readonly isDesktop: boolean;
  readonly authLoaded: boolean;
  readonly signedIn: boolean;
  readonly canManageRelay: boolean;
  /** The server's link state has been read at least once. */
  readonly linkStateKnown: boolean;
  readonly managedTunnelActive: boolean;
}

/** Which single step the "Use SpecWithCode on your phone" card shows. */
export function resolvePhoneConnectStep(input: PhoneConnectInput): PhoneConnectStep {
  if (!input.configured || !input.isDesktop) return "hidden";
  if (!input.authLoaded) return "loading";
  if (!input.signedIn) return "sign-in";
  if (!input.canManageRelay) return "no-permission";
  if (!input.linkStateKnown) return "loading";
  return input.managedTunnelActive ? "ready" : "turn-on";
}

/**
 * Set when the person starts sign-in from this card, so the Mac turns itself
 * on once they come back signed in. Session storage survives the reload that
 * a browser sign-in can cause, and not a quit.
 */
export const PHONE_CONNECT_PENDING_KEY = "specwithcode.phone-connect.pending";

export function shouldAutoTurnOn(step: PhoneConnectStep, pending: boolean): boolean {
  return pending && step === "turn-on";
}

/** Clear the pending flag once the flow ends either way. */
export function shouldClearPending(step: PhoneConnectStep): boolean {
  return step === "ready" || step === "no-permission" || step === "hidden";
}
