#!/usr/bin/env node
// Checks that agents can drive an iPhone through the iPhone Mirroring window
// with the product's own computer_* tools: 20 taps on named controls, Latin
// typing and scrolling. It needs a paired iPhone, so no CI can run it; run it
// by hand on the Mac that mirrors the phone right after any release that
// changes apps/desktop/src/computerUse/ (increment 1395, AC-01 and D-04).
//
//   node scripts/computer-use/iphone-mirroring-check.mjs --out <dir> --ios <version> [--save-screenshots]
//   node scripts/computer-use/iphone-mirroring-check.mjs --dry-run [--out <dir>] [--miss <n>]
//
// Live mode runs from the shell of a SpecWithCode Claude thread. It speaks MCP
// to this machine's SpecWithCode service as that thread
// (SPECWITHCODE_STUDIO_MCP_AUTHORIZATION), so every tap, key and scroll goes
// through the same computer_* tools and access card an agent gets, performed
// by the installed desktop app. Besides that the script only reads: the
// running desktop app's version, the load average, the iPhone Mirroring
// window's bounds, and the text in screenshots the tools returned, with
// macOS's own text recognition, to find controls by name and judge each step.
//
// It writes <out>/check.log, one line per check, and ends with one of:
//   Result: PASS     after "Clicks landed: 20 of 20"
//   Result: FAIL     after "Clicks landed: N of 20" with N below 20, or
//                    "Clicks landed: all 20, but another check failed"
//   Result: INVALID  with no click total: the run proves nothing and is
//                    repeated. Setup did not finish (access, window,
//                    connection), the installed app has no iPhone Mirroring
//                    path, another app kept the front (a step another app
//                    interrupts is paused and repeated, 3 times at most), or
//                    a failed run started at a 1-minute load above 48.
//
// Before a live run: the phone is near the Mac, locked, with its language set
// to English; iPhone Mirroring shows the phone (connected) on the main
// display; nothing else covers the window. Keep hands off the Mac's trackpad
// and keyboard while it runs. It takes about four minutes.
//
// Exit code: 0 PASS, 1 FAIL, 3 INVALID, 2 a usage error.
//
// --dry-run drives a simulated phone through the same steps and writes
// <out>/dry-run.log (never check.log). --miss <n> makes counted click n miss.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

export const CLICK_TARGET = 20;
export const MIRRORING_APP = "iPhone Mirroring";
export const MIRRORING_BUNDLE_ID = "com.apple.ScreenContinuity";
/**
 * One sample per line: lowercase, capitals, digits, shifted symbols, a doubled
 * letter. Text recognition cannot tell c, o, s, v, w, x and z from their
 * capitals, reads q as "ą" and z as "2", and confuses "!" with "l" and "¡" with
 * "i", so the samples avoid those (and s/5, o/0) and the symbols are "@" and "#".
 */
export const TYPE_SAMPLES = ["hbdt", "QHBR", "4207", "x@y#h", "hbbd"];
/** The key repeat check types REPEAT_BASE + REPEAT_TAIL and deletes from the tail. */
export const REPEAT_BASE = "QHBR";
export const REPEAT_TAIL = "4207";
export const REPEAT_PRESSES = 3;
/** Backspaces that empty the search field whatever a step left there; extra ones do nothing. */
export const CLEAR_PRESSES = 14;
export const DEFAULTS = {
  clockApp: "Clock",
  tabs: ["World Clock", "Stopwatch"],
  // Every tab Clock shows; a tab bar is where at least three of them line up.
  barLabels: ["World Clock", "Alarms", "Stopwatch", "Timers"],
  listApp: "Settings",
  settleMs: 900,
  openMs: 2_200,
  // How long a paused step waits for iPhone Mirroring to be back in front.
  pauseMs: 60_000,
  // Spotlight shows its suggestions, and an inline one after the text, about a second after a key.
  suggestMs: 2_500,
  minScrollPx: 20,
};
/** A failed run that started above this 1-minute load average is invalid (three times 16 cores). */
export const MAX_FAIL_LOAD = 48;
/**
 * Typed into the phone's Spotlight field to show the installed app has the
 * iPhone Mirroring path: that path refuses it before pressing any key. An app
 * without the path pastes it instead, a stray key in a search field.
 */
export const PATH_PROBE = "é";
/** The start of the refusal the iPhone Mirroring path gives for PATH_PROBE. */
export const PATH_REFUSAL = "passes only the keys of a US keyboard";
/** Tools that send input; each goes only to iPhone Mirroring in front. */
const INPUT_TOOLS = new Set([
  "computer_click",
  "computer_drag",
  "computer_key",
  "computer_scroll",
  "computer_type",
]);
/** How often a step is paused by another app in front and repeated before the run is INVALID. */
export const FRONT_TRIES = 3;
/** Another app in front: the step is paused, then repeated from its start. */
class FrontChanged extends Error {}
/** Refusals that sent nothing because another app was in front: safe to try again. */
const SENT_NOTHING = [
  "cannot click or type in SpecWithCode itself",
  "app in front changed",
  "did not come to the front",
  "Could not tell which app is in front",
];
/** iPhone Mirroring left the front partway: part of the input may be on the phone. */
const LEFT_FRONT = "stopped being the app in front partway";
/** What iPhone Mirroring shows instead of the phone when it is not connected. */
const NOT_CONNECTED = [
  "lock your iphone",
  "timed out",
  "iphone in use",
  "connecting to",
  "try again",
  "iphone changed",
  "microphone in use",
];
/**
 * Whole lines that mean the same: a paused connection ("Connection Paused",
 * which text recognition may cut to "Connectic Paused") and its lone "Resume"
 * button.
 */
const NOT_CONNECTED_LINES = [/^connect\S* paused$/, /^paused$/, /^resume$/];

// Reading the screen is in iphone-mirroring-judge.mjs.
export * from "./iphone-mirroring-judge.mjs";
import {
  normalize,
  readField,
  SPOTLIGHT_TRIES,
  newTexts,
  showsNoSpotlight,
  center,
  jaccard,
  pageSignature,
  tabAnchors,
  anchorIn,
  backgroundOf,
  locateTabs,
  describeLines,
  scrolled,
} from "./iphone-mirroring-judge.mjs";

/**
 * Runs every step through `deps` and returns the report lines and totals.
 * deps.call(tool, args) -> { data, image } and throws on a tool error;
 * deps.window(size) -> { window, onMainDisplay } | undefined, in screenshot pixels;
 * deps.ocr(image, region) -> [{ text, x, y, width, height }] in screenshot pixels;
 * deps.loadavg() -> the 1-minute load average;
 * deps.desktopApps() -> [{ version, path }] of the running SpecWithCode desktop apps;
 * deps.warmUp() -> ms, optional: starts text recognition, whose first call can take a minute;
 * deps.sleep(ms).
 */
export async function runCheck(deps, options = {}) {
  const config = { ...DEFAULTS, ...options };
  const [tabA, tabB] = config.tabs;
  const lines = [];
  const checks = [];
  // While a step runs, its lines wait here: a repeated step's results are
  // written as not counted, so the log never scores an attempt twice.
  let pending;
  const emit = (line) => {
    lines.push(line);
    deps.onLine?.(line);
  };
  const log = (line) => (pending === undefined ? emit(line) : pending.push(line));
  const check = (name, ok, detail) => {
    // With another app taking the front, a failed step says nothing about the product.
    if (!ok && frontLost !== undefined) return unsure(name, detail) ?? false;
    checks.push({ name, ok });
    log(`${ok ? "PASS" : "FAIL"} ${name}: ${detail}`);
    return ok;
  };
  // A check the screen could not settle either way: never a product failure.
  const unsure = (name, detail) => {
    checks.push({ name, ok: false, unsure: true });
    log(`UNSURE ${name}: ${detail}`);
  };
  const note = (detail) => log(`NOTE ${detail}`);

  let lastFrontmost;
  // Set when another app kept the front: the run then proves nothing.
  let frontLost;
  // From setup on, every input and reading needs iPhone Mirroring in front.
  let guarding = false;
  const stamp = () => new Date().toISOString().slice(11, 23);
  const frontmost = async () => (deps.frontmost === undefined ? undefined : deps.frontmost());
  const lose = (reason) => {
    frontLost ??= `${reason}; keep the Mac's trackpad and keyboard untouched while the check runs`;
    return new Error(frontLost);
  };
  // Another app in front pauses the step: it is repeated from its start once
  // iPhone Mirroring is back, so a step is never judged across a front change.
  const frontChange = (reason) => new FrontChanged(reason);
  /** Waits for iPhone Mirroring to be in front on two readings in a row, opening it as needed. */
  const waitForMirroring = async (name) => {
    let waited = 0;
    let steady = 0;
    let other = "another app";
    try {
      while (steady < 2) {
        const app = await frontmost();
        if (app === MIRRORING_APP || app === undefined) steady++;
        else {
          steady = 0;
          other = app;
          if (waited > config.pauseMs) {
            throw lose(`${other} kept the front for ${config.pauseMs / 1000} s during ${name}`);
          }
          await deps.call("computer_open", { application: MIRRORING_APP });
        }
        await deps.sleep(config.settleMs);
        waited += config.settleMs;
      }
    } catch (error) {
      if (frontLost !== undefined) throw error;
      throw lose(`bringing ${MIRRORING_APP} back during ${name} failed (${error.message})`);
    }
  };
  /** Runs one step; a front change pauses it and runs it again from the start. */
  const step = async (name, run) => {
    for (let attempt = 1; ; attempt++) {
      const mark = checks.length;
      const outer = pending;
      pending = [];
      const flush = (void_) => {
        const held = pending;
        pending = outer;
        for (const line of held) {
          log(
            void_ && /^(PASS|FAIL|UNSURE) /.test(line)
              ? `NOTE not counted, the step was repeated: ${line}`
              : line,
          );
        }
      };
      try {
        // A repeat starts from what the phone shows now, never from before the change.
        if (attempt > 1) {
          try {
            seen = await look();
          } catch (error) {
            if (error instanceof FrontChanged) throw error;
            // Without a reading after the change the step cannot be repeated: that is the loss.
            throw lose(
              `the first reading after ${MIRRORING_APP} came back during ${name} failed (${error.message})`,
            );
          }
        }
        const value = await run();
        flush(false);
        return value;
      } catch (error) {
        const repeat = error instanceof FrontChanged && frontLost === undefined;
        flush(repeat);
        if (!repeat) throw error;
        checks.length = mark;
        if (attempt >= FRONT_TRIES) {
          throw lose(`${error.message}, ${FRONT_TRIES} times in a row during ${name}`);
        }
        note(
          `${stamp()} paused ${name}: ${error.message}; repeating it once ${MIRRORING_APP} is back`,
        );
        await waitForMirroring(name);
      }
    }
  };
  const call = async (tool, args) => {
    let result;
    if (!INPUT_TOOLS.has(tool)) result = await deps.call(tool, args);
    else {
      if (frontLost !== undefined) throw new Error(frontLost);
      if (guarding) {
        let app;
        try {
          app = await frontmost();
        } catch (error) {
          throw frontChange(`the app in front could not be read before ${tool} (${error.message})`);
        }
        if (app !== undefined && app !== MIRRORING_APP) {
          throw frontChange(`${app} was in front before ${tool}`);
        }
      }
      try {
        result = await deps.call(tool, args);
      } catch (error) {
        const message = String(error?.message);
        if (message.includes(LEFT_FRONT))
          throw frontChange(`${MIRRORING_APP} left the front during ${tool}`);
        if (SENT_NOTHING.some((phrase) => message.includes(phrase))) {
          throw frontChange(
            `${tool} was refused with another app in front, nothing sent (${message})`,
          );
        }
        throw error;
      }
    }
    if (typeof result?.data?.frontmostApplication === "string") {
      lastFrontmost = result.data.frontmostApplication;
    }
    return result;
  };
  const front = () => `frontmost ${lastFrontmost ?? "unknown"}`;

  /** A screenshot through the product, the Mirroring window in it, and the text inside that window. */
  const look = async () => {
    const shot = await call("computer_screenshot", {});
    const shown = shot.data?.frontmostApplication;
    if (guarding && typeof shown === "string" && shown !== MIRRORING_APP) {
      throw frontChange(`${shown} was in front in the screenshot`);
    }
    const size = shot.data?.display;
    const found = size === undefined ? undefined : await deps.window(size);
    if (found === undefined) return { window: undefined, lines: [], shot };
    const text = await deps.ocr(shot.image, found.window);
    return { window: found.window, onMainDisplay: found.onMainDisplay, lines: text, shot };
  };
  const summary = (seen) =>
    seen.lines
      .slice(0, 8)
      .map((line) => JSON.stringify(line.text))
      .join(", ") || "no text";

  const load = () => {
    const value = deps.loadavg();
    return Number.isFinite(value) ? Math.round(value * 100) / 100 : undefined;
  };
  const startLoad = load();
  log(`Load (1 min) at start: ${startLoad ?? "unknown"}`);
  const endLoad = () => log(`Load (1 min) at end: ${load() ?? "unknown"}`);

  const invalid = (reason) => {
    endLoad();
    log(`Result: INVALID (${reason}). Repeat the run; this does not count against AC-01.`);
    return { lines, pass: false, invalid: true, landed: undefined, checks };
  };

  const finish = () => {
    if (frontLost !== undefined) return invalid(`another app took the front: ${frontLost}`);
    const clickChecks = checks.filter((entry) => entry.name.startsWith("click "));
    const landed = clickChecks.filter((entry) => entry.ok).length;
    const passed = checks.filter((entry) => entry.ok).length;
    const pass =
      passed === checks.length && clickChecks.length === CLICK_TARGET && landed === CLICK_TARGET;
    const firstFailure = checks.find((entry) => !entry.ok && !entry.unsure);
    const failure = `${passed}/${checks.length} checks passed${firstFailure ? `; first failure: ${firstFailure.name}` : ""}`;
    const unsettled = checks.filter((entry) => entry.unsure).map((entry) => entry.name);
    if (!pass && firstFailure === undefined && unsettled.length > 0) {
      // Nothing failed on the product; what did not pass could not be judged.
      return invalid(`could not judge ${unsettled.join(", ")}; ${landed} clicks landed`);
    }
    if (!pass && startLoad !== undefined && startLoad > MAX_FAIL_LOAD) {
      // No click total: an invalid log must never read as a result.
      return invalid(
        `failed (${failure}; ${landed} clicks landed) but started at a 1-minute load of ${startLoad}, above ${MAX_FAIL_LOAD}`,
      );
    }
    // Only a passing run may read "20 of 20": the T-02 test greps for it.
    log(
      pass || landed < CLICK_TARGET
        ? `Clicks landed: ${landed} of ${CLICK_TARGET}`
        : `Clicks landed: all ${CLICK_TARGET}, but another check failed`,
    );
    endLoad();
    log(pass ? `Result: PASS (${passed}/${checks.length} checks)` : `Result: FAIL (${failure})`);
    return { lines, pass, invalid: false, landed, checks };
  };

  const stop = (name, detail) => {
    check(name, false, detail);
    return finish();
  };
  const setup = (detail) => log(`SETUP ${detail}`);

  // 1. The desktop app, access and the window ---------------------------------------
  const apps = await deps.desktopApps();
  if (apps.length === 0)
    return invalid("no SpecWithCode desktop app is running to perform the steps");
  for (const app of apps) log(`Desktop app: SpecWithCode ${app.version} (${app.path})`);
  if (apps.length > 1) {
    note(
      "more than one SpecWithCode desktop app runs; the path check below shows how the one that performs the steps behaves",
    );
  }
  if (deps.warmUp !== undefined) {
    try {
      const ms = await deps.warmUp();
      setup(`text recognition ready in ${(ms / 1000).toFixed(1)} s`);
    } catch (error) {
      return invalid(`text recognition did not start: ${error.message}`);
    }
  }

  try {
    const access = await deps.call("request_access", {
      reason:
        "Run the iPhone Mirroring check: tap, type and scroll on the phone through the iPhone Mirroring window.",
      apps: [MIRRORING_APP],
    });
    const status = access.data?.status ?? "unknown";
    if (status !== "allowed") return invalid(`request_access answered ${status}`);
    setup(`access allowed; ${stamp()} frontmost ${(await frontmost()) ?? "unknown"}`);
  } catch (error) {
    return invalid(`request_access failed: ${error.message}`);
  }

  try {
    await call("computer_open", { application: MIRRORING_APP });
  } catch (error) {
    return invalid(`computer_open failed: ${error.message}`);
  }
  await deps.sleep(config.openMs);
  let seen = await look();
  if (seen.window === undefined) return invalid(`no ${MIRRORING_APP} window on screen; ${front()}`);
  if (!seen.onMainDisplay) {
    return invalid(
      `the ${MIRRORING_APP} window is not on the main display, where screenshots are taken; move it there (Window menu)`,
    );
  }
  setup(
    `window at (${seen.window.x}, ${seen.window.y}) ${seen.window.width}x${seen.window.height}; ${front()}`,
  );
  const blocked = seen.lines.find(
    (line) =>
      NOT_CONNECTED.some((phrase) => normalize(line.text).includes(phrase)) ||
      NOT_CONNECTED_LINES.some((pattern) => pattern.test(normalize(line.text))),
  );
  if (blocked !== undefined) {
    return invalid(
      `${MIRRORING_APP} is not connected and showing the phone: it shows "${blocked.text}"`,
    );
  }
  if (seen.lines.length === 0) {
    return invalid(`no text in the ${MIRRORING_APP} window, so it is not showing the phone`);
  }
  setup(`connected: ${summary(seen)}`);

  // 2. The installed app has the iPhone Mirroring path -------------------------------
  guarding = true;
  let probe;
  try {
    probe = await step("the path probe", async () => {
      await call("computer_key", { keys: "cmd+1" });
      await deps.sleep(config.settleMs);
      await call("computer_key", { keys: "cmd+3" });
      await deps.sleep(config.settleMs);
      try {
        await call("computer_type", { text: PATH_PROBE });
      } catch (error) {
        if (error instanceof FrontChanged) throw error;
        return { refused: String(error?.message).includes(PATH_REFUSAL), reason: error.message };
      }
      // An app without the path pasted the probe: at most a stray key in the search field.
      await call("computer_key", { keys: "backspace", repeat: 2 }).catch(() => undefined);
      return { took: true };
    });
  } catch (error) {
    return invalid(`opening the phone's Spotlight failed: ${error.message}`);
  }
  if (probe.took) {
    return invalid(
      `the installed desktop app has no iPhone Mirroring path: computer_type took "${PATH_PROBE}" instead of refusing it. It went to the phone's Spotlight search field, where a stray key is harmless, and was cleared with backspace`,
    );
  }
  if (!probe.refused) {
    return invalid(`the iPhone Mirroring path probe failed for another reason: ${probe.reason}`);
  }
  check(
    "mirroring path",
    true,
    `computer_type refused "${PATH_PROBE}" before pressing any key, as only the iPhone Mirroring path does; nothing reached the phone`,
  );

  // 3. Typing into Spotlight on the phone -----------------------------------------
  // Each step starts from a fresh, emptied search field, so what one step left
  // there never decides the next.
  let lastHome = [];
  // It returns a reading of the home screen and one taken after Spotlight was asked to open.
  const freshSearch = async () => {
    await call("computer_key", { keys: "cmd+1" });
    await deps.sleep(config.settleMs);
    const home = await look();
    lastHome = home.lines;
    await call("computer_key", { keys: "cmd+3" });
    await deps.sleep(config.settleMs);
    await call("computer_key", { keys: "backspace", repeat: CLEAR_PRESSES });
    await deps.sleep(300);
    const opened = await look();
    return { home, opened };
  };
  // Types into a fresh search. When the phone then shows only what its home screen
  // showed, no search field took the text: that judges nothing, so Spotlight is
  // opened again, up to SPOTLIGHT_TRIES times. Returns what the last try saw when
  // every try ended that way; `seen` holds the reading after typing. A reading
  // where `shown` finds the field is judged at once.
  const typeInSpotlight = async (text, name, waitMs, shown) => {
    for (let tries = 1; ; tries++) {
      const { home, opened } = await freshSearch();
      await call("computer_type", { text });
      await deps.sleep(waitMs);
      seen = await look();
      if (shown(seen)) return undefined;
      const after = seen;
      let gone = showsNoSpotlight(after.lines, home.lines);
      if (!gone && showsNoSpotlight(after.lines, home.lines, after.lines)) {
        // The home screen with new text: home once more tells the screen's own
        // text from a search field's, which closes.
        await call("computer_key", { keys: "cmd+1" });
        await deps.sleep(config.settleMs);
        const again = await look();
        gone = showsNoSpotlight(after.lines, home.lines, again.lines);
        seen = after;
      }
      if (!gone) return undefined;
      const extra = newTexts(opened.lines, home.lines);
      const detail = `after typing "${text}" the phone showed only its home screen, no search field (try ${tries} of ${SPOTLIGHT_TRIES}); before typing, after cmd+3, it showed ${extra.length === 0 ? "nothing beyond the home screen" : `new text ${extra.map((entry) => JSON.stringify(entry)).join(", ")}`}; home screen read ${describeLines(home.lines.slice(0, 6))}`;
      note(`${stamp()} ${name}: ${detail}`);
      if (tries >= SPOTLIGHT_TRIES) return detail;
    }
  };
  const noSpotlight = (detail) =>
    `the phone showed no Spotlight after typing on ${SPOTLIGHT_TRIES} tries, so the typing could not be judged; last try: ${detail}`;
  for (const sample of TYPE_SAMPLES) {
    try {
      await step(`type "${sample}"`, async () => {
        const gone = await typeInSpotlight(sample, `type "${sample}"`, config.settleMs, (reading) =>
          reading.lines.some((line) => readField(line.text, sample)?.count === 0),
        );
        if (gone !== undefined) {
          unsure(`type "${sample}"`, noSpotlight(gone));
          return;
        }
        const fields = seen.lines
          .map((line) => ({ line, field: readField(line.text, sample) }))
          .filter((entry) => entry.field !== undefined && entry.field.count === 0);
        const found = fields.some((entry) => entry.field.after !== "other");
        const unclear = fields.find((entry) => entry.field.after === "other");
        if (!found && unclear !== undefined) {
          unsure(
            `type "${sample}"`,
            `the field reads ${JSON.stringify(unclear.line.text)}: the text then more that is neither the cursor nor a known suggestion, so it cannot be told whether more was typed; ${front()}`,
          );
        } else {
          check(
            `type "${sample}"`,
            found,
            found
              ? `shown on the phone; ${front()}`
              : `not shown as typed; read ${describeLines(seen.lines.slice(0, 12))}; ${front()}`,
          );
        }
      });
    } catch (error) {
      check(`type "${sample}"`, false, `failed: ${error.message}`);
    }
  }

  // One backspace, then a repeated backspace, each judged by exactly what it
  // removed, read after Spotlight settled and with no other input since.
  // Spotlight's inline suggestion ("- Ask Siri") may take a press without
  // removing text; a call is never passed on that guess. A press that removed
  // nothing passes only if the suggestion is seen gone after it, and a repeat
  // that removed one fewer than asked while a suggestion showed is UNSURE.
  try {
    await step("key repeat", async () => {
      const gone = await typeInSpotlight(
        REPEAT_BASE + REPEAT_TAIL,
        "key repeat",
        config.suggestMs,
        (reading) => reading.lines.some((line) => readField(line.text, REPEAT_BASE, true)),
      );
      if (gone !== undefined) {
        unsure("key repeat", noSpotlight(gone));
        return;
      }
      const reads = [];
      const parse = () => {
        const line = seen.lines.find((entry) => readField(entry.text, REPEAT_BASE, true));
        reads.push(line?.text);
        const field = line === undefined ? undefined : readField(line.text, REPEAT_BASE, true);
        return field === undefined
          ? undefined
          : {
              tail: field.count,
              suggestion: field.after === "suggestion",
              other: field.after === "other",
            };
      };
      const read = async (waitMs = config.suggestMs) => {
        await deps.sleep(waitMs);
        seen = await look();
        return parse();
      };
      const typed = parse();
      await call("computer_key", { keys: "backspace" });
      // Read soon, before Spotlight could search again.
      const afterOne = await read(config.settleMs);
      // No input since: what shows now is what the repeat meets.
      const before = await read();
      await call("computer_key", { keys: "backspace", repeat: REPEAT_PRESSES });
      const afterRepeat = await read(config.settleMs);
      const shown = reads.map((text) => (text === undefined ? "nothing" : JSON.stringify(text)));
      const yes = (flag) => (flag ? "yes" : "no");
      const usable = (entry) => entry !== undefined && !entry.other;
      // Each call is judged on its own before and after readings, so doubt about
      // one never hides a failure the other shows.
      // The single press: arrived when it removed one character; lost when it
      // removed none with no suggestion showing, or more than one; otherwise not
      // judged, since a suggestion may have taken it without removing text.
      let single = "not judged";
      if (usable(typed) && usable(afterOne)) {
        const removed = typed.tail - afterOne.tail;
        if (removed === 1) single = "arrived";
        else if (removed > 1 || removed < 0 || !typed.suggestion) single = "lost";
      }
      // The repeat: arrived when it removed REPEAT_PRESSES characters; lost when it
      // removed fewer than the digits it could reach (one fewer with a suggestion),
      // or more than it pressed; otherwise unsure.
      let repeat;
      if (afterRepeat === undefined || before === undefined) repeat = "unreadable";
      else if (!usable(before) || !usable(afterRepeat)) repeat = "unsure";
      else {
        const removed = before.tail - afterRepeat.tail;
        const least = Math.min(REPEAT_PRESSES, before.tail) - (before.suggestion ? 1 : 0);
        if (removed < least || removed > REPEAT_PRESSES) repeat = "lost";
        else if (removed === REPEAT_PRESSES) repeat = "arrived";
        else repeat = "unsure";
      }
      const mistyped = usable(typed) && typed.tail !== REPEAT_TAIL.length;
      const count = (from, to) =>
        usable(from) && usable(to) ? `${from.tail - to.tail}` : "uncounted";
      const detail = `field read ${shown.join(" -> ")}; one backspace removed ${count(typed, afterOne)} (suggestion before ${yes(typed?.suggestion)}, after ${yes(afterOne?.suggestion)}): ${single}; backspace repeat ${REPEAT_PRESSES} removed ${count(before, afterRepeat)} (suggestion before ${yes(before?.suggestion)}): ${repeat}`;
      const changedAlone =
        usable(afterOne) && usable(before) && before.tail !== afterOne.tail
          ? "; the field also changed with no key pressed"
          : "";
      if (mistyped || single === "lost" || repeat === "lost" || repeat === "unreadable") {
        const why = mistyped
          ? `"${REPEAT_BASE}${REPEAT_TAIL}" was not typed as sent`
          : "a press did not arrive or the field was gone";
        check("key repeat", false, `${detail}${changedAlone}; ${why}`);
      } else if (repeat === "arrived" && changedAlone === "") {
        check(
          "key repeat",
          true,
          `${detail}; every press of the repeat arrived${single === "arrived" ? ", and the single press too" : ` (the single press is not judged: ${usable(typed) && usable(afterOne) ? "a suggestion showed and no text was removed" : "its readings could not be counted"})`}`,
        );
      } else {
        unsure(
          "key repeat",
          `${detail}${changedAlone}; ${repeat === "unsure" ? "the repeat's readings cannot show whether every press arrived" : "the field changed on its own between the two calls"}`,
        );
      }
    });
  } catch (error) {
    check("key repeat", false, `failed: ${error.message}`);
  }

  // 4. Taps on the Clock app's tabs ------------------------------------------------
  const barLabels = options.tabs === undefined ? config.barLabels : config.tabs;
  // The search field: the topmost line that reads the typed name, alone or with a suggestion.
  const searchField = (reading, name) =>
    reading.lines
      .filter((line) => {
        const field = readField(line.text, name);
        return field !== undefined && field.count === 0 && field.after !== "other";
      })
      .sort((a, b) => a.y - b.y)[0];
  // Return opens Spotlight's top hit once it shows ("Clock - Open"), so the key
  // waits for it. When Spotlight still shows after Return, the app's result is
  // tapped instead, and the log says so.
  const openApp = async (name) => {
    await freshSearch();
    await call("computer_type", { text: name });
    let suggested;
    for (let waited = 0; suggested === undefined && waited < config.suggestMs;) {
      await deps.sleep(config.settleMs);
      waited += config.settleMs;
      seen = await look();
      suggested = seen.lines.find((line) => readField(line.text, name)?.after === "suggestion");
    }
    await call("computer_key", { keys: "return" });
    await deps.sleep(config.openMs);
    seen = await look();
    const field = searchField(seen, name);
    const below =
      field === undefined
        ? []
        : seen.lines
            .filter((line) => center(line).y > center(field).y + field.height)
            .sort((a, b) => a.y - b.y);
    const first = below.find((line) => normalize(line.text) === normalize(name));
    // The app's own result is the first row under the field. Text between them
    // (a heading such as "Google" over another source's "Clock") means the
    // app's caption was missed, and nothing is tapped.
    const sameRow = (a, b) =>
      Math.abs(center(a).y - center(b).y) <= Math.max(a.height, b.height) / 2;
    const result =
      first !== undefined &&
      !below.some((line) => center(line).y < center(first).y && !sameRow(line, first))
        ? first
        : undefined;
    // Spotlight is still up only when its field shows a suggestion or the name
    // shows under it: an opened app's own title (Settings) is neither.
    const searching =
      field !== undefined &&
      (readField(field.text, name).after === "suggestion" || first !== undefined);
    if (!searching || locateTabs(seen.lines, [tabA, tabB], barLabels) !== undefined) return seen;
    const before =
      suggested === undefined
        ? `with no suggestion read after ${config.suggestMs / 1000} s`
        : `while ${JSON.stringify(suggested.text)} showed`;
    if (result === undefined) {
      note(
        `${stamp()} Return did not open ${name} ${before}, and ${first === undefined ? `no "${name}" result showed to tap` : `the first "${name}" under the field is not in the first row of results, so it is another source's and was not tapped`}`,
      );
      return seen;
    }
    const point = center(result);
    await call("computer_click", point);
    await deps.sleep(config.openMs);
    seen = await look();
    note(
      `${stamp()} Return did not open ${name} ${before}; tapped the "${name}" result at (${point.x}, ${point.y}): ${searchField(seen, name) === undefined ? "Spotlight closed" : "Spotlight still showed"} (not one of the ${CLICK_TARGET} counted clicks)`,
    );
    return seen;
  };
  let located;
  try {
    located = await step(`opening ${config.clockApp}`, async () => {
      seen = await openApp(config.clockApp);
      const found = locateTabs(seen.lines, [tabA, tabB], barLabels);
      if (found !== undefined && !found.ambiguous) return found;
      // One more reading: a label text recognition missed once usually shows the next time.
      await deps.sleep(config.settleMs);
      seen = await look();
      return locateTabs(seen.lines, [tabA, tabB], barLabels);
    });
  } catch (error) {
    return stop("tabs", `opening ${config.clockApp} failed: ${error.message}`);
  }
  if (located?.ambiguous) {
    unsure(
      "tabs",
      `"${tabA}" and "${tabB}" line up in more than one place; read ${describeLines(seen.lines)}`,
    );
    return finish();
  }
  // Clock on iOS 27 may show its tabs as icons only, in a column at the lower
  // right: the column is found in the picture once a Clock page title shows,
  // and its icons are the tabs in Clock's order (DEFAULTS.barLabels). Never
  // while Spotlight still shows: its Clock row has a "Stopwatch" label, and the
  // home screen's dock is a column of icons too.
  const searching = searchField(seen, config.clockApp) !== undefined;
  if (located === undefined && deps.icons !== undefined && !searching) {
    const title = config.barLabels.find((label) =>
      seen.lines.some((line) => normalize(line.text) === normalize(label)),
    );
    const order = [tabA, tabB].map((label) => config.barLabels.indexOf(label));
    if (title !== undefined && order.every((index) => index >= 0)) {
      try {
        const found = await deps.icons(seen.shot.image, seen.window);
        const column = found?.column;
        if (column === undefined) {
          const marks = found?.marks ?? [];
          note(
            `no column of ${config.barLabels.length} tab icons in the picture; icon-sized marks at ${marks.map((mark) => `(${mark.x}, ${mark.y})`).join(", ") || "none"}`,
          );
        }
        if (column?.length === config.barLabels.length) {
          const pitch = (column.at(-1).y - column[0].y) / (column.length - 1);
          const line = (point) => ({ text: "", x: point.x, y: point.y, width: 0, height: 0 });
          located = {
            icons: true,
            title,
            tabs: { [tabA]: line(column[order[0]]), [tabB]: line(column[order[1]]) },
            bar: {
              axis: "column",
              at: Math.round(column.reduce((sum, point) => sum + point.x, 0) / column.length),
              half: Math.round(pitch / 2),
              from: Math.round(column[0].y - pitch / 2),
              to: Math.round(column.at(-1).y + pitch / 2),
            },
          };
        }
      } catch (error) {
        note(`finding ${config.clockApp}'s icon column failed: ${error.message}`);
      }
    }
  }
  if (located === undefined) {
    const shownTabs = barLabels.filter((label) =>
      seen.lines.some((line) => normalize(line.text) === normalize(label)),
    );
    // Clock open with some tabs or a page title showing: the tabs could not be
    // found on the screen, which says nothing about the product.
    if (shownTabs.length >= 2) {
      unsure(
        "tabs",
        `${config.clockApp} shows ${shownTabs.map((label) => `"${label}"`).join(", ")} but no tab bar holding "${tabA}" and "${tabB}" with an even pitch could be read; read ${describeLines(seen.lines)}`,
      );
      return finish();
    }
    if (shownTabs.length === 1 && !searching) {
      unsure(
        "tabs",
        `${config.clockApp} shows "${shownTabs[0]}" but neither a tab bar holding "${tabA}" and "${tabB}" nor a column of ${config.barLabels.length} tab icons could be found; read ${describeLines(seen.lines)}`,
      );
      return finish();
    }
    return stop(
      "tabs",
      `could not find "${tabA}" and "${tabB}" in a tab bar with the other tabs (${barLabels.join(", ")}), and no ${config.clockApp} page title showed; read ${describeLines(seen.lines)}`,
    );
  }
  const { bar } = located;
  // Where each tab was last read; a reading that misses a label keeps the last place.
  const tabLines = { ...located.tabs };
  check(
    "tabs",
    true,
    located.icons
      ? `"${tabA}" and "${tabB}" found in ${config.clockApp} as icons ${config.barLabels.indexOf(tabA) + 1} and ${config.barLabels.indexOf(tabB) + 1} of a column of ${config.barLabels.length} at x ${bar.at}, y ${bar.from} to ${bar.to}, with the page title "${located.title}" showing`
      : `"${tabA}" and "${tabB}" found in ${config.clockApp}, in a ${bar.axis} at ${bar.axis === "row" ? "y" : "x"} ${bar.at}`,
  );
  const signature = (reading) => pageSignature(reading.lines, reading.window, bar);

  const tap = async (label) => {
    // Only the bar found first counts, so a page title never stands in for a missed label.
    const again = located.icons ? undefined : locateTabs(seen.lines, [tabA, tabB], barLabels);
    if (again?.bar?.axis === bar.axis && Math.abs(again.bar.at - bar.at) <= bar.half) {
      Object.assign(tabLines, again.tabs);
    }
    const line = tabLines[label];
    const point = center(line);
    const before = lastFrontmost;
    const pageBefore = signature(seen);
    await call("computer_click", point);
    await deps.sleep(config.settleMs);
    seen = await look();
    return { line, point, before, pageBefore };
  };
  // Icon tabs carry no label, so each page's title is its first word.
  const anchors = Object.fromEntries(
    Object.entries(tabAnchors(config)).map(([tab, words]) => [
      tab,
      located.icons ? [...new Set([normalize(tab), ...words])] : words,
    ]),
  );
  const anchorOf = (label, page) => anchorIn(page, anchors[label]);

  // Not counted: makes the first tab current, so every counted tap changes the page.
  let warm;
  try {
    warm = await step(`the setup tap on "${tabA}"`, () => tap(tabA));
  } catch (error) {
    return stop("tabs", `the setup tap on "${tabA}" failed: ${error.message}`);
  }
  const refs = { [tabA]: signature(seen), [tabB]: undefined };
  note(
    `setup tap on "${tabA}" at (${warm.point.x}, ${warm.point.y}); its page reads ${refs[tabA].slice(0, 6).join(" | ") || "nothing"}`,
  );
  if (anchorOf(tabA, refs[tabA]) === undefined) {
    return stop(
      "tabs",
      `the page after tapping "${tabA}" shows none of ${anchors[tabA].map((word) => `"${word}"`).join(", ")}, so it is not that tab's page and no tap can be judged (--anchors sets the words)`,
    );
  }

  for (let index = 1; index <= CLICK_TARGET; index++) {
    const target = index % 2 === 1 ? tabB : tabA;
    const other = target === tabA ? tabB : tabA;
    const name = `click ${index}/${CLICK_TARGET}`;
    try {
      await step(name, async () => {
        // After a miss the target's page may already show; an uncounted tap on the other tab resets it.
        if (anchorOf(target, signature(seen)) !== undefined) {
          const reset = await tap(other);
          note(`reset tap on "${other}" before ${name} at (${reset.point.x}, ${reset.point.y})`);
        }
        // With icon tabs a tap is judged only from the other tab's page, read
        // before it: a page read as neither proves nothing about the tap.
        if (located.icons) {
          for (let tries = 1; anchorOf(other, signature(seen)) === undefined; tries++) {
            if (tries > 2) {
              unsure(
                name,
                `the "${other}" page could not be read before the tap on "${target}", so the tap cannot be judged; the page reads ${signature(seen).slice(0, 8).join(" | ") || "nothing"}`,
              );
              return;
            }
            if (tries === 1) {
              await deps.sleep(config.settleMs);
              seen = await look();
            } else {
              const reset = await tap(other);
              note(
                `reset tap on "${other}" before ${name} at (${reset.point.x}, ${reset.point.y})`,
              );
            }
          }
        }
        const result = await tap(target);
        const page = signature(seen);
        const where = `"${target}" at (${result.point.x}, ${result.point.y}); ${result.before ?? "unknown"} -> ${lastFrontmost ?? "unknown"}`;
        // Landed: the page changed, shows the target tab's own words, and not the other tab's.
        // With icon tabs the title decides "changed": the page before did not show
        // the target's words (text behind the window's margins stays the same).
        const changed = located.icons
          ? anchorOf(target, result.pageBefore) === undefined &&
            anchorOf(target, page) !== undefined
          : jaccard(page, result.pageBefore) < 0.5;
        const anchor = anchorOf(target, page);
        const foreign = anchorOf(other, page);
        const same = refs[target] === undefined ? undefined : jaccard(page, refs[target]);
        const ok =
          changed &&
          anchor !== undefined &&
          foreign === undefined &&
          (same === undefined || same >= 0.6);
        if (ok && refs[target] === undefined) refs[target] = page;
        check(
          name,
          ok,
          `${where}; ${changed ? "page changed" : "page did not change"}, ${anchor === undefined ? "no" : `"${anchor}"`} ${target} word${foreign === undefined ? "" : `, but shows "${foreign}" from ${other}`}, ${same === undefined ? "first view of this page" : `matched ${same.toFixed(2)}`}${ok ? "" : `; before the tap it showed ${anchorOf(other, result.pageBefore) === undefined ? "no" : `"${anchorOf(other, result.pageBefore)}"`} ${other} word, after it reads ${page.slice(0, 8).join(" | ") || "nothing"}`}`,
        );
      });
    } catch (error) {
      check(name, false, `failed: ${error.message}`);
    }
  }

  // 5. Scrolling the Settings list --------------------------------------------------
  try {
    await step("scroll", async () => {
      seen = await openApp(config.listApp);
      const start = seen.lines;
      const point = {
        x: Math.round(seen.window.x + seen.window.width / 2),
        y: Math.round(seen.window.y + seen.window.height * 0.6),
      };
      await call("computer_scroll", { ...point, direction: "down", amount: 5 });
      await deps.sleep(config.settleMs);
      seen = await look();
      // Text behind the window's margins shows at the same place on the home screen.
      const background = backgroundOf(start, lastHome);
      const down = scrolled(start, seen.lines, seen.window, "down", config.minScrollPx, background);
      const middle = seen.lines;
      check(
        "scroll down",
        down.ok,
        `${down.replaced ? "page replaced" : `shared text moved ${down.median}px (${down.common} lines)`}; ${front()}`,
      );
      if (!down.ok) {
        // Not counted: tells the next fix whether a swipe moves the list where the wheel did not.
        await call("computer_drag", {
          fromX: point.x,
          fromY: Math.round(seen.window.y + seen.window.height * 0.7),
          toX: point.x,
          toY: Math.round(seen.window.y + seen.window.height * 0.35),
        });
        await deps.sleep(config.settleMs);
        const probe = await look();
        const moved = scrolled(
          middle,
          probe.lines,
          probe.window,
          "down",
          config.minScrollPx,
          background,
        );
        note(
          `probe, not counted: computer_drag ${moved.ok ? "moved" : "did not move"} the list (${moved.median}px, ${moved.common} lines)`,
        );
        seen = probe;
      }
      const before = seen.lines;
      await call("computer_scroll", { ...point, direction: "up", amount: 5 });
      await deps.sleep(config.settleMs);
      seen = await look();
      const up = scrolled(before, seen.lines, seen.window, "up", config.minScrollPx, background);
      const back =
        jaccard(pageSignature(seen.lines, seen.window), pageSignature(start, seen.window)) >= 0.7 &&
        jaccard(pageSignature(before, seen.window), pageSignature(start, seen.window)) < 0.7;
      check(
        "scroll up",
        up.ok || back,
        `${up.replaced ? "page replaced" : `shared text moved ${up.median}px (${up.common} lines)`}${back ? "; back at the top" : ""}; ${front()}`,
      );
    });
  } catch (error) {
    check("scroll", false, `failed: ${error.message}`);
  }

  // Back to the home screen; another app taking the front here still voids the run.
  await step("the home key", () => call("computer_key", { keys: "cmd+1" })).catch(() => undefined);
  return finish();
}

// The simulated phone for --dry-run is in iphone-mirroring-simulated.mjs.
export { simulatedPhone } from "./iphone-mirroring-simulated.mjs";
import { simulatedPhone } from "./iphone-mirroring-simulated.mjs";

// Live dependencies are in iphone-mirroring-live.mjs.
export {
  liveDeps,
  mcpClient,
  regionToScreenshot,
  windowInScreenshot,
} from "./iphone-mirroring-live.mjs";
import { liveDeps, mcpClient, run } from "./iphone-mirroring-live.mjs";

// Command line ------------------------------------------------------------------------

export function parseArgs(argv) {
  const options = { dryRun: false, saveScreenshots: false };
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    const value = () => {
      const next = argv[++index];
      if (next === undefined || next.startsWith("--")) throw new Error(`${flag} needs a value`);
      return next;
    };
    if (flag === "--dry-run") options.dryRun = true;
    else if (flag === "--save-screenshots") options.saveScreenshots = true;
    else if (flag === "--out") options.out = value();
    else if (flag === "--ios") {
      options.ios = value().trim();
      if (options.ios === "") throw new Error("--ios needs the iOS version, such as 27.2.1");
    } else if (flag === "--miss") options.miss = Number(value());
    else if (flag === "--clock-app") options.clockApp = value();
    else if (flag === "--list-app") options.listApp = value();
    else if (flag === "--tabs") {
      options.tabs = value()
        .split(",")
        .map((tab) => tab.trim());
      if (options.tabs.length !== 2 || options.tabs.some((tab) => tab === "")) {
        throw new Error("--tabs takes two tab names, comma separated");
      }
    } else if (flag === "--anchors") {
      options.anchors = value()
        .split(";")
        .map((words) =>
          words
            .split(",")
            .map((word) => normalize(word))
            .filter((word) => word !== ""),
        );
      if (options.anchors.length !== 2 || options.anchors.some((words) => words.length === 0)) {
        throw new Error('--anchors takes two word lists, e.g. "world clock;lap,start"');
      }
    } else if (flag === "--url") options.url = value();
    else throw new Error(`unknown option ${flag}`);
  }
  if (!options.dryRun && options.out === undefined) throw new Error("--out <dir> is required");
  if (!options.dryRun && options.ios === undefined) {
    throw new Error("--ios <version> is required: the log names the iOS version it proved");
  }
  if (options.miss !== undefined && !options.dryRun)
    throw new Error("--miss works only with --dry-run");
  return options;
}

const header = (meta) => [
  "iPhone Mirroring check",
  `Started: ${meta.started}`,
  `Mode: ${meta.mode}`,
  `macOS: ${meta.macos}`,
  `iOS: ${meta.ios}`,
  `SpecWithCode service: ${meta.service}`,
];

/** Runs the check and writes its log; returns the exit code. */
export async function main(argv, env = process.env) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    console.error(`iphone-mirroring-check: ${error.message}`);
    return 2;
  }
  const checkOptions = {
    ...(options.clockApp ? { clockApp: options.clockApp } : {}),
    ...(options.listApp ? { listApp: options.listApp } : {}),
    ...(options.tabs ? { tabs: options.tabs } : {}),
    ...(options.anchors ? { anchors: options.anchors } : {}),
  };
  const started = new Date().toISOString();

  if (options.dryRun) {
    const outDir =
      options.out ?? NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "iphone-mirroring-dry-"));
    NodeFS.mkdirSync(outDir, { recursive: true });
    const phone = simulatedPhone({ missClick: options.miss });
    const result = await runCheck(phone.deps, checkOptions);
    const meta = {
      started,
      mode: "dry run, simulated phone",
      macos: "simulated",
      ios: "simulated",
      service: "simulated",
    };
    const file = NodePath.join(outDir, "dry-run.log");
    NodeFS.writeFileSync(file, [...header(meta), ...result.lines, ""].join("\n"));
    console.log([...header(meta), ...result.lines].join("\n"));
    console.log(`Log: ${file}`);
    return result.pass ? 0 : result.invalid ? 3 : 1;
  }

  // osascript reads the window and the text; it exists only on macOS.
  if (!NodeFS.existsSync("/usr/bin/osascript")) {
    console.error("iphone-mirroring-check: the live check runs only on macOS.");
    return 2;
  }
  const authorization = env.SPECWITHCODE_STUDIO_MCP_AUTHORIZATION;
  if (!authorization) {
    console.error(
      "iphone-mirroring-check: run this from a SpecWithCode Claude thread's shell; SPECWITHCODE_STUDIO_MCP_AUTHORIZATION is not set.",
    );
    return 2;
  }
  const url =
    options.url ?? `http://${env.STUDIO_HOST ?? "127.0.0.1"}:${env.STUDIO_PORT ?? "8319"}/mcp`;
  const outDir = NodePath.resolve(options.out);
  NodeFS.mkdirSync(outDir, { recursive: true });
  const scratch = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "iphone-mirroring-check-"));
  const file = NodePath.join(outDir, "check.log");
  const client = mcpClient({ url, authorization });
  const earlyLoad = NodeOS.loadavg()[0];
  const printed = [];
  const print = (line) => {
    printed.push(line);
    console.log(line);
  };
  let result;
  let meta;
  try {
    const server = await client.initialize();
    meta = {
      started,
      mode: "live",
      macos: run("/usr/bin/sw_vers", ["-productVersion"]),
      ios: options.ios,
      service: server?.version ?? "unknown",
    };
    for (const line of header(meta)) console.log(line);
    const deps = await liveDeps({
      client,
      scratch,
      saveScreenshots: options.saveScreenshots,
      outDir,
    });
    result = await runCheck({ ...deps, onLine: print }, checkOptions);
  } catch (error) {
    // A step threw past its own check: keep what ran, and never report a total it did not reach.
    meta ??= {
      started,
      mode: "live",
      macos: "unknown",
      ios: options.ios ?? "not given",
      service: "unreachable",
    };
    const landed = printed.filter((line) => /^PASS click \d+\//.test(line)).length;
    const pathShown = printed.some((line) => line.startsWith("PASS mirroring path"));
    const end = [`FAIL stopped: ${error.message}`];
    // Judge by the start load the log shows, when runCheck logged one.
    const logged = printed
      .find((line) => line.startsWith("Load (1 min) at start: "))
      ?.slice("Load (1 min) at start: ".length);
    let startLoad = Number(logged);
    if (logged === undefined || !Number.isFinite(startLoad)) {
      startLoad = Math.round(earlyLoad * 100) / 100;
      end.push(`Load (1 min) at start: ${startLoad}`);
    }
    end.push(`Load (1 min) at end: ${Math.round(NodeOS.loadavg()[0] * 100) / 100}`);
    if (!pathShown) {
      end.push(
        `Result: INVALID (stopped before the iPhone Mirroring path was shown). Repeat the run.`,
      );
    } else if (startLoad > MAX_FAIL_LOAD) {
      end.push(
        `Result: INVALID (stopped early with ${landed} clicks landed, at a 1-minute start load of ${startLoad}, above ${MAX_FAIL_LOAD}). Repeat the run.`,
      );
    } else {
      end.push(
        landed < CLICK_TARGET
          ? `Clicks landed: ${landed} of ${CLICK_TARGET}`
          : `Clicks landed: all ${CLICK_TARGET}, but the run stopped early`,
        "Result: FAIL (stopped early)",
      );
    }
    for (const line of end) print(line);
    result = { lines: printed, pass: false, invalid: end.at(-1).startsWith("Result: INVALID") };
  } finally {
    NodeFS.rmSync(scratch, { recursive: true, force: true });
  }
  NodeFS.writeFileSync(
    file,
    [...header(meta), ...result.lines, `Finished: ${new Date().toISOString()}`, ""].join("\n"),
  );
  console.log(`Log: ${file}`);
  return result.pass ? 0 : result.invalid ? 3 : 1;
}

if (
  process.argv[1] &&
  NodeURL.pathToFileURL(NodePath.resolve(process.argv[1])).href === import.meta.url
) {
  process.exitCode = await main(process.argv.slice(2));
}
