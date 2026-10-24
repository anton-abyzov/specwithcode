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
import { badgeFor, titleFor } from "./status.js";
import { AgentTabGroups, cleanupStaleGroups } from "./tabGroup.js";

const KEEPALIVE_MS = 20_000;
/** With a service that answers pings, no reply this long after a ping means the socket is dead. */
const PONG_TIMEOUT_MS = 15_000;
const HANDSHAKE_TIMEOUT_MS = 8_000;
const RETRY_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 30_000];
/**
 * A rejected code is retried slowly instead of never: another SpecWithCode server can hold the
 * port for a moment while the real one restarts. The service still checks the token, so a code
 * that was reset keeps being refused.
 */
const REJECTED_RETRY_DELAYS_MS = [30_000, 60_000, 120_000, 300_000];
/** Opening the popup tries at once when disconnected, at most this often. */
const POPUP_RETRY_MS = 10_000;
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
  /** When a welcome last arrived, kept across worker restarts. */
  lastConnectedAt: null,
  /** When the profile stopped being usable after it was connected. */
  disconnectedAt: null,
  /** When the next automatic attempt is due, or null. */
  nextRetryAt: null,
};

let socket = null;
let relay = null;
let groups = null;
let keepalive = null;
let retryTimer = null;
let retryIndex = 0;
let rejectedIndex = 0;
let connecting = false;
let popupRetryAt = 0;
/** The phase the badge shows; a retry's brief "connecting" keeps showing OFF. */
let shownPhase = "not_paired";
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

function persistStatus() {
  const status = {
    phase: state.phase,
    message: state.message,
    lastConnectedAt: state.lastConnectedAt,
    disconnectedAt: state.disconnectedAt,
    nextRetryAt: state.nextRetryAt,
    rejectedIndex,
  };
  Promise.resolve(chrome.storage.session?.set({ status })).catch(() => {});
}

function render() {
  const badge = badgeFor(shownPhase);
  chrome.action.setBadgeText({ text: badge.text }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ color: badge.color }).catch(() => {});
  chrome.action.setTitle({ title: titleFor({ ...state, phase: shownPhase }) }).catch(() => {});
}

function setPhase(phase, message = "") {
  const was = state.phase;
  state.phase = phase;
  state.message = message;
  if (phase === "connected") {
    state.lastConnectedAt = Date.now();
    state.disconnectedAt = null;
    state.nextRetryAt = null;
  } else if (was === "connected") state.disconnectedAt = Date.now();
  if (phase === "paused" || phase === "not_paired") state.nextRetryAt = null;
  // A retry after a failure keeps saying OFF (or !) until it actually connects.
  shownPhase =
    phase === "connecting" && (shownPhase === "disconnected" || shownPhase === "rejected")
      ? shownPhase
      : phase;
  render();
  persistStatus();
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

function clearRetry() {
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = null;
  state.nextRetryAt = null;
}

function armRetry(delay) {
  if (retryTimer) clearTimeout(retryTimer);
  state.nextRetryAt = Date.now() + delay;
  // Chrome may stop the worker before a long timer fires; the watchdog alarm then retries.
  retryTimer = setTimeout(() => {
    retryTimer = null;
    void connect();
  }, delay);
  render();
  persistStatus();
}

function scheduleRetry() {
  if (retryTimer) return;
  if (state.phase === "rejected") {
    // Step first: armRetry persists rejectedIndex, and a restarted worker resumes from it.
    const step = rejectedIndex++;
    const delays = REJECTED_RETRY_DELAYS_MS;
    return armRetry(delays[Math.min(step, delays.length - 1)]);
  }
  const step = retryIndex++;
  armRetry(RETRY_DELAYS_MS[Math.min(step, RETRY_DELAYS_MS.length - 1)]);
}

/** The service stopped answering pings: drop the socket now instead of waiting for TCP. */
function dropSilentSocket() {
  teardown("no heartbeat");
  setPhase("disconnected", "SpecWithCode stopped answering. Reconnecting…");
  scheduleRetry();
}

async function connect() {
  // Startup, the watchdog and the popup can all call this at once. Claim the attempt before the
  // first await, or each caller opens its own socket and the service replaces one with another.
  if (connecting || socket) return;
  connecting = true;
  clearRetry();
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
  /** The service answers pings (it said so in welcome); older services never do. */
  let heartbeat = false;
  let awaitingPongSince = null;
  let lastTickAt = 0;
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
    // Any message proves the service is alive.
    awaitingPongSince = null;
    if (message?.method === "welcome" && !welcomed) {
      welcomed = true;
      clearTimeout(handshakeTimer);
      connecting = false;
      retryIndex = 0;
      rejectedIndex = 0;
      heartbeat = message.params?.heartbeat === true;
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
      lastTickAt = Date.now();
      keepalive = setInterval(() => {
        if (ws.readyState !== 1) return;
        const now = Date.now();
        // A long gap means the computer slept: ask again instead of judging a ping sent before it.
        if (now - lastTickAt > KEEPALIVE_MS * 2) awaitingPongSince = null;
        lastTickAt = now;
        if (heartbeat && awaitingPongSince !== null && now - awaitingPongSince >= PONG_TIMEOUT_MS)
          return dropSilentSocket();
        ws.send(JSON.stringify({ method: "ping" }));
        if (heartbeat && awaitingPongSince === null) awaitingPongSince = now;
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
        "SpecWithCode did not accept this pairing code. Trying again on its own; if it keeps failing, paste the current code from Settings › Chrome.",
      );
      return scheduleRetry();
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

/** A person asked (Reconnect, Pair, opening the popup): try now, ignoring the backoff. */
function reconnectNow() {
  clearRetry();
  retryIndex = 0;
  rejectedIndex = 0;
  teardown("reconnect");
  return connect();
}

/** Status kept in chrome.storage.session, so a restarted worker still tells the truth. */
async function restoreStatus() {
  const stored = await Promise.resolve(chrome.storage.session?.get(["status"])).catch(() => null);
  const status = stored?.status;
  if (!status || typeof status !== "object") return false;
  state.lastConnectedAt = status.lastConnectedAt ?? null;
  // The worker stopped while connected: the connection ended with it.
  state.disconnectedAt =
    status.phase === "connected" ? Date.now() : (status.disconnectedAt ?? null);
  rejectedIndex = Number.isInteger(status.rejectedIndex) ? status.rejectedIndex : 0;
  if (status.phase !== "rejected" || !(status.nextRetryAt > Date.now())) return false;
  // Still inside a rejected backoff: wait for it instead of trying on every worker start.
  setPhase("rejected", status.message ?? "");
  armRetry(status.nextRetryAt - Date.now());
  return true;
}

const ready = restoreStatus()
  .catch(() => false)
  .then((waiting) => {
    if (!waiting) void connect();
  });

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const respond = (promise) => {
    promise.then(
      (value) => sendResponse({ ok: true, ...value }),
      (error) => sendResponse({ ok: false, error: error?.message ?? String(error) }),
    );
    return true;
  };
  switch (message?.type) {
    case "status": {
      // Someone is looking: a disconnected profile gets a fresh attempt instead of a stale wait.
      const idle = !socket && !connecting;
      if (idle && (state.phase === "disconnected" || state.phase === "rejected")) {
        const now = Date.now();
        if (now >= popupRetryAt) {
          popupRetryAt = now + POPUP_RETRY_MS;
          clearRetry();
          void connect();
        }
      }
      sendResponse({ ok: true, state: { ...state, shownPhase, now: Date.now() } });
      return false;
    }
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
          clearRetry();
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
  if (alarm.name !== WATCHDOG_ALARM) return;
  void ready.then(() => {
    if (socket || connecting) return;
    if (state.phase === "rejected" && state.nextRetryAt && Date.now() < state.nextRetryAt) return;
    void connect();
  });
});
chrome.runtime.onStartup.addListener(() => void ready.then(() => connect()));
chrome.runtime.onInstalled.addListener(() => void ready.then(() => connect()));
