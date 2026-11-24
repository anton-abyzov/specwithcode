// @effect-diagnostics globalTimers:off globalDate:off -- An Electron IPC handler: the callback deadline and elapsed time run outside any Effect fiber, as in the SDK it replaces.
import type { DesktopConnectSignInState } from "@specweave-studio/contracts";

/**
 * The desktop app's own handler for the Clerk SDK's "open the browser and wait
 * for the callback" request.
 *
 * `@clerk/electron` refuses a second request while one is waiting and tells
 * the window nothing, so a sign-in that was not finished in the browser left
 * the button dead for three minutes. This handler keeps the SDK's checks (the
 * sender, the URL to open, the callback match) and changes two things: a new
 * request replaces the waiting one and opens the browser again, and every
 * change of state is reported to the window that asked.
 *
 * A request that is replaced, fails or times out ends by rejecting, as in the
 * SDK: resolving would hand clerk-js a callback it then acts on. Electron
 * prints its own "Error occurred in handler" line for every rejected handler,
 * so each of those shows twice in the journal: our line with the state, and
 * Electron's with the fixed message below. Neither carries the URL.
 *
 * Electron is passed in, so this module is tested without it. The test also
 * loads the installed SDK and fails when its channel names or rules drift.
 */

/** `OAUTH_TRANSPORT_CHANNELS.open` in `@clerk/electron`. */
export const CLERK_OAUTH_TRANSPORT_OPEN_CHANNEL = "clerk:oauth-transport:open";
/**
 * `OAUTH_TRANSPORT_CHANNELS.getRedirectUrl` in `@clerk/electron`. Stays the
 * SDK's unless `browserRedirectUrl` is given.
 */
export const CLERK_OAUTH_TRANSPORT_REDIRECT_URL_CHANNEL = "clerk:oauth-transport:get-redirect-url";
/** The SDK's own limit (`CALLBACK_TIMEOUT_MS`). */
export const CLERK_OAUTH_CALLBACK_TIMEOUT_MS = 180_000;

const NOT_MAIN_FRAME_MESSAGE = "Clerk: OAuth request did not originate from a window's main frame.";
const REPLACED_MESSAGE = "Clerk: OAuth flow was replaced by a newer sign-in request.";
const OPEN_FAILED_MESSAGE = "Clerk: could not open the browser for the OAuth flow.";
const TIMED_OUT_MESSAGE = "Clerk: OAuth callback timed out.";
const CANCELLED_MESSAGE = "Clerk: OAuth flow was cancelled.";

/** The renderer that sent a request: Electron's `WebContents`, as far as this handler uses it. */
export interface ClerkOAuthSender {
  readonly id: number;
  getType(): string;
  readonly mainFrame: unknown;
  isDestroyed(): boolean;
  send(channel: string, ...args: unknown[]): void;
}

export interface ClerkOAuthInvokeEvent {
  readonly sender: ClerkOAuthSender;
  readonly senderFrame: unknown;
}

export interface ClerkOAuthCallbackResult {
  readonly callbackUrl: string;
}

export type ClerkOAuthOpenHandler = (
  event: ClerkOAuthInvokeEvent,
  url: unknown,
) => Promise<ClerkOAuthCallbackResult>;

/** Answers the SDK's "where does the browser come back to" request. */
export type ClerkOAuthRedirectUrlHandler = (event: ClerkOAuthInvokeEvent) => Promise<string>;

/** One line per change of state. No field ever holds a URL, a query, a token or a nonce. */
export interface ClerkOAuthLogEntry {
  readonly event: DesktopConnectSignInState | "cancelled" | "refused" | "callback-ignored";
  /** Counts requests since the app started; 0 when no request is involved. */
  readonly request: number;
  /** Host of the page opened in the browser. */
  readonly host?: string;
  readonly elapsedMs?: number;
  readonly reason?: string;
}

export interface ClerkOAuthTransportDependencies {
  readonly ipcMain: {
    handle(channel: string, listener: ClerkOAuthOpenHandler | ClerkOAuthRedirectUrlHandler): void;
    removeHandler(channel: string): void;
  };
  readonly app: {
    on(eventName: "open-url" | "second-instance", listener: (...args: never[]) => void): unknown;
    removeListener(
      eventName: "open-url" | "second-instance",
      listener: (...args: never[]) => void,
    ): unknown;
  };
  /** Opens the URL in the system browser; rejects when it could not. */
  readonly openExternal: (url: string) => Promise<void>;
  /** Brings the window that asked to the front when its sign-in comes back. */
  readonly focusWindow: (sender: ClerkOAuthSender) => void;
  /** `scheme://host/` of the renderer origin: the only callback link that completes a sign-in. */
  readonly redirectUrl: string;
  /**
   * Where Clerk sends the browser when the sign-in ends, when that is not
   * `redirectUrl` itself. The production app uses an https page that forwards
   * to `redirectUrl` with the same query: a custom-scheme redirect commits no
   * page, so the browser tab otherwise stays on the provider's last page,
   * still looking busy. Omitted: the SDK's own answer (`redirectUrl`) stays.
   */
  readonly browserRedirectUrl?: string | undefined;
  /** The channel the window listens on for `DesktopConnectSignInState`. */
  readonly stateChannel: string;
  readonly log: (entry: ClerkOAuthLogEntry) => void;
  readonly timers?: {
    readonly set: (callback: () => void, delayMs: number) => unknown;
    readonly clear: (timer: unknown) => void;
  };
  readonly now?: () => number;
}

/** The SDK's `buildRedirectUrl`. */
export function clerkOAuthRedirectUrl(renderer: {
  readonly scheme: string;
  readonly host: string;
}): string {
  return `${renderer.scheme}://${renderer.host}/`;
}

/** The https page on spec-weave.com that forwards a finished sign-in to `studio://app/`. */
export const CONNECT_BROWSER_RETURN_URL = "https://spec-weave.com/connect/return/";
/** The production Clerk instance, whose redirect allowlist holds that page. */
export const CONNECT_PRODUCTION_CLERK_HOSTNAME = "clerk.spec-weave.com";

/**
 * The page the browser comes back to, or `undefined` to keep the SDK's
 * direct `scheme://host/` redirect. Only a production build on the
 * production Clerk instance uses the page: it forwards to `studio://` alone,
 * and only that instance allows it as a redirect.
 */
export function connectBrowserReturnUrl(build: {
  readonly isDevelopment: boolean;
  readonly frontendApiHostname: string | undefined;
}): string | undefined {
  if (build.isDevelopment) return undefined;
  return build.frontendApiHostname === CONNECT_PRODUCTION_CLERK_HOSTNAME
    ? CONNECT_BROWSER_RETURN_URL
    : undefined;
}

/** The SDK's `isMainFrameEvent`: only the top frame of a window, never a guest page or a subframe. */
export function isClerkOAuthMainFrameEvent(event: ClerkOAuthInvokeEvent): boolean {
  const { sender, senderFrame } = event;
  return sender.getType() === "window" && Boolean(senderFrame) && senderFrame === sender.mainFrame;
}

/**
 * The SDK's `isMatchingCallbackUrl`: protocol, host and path equal those of
 * the renderer origin. Nothing looser, so no other link can finish a sign-in.
 */
export function isClerkOAuthCallbackUrl(url: unknown, redirectUrl: string): url is string {
  if (typeof url !== "string") return false;
  try {
    const callback = new URL(url);
    const expected = new URL(redirectUrl);
    return (
      callback.protocol === expected.protocol &&
      callback.host === expected.host &&
      callback.pathname === expected.pathname
    );
  } catch {
    return false;
  }
}

/**
 * The SDK's `assertExternalOAuthUrl`: only a web page may be handed to the
 * system. Returns the host for the log; the messages never repeat the URL.
 */
function externalOAuthUrlHost(url: unknown): string {
  let parsed: URL;
  try {
    if (typeof url !== "string") throw new TypeError("not a string");
    parsed = new URL(url);
  } catch {
    throw new TypeError("Clerk: refusing to open an invalid OAuth URL.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new TypeError(
      `Clerk: refusing to open unsupported OAuth URL protocol: ${parsed.protocol}`,
    );
  }
  return parsed.host;
}

interface WaitingRequest {
  readonly id: number;
  readonly sender: ClerkOAuthSender;
  readonly host: string;
  readonly startedAt: number;
  readonly resolve: (result: ClerkOAuthCallbackResult) => void;
  readonly reject: (error: Error) => void;
  timer: unknown;
}

/**
 * Takes over the SDK's open channel and listens for the callback link.
 * Returns the cleanup: it rejects a waiting request and removes the handler
 * and both listeners. Safe to call twice, and before or after the SDK's own
 * cleanup, which removes the handler on the same channel.
 */
export function installClerkOAuthTransport(
  dependencies: ClerkOAuthTransportDependencies,
): () => void {
  const { ipcMain, app, redirectUrl, stateChannel } = dependencies;
  // A logger that throws must not leave a request waiting or a listener behind.
  const log = (entry: ClerkOAuthLogEntry) => {
    try {
      dependencies.log(entry);
    } catch {
      // The journal line is lost; the sign-in carries on.
    }
  };
  const timers = dependencies.timers ?? {
    set: (callback: () => void, delayMs: number) => setTimeout(callback, delayMs),
    clear: (timer: unknown) => clearTimeout(timer as ReturnType<typeof setTimeout>),
  };
  const now = dependencies.now ?? (() => Date.now());

  let waiting: WaitingRequest | null = null;
  let requestCount = 0;
  let disposed = false;

  const report = (sender: ClerkOAuthSender, state: DesktopConnectSignInState) => {
    try {
      if (!sender.isDestroyed()) sender.send(stateChannel, state);
    } catch {
      // The window went away between the check and the send.
    }
  };

  /**
   * Ends `request` only while it is the waiting one. A request that was
   * replaced, timed out or completed is no longer `waiting`, so nothing that
   * arrives later (a callback, a late browser failure, its timer) can reach it.
   */
  const release = (request: WaitingRequest): boolean => {
    if (waiting !== request) return false;
    waiting = null;
    timers.clear(request.timer);
    return true;
  };

  const elapsed = (request: WaitingRequest) => Math.max(0, now() - request.startedAt);

  const fail = (
    request: WaitingRequest,
    event: "open-failed" | "timed-out",
    message: string,
  ): void => {
    if (!release(request)) return;
    log({ event, request: request.id, host: request.host, elapsedMs: elapsed(request) });
    report(request.sender, event);
    request.reject(new Error(message));
  };

  const replace = (request: WaitingRequest, next: ClerkOAuthSender): void => {
    if (!release(request)) return;
    log({
      event: "replaced",
      request: request.id,
      host: request.host,
      elapsedMs: elapsed(request),
    });
    // The same window gets `waiting` for the new request next, which updates its
    // notice in place. Only another window is told its own sign-in was dropped.
    if (request.sender !== next) report(request.sender, "replaced");
    request.reject(new Error(REPLACED_MESSAGE));
  };

  const deliverCallback = (callbackUrl: string): void => {
    const request = waiting;
    if (request === null || !release(request)) {
      log({ event: "callback-ignored", request: 0, reason: "no sign-in is waiting" });
      return;
    }
    log({
      event: "completed",
      request: request.id,
      host: request.host,
      elapsedMs: elapsed(request),
    });
    report(request.sender, "completed");
    try {
      dependencies.focusWindow(request.sender);
    } catch {
      // Focus is a courtesy; the sign-in still completes.
    }
    request.resolve({ callbackUrl });
  };

  const openUrlListener = (event: { preventDefault(): void }, url: unknown): void => {
    if (!isClerkOAuthCallbackUrl(url, redirectUrl)) return;
    event.preventDefault();
    deliverCallback(url);
  };

  const secondInstanceListener = (_event: unknown, argv: unknown): void => {
    if (!Array.isArray(argv)) return;
    const callbackUrl = argv.find((value): value is string =>
      isClerkOAuthCallbackUrl(value, redirectUrl),
    );
    if (callbackUrl !== undefined) deliverCallback(callbackUrl);
  };

  const handleOpen: ClerkOAuthOpenHandler = (event, url) => {
    // A refused request never touches the one that is waiting.
    if (disposed) return Promise.reject(new Error(CANCELLED_MESSAGE));
    if (!isClerkOAuthMainFrameEvent(event)) {
      log({ event: "refused", request: 0, reason: "not a window's main frame" });
      return Promise.reject(new Error(NOT_MAIN_FRAME_MESSAGE));
    }
    let host: string;
    try {
      host = externalOAuthUrlHost(url);
    } catch (error) {
      log({ event: "refused", request: 0, reason: "not a web address" });
      return Promise.reject(error);
    }
    const target = url as string;
    const sender = event.sender;

    if (waiting !== null) replace(waiting, sender);

    requestCount += 1;
    const id = requestCount;
    return new Promise<ClerkOAuthCallbackResult>((resolve, reject) => {
      const request: WaitingRequest = {
        id,
        sender,
        host,
        startedAt: now(),
        resolve,
        reject,
        timer: undefined,
      };
      request.timer = timers.set(
        () => fail(request, "timed-out", TIMED_OUT_MESSAGE),
        CLERK_OAUTH_CALLBACK_TIMEOUT_MS,
      );
      waiting = request;
      log({ event: "waiting", request: id, host });
      // Said before the browser answers: on Linux the open call can stay
      // unsettled for as long as the browser it started keeps running.
      report(sender, "waiting");
      Promise.resolve()
        .then(() => dependencies.openExternal(target))
        .catch(() => fail(request, "open-failed", OPEN_FAILED_MESSAGE));
    });
  };

  // Electron allows one handler per channel and throws on a second.
  ipcMain.removeHandler(CLERK_OAUTH_TRANSPORT_OPEN_CHANNEL);
  ipcMain.handle(CLERK_OAUTH_TRANSPORT_OPEN_CHANNEL, handleOpen);
  const { browserRedirectUrl } = dependencies;
  if (browserRedirectUrl !== undefined) {
    // The SDK's rule for this channel: a window's main frame only.
    const handleRedirectUrl: ClerkOAuthRedirectUrlHandler = (event) => {
      if (!isClerkOAuthMainFrameEvent(event)) {
        return Promise.reject(new Error(NOT_MAIN_FRAME_MESSAGE));
      }
      return Promise.resolve(browserRedirectUrl);
    };
    ipcMain.removeHandler(CLERK_OAUTH_TRANSPORT_REDIRECT_URL_CHANNEL);
    ipcMain.handle(CLERK_OAUTH_TRANSPORT_REDIRECT_URL_CHANNEL, handleRedirectUrl);
  }
  app.on("open-url", openUrlListener as (...args: never[]) => void);
  app.on("second-instance", secondInstanceListener as (...args: never[]) => void);

  return () => {
    if (disposed) return;
    disposed = true;
    const request = waiting;
    if (request !== null && release(request)) {
      log({
        event: "cancelled",
        request: request.id,
        host: request.host,
        elapsedMs: elapsed(request),
      });
      request.reject(new Error(CANCELLED_MESSAGE));
    }
    // Each step runs even when another throws, so nothing is left behind.
    const steps = [
      () => app.removeListener("open-url", openUrlListener as (...args: never[]) => void),
      () =>
        app.removeListener("second-instance", secondInstanceListener as (...args: never[]) => void),
      () => ipcMain.removeHandler(CLERK_OAUTH_TRANSPORT_OPEN_CHANNEL),
      ...(browserRedirectUrl === undefined
        ? []
        : [() => ipcMain.removeHandler(CLERK_OAUTH_TRANSPORT_REDIRECT_URL_CHANNEL)]),
    ];
    for (const step of steps) {
      try {
        step();
      } catch {
        // Keep going: the remaining listeners still have to come off.
      }
    }
  };
}
