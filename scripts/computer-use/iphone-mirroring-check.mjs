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
//                    path, another app kept taking the front (a click on
//                    another window does), or a failed run started at a
//                    1-minute load above 48.
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
 * capitals, reads q as "ą", and confuses "!" with "l" and "¡" with "i", so the
 * letter samples avoid those and the symbols are "@" and "#".
 */
export const TYPE_SAMPLES = ["hbdt", "QHBR", "4207", "x@y#z", "hbbd"];
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
/** How often the check brings iPhone Mirroring forward, or retries, before the run is INVALID. */
export const FRONT_TRIES = 3;
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

// Text and geometry ------------------------------------------------------------

// Characters no US key types that text recognition returns for ones it does.
const LOOKALIKES = {
  а: "a",
  е: "e",
  о: "o",
  р: "p",
  с: "c",
  х: "x",
  у: "y",
  А: "A",
  В: "B",
  Е: "E",
  К: "K",
  М: "M",
  Н: "H",
  О: "O",
  Р: "P",
  С: "C",
  Т: "T",
  Х: "X",
  "¡": "i",
  "—": "-",
  "–": "-",
};
/** A reading with accents dropped and lookalikes mapped: no US key types either, so no wrong key passes. */
export const readAs = (text) =>
  Array.from(text.normalize("NFD").replace(/\p{M}/gu, ""))
    .map((char) => LOOKALIKES[char] ?? char)
    .join("");
export const normalize = (text) => readAs(text).toLowerCase().replace(/\s+/g, " ").trim();
/** Letters whose capital has the same shape, so a reading cannot tell their case. */
const SAME_SHAPE = new Set("cosvwxz");
const sameChar = (typed, read) =>
  typed === read ||
  (read !== undefined &&
    SAME_SHAPE.has(typed.toLowerCase()) &&
    typed.toLowerCase() === read.toLowerCase());
// What may follow the typed text in the field: nothing, the cursor, or
// Spotlight's inline suggestion as the run's pictures show it
// ("zQ4207- Ask Siri", "ZQZXV - Ask Siri"). Anything else may be typed text.
const NOTHING_AFTER = /^\|?$/;
const KNOWN_SUGGESTION = /^\|? ?-\s+Ask Siri$/;

/**
 * A field reading against typed text: undefined when it does not start with
 * exactly `base`; else how many digits follow (with `digits`) and what comes
 * after them: "none", "suggestion", or "other" (possibly more typed text).
 */
export function readField(reading, base, digits = false) {
  const read = Array.from(readAs(reading));
  const want = Array.from(base);
  for (let index = 0; index < want.length; index++) {
    if (!sameChar(want[index], read[index])) return undefined;
  }
  let count = 0;
  if (digits) while (/[0-9]/.test(read[want.length + count] ?? "")) count++;
  const rest = read.slice(want.length + count).join("");
  const after = NOTHING_AFTER.test(rest)
    ? "none"
    : KNOWN_SUGGESTION.test(rest)
      ? "suggestion"
      : "other";
  return { count, after };
}

/** How many digits follow `base`, when only the cursor or a known suggestion follows them. */
export function typedTail(reading, base, digits = false) {
  const field = readField(reading, base, digits);
  return field === undefined || field.after === "other" ? undefined : field.count;
}

/** Whether a reading is exactly the typed text, with only the cursor or a known suggestion after it. */
export const startsWithTyped = (reading, typed) => typedTail(reading, typed) === 0;

/** Whether a reading shows Spotlight's inline suggestion after the typed text. */
export function showsSuggestion(reading, base) {
  return readField(reading, base, true)?.after === "suggestion";
}
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

/** Whether a line sits in the tab bar's row or column. */
export function inBar(line, bar) {
  const point = center(line);
  const across = bar.axis === "row" ? point.y : point.x;
  const along = bar.axis === "row" ? point.x : point.y;
  return (
    Math.abs(across - bar.at) <= bar.half &&
    (bar.from === undefined || (along >= bar.from && along <= bar.to))
  );
}

/**
 * The words a page shows outside its tab bar: what tells one tab's page from
 * another. Without a known bar, the bottom quarter is left out.
 */
export function pageSignature(lines, window, bar) {
  const limit = window.y + window.height * 0.75;
  const onPage = (line) => (bar === undefined ? center(line).y < limit : !inBar(line, bar));
  return [
    ...new Set(
      lines
        .filter((line) => onPage(line) && !isReading(line.text))
        .map((line) => normalize(line.text))
        .filter((text) => text.length > 0),
    ),
  ];
}

/** Words that only that tab's page shows, by tab: what proves a tap landed on the named tab. */
export const DEFAULT_ANCHORS = {
  // A layout with the tabs on top may drop the page title; the rows read "Today, +0HRS".
  "World Clock": ["world clock", "today", "yesterday", "no world clocks"],
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

/**
 * The two tab labels where they line up as a tab bar does: side by side in a
 * row (at the bottom, or on top in a wider layout) or one above the other in a
 * sidebar. A bar must also hold a third of `barLabels` (Clock shows four tabs)
 * in line with them, so a page title and one tab never pass for a bar; of two
 * readings of the same label in line, the one closer to the others is the tab.
 * The bar ends just past its outer labels, so a page title further along the
 * same line stays page text. Returns { tabs: {label: line}, bar },
 * { ambiguous: true } when two different bars fit as well, or undefined.
 */
export function locateTabs(lines, labels, barLabels = labels) {
  const pair = labels.map(normalize);
  const known = [...new Set([...barLabels.map(normalize), ...pair])];
  const needed = Math.min(3, known.length);
  const [first, second] = pair.map((label) =>
    lines.filter((line) => normalize(line.text) === label),
  );
  const candidates = [];
  for (const a of first) {
    for (const b of second) {
      const ca = center(a);
      const cb = center(b);
      const size = Math.max(a.height, b.height);
      let bar;
      let rank;
      if (Math.abs(ca.y - cb.y) <= size * 0.75 && Math.abs(ca.x - cb.x) > size) {
        bar = { axis: "row", at: Math.round((ca.y + cb.y) / 2), half: size };
        rank = 1e7 + bar.at;
      } else if (
        Math.abs(ca.y - cb.y) > size &&
        (Math.abs(a.x - b.x) <= size || Math.abs(ca.x - cb.x) <= size)
      ) {
        const half = Math.round(Math.max(a.width, b.width) / 2 + size);
        bar = { axis: "column", at: Math.round((ca.x + cb.x) / 2), half };
        rank = -bar.at;
      }
      if (bar === undefined) continue;
      const along = (line) => (bar.axis === "row" ? center(line).x : center(line).y);
      const middle = (along(a) + along(b)) / 2;
      const members = [a, b];
      for (const label of known) {
        if (pair.includes(label)) continue;
        const inLine = lines
          .filter((line) => normalize(line.text) === label && inBar(line, bar))
          .sort((x, y) => Math.abs(along(x) - middle) - Math.abs(along(y) - middle));
        if (inLine.length > 0) members.push(inLine[0]);
      }
      if (members.length < needed) continue;
      // Tabs sit at an even pitch; a member far past the others is something else.
      const places = members.map(along).sort((x, y) => x - y);
      const gaps = places.slice(1).map((place, index) => place - places[index]);
      if (gaps.length > 1 && Math.max(...gaps) > 2 * Math.min(...gaps) + size) continue;
      const starts = members.map((line) => (bar.axis === "row" ? line.x : line.y));
      const ends = members.map((line) =>
        bar.axis === "row" ? line.x + line.width : line.y + line.height,
      );
      const from = Math.min(...starts) - size;
      const to = Math.max(...ends) + size;
      candidates.push({
        held: members.length,
        span: to - from,
        rank,
        tabs: { [labels[0]]: a, [labels[1]]: b },
        bar: { ...bar, from, to },
      });
    }
  }
  if (candidates.length === 0) return undefined;
  candidates.sort((x, y) => y.held - x.held || x.span - y.span || y.rank - x.rank);
  const [best, next] = candidates;
  const sameBar = (x, y) => x.axis === y.axis && Math.abs(x.at - y.at) <= x.half;
  if (
    next !== undefined &&
    next.held === best.held &&
    Math.abs(next.span - best.span) <= best.bar.half &&
    !sameBar(best.bar, next.bar)
  ) {
    return { ambiguous: true };
  }
  return { tabs: best.tabs, bar: best.bar };
}

/** Every line with where it is, for a log line that shows what the check saw. */
export const describeLines = (lines) =>
  lines
    .map((line) => `${JSON.stringify(line.text)}@(${center(line).x},${center(line).y})`)
    .join(", ") || "no text";

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
 * deps.warmUp() -> ms, optional: starts text recognition, whose first call can take a minute;
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
  // Set when another app kept taking the front: the run then proves nothing.
  let frontLost;
  const stamp = () => new Date().toISOString().slice(11, 23);
  const frontmost = async () => (deps.frontmost === undefined ? undefined : deps.frontmost());
  // Input only ever goes to iPhone Mirroring in front. Before each input call
  // the check brings it forward when another app is there (a click on another
  // window takes the front).
  const bringForward = async (tool) => {
    for (let attempt = 1; attempt <= FRONT_TRIES; attempt++) {
      const app = await frontmost();
      if (app === undefined || app === MIRRORING_APP) return;
      note(
        `${stamp()} ${app} was in front before ${tool}; bringing ${MIRRORING_APP} forward (${attempt} of ${FRONT_TRIES})`,
      );
      await deps.call("computer_open", { application: MIRRORING_APP });
      await deps.sleep(config.settleMs);
    }
    const app = await frontmost();
    if (app !== undefined && app !== MIRRORING_APP) {
      throw lose(`${app} took the front back ${FRONT_TRIES} times before ${tool}`);
    }
  };
  const lose = (reason) => {
    frontLost ??= `${reason}; keep hands off the Mac while the check runs`;
    return new Error(frontLost);
  };
  const call = async (tool, args) => {
    let result;
    if (!INPUT_TOOLS.has(tool)) result = await deps.call(tool, args);
    else {
      if (frontLost !== undefined) throw new Error(frontLost);
      for (let attempt = 1; result === undefined; attempt++) {
        await bringForward(tool);
        try {
          result = await deps.call(tool, args);
        } catch (error) {
          const message = String(error?.message);
          // Part of it may be on the phone: never send it again.
          if (message.includes(LEFT_FRONT))
            throw lose(`${MIRRORING_APP} left the front during ${tool}`);
          if (!SENT_NOTHING.some((phrase) => message.includes(phrase))) throw error;
          if (attempt >= FRONT_TRIES) {
            throw lose(`${tool} was refused ${FRONT_TRIES} times with another app in front`);
          }
          note(`${stamp()} ${tool} was refused with nothing sent (${message}); trying again`);
        }
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
  // Each step starts from a fresh, emptied search field, so what one step left
  // there never decides the next.
  const freshSearch = async () => {
    await call("computer_key", { keys: "cmd+1" });
    await deps.sleep(config.settleMs);
    await call("computer_key", { keys: "cmd+3" });
    await deps.sleep(config.settleMs);
    await call("computer_key", { keys: "backspace", repeat: CLEAR_PRESSES });
    await deps.sleep(300);
  };
  for (const sample of TYPE_SAMPLES) {
    try {
      await freshSearch();
      await call("computer_type", { text: sample });
      await deps.sleep(config.settleMs);
      seen = await look();
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
    await freshSearch();
    await call("computer_type", { text: REPEAT_BASE + REPEAT_TAIL });
    const reads = [];
    const read = async (waitMs = config.suggestMs) => {
      await deps.sleep(waitMs);
      seen = await look();
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
    const typed = await read();
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
  } catch (error) {
    check("key repeat", false, `failed: ${error.message}`);
  }

  // 4. Taps on the Clock app's tabs ------------------------------------------------
  const openApp = async (name) => {
    await freshSearch();
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
  const barLabels = options.tabs === undefined ? config.barLabels : config.tabs;
  let located = locateTabs(seen.lines, [tabA, tabB], barLabels);
  if (located === undefined || located.ambiguous) {
    // One more reading: a label text recognition missed once usually shows the next time.
    await deps.sleep(config.settleMs);
    seen = await look();
    located = locateTabs(seen.lines, [tabA, tabB], barLabels);
  }
  if (located?.ambiguous) {
    unsure(
      "tabs",
      `"${tabA}" and "${tabB}" line up in more than one place; read ${describeLines(seen.lines)}`,
    );
    return finish();
  }
  if (located === undefined) {
    const shownTabs = barLabels.filter((label) =>
      seen.lines.some((line) => normalize(line.text) === normalize(label)),
    );
    // Clock open with some tabs showing: text recognition missed the bar, not the product.
    if (shownTabs.length >= 2) {
      unsure(
        "tabs",
        `${config.clockApp} shows ${shownTabs.map((label) => `"${label}"`).join(", ")} but no tab bar holding "${tabA}" and "${tabB}" with an even pitch could be read; read ${describeLines(seen.lines)}`,
      );
      return finish();
    }
    return stop(
      "tabs",
      `could not find "${tabA}" and "${tabB}" in a tab bar with the other tabs (${barLabels.join(", ")}); read ${describeLines(seen.lines)}`,
    );
  }
  const { bar } = located;
  // Where each tab was last read; a reading that misses a label keeps the last place.
  const tabLines = { ...located.tabs };
  check(
    "tabs",
    true,
    `"${tabA}" and "${tabB}" found in ${config.clockApp}, in a ${bar.axis} at ${bar.axis === "row" ? "y" : "x"} ${bar.at}`,
  );
  const signature = (reading) => pageSignature(reading.lines, reading.window, bar);

  const tap = async (label) => {
    // Only the bar found first counts, so a page title never stands in for a missed label.
    const again = locateTabs(seen.lines, [tabA, tabB], barLabels);
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
  const anchors = tabAnchors(config);
  const anchorOf = (label, page) => anchorIn(page, anchors[label]);

  // Not counted: makes the first tab current, so every counted tap changes the page.
  const warm = await tap(tabA);
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
      // After a miss the target's page may already show; an uncounted tap on the other tab resets it.
      if (anchorOf(target, signature(seen)) !== undefined) {
        const reset = await tap(other);
        note(`reset tap on "${other}" before ${name} at (${reset.point.x}, ${reset.point.y})`);
      }
      const result = await tap(target);
      const page = signature(seen);
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

/**
 * A phone behind a Mirroring window that answers the tools the way the real one
 * should. suggestion: Spotlight shows an inline suggestion after new text, which
 * the next key call's first press removes. dropRepeat: a key repeat of N reaches
 * the phone as N - 1 presses. keepsQuery: Spotlight reopens with its last text.
 * tabsOnTop: Clock shows its tabs in a row at the top, under the status bar.
 */
export function simulatedPhone({
  missClick,
  pages: pageOverride,
  deadClicks = false,
  load = 3,
  mirroringPath = true,
  suggestion = false,
  dropRepeat = false,
  keepsQuery = false,
  tabsOnTop = false,
  // Called with the number of each input call: "refuse" puts SpecWithCode in
  // front first (the product refuses, nothing sent); "partway" sends it, then
  // reports that iPhone Mirroring left the front.
  stealFront,
} = {}) {
  const window = { x: 600, y: 100, width: 360, height: 760 };
  const display = { width: 1512, height: 982 };
  const tabY = tabsOnTop ? 140 : 820;
  const tabs = {
    "World Clock": { x: 640, y: tabY, width: 90, height: 20 },
    Alarms: { x: 740, y: tabY, width: 60, height: 20 },
    Stopwatch: { x: 840, y: tabY, width: 80, height: 20 },
    Timers: { x: 900, y: tabY, width: 50, height: 20 },
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
    // An inline suggestion shows after the text in the search field.
    inline: false,
    tab: "Stopwatch",
    scroll: 0,
    clicks: 0,
    calls: [],
  };
  const line = (text, x, y, width = 120, height = 20) => ({ text, x, y, width, height });

  const ocr = () => {
    if (state.app === "home") return [line("Clock", 640, 300), line("Settings", 760, 300)];
    if (state.app === "spotlight") {
      if (state.query === "") return [line("Search", 640, 160)];
      return [line(`${state.query}${state.inline ? "- Ask Siri" : ""}`, 640, 160)];
    }
    if (state.app === "Clock") {
      const top = tabsOnTop ? 200 : 150;
      return [
        ...pages[state.tab].map((text, index) => line(text, 620, top + index * 60)),
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

  let inputs = 0;
  const call = async (tool, args) => {
    state.calls.push(tool);
    if (
      tool !== "computer_open" &&
      tool.startsWith("computer_") &&
      tool !== "computer_screenshot"
    ) {
      const steal = stealFront?.(++inputs);
      if (steal === "refuse") state.front = "SpecWithCode";
      if (state.front !== MIRRORING_APP) {
        throw new Error(
          "Agents cannot click or type in SpecWithCode itself, so they cannot answer their own access requests.",
        );
      }
      if (steal === "partway") {
        await act(tool, args);
        state.front = "SpecWithCode";
        throw new Error(
          "iPhone Mirroring stopped being the app in front partway through, so the rest was not sent.",
        );
      }
    }
    return act(tool, args);
  };
  const act = async (tool, args) => {
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
          if (!keepsQuery) state.query = "";
          state.inline = false;
        } else if (args.keys === "backspace") {
          let presses = args.repeat ?? 1;
          if (dropRepeat && presses > 1) presses--;
          if (state.inline && presses > 0) {
            state.inline = false;
            presses--;
          }
          if (presses > 0)
            state.query = state.query.slice(0, Math.max(0, state.query.length - presses));
        } else if (args.keys === "return" && state.app === "spotlight") {
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
        if (state.app === "spotlight") {
          state.query += args.text;
          state.inline = suggestion;
        }
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
      frontmost: async () => state.front,
      loadavg: () => load,
      desktopApps: async () => [{ version: "simulated", path: "simulated" }],
      sleep: async () => {},
    },
  };
}

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
