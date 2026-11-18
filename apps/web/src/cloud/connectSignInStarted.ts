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
 * "renew" is Sign in again now (1417, AC-12): when the same account comes
 * back, nothing that follows a first sign-in runs.
 */
export type ConnectSignInOrigin = "setup" | "app" | "renew";

/** The note: where the sign-in started and, for a renew, the account being renewed. */
export interface ConnectSignInStartedNote {
  readonly origin: ConnectSignInOrigin;
  readonly renewing: string | null;
}

export function markConnectSignInStarted(
  origin: ConnectSignInOrigin,
  now = Date.now(),
  renewing?: string,
): void {
  try {
    window.sessionStorage.setItem(
      CONNECT_SIGN_IN_STARTED_KEY,
      JSON.stringify({ origin, at: now, ...(renewing ? { renewing } : {}) }),
    );
  } catch {
    // Without session storage a reloading sign-in is not recognised, as before.
  }
}

/** Reads the note without removing it. Null when there is none, or it is too old or unreadable. */
export function readConnectSignInStartedNote(now = Date.now()): ConnectSignInStartedNote | null {
  try {
    const raw = window.sessionStorage.getItem(CONNECT_SIGN_IN_STARTED_KEY);
    if (raw === null) return null;
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null) return null;
    const { origin, at, renewing } = value as { origin?: unknown; at?: unknown; renewing?: unknown };
    if (origin !== "setup" && origin !== "app" && origin !== "renew") return null;
    if (typeof at !== "number" || now - at > CONNECT_SIGN_IN_STARTED_MAX_AGE_MS || at > now) {
      return null;
    }
    return {
      origin,
      renewing: origin === "renew" && typeof renewing === "string" && renewing ? renewing : null,
    };
  } catch {
    return null;
  }
}

export function readConnectSignInStarted(now = Date.now()): ConnectSignInOrigin | null {
  return readConnectSignInStartedNote(now)?.origin ?? null;
}

/** Reads the note and removes it, so one sign-in is answered once. */
export function takeConnectSignInStartedNote(now = Date.now()): ConnectSignInStartedNote | null {
  const note = readConnectSignInStartedNote(now);
  try {
    window.sessionStorage.removeItem(CONNECT_SIGN_IN_STARTED_KEY);
  } catch {
    // Nothing to remove.
  }
  return note;
}

export function takeConnectSignInStarted(now = Date.now()): ConnectSignInOrigin | null {
  return takeConnectSignInStartedNote(now)?.origin ?? null;
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
  /** For a renew, the account it renewed, and the account that signed in. */
  readonly renewing?: string | null;
  readonly account?: string;
}): boolean {
  // Setup shows the link in its own step; a second dialog over it would say the same.
  if (input.started === "setup") return false;
  // A renew that brings back the same account is not a first sign-in here. The
  // sign-in it opens takes any account, and another one (or one it cannot tell)
  // is asked what follows a sign-in.
  if (input.started === "renew") return !input.renewing || input.renewing !== input.account;
  // A session found at load is a sign-in only when one was started in this window.
  return input.sawSignedOut || input.started === "app";
}

/**
 * Sign in again now signs out first (Clerk hides its sign-in while one is
 * active), and the sign-out may reload the window. This note asks the next
 * signed-out render to open the sign-in by itself, once, and names the
 * account being renewed.
 */
export const CONNECT_RENEW_OPEN_KEY = "specwithcode.connect.renew-open";

/** A renew whose sign-out has not come back by now no longer opens the sign-in. */
export const CONNECT_RENEW_OPEN_MAX_AGE_MS = 2 * 60_000;

export function markConnectRenewOpen(accountId: string, now = Date.now()): void {
  try {
    window.sessionStorage.setItem(CONNECT_RENEW_OPEN_KEY, JSON.stringify({ accountId, at: now }));
  } catch {
    // Without session storage the person opens the sign-in from the banner.
  }
}

/**
 * Reads the note and removes it. The renewed account, only for a note left in
 * the last two minutes; null otherwise.
 */
export function takeConnectRenewOpen(now = Date.now()): string | null {
  try {
    const raw = window.sessionStorage.getItem(CONNECT_RENEW_OPEN_KEY);
    window.sessionStorage.removeItem(CONNECT_RENEW_OPEN_KEY);
    if (raw === null) return null;
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null) return null;
    const { accountId, at } = value as { accountId?: unknown; at?: unknown };
    if (typeof accountId !== "string" || !accountId || typeof at !== "number") return null;
    return at <= now && now - at <= CONNECT_RENEW_OPEN_MAX_AGE_MS ? accountId : null;
  } catch {
    return null;
  }
}
