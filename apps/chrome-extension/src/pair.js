/**
 * The pairing form, shared by the extension's own pairing page (pair.html, opened on a first
 * install) and the toolbar popup. A profile is paired by a pasted code and a name the person
 * chose: there is no default name, and Pair stays off until there is one.
 */

/** Names offered with one press. */
export const SUGGESTED_NAMES = ["Personal", "Work", "Agents"];

export const WHERE_TO_COPY =
  "Copy the code from SpecWithCode: first-run setup, or Settings > Chrome.";

/** The line a profile that is already paired shows before it is paired again. */
export function replacesText(state) {
  if (!state || state.phase === "not_paired") return "";
  return state.machine
    ? `This profile is paired with ${state.machine}. Pairing here replaces that.`
    : "This profile is already paired. Pairing here replaces that.";
}

const send = (message) => chrome.runtime.sendMessage(message);

/**
 * Wires the form in `doc`: the code field, the name field, the suggestions and the Pair button.
 * `onPaired` runs after the service worker took the code; it is not connected yet at that point.
 */
export function wirePairForm(doc, { onPaired, onRename } = {}) {
  const $ = (id) => doc.getElementById(id);
  const form = $("pair-form");
  const code = $("code");
  const label = $("label");
  const button = $("pair-button");
  const error = $("error");
  const hint = $("name-hint");

  const sync = () => {
    button.disabled = !label.value.trim();
    if (label.value.trim() && hint) hint.hidden = true;
  };
  /** Set once the person types or picks a name; the worker's name never overwrites theirs. */
  let touched = false;
  label.addEventListener("input", () => {
    touched = true;
    sync();
  });
  if (onRename) label.addEventListener("change", () => onRename(label.value));

  for (const suggestion of doc.querySelectorAll("[data-name]")) {
    suggestion.addEventListener("click", () => {
      label.value = suggestion.dataset.name;
      touched = true;
      sync();
      label.dispatchEvent(new Event("change"));
      if (code.value.trim()) button.focus();
      else code.focus();
    });
  }

  // Paste and Enter pairs once there is a name; without one, Enter moves to the name.
  code.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
    event.preventDefault();
    if (label.value.trim()) form.requestSubmit();
    else {
      if (hint) hint.hidden = false;
      label.focus();
    }
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!label.value.trim()) {
      if (hint) hint.hidden = false;
      label.focus();
      return;
    }
    error.textContent = "";
    button.disabled = true;
    const response = await send({ type: "pair", code: code.value, label: label.value }).catch(
      (failure) => ({ ok: false, error: failure?.message }),
    );
    sync();
    if (!response?.ok) {
      error.textContent = response?.error ?? "Pairing failed.";
      return;
    }
    code.value = "";
    await onPaired?.();
  });

  sync();
  return {
    /** Fill the name from the worker until the person types one, unless it still needs one. */
    prefill(state) {
      if (touched || !state) return;
      if (state.label && !state.needsName && label.value !== state.label) {
        label.value = state.label;
        sync();
      }
    },
    focusCode() {
      code.focus();
    },
  };
}

const PHASE_TEXT = {
  connecting: "Connecting…",
  connected: "Paired. Agents can use this profile now.",
  disconnected: "Paired, but SpecWithCode is not reachable. Is the app running on this computer?",
  rejected: "Not connected: SpecWithCode did not accept this code.",
  paused: "Paired and paused.",
};

/** The pairing page: the code field is focused, so paste, pick a name and Enter pair. */
async function startPairPage() {
  const $ = (id) => document.getElementById(id);
  // A second pairing tab closes the older one, so one stays open.
  void send({ type: "pairPageOpened" }).catch(() => {});
  let paired = false;
  const refresh = async () => {
    const response = await send({ type: "status" }).catch(() => null);
    const state = response?.state ?? { phase: "not_paired" };
    if (!paired) {
      const replaces = replacesText(state);
      $("replaces").textContent = replaces;
      $("replaces").hidden = !replaces;
      controls.prefill(state);
      return;
    }
    const shown = state.shownPhase ?? state.phase;
    if (state.phase === "rejected") {
      // The code was refused: bring the form back with the reason, for another code.
      paired = false;
      $("done").hidden = true;
      $("pair-form").hidden = false;
      $("error").textContent = state.message || "SpecWithCode did not accept this code.";
      controls.focusCode();
      return;
    }
    $("done-status").textContent = PHASE_TEXT[shown] ?? "Connecting…";
    $("done-status").dataset.phase = shown;
    $("done-detail").textContent =
      shown === "connected"
        ? `Paired with ${state.machine || "SpecWithCode"} as "${state.label}". You can close this tab.`
        : (state.message ?? "");
  };
  const controls = wirePairForm(document, {
    onPaired: async () => {
      paired = true;
      $("pair-form").hidden = true;
      $("done").hidden = false;
      $("done-status").focus();
      await refresh();
    },
  });
  controls.focusCode();
  await refresh();
  setInterval(() => void refresh(), 1_000);
}

if (globalThis.document?.body?.dataset.page === "pair") void startPairPage();
