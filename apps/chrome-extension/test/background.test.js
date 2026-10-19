import { afterEach, describe, expect, it, vi } from "vitest";

const pairing = {
  relayUrl: "ws://127.0.0.1:8319/api/browser-relay",
  token: "t".repeat(43),
  machine: "mac",
};
const flush = async () => {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};

/** A service worker's view of Chrome: storage, the badge, the lifecycle events and the popup. */
function fakeChrome(stored) {
  const listeners = () => {
    const set = new Set();
    return {
      addListener: (f) => set.add(f),
      removeListener: (f) => set.delete(f),
      fire: (...a) => [...set].map((f) => f(...a)),
    };
  };
  const storage = { ...stored };
  return {
    storage: {
      local: {
        get: async (keys) =>
          Object.fromEntries(keys.filter((k) => k in storage).map((k) => [k, storage[k]])),
        set: async (values) => Object.assign(storage, values),
        remove: async (keys) => keys.forEach((k) => delete storage[k]),
      },
    },
    action: {
      setBadgeText: async () => {},
      setBadgeBackgroundColor: async () => {},
      setTitle: async () => {},
    },
    alarms: { create: () => {}, onAlarm: listeners() },
    runtime: {
      id: "okoinngelinfjfkmkcnbgndapeiofgbb",
      getManifest: () => ({ version: "1.0.3" }),
      onMessage: listeners(),
      onStartup: listeners(),
      onInstalled: listeners(),
    },
    tabGroups: { query: async () => [] },
    tabs: {
      query: async () => [],
      ungroup: async () => {},
      onUpdated: listeners(),
      onCreated: listeners(),
      onRemoved: listeners(),
    },
    debugger: { onEvent: listeners(), onDetach: listeners() },
    stored: storage,
  };
}

class FakeWebSocket {
  static opened = [];
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.sent = [];
    this.handlers = {};
    FakeWebSocket.opened.push(this);
  }
  addEventListener(type, f) {
    (this.handlers[type] ??= []).push(f);
  }
  emit(type, event) {
    for (const f of this.handlers[type] ?? []) f(event);
  }
  send(text) {
    this.sent.push(JSON.parse(text));
  }
  close(code = 1000) {
    if (this.readyState === 3) return;
    this.readyState = 3;
    // Chrome delivers the close event later, after the code that closed the socket has moved on.
    this.closing = () => this.emit("close", { code });
  }
  open() {
    this.readyState = 1;
    this.emit("open");
  }
  welcome() {
    this.emit("message", {
      data: JSON.stringify({ method: "welcome", params: { machine: "Demo Mac" } }),
    });
  }
}

async function startWorker(stored = { pairing, label: "Work" }) {
  vi.resetModules();
  FakeWebSocket.opened = [];
  const chrome = fakeChrome(stored);
  globalThis.chrome = chrome;
  globalThis.WebSocket = FakeWebSocket;
  await import("../src/background.js");
  const ask = (message) =>
    new Promise((resolve) => chrome.runtime.onMessage.fire(message, {}, resolve));
  globalThis.__swcAsk = ask;
  return { chrome, ask };
}

afterEach(async () => {
  // Unpairing tears the socket down, which stops the keepalive timer.
  await globalThis.__swcAsk?.({ type: "unpair" });
  delete globalThis.__swcAsk;
  delete globalThis.chrome;
  delete globalThis.WebSocket;
});

describe("service worker connection", () => {
  it("opens one socket when Chrome starts the worker and fires onStartup together", async () => {
    const { chrome, ask } = await startWorker();
    chrome.runtime.onStartup.fire();
    chrome.alarms.onAlarm.fire({ name: "specwithcode-reconnect" });
    await flush();
    expect(FakeWebSocket.opened).toHaveLength(1);
    const ws = FakeWebSocket.opened[0];
    ws.open();
    const hello = ws.sent[0].params;
    expect(hello.label).toBe("Work");
    expect(hello.instanceId).toBe(chrome.stored.instanceId);
    expect(hello.instanceId).toMatch(/^[0-9a-f-]{36}$/);
    ws.welcome();
    expect((await ask({ type: "status" })).state.phase).toBe("connected");
  });

  it("keeps the instance id across restarts of the worker", async () => {
    const first = await startWorker();
    await flush();
    const id = first.chrome.stored.instanceId;
    await first.ask({ type: "unpair" });
    await startWorker({ pairing, label: "Work", instanceId: id });
    await flush();
    FakeWebSocket.opened[0].open();
    expect(FakeWebSocket.opened[0].sent[0].params.instanceId).toBe(id);
  });

  it("ignores the close of a socket a reconnect already replaced", async () => {
    const { ask } = await startWorker();
    await flush();
    const [first] = FakeWebSocket.opened;
    first.open();
    first.welcome();
    await ask({ type: "reconnect" });
    await flush();
    expect(FakeWebSocket.opened).toHaveLength(2);
    const second = FakeWebSocket.opened[1];
    second.open();
    second.welcome();
    // The old socket's close event arrives after the new one is connected.
    first.closing();
    await flush();
    expect((await ask({ type: "status" })).state.phase).toBe("connected");
    expect(FakeWebSocket.opened).toHaveLength(2);
  });

  it("reconnects once after the service drops the live socket", async () => {
    const { ask } = await startWorker();
    await flush();
    const [first] = FakeWebSocket.opened;
    first.open();
    first.welcome();
    first.close(1006);
    first.closing();
    await flush();
    expect((await ask({ type: "status" })).state.phase).toBe("disconnected");
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    await flush();
    expect(FakeWebSocket.opened).toHaveLength(2);
  });
});
