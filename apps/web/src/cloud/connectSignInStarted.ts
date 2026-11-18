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
 * "renew" is Sign in again now (1417, AC-12): the same account comes back,
 * so nothing that follows a first sign-in runs.
 */
export type ConnectSignInOrigin = "setup" | "app" | "renew";

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
    if (origin !== "setup" && origin !== "app" && origin !== "renew") return null;
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
  // A renew brings back an account this window already had.
  if (input.started === "setup" || input.started === "renew") return false;
  // A session found at load is a sign-in only when one was started in this window.
  return input.sawSignedOut || input.started === "app";
}

/**
 * Sign in again now signs out first (Clerk hides its sign-in while one is
 * active), and the sign-out may reload the window. This note asks the next
 * signed-out render to open the sign-in by itself, once.
 */
export const CONNECT_RENEW_OPEN_KEY = "specwithcode.connect.renew-open";

/** A renew whose sign-out has not come back by now no longer opens the sign-in. */
export const CONNECT_RENEW_OPEN_MAX_AGE_MS = 2 * 60_000;

export function markConnectRenewOpen(now = Date.now()): void {
  try {
    window.sessionStorage.setItem(CONNECT_RENEW_OPEN_KEY, String(now));
  } catch {
    // Without session storage the person opens the sign-in from the banner.
  }
}

/** Reads the note and removes it. True only for a note left in the last two minutes. */
export function takeConnectRenewOpen(now = Date.now()): boolean {
  try {
    const raw = window.sessionStorage.getItem(CONNECT_RENEW_OPEN_KEY);
    window.sessionStorage.removeItem(CONNECT_RENEW_OPEN_KEY);
    if (raw === null) return false;
    const at = Number(raw);
    return Number.isFinite(at) && at <= now && now - at <= CONNECT_RENEW_OPEN_MAX_AGE_MS;
  } catch {
    return false;
  }
}
