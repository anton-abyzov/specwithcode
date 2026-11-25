// @effect-diagnostics globalTimers:off globalDate:off nodeBuiltinImport:off globalFetchInEffect:off -- The session rules are plain classes driven by Electron events: their timers, clock, store file and one loopback request run outside any Effect fiber.
/**
 * Screen sharing on this machine (1490): builds the store, the session rules,
 * the capture, the windows and the link to this machine's own server, and
 * gives the app's window four calls about them.
 *
 * The switch and the grants live only here, in the main process. The four
 * calls reach the machine the app runs on and no other, turning on asks the
 * system to authenticate a person, and no call starts a session or returns a
 * picture: sessions start only from an approved device through the server.
 */
import * as NodeFS from "node:fs";

import {
  PRIMARY_LOCAL_ENVIRONMENT_ID,
  SCREEN_SHARE_HOST_PATH,
  ScreenShareLocalState,
  type ScreenShareHostLink,
} from "@specweave-studio/contracts";
import { currentDesktopBootstrapToken } from "@specweave-studio/shared/desktopBootstrapToken";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Electron from "electron";

import * as DesktopEnvironment from "../../app/DesktopEnvironment.ts";
import * as DesktopBackendPool from "../../backend/DesktopBackendPool.ts";
import * as DesktopLocalEnvironmentAuth from "../../backend/DesktopLocalEnvironmentAuth.ts";
import * as DesktopLocalService from "../../backend/DesktopLocalService.ts";
import {
  DESKTOP_SERVICE_CREDENTIAL_FILE,
  isThisMachineServiceUrl,
  resolveDesktopOwnerProof,
} from "../../backend/desktopServiceCredential.ts";
import * as ElectronSafeStorage from "../../electron/ElectronSafeStorage.ts";
import { makeScreenCapture, screenRecordingGranted } from "../../screenShare/ScreenCapture.ts";
import { ScreenShareHost, type HostSocket } from "../../screenShare/ScreenShareHost.ts";
import {
  sealScreenShareStore,
  unsealScreenShareStore,
  type ScreenShareKeyWrap,
} from "../../screenShare/screenShareSeal.ts";
import { ScreenShareSessions } from "../../screenShare/screenShareSession.logic.ts";
import { ScreenShareStore } from "../../screenShare/ScreenShareStore.ts";
import { ScreenShareWindows } from "../../screenShare/ScreenShareWindows.ts";
import {
  SCREEN_SHARE_GET_STATE_CHANNEL,
  SCREEN_SHARE_REMOVE_GRANT_CHANNEL,
  SCREEN_SHARE_SET_ENABLED_CHANNEL,
  SCREEN_SHARE_SET_VIEWING_CHANNEL,
} from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

export const SCREEN_SHARE_STORE_FILE = "screen-share.bin";

/**
 * Windows of this app that are showing another machine's screen right now.
 * While there is one, computer use on this machine holds off: its screenshots
 * would carry the other machine's screen into a thread.
 */
export const screenShareViewing = (() => {
  const windows = new Set<number>();
  return {
    set: (id: number, viewing: boolean) => void (viewing ? windows.add(id) : windows.delete(id)),
    active: () => windows.size > 0,
  };
})();

export const SCREEN_SHARE_VIEWING_REFUSAL =
  "SpecWithCode is showing another machine's screen on this Mac right now, so computer use is paused here. It resumes when that view is closed.";

const NOT_HERE: ScreenShareLocalState = {
  supported: false,
  enabled: false,
  link: "connecting",
  screenRecording: false,
  storeHealthy: true,
  grants: [],
  audit: [],
  active: null,
};

/** The reason the system's dialog shows: one plain line, whatever a device is called. */
const dialogReason = (reason: string) =>
  reason
    .replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);

const openSocket = (url: string): HostSocket => {
  const ws = new WebSocket(url);
  ws.binaryType = "arraybuffer";
  let closed = false;
  const socket: HostSocket = {
    send: (data) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      ws.send(typeof data === "string" ? data : new Uint8Array(data));
    },
    close: () => ws.close(),
    onOpen: null,
    onMessage: null,
    onClose: null,
  };
  const done = (code: number, reason: string) => {
    if (closed) return;
    closed = true;
    socket.onClose?.(code, reason);
  };
  ws.addEventListener("open", () => socket.onOpen?.());
  ws.addEventListener("message", (event) => {
    const data: unknown = event.data;
    if (typeof data === "string") socket.onMessage?.(data);
    else if (data instanceof ArrayBuffer) socket.onMessage?.(new Uint8Array(data));
  });
  ws.addEventListener("close", (event) => done(event.code, event.reason));
  ws.addEventListener("error", () => done(1006, ""));
  return socket;
};

export const installScreenShare = Effect.fn("desktop.ipc.installScreenShare")(function* () {
  const ipc = yield* DesktopIpc.DesktopIpc;
  const environment = yield* DesktopEnvironment.DesktopEnvironment;

  const viewing = DesktopIpc.makeIpcMethod({
    channel: SCREEN_SHARE_SET_VIEWING_CHANNEL,
    payload: Schema.Boolean,
    result: Schema.Void,
    handler: (on, event) =>
      Effect.sync(() => {
        if (event === undefined) return;
        const id = event.sender.id;
        const contents = Electron.webContents.fromId(id);
        if (contents === undefined) return;
        screenShareViewing.set(id, on);
        // A window that closes or crashes while viewing stops counting.
        if (on) contents.once("destroyed", () => screenShareViewing.set(id, false));
      }),
  });
  yield* ipc.handle(viewing);

  if (environment.platform !== "darwin") {
    // Other systems cannot show their screen yet. The window still asks, and hears "not here".
    for (const channel of [SCREEN_SHARE_SET_ENABLED_CHANNEL, SCREEN_SHARE_REMOVE_GRANT_CHANNEL])
      yield* ipc.handle(
        DesktopIpc.makeIpcMethod({
          channel,
          payload: Schema.Unknown,
          result: ScreenShareLocalState,
          handler: () => Effect.succeed(NOT_HERE),
        }),
      );
    yield* ipc.handle(
      DesktopIpc.makeIpcMethod({
        channel: SCREEN_SHARE_GET_STATE_CHANNEL,
        payload: Schema.Undefined,
        result: ScreenShareLocalState,
        handler: () => Effect.succeed(NOT_HERE),
      }),
    );
    return;
  }

  const pool = yield* DesktopBackendPool.DesktopBackendPool;
  const localService = yield* DesktopLocalService.DesktopLocalService;
  const localAuth = yield* DesktopLocalEnvironmentAuth.DesktopLocalEnvironmentAuth;
  const safeStorage = yield* ElectronSafeStorage.ElectronSafeStorage;
  const runPromise = Effect.runPromiseWith(yield* Effect.context<never>());

  const wrap: ScreenShareKeyWrap = {
    available: () => Electron.safeStorage.isEncryptionAvailable(),
    wrap: (text) => Electron.safeStorage.encryptString(text),
    unwrap: (bytes) => Electron.safeStorage.decryptString(Buffer.from(bytes)),
  };
  const file = environment.path.join(environment.stateDir, SCREEN_SHARE_STORE_FILE);
  const store = new ScreenShareStore({
    read: () => (NodeFS.existsSync(file) ? NodeFS.readFileSync(file) : null),
    write: (bytes) => {
      // A temporary file, then a rename: a crash never leaves half a store.
      const temporary = `${file}.${process.pid}.tmp`;
      NodeFS.writeFileSync(temporary, bytes, { mode: 0o600 });
      NodeFS.renameSync(temporary, file);
    },
    canSeal: () => {
      try {
        return wrap.available();
      } catch {
        return false;
      }
    },
    seal: (text) => sealScreenShareStore(wrap, text),
    unseal: (bytes) => unsealScreenShareStore(wrap, bytes),
    now: () => Date.now(),
  });
  if (!store.storeHealthy)
    yield* Effect.logWarning(
      "The screen sharing store could not be opened. Sharing is off and every device is asked again.",
    );

  /**
   * Where this machine's server is and what proves this app to it: the owner
   * proof for the installed service, or the current token of the launch
   * secret for a backend this app started. Never sent off this machine.
   */
  const target = Effect.gen(function* () {
    const attached = yield* localService.attached;
    let httpBaseUrl: URL;
    let proof: string;
    if (Option.isSome(attached)) {
      httpBaseUrl = attached.value.httpBaseUrl;
      proof = yield* resolveDesktopOwnerProof({
        filePath: environment.path.join(environment.stateDir, DESKTOP_SERVICE_CREDENTIAL_FILE),
        key: attached.value.descriptor.environmentId,
        crypto: safeStorage,
      });
    } else {
      const primary = (yield* pool.list).find(
        (instance) => instance.id === PRIMARY_LOCAL_ENVIRONMENT_ID,
      );
      const config = primary === undefined ? Option.none() : yield* primary.currentConfig;
      const secret = Option.getOrUndefined(config)?.bootstrap.desktopBootstrapSecret;
      if (Option.isNone(config) || secret === undefined) return null;
      httpBaseUrl = config.value.httpBaseUrl;
      proof = currentDesktopBootstrapToken(secret, yield* Clock.currentTimeMillis);
    }
    if (!isThisMachineServiceUrl(httpBaseUrl)) return null;
    const bearer = yield* localAuth.getBearerToken;
    const ticket = yield* Effect.tryPromise(async () => {
      const response = await fetch(new URL("/api/auth/websocket-ticket", httpBaseUrl), {
        method: "POST",
        headers: { authorization: `Bearer ${bearer}` },
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error(`ticket ${response.status}`);
      const body = (await response.json()) as { readonly ticket?: unknown };
      if (typeof body.ticket !== "string") throw new Error("no ticket");
      return body.ticket;
    });
    const url = new URL(SCREEN_SHARE_HOST_PATH, httpBaseUrl);
    url.protocol = httpBaseUrl.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set("wsTicket", ticket);
    return { url: url.href, proof };
  }).pipe(Effect.orElseSucceed(() => null));

  const capture = makeScreenCapture();
  const after = (ms: number, run: () => void) => {
    const timer = setTimeout(run, ms);
    return () => clearTimeout(timer);
  };
  // The three depend on each other; each reaches the others only when called.
  const windows: ScreenShareWindows = new ScreenShareWindows(
    environment.path.join(environment.dirname, "screen-share-preload.cjs"),
    {
      answer: (sid, answer) => void sessions.answerPrompt(sid, answer),
      stop: () => sessions.stop(),
      bannerLost: () => sessions.bannerLost(),
    },
  );
  const sessions: ScreenShareSessions = new ScreenShareSessions({
    store,
    platformSupported: true,
    screenRecording: screenRecordingGranted,
    now: () => Date.now(),
    after,
    send: (sid, payload) => host.send(sid, payload),
    close: (sid, reason) => host.close(sid, reason),
    // Touch ID, Apple Watch or the account password, in the system's own dialog.
    authenticate: (reason) =>
      Electron.systemPreferences.promptTouchID(dialogReason(reason)).then(
        () => true,
        () => false,
      ),
    prompt: { show: (view) => windows.showPrompt(view), hide: () => windows.hidePrompt() },
    banner: { show: (view) => windows.showBanner(view), hide: () => windows.hideBanner() },
    capture,
    changed: () => host.publishStatus(),
  });
  const recordLink = (link: ScreenShareHostLink) => {
    if (link !== "refused" && link !== "replaced") return;
    const at = new Date().toISOString();
    store.recordAudit({
      id: `link-${at}`,
      at,
      label: "This machine's own app",
      shortId: "",
      mode: "view",
      outcome: "refused",
      reason: link === "refused" ? "host_refused" : "host_replaced",
      endedAt: at,
    });
  };
  const host: ScreenShareHost = new ScreenShareHost({
    target: () => runPromise(target),
    open: openSocket,
    after,
    sessions,
    onLink: recordLink,
  });

  const state = (): ScreenShareLocalState => ({
    supported: sessions.status().supported,
    enabled: store.enabled,
    link: host.state,
    screenRecording: screenRecordingGranted(),
    storeHealthy: store.storeHealthy,
    grants: [...store.grants],
    audit: [...store.audit].reverse(),
    active: sessions.active(),
  });

  yield* ipc.handle(
    DesktopIpc.makeIpcMethod({
      channel: SCREEN_SHARE_GET_STATE_CHANNEL,
      payload: Schema.Undefined,
      result: ScreenShareLocalState,
      handler: () => Effect.sync(state),
    }),
  );
  yield* ipc.handle(
    DesktopIpc.makeIpcMethod({
      channel: SCREEN_SHARE_SET_ENABLED_CHANNEL,
      payload: Schema.Boolean,
      result: ScreenShareLocalState,
      handler: (enabled) =>
        Effect.promise(() => sessions.setEnabled(enabled)).pipe(
          Effect.tap((saved) =>
            Effect.logInfo("Screen sharing switch.", { asked: enabled, saved, now: store.enabled }),
          ),
          Effect.map(state),
        ),
    }),
  );
  yield* ipc.handle(
    DesktopIpc.makeIpcMethod({
      channel: SCREEN_SHARE_REMOVE_GRANT_CHANNEL,
      payload: Schema.String,
      result: ScreenShareLocalState,
      handler: (thumbprint) =>
        Effect.sync(() => {
          sessions.removeGrant(thumbprint);
          return state();
        }),
    }),
  );

  yield* Effect.acquireRelease(
    Effect.sync(() => host.start()),
    () =>
      Effect.promise(async () => {
        sessions.shutdown();
        // Long enough for the last word to reach the viewer, never a reason to hang the quit.
        await Promise.race([sessions.idle(), new Promise((resolve) => setTimeout(resolve, 500))]);
        host.stop();
        windows.dispose();
        capture.dispose();
      }),
  );
});
