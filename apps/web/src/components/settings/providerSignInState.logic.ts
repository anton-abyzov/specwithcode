import type { ProviderAuthState, ServerProvider } from "@specweave-studio/contracts";

/**
 * What the app knows about one provider's sign-in on one machine. The states
 * stay apart on purpose: installed is not signed in, a finished browser page
 * is not signed in, and a state the app could not read is not "not installed".
 *
 * - `unknown`: that machine did not report the provider or its sign-in state.
 * - `notInstalled`: reported, and its program is not on that machine.
 * - `installed`: on that machine; sign-in is missing or was never verified.
 * - `checking`: a sign-in is starting or the provider is checking the account.
 * - `waiting`: a sign-in waits for the person (browser, code or terminal).
 * - `ready`: the provider verified the sign-in on that machine.
 * - `failed`: the last sign-in failed and nothing has verified one since.
 */
export type ProviderSignInKind =
  | "unknown"
  | "notInstalled"
  | "installed"
  | "checking"
  | "waiting"
  | "ready"
  | "failed";

export interface ProviderSignInState {
  readonly kind: ProviderSignInKind;
  /** A sign-in is running; it wins over every settled state. */
  readonly active: boolean;
  /** Verified on that machine. Never true from an install or a browser page alone. */
  readonly signedIn: boolean;
  /** The provider's program is on that machine; false while that is not known. */
  readonly installed: boolean;
  /** `installed` only: the provider said outright that nobody is signed in. */
  readonly signedOut: boolean;
  /** The last failure, only while it still describes the current state. */
  readonly failureMessage: string | null;
  /** False when only an install, update or enable can fix the failure. */
  readonly retryable: boolean;
}

export function resolveProviderSignInState(input: {
  readonly provider: Pick<ServerProvider, "installed" | "auth"> | undefined;
  readonly auth: ProviderAuthState | null | undefined;
  readonly queryError: string | null | undefined;
}): ProviderSignInState {
  const { provider, auth } = input;
  const active =
    auth?.phase === "starting" || auth?.phase === "waiting" || auth?.phase === "verifying";
  const signedIn =
    provider?.auth.status === "authenticated" ||
    (provider?.auth.status === "unknown" && auth?.phase === "succeeded");
  const kind: ProviderSignInKind = active
    ? auth?.phase === "waiting"
      ? "waiting"
      : "checking"
    : signedIn
      ? "ready"
      : provider === undefined || input.queryError
        ? "unknown"
        : auth?.phase === "failed"
          ? "failed"
          : provider.installed
            ? "installed"
            : "notInstalled";
  return {
    kind,
    active,
    signedIn,
    installed: kind !== "unknown" && provider?.installed === true,
    signedOut: kind === "installed" && provider?.auth.status === "unauthenticated",
    // A verified sign-in outdates an earlier failure, whichever came last on screen.
    failureMessage: kind === "failed" ? (auth?.message ?? null) : null,
    retryable: !(kind === "failed" && auth?.retryable === false),
  };
}
