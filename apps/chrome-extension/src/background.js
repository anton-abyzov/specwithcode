/**
 * SpecWithCode Browser service worker.
 *
 * Holds one WebSocket to the SpecWithCode service on this computer
 * (ws://127.0.0.1:<port>/api/browser-relay), proves itself with the pairing
 * token, and then answers allow-listed chrome.* calls through RelayConnection.
 * Reconnects on its own while paired; nothing leaves this computer.
 */

import { PROTOCOL_VERSION, parsePairingCode } from "./pairing.js";
import { RelayConnection } from "./relayConnection.js";
import { AgentTabGroups, cleanupStaleGroups } from "./tabGroup.js";

const KEEPALIVE_MS = 20_000;
const HANDSHAKE_TIMEOUT_MS = 8_000;
const RETRY_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 30_000];
const WATCHDOG_ALARM = "specwithcode-reconnect";
/** The service closes with this code when the pairing token is wrong or was reset. */
const CLOSE_REJECTED = 4401;

const state = {
  /** "not_paired" | "connecting" | "connected" | "disconnected" | "rejected" | "paused" */
  phase: "not_paired",
  message: "",
  machine: "",
  label: "",
  connectedAt: null,
  attachedTabs: 0,
};

let socket = null;
let relay = null;
let groups = null;
let keepalive = null;
let retryTimer = null;
let retryIndex = 0;
let connecting = false;
/** Bumped by every teardown; an attempt from an older generation gives up quietly. */
let generation = 0;

const cleanup = cleanupStaleGroups();

async function readSettings() {
  const stored = await chrome.storage.local.get(["pairing", "label", "paused", "instanceId"]);
  // Store installs share one extension id across Chrome profiles; this id tells them apart.
  let instanceId = stored.instanceId;
  if (typeof instanceId !== "string" || !instanceId) {
    instanceId = crypto.randomUUID();
    await chrome.storage.local.set({ instanceId });
  }
  return {
    instanceId,
    pairing: stored.pairing ?? null,
    label: typeof stored.label === "string" && stored.label.trim() ? stored.label.trim() : "Chrome",
    paused: stored.paused === true,
  };
}

function setPhase(phase, message = "") {
  state.phase = phase;
  state.message = message;
  const badge =
    phase === "connected"
      ? { text: "ON", color: "#2f9e44" }
      : phase === "rejected"
        ? { text: "!", color: "#e03131" }
        : { text: "", color: "#868e96" };
  chrome.action.setBadgeText({ text: badge.text }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ color: badge.color }).catch(() => {});
  chrome.action
    .setTitle({
      title:
        phase === "connected"
          ? `SpecWithCode Browser: agents can use this profile (${state.label})`
          : "SpecWithCode Browser: not connected",
    })
    .catch(() => {});
}

function stopKeepalive() {
  if (keepalive) clearInterval(keepalive);
  keepalive = null;
}

function teardown(reason) {
  stopKeepalive();
  generation += 1;
  connecting = false;
  const current = socket;
  socket = null;
  relay?.close(reason);
  relay = null;
  groups?.dispose();
  groups = null;
  state.attachedTabs = 0;
  state.connectedAt = null;
  if (current && current.readyState <= 1) {
    try {
      current.close(1000, reason);
    } catch {
      // Already closed.
    }
  }
}

function scheduleRetry() {
  if (retryTimer) return;
  const delay = RETRY_DELAYS_MS[Math.min(retryIndex, RETRY_DELAYS_MS.length - 1)];
  retryIndex += 1;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    void connect();
  }, delay);
}

async function connect() {
  // Startup, the watchdog and the popup can all call this at once. Claim the attempt before the
  // first await, or each caller opens its own socket and the service replaces one with another.
  if (connecting || socket) return;
  connecting = true;
  const run = generation;
  const settings = await readSettings().catch(() => null);
  if (run !== generation) return;
  if (!settings) {
    connecting = false;
    setPhase("disconnected", "Could not read this profile's settings.");
    return scheduleRetry();
  }
  state.label = settings.label;
  if (!settings.pairing) {
    connecting = false;
    return setPhase("not_paired");
  }
  if (settings.paused) {
    connecting = false;
    return setPhase("paused", "Paused. Agents cannot use this profile.");
  }
  state.machine = settings.pairing.machine ?? "";
  setPhase("connecting");
  await cleanup;
  if (run !== generation) return;
  let ws;
  try {
    ws = new WebSocket(settings.pairing.relayUrl);
  } catch (error) {
    connecting = false;
    setPhase("disconnected", error?.message ?? "Could not open the connection.");
    return scheduleRetry();
  }
  socket = ws;
  let welcomed = false;
  /** A socket a teardown replaced must not touch the state of the one that followed it. */
  const stale = () => socket !== ws;
  const handshakeTimer = setTimeout(() => {
    if (!welcomed) ws.close(1000, "handshake timeout");
  }, HANDSHAKE_TIMEOUT_MS);

  ws.addEventListener("open", () => {
    if (stale()) return;
    ws.send(
      JSON.stringify({
        method: "hello",
        params: {
          protocol: PROTOCOL_VERSION,
          token: settings.pairing.token,
          label: settings.label,
          extensionVersion: chrome.runtime.getManifest().version,
          extensionId: chrome.runtime.id,
          instanceId: settings.instanceId,
          userAgent: navigator.userAgent,
        },
      }),
    );
  });

  ws.addEventListener("message", (event) => {
    if (stale()) return;
    let message;
    try {
      message = JSON.parse(String(event.data));
    } catch {
      return;
    }
    if (message?.method === "welcome" && !welcomed) {
      welcomed = true;
      clearTimeout(handshakeTimer);
      connecting = false;
      retryIndex = 0;
      if (typeof message.params?.machine === "string" && message.params.machine)
        state.machine = message.params.machine;
      state.connectedAt = Date.now();
      groups = new AgentTabGroups({
        label: settings.label,
        onTabReleased: (tabId) => relay?.detachTab(tabId),
      });
      relay = new RelayConnection(ws, {
        onTabAttached: (tabId) => {
          state.attachedTabs = relay?.attachedTabs.size ?? 0;
          void groups?.add(tabId);
        },
        onTabDetached: (tabId) => {
          state.attachedTabs = relay?.attachedTabs.size ?? 0;
          groups?.remove(tabId);
        },
      });
      // A live socket with traffic keeps the MV3 service worker awake.
      keepalive = setInterval(() => {
        if (ws.readyState === 1) ws.send(JSON.stringify({ method: "ping" }));
      }, KEEPALIVE_MS);
      setPhase("connected");
      return;
    }
    if (message?.method === "reconnect") {
      teardown("reconnect requested");
      retryIndex = 0;
      void connect();
    }
  });

  ws.addEventListener("close", (event) => {
    clearTimeout(handshakeTimer);
    if (stale()) return;
    teardown("socket closed");
    if (event.code === CLOSE_REJECTED) {
      setPhase(
        "rejected",
        "SpecWithCode did not accept this pairing code. Paste the current code from Settings › Chrome.",
      );
      return;
    }
    const run = generation;
    void readSettings().then((current) => {
      // A reconnect, pair or pause started while settings were read; it owns the state now.
      if (run !== generation || socket || connecting) return;
      if (!current.pairing) return setPhase("not_paired");
      if (current.paused) return setPhase("paused", "Paused. Agents cannot use this profile.");
      setPhase(
        "disconnected",
        welcomed
          ? "The connection to SpecWithCode closed. Reconnecting…"
          : "SpecWithCode is not reachable. Is the app running on this computer?",
      );
      scheduleRetry();
    });
  });
}

function reconnectNow() {
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = null;
  retryIndex = 0;
  teardown("reconnect");
  return connect();
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const respond = (promise) => {
    promise.then(
      (value) => sendResponse({ ok: true, ...value }),
      (error) => sendResponse({ ok: false, error: error?.message ?? String(error) }),
    );
    return true;
  };
  switch (message?.type) {
    case "status":
      sendResponse({ ok: true, state: { ...state } });
      return false;
    case "pair":
      return respond(
        (async () => {
          const pairing = parsePairingCode(message.code);
          const label =
            String(message.label ?? "")
              .trim()
              .slice(0, 60) || "Chrome";
          await chrome.storage.local.set({ pairing, label, paused: false });
          await reconnectNow();
          return {};
        })(),
      );
    case "rename":
      return respond(
        (async () => {
          const label =
            String(message.label ?? "")
              .trim()
              .slice(0, 60) || "Chrome";
          await chrome.storage.local.set({ label });
          await reconnectNow();
          return {};
        })(),
      );
    case "pause":
      return respond(
        (async () => {
          await chrome.storage.local.set({ paused: message.paused === true });
          await reconnectNow();
          return {};
        })(),
      );
    case "unpair":
      return respond(
        (async () => {
          await chrome.storage.local.remove(["pairing"]);
          teardown("unpaired");
          setPhase("not_paired");
          return {};
        })(),
      );
    case "reconnect":
      return respond(reconnectNow().then(() => ({})));
  }
  return false;
});

chrome.alarms.create(WATCHDOG_ALARM, { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === WATCHDOG_ALARM && !socket && !connecting && state.phase !== "rejected")
    void connect();
});
chrome.runtime.onStartup.addListener(() => void connect());
chrome.runtime.onInstalled.addListener(() => void connect());

void connect();
