import { describe, expect, it, vi } from "vite-plus/test";

import { createCdpRelayConnection, type CdpRelayTarget } from "./CdpRelay.ts";

const makeTarget = (
  send: CdpRelayTarget["send"],
  setDownloadDirectory: CdpRelayTarget["setDownloadDirectory"] = () => {},
): CdpRelayTarget => ({
  send,
  targetId: async () => "GUEST-TARGET",
  url: () => "http://localhost:4719/",
  title: () => "Fixture",
  userAgent: () => "Electron",
  setDownloadDirectory,
});

// Each relay reply resolves after a few microtasks; one macrotask lets them all land.
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("CDP relay", () => {
  it("announces only the tab's page, under its real target id", async () => {
    const written: Array<Record<string, unknown>> = [];
    const relay = createCdpRelayConnection(makeTarget(vi.fn()), (raw) =>
      written.push(JSON.parse(raw)),
    );
    relay.receive(JSON.stringify({ id: 1, method: "Target.setAutoAttach", params: {} }));
    relay.receive(JSON.stringify({ id: 2, method: "Target.createTarget", params: {} }));
    await settle();
    const attach = written.findIndex((message) => message["id"] === 1);
    // The page is announced right after the auto-attach reply, never before it.
    expect(written.slice(attach, attach + 2)).toEqual([
      { id: 1, result: {} },
      {
        method: "Target.attachedToTarget",
        params: expect.objectContaining({
          sessionId: "studio-preview-page",
          targetInfo: expect.objectContaining({ targetId: "GUEST-TARGET", type: "page" }),
        }),
      },
    ]);
    expect(written).toContainEqual({
      id: 2,
      error: expect.objectContaining({ message: expect.stringContaining("createTarget") }),
    });
  });

  it("forwards page commands to the tab and lets a slow one finish last", async () => {
    const pending: Array<() => void> = [];
    const send = vi.fn(
      (method: string) =>
        new Promise<unknown>((resolve) => pending.push(() => resolve({ method }))),
    );
    const written: Array<Record<string, unknown>> = [];
    const relay = createCdpRelayConnection(makeTarget(send), (raw) =>
      written.push(JSON.parse(raw)),
    );
    // The tab's debugger announces its iframe before anything addresses it.
    relay.event("Target.attachedToTarget", { sessionId: "iframe-session" }, "");
    relay.receive(
      JSON.stringify({ id: 5, method: "Page.captureScreenshot", sessionId: "studio-preview-page" }),
    );
    relay.receive(JSON.stringify({ id: 6, method: "DOM.enable", sessionId: "iframe-session" }));
    // A slow screenshot must not hold up the reply behind it.
    pending[1]!();
    await settle();
    expect(written).toEqual([
      { id: 6, result: { method: "DOM.enable" }, sessionId: "iframe-session" },
    ]);
    pending[0]!();
    await settle();
    expect(send).toHaveBeenNthCalledWith(1, "Page.captureScreenshot", {}, undefined);
    expect(send).toHaveBeenNthCalledWith(2, "DOM.enable", {}, "iframe-session");
    expect(written.at(-1)).toEqual({
      id: 5,
      result: { method: "Page.captureScreenshot" },
      sessionId: "studio-preview-page",
    });
  });

  it("routes tab events to the page session once the page is announced", async () => {
    const written: Array<Record<string, unknown>> = [];
    const relay = createCdpRelayConnection(makeTarget(vi.fn()), (raw) =>
      written.push(JSON.parse(raw)),
    );
    relay.event("Page.loadEventFired", {}, undefined);
    expect(written).toEqual([]);
    relay.receive(JSON.stringify({ id: 1, method: "Target.setAutoAttach", params: {} }));
    await settle();
    // Electron passes an empty session id for the page's own events.
    relay.event("Page.loadEventFired", { timestamp: 1 }, "");
    relay.event("Runtime.consoleAPICalled", {}, "iframe-session");
    expect(written.slice(-2)).toEqual([
      { method: "Page.loadEventFired", params: { timestamp: 1 }, sessionId: "studio-preview-page" },
      { method: "Runtime.consoleAPICalled", params: {}, sessionId: "iframe-session" },
    ]);
  });
});

describe("CDP relay target scope", () => {
  it("reaches only the tab's own page and the frames it announced", async () => {
    const send = vi.fn(async (method: string) => ({ method }));
    const written: Array<Record<string, unknown>> = [];
    const relay = createCdpRelayConnection(makeTarget(send), (raw) =>
      written.push(JSON.parse(raw)),
    );
    relay.receive(JSON.stringify({ id: 1, method: "Target.setAutoAttach", params: {} }));
    await settle();
    // The tab's own iframe, announced by its debugger.
    relay.event(
      "Target.attachedToTarget",
      { sessionId: "iframe-1", targetInfo: { targetId: "IFRAME-1", type: "iframe" } },
      "",
    );
    const page = (id: number, method: string, params: unknown = {}, sessionId?: string) =>
      relay.receive(
        JSON.stringify({ id, method, params, sessionId: sessionId ?? "studio-preview-page" }),
      );
    // Another tab's target, or a session the tab never announced, is out of reach.
    page(2, "Target.attachToTarget", { targetId: "OTHER-TAB", flatten: true });
    page(3, "Target.sendMessageToTarget", { targetId: "OTHER-TAB", message: "{}" });
    page(4, "Target.attachToBrowserTarget");
    page(5, "Input.dispatchMouseEvent", { type: "mousePressed" }, "other-tab-session");
    page(6, "Target.detachFromTarget", { sessionId: "other-tab-session" });
    // The page and its own frames keep working.
    page(7, "Target.setAutoAttach", { autoAttach: true, flatten: true });
    page(8, "DOM.enable", {}, "iframe-1");
    page(9, "Target.detachFromTarget", { sessionId: "iframe-1" });
    page(10, "Runtime.evaluate", { expression: "1" });
    await settle();
    for (const id of [2, 3, 4, 5, 6]) {
      expect(
        written.find((m) => m["id"] === id),
        `id ${id}`,
      ).toHaveProperty("error");
    }
    for (const id of [7, 8, 9, 10]) {
      expect(
        written.find((m) => m["id"] === id),
        `id ${id}`,
      ).toHaveProperty("result");
    }
    expect(send.mock.calls.map((call) => call[0]).toSorted()).toEqual([
      "DOM.enable",
      "Runtime.evaluate",
      "Target.detachFromTarget",
      "Target.setAutoAttach",
    ]);
    // Once the frame detaches, its session is gone too.
    relay.event("Target.detachedFromTarget", { sessionId: "iframe-1" }, "");
    page(11, "DOM.enable", {}, "iframe-1");
    await settle();
    expect(written.find((m) => m["id"] === 11)).toHaveProperty("error");
  });
});

describe("CDP relay browser commands on page sessions", () => {
  it("refuses browser-level commands sent on the page or a frame session", async () => {
    const send = vi.fn(async (method: string) => ({ method }));
    const written: Array<Record<string, unknown>> = [];
    const relay = createCdpRelayConnection(makeTarget(send), (raw) =>
      written.push(JSON.parse(raw)),
    );
    relay.receive(JSON.stringify({ id: 1, method: "Target.setAutoAttach", params: {} }));
    await settle();
    relay.event(
      "Target.attachedToTarget",
      { sessionId: "iframe-1", targetInfo: { targetId: "IFRAME-1", type: "iframe" } },
      "",
    );
    const page = (id: number, method: string, params: unknown = {}, sessionId?: string) =>
      relay.receive(
        JSON.stringify({ id, method, params, sessionId: sessionId ?? "studio-preview-page" }),
      );
    // A permission override set through the tab's debugger would skip the person's Allow prompt.
    page(2, "Browser.grantPermissions", { permissions: ["clipboardReadWrite"] });
    page(3, "Browser.setPermission", { permission: { name: "geolocation" }, setting: "granted" });
    page(4, "Browser.grantPermissions", { permissions: ["notifications"] }, "iframe-1");
    // Page commands keep working.
    page(5, "Runtime.evaluate", { expression: "1" });
    await settle();
    for (const id of [2, 3, 4]) {
      expect(
        written.find((m) => m["id"] === id),
        `id ${id}`,
      ).toHaveProperty("error");
    }
    expect(written.find((m) => m["id"] === 5)).toHaveProperty("result");
    expect(send.mock.calls.map((call) => call[0])).toEqual(["Runtime.evaluate"]);
  });
});

describe("CDP relay extra sessions", () => {
  it("gives a second page session the page's commands and events", async () => {
    const send = vi.fn(async () => ({}));
    const written: Array<Record<string, unknown>> = [];
    const relay = createCdpRelayConnection(makeTarget(send), (raw) =>
      written.push(JSON.parse(raw)),
    );
    relay.receive(JSON.stringify({ id: 1, method: "Target.setAutoAttach", params: {} }));
    relay.receive(JSON.stringify({ id: 2, method: "Target.attachToBrowserTarget" }));
    await settle();
    const browserSession = (written.find((m) => m["id"] === 2)!["result"] as { sessionId: string })
      .sessionId;
    relay.receive(
      JSON.stringify({
        id: 3,
        method: "Target.attachToTarget",
        params: { targetId: "GUEST-TARGET", flatten: true },
        sessionId: browserSession,
      }),
    );
    relay.receive(
      JSON.stringify({
        id: 4,
        method: "Target.attachToTarget",
        params: { targetId: "SOMETHING-ELSE" },
        sessionId: browserSession,
      }),
    );
    await settle();
    const extra = (written.find((m) => m["id"] === 3)!["result"] as { sessionId: string })
      .sessionId;
    expect(written.find((m) => m["id"] === 4)).toHaveProperty("error");
    relay.receive(JSON.stringify({ id: 5, method: "Page.startScreencast", sessionId: extra }));
    await settle();
    expect(send).toHaveBeenLastCalledWith("Page.startScreencast", {}, undefined);
    written.length = 0;
    relay.event("Page.screencastFrame", { data: "x" }, undefined);
    expect(written.map((m) => m["sessionId"])).toEqual(["studio-preview-page", extra]);
  });
});

describe("CDP relay downloads", () => {
  it("applies the server's download directory and reports downloads on the root session", async () => {
    const send = vi.fn(async () => ({}));
    const directories: Array<string | null> = [];
    const written: Array<Record<string, unknown>> = [];
    const relay = createCdpRelayConnection(
      makeTarget(send, (directory) => directories.push(directory)),
      (raw) => written.push(JSON.parse(raw)),
    );
    relay.receive(JSON.stringify({ id: 1, method: "Target.setAutoAttach", params: {} }));
    relay.receive(
      JSON.stringify({
        id: 2,
        method: "Browser.setDownloadBehavior",
        params: {
          behavior: "allowAndName",
          browserContextId: "studio-preview",
          downloadPath: "/srv/artifacts",
          eventsEnabled: true,
        },
      }),
    );
    await settle();
    expect(directories).toEqual(["/srv/artifacts"]);
    // The tab's own debugger has no such context, so the id stays here.
    expect(send).toHaveBeenCalledWith(
      "Browser.setDownloadBehavior",
      { behavior: "allowAndName", downloadPath: "/srv/artifacts", eventsEnabled: true },
      undefined,
    );
    written.length = 0;
    relay.event("Browser.downloadWillBegin", { guid: "g1", suggestedFilename: "r.csv" }, "");
    expect(written).toEqual([
      { method: "Browser.downloadWillBegin", params: { guid: "g1", suggestedFilename: "r.csv" } },
    ]);
  });
});
