// @effect-diagnostics nodeBuiltinImport:off globalTimers:off -- The SDK pin loads the installed @clerk/electron from disk; the handler is plain Electron IPC with no Effect fiber.
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as NodeVM from "node:vm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  CLERK_OAUTH_CALLBACK_TIMEOUT_MS,
  CLERK_OAUTH_TRANSPORT_OPEN_CHANNEL,
  CLERK_OAUTH_TRANSPORT_REDIRECT_URL_CHANNEL,
  clerkOAuthRedirectUrl,
  installClerkOAuthTransport,
  isClerkOAuthCallbackUrl,
  isClerkOAuthMainFrameEvent,
  type ClerkOAuthCallbackResult,
  type ClerkOAuthInvokeEvent,
  type ClerkOAuthLogEntry,
  type ClerkOAuthOpenHandler,
  type ClerkOAuthSender,
} from "./DesktopClerkOAuthTransport.ts";

const REDIRECT_URL = "studio://app/";
const STATE_CHANNEL = "desktop:connect-sign-in-state";
// Every secret-looking part of these URLs must stay out of logs and errors.
const SIGN_IN_URL =
  "https://accounts.example.com/oauth/authorize?client_id=CLIENT-ID-1&state=STATE-SECRET-2&nonce=NONCE-SECRET-3";
const CALLBACK_URL = "studio://app/?rotating_token_nonce=TOKEN-SECRET-4&__clerk_status=verified";
const SECRETS = [
  "CLIENT-ID-1",
  "STATE-SECRET-2",
  "NONCE-SECRET-3",
  "TOKEN-SECRET-4",
  "client_id",
  "rotating_token_nonce",
  "/oauth/authorize",
  "?",
];

type AnyListener = (...args: any[]) => unknown;

/** Electron's ipcMain, as far as it matters here: one handler per channel, a second one throws. */
class FakeIpcMain {
  readonly handlers = new Map<string, AnyListener>();
  handle(channel: string, listener: AnyListener): void {
    if (this.handlers.has(channel)) {
      throw new Error(`Attempted to register a second handler for '${channel}'`);
    }
    this.handlers.set(channel, listener);
  }
  removeHandler(channel: string): void {
    this.handlers.delete(channel);
  }
}

class FakeApp {
  readonly listeners = new Map<string, AnyListener[]>();
  userAgentFallback = "Mozilla/5.0 (Test) Electron/44";
  on(eventName: string, listener: AnyListener): this {
    this.listeners.set(eventName, [...(this.listeners.get(eventName) ?? []), listener]);
    return this;
  }
  removeListener(eventName: string, listener: AnyListener): this {
    this.listeners.set(
      eventName,
      (this.listeners.get(eventName) ?? []).filter((candidate) => candidate !== listener),
    );
    return this;
  }
  emit(eventName: string, ...args: unknown[]): void {
    // `on` and `removeListener` replace the array, so removing while emitting is safe.
    for (const listener of this.listeners.get(eventName) ?? []) listener(...args);
  }
  count(eventName: string): number {
    return (this.listeners.get(eventName) ?? []).length;
  }
  // Used by the SDK only.
  setAsDefaultProtocolClient = vi.fn(() => true);
  hasSingleInstanceLock = vi.fn(() => true);
  requestSingleInstanceLock = vi.fn(() => true);
  releaseSingleInstanceLock = vi.fn();
  quit = vi.fn();
}

interface FakeSender extends ClerkOAuthSender {
  readonly send: ReturnType<typeof vi.fn<(channel: string, ...args: unknown[]) => void>>;
  destroyed: boolean;
}

let nextSenderId = 1;
function makeSender(type = "window"): FakeSender {
  const sender: FakeSender = {
    id: nextSenderId++,
    getType: () => type,
    mainFrame: { frame: "main" },
    destroyed: false,
    isDestroyed: () => sender.destroyed,
    send: vi.fn<(channel: string, ...args: unknown[]) => void>(),
  };
  return sender;
}
const mainFrameEvent = (sender: ClerkOAuthSender): ClerkOAuthInvokeEvent => ({
  sender,
  senderFrame: sender.mainFrame,
});
const statesSentTo = (sender: FakeSender) =>
  sender.send.mock.calls.map(([channel, state]) => {
    expect(channel).toBe(STATE_CHANNEL);
    return state;
  });

type Tracked<T> =
  | { status: "pending" }
  | { status: "resolved"; value: T }
  | { status: "rejected"; error: unknown };
function track<T>(promise: Promise<T>): { current: Tracked<T> } {
  const box: { current: Tracked<T> } = { current: { status: "pending" } };
  promise.then(
    (value) => {
      box.current = { status: "resolved", value };
    },
    (error: unknown) => {
      box.current = { status: "rejected", error };
    },
  );
  return box;
}
/** Lets settled promises run their callbacks. */
const flush = () => vi.advanceTimersByTimeAsync(0);
const rejectionMessage = (tracked: { current: Tracked<unknown> }) =>
  tracked.current.status === "rejected" && tracked.current.error instanceof Error
    ? tracked.current.error.message
    : `not rejected (${tracked.current.status})`;

function setup(options: { openExternal?: (url: string) => Promise<void> } = {}) {
  const ipcMain = new FakeIpcMain();
  const app = new FakeApp();
  const log: ClerkOAuthLogEntry[] = [];
  const focusWindow = vi.fn<(sender: ClerkOAuthSender) => void>();
  const openExternal = vi.fn(options.openExternal ?? (async () => undefined));
  const cleanup = installClerkOAuthTransport({
    ipcMain,
    app,
    openExternal,
    focusWindow,
    redirectUrl: REDIRECT_URL,
    stateChannel: STATE_CHANNEL,
    log: (entry) => log.push(entry),
  });
  // A rest parameter, so an explicit `undefined` URL is sent as it is.
  const open = (event: ClerkOAuthInvokeEvent, ...url: [unknown?]) =>
    track(
      (ipcMain.handlers.get(CLERK_OAUTH_TRANSPORT_OPEN_CHANNEL) as ClerkOAuthOpenHandler)(
        event,
        url.length === 0 ? SIGN_IN_URL : url[0],
      ),
    );
  return { ipcMain, app, log, focusWindow, openExternal, cleanup, open };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("the desktop's Clerk OAuth open handler", () => {
  it("tells the asking window it is waiting, opens the browser and completes on the callback link", async () => {
    const { app, open, openExternal, focusWindow, log } = setup();
    const window = makeSender();

    const request = open(mainFrameEvent(window));
    // Said in the same turn as the click, before the browser answers.
    expect(statesSentTo(window)).toEqual(["waiting"]);
    await flush();
    expect(openExternal.mock.calls).toEqual([[SIGN_IN_URL]]);
    expect(request.current.status).toBe("pending");

    const event = { preventDefault: vi.fn() };
    app.emit("open-url", event, CALLBACK_URL);
    await flush();

    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(request.current).toEqual({ status: "resolved", value: { callbackUrl: CALLBACK_URL } });
    expect(statesSentTo(window)).toEqual(["waiting", "completed"]);
    expect(focusWindow.mock.calls).toEqual([[window]]);
    expect(log.map((entry) => entry.event)).toEqual(["waiting", "completed"]);

    // The clock stopped with the sign-in.
    await vi.advanceTimersByTimeAsync(CLERK_OAUTH_CALLBACK_TIMEOUT_MS * 2);
    expect(statesSentTo(window)).toEqual(["waiting", "completed"]);
  });

  it("takes the callback link from a second launch's arguments on Windows and Linux", async () => {
    const { app, open } = setup();
    const window = makeSender();
    const request = open(mainFrameEvent(window));

    app.emit("second-instance", {}, [
      "specweave-studio",
      "--flag",
      CALLBACK_URL,
      "studio://app/?later",
    ]);
    await flush();

    expect(request.current).toEqual({ status: "resolved", value: { callbackUrl: CALLBACK_URL } });
    expect(statesSentTo(window)).toEqual(["waiting", "completed"]);
  });

  it("a second click opens the browser again and restarts the clock instead of being refused", async () => {
    const { open, openExternal, log } = setup();
    const window = makeSender();

    const first = open(mainFrameEvent(window));
    await vi.advanceTimersByTimeAsync(100_000);
    const second = open(mainFrameEvent(window), `${SIGN_IN_URL}&attempt=2`);
    await flush();

    expect(openExternal).toHaveBeenCalledTimes(2);
    expect(rejectionMessage(first)).toBe(
      "Clerk: OAuth flow was replaced by a newer sign-in request.",
    );
    expect(second.current.status).toBe("pending");
    // One notice, updated in place: the same window is never told "replaced".
    expect(statesSentTo(window)).toEqual(["waiting", "waiting"]);
    expect(log.map((entry) => [entry.event, entry.request])).toEqual([
      ["waiting", 1],
      ["replaced", 1],
      ["waiting", 2],
    ]);

    // The first request's 180 seconds pass: its timer is gone.
    await vi.advanceTimersByTimeAsync(80_000);
    expect(second.current.status).toBe("pending");
    expect(statesSentTo(window)).toEqual(["waiting", "waiting"]);

    await vi.advanceTimersByTimeAsync(99_999);
    expect(second.current.status).toBe("pending");
    await vi.advanceTimersByTimeAsync(1);
    expect(rejectionMessage(second)).toBe("Clerk: OAuth callback timed out.");
    expect(statesSentTo(window)).toEqual(["waiting", "waiting", "timed-out"]);
  });

  it("delivers the callback only to the newest request; a replaced one can never receive it", async () => {
    const { app, open, focusWindow } = setup();
    const firstWindow = makeSender();
    const secondWindow = makeSender();

    const first = open(mainFrameEvent(firstWindow));
    const second = open(mainFrameEvent(secondWindow));
    await flush();
    expect(first.current.status).toBe("rejected");
    // Another window took over, so the first is told to drop its notice.
    expect(statesSentTo(firstWindow)).toEqual(["waiting", "replaced"]);

    app.emit("open-url", { preventDefault: vi.fn() }, CALLBACK_URL);
    app.emit("open-url", { preventDefault: vi.fn() }, "studio://app/?second-callback");
    await flush();

    expect(second.current).toEqual({ status: "resolved", value: { callbackUrl: CALLBACK_URL } });
    expect(rejectionMessage(first)).toBe(
      "Clerk: OAuth flow was replaced by a newer sign-in request.",
    );
    expect(statesSentTo(firstWindow)).toEqual(["waiting", "replaced"]);
    expect(statesSentTo(secondWindow)).toEqual(["waiting", "completed"]);
    expect(focusWindow.mock.calls).toEqual([[secondWindow]]);
  });

  it("a replaced request's late browser failure does not touch the new request", async () => {
    const failures: Array<() => void> = [];
    const { app, open } = setup({
      openExternal: () =>
        new Promise<void>((_resolve, reject) => {
          failures.push(() => reject(new Error("xdg-open exited")));
        }),
    });
    const window = makeSender();

    const first = open(mainFrameEvent(window));
    await flush();
    const second = open(mainFrameEvent(window));
    await flush();
    failures[0]!();
    await flush();

    expect(first.current.status).toBe("rejected");
    expect(second.current.status).toBe("pending");
    expect(statesSentTo(window)).toEqual(["waiting", "waiting"]);

    app.emit("open-url", { preventDefault: vi.fn() }, CALLBACK_URL);
    await flush();
    expect(second.current.status).toBe("resolved");
  });

  it.each([
    {
      name: "rejects",
      openExternal: () => Promise.reject(new Error(`could not open ${SIGN_IN_URL}`)),
    },
    {
      name: "throws",
      openExternal: () => {
        throw new Error(`could not open ${SIGN_IN_URL}`);
      },
    },
  ])("says so at once when the browser cannot be opened ($name)", async ({ openExternal }) => {
    const { open, log } = setup({ openExternal });
    const window = makeSender();

    const request = open(mainFrameEvent(window));
    await flush();

    expect(statesSentTo(window)).toEqual(["waiting", "open-failed"]);
    // A fixed message: the browser's own error can repeat the URL.
    expect(rejectionMessage(request)).toBe("Clerk: could not open the browser for the OAuth flow.");
    expect(log.map((entry) => entry.event)).toEqual(["waiting", "open-failed"]);

    // Nothing is left waiting: the timer is gone and the next click starts over.
    await vi.advanceTimersByTimeAsync(CLERK_OAUTH_CALLBACK_TIMEOUT_MS);
    expect(statesSentTo(window)).toEqual(["waiting", "open-failed"]);
    const retry = open(mainFrameEvent(window));
    await flush();
    expect(statesSentTo(window)).toEqual(["waiting", "open-failed", "waiting", "open-failed"]);
    expect(retry.current.status).toBe("rejected");
  });

  it("times out after exactly 180 seconds and ignores a callback that comes later", async () => {
    const { app, open, log, focusWindow } = setup();
    const window = makeSender();
    const request = open(mainFrameEvent(window));

    expect(CLERK_OAUTH_CALLBACK_TIMEOUT_MS).toBe(180_000);
    await vi.advanceTimersByTimeAsync(179_999);
    expect(request.current.status).toBe("pending");
    await vi.advanceTimersByTimeAsync(1);
    expect(rejectionMessage(request)).toBe("Clerk: OAuth callback timed out.");
    expect(statesSentTo(window)).toEqual(["waiting", "timed-out"]);

    const event = { preventDefault: vi.fn() };
    app.emit("open-url", event, CALLBACK_URL);
    await flush();
    expect(request.current.status).toBe("rejected");
    expect(statesSentTo(window)).toEqual(["waiting", "timed-out"]);
    expect(focusWindow).not.toHaveBeenCalled();
    expect(log.map((entry) => entry.event)).toEqual(["waiting", "timed-out", "callback-ignored"]);
  });

  it.each([
    { name: "a preview guest page", event: () => mainFrameEvent(makeSender("webview")) },
    {
      name: "a subframe of a window",
      event: () => ({ sender: makeSender(), senderFrame: { frame: "ad" } }),
    },
    { name: "a frame that is gone", event: () => ({ sender: makeSender(), senderFrame: null }) },
    {
      name: "another window's main frame",
      event: () => ({ sender: makeSender(), senderFrame: makeSender().mainFrame }),
    },
  ])("refuses $name and leaves the waiting sign-in alone", async ({ event }) => {
    const { app, open, openExternal } = setup();
    const window = makeSender();
    const waiting = open(mainFrameEvent(window));
    await flush();

    const refusedEvent = event() as ClerkOAuthInvokeEvent;
    const refused = open(refusedEvent);
    await flush();

    expect(rejectionMessage(refused)).toBe(
      "Clerk: OAuth request did not originate from a window's main frame.",
    );
    expect(openExternal).toHaveBeenCalledTimes(1);
    expect((refusedEvent.sender as FakeSender).send).not.toHaveBeenCalled();
    expect(waiting.current.status).toBe("pending");
    expect(statesSentTo(window)).toEqual(["waiting"]);

    app.emit("open-url", { preventDefault: vi.fn() }, CALLBACK_URL);
    await flush();
    expect(waiting.current.status).toBe("resolved");
  });

  it.each([
    "file:///etc/passwd",
    "javascript:alert(1)",
    "studio://app/",
    "data:text/html,<script>alert(1)</script>",
    "vscode://vscode-remote/ssh-remote+host/path",
    "ms-settings:privacy",
    "//accounts.example.com/oauth",
    "accounts.example.com/oauth",
    "",
    undefined,
    null,
    42,
    { href: "https://accounts.example.com/" },
  ])("opens only http and https: refuses %j and leaves the waiting sign-in alone", async (url) => {
    const { open, openExternal } = setup();
    const window = makeSender();
    const waiting = open(mainFrameEvent(window));
    await flush();

    const refused = open(mainFrameEvent(window), url);
    await flush();

    expect(refused.current.status).toBe("rejected");
    expect(rejectionMessage(refused)).toMatch(/^Clerk: refusing to open /);
    expect(openExternal).toHaveBeenCalledTimes(1);
    expect(waiting.current.status).toBe("pending");
    expect(statesSentTo(window)).toEqual(["waiting"]);
  });

  it.each(["http://localhost:3000/authorize?x=1", "https://accounts.example.com/o/oauth2/auth"])(
    "opens %s",
    async (url) => {
      const { open, openExternal } = setup();
      open(mainFrameEvent(makeSender()), url);
      await flush();
      expect(openExternal.mock.calls).toEqual([[url]]);
    },
  );

  it.each([
    { url: "studio://app/", matches: true },
    { url: "studio://app/?rotating_token_nonce=abc", matches: true },
    { url: "studio://app/#fragment", matches: true },
    { url: "STUDIO://APP/?x=1", matches: false },
    { url: "studio://app", matches: false },
    { url: "studio://app/welcome", matches: false },
    { url: "studio://app/settings/providers?instanceId=work", matches: false },
    { url: "studio://app//", matches: false },
    { url: "studio://app/.", matches: true },
    { url: "studio://app.evil.example/", matches: false },
    { url: "studio://evil/app/", matches: false },
    { url: "studio://app:8080/", matches: false },
    { url: "studio-dev://app/", matches: false },
    { url: "https://app/", matches: false },
    { url: "studio:app/", matches: false },
    { url: "not a url", matches: false },
    { url: "", matches: false },
    { url: undefined, matches: false },
    { url: 7, matches: false },
  ])("callback match for $url is $matches", async ({ url, matches }) => {
    expect(isClerkOAuthCallbackUrl(url, REDIRECT_URL)).toBe(matches);

    // The same answer through both listeners, with a sign-in waiting.
    for (const deliver of ["open-url", "second-instance"] as const) {
      const { app, open } = setup();
      const request = open(mainFrameEvent(makeSender()));
      const event = { preventDefault: vi.fn() };
      if (deliver === "open-url") app.emit("open-url", event, url);
      else app.emit("second-instance", {}, ["specweave-studio", url]);
      await flush();
      expect(request.current.status).toBe(matches ? "resolved" : "pending");
      if (deliver === "open-url") {
        expect(event.preventDefault).toHaveBeenCalledTimes(matches ? 1 : 0);
      }
    }
  });

  it("ignores a second launch whose arguments are not a list", async () => {
    const { app, open } = setup();
    const request = open(mainFrameEvent(makeSender()));
    app.emit("second-instance", {}, undefined);
    app.emit("second-instance", {}, CALLBACK_URL);
    await flush();
    expect(request.current.status).toBe("pending");
  });

  it("writes one log line per change of state, with no URL query, token or nonce", async () => {
    const failing = { next: false };
    const { app, open, log } = setup({
      openExternal: async () => {
        if (failing.next) throw new Error(`could not open ${SIGN_IN_URL}`);
      },
    });
    const window = makeSender();
    const other = makeSender();
    const rejections: string[] = [];
    const run = (event: ClerkOAuthInvokeEvent, url: string = SIGN_IN_URL) => {
      const tracked = open(event, url);
      return () => {
        if (tracked.current.status === "rejected") rejections.push(rejectionMessage(tracked));
      };
    };

    const settled = [run(mainFrameEvent(window))]; // waiting 1
    settled.push(run(mainFrameEvent(other))); // replaced 1, waiting 2
    await flush();
    app.emit("open-url", { preventDefault: vi.fn() }, CALLBACK_URL); // completed 2
    app.emit("open-url", { preventDefault: vi.fn() }, CALLBACK_URL); // callback-ignored
    settled.push(run(mainFrameEvent(window))); // waiting 3
    await vi.advanceTimersByTimeAsync(CLERK_OAUTH_CALLBACK_TIMEOUT_MS); // timed-out 3
    failing.next = true;
    settled.push(run(mainFrameEvent(window))); // waiting 4, open-failed 4
    await flush();
    settled.push(run(mainFrameEvent(makeSender("webview")))); // refused
    settled.push(run(mainFrameEvent(window), `file:///tmp/${SECRETS[1]}`)); // refused
    await flush();
    for (const collect of settled) collect();

    expect(log.map((entry) => [entry.event, entry.request])).toEqual([
      ["waiting", 1],
      ["replaced", 1],
      ["waiting", 2],
      ["completed", 2],
      ["callback-ignored", 0],
      ["waiting", 3],
      ["timed-out", 3],
      ["waiting", 4],
      ["open-failed", 4],
      ["refused", 0],
      ["refused", 0],
    ]);
    expect(log.find((entry) => entry.event === "waiting")).toEqual({
      event: "waiting",
      request: 1,
      host: "accounts.example.com",
    });
    expect(log.find((entry) => entry.event === "timed-out")?.elapsedMs).toBe(180_000);

    const written = JSON.stringify(log) + JSON.stringify(rejections);
    expect(rejections).toHaveLength(5);
    for (const secret of SECRETS) expect(written).not.toContain(secret);
  });

  it("does not send to a window that is gone, and a failing send or focus does not stop the sign-in", async () => {
    const { app, open, focusWindow } = setup();
    const window = makeSender();
    const request = open(mainFrameEvent(window));
    window.destroyed = true;
    focusWindow.mockImplementation(() => {
      throw new Error("window is destroyed");
    });

    app.emit("open-url", { preventDefault: vi.fn() }, CALLBACK_URL);
    await flush();
    expect(statesSentTo(window)).toEqual(["waiting"]);
    expect(request.current.status).toBe("resolved");

    const throwing = makeSender();
    throwing.send.mockImplementation(() => {
      throw new Error("Object has been destroyed");
    });
    const second = open(mainFrameEvent(throwing));
    app.emit("open-url", { preventDefault: vi.fn() }, CALLBACK_URL);
    await flush();
    expect(second.current.status).toBe("resolved");
  });

  it("takes over a handler that is already registered on the channel", () => {
    const ipcMain = new FakeIpcMain();
    const sdkHandler = vi.fn();
    ipcMain.handle(CLERK_OAUTH_TRANSPORT_OPEN_CHANNEL, sdkHandler);

    installClerkOAuthTransport({
      ipcMain,
      app: new FakeApp(),
      openExternal: async () => undefined,
      focusWindow: () => undefined,
      redirectUrl: REDIRECT_URL,
      stateChannel: STATE_CHANNEL,
      log: () => undefined,
    });

    expect(ipcMain.handlers.get(CLERK_OAUTH_TRANSPORT_OPEN_CHANNEL)).not.toBe(sdkHandler);
    expect(ipcMain.handlers.size).toBe(1);
  });

  it("cleanup rejects the waiting request and removes the handler and both listeners", async () => {
    const { ipcMain, app, open, cleanup, log } = setup();
    const window = makeSender();
    const handler = ipcMain.handlers.get(
      CLERK_OAUTH_TRANSPORT_OPEN_CHANNEL,
    ) as ClerkOAuthOpenHandler;
    const openUrlListener = app.listeners.get("open-url")![0]!;
    const request = open(mainFrameEvent(window));
    expect([app.count("open-url"), app.count("second-instance")]).toEqual([1, 1]);

    cleanup();
    cleanup();
    await flush();

    expect(rejectionMessage(request)).toBe("Clerk: OAuth flow was cancelled.");
    expect(ipcMain.handlers.size).toBe(0);
    expect([app.count("open-url"), app.count("second-instance")]).toEqual([0, 0]);
    expect(log.map((entry) => entry.event)).toEqual(["waiting", "cancelled"]);

    // A listener or handler still held by Electron after cleanup does nothing.
    openUrlListener({ preventDefault: vi.fn() }, CALLBACK_URL);
    const late = track(handler(mainFrameEvent(window), SIGN_IN_URL));
    await vi.advanceTimersByTimeAsync(CLERK_OAUTH_CALLBACK_TIMEOUT_MS);
    expect(request.current.status).toBe("rejected");
    expect(rejectionMessage(late)).toBe("Clerk: OAuth flow was cancelled.");
    expect(statesSentTo(window)).toEqual(["waiting"]);
  });

  it("cleanup still removes everything when one removal throws", () => {
    const ipcMain = new FakeIpcMain();
    const app = new FakeApp();
    const removeListener = app.removeListener.bind(app);
    let thrown = false;
    app.removeListener = (eventName: string, listener: AnyListener) => {
      removeListener(eventName, listener);
      if (!thrown) {
        thrown = true;
        throw new Error("app is shutting down");
      }
      return app;
    };
    const cleanup = installClerkOAuthTransport({
      ipcMain,
      app,
      openExternal: async () => undefined,
      focusWindow: () => undefined,
      redirectUrl: REDIRECT_URL,
      stateChannel: STATE_CHANNEL,
      log: () => undefined,
    });

    expect(() => cleanup()).not.toThrow();
    expect(thrown).toBe(true);
    expect(ipcMain.handlers.size).toBe(0);
    expect([app.count("open-url"), app.count("second-instance")]).toEqual([0, 0]);
  });
});

/*
 * AC-07. The handler above copies three rules from @clerk/electron and takes
 * over one of its channels. These tests load the SDK that is installed, with a
 * stand-in for Electron, and compare the two. They fail when the SDK renames a
 * channel, changes a rule, or stops refusing a second request (the reason this
 * handler exists), so a bump cannot quietly drop or weaken the handler.
 */
describe("the installed @clerk/electron still matches the desktop's handler", () => {
  const sdkRequire = NodeModule.createRequire(import.meta.url);
  const sdkMainPath = sdkRequire.resolve("@clerk/electron");
  const sdkRoot = NodePath.resolve(NodePath.dirname(sdkMainPath), "../..");

  function loadSdk() {
    const ipcMain = new FakeIpcMain();
    const app = new FakeApp();
    const shell = { openExternal: vi.fn(async (_url: string) => undefined) };
    const electron = {
      ipcMain,
      app,
      shell,
      protocol: { registerSchemesAsPrivileged: vi.fn() },
      BrowserWindow: { fromWebContents: () => null },
    };
    const requireFromSdk = NodeModule.createRequire(sdkMainPath);
    const module = { exports: {} as Record<string, unknown> };
    // The SDK's CommonJS build, evaluated with our Electron stand-in.
    NodeVM.compileFunction(
      NodeFS.readFileSync(sdkMainPath, "utf8"),
      ["require", "module", "exports"],
      { filename: sdkMainPath },
    )((id: string) => (id === "electron" ? electron : requireFromSdk(id)), module, module.exports);
    const createClerkBridge = module.exports.createClerkBridge as (options: {
      storage: unknown;
      renderer: { scheme: string; host: string };
    }) => { cleanup(): void; isPrimaryInstance: boolean };
    const createBridge = (renderer = { scheme: "studio", host: "app" }) =>
      createClerkBridge({
        storage: { getItem: () => null, setItem: () => undefined, removeItem: () => undefined },
        renderer,
      });
    const sdkOpen = (event: ClerkOAuthInvokeEvent, url: unknown = SIGN_IN_URL) =>
      track(
        Promise.resolve().then(
          () =>
            ipcMain.handlers.get(CLERK_OAUTH_TRANSPORT_OPEN_CHANNEL)!(
              event,
              url,
            ) as Promise<ClerkOAuthCallbackResult>,
        ),
      );
    return { ipcMain, app, shell, createBridge, sdkOpen };
  }

  it("registers the two channels this handler names, in every build of the SDK", () => {
    const { ipcMain, createBridge } = loadSdk();
    createBridge();
    expect([...ipcMain.handlers.keys()]).toEqual(
      expect.arrayContaining([
        CLERK_OAUTH_TRANSPORT_REDIRECT_URL_CHANNEL,
        CLERK_OAUTH_TRANSPORT_OPEN_CHANNEL,
      ]),
    );

    // The preload half invokes the same names; it is bundled from these files.
    const channelFiles = ["cjs", "esm"].flatMap((build) => {
      const directory = NodePath.join(sdkRoot, "dist", build);
      return NodeFS.readdirSync(directory)
        .filter((name) => /^ipc-.*\.js$/.test(name))
        .map((name) => NodePath.join(directory, name));
    });
    expect(channelFiles).toHaveLength(2);
    for (const file of channelFiles) {
      const source = NodeFS.readFileSync(file, "utf8");
      expect(source).toContain(`open: "${CLERK_OAUTH_TRANSPORT_OPEN_CHANNEL}"`);
      expect(source).toContain(`getRedirectUrl: "${CLERK_OAUTH_TRANSPORT_REDIRECT_URL_CHANNEL}"`);
    }
  });

  it.each([
    { scheme: "studio", host: "app" },
    { scheme: "studio-dev", host: "app" },
  ])("builds the same redirect URL for $scheme", (renderer) => {
    const { ipcMain, createBridge } = loadSdk();
    createBridge(renderer);
    const sdkRedirectUrl = ipcMain.handlers.get(CLERK_OAUTH_TRANSPORT_REDIRECT_URL_CHANNEL)!(
      mainFrameEvent(makeSender()),
    );
    expect(clerkOAuthRedirectUrl(renderer)).toBe(sdkRedirectUrl);
  });

  it.each([
    "studio://app/",
    "studio://app/?rotating_token_nonce=abc",
    "studio://app/#fragment",
    "studio://app/.",
    "studio://user:pass@app/",
    "STUDIO://APP/?x=1",
    "studio://app",
    "studio://app/welcome",
    "studio://app//",
    "studio://app.evil.example/",
    "studio://evil/app/",
    "studio://app:8080/",
    "studio-dev://app/",
    "https://app/",
    "studio:app/",
    "not a url",
    "",
  ])("matches the callback %j exactly as the SDK does", async (candidate) => {
    const ours = isClerkOAuthCallbackUrl(candidate, REDIRECT_URL);

    for (const deliver of ["open-url", "second-instance"] as const) {
      const { app, createBridge, sdkOpen } = loadSdk();
      const bridge = createBridge();
      const request = sdkOpen(mainFrameEvent(makeSender()));
      await flush();
      const event = { preventDefault: vi.fn() };
      if (deliver === "open-url") app.emit("open-url", event, candidate);
      else app.emit("second-instance", {}, ["specweave-studio", candidate]);
      await flush();

      expect(request.current.status === "resolved").toBe(ours);
      if (deliver === "open-url") expect(event.preventDefault.mock.calls.length === 1).toBe(ours);
      bridge.cleanup();
      await flush();
    }
  });

  it.each([
    { name: "a window's main frame", event: () => mainFrameEvent(makeSender()) },
    { name: "a preview guest page", event: () => mainFrameEvent(makeSender("webview")) },
    {
      name: "a subframe of a window",
      event: () => ({ sender: makeSender(), senderFrame: { frame: "ad" } }),
    },
    { name: "a frame that is gone", event: () => ({ sender: makeSender(), senderFrame: null }) },
    {
      name: "another window's main frame",
      event: () => ({ sender: makeSender(), senderFrame: makeSender().mainFrame }),
    },
  ])("accepts or refuses $name exactly as the SDK does", async ({ event }) => {
    const { createBridge, sdkOpen } = loadSdk();
    createBridge();
    const candidate = event() as ClerkOAuthInvokeEvent;
    const request = sdkOpen(candidate);
    await flush();

    const ours = isClerkOAuthMainFrameEvent(candidate);
    expect(request.current.status === "pending").toBe(ours);
    if (!ours) {
      // The same words, so a log search finds both.
      const { open } = setup();
      const refused = open(candidate);
      await flush();
      expect(rejectionMessage(refused)).toBe(rejectionMessage(request));
    }
  });

  it.each([
    "https://accounts.example.com/o/oauth2/auth?x=1",
    "http://localhost:3000/authorize",
    "HTTPS://ACCOUNTS.EXAMPLE.COM/",
    "file:///etc/passwd",
    "javascript:alert(1)",
    "studio://app/",
    "data:text/html,hi",
    "vscode://vscode-remote/ssh-remote+host/path",
    "ms-settings:privacy",
    "//accounts.example.com/oauth",
    "accounts.example.com/oauth",
    "",
  ])("opens or refuses %j exactly as the SDK does", async (candidate) => {
    const sdk = loadSdk();
    sdk.createBridge();
    const sdkRequest = sdk.sdkOpen(mainFrameEvent(makeSender()), candidate);
    await flush();

    const ours = setup();
    const ourRequest = ours.open(mainFrameEvent(makeSender()), candidate);
    await flush();

    expect(ourRequest.current.status).toBe(sdkRequest.current.status);
    expect(ours.openExternal.mock.calls).toEqual(sdk.shell.openExternal.mock.calls);
  });

  it("waits the same 180 seconds as the SDK", async () => {
    const { createBridge, sdkOpen } = loadSdk();
    createBridge();
    const request = sdkOpen(mainFrameEvent(makeSender()));
    await flush();

    await vi.advanceTimersByTimeAsync(CLERK_OAUTH_CALLBACK_TIMEOUT_MS - 1);
    expect(request.current.status).toBe("pending");
    await vi.advanceTimersByTimeAsync(1);
    expect(rejectionMessage(request)).toBe("Clerk: OAuth callback timed out.");
  });

  it("the SDK alone still refuses a second request, which is why the desktop replaces its handler", async () => {
    const { createBridge, sdkOpen } = loadSdk();
    createBridge();
    const window = makeSender();
    sdkOpen(mainFrameEvent(window));
    await flush();
    const second = sdkOpen(mainFrameEvent(window));
    await flush();
    expect(rejectionMessage(second)).toBe("Clerk: an OAuth flow is already pending.");
  });

  it.each(["ours first", "the SDK's first"] as const)(
    "replaces the SDK's handler, completes a sign-in next to its listeners, and cleans up with %s",
    async (order) => {
      const { ipcMain, app, shell, createBridge } = loadSdk();
      const bridge = createBridge();
      const sdkHandler = ipcMain.handlers.get(CLERK_OAUTH_TRANSPORT_OPEN_CHANNEL);
      const sdkRedirectHandler = ipcMain.handlers.get(CLERK_OAUTH_TRANSPORT_REDIRECT_URL_CHANNEL);
      const log: ClerkOAuthLogEntry[] = [];
      const cleanup = installClerkOAuthTransport({
        ipcMain,
        app,
        openExternal: (url) => shell.openExternal(url),
        focusWindow: () => undefined,
        redirectUrl: clerkOAuthRedirectUrl({ scheme: "studio", host: "app" }),
        stateChannel: STATE_CHANNEL,
        log: (entry) => log.push(entry),
      });
      const handler = ipcMain.handlers.get(
        CLERK_OAUTH_TRANSPORT_OPEN_CHANNEL,
      ) as ClerkOAuthOpenHandler;
      expect(handler).not.toBe(sdkHandler);
      // Everything else stays the SDK's.
      expect(ipcMain.handlers.get(CLERK_OAUTH_TRANSPORT_REDIRECT_URL_CHANNEL)).toBe(
        sdkRedirectHandler,
      );
      expect([app.count("open-url"), app.count("second-instance")]).toEqual([2, 2]);

      const window = makeSender();
      const first = track(handler(mainFrameEvent(window), SIGN_IN_URL));
      const second = track(handler(mainFrameEvent(window), SIGN_IN_URL));
      await flush();
      expect(rejectionMessage(first)).toBe(
        "Clerk: OAuth flow was replaced by a newer sign-in request.",
      );
      expect(shell.openExternal).toHaveBeenCalledTimes(2);

      // The SDK's idle listeners see the same link and do nothing with it.
      app.emit("open-url", { preventDefault: vi.fn() }, CALLBACK_URL);
      await flush();
      expect(second.current).toEqual({
        status: "resolved",
        value: { callbackUrl: CALLBACK_URL },
      });

      const waiting = track(handler(mainFrameEvent(window), SIGN_IN_URL));
      const steps =
        order === "ours first"
          ? [cleanup, () => bridge.cleanup()]
          : [() => bridge.cleanup(), cleanup];
      for (const step of steps) expect(step).not.toThrow();
      await flush();

      expect(rejectionMessage(waiting)).toBe("Clerk: OAuth flow was cancelled.");
      expect(ipcMain.handlers.size).toBe(0);
      expect([app.count("open-url"), app.count("second-instance")]).toEqual([0, 0]);
    },
  );
});
