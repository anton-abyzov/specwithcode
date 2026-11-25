// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off -- drives the plain relay hub with a fake extension.
import { describe, expect, it, vi } from "vite-plus/test";

import { seal } from "../fleet/fileTransfer/seal.ts";
import { ChromeTools } from "./chromeTools.ts";
import { connectFake, setup } from "./fakeChrome.testkit.ts";
import { checkSignInUrl, keyFingerprint, SignInViews } from "./signInView.ts";

const cdpCalls = (fake: ReturnType<typeof connectFake>, method: string) =>
  fake.calls.filter(
    (call) => call.method === "chrome.debugger.sendCommand" && call.params[1] === method,
  );

function start(now?: () => number) {
  const { extension, token } = setup();
  const fake = connectFake(extension, token);
  const ends: Array<[string, string]> = [];
  const views = new SignInViews(extension.hub, {
    onEnd: (viewId, end) => ends.push([viewId, end]),
    ...(now ? { now } : {}),
  });
  const tools = new ChromeTools(extension.hub);
  return { extension, fake, views, tools, ends };
}

/** The tab the last sign-in view opened. */
const viewTab = (fake: ReturnType<typeof connectFake>) => {
  const created = fake.calls.filter((call) => call.method === "chrome.tabs.create");
  return created.length + 99;
};

describe("sign-in view (1488)", () => {
  it("opens a fresh tab, re-attaches after the hold and loads only https pages", async () => {
    const { fake, views } = start();
    expect(() => checkSignInUrl("http://app.squareup.com")).toThrow(/https/);
    await expect(views.start({ url: "javascript:alert(1)" })).rejects.toThrow(/https/);
    const started = await views.start({ url: "https://app.squareup.com/login" });
    expect(started.profile).toBe("Personal");
    expect(started.fingerprint).toBe(keyFingerprint(started.publicKey));
    expect(started.fingerprint).toMatch(/^[0-9a-f]{4}(-[0-9a-f]{4}){3}$/);
    const tabId = viewTab(fake);
    const order = fake.calls
      .filter((call) => (call.params[0] as { tabId?: number } | undefined)?.tabId === tabId)
      .map((call) =>
        call.method === "chrome.debugger.sendCommand" ? call.params[1] : call.method,
      );
    // Held, then the debugger is dropped and attached anew before the page loads.
    expect(order.slice(0, 3)).toEqual([
      "chrome.debugger.detach",
      "chrome.debugger.attach",
      "Page.enable",
    ]);
    expect(order).toContain("Page.navigate");
    expect(cdpCalls(fake, "Page.navigate").at(-1)?.params[2]).toEqual({
      url: "https://app.squareup.com/login",
    });
  });

  it("hides the held tab from every thread and refuses every tool on it", async () => {
    const { extension, fake, views, tools } = start();
    await tools.open("t1", { url: "https://example.com" });
    await views.start({ url: "https://app.squareup.com/login" });
    const held = viewTab(fake);
    const listed = await tools.tabs("t1", undefined);
    expect(listed.tabs.map((tab) => tab.tabId)).not.toContain(held);
    await expect(tools.screenshot("t1", { tabId: held })).rejects.toMatchObject({
      code: "tab_in_use",
      message: expect.stringMatching(/held for the owner/),
    });
    await expect(tools.click("t2", { ref: "e1", tabId: held })).rejects.toMatchObject({
      code: "tab_in_use",
    });
    // Settings › Chrome › Stop lets go of the agents' tabs, not the person's.
    const profile = extension.hub.profiles()[0]!;
    await extension.hub.stop(profile.id);
    expect(extension.hub.heldForPerson(profile, held)).toBe(true);
    expect(
      fake.calls.filter(
        (call) =>
          call.method === "chrome.debugger.detach" &&
          (call.params[0] as { tabId: number }).tabId === held,
      ),
    ).toHaveLength(1);
    // Nothing from the view reached the audit list.
    expect(extension.hub.recentActions().map((action) => action.tool)).toEqual([
      "chrome_click",
      "chrome_screenshot",
      "chrome_open",
    ]);
    expect(JSON.stringify(extension.hub.recentActions())).not.toContain("squareup");
  });

  it("takes a tab a thread was driving away from it", async () => {
    const { extension, fake, tools } = start();
    await tools.open("t1", { url: "https://example.com" });
    const profile = extension.hub.profiles()[0]!;
    const agentTab = viewTab(fake);
    extension.hub.holdForPerson(profile, agentTab, "signin-x");
    expect(extension.hub.tabOwner(profile, agentTab)).toBeNull();
    expect(profile.lastTabByThread.has("t1")).toBe(false);
    await expect(tools.screenshot("t1", {})).rejects.toMatchObject({ code: "tab_not_found" });
  });

  it("sends frames with the origin Chrome reports, at most every 450 ms", async () => {
    let now = 1_000;
    const { fake, views: timed } = start(() => now);
    const { viewId } = await timed.start({ url: "https://app.squareup.com/login?next=/x" });
    const frame = await timed.frame(viewId);
    expect(frame).toMatchObject({ width: 800, height: 600, origin: "https://app.squareup.com" });
    expect(typeof frame.data).toBe("string");
    const shot = cdpCalls(fake, "Page.captureScreenshot").at(-1)?.params[2] as {
      format: string;
      clip: { scale: number };
    };
    expect(shot.format).toBe("jpeg");
    expect(shot.clip.scale).toBe(1);
    const shots = cdpCalls(fake, "Page.captureScreenshot").length;
    now += 100;
    expect(await timed.frame(viewId)).toBe(frame);
    expect(cdpCalls(fake, "Page.captureScreenshot")).toHaveLength(shots);
    now += 500;
    await timed.frame(viewId);
    expect(cdpCalls(fake, "Page.captureScreenshot")).toHaveLength(shots + 1);
  });

  it("clamps clicks, sends named keys only and types only sealed text", async () => {
    const { fake, views } = start();
    const started = await views.start({ url: "https://app.squareup.com/login" });
    await views.frame(started.viewId);
    await views.input(started.viewId, { type: "click", x: 5_000, y: -3 });
    const press = cdpCalls(fake, "Input.dispatchMouseEvent").find(
      (call) => (call.params[2] as { type: string }).type === "mousePressed",
    );
    expect(press?.params[2]).toMatchObject({ x: 799, y: 0, button: "left" });

    await views.input(started.viewId, { type: "key", key: "Enter" });
    expect(cdpCalls(fake, "Input.dispatchKeyEvent").length).toBe(2);
    await expect(views.input(started.viewId, { type: "key", key: "p" })).rejects.toThrow(
      /sealed text/,
    );

    await expect(
      views.input(started.viewId, { type: "text", text: "hunter2" } as never),
    ).rejects.toThrow(/plain text is refused/);
    const other = await views.start({ url: "https://app.squareup.com/login" });
    await expect(
      views.input(started.viewId, {
        type: "text",
        sealed: seal(Buffer.from("hunter2"), other.publicKey),
      }),
    ).rejects.toThrow(/not sealed to this/);
    expect(cdpCalls(fake, "Input.insertText")).toHaveLength(0);

    const sealed = seal(Buffer.from("hunter2"), started.publicKey);
    expect(sealed).not.toContain("hunter2");
    await views.input(started.viewId, { type: "text", sealed });
    expect(cdpCalls(fake, "Input.insertText").map((call) => call.params[2])).toEqual([
      { text: "hunter2" },
    ]);
  });

  it("follows a popup the sign-in opens and holds it too", async () => {
    const { extension, fake, views, tools } = start();
    const { viewId } = await views.start({ url: "https://app.squareup.com/login" });
    const main = viewTab(fake);
    fake.session.receive(
      JSON.stringify({
        method: "chrome.tabs.onCreated",
        params: [{ id: 555, openerTabId: main }],
      }),
    );
    const profile = extension.hub.profiles()[0]!;
    expect(extension.hub.heldForPerson(profile, 555)).toBe(true);
    await expect(tools.screenshot("t1", { tabId: 555 })).rejects.toMatchObject({
      code: "tab_in_use",
    });
    await views.input(viewId, { type: "key", key: "Tab" });
    expect(
      (cdpCalls(fake, "Input.dispatchKeyEvent").at(-1)?.params[0] as { tabId?: number } | undefined)
        ?.tabId,
    ).toBe(555);
    fake.session.receive(JSON.stringify({ method: "chrome.tabs.onRemoved", params: [555] }));
    await views.input(viewId, { type: "key", key: "Tab" });
    expect(
      (cdpCalls(fake, "Input.dispatchKeyEvent").at(-1)?.params[0] as { tabId?: number } | undefined)
        ?.tabId,
    ).toBe(main);
  });

  it("answers a dialog in the held tab and tells only the view", async () => {
    const { extension, fake, views } = start();
    const { viewId } = await views.start({ url: "https://app.squareup.com/login" });
    const main = viewTab(fake);
    fake.session.receive(
      JSON.stringify({
        method: "chrome.debugger.onEvent",
        params: [
          { tabId: main },
          "Page.javascriptDialogOpening",
          { type: "confirm", message: "Stay?" },
        ],
      }),
    );
    await vi.waitFor(() =>
      expect(cdpCalls(fake, "Page.handleJavaScriptDialog").at(-1)?.params[2]).toEqual({
        accept: false,
      }),
    );
    expect(extension.hub.profiles()[0]!.dialogs.size).toBe(0);
    expect((await views.frame(viewId)).dialog).toBe("confirm dismissed: Stay?");
  });

  it("Done keeps the tab and lets go; Cancel closes it; idle and a closed tab end it", async () => {
    vi.useFakeTimers();
    try {
      const { extension, fake, views, ends } = start();
      const profile = extension.hub.profiles()[0]!;
      const a = await views.start({ url: "https://app.squareup.com/login" });
      const tabA = viewTab(fake);
      await views.done(a.viewId);
      expect(extension.hub.heldForPerson(profile, tabA)).toBe(false);
      expect(fake.calls.some((call) => call.method === "chrome.tabs.remove")).toBe(false);
      await expect(views.frame(a.viewId)).rejects.toThrow(/ended/);

      const b = await views.start({ url: "https://app.squareup.com/login" });
      const tabB = viewTab(fake);
      await views.cancel(b.viewId);
      expect(fake.calls.find((call) => call.method === "chrome.tabs.remove")?.params).toEqual([
        tabB,
      ]);

      const c = await views.start({ url: "https://app.squareup.com/login" });
      await vi.advanceTimersByTimeAsync(10 * 60_000 + 1);
      const d = await views.start({ url: "https://app.squareup.com/login" });
      fake.session.receive(
        JSON.stringify({ method: "chrome.tabs.onRemoved", params: [viewTab(fake)] }),
      );
      await vi.waitFor(() => expect(ends).toHaveLength(4));
      expect(ends).toEqual([
        [a.viewId, "done"],
        [b.viewId, "cancelled"],
        [c.viewId, "timed_out"],
        [d.viewId, "tab_closed"],
      ]);
      expect(views.open()).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});
