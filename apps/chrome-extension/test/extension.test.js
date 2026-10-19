import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { describe, expect, it } from "vitest";

import { generatedModule, packageFiles, validateManifest } from "../scripts/build.mjs";
import { parsePairingCode } from "../src/pairing.js";
import { RelayConnection, isNonDebuggableUrl } from "../src/relayConnection.js";
import { AgentTabGroups, groupTitle } from "../src/tabGroup.js";

const root = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");
const code = (data) =>
  "swc-chrome:1:" + Buffer.from(JSON.stringify(data), "utf8").toString("base64url");
const token = "t".repeat(43);

describe("parsePairingCode", () => {
  it("reads a code SpecWithCode made", () => {
    expect(
      parsePairingCode(code({ u: "ws://127.0.0.1:8319/api/browser-relay", t: token, m: "mac" })),
    ).toEqual({
      relayUrl: "ws://127.0.0.1:8319/api/browser-relay",
      token,
      machine: "mac",
    });
  });
  it("refuses anything that leaves this computer", () => {
    expect(() => parsePairingCode(code({ u: "ws://10.0.0.2:8319/x", t: token }))).toThrow(
      /this computer/,
    );
    expect(() => parsePairingCode(code({ u: "wss://example.com/x", t: token }))).toThrow(
      /this computer/,
    );
    expect(() => parsePairingCode(code({ u: "ws://127.0.0.1:1/x", t: "short" }))).toThrow(/token/);
    expect(() => parsePairingCode("hello")).toThrow(/not a SpecWithCode pairing code/);
  });
});

function fakeChrome() {
  const listeners = () => {
    const set = new Set();
    return {
      addListener: (f) => set.add(f),
      removeListener: (f) => set.delete(f),
      fire: (...a) => [...set].forEach((f) => f(...a)),
    };
  };
  return {
    calls: [],
    debugger: {
      onEvent: listeners(),
      onDetach: listeners(),
      attach: async function (...args) {
        this.parent.calls.push(["attach", ...args]);
      },
      detach: async function () {},
      sendCommand: async () => ({ ok: true }),
    },
    tabs: {
      onCreated: listeners(),
      onRemoved: listeners(),
      get: async (id) => ({ id, url: id === 9 ? "chrome://settings" : "https://example.com" }),
      create: async () => ({ id: 5 }),
      query: async () => [],
      remove: async () => {},
      update: async () => ({}),
    },
  };
}

function fakeSocket() {
  const handlers = {};
  return {
    readyState: 1,
    sent: [],
    send(text) {
      this.sent.push(JSON.parse(text));
    },
    close() {},
    addEventListener(type, f) {
      handlers[type] = f;
    },
    emit(message) {
      return handlers.message({ data: JSON.stringify(message) });
    },
  };
}

describe("RelayConnection", () => {
  it("answers allow-listed calls and refuses the rest", async () => {
    const chrome = fakeChrome();
    chrome.debugger.parent = chrome;
    const ws = fakeSocket();
    const relay = new RelayConnection(ws, { chrome });
    await ws.emit({ id: 1, method: "chrome.tabs.create", params: [{ url: "about:blank" }] });
    await ws.emit({ id: 2, method: "chrome.cookies.getAll", params: [{}] });
    await ws.emit({ id: 3, method: "chrome.debugger.attach", params: [{ tabId: 9 }, "1.3"] });
    await ws.emit({ id: 4, method: "chrome.debugger.attach", params: [{ tabId: 4 }, "1.3"] });
    expect(ws.sent.find((m) => m.id === 1).result).toEqual({ id: 5 });
    expect(ws.sent.find((m) => m.id === 2).error).toMatch(/Unknown method/);
    expect(ws.sent.find((m) => m.id === 3).error).toMatch(/does not let extensions/);
    expect(relay.attachedTabs.has(4)).toBe(true);
    // Events for tabs the service did not attach to are never forwarded.
    chrome.debugger.onEvent.fire({ tabId: 77 }, "Network.requestWillBeSent", {});
    chrome.debugger.onEvent.fire({ tabId: 4 }, "Page.loadEventFired", {});
    const events = ws.sent.filter((m) => m.method === "chrome.debugger.onEvent");
    expect(events).toHaveLength(1);
    expect(events[0].params[0]).toEqual({ tabId: 4 });
  });
  it("knows which pages Chrome never lets an extension debug", () => {
    expect(isNonDebuggableUrl("chrome://settings")).toBe(true);
    expect(isNonDebuggableUrl("https://example.com")).toBe(false);
  });
});

describe("AgentTabGroups", () => {
  /** Chrome reports the new group before its title is set, as real Chrome can. */
  function fakeGroups() {
    const listeners = new Set();
    const groups = new Map();
    const tabs = new Map();
    let nextGroup = 1;
    return {
      groups,
      tabs: {
        onUpdated: {
          addListener: (f) => listeners.add(f),
          removeListener: (f) => listeners.delete(f),
        },
        get: async (id) => ({ id, windowId: 1, groupId: tabs.get(id) ?? -1 }),
        group: async ({ tabIds, groupId, createProperties }) => {
          const id = groupId ?? nextGroup++;
          if (!groups.has(id))
            groups.set(id, { id, windowId: createProperties.windowId, title: "" });
          for (const tabId of tabIds) {
            tabs.set(tabId, id);
            for (const f of listeners) f(tabId, { groupId: id });
          }
          await Promise.resolve();
          return id;
        },
        ungroup: async () => {},
      },
      tabGroups: {
        get: async (id) => groups.get(id),
        query: async ({ windowId, title }) =>
          [...groups.values()].filter((g) => g.windowId === windowId && g.title === title),
        update: async (id, props) => Object.assign(groups.get(id), props),
      },
    };
  }

  it("keeps a tab whose new group has no title yet, and groups tabs opened together once", async () => {
    const chrome = fakeGroups();
    const released = [];
    const groups = new AgentTabGroups({
      chrome,
      label: "Work",
      onTabReleased: (tabId) => released.push(tabId),
    });
    await Promise.all([groups.add(1), groups.add(2), groups.add(3)]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(released).toEqual([]);
    expect([...chrome.groups.values()].map((g) => g.title)).toEqual([groupTitle("Work")]);
  });
});

describe("store package", () => {
  it("passes the Chrome Web Store limits", () => {
    const manifest = JSON.parse(NodeFS.readFileSync(NodePath.join(root, "manifest.json"), "utf8"));
    expect(validateManifest(manifest)).toEqual([]);
  });
  it("refuses a description that lists AI products by name", () => {
    const manifest = JSON.parse(NodeFS.readFileSync(NodePath.join(root, "manifest.json"), "utf8"));
    manifest.description = "Let your agents (Claude, Codex, Grok) use this profile.";
    expect(validateManifest(manifest)).toContain("description must not name AI products");
  });
  it("ships the license, notice and every source file", () => {
    const files = packageFiles();
    for (const name of [
      "manifest.json",
      "LICENSE",
      "NOTICE",
      "src/background.js",
      "src/relayConnection.js",
      "icons/icon-128.png",
    ])
      expect(files).toContain(name);
    expect(files.some((name) => name.includes("test"))).toBe(false);
  });
});

describe("extensionVersion.generated.ts", () => {
  it("matches manifest.json, so the server reports the version the store gets", () => {
    const manifest = JSON.parse(NodeFS.readFileSync(NodePath.join(root, "manifest.json"), "utf8"));
    const generated = NodeFS.readFileSync(
      NodePath.join(root, "../server/src/browserExtension/extensionVersion.generated.ts"),
      "utf8",
    );
    expect(generated).toBe(generatedModule(manifest.version));
  });
});
