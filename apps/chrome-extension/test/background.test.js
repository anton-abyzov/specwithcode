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
function fakeChrome(stored, session = {}) {
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
      // Survives the worker stopping, like chrome.storage.session.
      session: {
        get: async (keys) =>
          Object.fromEntries(keys.filter((k) => k in session).map((k) => [k, session[k]])),
        set: async (values) => Object.assign(session, values),
      },
    },
    action: {
      badge: { text: "", color: "", title: "" },
      async setBadgeText({ text }) {
        this.badge.text = text;
      },
      async setBadgeBackgroundColor({ color }) {
        this.badge.color = color;
      },
      async setTitle({ title }) {
        this.badge.title = title;
      },
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
    session,
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
  welcome(params = {}) {
    this.emit("message", {
      data: JSON.stringify({ method: "welcome", params: { machine: "Demo Mac", ...params } }),
    });
  }
  /** The service ends the socket itself, for example 4401 for a code it does not accept. */
  serverClose(code) {
    this.readyState = 3;
    this.emit("close", { code });
  }
  get pings() {
    return this.sent.filter((m) => m.method === "ping").length;
  }
}

async function startWorker(stored = { pairing, label: "Work" }, session = {}) {
  vi.resetModules();
  FakeWebSocket.opened = [];
  const chrome = fakeChrome(stored, session);
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
  vi.useRealTimers();
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

describe("staying connected for days", () => {
  const tick = (ms = 0) => vi.advanceTimersByTimeAsync(ms);
  const connected = async (params) => {
    const worker = await startWorker();
    await tick();
    const ws = FakeWebSocket.opened.at(-1);
    ws.open();
    ws.welcome(params);
    return { ...worker, ws };
  };
  const phase = async (ask) => (await ask({ type: "status" })).state;

  it("keeps retrying after the service rejects the code and connects once it accepts it", async () => {
    vi.useFakeTimers();
    const { chrome, ask, ws } = await connected();
    // Another server on the port, or a restart mid-handshake, refuses the unchanged token once.
    ws.serverClose(4401);
    await tick();
    expect(chrome.action.badge).toMatchObject({ text: "!", color: "#e03131" });
    expect(chrome.action.badge.title).toMatch(/NOT connected since .*did not accept/);
    await tick(29_000);
    expect(FakeWebSocket.opened).toHaveLength(1);
    await tick(1_000);
    expect(FakeWebSocket.opened).toHaveLength(2);
    const second = FakeWebSocket.opened[1];
    second.open();
    // The same token is sent again; only the service decides whether it is still valid.
    expect(second.sent[0].params.token).toBe(pairing.token);
    second.welcome();
    expect((await phase(ask)).phase).toBe("connected");
    expect(chrome.action.badge).toMatchObject({ text: "ON", color: "#2f9e44" });
  });

  it("backs off to five minutes while the code keeps being refused", async () => {
    vi.useFakeTimers();
    const { ws } = await connected();
    ws.serverClose(4401);
    for (const wait of [30_000, 60_000, 120_000, 300_000, 300_000]) {
      const before = FakeWebSocket.opened.length;
      await tick(wait - 1);
      expect(FakeWebSocket.opened).toHaveLength(before);
      await tick(1);
      expect(FakeWebSocket.opened).toHaveLength(before + 1);
      const next = FakeWebSocket.opened.at(-1);
      next.open();
      next.serverClose(4401);
      await tick();
    }
  });

  it("stops every attempt when paused or unpaired", async () => {
    vi.useFakeTimers();
    const { chrome, ask, ws } = await connected();
    ws.serverClose(4401);
    await tick();
    await ask({ type: "pause", paused: true });
    await tick(10 * 60_000);
    expect(FakeWebSocket.opened).toHaveLength(1);
    expect(chrome.action.badge.text).toBe("II");
    expect((await phase(ask)).nextRetryAt).toBeNull();
    await ask({ type: "pause", paused: false });
    await tick();
    expect(FakeWebSocket.opened).toHaveLength(2);
    FakeWebSocket.opened[1].serverClose(1006);
    await tick();
    await ask({ type: "unpair" });
    await tick(10 * 60_000);
    expect(FakeWebSocket.opened).toHaveLength(2);
    expect(chrome.action.badge).toMatchObject({ text: "OFF", color: "#868e96" });
  });

  it("drops a socket that stops answering pings and reconnects", async () => {
    vi.useFakeTimers();
    const { chrome, ask, ws } = await connected({ heartbeat: true });
    await tick(20_000);
    expect(ws.pings).toBe(1);
    // No pong: the next keepalive finds the service silent.
    await tick(20_000);
    const state = await phase(ask);
    expect(state.shownPhase).toBe("disconnected");
    expect(chrome.action.badge).toMatchObject({ text: "OFF", color: "#e03131" });
    expect(chrome.action.badge.title).toMatch(/NOT connected since/);
    await tick(1_000);
    expect(FakeWebSocket.opened).toHaveLength(2);
  });

  it("stays connected while pongs arrive, and never judges an older service by silence", async () => {
    vi.useFakeTimers();
    const fresh = await connected({ heartbeat: true });
    for (let i = 0; i < 15; i += 1) {
      await tick(20_000);
      fresh.ws.emit("message", { data: JSON.stringify({ method: "pong" }) });
    }
    expect((await phase(fresh.ask)).phase).toBe("connected");
    await fresh.ask({ type: "unpair" });
    const older = await connected();
    await tick(10 * 60_000);
    expect(older.ws.pings).toBe(30);
    expect((await phase(older.ask)).phase).toBe("connected");
  });

  it("asks again after the computer sleeps instead of dropping a healthy socket", async () => {
    vi.useFakeTimers();
    const { ask, ws } = await connected({ heartbeat: true });
    await tick(20_000);
    expect(ws.pings).toBe(1);
    // Asleep for ten minutes: the clock jumps, timers did not run.
    vi.setSystemTime(Date.now() + 10 * 60_000);
    await tick(20_000);
    expect(ws.pings).toBe(2);
    expect((await phase(ask)).phase).toBe("connected");
    ws.emit("message", { data: JSON.stringify({ method: "pong" }) });
    await tick(20_000);
    expect((await phase(ask)).phase).toBe("connected");
  });

  it("remembers a rejected backoff when Chrome restarts the worker", async () => {
    vi.useFakeTimers();
    const session = {};
    const first = await startWorker({ pairing, label: "Work" }, session);
    await tick();
    FakeWebSocket.opened[0].open();
    FakeWebSocket.opened[0].welcome();
    FakeWebSocket.opened[0].serverClose(4401);
    await tick(10_000);
    expect(session.status.phase).toBe("rejected");
    expect(session.status.lastConnectedAt).toBeTypeOf("number");
    // Chrome stops the worker here; only chrome.storage.session is left.
    const left = structuredClone(session);
    await first.ask({ type: "unpair" });
    // A new worker starts inside the backoff: it waits instead of trying at once.
    const second = await startWorker({ pairing, label: "Work" }, left);
    await tick();
    expect(FakeWebSocket.opened).toHaveLength(0);
    const state = await phase(second.ask);
    expect(state.phase).toBe("rejected");
    expect(state.lastConnectedAt).toBe(left.status.lastConnectedAt);
    expect(second.chrome.action.badge.text).toBe("!");
    await tick(20_000);
    expect(FakeWebSocket.opened).toHaveLength(1);
  });

  it("keeps growing the rejected backoff when Chrome stops the worker between attempts", async () => {
    vi.useFakeTimers();
    let session = {};
    let worker = await startWorker({ pairing, label: "Work" }, session);
    await tick();
    const ws = FakeWebSocket.opened[0];
    ws.open();
    ws.welcome();
    ws.serverClose(4401);
    await tick();
    const waits = [];
    for (let i = 0; i < 5; i += 1) {
      waits.push(session.status.nextRetryAt - Date.now());
      // Chrome stops the idle worker; the next one starts with only chrome.storage.session.
      const left = structuredClone(session);
      await worker.ask({ type: "unpair" });
      session = left;
      worker = await startWorker({ pairing, label: "Work" }, session);
      await tick(session.status.nextRetryAt - Date.now());
      const next = FakeWebSocket.opened.at(-1);
      next.open();
      next.serverClose(4401);
      await tick();
    }
    expect(waits).toEqual([30_000, 60_000, 120_000, 300_000, 300_000]);
  });

  it("tries at once when the popup opens on a disconnected profile", async () => {
    vi.useFakeTimers();
    const { ask, ws } = await connected();
    ws.serverClose(4401);
    await tick();
    expect(FakeWebSocket.opened).toHaveLength(1);
    await ask({ type: "status" });
    await tick();
    expect(FakeWebSocket.opened).toHaveLength(2);
    // The popup polls every second; it does not turn into a retry storm.
    FakeWebSocket.opened[1].serverClose(4401);
    await tick();
    for (let i = 0; i < 5; i += 1) {
      await ask({ type: "status" });
      await tick(1_000);
    }
    expect(FakeWebSocket.opened).toHaveLength(2);
  });
});
