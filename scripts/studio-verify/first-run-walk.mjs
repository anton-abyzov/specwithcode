// The one walk through first-run setup for every headless check. It reads the
// step from the dialog's `data-wizard-step` and presses the step's neutral
// action, the control marked `data-wizard-neutral`: it goes on without
// choosing, granting or importing anything. No label is matched, so a renamed
// button or the app in another language walks the same.
//
//   import { walkFirstRun } from "../studio-verify/first-run-walk.mjs";
//   const steps = await walkFirstRun(page, { until: () => nav.isVisible() });
//
// It returns the step ids it went through, in order (empty when setup never
// showed). It fails naming the step and the enabled buttons on screen when a
// step offers no neutral action in time, when a step does not move on after
// it, and after `maxSteps` steps.

export const WIZARD_DIALOG = "[data-wizard-step]";
export const WIZARD_NEUTRAL = `${WIZARD_DIALOG} [data-wizard-neutral]`;
/** The one enabled neutral control of `step`; a Playwright locator for it is strict. */
export const enabledNeutral = (step) =>
  `[data-wizard-step=${JSON.stringify(step)}] [data-wizard-neutral]:not(:disabled):not([aria-disabled="true"])`;

const STEP_TIMEOUT_MS = 60_000;
const MAX_STEPS = 12;

/** Read in the page: the open step, its enabled neutral controls and its enabled buttons. */
function readWizard(selectors) {
  const shown = (element) => element.getClientRects().length > 0;
  const enabled = (element) =>
    !element.disabled && element.getAttribute("aria-disabled") !== "true" && shown(element);
  const dialog = [...document.querySelectorAll(selectors.dialog)].find(shown);
  if (!dialog) return { step: null, neutral: 0, buttons: [] };
  return {
    step: dialog.getAttribute("data-wizard-step") ?? "",
    neutral: [...dialog.querySelectorAll("[data-wizard-neutral]")].filter(enabled).length,
    buttons: [...dialog.querySelectorAll("button")]
      .filter(enabled)
      .map((button) => (button.innerText ?? button.textContent ?? "").trim().split("\n")[0])
      .filter(Boolean)
      .slice(0, 20),
  };
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const named = (buttons) =>
  buttons.length ? buttons.map((name) => JSON.stringify(name)).join(", ") : "none";

/**
 * Walks setup from wherever it is to its end.
 *
 * - `until`: an async check that the app is ready without setup (the sidebar, a
 *   project link). Until setup shows or this holds, the walk waits up to
 *   `appearTimeoutMs`; with no `until`, a setup that never shows in that time
 *   is not an error.
 * - `stepTimeoutMs` (60 s): how long a step may take to offer its neutral action
 *   and to move on after it.
 * - `onStep(id)`: called before each press.
 */
export async function walkFirstRun(
  page,
  {
    until,
    appearTimeoutMs = STEP_TIMEOUT_MS,
    stepTimeoutMs = STEP_TIMEOUT_MS,
    maxSteps = MAX_STEPS,
    pollMs = 250,
    onStep,
  } = {},
) {
  const read = () => page.evaluate(readWizard, { dialog: WIZARD_DIALOG });
  const steps = [];
  const fail = (message, state) => {
    const error = new Error(
      `first-run setup: ${message}; enabled buttons: ${named(state?.buttons ?? [])}; steps: ${
        steps.join(" > ") || "none"
      }`,
    );
    error.firstRunSteps = [...steps];
    error.firstRunStep = state?.step ?? null;
    throw error;
  };

  // Setup shows, or the app is ready without it.
  let state = await read();
  for (const deadline = Date.now() + appearTimeoutMs; state.step === null; ) {
    if (until && (await until().catch(() => false))) {
      // The app can draw before setup opens over it: ready twice in a row counts.
      await pause(pollMs);
      state = await read();
      if (state.step === null && (await until().catch(() => false))) return steps;
      continue;
    }
    if (Date.now() >= deadline) {
      if (until) fail(`neither setup nor the ready app showed within ${appearTimeoutMs} ms`, state);
      return steps;
    }
    await pause(pollMs);
    state = await read();
  }

  while (state.step !== null) {
    const step = state.step;
    for (const deadline = Date.now() + stepTimeoutMs; state.step === step && state.neutral === 0; ) {
      if (Date.now() >= deadline)
        fail(`step "${step}" offered no enabled neutral control within ${stepTimeoutMs} ms`, state);
      await pause(pollMs);
      state = await read();
    }
    if (state.step !== step) continue;
    if (state.neutral > 1) fail(`step "${step}" offers ${state.neutral} neutral controls`, state);
    if (steps.length >= maxSteps) fail(`setup did not end after ${maxSteps} steps`, state);
    steps.push(step);
    await onStep?.(step);
    // Scoped to the step read: a press never lands on the step after it.
    await page.locator(enabledNeutral(step)).click({ timeout: stepTimeoutMs });
    // The step moves on, or setup ends. Pressing again on the same step would hide a stuck step.
    const pressedAt = Date.now();
    state = await read();
    while (state.step === step) {
      if (Date.now() - pressedAt >= stepTimeoutMs)
        fail(`step "${step}" did not move on within ${stepTimeoutMs} ms of its neutral control`, state);
      await pause(pollMs);
      state = await read();
    }
  }
  return steps;
}
