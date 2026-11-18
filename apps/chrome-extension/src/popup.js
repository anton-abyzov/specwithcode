import { replacesText, wirePairForm } from "./pair.js";
import { timingText } from "./status.js";

const PHASE_TEXT = {
  not_paired: "Not paired",
  connecting: "Connecting…",
  connected: "Connected: agents can use this profile",
  disconnected: "Not connected: agents cannot use this profile",
  rejected: "Not connected: pairing code not accepted",
  paused: "Paused",
};

const $ = (id) => document.getElementById(id);

function send(message) {
  return chrome.runtime.sendMessage(message);
}

const form = wirePairForm(document, {
  onPaired: () => refresh(),
  onRename: async (label) => {
    if (!label.trim()) return;
    const response = await send({ type: "status" });
    if (response?.state?.phase !== "not_paired") await send({ type: "rename", label });
    await refresh();
  },
});

async function refresh() {
  const response = await send({ type: "status" });
  const state = response?.state ?? { phase: "not_paired" };
  // During a retry the badge still says OFF, and so does the popup.
  const shown = state.shownPhase ?? state.phase;
  $("status").textContent = PHASE_TEXT[shown] ?? shown;
  $("status").dataset.phase = shown;
  $("detail").textContent = state.message ?? "";
  $("timing").textContent = timingText(state);
  const paired = state.phase !== "not_paired";
  $("paired").hidden = !paired;
  $("label-value").textContent = state.label || "No name yet";
  $("machine-value").textContent = state.machine || "This computer";
  $("tabs-value").textContent = String(state.attachedTabs ?? 0);
  $("pause").textContent = state.phase === "paused" ? "Resume" : "Pause";
  $("pause").dataset.paused = state.phase === "paused" ? "true" : "false";
  $("name-needed").hidden = !(paired && state.needsName);
  const replaces = replacesText(state);
  $("replaces").textContent = replaces;
  $("replaces").hidden = !replaces;
  // A paired profile can still take a fresh code (after Reset in SpecWithCode).
  $("pair-button").textContent = paired ? "Pair again" : "Pair this profile";
  form.prefill(state);
}

$("reconnect").addEventListener("click", async () => {
  await send({ type: "reconnect" });
  await refresh();
});

$("pause").addEventListener("click", async () => {
  await send({ type: "pause", paused: $("pause").dataset.paused !== "true" });
  await refresh();
});

$("unpair").addEventListener("click", async () => {
  await send({ type: "unpair" });
  await refresh();
});

void refresh();
setInterval(() => void refresh(), 1_000);
