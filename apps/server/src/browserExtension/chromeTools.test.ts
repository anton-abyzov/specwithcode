// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off -- drives the plain relay hub with a fake extension.
import { describe, expect, it } from "vite-plus/test";

import {
  encodePairingCode,
  makeBrowserExtension,
  relayRequestAllowed,
  tokensEqual,
} from "./BrowserExtension.ts";
import { ChromeTools, checkUrl } from "./chromeTools.ts";
import { connectFake, setup } from "./fakeChrome.testkit.ts";
import { BrowserRelayError, CLOSE_REJECTED, TAB_IDLE_MS } from "./relayHub.ts";

describe("pairing", () => {
  it("encodes a loopback relay URL, a long token and the machine name", () => {
    const { json, extension, stateDir } = setup();
    expect(json.u).toBe("ws://127.0.0.1:8319/api/browser-relay");
    expect(json.t.length).toBeGreaterThanOrEqual(32);
    expect(json.m).toBe("mac");
    // The token survives a restart.
    const again = makeBrowserExtension({ stateDir, port: 8319, machineName: "mac" });
    expect(again.pairing(false).pairingCode).toBe(extension.pairing(false).pairingCode);
    expect(encodePairingCode("ws://127.0.0.1:1/x", "t", "m")).toMatch(/^swc-chrome:1:/);
  });

  it("rejects a wrong token and drops every profile on reset", () => {
    const { extension, token } = setup();
    const wrong = connectFake(extension, "x".repeat(43));
    expect(wrong.closed[0]?.code).toBe(CLOSE_REJECTED);
    const right = connectFake(extension, token);
    expect(extension.hub.profiles()).toHaveLength(1);
    extension.pairing(true);
    expect(right.closed.at(-1)?.code).toBe(CLOSE_REJECTED);
    expect(extension.hub.profiles()).toHaveLength(0);
  });

  it("compares tokens in constant time and refuses empty ones", () => {
    expect(tokensEqual("abc", "abc")).toBe(true);
    expect(tokensEqual("abc", "abd")).toBe(false);
    expect(tokensEqual("", "")).toBe(false);
  });
});

describe("relayRequestAllowed", () => {
  const ok = { remoteAddress: "127.0.0.1", origin: "chrome-extension://abc", headers: {} };
  it("accepts the extension from loopback", () => expect(relayRequestAllowed(ok)).toBe(true));
  it("refuses other machines, web pages and proxied requests", () => {
    expect(relayRequestAllowed({ ...ok, remoteAddress: "192.168.1.5" })).toBe(false);
    expect(relayRequestAllowed({ ...ok, origin: "https://evil.example" })).toBe(false);
    expect(relayRequestAllowed({ ...ok, origin: undefined })).toBe(false);
    expect(relayRequestAllowed({ ...ok, headers: { "x-forwarded-for": "1.2.3.4" } })).toBe(false);
  });
});

describe("ChromeTools", () => {
  it("explains how to connect when no profile is paired", async () => {
    const { extension } = setup();
    const tools = new ChromeTools(extension.hub);
    expect(tools.profiles("t1").profiles).toEqual([]);
    await expect(tools.open("t1", { url: "https://example.com" })).rejects.toMatchObject({
      code: "not_connected",
    });
  });

  it("opens, reads, clicks, types, screenshots and closes in one profile", async () => {
    const { extension, token } = setup();
    const fake = connectFake(extension, token);
    const tools = new ChromeTools(extension.hub);

    const opened = await tools.open("t1", { url: "https://example.com" });
    expect(opened).toMatchObject({ profile: "Personal", url: "https://example.com/" });
    expect(fake.calls.map((c) => c.method)).toContain("chrome.debugger.attach");

    const snapshot = await tools.snapshot("t1", {});
    expect(snapshot.elements).toEqual([{ ref: "e1", role: "button", name: "Send" }]);

    await tools.click("t1", { ref: "e1" });
    const mouse = fake.calls.filter(
      (c) =>
        c.method === "chrome.debugger.sendCommand" && c.params[1] === "Input.dispatchMouseEvent",
    );
    expect(mouse).toHaveLength(3);

    await tools.type("t1", { ref: "e1", text: "hi", submit: true });
    expect(
      fake.calls.some(
        (c) =>
          c.params[1] === "Input.insertText" && (c.params[2] as { text: string }).text === "hi",
      ),
    ).toBe(true);

    const shot = await tools.screenshot("t1", {});
    expect(shot.screenshot).toMatchObject({ mimeType: "image/png", width: 1, height: 1 });

    expect(await tools.evaluateExpression("t1", { expression: "6*7" })).toMatchObject({
      value: 42,
    });
    await expect(tools.evaluateExpression("t1", { expression: "throw" })).rejects.toThrow("Boom");

    const tabs = await tools.tabs("t1", undefined);
    expect(tabs.tabs.find((t) => t.tabId === opened.tabId)).toMatchObject({
      agentTab: true,
      thisThread: true,
    });
    expect(tabs.tabs.find((t) => t.tabId === 1)?.agentTab).toBe(false);

    // The user's own tab is never closed by an agent.
    await expect(tools.close("t1", { tabId: 1 })).rejects.toMatchObject({ code: "tab_not_found" });
    expect(await tools.close("t1", {})).toEqual({ profile: "Personal", closed: opened.tabId });

    const actions = extension.status().recentActions.map((a) => a.tool);
    expect(actions).toContain("chrome_open");
    expect(actions).toContain("chrome_click");
  });

  it("attaches again when the extension drops the debugger from a new tab", async () => {
    const { extension, token } = setup();
    const fake = connectFake(extension, token);
    fake.failNext.set("Page.navigate", "Debugger is not attached to the tab with id: 100.");
    const tools = new ChromeTools(extension.hub);

    const opened = await tools.open("t1", { url: "https://example.com" });
    expect(opened).toMatchObject({ profile: "Personal", url: "https://example.com/" });
    expect(fake.calls.filter((c) => c.method === "chrome.debugger.attach")).toHaveLength(2);
    const navigations = fake.calls.filter(
      (c) => c.method === "chrome.debugger.sendCommand" && c.params[1] === "Page.navigate",
    );
    expect(navigations).toHaveLength(2);
  });

  it("does not retry other navigation failures", async () => {
    const { extension, token } = setup();
    const fake = connectFake(extension, token);
    fake.failNext.set("Page.navigate", "Cannot navigate to invalid URL");
    const tools = new ChromeTools(extension.hub);

    await expect(tools.open("t1", { url: "https://example.com" })).rejects.toThrow(
      /Cannot navigate/,
    );
    expect(fake.calls.filter((c) => c.method === "chrome.debugger.attach")).toHaveLength(1);
  });

  it("lets several threads use one profile at once, each in its own tabs", async () => {
    const { extension, token } = setup();
    const fake = connectFake(extension, token);
    const tools = new ChromeTools(extension.hub);
    // A project thread, a chat and the personal assistant, all at the same time.
    const [a, b, c] = await Promise.all([
      tools.open("thread-a", { url: "https://easychamp.com" }),
      tools.open("chat-b", { url: "https://example.com" }),
      tools.open("aide-c", { url: "https://example.org" }),
    ]);
    expect(new Set([a.tabId, b.tabId, c.tabId]).size).toBe(3);
    expect(tools.profiles("thread-a").profiles[0]?.inUseByAnotherThread).toBe(true);
    expect(tools.profiles("thread-a").hint).toContain("each thread works in its own tabs");

    // Each keeps acting in its own current tab.
    await Promise.all([
      tools.snapshot("thread-a", {}),
      tools.click("chat-b", { ref: "e1" }),
      tools.screenshot("aide-c", {}),
    ]);
    const evaluated = (tabId: number) =>
      fake.calls.some(
        (call) =>
          call.method === "chrome.debugger.sendCommand" &&
          (call.params[0] as { tabId: number }).tabId === tabId &&
          call.params[1] === "Runtime.evaluate",
      );
    expect([a.tabId, b.tabId, c.tabId].every(evaluated)).toBe(true);

    // A thread cannot drive or close another thread's tab while it is in use.
    await expect(tools.snapshot("chat-b", { tabId: a.tabId })).rejects.toMatchObject({
      code: "tab_in_use",
    });
    await expect(tools.close("chat-b", { tabId: a.tabId })).rejects.toMatchObject({
      code: "tab_in_use",
    });
    const listed = await tools.tabs("chat-b", undefined);
    expect(listed.tabs.find((t) => t.tabId === a.tabId)).toMatchObject({ anotherThread: true });
    expect(listed.tabs.find((t) => t.tabId === b.tabId)).toMatchObject({ thisThread: true });

    const summary = extension.status().profiles[0]!;
    expect(summary.threads?.map((use) => use.threadId).sort()).toEqual([
      "aide-c",
      "chat-b",
      "thread-a",
    ]);
    expect(summary.lease).not.toBeNull();
  });

  it("brings a background tab to the front before a screenshot", async () => {
    const { extension, token } = setup();
    const fake = connectFake(extension, token);
    const tools = new ChromeTools(extension.hub);
    const first = await tools.open("t1", { url: "https://example.com" });
    await tools.open("t2", { url: "https://example.org" });
    await tools.screenshot("t1", {});
    const front = fake.calls.filter(
      (call) =>
        call.params[1] === "Page.bringToFront" &&
        (call.params[0] as { tabId: number }).tabId === first.tabId,
    );
    expect(front).toHaveLength(1);
  });

  it("frees an idle thread's tab and stops one thread without touching others", async () => {
    let now = 1_000_000;
    const { extension, token } = setup();
    connectFake(extension, token);
    const hub = extension.hub as unknown as { now: () => number };
    hub.now = () => now;
    const tools = new ChromeTools(extension.hub);
    const a = await tools.open("t1", { url: "https://example.com" });
    const b = await tools.open("t2", { url: "https://example.org" });

    // Two minutes of quiet hands the tab back.
    now += TAB_IDLE_MS + 1;
    await expect(tools.snapshot("t2", { tabId: a.tabId })).resolves.toMatchObject({
      tabId: a.tabId,
    });
    // The first thread then hears its tab moved on.
    await expect(tools.snapshot("t1", {})).rejects.toMatchObject({ code: "tab_in_use" });

    const id = extension.hub.profiles()[0]!.id;
    await tools.open("t3", { url: "https://example.net" });
    await extension.hub.stop(id, "t2");
    const left = extension.status().profiles[0]!.threads!.map((use) => use.threadId);
    expect(left).toEqual(["t3"]);
    // t2 lost its tabs; it can open a new one at once.
    await expect(tools.snapshot("t2", {})).rejects.toMatchObject({ code: "tab_not_found" });
    expect(b.tabId).toBeGreaterThan(0);
    await extension.hub.stop(id);
    expect(extension.status().profiles[0]!.threads).toEqual([]);
  });

  it("asks for a profile name when several are paired", async () => {
    const { extension, token } = setup();
    connectFake(extension, token, "Personal");
    connectFake(extension, token, "Work");
    const tools = new ChromeTools(extension.hub);
    await expect(tools.open("t1", { url: "https://example.com" })).rejects.toMatchObject({
      code: "choose_profile",
    });
    await expect(
      tools.open("t1", { url: "https://example.com", profile: "work" }),
    ).resolves.toMatchObject({ profile: "Work" });
  });

  it("only loads web pages", () => {
    expect(checkUrl("https://example.com")).toBe("https://example.com/");
    for (const url of ["chrome://settings", "file:///etc/passwd", "javascript:alert(1)", "nope"])
      expect(() => checkUrl(url)).toThrow(BrowserRelayError);
  });

  it("reports a check per profile", async () => {
    const { extension, token } = setup();
    expect((await extension.check()).state).toBe("not_connected");
    connectFake(extension, token);
    const check = await extension.check();
    expect(check.state).toBe("connected");
    expect(check.profiles[0]).toMatchObject({ label: "Personal", ok: true, tabCount: 1 });
  });

  it("links the store listing and tells a hand-loaded copy from a store install", () => {
    const { extension, token } = setup();
    connectFake(extension, token);
    const status = extension.status();
    expect(status.storeUrl).toBe(
      "https://chromewebstore.google.com/detail/specwithcode-browser/okoinngelinfjfkmkcnbgndapeiofgbb",
    );
    expect(status.profiles[0]).toMatchObject({ label: "Personal", fromStore: false });
    expect(status.profiles[0]).not.toHaveProperty("extensionId");
  });
});
