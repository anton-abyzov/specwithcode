// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off -- drives the plain relay hub with a fake extension.
import { describe, expect, it, vi } from "vite-plus/test";

import { newReceivingKey, seal, unseal } from "../fleet/fileTransfer/seal.ts";
import { ChromeTools } from "./chromeTools.ts";
import { connectFake, setup } from "./fakeChrome.testkit.ts";
import {
  checkSignInUrl,
  keyFingerprint,
  MAX_SEALED_INPUT_CHARS,
  PASSKEY_NOTICE,
  PASSKEY_WATCH_SCRIPT,
  SIGN_IN_SEAL_INFO,
  type SignInFrame,
  type SignInTextPayload,
  SignInViews,
} from "./signInView.ts";

type Fake = ReturnType<typeof connectFake>;

const cdpCalls = (fake: Fake, method: string) =>
  fake.calls.filter(
    (call) => call.method === "chrome.debugger.sendCommand" && call.params[1] === method,
  );
const tabOf = (call: { params: unknown[] } | undefined) =>
  (call?.params[0] as { tabId?: number } | undefined)?.tabId;

function start(options: { now?: () => number } = {}) {
  const { extension, token } = setup();
  const fake = connectFake(extension, token);
  const ends: Array<[string, string]> = [];
  const views = new SignInViews(extension.hub, {
    onEnd: (viewId, end) => ends.push([viewId, end]),
    ...(options.now ? { now: options.now } : {}),
  });
  const tools = new ChromeTools(extension.hub);
  const viewer = newReceivingKey();
  const profile = () => extension.hub.profiles()[0]!;
  return { extension, token, fake, views, tools, ends, viewer, profile };
}

/** The tab the newest sign-in view (or chrome_open) created. */
const newestTab = (fake: Fake) => Math.max(...fake.tabs.keys());

const openFrame = (sealed: string, viewer: ReturnType<typeof newReceivingKey>): SignInFrame =>
  JSON.parse(unseal(sealed, viewer, SIGN_IN_SEAL_INFO).toString("utf8"));

const sealText = (publicKey: string, payload: SignInTextPayload) =>
  seal(Buffer.from(JSON.stringify(payload)), publicKey, SIGN_IN_SEAL_INFO);

describe("sign-in view (1488)", () => {
  it("opens a fresh https tab, drops any old debugger session and watches for passkeys", async () => {
    const { fake, views, viewer } = start();
    expect(() => checkSignInUrl("http://app.squareup.com")).toThrow(/https/);
    await expect(
      views.start({ url: "javascript:alert(1)", viewerKey: viewer.publicKey }),
    ).rejects.toThrow(/https/);
    await expect(
      views.start({ url: "https://app.squareup.com/login", viewerKey: "not-a-key" }),
    ).rejects.toThrow(/X25519/);
    const started = await views.start({
      url: "https://app.squareup.com/login",
      viewerKey: viewer.publicKey,
    });
    expect(started.fingerprint).toBe(keyFingerprint(started.publicKey));
    const tabId = newestTab(fake);
    const order = fake.calls
      .filter((call) => tabOf(call) === tabId)
      .map((call) =>
        call.method === "chrome.debugger.sendCommand" ? call.params[1] : call.method,
      );
    expect(order.slice(0, 3)).toEqual([
      "chrome.debugger.detach",
      "chrome.debugger.attach",
      "Page.enable",
    ]);
    expect(order).toEqual(
      expect.arrayContaining(["Runtime.addBinding", "Page.addScriptToEvaluateOnNewDocument"]),
    );
    expect(cdpCalls(fake, "Page.navigate").at(-1)?.params[2]).toEqual({
      url: "https://app.squareup.com/login",
    });
  });

  it("refuses a tab some other debugger already holds, and closes it", async () => {
    const viewer = newReceivingKey();
    const failing = connectFakeAttachFails();
    await expect(
      failing.views.start({ url: "https://app.squareup.com/login", viewerKey: viewer.publicKey }),
    ).rejects.toThrow(/Another debugger/);
    expect(failing.fake.calls.some((call) => call.method === "chrome.tabs.remove")).toBe(true);
  });

  it("hides the held tab from threads with a reply that does not say why", async () => {
    const { extension, fake, views, tools, viewer, profile } = start();
    await tools.open("t1", { url: "https://example.com" });
    await views.start({ url: "https://app.squareup.com/login", viewerKey: viewer.publicKey });
    const held = newestTab(fake);
    const listed = await tools.tabs("t1", undefined);
    expect(listed.tabs.map((tab) => tab.tabId)).not.toContain(held);
    const refusal = await tools.screenshot("t1", { tabId: held }).catch((error: Error) => error);
    expect(refusal).toMatchObject({ code: "tab_in_use" });
    expect((refusal as Error).message).toBe(
      `Tab ${held} is not available. Open your own tab with chrome_open.`,
    );
    await expect(tools.click("t2", { ref: "e1", tabId: held })).rejects.toMatchObject({
      code: "tab_in_use",
    });
    // Settings › Chrome › Stop lets go of the agents' tabs only, and does not count the person's.
    await extension.hub.stop(profile().id);
    expect(extension.hub.heldForPerson(profile(), held)).toBe(true);
    expect(extension.hub.profileSummaries()[0]?.attachedTabs).toBe(0);
    expect(JSON.stringify(extension.hub.recentActions())).not.toContain("squareup");
  });

  it("refuses calls into a held tab at dispatch and drops answers to calls made before the hold", async () => {
    const { extension, fake, profile } = start();
    const before = extension.hub.call(profile().id, "chrome.debugger.sendCommand", [
      { tabId: 1 },
      "Page.captureScreenshot",
      {},
    ]);
    extension.hub.holdForPerson(profile(), 1, "signin-x");
    await expect(before).rejects.toMatchObject({ code: "tab_in_use" });
    const sent = fake.calls.length;
    await expect(
      extension.hub.call(profile().id, "chrome.tabs.update", [1, { active: true }]),
    ).rejects.toMatchObject({ code: "tab_in_use" });
    expect(fake.calls).toHaveLength(sent);
    await expect(
      extension.hub.call(profile().id, "chrome.tabs.get", [1], 5_000, "signin-x"),
    ).resolves.toMatchObject({ id: 1 });
  });

  it("lets no thread take a new tab while a sign-in tab is being created", async () => {
    const { extension, tools, profile } = start();
    const end = extension.hub.beginPersonCreate(profile());
    await expect(tools.open("t1", { url: "https://example.com" })).rejects.toMatchObject({
      code: "tab_in_use",
    });
    end();
    await expect(tools.open("t1", { url: "https://example.com" })).resolves.toMatchObject({
      url: "https://example.com/",
    });
  });

  it("takes a tab a thread was driving away from it", async () => {
    const { extension, fake, tools, profile } = start();
    await tools.open("t1", { url: "https://example.com" });
    const agentTab = newestTab(fake);
    extension.hub.holdForPerson(profile(), agentTab, "signin-x");
    expect(extension.hub.tabOwner(profile(), agentTab)).toBeNull();
    await expect(tools.screenshot("t1", {})).rejects.toMatchObject({ code: "tab_not_found" });
  });

  it("seals frames to the viewer, with the origin Chrome reports, at most every 450 ms", async () => {
    let now = 1_000;
    const { fake, views, viewer } = start({ now: () => now });
    const { viewId } = await views.start({
      url: "https://app.squareup.com/login?next=/x",
      viewerKey: viewer.publicKey,
    });
    const first = await views.frame(viewId);
    expect(first.sealed).not.toContain("squareup");
    const frame = openFrame(first.sealed, viewer);
    expect(frame).toMatchObject({
      width: 800,
      height: 600,
      origin: "https://app.squareup.com",
      frame: `${newestTab(fake)}:1`,
    });
    expect(() => unseal(first.sealed, newReceivingKey(), SIGN_IN_SEAL_INFO)).toThrow();
    const shots = cdpCalls(fake, "Page.captureScreenshot").length;
    now += 100;
    expect(await views.frame(viewId)).toEqual(first);
    expect(cdpCalls(fake, "Page.captureScreenshot")).toHaveLength(shots);
    now += 500;
    await views.frame(viewId);
    expect(cdpCalls(fake, "Page.captureScreenshot")).toHaveLength(shots + 1);
  });

  it("throws a frame away when the page moved on while it was taken", async () => {
    let now = 1_000;
    const { fake, views, viewer } = start({ now: () => now });
    const { viewId } = await views.start({
      url: "https://app.squareup.com/login",
      viewerKey: viewer.publicKey,
    });
    let redirects = 1;
    fake.before.set("Page.captureScreenshot", (tab) => {
      if (tab && redirects-- > 0) {
        tab.url = "https://evil.example/";
        tab.entry = (tab.entry ?? 0) + 1;
      }
    });
    const frame = openFrame((await views.frame(viewId)).sealed, viewer);
    expect(frame.origin).toBe("https://evil.example");
    expect(cdpCalls(fake, "Page.captureScreenshot")).toHaveLength(2);
    fake.before.set("Page.captureScreenshot", (tab) => {
      if (tab) tab.entry = (tab.entry ?? 0) + 1;
    });
    now += 1_000;
    await expect(views.frame(viewId)).rejects.toThrow(/keeps changing/);
  });

  it("acts only on the page the person saw, sends named keys only and types only sealed, fresh text", async () => {
    const { fake, views, viewer } = start();
    const started = await views.start({
      url: "https://app.squareup.com/login",
      viewerKey: viewer.publicKey,
    });
    const tabId = newestTab(fake);
    const { frame } = openFrame((await views.frame(started.viewId)).sealed, viewer);

    await views.input(started.viewId, { type: "click", frame, x: 5_000, y: -3 });
    const press = cdpCalls(fake, "Input.dispatchMouseEvent").find(
      (call) => (call.params[2] as { type: string }).type === "mousePressed",
    );
    expect(press?.params[2]).toMatchObject({ x: 799, y: 0, button: "left" });
    await expect(
      views.input(started.viewId, { type: "click", frame, x: Number.NaN, y: 1 }),
    ).rejects.toThrow(/x and y/);

    await views.input(started.viewId, { type: "key", frame, key: "Enter" });
    expect(cdpCalls(fake, "Input.dispatchKeyEvent")).toHaveLength(2);
    for (const key of ["p", "Space", " "])
      await expect(views.input(started.viewId, { type: "key", frame, key })).rejects.toThrow(
        /sealed text/,
      );

    await expect(
      views.input(started.viewId, { type: "text", text: "hunter2" } as never),
    ).rejects.toThrow(/plain text is refused/);
    const other = newReceivingKey();
    const fixed = "That text was not typed. Look at the page and try again.";
    await expect(
      views.input(started.viewId, {
        type: "text",
        sealed: sealText(other.publicKey, { seq: 1, frame, text: "hunter2" }),
      }),
    ).rejects.toThrow(fixed);
    await expect(
      views.input(started.viewId, { type: "text", sealed: "x".repeat(MAX_SEALED_INPUT_CHARS + 1) }),
    ).rejects.toThrow(fixed);
    expect(cdpCalls(fake, "Input.insertText")).toHaveLength(0);

    const sealed = sealText(started.publicKey, { seq: 1, frame, text: "hunter2" });
    expect(sealed).not.toContain("hunter2");
    await views.input(started.viewId, { type: "text", sealed });
    expect(cdpCalls(fake, "Input.insertText").map((call) => call.params[2])).toEqual([
      { text: "hunter2" },
    ]);
    // The same blob, or an older number, never types again.
    await expect(views.input(started.viewId, { type: "text", sealed })).rejects.toThrow(fixed);
    await expect(
      views.input(started.viewId, {
        type: "text",
        sealed: sealText(started.publicKey, { seq: 1, frame, text: "again" }),
      }),
    ).rejects.toThrow(fixed);

    // A redirect after the frame was shown: clicks and text aimed at the old page are refused.
    const tab = fake.tabs.get(tabId)!;
    tab.url = "https://evil.example/";
    tab.entry = (tab.entry ?? 0) + 1;
    await expect(views.input(started.viewId, { type: "click", frame, x: 1, y: 1 })).rejects.toThrow(
      /page changed/,
    );
    await expect(
      views.input(started.viewId, {
        type: "text",
        sealed: sealText(started.publicKey, { seq: 2, frame, text: "hunter2" }),
      }),
    ).rejects.toThrow(fixed);
    // Text never goes to a page that is not https, even when the person saw it.
    tab.url = "http://plain.example/";
    tab.entry += 1;
    const plain = openFrame((await views.frame(started.viewId)).sealed, viewer).frame;
    await expect(
      views.input(started.viewId, {
        type: "text",
        sealed: sealText(started.publicKey, { seq: 3, frame: plain, text: "hunter2" }),
      }),
    ).rejects.toThrow(fixed);
    expect(cdpCalls(fake, "Input.insertText")).toHaveLength(1);
  });

  it("holds popups and their popups, attaches them at once and drops one that closed unseen", async () => {
    let now = 1_000;
    const { extension, fake, views, tools, viewer, profile } = start({ now: () => now });
    const { viewId } = await views.start({
      url: "https://app.squareup.com/login",
      viewerKey: viewer.publicKey,
    });
    const main = newestTab(fake);
    fake.tabs.set(555, {
      id: 555,
      url: "https://accounts.google.com/",
      title: "",
      active: true,
      openerTabId: main,
    });
    fake.session.receive(
      JSON.stringify({ method: "chrome.tabs.onCreated", params: [{ id: 555, openerTabId: main }] }),
    );
    expect(extension.hub.heldForPerson(profile(), 555)).toBe(true);
    await vi.waitFor(() =>
      expect(
        fake.calls.some((call) => call.method === "chrome.debugger.attach" && tabOf(call) === 555),
      ).toBe(true),
    );
    // A popup of the popup that Chrome never reported is still kept from threads.
    fake.tabs.set(556, {
      id: 556,
      url: "https://x.example/",
      title: "",
      active: false,
      openerTabId: 555,
    });
    const listed = await tools.tabs("t1", undefined);
    expect(listed.tabs.map((tab) => tab.tabId)).not.toContain(556);
    expect(extension.hub.heldForPerson(profile(), 556)).toBe(true);

    const popupFrame = openFrame((await views.frame(viewId)).sealed, viewer).frame;
    expect(popupFrame.startsWith("555:")).toBe(true);
    await views.input(viewId, { type: "key", frame: popupFrame, key: "Tab" });
    expect(tabOf(cdpCalls(fake, "Input.dispatchKeyEvent").at(-1))).toBe(555);

    // Closed without a removal event: the next frame shows the main tab again.
    fake.tabs.delete(555);
    now += 1_000;
    const back = openFrame((await views.frame(viewId)).sealed, viewer).frame;
    expect(back.startsWith(`${main}:`)).toBe(true);
  });

  it("answers a dialog and reports a passkey request only to the view, until the page changes", async () => {
    let now = 1_000;
    const { extension, fake, views, viewer } = start({ now: () => now });
    const { viewId } = await views.start({
      url: "https://app.squareup.com/login",
      viewerKey: viewer.publicKey,
    });
    const main = newestTab(fake);
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
    fake.session.receive(
      JSON.stringify({
        method: "chrome.debugger.onEvent",
        params: [
          { tabId: main },
          "Runtime.bindingCalled",
          {
            name: "__swcSignInPasskey",
            payload: JSON.stringify({ kind: "get", rpId: "squareup.com" }),
          },
        ],
      }),
    );
    await vi.waitFor(async () => {
      now += 1_000;
      const frame = openFrame((await views.frame(viewId)).sealed, viewer);
      expect(frame.passkey).toEqual({ kind: "get", rpId: "squareup.com", notice: PASSKEY_NOTICE });
    });
    now += 1_000;
    const tab = fake.tabs.get(main)!;
    tab.entry = (tab.entry ?? 0) + 1;
    const after = openFrame((await views.frame(viewId)).sealed, viewer);
    expect(after.passkey).toBeUndefined();
    expect(after.dialog).toBeUndefined();
  });

  it("the passkey watcher reports kind and site only and leaves the call alone", async () => {
    const told: string[] = [];
    const calls: unknown[] = [];
    const credentials = {
      get: (options: unknown) => (calls.push(options), Promise.resolve("assertion")),
      create: (options: unknown) => (calls.push(options), Promise.resolve("credential")),
    };
    const run = new Function("navigator", "globalThis", PASSKEY_WATCH_SCRIPT);
    const global = { __swcSignInPasskey: (payload: string) => told.push(payload) };
    run({ credentials }, global);
    run({ credentials }, global);
    const options = { publicKey: { rpId: "squareup.com", challenge: new Uint8Array([1, 2]) } };
    await expect(credentials.get(options)).resolves.toBe("assertion");
    await credentials.create({
      publicKey: { rp: { id: "squareup.com" }, challenge: new Uint8Array(1) },
    });
    await credentials.get({ password: true });
    expect(told).toEqual([
      JSON.stringify({ kind: "get", rpId: "squareup.com" }),
      JSON.stringify({ kind: "create", rpId: "squareup.com" }),
    ]);
    expect(calls[0]).toBe(options);
  });

  it("Done keeps the tab; Cancel and idle close it; holds stay until Chrome confirms", async () => {
    vi.useFakeTimers();
    try {
      const { extension, fake, views, ends, viewer, profile } = start();
      const a = await views.start({
        url: "https://app.squareup.com/login",
        viewerKey: viewer.publicKey,
      });
      const tabA = newestTab(fake);
      await views.done(a.viewId);
      expect(extension.hub.heldForPerson(profile(), tabA)).toBe(false);
      expect(fake.calls.some((call) => call.method === "chrome.tabs.remove")).toBe(false);
      await expect(views.frame(a.viewId)).rejects.toThrow(/ended/);

      const b = await views.start({
        url: "https://app.squareup.com/login",
        viewerKey: viewer.publicKey,
      });
      const tabB = newestTab(fake);
      await views.cancel(b.viewId);
      expect(fake.calls.find((call) => call.method === "chrome.tabs.remove")?.params).toEqual([
        tabB,
      ]);
      expect(extension.hub.heldForPerson(profile(), tabB)).toBe(false);

      const c = await views.start({
        url: "https://app.squareup.com/login",
        viewerKey: viewer.publicKey,
      });
      const tabC = newestTab(fake);
      await vi.advanceTimersByTimeAsync(10 * 60_000 + 1);
      expect(fake.calls.findLast((call) => call.method === "chrome.tabs.remove")?.params).toEqual([
        tabC,
      ]);

      const d = await views.start({
        url: "https://app.squareup.com/login",
        viewerKey: viewer.publicKey,
      });
      fake.session.receive(
        JSON.stringify({ method: "chrome.tabs.onRemoved", params: [newestTab(fake)] }),
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

  it("keeps holds across a reconnect and finishes a failed teardown when the profile is back", async () => {
    const { extension, token, fake, views, tools, viewer, profile } = start();
    const { viewId } = await views.start({
      url: "https://app.squareup.com/login",
      viewerKey: viewer.publicKey,
    });
    const held = newestTab(fake);
    // The extension drops out mid-cancel: the tab cannot be closed, so it stays held.
    fake.session.closed();
    await views.cancel(viewId);
    const again = connectFake(extension, token);
    again.tabs.set(held, { id: held, url: "https://app.squareup.com/", title: "", active: true });
    expect(extension.hub.heldForPerson(profile(), held)).toBe(true);
    await expect(tools.screenshot("t1", { tabId: held })).rejects.toMatchObject({
      code: "tab_in_use",
    });
    await vi.waitFor(() =>
      expect(again.calls.find((call) => call.method === "chrome.tabs.remove")?.params).toEqual([
        held,
      ]),
    );
    await vi.waitFor(() => expect(extension.hub.heldForPerson(profile(), held)).toBe(false));
  });

  it("stops listening when disposed", async () => {
    const { views, viewer } = start();
    const { viewId } = await views.start({
      url: "https://app.squareup.com/login",
      viewerKey: viewer.publicKey,
    });
    await views.dispose();
    expect(views.open()).toEqual([]);
    await expect(views.frame(viewId)).rejects.toThrow(/ended/);
  });
});

/** A profile whose Chrome says another debugger already holds every new tab. */
function connectFakeAttachFails() {
  const { extension, token } = setup();
  const fake = connectFake(extension, token);
  const views = new SignInViews(extension.hub);
  // Answer the first chrome.debugger.attach with Chrome's "already attached" error.
  const hub = extension.hub;
  const call = hub.call.bind(hub);
  hub.call = ((profileId, method, params, timeoutMs, person) =>
    method === "chrome.debugger.attach"
      ? Promise.reject(new Error("Another debugger is already attached to the tab with id: 1."))
      : call(profileId, method, params, timeoutMs, person)) as typeof hub.call;
  return { fake, views };
}
