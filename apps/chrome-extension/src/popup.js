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
  $("label-value").textContent = state.label || "Chrome";
  $("machine-value").textContent = state.machine || "This computer";
  $("tabs-value").textContent = String(state.attachedTabs ?? 0);
  $("pause").textContent = state.phase === "paused" ? "Resume" : "Pause";
  $("pause").dataset.paused = state.phase === "paused" ? "true" : "false";
  // A paired profile can still take a fresh code (after Reset in SpecWithCode).
  $("pair-form").querySelector("button").textContent = paired ? "Pair again" : "Pair this profile";
  if (!$("label").value && state.label) $("label").value = state.label;
}

$("pair-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  $("error").textContent = "";
  const response = await send({ type: "pair", code: $("code").value, label: $("label").value });
  if (!response?.ok) $("error").textContent = response?.error ?? "Pairing failed.";
  else $("code").value = "";
  await refresh();
});

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

$("label").addEventListener("change", async () => {
  const response = await send({ type: "status" });
  if (response?.state?.phase !== "not_paired")
    await send({ type: "rename", label: $("label").value });
  await refresh();
});

void refresh();
setInterval(() => void refresh(), 1_000);
