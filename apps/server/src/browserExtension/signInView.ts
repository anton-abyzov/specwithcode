// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off -- plain async helpers over the relay hub, driven by tests with a fake extension.
/**
 * A person signs in on this machine's Chrome from another device (1488).
 *
 * The server opens a fresh tab and holds it for the person: no thread sees,
 * claims or stops it, and nothing from it reaches the audit list or a thread.
 * The person's window pulls frames and sends clicks, keys and text. Text is
 * sealed to this view's key on the person's device, so the relay and logs
 * carry only ciphertext, and it is unsealed only here, next to the tab.
 */
import * as NodeCrypto from "node:crypto";

import { newReceivingKey, type ReceivingKey, unseal } from "../fleet/fileTransfer/seal.ts";
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
const MAX_TEXT_CHARS = 1_000;
const MAX_SCROLL = 5_000;
const FRAME_QUALITY = 60;

export type SignInViewEnd = "done" | "cancelled" | "timed_out" | "tab_closed";

export interface SignInViewStarted {
  readonly viewId: string;
  readonly profile: string;
  /** The view's public key; the person's device seals typed text to it. */
  readonly publicKey: string;
  /** Short form of the key, shown on both devices so a swapped key is visible. */
  readonly fingerprint: string;
}

export interface SignInFrame {
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
}

export type SignInInput =
  | { readonly type: "click"; readonly x: number; readonly y: number }
  | {
      readonly type: "scroll";
      readonly x: number;
      readonly y: number;
      readonly deltaX: number;
      readonly deltaY: number;
    }
  /** A named key only (Enter, Tab, Backspace…); characters go through sealed text. */
  | { readonly type: "key"; readonly key: string }
  | { readonly type: "text"; readonly sealed: string };

interface View {
  readonly id: string;
  readonly profile: RelayProfile;
  readonly mainTab: number;
  /** Popups the sign-in opened, newest last; the view shows the newest. */
  readonly popups: number[];
  readonly key: ReceivingKey;
  readonly attached: Set<number>;
  timer: ReturnType<typeof setTimeout> | null;
  lastFrame: SignInFrame | null;
  capturing: Promise<SignInFrame> | null;
  dialog: string | null;
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

const finite = (value: unknown) => typeof value === "number" && Number.isFinite(value);
const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));

export class SignInViews {
  private readonly hub: BrowserRelayHub;
  private readonly views = new Map<string, View>();
  private readonly now: () => number;
  private readonly idleMs: number;
  private readonly onEnd: SignInViewsOptions["onEnd"];

  constructor(hub: BrowserRelayHub, options: SignInViewsOptions = {}) {
    this.hub = hub;
    this.now = options.now ?? Date.now;
    this.idleMs = options.idleMs ?? SIGN_IN_VIEW_IDLE_MS;
    this.onEnd = options.onEnd;
    hub.onHeldTabEvent((profile, viewId, event) => this.heldEvent(profile, viewId, event));
  }

  private cdp(view: View, tabId: number, method: string, params: object = {}) {
    return this.hub.call(view.profile.id, "chrome.debugger.sendCommand", [
      { tabId },
      method,
      params,
    ]);
  }

  private async attach(view: View, tabId: number) {
    if (view.attached.has(tabId)) return;
    try {
      await this.hub.call(view.profile.id, "chrome.debugger.attach", [{ tabId }, "1.3"]);
    } catch (error) {
      if (!/already attached/i.test(error instanceof Error ? error.message : String(error)))
        throw error;
    }
    view.attached.add(tabId);
    view.profile.attachedTabs.add(tabId);
    await this.cdp(view, tabId, "Page.enable").catch(() => {});
    await this.cdp(view, tabId, "Emulation.setFocusEmulationEnabled", { enabled: true }).catch(
      () => {},
    );
  }

  /**
   * Open a fresh tab at `url` and hold it for the person. The tab is held
   * before anything loads, and the debugger is attached anew after the hold,
   * so nothing a thread set up in that tab (scripts, captured traffic) lasts.
   */
  async start(input: { url: string; profile?: string | undefined }): Promise<SignInViewStarted> {
    const url = checkSignInUrl(input.url);
    const profile = this.hub.resolveProfile(input.profile);
    const tab = (await this.hub.call(profile.id, "chrome.tabs.create", [
      { url: "about:blank", active: true },
    ])) as { id?: number } | undefined;
    if (typeof tab?.id !== "number")
      throw new BrowserRelayError("page_error", "Chrome opened no tab.");
    const id = `signin-${NodeCrypto.randomUUID()}`;
    this.hub.holdForPerson(profile, tab.id, id);
    await this.hub
      .call(profile.id, "chrome.debugger.detach", [{ tabId: tab.id }], 5_000)
      .catch(() => {});
    profile.attachedTabs.delete(tab.id);
    const view: View = {
      id,
      profile,
      mainTab: tab.id,
      popups: [],
      key: newReceivingKey(),
      attached: new Set(),
      timer: null,
      lastFrame: null,
      capturing: null,
      dialog: null,
      ended: false,
    };
    this.views.set(id, view);
    this.touch(view);
    try {
      await this.attach(view, tab.id);
      await this.cdp(view, tab.id, "Page.navigate", { url });
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

  private activeTab(view: View) {
    return view.popups.at(-1) ?? view.mainTab;
  }

  private touch(view: View) {
    if (view.timer) clearTimeout(view.timer);
    view.timer = setTimeout(() => void this.end(view, "timed_out", false), this.idleMs);
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
      width: Math.max(1, Math.round(finite(port?.clientWidth) ? port!.clientWidth! : 1280)),
      height: Math.max(1, Math.round(finite(port?.clientHeight) ? port!.clientHeight! : 800)),
      pageX: finite(port?.pageX) ? port!.pageX! : 0,
      pageY: finite(port?.pageY) ? port!.pageY! : 0,
    };
  }

  /** The current page as Chrome's navigation history has it, not as the page says. */
  private async location(view: View, tabId: number) {
    const history = (await this.cdp(view, tabId, "Page.getNavigationHistory").catch(
      () => null,
    )) as { currentIndex?: number; entries?: Array<{ url?: string; title?: string }> } | null;
    const entry = history?.entries?.[history.currentIndex ?? -1];
    return { origin: originOf(entry?.url ?? ""), title: (entry?.title ?? "").slice(0, 200) };
  }

  /** The newest frame of the tab, captured at most every SIGN_IN_FRAME_MIN_MS. */
  async frame(viewId: string): Promise<SignInFrame> {
    const view = this.view(viewId);
    this.touch(view);
    if (view.lastFrame && this.now() - view.lastFrame.at < SIGN_IN_FRAME_MIN_MS)
      return view.lastFrame;
    if (view.capturing) return view.capturing;
    view.capturing = this.capture(view).finally(() => {
      view.capturing = null;
    });
    return view.capturing;
  }

  private async capture(view: View): Promise<SignInFrame> {
    const tabId = this.activeTab(view);
    await this.attach(view, tabId);
    const port = await this.viewport(view, tabId);
    const shot = (await this.cdp(view, tabId, "Page.captureScreenshot", {
      format: "jpeg",
      quality: FRAME_QUALITY,
      clip: { x: port.pageX, y: port.pageY, width: port.width, height: port.height, scale: 1 },
    })) as { data?: string } | undefined;
    if (typeof shot?.data !== "string")
      throw new BrowserRelayError("page_error", "Chrome returned no frame.");
    const where = await this.location(view, tabId);
    const dialog = view.dialog;
    view.dialog = null;
    const frame: SignInFrame = {
      data: shot.data,
      width: port.width,
      height: port.height,
      ...where,
      at: this.now(),
      ...(dialog ? { dialog } : {}),
    };
    view.lastFrame = frame;
    return frame;
  }

  async input(viewId: string, input: SignInInput): Promise<void> {
    const view = this.view(viewId);
    this.touch(view);
    if ("text" in (input as object))
      throw new BrowserRelayError(
        "invalid_request",
        "Typed text must be sealed to the view's key; plain text is refused.",
      );
    const tabId = this.activeTab(view);
    await this.attach(view, tabId);
    switch (input.type) {
      case "click":
      case "scroll": {
        if (!finite(input.x) || !finite(input.y))
          throw new BrowserRelayError("invalid_request", "A click needs x and y.");
        const port = view.lastFrame ?? (await this.viewport(view, tabId));
        const at = {
          x: clamp(input.x, 0, port.width - 1),
          y: clamp(input.y, 0, port.height - 1),
        };
        if (input.type === "scroll") {
          if (!finite(input.deltaX) || !finite(input.deltaY))
            throw new BrowserRelayError("invalid_request", "A scroll needs deltaX and deltaY.");
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
        // A single character would cross the relay in clear: those go through sealed text.
        const key =
          typeof input.key === "string" && [...input.key].length > 1
            ? keyDefinition(input.key)
            : null;
        if (!key)
          throw new BrowserRelayError(
            "invalid_request",
            "Only named keys (Enter, Tab, Backspace, Escape, arrows) are sent as keys; characters go through sealed text.",
          );
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
      case "text": {
        let text: string;
        try {
          text = unseal(String(input.sealed), view.key).toString("utf8");
        } catch {
          throw new BrowserRelayError(
            "invalid_request",
            "That text was not sealed to this sign-in view's key.",
          );
        }
        if ([...text].length > MAX_TEXT_CHARS)
          throw new BrowserRelayError("invalid_request", "Too much text in one input.");
        await this.cdp(view, tabId, "Input.insertText", { text });
        return;
      }
      default:
        throw new BrowserRelayError("invalid_request", "Unknown input.");
    }
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
      .map((view) => ({ viewId: view.id, profile: view.profile.label }));
  }

  private async end(view: View, end: SignInViewEnd, closeTabs: boolean) {
    if (view.ended) return;
    view.ended = true;
    if (view.timer) clearTimeout(view.timer);
    view.timer = null;
    view.lastFrame = null;
    this.views.delete(view.id);
    const tabs = [view.mainTab, ...view.popups];
    for (const tabId of tabs) this.hub.releasePersonTab(view.profile, tabId);
    await Promise.allSettled(
      tabs.map(async (tabId) => {
        if (closeTabs) {
          await this.hub.call(view.profile.id, "chrome.tabs.remove", [tabId], 5_000);
        } else if (view.attached.has(tabId)) {
          await this.hub.call(view.profile.id, "chrome.debugger.detach", [{ tabId }], 5_000);
        }
      }),
    );
    for (const tabId of tabs) view.profile.attachedTabs.delete(tabId);
    this.onEnd?.(view.id, end);
  }

  private heldEvent(profile: RelayProfile, viewId: string, event: HeldTabEvent) {
    const view = this.views.get(viewId);
    if (!view || view.ended || view.profile !== profile) return;
    switch (event.kind) {
      case "popup":
        view.popups.push(event.tabId);
        view.lastFrame = null;
        return;
      case "removed": {
        if (event.tabId === view.mainTab) {
          void this.end(view, "tab_closed", false);
          return;
        }
        const at = view.popups.indexOf(event.tabId);
        if (at >= 0) view.popups.splice(at, 1);
        view.attached.delete(event.tabId);
        view.lastFrame = null;
        return;
      }
      case "detached":
        view.attached.delete(event.tabId);
        return;
      case "cdp":
        if (event.method === "Page.javascriptDialogOpening") this.answerDialog(view, event);
        return;
    }
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
