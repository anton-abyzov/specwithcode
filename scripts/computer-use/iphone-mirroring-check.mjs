#!/usr/bin/env node
// Checks that agents can drive an iPhone through the iPhone Mirroring window
// with the product's own computer_* tools: 20 taps on named controls, Latin
// typing and scrolling. It needs a paired iPhone, so no CI can run it; run it
// by hand on the Mac that mirrors the phone right after any release that
// changes apps/desktop/src/computerUse/ (increment 1395, AC-01 and D-04).
//
//   node scripts/computer-use/iphone-mirroring-check.mjs --out <dir> [--ios <version>]
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
//   Result: FAIL     after "Clicks landed: N of 20"
//   Result: INVALID  with no click total: the run proves nothing and is
//                    repeated. Setup did not finish (access, window,
//                    connection), the installed app has no iPhone Mirroring
//                    path, or a failed run started at a 1-minute load above 48.
//
// Before a live run: the phone is near the Mac, locked, with its language set
// to English; iPhone Mirroring shows the phone (connected) on the main
// display; nothing else covers the window. The run takes about three minutes.
//
// Exit code: 0 PASS, 1 FAIL, 3 INVALID, 2 a usage error.
//
// --dry-run drives a simulated phone through the same steps and writes
// <out>/dry-run.log (never check.log). --miss <n> makes counted click n miss.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

export const CLICK_TARGET = 20;
export const MIRRORING_APP = "iPhone Mirroring";
export const MIRRORING_BUNDLE_ID = "com.apple.ScreenContinuity";
/** One sample per line: lowercase, capitals, digits, shifted symbols. */
export const TYPE_SAMPLES = ["zqxv", "QZXV", "4207", "x@y!z"];
export const DEFAULTS = {
  clockApp: "Clock",
  tabs: ["World Clock", "Stopwatch"],
  listApp: "Settings",
  settleMs: 900,
  openMs: 2_200,
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

// Text and geometry ------------------------------------------------------------

export const normalize = (text) => text.toLowerCase().replace(/\s+/g, " ").trim();
const squash = (text) => text.replace(/\s+/g, "");
/** Clock readings change between screenshots, so they never decide a match. */
const isReading = (text) => /^[\d\s:.,]+(am|pm)?$/i.test(text.trim());

export const center = (line) => ({
  x: Math.round(line.x + line.width / 2),
  y: Math.round(line.y + line.height / 2),
});

export function jaccard(a, b) {
  const left = new Set(a);
  const right = new Set(b);
  if (left.size === 0 && right.size === 0) return 1;
  let shared = 0;
  for (const item of left) if (right.has(item)) shared++;
  return shared / (left.size + right.size - shared);
}

/** The words a page shows above its tab bar: what tells one tab's page from another. */
export function pageSignature(lines, window) {
  const limit = window.y + window.height * 0.75;
  return [
    ...new Set(
      lines
        .filter((line) => center(line).y < limit && !isReading(line.text))
        .map((line) => normalize(line.text))
        .filter((text) => text.length > 0),
    ),
  ];
}

/** Words that only that tab's page shows, by tab: what proves a tap landed on the named tab. */
export const DEFAULT_ANCHORS = {
  "World Clock": ["world clock"],
  // Not "start" or "stop": the Timers page shows those too.
  Stopwatch: ["lap", "reset"],
};

/** The anchor words per tab: --anchors, else the defaults, else the tab's own name. */
export function tabAnchors(config) {
  return Object.fromEntries(
    config.tabs.map((tab, index) => [
      tab,
      config.anchors?.[index] ?? DEFAULT_ANCHORS[tab] ?? [normalize(tab)],
    ]),
  );
}

/** The first anchor word a page signature shows, as a whole word. */
export function anchorIn(page, words) {
  for (const word of words) {
    const pattern = new RegExp(
      `(^|[^a-z])${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^a-z])`,
    );
    if (page.some((entry) => pattern.test(entry))) return word;
  }
  return undefined;
}

/** A tab's label in the bottom part of the window, the lowest one when it shows twice. */
export function findTab(lines, window, label) {
  const top = window.y + window.height * 0.7;
  const wanted = normalize(label);
  return lines
    .filter((line) => normalize(line.text) === wanted && center(line).y >= top)
    .sort((a, b) => center(b).y - center(a).y)[0];
}

/** How far text that shows in both readings moved, as the median of the vertical moves. */
export function verticalShift(before, after) {
  const once = (lines) => {
    const seen = new Map();
    for (const line of lines) {
      const key = normalize(line.text);
      if (key === "" || isReading(line.text)) continue;
      seen.set(key, seen.has(key) ? null : line);
    }
    return seen;
  };
  const a = once(before);
  const b = once(after);
  const moves = [];
  for (const [key, line] of a) {
    const other = b.get(key);
    if (line !== null && other !== undefined && other !== null) {
      moves.push(center(other).y - center(line).y);
    }
  }
  moves.sort((x, y) => x - y);
  const median = moves.length === 0 ? 0 : moves[Math.floor(moves.length / 2)];
  return { common: moves.length, median };
}

/** Whether a scroll moved the page: shared text moved far enough, or the page was replaced. */
export function scrolled(before, after, window, direction, minPx) {
  const shift = verticalShift(before, after);
  const sign = direction === "down" ? -1 : 1;
  if (shift.common >= 3) return { ok: shift.median * sign >= minPx, ...shift };
  const replaced =
    jaccard(pageSignature(before, window), pageSignature(after, window)) < 0.4 && after.length > 0;
  return { ok: replaced, replaced, ...shift };
}

// The check ----------------------------------------------------------------------

/**
 * Runs every step through `deps` and returns the report lines and totals.
 * deps.call(tool, args) -> { data, image } and throws on a tool error;
 * deps.window(size) -> { window, onMainDisplay } | undefined, in screenshot pixels;
 * deps.ocr(image, region) -> [{ text, x, y, width, height }] in screenshot pixels;
 * deps.loadavg() -> the 1-minute load average;
 * deps.desktopApps() -> [{ version, path }] of the running SpecWithCode desktop apps;
 * deps.sleep(ms).
 */
export async function runCheck(deps, options = {}) {
  const config = { ...DEFAULTS, ...options };
  const [tabA, tabB] = config.tabs;
  const lines = [];
  const checks = [];
  const log = (line) => {
    lines.push(line);
    deps.onLine?.(line);
  };
  const check = (name, ok, detail) => {
    checks.push({ name, ok });
    log(`${ok ? "PASS" : "FAIL"} ${name}: ${detail}`);
    return ok;
  };
  const note = (detail) => log(`NOTE ${detail}`);

  let lastFrontmost;
  const call = async (tool, args) => {
    const attempt = () => deps.call(tool, args);
    let result;
    try {
      result = await attempt();
    } catch (error) {
      // The gate refuses input when the app in front changed (a card was answered).
      if (!String(error?.message).includes("app in front changed")) throw error;
      note(`${tool} refused because the app in front changed; reopening ${MIRRORING_APP}.`);
      await deps.call("computer_open", { application: MIRRORING_APP });
      await deps.sleep(config.settleMs);
      result = await attempt();
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
    const clickChecks = checks.filter((entry) => entry.name.startsWith("click "));
    const landed = clickChecks.filter((entry) => entry.ok).length;
    const passed = checks.filter((entry) => entry.ok).length;
    const pass =
      passed === checks.length && clickChecks.length === CLICK_TARGET && landed === CLICK_TARGET;
    const firstFailure = checks.find((entry) => !entry.ok);
    const failure = `${passed}/${checks.length} checks passed${firstFailure ? `; first failure: ${firstFailure.name}` : ""}`;
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

  try {
    const access = await deps.call("request_access", {
      reason:
        "Run the iPhone Mirroring check: tap, type and scroll on the phone through the iPhone Mirroring window.",
      apps: [MIRRORING_APP],
    });
    const status = access.data?.status ?? "unknown";
    if (status !== "allowed") return invalid(`request_access answered ${status}`);
    setup("access allowed");
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
  const blocked = seen.lines.find((line) =>
    NOT_CONNECTED.some((phrase) => normalize(line.text).includes(phrase)),
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
  try {
    await call("computer_key", { keys: "cmd+1" });
    await deps.sleep(config.settleMs);
    await call("computer_key", { keys: "cmd+3" });
    await deps.sleep(config.settleMs);
  } catch (error) {
    return invalid(`opening the phone's Spotlight failed: ${error.message}`);
  }
  try {
    await call("computer_type", { text: PATH_PROBE });
    // An app without the path pasted the probe: at most a stray key in the search field.
    await call("computer_key", { keys: "backspace", repeat: 2 }).catch(() => undefined);
    return invalid(
      `the installed desktop app has no iPhone Mirroring path: computer_type took "${PATH_PROBE}" instead of refusing it. It went to the phone's Spotlight search field, where a stray key is harmless, and was cleared with backspace`,
    );
  } catch (error) {
    if (!String(error?.message).includes(PATH_REFUSAL)) {
      return invalid(`the iPhone Mirroring path probe failed for another reason: ${error.message}`);
    }
    check(
      "mirroring path",
      true,
      `computer_type refused "${PATH_PROBE}" before pressing any key, as only the iPhone Mirroring path does; nothing reached the phone`,
    );
  }

  // 3. Typing into Spotlight on the phone -----------------------------------------
  for (const sample of TYPE_SAMPLES) {
    try {
      await call("computer_type", { text: sample });
      await deps.sleep(config.settleMs);
      seen = await look();
      const found = seen.lines.some((line) => squash(line.text).includes(squash(sample)));
      check(
        `type "${sample}"`,
        found,
        found ? `shown on the phone; ${front()}` : `not shown; read ${summary(seen)}; ${front()}`,
      );
      await call("computer_key", { keys: "backspace", repeat: sample.length });
      await deps.sleep(300);
    } catch (error) {
      check(`type "${sample}"`, false, `failed: ${error.message}`);
    }
  }

  // 4. Taps on the Clock app's tabs ------------------------------------------------
  const openApp = async (name) => {
    await call("computer_key", { keys: "cmd+3" });
    await deps.sleep(config.settleMs);
    await call("computer_type", { text: name });
    await deps.sleep(config.settleMs);
    await call("computer_key", { keys: "return" });
    await deps.sleep(config.openMs);
    return look();
  };
  try {
    seen = await openApp(config.clockApp);
  } catch (error) {
    return stop("tabs", `opening ${config.clockApp} failed: ${error.message}`);
  }
  const located = [tabA, tabB].map((label) => findTab(seen.lines, seen.window, label));
  if (located.some((line) => line === undefined)) {
    return stop(
      "tabs",
      `could not find "${tabA}" and "${tabB}" at the bottom; read ${summary(seen)}`,
    );
  }
  check("tabs", true, `"${tabA}" and "${tabB}" found in ${config.clockApp}`);

  const tap = async (label) => {
    const line = findTab(seen.lines, seen.window, label);
    if (line === undefined) return { line: undefined };
    const point = center(line);
    const before = lastFrontmost;
    const pageBefore = pageSignature(seen.lines, seen.window);
    await call("computer_click", point);
    await deps.sleep(config.settleMs);
    seen = await look();
    return { line, point, before, pageBefore };
  };
  const anchors = tabAnchors(config);
  const anchorOf = (label, page) => anchorIn(page, anchors[label]);

  // Not counted: makes the first tab current, so every counted tap changes the page.
  const warm = await tap(tabA);
  const refs = { [tabA]: pageSignature(seen.lines, seen.window), [tabB]: undefined };
  note(
    `setup tap on "${tabA}" ${warm.line ? `at (${warm.point.x}, ${warm.point.y})` : "found no label"}; its page reads ${refs[tabA].slice(0, 6).join(" | ") || "nothing"}`,
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
      // After a miss the target's page may already show; an uncounted tap on the other tab resets it.
      if (anchorOf(target, pageSignature(seen.lines, seen.window)) !== undefined) {
        const reset = await tap(other);
        note(`reset tap on "${other}" before ${name}: ${reset.line ? "done" : "label not found"}`);
      }
      const result = await tap(target);
      if (result.line === undefined) {
        check(name, false, `"${target}" not found; read ${summary(seen)}`);
        continue;
      }
      const page = pageSignature(seen.lines, seen.window);
      const where = `"${target}" at (${result.point.x}, ${result.point.y}); ${result.before ?? "unknown"} -> ${lastFrontmost ?? "unknown"}`;
      // Landed: the page changed, shows the target tab's own words, and not the other tab's.
      const changed = jaccard(page, result.pageBefore) < 0.5;
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
        `${where}; ${changed ? "page changed" : "page did not change"}, ${anchor === undefined ? "no" : `"${anchor}"`} ${target} word${foreign === undefined ? "" : `, but shows "${foreign}" from ${other}`}, ${same === undefined ? "first view of this page" : `matched ${same.toFixed(2)}`}`,
      );
    } catch (error) {
      check(name, false, `failed: ${error.message}`);
    }
  }

  // 5. Scrolling the Settings list --------------------------------------------------
  try {
    seen = await openApp(config.listApp);
    const start = seen.lines;
    const point = {
      x: Math.round(seen.window.x + seen.window.width / 2),
      y: Math.round(seen.window.y + seen.window.height * 0.6),
    };
    await call("computer_scroll", { ...point, direction: "down", amount: 5 });
    await deps.sleep(config.settleMs);
    seen = await look();
    const down = scrolled(start, seen.lines, seen.window, "down", config.minScrollPx);
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
      const moved = scrolled(middle, probe.lines, probe.window, "down", config.minScrollPx);
      note(
        `probe, not counted: computer_drag ${moved.ok ? "moved" : "did not move"} the list (${moved.median}px, ${moved.common} lines)`,
      );
      seen = probe;
    }
    const before = seen.lines;
    await call("computer_scroll", { ...point, direction: "up", amount: 5 });
    await deps.sleep(config.settleMs);
    seen = await look();
    const up = scrolled(before, seen.lines, seen.window, "up", config.minScrollPx);
    const back =
      jaccard(pageSignature(seen.lines, seen.window), pageSignature(start, seen.window)) >= 0.7 &&
      jaccard(pageSignature(before, seen.window), pageSignature(start, seen.window)) < 0.7;
    check(
      "scroll up",
      up.ok || back,
      `${up.replaced ? "page replaced" : `shared text moved ${up.median}px (${up.common} lines)`}${back ? "; back at the top" : ""}; ${front()}`,
    );
  } catch (error) {
    check("scroll", false, `failed: ${error.message}`);
  }

  await call("computer_key", { keys: "cmd+1" }).catch(() => undefined);
  return finish();
}

// A simulated phone for --dry-run -------------------------------------------------

/** A phone behind a Mirroring window that answers the tools the way the real one should. */
export function simulatedPhone({
  missClick,
  pages: pageOverride,
  deadClicks = false,
  load = 3,
  mirroringPath = true,
} = {}) {
  const window = { x: 600, y: 100, width: 360, height: 760 };
  const display = { width: 1512, height: 982 };
  const tabs = {
    "World Clock": { x: 640, y: 820, width: 90, height: 20 },
    Stopwatch: { x: 840, y: 820, width: 80, height: 20 },
  };
  const pages = pageOverride ?? {
    "World Clock": ["World Clock", "Edit", "Cupertino", "Today, +0HRS", "10:42"],
    Stopwatch: ["00:00,00", "Lap", "Start"],
  };
  const rows = [
    "General",
    "Accessibility",
    "Action Button",
    "Camera",
    "Control Center",
    "Display & Brightness",
    "Home Screen & App Library",
    "Search",
    "Siri",
    "StandBy",
    "Wallpaper",
    "Notifications",
    "Sounds & Haptics",
    "Focus",
    "Screen Time",
  ];
  const state = {
    front: "SpecWithCode",
    app: "home",
    query: "",
    tab: "Stopwatch",
    scroll: 0,
    clicks: 0,
    calls: [],
  };
  const line = (text, x, y, width = 120, height = 20) => ({ text, x, y, width, height });

  const ocr = () => {
    if (state.app === "home") return [line("Clock", 640, 300), line("Settings", 760, 300)];
    if (state.app === "spotlight")
      return state.query === "" ? [line("Search", 640, 160)] : [line(state.query, 640, 160)];
    if (state.app === "Clock") {
      return [
        ...pages[state.tab].map((text, index) => line(text, 620, 150 + index * 60)),
        ...Object.entries(tabs).map(([text, box]) =>
          line(text, box.x, box.y, box.width, box.height),
        ),
      ];
    }
    if (state.app === "Settings") {
      return rows
        .map((text, index) => line(text, 620, 200 + index * 50 - state.scroll))
        .filter((entry) => entry.y > window.y && entry.y < window.y + window.height - 20);
    }
    return [];
  };

  const call = async (tool, args) => {
    state.calls.push(tool);
    const done = (data = {}) => ({ data: { display, frontmostApplication: state.front, ...data } });
    switch (tool) {
      case "request_access":
        return { data: { status: "allowed", allowed: [MIRRORING_APP] } };
      case "computer_open":
        state.front = MIRRORING_APP;
        return done();
      case "computer_screenshot":
        return { ...done(), image: "simulated" };
      case "computer_key": {
        if (args.keys === "cmd+1") state.app = "home";
        else if (args.keys === "cmd+3") {
          state.app = "spotlight";
          state.query = "";
        } else if (args.keys === "backspace")
          state.query = state.query.slice(0, -(args.repeat ?? 1));
        else if (args.keys === "return" && state.app === "spotlight") {
          state.app = state.query;
          state.scroll = 0;
        }
        return done();
      }
      case "computer_type":
        // The iPhone Mirroring path refuses what a US keyboard cannot type; an older app pastes it.
        if (mirroringPath && /[^\x20-\x7e\n\t]/.test(args.text)) {
          throw new Error(
            `iPhone Mirroring ${PATH_REFUSAL} to the phone, so "${args.text}" cannot be typed there and nothing was typed.`,
          );
        }
        if (state.app === "spotlight") state.query += args.text;
        return done();
      case "computer_click": {
        state.clicks++;
        // The first click is the uncounted setup tap.
        const counted = state.clicks - 1;
        const hit = Object.entries(tabs).find(
          ([, box]) =>
            args.x >= box.x &&
            args.x < box.x + box.width &&
            args.y >= box.y &&
            args.y < box.y + box.height,
        );
        if (state.app === "Clock" && hit !== undefined && counted !== missClick && !deadClicks) {
          state.tab = hit[0];
        }
        return done();
      }
      case "computer_scroll":
        if (state.app === "Settings") {
          state.scroll = Math.max(
            0,
            state.scroll + (args.direction === "down" ? 1 : -1) * args.amount * 20,
          );
        }
        return done();
      case "computer_drag":
        return done();
      default:
        throw new Error(`the simulated phone has no ${tool}`);
    }
  };

  return {
    state,
    deps: {
      call,
      window: async () => ({ window, onMainDisplay: true }),
      ocr: async () => ocr(),
      loadavg: () => load,
      desktopApps: async () => [{ version: "simulated", path: "simulated" }],
      sleep: async () => {},
    },
  };
}

// Live dependencies -----------------------------------------------------------------

const MCP_PROTOCOL_VERSION = "2025-06-18";

/** An MCP client that calls the service as the thread whose shell runs this script. */
export function mcpClient({ url, authorization, fetchImpl = fetch }) {
  let sessionId = null;
  let id = 0;
  const post = async (body) => {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization,
        "mcp-protocol-version": MCP_PROTOCOL_VERSION,
        ...(sessionId === null ? {} : { "mcp-session-id": sessionId }),
      },
      body: JSON.stringify(body),
    });
    sessionId = response.headers.get("mcp-session-id") ?? sessionId;
    const text = await response.text();
    if (body.id === undefined) return undefined;
    if (!response.ok) throw new Error(`MCP ${body.method} answered HTTP ${response.status}`);
    const type = response.headers.get("content-type") ?? "";
    const payload = type.includes("text/event-stream")
      ? text
          .split("\n")
          .filter((row) => row.startsWith("data:"))
          .map((row) => row.slice(5).trim())
          .filter((row) => row.startsWith("{"))
          .map((row) => JSON.parse(row))
          .find((message) => message.id === body.id)
      : JSON.parse(text);
    if (payload?.error) throw new Error(payload.error.message ?? `MCP ${body.method} failed`);
    return payload?.result;
  };
  return {
    async initialize() {
      const result = await post({
        jsonrpc: "2.0",
        id: ++id,
        method: "initialize",
        params: {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "iphone-mirroring-check", version: "1" },
        },
      });
      await post({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
      return result?.serverInfo;
    },
    async call(name, args) {
      const result = await post({
        jsonrpc: "2.0",
        id: ++id,
        method: "tools/call",
        params: { name, arguments: args },
      });
      const content = result?.content ?? [];
      const text = content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n");
      if (result?.isError) throw new Error(text || `${name} failed`);
      let data = result?.structuredContent;
      if (data === undefined) {
        try {
          data = JSON.parse(text);
        } catch {
          data = {};
        }
      }
      const image = content.find((part) => part.type === "image")?.data;
      return { data, image };
    },
  };
}

const run = (file, args, input) =>
  NodeChildProcess.execFileSync(file, args, { encoding: "utf8", timeout: 20_000, input }).trim();

const WINDOW_SCRIPT = `
ObjC.import("CoreGraphics");
ObjC.import("AppKit");
function run(argv) {
  var apps = $.NSRunningApplication.runningApplicationsWithBundleIdentifier(argv[0]);
  var pids = {};
  for (var a = 0; a < apps.count; a++) pids[String(apps.objectAtIndex(a).processIdentifier)] = true;
  var list = ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo(1 | 16, 0))) || [];
  var found = null;
  for (var i = 0; i < list.length && found === null; i++) {
    var w = list[i];
    var b = w.kCGWindowBounds || {};
    if (pids[String(w.kCGWindowOwnerPID)] === true && Number(w.kCGWindowLayer) === 0 && Number(b.Width) > 100) {
      found = { x: Number(b.X), y: Number(b.Y), width: Number(b.Width), height: Number(b.Height) };
    }
  }
  var main = $.NSScreen.screens.objectAtIndex(0).frame.size;
  return JSON.stringify({ window: found, main: { width: Number(main.width), height: Number(main.height) } });
}`;

const OCR_SCRIPT = `
ObjC.import("Foundation");
ObjC.import("Vision");
function run(argv) {
  var handler = $.VNImageRequestHandler.alloc.initWithURLOptions($.NSURL.fileURLWithPath(argv[0]), $({}));
  var request = $.VNRecognizeTextRequest.alloc.init;
  request.recognitionLevel = 0;
  request.usesLanguageCorrection = false;
  if (!handler.performRequestsError($([request]), $())) return JSON.stringify({ lines: [] });
  var results = request.results;
  var lines = [];
  for (var i = 0; i < results.count; i++) {
    var top = results.objectAtIndex(i).topCandidates(1);
    if (top.count === 0) continue;
    var box = results.objectAtIndex(i).boundingBox;
    lines.push({ text: top.objectAtIndex(0).string.js, x: Number(box.origin.x), y: Number(box.origin.y), width: Number(box.size.width), height: Number(box.size.height) });
  }
  return JSON.stringify({ lines: lines });
}`;

const DESKTOP_APPS_SCRIPT = `
ObjC.import("AppKit");
function run() {
  var apps = $.NSWorkspace.sharedWorkspace.runningApplications;
  var found = [];
  for (var i = 0; i < apps.count; i++) {
    var app = apps.objectAtIndex(i);
    var id = app.bundleIdentifier;
    var name = app.localizedName;
    var ours = (id && !id.isNil() && id.js === "com.specweave.studio") || (name && !name.isNil() && name.js === "SpecWithCode");
    if (!ours || app.bundleURL.isNil()) continue;
    var bundle = $.NSBundle.bundleWithURL(app.bundleURL);
    var version = bundle.isNil() ? null : bundle.objectForInfoDictionaryKey("CFBundleShortVersionString");
    found.push({ path: app.bundleURL.path.js, version: version && !version.isNil() ? version.js : "unknown" });
  }
  return JSON.stringify(found);
}`;

/** Converts a window in display points to screenshot pixels, and says whether it is on the main display. */
export function windowInScreenshot(found, main, size) {
  if (found === null || found === undefined) return undefined;
  const scale = size.width / main.width;
  const onMainDisplay =
    found.x >= 0 &&
    found.y >= 0 &&
    found.x + found.width <= main.width &&
    found.y + found.height <= main.height;
  return {
    onMainDisplay,
    window: {
      x: Math.round(found.x * scale),
      y: Math.round(found.y * scale),
      width: Math.round(found.width * scale),
      height: Math.round(found.height * scale),
    },
  };
}

/** Maps Vision's bottom-left, normalized boxes inside a region to screenshot pixels. */
export function regionToScreenshot(lines, region) {
  return lines.map((line) => ({
    text: line.text,
    x: Math.round(region.x + line.x * region.width),
    y: Math.round(region.y + (1 - line.y - line.height) * region.height),
    width: Math.round(line.width * region.width),
    height: Math.round(line.height * region.height),
  }));
}

export async function liveDeps({ client, scratch, saveScreenshots, outDir }) {
  const { default: sharp } = await import("sharp");
  let shots = 0;
  return {
    call: (tool, args) => client.call(tool, args),
    window: async (size) => {
      const answer = JSON.parse(
        run("/usr/bin/osascript", ["-l", "JavaScript", "-e", WINDOW_SCRIPT, MIRRORING_BUNDLE_ID]),
      );
      return windowInScreenshot(answer.window, answer.main, size);
    },
    ocr: async (image, region) => {
      const source = Buffer.from(image, "base64");
      const meta = await sharp(source).metadata();
      const left = Math.max(0, region.x);
      const top = Math.max(0, region.y);
      const clipped = {
        x: left,
        y: top,
        width: Math.min(region.width, meta.width - left),
        height: Math.min(region.height, meta.height - top),
      };
      if (clipped.width <= 0 || clipped.height <= 0) return [];
      const file = NodePath.join(scratch, `window-${++shots}.png`);
      await sharp(source)
        .extract({ left: clipped.x, top: clipped.y, width: clipped.width, height: clipped.height })
        .resize({ width: clipped.width * 2 })
        .png()
        .toFile(file);
      if (saveScreenshots)
        NodeFS.copyFileSync(file, NodePath.join(outDir, NodePath.basename(file)));
      const answer = JSON.parse(
        run("/usr/bin/osascript", ["-l", "JavaScript", "-e", OCR_SCRIPT, file]),
      );
      return regionToScreenshot(answer.lines, clipped);
    },
    loadavg: () => NodeOS.loadavg()[0],
    desktopApps: async () =>
      JSON.parse(run("/usr/bin/osascript", ["-l", "JavaScript", "-e", DESKTOP_APPS_SCRIPT])),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}

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
    else if (flag === "--ios") options.ios = value();
    else if (flag === "--miss") options.miss = Number(value());
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
  const startLoad = NodeOS.loadavg()[0];
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
    if (!printed.some((line) => line.startsWith("Load (1 min) at start"))) {
      end.push(`Load (1 min) at start: ${Math.round(startLoad * 100) / 100}`);
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
