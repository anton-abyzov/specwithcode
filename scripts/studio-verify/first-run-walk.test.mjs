import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { enabledNeutral, walkFirstRun } from "./first-run-walk.mjs";

const scripts = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ownPath = fileURLToPath(import.meta.url);

/** The scripts that walk first-run setup: each one calls the shared walker. */
const WALKERS = [
  "desktop-e2e/installed-e2e.mjs",
  "desktop-e2e/nogit-chat-e2e.mjs",
  "studio-fleet/test-startup.mjs",
  "studio-projects/acceptance.mjs",
  "studio-projects/coordinator-quality.mjs",
  "studio-projects/native-acceptance.mjs",
  "studio-projects/tutorial-capture.mjs",
  "studio-verify/headless-workflow.mjs",
  "studio-verify/https-browser-diagnosis.mjs",
  "studio-verify/lifecycle-controls.mjs",
  "studio-verify/ui-acceptance.mjs",
];
/** Labels only setup shows. Continue, Skip and Finish exist outside setup, so they are not here. */
const SETUP_LABELS = [
  "Use without an account",
  "Do not import projects",
  "Keep Supervised",
  "Keep current access",
  "Continue without an agent",
];
/** Pieces of the old regex forms of those labels. */
const SETUP_FRAGMENTS = [
  "without an account",
  "import projects",
  "Keep (Supervised",
  "without an agent",
];

/**
 * A page whose setup is a list of steps. Each step: `{ id, neutral, waits, moves }`:
 * `neutral` enabled neutral controls once `waits` reads have passed, `moves`
 * false for a step that stays open after its press.
 */
function fakePage(
  steps,
  { readyAfter = null, buttons = ["Back", "Install"], clickFails = 0, readErrors = [] } = {},
) {
  const state = { index: 0, reads: 0, presses: [], selectors: [], clickFails };
  const current = () => steps[state.index];
  return {
    state,
    page: {
      evaluate: async () => {
        state.reads++;
        const error = readErrors.shift();
        if (error) throw new Error(error);
        const step = current();
        if (!step) return { step: null, neutral: 0, buttons: [] };
        const waiting = (step.waits ?? 0) > 0;
        if (waiting) step.waits--;
        return { step: step.id, neutral: waiting ? 0 : (step.neutral ?? 1), buttons };
      },
      locator: (selector) => ({
        click: async () => {
          state.selectors.push(selector);
          const step = current();
          // The step went on by itself between the read and the press.
          if (state.clickFails > 0) {
            state.clickFails--;
            if (step.skipOnFail) state.index++;
            throw new Error("locator.click: Timeout 5000ms exceeded.\nCall log: ...");
          }
          assert.equal(selector, enabledNeutral(step.id));
          state.presses.push(step.id);
          if (step.moves !== false) state.index++;
        },
      }),
    },
    until: async () => readyAfter !== null && state.reads >= readyAfter,
  };
}
const quick = { pollMs: 1, stepTimeoutMs: 40, appearTimeoutMs: 40 };

test("walks each step on its neutral control and returns the step ids in order", async () => {
  const { page, state } = fakePage([
    { id: "start" },
    { id: "agents", waits: 3 },
    { id: "access" },
    { id: "import" },
  ]);
  assert.deepEqual(await walkFirstRun(page, quick), ["start", "agents", "access", "import"]);
  assert.deepEqual(state.presses, ["start", "agents", "access", "import"]);
});

test("returns no steps when the app is ready without setup, or setup never shows", async () => {
  const ready = fakePage([], { readyAfter: 0 });
  assert.deepEqual(await walkFirstRun(ready.page, { ...quick, until: ready.until }), []);
  const none = fakePage([]);
  assert.deepEqual(await walkFirstRun(none.page, quick), []);
});

test("fails when neither setup nor the ready app shows", async () => {
  const { page, until } = fakePage([]);
  await assert.rejects(walkFirstRun(page, { ...quick, until }), /neither setup nor the ready app/);
});

test("a read cut off by a navigation is read again", async () => {
  const { page, state } = fakePage([{ id: "connection" }, { id: "agents" }], {
    readErrors: [
      "page.evaluate: Execution context was destroyed, most likely because of a navigation",
      "page.evaluate: Execution context was destroyed, most likely because of a navigation",
    ],
  });
  assert.deepEqual(await walkFirstRun(page, quick), ["connection", "agents"]);
  assert.deepEqual(state.presses, ["connection", "agents"]);
});

test("any other read error ends the walk", async () => {
  const { page } = fakePage([{ id: "connection" }], {
    readErrors: ["page.evaluate: Target page, context or browser has been closed"],
  });
  await assert.rejects(walkFirstRun(page, quick), /has been closed/);
});

test("a ready check that keeps flipping still ends at the deadline", async () => {
  const { page } = fakePage([]);
  let calls = 0;
  // True, then false on the confirming read, again and again.
  const until = async () => calls++ % 2 === 0;
  const started = Date.now();
  await assert.rejects(
    walkFirstRun(page, { ...quick, appearTimeoutMs: 30, until }),
    /neither setup nor the ready app/,
  );
  assert.ok(Date.now() - started < 1_000, "the flipping check outlasted the deadline");
});

test("a step that offers no neutral control fails naming the step and the enabled buttons", async () => {
  const { page } = fakePage([{ id: "connection" }, { id: "agents", waits: 1_000 }]);
  await assert.rejects(walkFirstRun(page, quick), (error) => {
    assert.match(error.message, /step "agents" offered no enabled neutral control within 40 ms/);
    assert.match(error.message, /enabled buttons: "Back", "Install"/);
    assert.deepEqual(error.firstRunSteps, ["connection"]);
    assert.equal(error.firstRunStep, "agents");
    return true;
  });
});

test("two enabled neutral controls on one step fail before anything is pressed", async () => {
  const { page, state } = fakePage([{ id: "access", neutral: 2 }]);
  await assert.rejects(walkFirstRun(page, quick), /step "access" offers 2 neutral controls/);
  assert.deepEqual(state.presses, []);
});

test("a step that stays open after its neutral control fails instead of pressing again", async () => {
  const { page, state } = fakePage([{ id: "import", moves: false }]);
  await assert.rejects(walkFirstRun(page, quick), /step "import" did not move on/);
  assert.deepEqual(state.presses, ["import"]);
});

test("a press that misses because the step moved on reads the step again", async () => {
  const { page, state } = fakePage(
    [{ id: "start", skipOnFail: true }, { id: "agents" }, { id: "import" }],
    { clickFails: 1 },
  );
  assert.deepEqual(await walkFirstRun(page, quick), ["agents", "import"]);
  assert.deepEqual(state.presses, ["agents", "import"]);
});

test("a press that fails on the same step fails naming the step", async () => {
  const { page } = fakePage([{ id: "access" }], { clickFails: 1 });
  await assert.rejects(walkFirstRun(page, quick), (error) => {
    assert.match(
      error.message,
      /could not press the neutral control of step "access": locator.click/,
    );
    assert.deepEqual(error.firstRunSteps, ["access"]);
    return true;
  });
});

test("the whole walk ends by its budget, whatever each step allows", async () => {
  const { page } = fakePage([{ id: "agents", waits: 1_000_000 }]);
  const started = Date.now();
  await assert.rejects(
    walkFirstRun(page, { pollMs: 1, stepTimeoutMs: 60_000, timeoutMs: 60 }),
    /step "agents" offered no enabled neutral control within the walk's 60 ms/,
  );
  assert.ok(Date.now() - started < 5_000);
});

test("fails after twelve steps", async () => {
  const { page, state } = fakePage(Array.from({ length: 20 }, (_, index) => ({ id: `s${index}` })));
  await assert.rejects(walkFirstRun(page, quick), /did not end after 12 steps/);
  assert.equal(state.presses.length, 12);
});

test("the press is scoped to the step read, so it never lands on the next step", () => {
  assert.equal(
    enabledNeutral("access"),
    '[data-wizard-step="access"] [data-wizard-neutral]:not(:disabled):not([aria-disabled="true"])',
  );
});

test("each of the eleven setup walkers calls the shared walker", () => {
  for (const file of WALKERS) {
    const text = readFileSync(join(scripts, file), "utf8");
    assert.match(
      text,
      /import\s*\{[^}]*\bwalkFirstRun\b[^}]*\}\s*from\s*["'](\.\.\/studio-verify|\.)\/first-run-walk\.mjs["']/,
      `${file} does not import walkFirstRun`,
    );
    assert.match(text, /\bwalkFirstRun\(/, `${file} does not call walkFirstRun`);
  }
});

function* files(folder) {
  for (const entry of readdirSync(folder, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const path = join(folder, entry.name);
    if (entry.isDirectory()) yield* files(path);
    else if (entry.isFile()) yield path;
  }
}

test("no script outside this test holds a setup-only label", () => {
  const found = [];
  for (const path of files(scripts)) {
    if (path === ownPath) continue;
    let text;
    try {
      text = readFileSync(path, "utf8");
    } catch {
      continue;
    }
    for (const label of [...SETUP_LABELS, ...SETUP_FRAGMENTS])
      if (text.includes(label)) found.push(`${relative(scripts, path)}: "${label}"`);
  }
  assert.deepEqual(found, []);
});
