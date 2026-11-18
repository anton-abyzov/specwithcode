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
const CLICK_TIMEOUT_MS = 5_000;
const MAX_MISSED_PRESSES = 3;

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

/** What Playwright says when the page navigated in the middle of a read. */
const NAVIGATED = /Execution context was destroyed|Cannot find context with specified id|navigat/i;

/**
 * Walks setup from wherever it is to its end.
 *
 * - `until`: an async check that the app is ready without setup (the sidebar, a
 *   project link). Until setup shows or this holds, the walk waits up to
 *   `appearTimeoutMs`; with no `until`, a setup that never shows in that time
 *   is not an error.
 * - `stepTimeoutMs` (60 s): how long a step may take to offer its neutral action
 *   and to move on after it.
 * - `timeoutMs`: the whole walk's budget, so a caller's own deadline holds; every
 *   wait above ends by it.
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
    timeoutMs = Infinity,
    onStep,
  } = {},
) {
  const end = Date.now() + timeoutMs;
  /** When a wait of `ms` ends: its own limit or the walk's, whichever comes first. */
  const by = (ms) => Math.min(Date.now() + ms, end);
  const late = (limit, ms) => (limit === end ? `the walk's ${timeoutMs} ms` : `${ms} ms`);
  // A page that navigates while it is read (the pair link redirecting) is read
  // again once the new document is there; any other error ends the walk.
  const read = async () => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await page.evaluate(readWizard, { dialog: WIZARD_DIALOG });
      } catch (error) {
        if (!NAVIGATED.test(String(error?.message ?? error)) || attempt >= 40 || Date.now() >= end)
          throw error;
        await pause(pollMs);
      }
    }
  };
  const steps = [];
  let missed = 0;
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
  for (const deadline = by(appearTimeoutMs); state.step === null; ) {
    // Checked first, so a ready check that keeps flipping cannot outlast the deadline.
    if (Date.now() >= deadline) {
      if (until)
        fail(`neither setup nor the ready app showed within ${late(deadline, appearTimeoutMs)}`, state);
      return steps;
    }
    if (until && (await until().catch(() => false))) {
      // The app can draw before setup opens over it: ready twice in a row counts.
      await pause(pollMs);
      state = await read();
      if (state.step === null && (await until().catch(() => false))) return steps;
      continue;
    }
    await pause(pollMs);
    state = await read();
  }

  while (state.step !== null) {
    const step = state.step;
    for (const deadline = by(stepTimeoutMs); state.step === step && state.neutral === 0; ) {
      if (Date.now() >= deadline)
        fail(
          `step "${step}" offered no enabled neutral control within ${late(deadline, stepTimeoutMs)}`,
          state,
        );
      await pause(pollMs);
      state = await read();
    }
    if (state.step !== step) continue;
    if (state.neutral > 1) fail(`step "${step}" offers ${state.neutral} neutral controls`, state);
    if (steps.length >= maxSteps) fail(`setup did not end after ${maxSteps} steps`, state);
    steps.push(step);
    await onStep?.(step);
    // Scoped to the step read: a press never lands on the step after it.
    try {
      await page
        .locator(enabledNeutral(step))
        .click({ timeout: Math.max(1, Math.min(CLICK_TIMEOUT_MS, stepTimeoutMs, end - Date.now())) });
    } catch (error) {
      state = await read();
      // The step changed or went busy between the read and the press: read it again.
      if ((state.step !== step || state.neutral === 0) && ++missed <= MAX_MISSED_PRESSES) {
        steps.pop();
        continue;
      }
      fail(`could not press the neutral control of step "${step}": ${error.message.split("\n")[0]}`, state);
    }
    // The step moves on, or setup ends. Pressing again on the same step would hide a stuck step.
    state = await read();
    for (const deadline = by(stepTimeoutMs); state.step === step; ) {
      if (Date.now() >= deadline)
        fail(
          `step "${step}" did not move on within ${late(deadline, stepTimeoutMs)} of its neutral control`,
          state,
        );
      await pause(pollMs);
      state = await read();
    }
  }
  return steps;
}
