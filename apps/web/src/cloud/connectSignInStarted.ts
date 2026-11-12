/**
 * Remembers, for this window, that a SpecWithCode Connect sign-in was started
 * and from where. A sign-in through another site (Google, GitHub) reloads the
 * window, so what completes it is a load, not a change the app sees happen.
 * Without this note such a sign-in reads as a session restored from before,
 * and nothing that follows a sign-in runs.
 */
export const CONNECT_SIGN_IN_STARTED_KEY = "specwithcode.connect.sign-in-started";

/** A sign-in left unfinished this long ago no longer explains a session found at load. */
export const CONNECT_SIGN_IN_STARTED_MAX_AGE_MS = 15 * 60_000;

/**
 * "setup" is the first-run setup, which links this machine and shows it in its
 * own step. "app" is everywhere else, where the sign-in dialog does that.
 */
export type ConnectSignInOrigin = "setup" | "app";

export function markConnectSignInStarted(origin: ConnectSignInOrigin, now = Date.now()): void {
  try {
    window.sessionStorage.setItem(CONNECT_SIGN_IN_STARTED_KEY, JSON.stringify({ origin, at: now }));
  } catch {
    // Without session storage a reloading sign-in is not recognised, as before.
  }
}

/** Reads the note without removing it. Null when there is none, or it is too old or unreadable. */
export function readConnectSignInStarted(now = Date.now()): ConnectSignInOrigin | null {
  try {
    const raw = window.sessionStorage.getItem(CONNECT_SIGN_IN_STARTED_KEY);
    if (raw === null) return null;
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null) return null;
    const { origin, at } = value as { origin?: unknown; at?: unknown };
    if (origin !== "setup" && origin !== "app") return null;
    if (typeof at !== "number" || now - at > CONNECT_SIGN_IN_STARTED_MAX_AGE_MS || at > now) {
      return null;
    }
    return origin;
  } catch {
    return null;
  }
}

/** Reads the note and removes it, so one sign-in is answered once. */
export function takeConnectSignInStarted(now = Date.now()): ConnectSignInOrigin | null {
  const origin = readConnectSignInStarted(now);
  try {
    window.sessionStorage.removeItem(CONNECT_SIGN_IN_STARTED_KEY);
  } catch {
    // Nothing to remove.
  }
  return origin;
}

/** Removes a note of this origin, when the place that started the sign-in goes away. */
export function forgetConnectSignInStarted(origin: ConnectSignInOrigin): void {
  if (readConnectSignInStarted() === origin) takeConnectSignInStarted();
}

/**
 * Whether a signed-in account seen by the sign-in dialog asks for what follows
 * a sign-in there: turning Connect on and showing the dialog.
 * `sawSignedOut` is false for the first account seen after a load.
 */
export function signInDialogFollowsUp(input: {
  readonly sawSignedOut: boolean;
  readonly started: ConnectSignInOrigin | null;
}): boolean {
  // Setup shows the link in its own step; a second dialog over it would say the same.
  if (input.started === "setup") return false;
  // A session found at load is a sign-in only when one was started in this window.
  return input.sawSignedOut || input.started === "app";
}
