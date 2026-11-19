// How iphone-mirroring-check.mjs reads the screen: typed text in a search
// field, tab bars, pages and scrolls, from the lines text recognition returns.

// Text and geometry ------------------------------------------------------------

// Characters no US key types that text recognition returns for ones it does.
export const LOOKALIKES = {
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
export const SAME_SHAPE = new Set("cosvwxz");
export const sameChar = (typed, read) =>
  typed === read ||
  (read !== undefined &&
    SAME_SHAPE.has(typed.toLowerCase()) &&
    typed.toLowerCase() === read.toLowerCase());
// What may follow the typed text in the field: nothing, the cursor, or one of
// Spotlight's inline suggestions the runs have shown ("zQ4207- Ask Siri",
// "hbdt - HDToday", "4207 - Open"). Anything else may be typed text, so a new
// suggestion reads UNSURE until it is added here.
export const NOTHING_AFTER = /^\|?$/;
export const SUGGESTIONS = ["Ask Siri", "HDToday", "Open"];
// The dash may come with no spaces around it ("x@y#h-Ask Siri").
export const KNOWN_SUGGESTION = new RegExp(`^\\|? ?-\\s*(?:${SUGGESTIONS.join("|")})$`);

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
export const isReading = (text) => /^[\d\s:.,]+(am|pm)?$/i.test(text.trim());

/** How often a typing step opens Spotlight again when the phone showed no Spotlight after typing. */
export const SPOTLIGHT_TRIES = 3;
/** A time of day, which changes between screenshots. */
export const isTime = (text) => /^\d{1,2}:\d{2}$/.test(text);
export const texts = (lines) =>
  lines.map((line) => normalize(line.text)).filter((text) => text !== "" && !isTime(text));
/** What a reading shows that the home screen reading did not; only times of day are left out. */
export const newTexts = (lines, home) => {
  const before = new Set(texts(home));
  return texts(lines).filter((text) => !before.has(text));
};
/** Home screen labels: words, not numbers or specks, which read the same on every screenshot. */
export const labels = (lines) => texts(lines).filter((text) => text.length > 2 && !isReading(text));
/** The share of home screen labels a reading must show again to be the home screen; text recognition misses a few. */
export const HOME_SHARE = 0.6;
/**
 * Whether a reading after typing is the home screen with no search field. Most
 * home labels must show again. New text (numbers and single characters too) is
 * the home screen's own only when `again`, a reading taken after going home
 * once more, still shows it: what a search field showed is gone from there, so
 * a field with any wrong text is judged, never taken for the home screen.
 * Without `again`, any new text keeps the reading from being the home screen.
 */
export function showsNoSpotlight(lines, home, again) {
  const before = labels(home);
  if (before.length === 0) return false;
  const now = new Set(labels(lines));
  if (before.filter((text) => now.has(text)).length < HOME_SHARE * before.length) return false;
  const extra = newTexts(lines, home);
  if (extra.length === 0) return true;
  if (again === undefined) return false;
  const stays = new Set(texts(again));
  return extra.every((text) => stays.has(text));
}

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

/**
 * Text a reading shows at the same place as the home screen reading: text of
 * other windows behind the Mirroring window's margins, which no scroll moves.
 */
export function backgroundOf(lines, home) {
  const near = (a, b) =>
    Math.abs(center(a).x - center(b).x) <= 3 && Math.abs(center(a).y - center(b).y) <= 3;
  return new Set(
    lines
      .filter((line) =>
        home.some((other) => normalize(other.text) === normalize(line.text) && near(other, line)),
      )
      .map((line) => normalize(line.text)),
  );
}

/**
 * How far text that shows in both readings moved, as the median of the
 * vertical moves, leaving out `background` (see backgroundOf).
 */
export function verticalShift(before, after, background = new Set()) {
  const once = (lines) => {
    const seen = new Map();
    for (const line of lines) {
      const key = normalize(line.text);
      if (key === "" || isReading(line.text) || background.has(key)) continue;
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
export function scrolled(before, after, window, direction, minPx, background = new Set()) {
  const shift = verticalShift(before, after, background);
  const sign = direction === "down" ? -1 : 1;
  if (shift.common >= 3) return { ok: shift.median * sign >= minPx, ...shift };
  const page = (lines) =>
    pageSignature(
      lines.filter((line) => !background.has(normalize(line.text))),
      window,
    );
  const left = page(before);
  const right = page(after);
  // A page has rows to compare: a stray reading or two is never a new page.
  const replaced = left.length >= 3 && right.length >= 3 && jaccard(left, right) < 0.4;
  return { ok: replaced, replaced, ...shift };
}
