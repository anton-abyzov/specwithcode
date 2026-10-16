// @effect-diagnostics globalDate:off globalTimers:off -- plain async helpers over the relay hub, driven by tests with a fake extension.
/**
 * What the `chrome_*` tools on studio-code do in a paired Chrome profile.
 * Plain async functions over the relay hub, so tests can drive them with a
 * fake extension. Every action holds the profile for the calling thread and
 * lands in the audit list Settings › Chrome shows.
 */
import { BrowserRelayError, type BrowserRelayHub, type RelayProfile } from "./relayHub.ts";
import {
  type ElementTarget,
  domClickScript,
  keyDefinition,
  locateScript,
  PAGE_IDENTITY_SCRIPT,
  READY_STATE_SCRIPT,
  snapshotScript,
} from "./pageScripts.ts";

const LOAD_TIMEOUT_MS = 15_000;
const SETTLE_MS = 300;
const DEFAULT_TEXT_CHARS = 12_000;

interface ChromeTab {
  readonly id?: number;
  readonly title?: string;
  readonly url?: string;
  readonly pendingUrl?: string;
  readonly active?: boolean;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Agents may only load web pages, never chrome://, file:// or javascript: URLs. */
export function checkUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new BrowserRelayError("invalid_request", `Not an absolute URL: ${url}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:" && parsed.href !== "about:blank")
    throw new BrowserRelayError(
      "invalid_request",
      "Only http and https pages can be opened in the user's Chrome.",
    );
  return parsed.href;
}

export class ChromeTools {
  private readonly hub: BrowserRelayHub;
  constructor(hub: BrowserRelayHub) {
    this.hub = hub;
  }

  private cdp(profile: RelayProfile, tabId: number, method: string, params: object = {}) {
    return this.hub.call(profile.id, "chrome.debugger.sendCommand", [{ tabId }, method, params]);
  }

  private async attach(profile: RelayProfile, tabId: number) {
    if (profile.attachedTabs.has(tabId)) return;
    try {
      await this.hub.call(profile.id, "chrome.debugger.attach", [{ tabId }, "1.3"]);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // Another debugger (DevTools, another extension) already holds the tab.
      if (!/already attached/i.test(message)) throw error;
    }
    profile.attachedTabs.add(tabId);
    // Page events carry JavaScript dialogs, which the hub answers.
    await this.cdp(profile, tabId, "Page.enable").catch(() => {});
  }

  private async evaluate<T>(profile: RelayProfile, tabId: number, expression: string): Promise<T> {
    const response = (await this.cdp(profile, tabId, "Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
    })) as {
      result?: { value?: unknown };
      exceptionDetails?: { text?: string; exception?: { description?: string } };
    };
    if (response?.exceptionDetails) {
      const details = response.exceptionDetails;
      throw new BrowserRelayError(
        "page_error",
        (details.exception?.description ?? details.text ?? "The page threw an error.").slice(
          0,
          500,
        ),
      );
    }
    return response?.result?.value as T;
  }

  private async waitForLoad(profile: RelayProfile, tabId: number) {
    const deadline = Date.now() + LOAD_TIMEOUT_MS;
    await sleep(SETTLE_MS);
    while (Date.now() < deadline) {
      try {
        const state = await this.evaluate<string>(profile, tabId, READY_STATE_SCRIPT);
        if (state === "complete") return;
        if (state === "interactive" && Date.now() > deadline - LOAD_TIMEOUT_MS / 2) return;
      } catch {
        // Mid-navigation the context is gone; try again.
      }
      await sleep(250);
    }
  }

  /** The tab a call targets: the one given, or this thread's last tab in that profile. */
  private async useTab(
    profile: RelayProfile,
    threadId: string,
    tabId: number | undefined,
  ): Promise<number> {
    const target = tabId ?? profile.lastTabByThread.get(threadId);
    if (target === undefined)
      throw new BrowserRelayError(
        "tab_not_found",
        "No tab chosen yet. Open one with chrome_open, or pass tabId from chrome_tabs.",
      );
    try {
      await this.hub.call(profile.id, "chrome.tabs.get", [target], 5_000);
    } catch {
      profile.lastTabByThread.delete(threadId);
      throw new BrowserRelayError(
        "tab_not_found",
        `Tab ${target} is closed. Call chrome_tabs for current tabs.`,
      );
    }
    await this.attach(profile, target);
    profile.agentTabs.add(target);
    profile.lastTabByThread.set(threadId, target);
    return target;
  }

  private begin(profileName: string | undefined, threadId: string, tool: string, url?: string) {
    const profile = this.hub.resolveProfile(profileName);
    this.hub.acquire(profile, threadId);
    this.hub.record(profile, threadId, tool, url);
    return profile;
  }

  private takeDialog(profile: RelayProfile, tabId: number) {
    const dialog = profile.dialogs.get(tabId);
    if (!dialog) return {};
    profile.dialogs.delete(tabId);
    const answer =
      dialog.type === "alert" || dialog.type === "beforeunload" ? "accepted" : "dismissed";
    return { dialog: `A ${dialog.type} dialog was ${answer}: ${dialog.message}` };
  }

  private async page(profile: RelayProfile, tabId: number) {
    const identity = await this.evaluate<{ title: string; url: string }>(
      profile,
      tabId,
      PAGE_IDENTITY_SCRIPT,
    ).catch(() => ({ title: "", url: "" }));
    return {
      profile: profile.label,
      tabId,
      title: identity?.title ?? "",
      url: identity?.url ?? "",
      ...this.takeDialog(profile, tabId),
    };
  }

  profiles(threadId: string) {
    const now = Date.now();
    const profiles = this.hub.profiles().map((profile) => ({
      name: profile.label,
      browser: profile.browser,
      agentTabs: profile.agentTabs.size,
      inUseByAnotherThread:
        profile.lease !== null &&
        profile.lease.threadId !== threadId &&
        now - profile.lease.lastActionAt < 120_000,
    }));
    return {
      profiles,
      hint:
        profiles.length === 0
          ? "No Chrome profile is connected. Ask the user to install the SpecWithCode Browser extension and pair it in Settings › Chrome."
          : profiles.length === 1
            ? "One profile is connected; the other chrome_* tools use it when profile is omitted."
            : "Pass profile with one of these names to the other chrome_* tools.",
    };
  }

  async tabs(profileName: string | undefined) {
    const profile = this.hub.resolveProfile(profileName);
    const tabs = (await this.hub.call(profile.id, "chrome.tabs.query", [{}])) as ChromeTab[];
    return {
      profile: profile.label,
      tabs: (Array.isArray(tabs) ? tabs : []).flatMap((tab) =>
        tab.id === undefined
          ? []
          : [
              {
                tabId: tab.id,
                title: (tab.title ?? "").slice(0, 200),
                url: (tab.url || tab.pendingUrl || "").slice(0, 500),
                active: tab.active === true,
                agentTab: profile.agentTabs.has(tab.id) || profile.attachedTabs.has(tab.id),
              },
            ],
      ),
    };
  }

  async open(threadId: string, input: { url: string; profile?: string | undefined }) {
    const url = checkUrl(input.url);
    const profile = this.begin(input.profile, threadId, "chrome_open", url);
    const tab = (await this.hub.call(profile.id, "chrome.tabs.create", [
      { url: "about:blank", active: true },
    ])) as ChromeTab;
    if (tab?.id === undefined) throw new BrowserRelayError("page_error", "Chrome opened no tab.");
    profile.agentTabs.add(tab.id);
    profile.lastTabByThread.set(threadId, tab.id);
    await this.attach(profile, tab.id);
    await this.cdp(profile, tab.id, "Page.navigate", { url });
    await this.waitForLoad(profile, tab.id);
    return this.page(profile, tab.id);
  }

  async navigate(
    threadId: string,
    input: {
      url?: string | undefined;
      action?: "back" | "forward" | "reload" | undefined;
      tabId?: number | undefined;
      profile?: string | undefined;
    },
  ) {
    if (!input.url && !input.action)
      throw new BrowserRelayError(
        "invalid_request",
        "Pass url, or action back, forward or reload.",
      );
    const url = input.url ? checkUrl(input.url) : undefined;
    const profile = this.begin(input.profile, threadId, "chrome_navigate", url ?? input.action);
    const tabId = await this.useTab(profile, threadId, input.tabId);
    if (url) await this.cdp(profile, tabId, "Page.navigate", { url });
    else if (input.action === "reload") await this.cdp(profile, tabId, "Page.reload", {});
    else
      await this.evaluate(
        profile,
        tabId,
        input.action === "back" ? "history.back()" : "history.forward()",
      );
    await this.waitForLoad(profile, tabId);
    return this.page(profile, tabId);
  }

  async snapshot(
    threadId: string,
    input: {
      tabId?: number | undefined;
      profile?: string | undefined;
      maxTextChars?: number | undefined;
    },
  ) {
    const profile = this.begin(input.profile, threadId, "chrome_snapshot");
    const tabId = await this.useTab(profile, threadId, input.tabId);
    const budget = Math.min(60_000, Math.max(1_000, input.maxTextChars ?? DEFAULT_TEXT_CHARS));
    const result = await this.evaluate<{
      title: string;
      url: string;
      text: string;
      textTruncated: boolean;
      elements: Array<Record<string, unknown>>;
    }>(profile, tabId, snapshotScript(budget));
    return {
      profile: profile.label,
      tabId,
      title: result?.title ?? "",
      url: result?.url ?? "",
      text: result?.text ?? "",
      textTruncated: result?.textTruncated === true,
      elements: (result?.elements ?? []) as never,
      ...this.takeDialog(profile, tabId),
    };
  }

  private async locate(
    profile: RelayProfile,
    tabId: number,
    target: ElementTarget,
    options: { focus?: boolean; clear?: boolean } = {},
  ) {
    if (!target.ref && !target.selector)
      throw new BrowserRelayError("invalid_request", "Pass ref from chrome_snapshot, or selector.");
    const found = await this.evaluate<{
      found: boolean;
      error?: string;
      x?: number;
      y?: number;
      width?: number;
      height?: number;
    }>(profile, tabId, locateScript(target, options));
    if (!found?.found)
      throw new BrowserRelayError(
        found?.error ? "invalid_request" : "element_not_found",
        found?.error ??
          `No element ${target.ref ? `with ref ${target.ref}` : `matches ${target.selector}`}. Take a new chrome_snapshot; refs change when the page changes.`,
      );
    return found as { x: number; y: number; width: number; height: number };
  }

  async click(
    threadId: string,
    input: ElementTarget & { tabId?: number | undefined; profile?: string | undefined },
  ) {
    const profile = this.begin(input.profile, threadId, "chrome_click");
    const tabId = await this.useTab(profile, threadId, input.tabId);
    const box = await this.locate(profile, tabId, input);
    if (box.width > 0 && box.height > 0) {
      const at = { x: box.x, y: box.y };
      await this.cdp(profile, tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", ...at });
      await this.cdp(profile, tabId, "Input.dispatchMouseEvent", {
        type: "mousePressed",
        button: "left",
        clickCount: 1,
        ...at,
      });
      await this.cdp(profile, tabId, "Input.dispatchMouseEvent", {
        type: "mouseReleased",
        button: "left",
        clickCount: 1,
        ...at,
      });
    } else await this.evaluate(profile, tabId, domClickScript(input));
    await this.waitForLoad(profile, tabId);
    return this.page(profile, tabId);
  }

  async type(
    threadId: string,
    input: ElementTarget & {
      text: string;
      clear?: boolean | undefined;
      submit?: boolean | undefined;
      tabId?: number | undefined;
      profile?: string | undefined;
    },
  ) {
    const profile = this.begin(input.profile, threadId, "chrome_type");
    const tabId = await this.useTab(profile, threadId, input.tabId);
    await this.locate(profile, tabId, input, { focus: true, clear: input.clear !== false });
    await this.cdp(profile, tabId, "Input.insertText", { text: input.text });
    if (input.submit === true) {
      await this.pressKey(profile, tabId, "Enter");
      await this.waitForLoad(profile, tabId);
    }
    return this.page(profile, tabId);
  }

  private async pressKey(profile: RelayProfile, tabId: number, name: string) {
    const key = keyDefinition(name);
    if (!key) throw new BrowserRelayError("invalid_request", `Unknown key: ${name}`);
    const base = {
      key: key.key,
      code: key.code,
      windowsVirtualKeyCode: key.keyCode,
      nativeVirtualKeyCode: key.keyCode,
    };
    await this.cdp(profile, tabId, "Input.dispatchKeyEvent", {
      type: key.text ? "keyDown" : "rawKeyDown",
      ...base,
      ...(key.text ? { text: key.text, unmodifiedText: key.text } : {}),
    });
    await this.cdp(profile, tabId, "Input.dispatchKeyEvent", { type: "keyUp", ...base });
  }

  async press(
    threadId: string,
    input: { key: string; tabId?: number | undefined; profile?: string | undefined },
  ) {
    const profile = this.begin(input.profile, threadId, "chrome_press");
    const tabId = await this.useTab(profile, threadId, input.tabId);
    await this.pressKey(profile, tabId, input.key);
    await sleep(SETTLE_MS);
    return this.page(profile, tabId);
  }

  async screenshot(
    threadId: string,
    input: {
      tabId?: number | undefined;
      profile?: string | undefined;
      fullPage?: boolean | undefined;
    },
  ) {
    const profile = this.begin(input.profile, threadId, "chrome_screenshot");
    const tabId = await this.useTab(profile, threadId, input.tabId);
    let params: object = { format: "png" };
    if (input.fullPage === true) {
      const metrics = (await this.cdp(profile, tabId, "Page.getLayoutMetrics")) as {
        cssContentSize?: { width: number; height: number };
      };
      const size = metrics?.cssContentSize;
      if (size)
        params = {
          format: "png",
          captureBeyondViewport: true,
          clip: {
            x: 0,
            y: 0,
            width: Math.ceil(size.width),
            height: Math.min(Math.ceil(size.height), 16_000),
            scale: 1,
          },
        };
    }
    const shot = (await this.cdp(profile, tabId, "Page.captureScreenshot", params)) as {
      data?: string;
    };
    if (!shot?.data) throw new BrowserRelayError("page_error", "Chrome returned no screenshot.");
    const png = Buffer.from(shot.data, "base64");
    const identity = await this.page(profile, tabId);
    return {
      profile: profile.label,
      tabId,
      url: identity.url,
      screenshot: {
        mimeType: "image/png" as const,
        data: shot.data,
        width: png.length >= 24 ? png.readUInt32BE(16) : 0,
        height: png.length >= 24 ? png.readUInt32BE(20) : 0,
      },
    };
  }

  async evaluateExpression(
    threadId: string,
    input: { expression: string; tabId?: number | undefined; profile?: string | undefined },
  ) {
    const profile = this.begin(input.profile, threadId, "chrome_evaluate");
    const tabId = await this.useTab(profile, threadId, input.tabId);
    const value = await this.evaluate<unknown>(profile, tabId, input.expression);
    return { profile: profile.label, tabId, value: value ?? null };
  }

  /** Closes only tabs agents opened or used; the user's own tabs stay. */
  async close(
    threadId: string,
    input: { tabId?: number | undefined; profile?: string | undefined },
  ) {
    const profile = this.begin(input.profile, threadId, "chrome_close");
    const tabId = input.tabId ?? profile.lastTabByThread.get(threadId);
    if (tabId === undefined || !profile.agentTabs.has(tabId))
      throw new BrowserRelayError(
        "tab_not_found",
        "Only tabs an agent opened or used can be closed. Pass tabId from chrome_tabs.",
      );
    await this.hub.call(profile.id, "chrome.tabs.remove", [tabId]).catch(() => {});
    profile.agentTabs.delete(tabId);
    profile.attachedTabs.delete(tabId);
    profile.lastTabByThread.delete(threadId);
    return { profile: profile.label, closed: tabId };
  }
}
