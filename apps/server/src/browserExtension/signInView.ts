// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off -- plain async helpers over the relay hub, driven by tests with a fake extension.
/**
 * A person signs in on this machine's Chrome from another device (1488).
 *
 * The server opens a fresh tab and holds it for the person: no thread sees,
 * claims or stops it, the hub refuses every call into it that does not come
 * from its view, and nothing from it reaches the audit list or a thread.
 *
 * Both directions are sealed end to end (`seal.ts`): frames to the key the
 * person's device sent with `start`, typed text to this view's key. The relay
 * and logs carry only ciphertext. Each frame names the document it shows, and
 * input aimed at another document (a redirect, a popup) is refused, so text
 * never lands on a page the person did not see.
 *
 * A page that asks for a passkey is reported to the view. Chrome draws its
 * passkey window outside the page, and a phone passkey (the hybrid QR flow)
 * needs the phone next to this machine for its Bluetooth check, so nothing of
 * WebAuthn is shown, relayed or proxied: the person is told and picks another
 * way to sign in.
 */
import * as NodeCrypto from "node:crypto";

import { newReceivingKey, type ReceivingKey, seal, unseal } from "../fleet/fileTransfer/seal.ts";
import { keyDefinition } from "./pageScripts.ts";
import {
  BrowserRelayError,
  type BrowserRelayHub,
  type HeldTabEvent,
  type RelayProfile,
} from "./relayHub.ts";

/** A view with no frame pulled and no input for this long ends on its own. */
export const SIGN_IN_VIEW_IDLE_MS = 10 * 60_000;
/** Frames are captured at most this often; a faster pull gets the last one again. */
export const SIGN_IN_FRAME_MIN_MS = 450;
/** Separates this use of the sealing format from fleet file transfer. */
export const SIGN_IN_SEAL_INFO = new TextEncoder().encode("specwithcode sign-in view v1");
/** Bounds a sealed input before anything decodes it. */
export const MAX_SEALED_INPUT_CHARS = 16_384;
const MAX_TEXT_CHARS = 1_000;
const MAX_SCROLL = 5_000;
const FRAME_QUALITY = 60;
const PASSKEY_BINDING = "__swcSignInPasskey";

/** Keys that carry no character of their own; characters go through sealed text. */
export const SIGN_IN_NAMED_KEYS: ReadonlySet<string> = new Set([
  "enter",
  "tab",
  "backspace",
  "delete",
  "escape",
  "arrowup",
  "arrowdown",
  "arrowleft",
  "arrowright",
  "home",
  "end",
  "pageup",
  "pagedown",
]);

export const PASSKEY_NOTICE =
  "This page asked for a passkey. Chrome shows its passkey window on this machine, outside this view, and a passkey on your phone works only next to this machine (Bluetooth check). Choose another way to sign in on the page, or Cancel.";

/**
 * Tells the view when the page asks for a passkey: the kind and the site, nothing else.
 * The page's own call goes on unchanged.
 */
export const PASSKEY_WATCH_SCRIPT = `(() => {
  const c = navigator.credentials;
  if (!c || c.__swcWatched) return;
  const tell = (kind, options) => {
    try {
      const key = options && options.publicKey;
      if (!key) return;
      const rp = kind === "create" ? key.rp && key.rp.id : key.rpId;
      globalThis[${JSON.stringify(PASSKEY_BINDING)}](JSON.stringify({ kind, rpId: typeof rp === "string" ? rp : "" }));
    } catch {}
  };
  const get = c.get.bind(c);
  const create = c.create.bind(c);
  Object.defineProperty(c, "__swcWatched", { value: true });
  c.get = (options) => (tell("get", options), get(options));
  c.create = (options) => (tell("create", options), create(options));
})();`;

export type SignInViewEnd = "done" | "cancelled" | "timed_out" | "tab_closed";

export interface SignInViewStarted {
  readonly viewId: string;
  readonly profile: string;
  /** The view's public key; the person's device seals typed text to it. */
  readonly publicKey: string;
  /** Short form of the key, shown on both devices so a swapped key is visible. */
  readonly fingerprint: string;
}

/** What a sealed frame holds once the person's device opens it. */
export interface SignInFrame {
  /** Names the tab and document this frame shows; input must name it back. */
  readonly frame: string;
  /** Base64 JPEG, one pixel per CSS pixel. */
  readonly data: string;
  readonly width: number;
  readonly height: number;
  /** The page's origin as Chrome reports it, never as the page or an agent says. */
  readonly origin: string;
  readonly title: string;
  readonly at: number;
  /** A dialog the page showed since the last frame, already answered. */
  readonly dialog?: string;
  /** Set while the shown page has asked for a passkey. */
  readonly passkey?: {
    readonly kind: "get" | "create";
    readonly rpId: string;
    readonly notice: string;
  };
}

/** What a sealed text input holds before sealing. */
export interface SignInTextPayload {
  /** Grows with every text input of a view; a repeat or an older one is refused. */
  readonly seq: number;
  /** The frame the person typed against. */
  readonly frame: string;
  readonly text: string;
}

export type SignInInput =
  | { readonly type: "click"; readonly frame: string; readonly x: number; readonly y: number }
  | {
      readonly type: "scroll";
      readonly frame: string;
      readonly x: number;
      readonly y: number;
      readonly deltaX: number;
      readonly deltaY: number;
    }
  /** A named key only (Enter, Tab, Backspace…); characters go through sealed text. */
  | { readonly type: "key"; readonly frame: string; readonly key: string }
  | { readonly type: "text"; readonly sealed: string };

interface Location {
  readonly frame: string;
  readonly entryId: number;
  readonly url: string;
  readonly origin: string;
  readonly title: string;
}

interface View {
  readonly id: string;
  readonly personKey: string;
  readonly profileLabel: string;
  readonly mainTab: number;
  /** Popups the sign-in opened, newest last; the view shows the newest. */
  readonly popups: number[];
  readonly key: ReceivingKey;
  readonly viewerKey: string;
  readonly attached: Set<number>;
  /** Calls in flight; teardown waits for them. */
  readonly busy: Set<Promise<unknown>>;
  timer: ReturnType<typeof setTimeout> | null;
  lastFrame: { readonly sealed: string; readonly at: number; readonly location: Location } | null;
  capturing: Promise<{ sealed: string }> | null;
  dialog: string | null;
  passkey: { kind: "get" | "create"; rpId: string; frame: string } | null;
  lastSeq: number;
  ended: boolean;
}

export interface SignInViewsOptions {
  readonly now?: () => number;
  readonly idleMs?: number;
  /** Told how a view ended; the asking thread hears only this, never addresses or frames. */
  readonly onEnd?: (viewId: string, end: SignInViewEnd) => void;
}

/** Sign-in pages must be https: the person types secrets there. */
export function checkSignInUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new BrowserRelayError("invalid_request", "Not an absolute URL.");
  }
  if (parsed.protocol !== "https:")
    throw new BrowserRelayError("invalid_request", "A sign-in page must be an https address.");
  return parsed.href;
}

export function keyFingerprint(publicKey: string): string {
  const hex = NodeCrypto.createHash("sha256")
    .update(Buffer.from(publicKey, "base64"))
    .digest("hex");
  return [0, 4, 8, 12].map((at) => hex.slice(at, at + 4)).join("-");
}

const originOf = (url: string) => {
  try {
    const parsed = new URL(url);
    return parsed.origin === "null" ? parsed.protocol : parsed.origin;
  } catch {
    return "";
  }
};

const finite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);
const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));

const pageChanged = () =>
  new BrowserRelayError(
    "invalid_request",
    "The page changed since the frame you acted on. Look at the new frame and try again.",
  );

/** One fixed answer for every failure of a command that carries a secret. */
const textRefused = () =>
  new BrowserRelayError(
    "invalid_request",
    "That text was not typed. Look at the page and try again.",
  );

export class SignInViews {
  private readonly hub: BrowserRelayHub;
  private readonly views = new Map<string, View>();
  /** Views whose teardown could not finish; finished when their profile reconnects. */
  private readonly orphans = new Map<string, { view: View; closeTabs: boolean }>();
  private readonly now: () => number;
  private readonly idleMs: number;
  private readonly onEnd: SignInViewsOptions["onEnd"];
  private readonly unsubscribe: () => void;

  constructor(hub: BrowserRelayHub, options: SignInViewsOptions = {}) {
    this.hub = hub;
    this.now = options.now ?? Date.now;
    this.idleMs = options.idleMs ?? SIGN_IN_VIEW_IDLE_MS;
    this.onEnd = options.onEnd;
    this.unsubscribe = hub.onHeldTabEvent((profile, viewId, event) =>
      this.heldEvent(profile, viewId, event),
    );
  }

  /** Stop listening; open views end as cancelled. */
  async dispose() {
    this.unsubscribe();
    await Promise.allSettled(
      [...this.views.values()].map((view) => this.end(view, "cancelled", true)),
    );
  }

  private profile(view: View): RelayProfile {
    const profile = this.hub.profileByPersonKey(view.personKey);
    if (!profile)
      throw new BrowserRelayError("not_connected", "That Chrome profile is not connected.");
    return profile;
  }

  private call(view: View, method: string, params: ReadonlyArray<unknown>, timeoutMs?: number) {
    const run = this.hub.call(this.profile(view).id, method, params, timeoutMs, view.id);
    view.busy.add(run);
    void run.then(
      () => view.busy.delete(run),
      () => view.busy.delete(run),
    );
    return run;
  }

  private cdp(view: View, tabId: number, method: string, params: object = {}) {
    return this.call(view, "chrome.debugger.sendCommand", [{ tabId }, method, params]);
  }

  /**
   * Attach to a held tab. "Already attached" means some other debugger
   * (DevTools, another extension) holds it, so the tab is not known to be clean.
   */
  private async attach(view: View, tabId: number) {
    if (view.attached.has(tabId)) return;
    try {
      await this.call(view, "chrome.debugger.attach", [{ tabId }, "1.3"]);
    } catch (error) {
      if (/already attached/i.test(error instanceof Error ? error.message : String(error)))
        throw new BrowserRelayError(
          "page_error",
          "Another debugger is attached to that tab, so it cannot be held for you. Close DevTools in that tab and try again.",
        );
      throw error;
    }
    if (view.ended) {
      await this.call(view, "chrome.debugger.detach", [{ tabId }], 5_000).catch(() => {});
      throw new BrowserRelayError("invalid_request", "That sign-in view has ended.");
    }
    view.attached.add(tabId);
    this.profile(view).attachedTabs.add(tabId);
    await this.cdp(view, tabId, "Page.enable").catch(() => {});
    await this.cdp(view, tabId, "Emulation.setFocusEmulationEnabled", { enabled: true }).catch(
      () => {},
    );
    // Passkey requests are reported to the view; the call itself is left alone. Chrome puts a
    // binding into pages loaded later only while the Runtime domain is on (checked on real
    // Chrome); its events stay between the extension and this server.
    await this.cdp(view, tabId, "Runtime.enable").catch(() => {});
    await this.cdp(view, tabId, "Runtime.addBinding", { name: PASSKEY_BINDING }).catch(() => {});
    await this.cdp(view, tabId, "Page.addScriptToEvaluateOnNewDocument", {
      source: PASSKEY_WATCH_SCRIPT,
    }).catch(() => {});
    await this.cdp(view, tabId, "Runtime.evaluate", { expression: PASSKEY_WATCH_SCRIPT }).catch(
      () => {},
    );
  }

  /**
   * Open a fresh tab at `url` and hold it for the person. No thread may take a
   * new tab until the hold is in place, and the debugger session is dropped and
   * opened anew after it, so nothing a thread set up in that tab lasts.
   * `viewerKey` is the person's device's X25519 public key; frames are sealed to it.
   */
  async start(input: {
    url: string;
    viewerKey: string;
    profile?: string | undefined;
  }): Promise<SignInViewStarted> {
    const url = checkSignInUrl(input.url);
    try {
      seal(new Uint8Array(1), input.viewerKey, SIGN_IN_SEAL_INFO);
    } catch {
      throw new BrowserRelayError(
        "invalid_request",
        "The viewer's key is not an X25519 public key.",
      );
    }
    const profile = this.hub.resolveProfile(input.profile);
    const id = `signin-${NodeCrypto.randomUUID()}`;
    const endCreate = this.hub.beginPersonCreate(profile);
    let tabId: number;
    try {
      const tab = (await this.hub.call(profile.id, "chrome.tabs.create", [
        { url: "about:blank", active: true },
      ])) as { id?: number } | undefined;
      if (typeof tab?.id !== "number")
        throw new BrowserRelayError("page_error", "Chrome opened no tab.");
      tabId = tab.id;
      this.hub.holdForPerson(profile, tabId, id);
    } finally {
      endCreate();
    }
    const view: View = {
      id,
      personKey: profile.personKey,
      profileLabel: profile.label,
      mainTab: tabId,
      popups: [],
      key: newReceivingKey(),
      viewerKey: input.viewerKey,
      attached: new Set(),
      busy: new Set(),
      timer: null,
      lastFrame: null,
      capturing: null,
      dialog: null,
      passkey: null,
      lastSeq: 0,
      ended: false,
    };
    this.views.set(id, view);
    this.touch(view);
    try {
      // Drop whatever session another caller may have opened; "not attached" is the clean case.
      await this.call(view, "chrome.debugger.detach", [{ tabId }], 5_000).catch((error) => {
        if (!/not attached/i.test(error instanceof Error ? error.message : String(error)))
          throw error;
      });
      profile.attachedTabs.delete(tabId);
      await this.attach(view, tabId);
      await this.cdp(view, tabId, "Page.navigate", { url });
    } catch (error) {
      await this.end(view, "cancelled", true);
      throw error;
    }
    return {
      viewId: id,
      profile: profile.label,
      publicKey: view.key.publicKey,
      fingerprint: keyFingerprint(view.key.publicKey),
    };
  }

  private view(viewId: string): View {
    const view = this.views.get(viewId);
    if (!view || view.ended)
      throw new BrowserRelayError("invalid_request", "That sign-in view has ended.");
    return view;
  }

  /** The newest popup that is still open, else the main tab. */
  private async activeTab(view: View) {
    while (view.popups.length > 0) {
      const popup = view.popups.at(-1)!;
      const open = await this.call(view, "chrome.tabs.get", [popup], 5_000).then(
        () => true,
        () => false,
      );
      if (open) return popup;
      this.dropPopup(view, popup);
    }
    return view.mainTab;
  }

  private dropPopup(view: View, tabId: number) {
    const at = view.popups.indexOf(tabId);
    if (at >= 0) view.popups.splice(at, 1);
    view.attached.delete(tabId);
    this.hub.profileByPersonKey(view.personKey)?.personTabs.delete(tabId);
    view.lastFrame = null;
  }

  private touch(view: View) {
    if (view.timer) clearTimeout(view.timer);
    view.timer = setTimeout(() => void this.end(view, "timed_out", true), this.idleMs);
  }

  private async viewport(view: View, tabId: number) {
    const metrics = (await this.cdp(view, tabId, "Page.getLayoutMetrics").catch(() => null)) as {
      cssVisualViewport?: {
        clientWidth?: number;
        clientHeight?: number;
        pageX?: number;
        pageY?: number;
      };
    } | null;
    const port = metrics?.cssVisualViewport;
    return {
      width: Math.max(1, Math.round(finite(port?.clientWidth) ? port.clientWidth : 1280)),
      height: Math.max(1, Math.round(finite(port?.clientHeight) ? port.clientHeight : 800)),
      pageX: finite(port?.pageX) ? port.pageX : 0,
      pageY: finite(port?.pageY) ? port.pageY : 0,
    };
  }

  /** The current document as Chrome's navigation history has it, not as the page says. */
  private async location(view: View, tabId: number): Promise<Location> {
    const history = (await this.cdp(view, tabId, "Page.getNavigationHistory")) as {
      currentIndex?: number;
      entries?: Array<{ id?: number; url?: string; title?: string }>;
    } | null;
    const entry = history?.entries?.[history.currentIndex ?? -1];
    const entryId = typeof entry?.id === "number" ? entry.id : -1;
    const url = entry?.url ?? "";
    return {
      frame: `${tabId}:${entryId}`,
      entryId,
      url,
      origin: originOf(url),
      title: (entry?.title ?? "").slice(0, 200),
    };
  }

  /** The newest frame of the tab, sealed to the viewer's key. */
  async frame(viewId: string): Promise<{ sealed: string }> {
    const view = this.view(viewId);
    this.touch(view);
    if (view.lastFrame && this.now() - view.lastFrame.at < SIGN_IN_FRAME_MIN_MS)
      return { sealed: view.lastFrame.sealed };
    if (view.capturing) return view.capturing;
    const capture = this.capture(view).finally(() => {
      view.capturing = null;
    });
    view.capturing = capture;
    view.busy.add(capture);
    void capture.then(
      () => view.busy.delete(capture),
      () => view.busy.delete(capture),
    );
    return capture;
  }

  private async capture(view: View): Promise<{ sealed: string }> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const tabId = await this.activeTab(view);
      await this.attach(view, tabId);
      const before = await this.location(view, tabId);
      const port = await this.viewport(view, tabId);
      const shot = (await this.cdp(view, tabId, "Page.captureScreenshot", {
        format: "jpeg",
        quality: FRAME_QUALITY,
        clip: { x: port.pageX, y: port.pageY, width: port.width, height: port.height, scale: 1 },
      })) as { data?: string } | undefined;
      if (typeof shot?.data !== "string")
        throw new BrowserRelayError("page_error", "Chrome returned no frame.");
      const after = await this.location(view, tabId);
      // The page moved on while the frame was taken: those pixels may not be that origin's.
      if (after.frame !== before.frame || after.url !== before.url) continue;
      const dialog = view.dialog;
      view.dialog = null;
      const passkey = view.passkey?.frame === after.frame ? view.passkey : null;
      const frame: SignInFrame = {
        frame: after.frame,
        data: shot.data,
        width: port.width,
        height: port.height,
        origin: after.origin,
        title: after.title,
        at: this.now(),
        ...(dialog ? { dialog } : {}),
        ...(passkey
          ? { passkey: { kind: passkey.kind, rpId: passkey.rpId, notice: PASSKEY_NOTICE } }
          : {}),
      };
      const sealed = seal(Buffer.from(JSON.stringify(frame)), view.viewerKey, SIGN_IN_SEAL_INFO);
      view.lastFrame = { sealed, at: frame.at, location: after };
      return { sealed };
    }
    throw new BrowserRelayError("page_error", "The page keeps changing. Try again in a moment.");
  }

  /** The tab and document input lands on, refused unless it is the one the person saw. */
  private async target(view: View, frame: unknown) {
    const tabId = await this.activeTab(view);
    await this.attach(view, tabId);
    const now = await this.location(view, tabId);
    if (typeof frame !== "string" || frame !== now.frame) throw pageChanged();
    return { tabId, location: now };
  }

  async input(viewId: string, input: SignInInput): Promise<void> {
    const view = this.view(viewId);
    this.touch(view);
    if (typeof input !== "object" || input === null || "text" in input)
      throw new BrowserRelayError(
        "invalid_request",
        "Typed text must be sealed to the view's key; plain text is refused.",
      );
    switch (input.type) {
      case "click":
      case "scroll": {
        if (!finite(input.x) || !finite(input.y))
          throw new BrowserRelayError("invalid_request", "A click needs x and y.");
        if (input.type === "scroll" && (!finite(input.deltaX) || !finite(input.deltaY)))
          throw new BrowserRelayError("invalid_request", "A scroll needs deltaX and deltaY.");
        const { tabId } = await this.target(view, input.frame);
        const port = await this.viewport(view, tabId);
        const at = {
          x: clamp(input.x, 0, port.width - 1),
          y: clamp(input.y, 0, port.height - 1),
        };
        if (input.type === "scroll") {
          await this.cdp(view, tabId, "Input.dispatchMouseEvent", {
            type: "mouseWheel",
            ...at,
            deltaX: clamp(input.deltaX, -MAX_SCROLL, MAX_SCROLL),
            deltaY: clamp(input.deltaY, -MAX_SCROLL, MAX_SCROLL),
          });
          return;
        }
        await this.cdp(view, tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", ...at });
        for (const type of ["mousePressed", "mouseReleased"] as const)
          await this.cdp(view, tabId, "Input.dispatchMouseEvent", {
            type,
            ...at,
            button: "left",
            clickCount: 1,
          });
        return;
      }
      case "key": {
        const name = typeof input.key === "string" ? input.key.trim().toLowerCase() : "";
        const key = SIGN_IN_NAMED_KEYS.has(name) ? keyDefinition(name) : null;
        if (!key)
          throw new BrowserRelayError(
            "invalid_request",
            "Only named keys (Enter, Tab, Backspace, Delete, Escape, arrows, Home, End, Page Up, Page Down) are sent as keys; characters go through sealed text.",
          );
        const { tabId } = await this.target(view, input.frame);
        const base = {
          key: key.key,
          code: key.code,
          windowsVirtualKeyCode: key.keyCode,
          nativeVirtualKeyCode: key.keyCode,
        };
        await this.cdp(view, tabId, "Input.dispatchKeyEvent", {
          type: key.text ? "keyDown" : "rawKeyDown",
          ...base,
          ...(key.text ? { text: key.text, unmodifiedText: key.text } : {}),
        });
        await this.cdp(view, tabId, "Input.dispatchKeyEvent", { type: "keyUp", ...base });
        return;
      }
      case "text":
        return this.typeSealed(view, input.sealed);
      default:
        throw new BrowserRelayError("invalid_request", "Unknown input.");
    }
  }

  private async typeSealed(view: View, sealed: unknown) {
    if (typeof sealed !== "string" || sealed.length > MAX_SEALED_INPUT_CHARS) throw textRefused();
    let payload: SignInTextPayload;
    try {
      payload = JSON.parse(unseal(sealed, view.key, SIGN_IN_SEAL_INFO).toString("utf8"));
    } catch {
      throw textRefused();
    }
    if (
      !Number.isSafeInteger(payload?.seq) ||
      payload.seq <= view.lastSeq ||
      typeof payload.text !== "string" ||
      [...payload.text].length > MAX_TEXT_CHARS
    )
      throw textRefused();
    // Spent before anything can fail, so the same blob never types twice.
    view.lastSeq = payload.seq;
    const { tabId, location } = await this.target(view, payload.frame).catch(() => {
      throw textRefused();
    });
    if (!location.url.startsWith("https://")) throw textRefused();
    await this.cdp(view, tabId, "Input.insertText", { text: payload.text }).catch(() => {
      throw textRefused();
    });
  }

  /** The person is signed in: let go of the tab and keep it open, so the session stays. */
  done(viewId: string) {
    return this.end(this.view(viewId), "done", false);
  }

  /** The person gave up: close the tab. */
  cancel(viewId: string) {
    return this.end(this.view(viewId), "cancelled", true);
  }

  /** Views that are still open, with no address or frame. */
  open(): Array<{ viewId: string; profile: string }> {
    return [...this.views.values()]
      .filter((view) => !view.ended)
      .map((view) => ({ viewId: view.id, profile: view.profileLabel }));
  }

  /**
   * End a view. The tabs stay held until Chrome confirmed their close (or the
   * debugger let go), after the calls in flight settle. A teardown that fails
   * keeps the hold and finishes when the profile reconnects.
   */
  private async end(view: View, end: SignInViewEnd, closeTabs: boolean) {
    if (view.ended) return;
    view.ended = true;
    if (view.timer) clearTimeout(view.timer);
    view.timer = null;
    view.lastFrame = null;
    this.views.delete(view.id);
    await Promise.allSettled(view.busy);
    const finished = await this.teardown(view, closeTabs);
    if (!finished) this.orphans.set(view.id, { view, closeTabs });
    this.onEnd?.(view.id, end);
  }

  private async teardown(view: View, closeTabs: boolean): Promise<boolean> {
    const profile = this.hub.profileByPersonKey(view.personKey);
    if (!profile) return false;
    const tabs = [view.mainTab, ...view.popups];
    const results = await Promise.allSettled(
      tabs.map(async (tabId) => {
        if (closeTabs) {
          await this.hub
            .call(profile.id, "chrome.tabs.remove", [tabId], 5_000, view.id)
            .catch(async (error) => {
              // Already closed is closed.
              const open = await this.hub
                .call(profile.id, "chrome.tabs.get", [tabId], 5_000, view.id)
                .then(
                  () => true,
                  () => false,
                );
              if (open) throw error;
            });
        } else {
          await this.hub
            .call(profile.id, "chrome.debugger.detach", [{ tabId }], 5_000, view.id)
            .catch((error) => {
              if (
                !/not attached|no tab/i.test(error instanceof Error ? error.message : String(error))
              )
                throw error;
            });
        }
      }),
    );
    if (results.some((result) => result.status === "rejected")) return false;
    for (const tabId of tabs) {
      this.hub.releasePersonTab(profile, tabId);
      profile.attachedTabs.delete(tabId);
    }
    return true;
  }

  private heldEvent(profile: RelayProfile, viewId: string, event: HeldTabEvent) {
    if (event.kind === "reconnected") {
      const orphan = this.orphans.get(viewId);
      if (orphan) {
        this.orphans.delete(viewId);
        void this.teardown(orphan.view, orphan.closeTabs).then((done) => {
          if (!done) this.orphans.set(viewId, orphan);
        });
        return;
      }
    }
    const view = this.views.get(viewId);
    if (!view || view.ended || view.personKey !== profile.personKey) return;
    switch (event.kind) {
      case "popup":
        view.popups.push(event.tabId);
        view.lastFrame = null;
        // Attach at once, so the popup's own popups and its closing are reported too.
        void this.attach(view, event.tabId).catch(() => {});
        return;
      case "removed":
        if (event.tabId === view.mainTab) {
          void this.end(view, "tab_closed", false);
          return;
        }
        this.dropPopup(view, event.tabId);
        return;
      case "detached":
      case "reconnected":
        view.attached.delete(event.tabId);
        view.lastFrame = null;
        return;
      case "cdp":
        if (event.method === "Page.javascriptDialogOpening") this.answerDialog(view, event);
        else if (event.method === "Runtime.bindingCalled") this.passkeyAsked(view, event);
        return;
    }
  }

  private passkeyAsked(view: View, event: Extract<HeldTabEvent, { kind: "cdp" }>) {
    const call = (event.params ?? {}) as { name?: unknown; payload?: unknown };
    if (call.name !== PASSKEY_BINDING || typeof call.payload !== "string") return;
    let asked: { kind?: unknown; rpId?: unknown };
    try {
      asked = JSON.parse(call.payload.slice(0, 1_000));
    } catch {
      return;
    }
    const kind = asked.kind === "create" ? "create" : asked.kind === "get" ? "get" : null;
    if (!kind) return;
    const rpId = typeof asked.rpId === "string" ? asked.rpId.slice(0, 253) : "";
    // Tied to the document Chrome shows now; a navigation clears it.
    void this.location(view, event.tabId)
      .then((location) => {
        view.passkey = { kind, rpId, frame: location.frame };
        view.lastFrame = null;
      })
      .catch(() => {});
  }

  /** Same rule as the hub: alerts and leave-page prompts accepted, confirm and prompt dismissed. */
  private answerDialog(view: View, event: Extract<HeldTabEvent, { kind: "cdp" }>) {
    const dialog = (event.params ?? {}) as { type?: unknown; message?: unknown };
    const type = typeof dialog.type === "string" ? dialog.type : "alert";
    const accept = type === "alert" || type === "beforeunload";
    const message = typeof dialog.message === "string" ? dialog.message.slice(0, 300) : "";
    view.dialog = `${type} ${accept ? "accepted" : "dismissed"}: ${message}`;
    void this.cdp(view, event.tabId, "Page.handleJavaScriptDialog", { accept }).catch(() => {});
  }
}
