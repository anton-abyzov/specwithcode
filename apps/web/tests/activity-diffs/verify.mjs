// Build first: vp build --config apps/web/tests/activity-diffs/vite.config.ts
// Supply the installed Playwright entry via STUDIO_PLAYWRIGHT_MODULE. Always headless.
// Usage: node apps/web/tests/activity-diffs/verify.mjs /absolute/owned/output-dir
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
process.env.PWDEBUG = "0";
process.env.PLAYWRIGHT_HTML_OPEN = "never";
const output = process.argv[2];
if (!output || !NodePath.isAbsolute(output)) {
  console.error("Usage: node apps/web/tests/activity-diffs/verify.mjs /absolute/output-dir");
  process.exit(2);
}
const { chromium } = await import(NodeURL.pathToFileURL(process.env.STUDIO_PLAYWRIGHT_MODULE).href);
const root = NodePath.resolve(".artifacts/activity-diffs/site");
await NodeFSP.mkdir(output, { recursive: true });
const MIME = {
  ".js": "text/javascript",
  ".css": "text/css",
  ".woff2": "font/woff2",
  ".wasm": "application/wasm",
  ".json": "application/json",
};
const server = NodeHttp.createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, "http://localhost").pathname;
    const file = NodePath.resolve(root, `.${pathname === "/" ? "/index.html" : pathname}`);
    if (!file.startsWith(`${root}${NodePath.sep}`)) {
      res.writeHead(403).end();
      return;
    }
    const body = await NodeFSP.readFile(file);
    res.writeHead(200, { "Content-Type": MIME[NodePath.extname(file)] ?? "text/html" });
    res.end(body);
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({
  headless: true,
  ...(process.env.STUDIO_CHROMIUM_EXECUTABLE
    ? { executablePath: process.env.STUDIO_CHROMIUM_EXECUTABLE }
    : {}),
});

const REPO = "/Users/anton/Projects/atlas";
const MOVED = "/Users/anton/.worktrees/atlas-flush";
const SUBAGENT = "Explore the flush timer";
const LEVELS = ["concise", "normal", "verbose"];
const VIEWPORTS = [
  [1280, 900],
  [720, 900],
  [390, 844],
];
const REFERENCES = [
  {
    name: "sed",
    thread: "thread-ref-sed",
    row: '[data-v2-item-type="command_execution"]',
    text: "sed -n 240,500p packages/core/src/chat/streaming.ts",
  },
  {
    name: "read-skill",
    thread: "thread-ref-read",
    row: '[data-v2-item-type="dynamic_tool"]',
    text: "SKILL.md",
  },
  {
    name: "brief",
    thread: "thread-ref-brief",
    row: '[data-v2-item-type="file_change"]',
    text: "brief.md",
  },
  {
    name: "group",
    thread: "thread-ref-group",
    row: "[data-tool-group-header]",
    text: "Ran 24 commands, changed 3 files, and performed 5 other actions",
  },
  {
    name: "thinking",
    thread: "thread-ref-thinking",
    row: '[data-v2-item-type="reasoning"]',
    text: "The interval change touches the policy",
  },
];

const checks = [];
const started = Date.now();
function check(name, pass, observed, { ac, screenshot } = {}) {
  checks.push({
    name,
    ac,
    pass: Boolean(pass),
    observed,
    ...(screenshot ? { screenshot } : {}),
  });
  const at = `${Math.round((Date.now() - started) / 1000)}s`;
  console.log(`${pass ? "pass" : "FAIL"}  ${name} (${at})${pass ? "" : `\n      ${observed}`}`);
}
const sha256 = (text) => NodeCrypto.createHash("sha256").update(text, "utf8").digest("hex");
const clean = (text) => (text ?? "").replace(/\s+/g, " ").trim();

// ---------------------------------------------------------------------------
// Page helpers
// ---------------------------------------------------------------------------

async function load(page, query) {
  await page.goto(`${origin}/?${query}`);
  await page.locator("main[data-thread]").waitFor();
  await page.locator(".messages-timeline-scroll").waitFor();
  await page.waitForTimeout(600);
}

const list = (page) => page.locator(".messages-timeline-scroll");

/** Walks the virtualized list from the top, calling `visit` at each position. */
async function scan(page, visit) {
  await list(page).evaluate((el) => el.scrollTo({ top: 0 }));
  await page.waitForTimeout(250);
  for (let step = 0; step < 120; step += 1) {
    if ((await visit()) === "stop") return;
    const moved = await list(page).evaluate((el) => {
      const before = el.scrollTop;
      el.scrollTop = before + Math.max(120, el.clientHeight * 0.75);
      return el.scrollTop !== before;
    });
    await page.waitForTimeout(140);
    if (!moved) {
      await visit();
      return;
    }
  }
}

async function toEnd(page) {
  for (let i = 0; i < 4; i += 1) {
    await list(page).evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
    await page.waitForTimeout(200);
  }
}

/** The first mounted match, scrolled into the middle of the list; scans the list to mount it. */
async function find(page, selector, text) {
  const locate = () => {
    const base = page.locator(selector);
    return text ? base.filter({ hasText: text }) : base;
  };
  if ((await locate().count()) === 0) {
    await scan(page, async () => ((await locate().count()) > 0 ? "stop" : undefined));
  }
  const found = locate().first();
  if ((await locate().count()) === 0) return null;
  await found.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await page.waitForTimeout(250);
  return locate().first();
}

const CLOSED_FOLDS =
  '[data-timeline-row-kind="turn-fold"] button[aria-expanded="false"], [data-tool-group-header][aria-expanded="false"]';

/** Opens every folded turn and tool group, as a reader would. */
async function unfoldAll(page) {
  for (let pass = 0; pass < 2; pass += 1) {
    let clicked = 0;
    await scan(page, async () => {
      for (let i = 0; i < 12; i += 1) {
        const closed = page.locator(CLOSED_FOLDS).filter({ visible: true });
        if ((await closed.count()) === 0) break;
        await closed.first().click();
        clicked += 1;
        await page.waitForTimeout(160);
      }
    });
    if (clicked === 0) break;
  }
}

/** Opens or closes an item row; the row itself is the toggle, its buttons are its actions. */
async function toggleRow(row) {
  if (!row) return;
  await row.click({ position: { x: 12, y: 12 } });
  await row.page().waitForTimeout(400);
}

async function closeDiff(page) {
  await page.evaluate(() => window.__fixture.closeDiff?.());
  await page.locator("[data-diff-panel]").waitFor({ state: "detached" });
  await page.waitForTimeout(150);
}

const panel = (page) => page.locator("[data-diff-panel]");

/** Waits until the DiffPanel's text contains `text`; returns the panel's text either way. */
async function panelText(page, text, timeout = 6000) {
  try {
    await page.waitForFunction(
      (expected) =>
        (document.querySelector("[data-diff-panel]")?.textContent ?? "").includes(expected),
      text,
      { timeout },
    );
  } catch {}
  return clean(
    await panel(page)
      .textContent()
      .catch(() => ""),
  );
}

/** The turn header's text (turn, repository, folder, branch@HEAD, machine), unspaced. */
async function provenance(page) {
  const header = panel(page).locator('[aria-label="Turn snapshot"]');
  if ((await header.count()) === 0) return null;
  return header.evaluate((el) => (el.textContent ?? "").replace(/\s+/g, " "));
}

/** Diff files and whether each is expanded, from the panel's collapse toggles. */
async function diffFiles(page) {
  return panel(page)
    .locator('button[aria-label^="Expand "], button[aria-label^="Collapse "]')
    .evaluateAll((buttons) =>
      buttons
        .filter((b) => !/ all (files|folders)$/.test(b.getAttribute("aria-label") ?? ""))
        .map((b) => ({
          path: (b.getAttribute("aria-label") ?? "").replace(/^(Expand|Collapse) /, ""),
          expanded: b.getAttribute("aria-expanded") === "true",
        })),
    );
}

/** Checks that `path` is the one expanded file and that its header is inside the panel's view. */
async function revealed(page, path) {
  const toggle = panel(page).locator(`button[aria-label="Collapse ${path}"]`);
  try {
    await toggle.waitFor({ timeout: 5000 });
  } catch {}
  const files = await diffFiles(page);
  const expanded = files.filter((file) => file.expanded).map((file) => file.path);
  const inView =
    (await toggle.count()) > 0
      ? await toggle.evaluate((el) => {
          const r = el.getBoundingClientRect();
          const box = document.querySelector("[data-diff-panel]").getBoundingClientRect();
          return r.top >= box.top && r.bottom <= box.bottom && r.left >= box.left - 1;
        })
      : false;
  return {
    pass: expanded.length === 1 && expanded[0] === path && inView,
    observed: `expanded=${JSON.stringify(expanded)} inView=${inView} files=${files.length}`,
  };
}

/** Screenshots once running transitions (a fading minimap, a sliding panel) have finished. */
async function capture(page, path) {
  await page
    .waitForFunction(
      () =>
        document
          .getAnimations()
          .every(
            (animation) =>
              animation.playState !== "running" ||
              animation.effect?.getComputedTiming().iterations === Infinity,
          ),
      null,
      { timeout: 2000 },
    )
    .catch(() => {});
  await page.screenshot({ path });
}

/** Closes toasts left by an earlier scenario so they do not cover the next capture. */
async function dismissToasts(page) {
  const close = page.locator('button[data-slot="toast-close"]');
  for (let i = (await close.count()) - 1; i >= 0; i -= 1)
    await close
      .nth(i)
      .click({ force: true })
      .catch(() => {});
  await close
    .first()
    .waitFor({ state: "detached", timeout: 2000 })
    .catch(() => {});
}

const lastOpen = (page) => page.evaluate(() => window.__fixture.diffOpens?.at(-1) ?? null);

// AC-14: sideways scroll, clipped labels, ellipsis without the full text, actions out of reach.
// With `scope`, only that element, its contents and the boxes around it are measured.
async function measure(page, scope = null) {
  return page.evaluate((scopeSelector) => {
    const scroller = document.querySelector(".messages-timeline-scroll");
    const bounds = scroller.getBoundingClientRect();
    // Code and diff panels scroll inside themselves and are exempt.
    const EXEMPT = "pre, code, [data-inline-patch], [data-file-diff], diffs-container";
    const squash = (value) => (value ?? "").replace(/\s+/g, " ").trim();
    const shown = (el) => {
      const r = el.getBoundingClientRect();
      // Screen-reader-only text is a 1px box by design.
      if (r.width <= 1 || r.height <= 1 || r.bottom <= bounds.top || r.top >= bounds.bottom)
        return false;
      const style = getComputedStyle(el);
      return style.visibility !== "hidden" && style.display !== "none";
    };
    const rowOf = (el) =>
      el.closest(
        "[data-v2-item-type], [data-tool-group-header], [data-timeline-row-kind], [data-changed-files-state]",
      );
    const describe = (el) => {
      const row = rowOf(el) ?? el.querySelector("[data-v2-item-type], [data-tool-group-header]");
      return `${el.tagName.toLowerCase()} in "${squash((row ?? el).textContent).slice(0, 100)}"`;
    };
    let boxes;
    const target = scopeSelector ? document.querySelector(scopeSelector) : null;
    if (target) {
      const around = [];
      for (let node = target.parentElement; node && node !== scroller; node = node.parentElement)
        around.push(node);
      boxes = [target, ...target.querySelectorAll("*"), ...around].filter(
        (el) => !el.closest(EXEMPT) && shown(el),
      );
    } else {
      // Walk the list once, skipping code and diff panels and anything outside the view.
      boxes = [];
      const walker = document.createTreeWalker(scroller, NodeFilter.SHOW_ELEMENT, {
        acceptNode: (el) => {
          if (el.matches(EXEMPT)) return NodeFilter.FILTER_REJECT;
          const r = el.getBoundingClientRect();
          if (r.height > 0 && (r.bottom <= bounds.top || r.top >= bounds.bottom))
            return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        },
      });
      for (let node = walker.nextNode(); node; node = walker.nextNode())
        if (shown(node)) boxes.push(node);
    }
    const wider = (el) => el.scrollWidth > el.clientWidth + 1;
    const sideways = [scroller, ...boxes]
      .filter((el) => wider(el) && ["auto", "scroll"].includes(getComputedStyle(el).overflowX))
      .map(describe);
    // Hidden overflow and paint containment both cut what does not fit.
    const clips = (style) =>
      ["hidden", "clip"].includes(style.overflowX) || /paint|content|strict/.test(style.contain);
    const clipped = boxes
      .filter((el) => {
        const style = getComputedStyle(el);
        return (
          wider(el) &&
          clips(style) &&
          style.textOverflow !== "ellipsis" &&
          squash(el.textContent).length > 0
        );
      })
      .map((el) => {
        const edge = el.getBoundingClientRect().right;
        const past = [...el.querySelectorAll("*")].find(
          (child) =>
            child.getBoundingClientRect().right > edge + 1 &&
            child.children.length === 0 &&
            squash(child.textContent).length > 0,
        );
        // Name the row the cut text belongs to; the clipping box may hold several rows.
        return past
          ? `${describe(past)} cut by its ${el.tagName.toLowerCase()}: "${squash(past.textContent).slice(0, 80)}"`
          : describe(el);
      });
    // CSS truncation is the contract for long labels, as long as the full text is on hover.
    // A thought's preview is the start of its text, which opens in full; it is reported apart.
    const cutWithoutTitle = boxes
      .filter((el) => wider(el) && getComputedStyle(el).textOverflow === "ellipsis")
      .filter((el) => {
        const full = squash(el.closest("[title]")?.getAttribute("title"));
        const cut = squash(el.textContent).replace(/…/g, "");
        return !full || !full.includes(cut.slice(0, Math.min(24, cut.length)));
      });
    const preview = (el) => el.closest('[data-v2-item-type="reasoning"]') !== null;
    const untitled = cutWithoutTitle.filter((el) => !preview(el)).map(describe);
    const previews = cutWithoutTitle.filter(preview).map(describe);
    const actions = boxes
      .filter((el) => el.matches("button"))
      .filter((el) =>
        /^(Copy (path|paths|command|script)|Open diff|Copy full)/.test(
          el.getAttribute("aria-label") ?? el.textContent?.trim() ?? "",
        ),
      );
    const unreachable = actions
      .filter((el) => {
        const r = el.getBoundingClientRect();
        let opacity = 1;
        for (let node = el; node && node !== scroller; node = node.parentElement)
          opacity *= Number(getComputedStyle(node).opacity);
        const live = el.closest("[data-open-diff-unavailable]") !== null;
        return (
          r.left < Math.max(0, bounds.left) - 1 ||
          r.right > Math.min(innerWidth, bounds.right) + 1 ||
          opacity < 0.5 ||
          el.tabIndex < 0 ||
          (el.disabled && !live)
        );
      })
      .map(
        (el) =>
          `${el.getAttribute("aria-label") ?? squash(el.textContent)} ${describe(el)} @${Math.round(el.getBoundingClientRect().right)}`,
      );
    const doc = document.scrollingElement;
    return {
      pageOverflow: doc.scrollWidth - doc.clientWidth,
      sideways,
      clipped,
      untitled,
      previews,
      unreachable,
      actions: actions.length,
    };
  }, scope);
}

/** Measures the whole list, every position, and merges what each position found. */
async function measureList(page) {
  const found = {
    pageOverflow: 0,
    sideways: new Set(),
    clipped: new Set(),
    untitled: new Set(),
    previews: new Set(),
    unreachable: new Set(),
    actions: 0,
  };
  await scan(page, async () => {
    const m = await measure(page);
    found.pageOverflow = Math.max(found.pageOverflow, m.pageOverflow);
    for (const key of ["sideways", "clipped", "untitled", "previews", "unreachable"])
      for (const entry of m[key]) found[key].add(entry);
    found.actions = Math.max(found.actions, m.actions);
  });
  return found;
}

function layoutChecks(found, label, screenshot) {
  check(
    `AC-14 no sideways page or row scroll, ${label}`,
    found.pageOverflow <= 0 && found.sideways.size === 0,
    `page overflow ${found.pageOverflow}px; sideways scrollers: ${[...found.sideways].join(" | ") || "none"}`,
    { ac: "AC-14", screenshot },
  );
  check(
    `AC-14 every row label fits its row, ${label}`,
    found.clipped.size === 0 && found.untitled.size === 0,
    `clipped without ellipsis: ${[...found.clipped].join(" | ").slice(0, 900) || "none"}; ellipsis without full text on hover: ${[...found.untitled].join(" | ").slice(0, 600) || "none"}; thought previews cut (not counted): ${found.previews.size}`,
    { ac: "AC-14", screenshot },
  );
  check(
    `AC-14 trailing actions visible and focusable, ${label}`,
    found.unreachable.size === 0,
    `${found.unreachable.size} out of reach: ${[...found.unreachable].join(" | ").slice(0, 900) || "none"}`,
    { ac: "AC-14", screenshot },
  );
}

/**
 * From each visible row, Tab must reach that row's actions in turn. Rows are measured one at a
 * time because the list is virtualized: a row scrolled out of the window leaves the tab order.
 */
async function tabWalk(page) {
  const rows = await page.evaluate(() => {
    const scroller = document.querySelector(".messages-timeline-scroll");
    const bounds = scroller.getBoundingClientRect();
    const ACTION = /^(Copy (path|paths|command|script)|Open diff)/;
    return [...scroller.querySelectorAll("[data-v2-item-type]")]
      .filter((row) => {
        const r = row.getBoundingClientRect();
        return r.height > 0 && r.top >= bounds.top && r.bottom <= bounds.bottom;
      })
      .map((row, index) => {
        row.setAttribute("data-tab-probe", String(index));
        const head = row.firstElementChild ?? row;
        return {
          index,
          text: (row.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 80),
          actions: [...head.querySelectorAll("button")]
            .filter(
              (button) => ACTION.test(button.getAttribute("aria-label") ?? "") && !button.disabled,
            )
            .map((button) => button.getAttribute("aria-label")),
        };
      })
      .filter((row) => row.actions.length > 0);
  });
  const missing = [];
  let actions = 0;
  for (const row of rows) {
    actions += row.actions.length;
    const probe = page.locator(`[data-tab-probe="${row.index}"]`);
    if ((await probe.count()) === 0) {
      missing.push(`${row.text}: row left the list`);
      continue;
    }
    await probe.focus();
    // Tab until focus leaves the row; other focusable controls in the row may come first.
    const reached = [];
    for (let i = 0; i < row.actions.length + 8; i += 1) {
      await page.keyboard.press("Tab");
      const label = await page.evaluate(
        (index) =>
          document.activeElement?.closest(`[data-tab-probe="${index}"]`)
            ? (document.activeElement.getAttribute("aria-label") ?? "")
            : null,
        row.index,
      );
      if (label === null) break;
      if (row.actions.includes(label)) reached.push(label);
    }
    if (JSON.stringify(reached) !== JSON.stringify(row.actions))
      missing.push(
        `${row.text}: expected ${row.actions.join(", ")}; Tab reached ${reached.join(", ")}`,
      );
  }
  return { rows: rows.length, actions, missing };
}

/** Failure counts on a fold or group header: the strong count and the faint ones. */
async function counts(scope) {
  return scope.evaluate((el) => {
    const failed = el.querySelector("[data-failed-count]");
    return {
      failed: (failed?.textContent ?? "").trim(),
      strong:
        failed !== null &&
        failed.className.includes("text-tool-error-icon") &&
        Number(getComputedStyle(failed).opacity) === 1,
      faint: [...el.querySelectorAll("[data-faint-count]")].map((node) => ({
        text: (node.textContent ?? "").trim(),
        muted: node.className.includes("text-muted-foreground"),
      })),
    };
  });
}

function countsMatch(observed) {
  return (
    observed.failed === "1 failed" &&
    observed.strong &&
    observed.faint.map((f) => f.text).join(",") === "1 possible failure,1 declined" &&
    observed.faint.every((f) => f.muted)
  );
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

async function activityLevel(page, ctx, level) {
  const tag = `${level} ${ctx.theme} ${ctx.width}`;
  const shot = (name) => NodePath.join(output, `${name}-${level}-${ctx.theme}-${ctx.width}.png`);
  await load(page, `thread=thread-activity&theme=${ctx.theme}&detail=${level}`);
  await capture(page, shot("activity"));

  // AC-10/AC-15: the folded turn names every failure it holds, at full strength.
  const fold = await find(
    page,
    '[data-timeline-row-kind="turn-fold"]',
    level === "concise" ? "1 failed" : "Worked for 1m",
  );
  const foldCounts = fold ? await counts(fold) : null;
  check(
    `AC-15 fold failure counts, ${tag}`,
    foldCounts && countsMatch(foldCounts),
    JSON.stringify(foldCounts),
    { ac: "AC-15", screenshot: shot("activity") },
  );

  await unfoldAll(page);
  const layout = await measureList(page);
  await find(page, '[data-v2-item-type="file_change"]', "streaming.ts");
  await capture(page, shot("activity-rows"));
  layoutChecks(layout, `activity ${tag}`, shot("activity-rows"));

  // Group header, chips, edit rows and cards across the whole list.
  const seen = { groups: new Map(), chips: new Map(), edits: new Map(), cards: new Map() };
  await scan(page, async () => {
    const snapshot = await page.evaluate(() => {
      const squash = (value) => (value ?? "").replace(/\s+/g, " ").trim();
      return {
        groups: [...document.querySelectorAll("[data-tool-group-header]")]
          .filter((el) => el.querySelector("[data-failed-count]"))
          .map((el) => ({
            key: squash(el.getAttribute("aria-label") ?? el.textContent).slice(0, 60),
            failed: squash(el.querySelector("[data-failed-count]").textContent),
            strong: el
              .querySelector("[data-failed-count]")
              .className.includes("text-tool-error-icon"),
            faint: [...el.querySelectorAll("[data-faint-count]")].map((n) => squash(n.textContent)),
          })),
        chips: [...document.querySelectorAll("[data-outcome-chip]")].map((el) => ({
          key: squash(el.closest("[data-v2-item-type]")?.textContent).slice(0, 60),
          kind: el.getAttribute("data-outcome-chip"),
          text: squash(el.textContent),
        })),
        edits: [...document.querySelectorAll('[data-v2-item-type="file_change"]')].map((el) => {
          const button = el.querySelector('button[aria-label^="Open diff"]');
          return {
            key: squash(el.querySelector("[data-row-path]")?.textContent ?? el.textContent).slice(
              0,
              80,
            ),
            openDiff: button !== null && !button.disabled,
          };
        }),
        cards: [...document.querySelectorAll("[data-changed-files-state]")].map((el) => ({
          key: squash(el.querySelector("[data-changed-files-header]")?.textContent).slice(0, 120),
          state: el.getAttribute("data-changed-files-state"),
          openDiff:
            el.querySelector('[data-changed-files-header] button[aria-label^="Open diff"]') !==
            null,
          text: squash(el.textContent),
        })),
      };
    });
    for (const key of ["groups", "chips", "edits", "cards"])
      for (const entry of snapshot[key]) seen[key].set(entry.key, entry);
  });
  const groups = [...seen.groups.values()];
  check(
    `AC-15 group header failure counts, ${tag}`,
    groups.length === 1 &&
      groups[0].failed === "1 failed" &&
      groups[0].strong &&
      groups[0].faint.join(",") === "1 possible failure,1 declined",
    JSON.stringify(groups),
    { ac: "AC-15", screenshot: shot("activity-rows") },
  );
  const chips = [...seen.chips.values()].map((chip) => `${chip.kind}:${chip.text}`).toSorted();
  check(
    `AC-15 failed, declined and stopped rows keep their chip, ${tag}`,
    JSON.stringify(chips) ===
      JSON.stringify(["declined:declined", "failed:exit 1", "stopped:stopped"]),
    JSON.stringify(chips),
    { ac: "AC-15", screenshot: shot("activity-rows") },
  );
  const edits = [...seen.edits.values()];
  check(
    `AC-15 every edit row keeps Open diff, ${tag}`,
    edits.length === 4 && edits.every((edit) => edit.openDiff),
    JSON.stringify(edits),
    { ac: "AC-15", screenshot: shot("activity-rows") },
  );
  const cards = [...seen.cards.values()];
  const expectedState = level === "concise" ? "summary" : "tree";
  check(
    `AC-15 two turn cards (none for the read-only turn), each with Open diff, ${tag}`,
    cards.length === 2 && cards.every((card) => card.openDiff && card.state === expectedState),
    JSON.stringify(cards.map(({ key, state, openDiff }) => ({ key, state, openDiff }))),
    { ac: "AC-15", screenshot: shot("activity-rows") },
  );
  const turn2Card = cards.find((card) => card.key.includes("7 changed files"));
  const turn3Card = cards.find((card) => card.key.includes("2 changed files"));
  if (level === "concise") {
    check(
      `AC-15 Concise card counts not-from-edit-tool files, failures and the subagent, ${tag}`,
      turn2Card?.key.includes("+1 not from edit tools") &&
        turn2Card?.key.includes("1 failed") &&
        turn3Card?.key.includes(`1 by subagent ${SUBAGENT}`),
      JSON.stringify([turn2Card?.key, turn3Card?.key]),
      { ac: "AC-15", screenshot: shot("activity-rows") },
    );
  } else {
    check(
      `AC-19 loaded subagent's file listed under it, not under not-reported, ${tag}`,
      turn3Card?.text.includes(`Edited by subagent ${SUBAGENT}`) &&
        turn2Card?.text.includes("not reported by an edit tool"),
      JSON.stringify([turn2Card?.text.slice(0, 300), turn3Card?.text.slice(0, 300)]),
      { ac: "AC-19", screenshot: shot("activity-rows") },
    );
  }

  // Open diff from the multi-file edit row, by keyboard: the exact run and path, the header,
  // and the file revealed and expanded even though the setting collapses files.
  const row = await find(page, '[data-v2-item-type="file_change"]', "streaming.ts");
  const button = row?.locator('button[aria-label="Open diff"]').first();
  if (button) {
    await button.focus();
    await page.keyboard.press("Enter");
  }
  const header = await (async () => {
    await panelText(page, "Turn 2");
    return provenance(page);
  })();
  const open = await lastOpen(page);
  check(
    `AC-04 edit row Open diff carries thread, run and path, ${tag}`,
    open?.runId === "thread-activity:run-2" &&
      open?.filePath === `${REPO}/packages/core/src/chat/streaming.ts` &&
      open?.sourceThreadId === "thread-activity",
    JSON.stringify(open),
    { ac: "AC-04" },
  );
  const provenanceShot = shot("opendiff-row");
  const reveal = await revealed(page, "packages/core/src/chat/streaming.ts");
  await capture(page, provenanceShot);
  check(
    `AC-15 DiffPanel header shows turn, repository, folder, branch@HEAD and machine, ${tag}`,
    header !== null &&
      ["Turn 2", "atlas", REPO, "feat/stream-flush@4f1c2e9", "MacBook M4"].every((part) =>
        header.replace(/ /g, "").includes(part.replace(/ /g, "")),
      ),
    header ?? "no Turn snapshot header",
    { ac: "AC-15", screenshot: provenanceShot },
  );
  check(`AC-04 revealed file is expanded and in view, ${tag}`, reveal.pass, reveal.observed, {
    ac: "AC-04",
    screenshot: provenanceShot,
  });
  await closeDiff(page);

  // The card header's Open diff on the stopped turn opens that turn.
  const card = await find(page, "[data-changed-files-state]", "2 changed files");
  await card
    ?.locator('[data-changed-files-header] button[aria-label^="Open diff"]')
    .first()
    .click();
  const cardText = await panelText(page, "Turn 3");
  const cardOpen = await lastOpen(page);
  // Capture once the turn's files have rendered, not the loading skeleton.
  await panel(page)
    .locator('button[aria-label^="Expand "], button[aria-label^="Collapse "]')
    .first()
    .waitFor({ timeout: 5000 })
    .catch(() => {});
  const cardFiles = (await diffFiles(page)).map((file) => file.path);
  const cardShot = shot("opendiff-card");
  await capture(page, cardShot);
  check(
    `AC-04 card Open diff opens its own turn, ${tag}`,
    cardOpen?.runId === "thread-activity:run-3" &&
      cardOpen?.sourceThreadId === "thread-activity" &&
      cardText.includes("Turn 3") &&
      cardFiles.some((path) => path.endsWith("flushTimer.ts")),
    `${JSON.stringify(cardOpen)} files=${JSON.stringify(cardFiles)} panel="${cardText.slice(0, 160)}"`,
    { ac: "AC-04", screenshot: cardShot },
  );
  await closeDiff(page);
}

async function linkSources(page, ctx) {
  const tag = `normal ${ctx.theme} ${ctx.width}`;
  const shot = (name) => NodePath.join(output, `${name}-${ctx.theme}-${ctx.width}.png`);
  await load(page, `thread=thread-activity&theme=${ctx.theme}&detail=normal`);
  await unfoldAll(page);

  // AC-04 from a card row and from a "not reported by an edit tool" row.
  for (const [name, cardHeader, fileName, runId, path] of [
    ["card-row", "7 changed files", "streaming.md", "thread-activity:run-2", "docs/streaming.md"],
    [
      "not-reported-row",
      "7 changed files",
      "bufferedWriter.ts",
      "thread-activity:run-2",
      "packages/client-runtime/src/stream/bufferedWriter.ts",
    ],
  ]) {
    const card = await find(page, "[data-changed-files-state]", cardHeader);
    const expand = card?.locator('button[aria-label="Expand all folders"]');
    if (expand && (await expand.count())) await expand.first().click();
    await page.waitForTimeout(200);
    const target = card
      ?.locator(
        name === "not-reported-row"
          ? '[data-changed-files-section="not-reported"] button'
          : "button",
      )
      .filter({ hasText: fileName })
      .first();
    if (target && (await target.count())) await target.click();
    else check(`AC-04 ${name} found, ${tag}`, false, `no ${fileName} row`, { ac: "AC-04" });
    await panelText(page, "Turn 2");
    const open = await lastOpen(page);
    const reveal = await revealed(page, path);
    await capture(page, shot(`opendiff-${name}`));
    check(
      `AC-04 ${name} Open diff reveals ${path}, ${tag}`,
      open?.runId === runId && open?.filePath?.endsWith(path) && reveal.pass,
      `${JSON.stringify(open)} ${reveal.observed}`,
      { ac: "AC-04", screenshot: shot(`opendiff-${name}`) },
    );
    await closeDiff(page);
  }

  // AC-04 from the inspector of the opened long-path edit row.
  const editRow = await find(page, '[data-v2-item-type="file_change"]', "BackpressureHint");
  await toggleRow(editRow);
  await page.waitForTimeout(500);
  const inspectorButton = editRow
    ?.locator("button")
    .filter({ hasText: /^Open diff$/ })
    .filter({ visible: true });
  const buttons = inspectorButton ? await inspectorButton.count() : 0;
  if (buttons > 1) await inspectorButton.nth(1).click();
  await panelText(page, "Turn 3");
  const longPath =
    "apps/web/src/components/chat/streaming/indicators/StreamingFlushIntervalIndicatorWithBackpressureHint.tsx";
  const reveal = await revealed(page, longPath);
  const open = await lastOpen(page);
  await capture(page, shot("opendiff-inspector"));
  check(
    `AC-04 inspector Open diff reveals the long-path file, ${tag}`,
    buttons > 1 && open?.runId === "thread-activity:run-3" && reveal.pass,
    `inspector buttons=${buttons} ${JSON.stringify(open)} ${reveal.observed}`,
    { ac: "AC-04", screenshot: shot("opendiff-inspector") },
  );

  // AC-04 line rule: the latest checkpointed turn, no run active, opens at the first new line.
  await panel(page).locator("[data-title]").filter({ hasText: longPath }).first().click();
  await page.waitForTimeout(300);
  const fileOpen = await page.evaluate(() => window.__fixture.fileOpens?.at(-1) ?? null);
  check(
    `AC-04 file title of the latest turn opens at its first changed line, ${tag}`,
    fileOpen?.path === longPath && fileOpen?.line === 13,
    JSON.stringify(fileOpen),
    { ac: "AC-04" },
  );
  await closeDiff(page);

  // An older turn opens today's file at the top, with the notice.
  const multi = await find(page, '[data-v2-item-type="file_change"]', "streaming.ts");
  await multi?.locator('button[aria-label="Open diff"]').first().click();
  await panelText(page, "Turn 2");
  await panel(page)
    .locator("[data-title]")
    .filter({ hasText: /^packages\/core\/src\/chat\/streaming\.ts$/ })
    .first()
    .click();
  await page.waitForTimeout(400);
  const olderOpen = await page.evaluate(() => window.__fixture.fileOpens?.at(-1) ?? null);
  const toast = await page.evaluate(() => window.__fixture.toasts?.at(-1) ?? null);
  await capture(page, shot("current-file-notice"));
  check(
    `AC-04 file title of an older turn opens the current file with the notice, ${tag}`,
    olderOpen?.path === "packages/core/src/chat/streaming.ts" &&
      olderOpen?.line === null &&
      toast?.title === "Showing the current file; it may differ from this turn",
    `${JSON.stringify(olderOpen)} ${JSON.stringify(toast)}`,
    { ac: "AC-04", screenshot: shot("current-file-notice") },
  );
  await closeDiff(page);
}

async function paging(page, ctx) {
  const tag = `${ctx.theme} ${ctx.width}`;
  const shot = (name) => NodePath.join(output, `${name}-${ctx.theme}-${ctx.width}.png`);
  await load(page, `thread=thread-activity&theme=${ctx.theme}&detail=normal`);
  await unfoldAll(page);
  const sources = await page.evaluate(() => window.__fixture.sources);

  // Command output: last page first, Load earlier, Copy full byte-equal.
  const row = await find(page, '[data-v2-item-type="command_execution"]', "stream-trace.log");
  await toggleRow(row);
  const status = row?.getByText(/^Showing last [\d,]+ of [\d,]+ characters$/);
  await status
    ?.first()
    .waitFor({ timeout: 6000 })
    .catch(() => {});
  const first = clean(
    await status
      ?.first()
      .textContent()
      .catch(() => ""),
  );
  await row?.evaluate((el) => el.scrollIntoView({ block: "start" }));
  await capture(page, shot("paged-output"));
  check(
    `AC-11 command output opens on its last page, ${tag}`,
    first === "Showing last 262,142 of 533,769 characters",
    first || "no paging status",
    { ac: "AC-11", screenshot: shot("paged-output") },
  );
  // Copy full from the last page reads every page.
  await row?.getByRole("button", { name: "Copy full output" }).first().click();
  await page
    .waitForFunction(() => (window.__fixture.copies ?? []).length > 0, null, {
      timeout: 8000,
    })
    .catch(() => {});
  const copied = await page.evaluate(() => window.__fixture.copies?.at(-1) ?? "");
  let earlier = 0;
  for (; earlier < 4; earlier += 1) {
    const load = row?.getByRole("button", { name: "Load earlier" });
    if (!load || (await load.count()) === 0) break;
    await load.first().click();
    await page.waitForTimeout(500);
  }
  const after = clean(
    await row
      ?.getByText(/^Showing /)
      .first()
      .textContent()
      .catch(() => ""),
  );
  check(
    `AC-11 Load earlier reaches the start of the output, ${tag}`,
    earlier === 2 && !/^Showing last/.test(after),
    `clicks=${earlier} status="${after}"`,
    { ac: "AC-11", screenshot: shot("paged-output") },
  );
  const pages = await page.evaluate(() =>
    (window.__fixture.turnItemPageReads ?? []).filter((read) => read.field === "output"),
  );
  check(
    `AC-11 Copy full output is byte-equal (SHA-256), ${tag}`,
    sha256(copied) === sha256(sources.traceLog),
    `copied ${copied.length} chars sha256=${sha256(copied).slice(0, 16)} source ${sources.traceLog.length} chars sha256=${sha256(sources.traceLog).slice(0, 16)}`,
    { ac: "AC-11" },
  );
  // A split pair leaves half a surrogate at a page's edge.
  const half = (char) =>
    typeof char === "string" && char.length === 1 && /[\uD800-\uDFFF]/.test(char);
  const lone = pages.filter((read) => half(read.head) || half(read.tail));
  const atEmoji = pages.filter((read) => read.head === "🚀" || read.tail === "🌊");
  check(
    `AC-11 page cuts land beside an emoji and never split it, ${tag}`,
    lone.length === 0 && atEmoji.length > 0,
    `pages=${JSON.stringify(pages.map(({ offset, end, head, tail }) => ({ offset, end, head, tail })))}`,
    { ac: "AC-11" },
  );
  await toggleRow(row);

  // Edit body over one page: first page, Load more, Copy full patch byte-equal.
  const patchRow = await find(page, '[data-v2-item-type="file_change"]', "flush-trace.json");
  await toggleRow(patchRow);
  const patchStatus = patchRow?.getByText(/^Showing [\d,]+ of [\d,]+ characters$/);
  await patchStatus
    ?.first()
    .waitFor({ timeout: 6000 })
    .catch(() => {});
  const patchFirst = clean(
    await patchStatus
      ?.first()
      .textContent()
      .catch(() => ""),
  );
  await patchRow?.evaluate((el) => el.scrollIntoView({ block: "start" }));
  await capture(page, shot("paged-patch"));
  const total = sources.largePatch.length.toLocaleString("en-US");
  check(
    `AC-11 edit body opens on its first page with Load more, ${tag}`,
    new RegExp(`^Showing [\\d,]+ of ${total} characters$`).test(patchFirst) &&
      (await patchRow?.getByRole("button", { name: "Load more" }).count()) > 0,
    patchFirst || "no paging status",
    { ac: "AC-11", screenshot: shot("paged-patch") },
  );
  const copies = await page.evaluate(() => (window.__fixture.copies ?? []).length);
  await patchRow
    ?.getByRole("button", { name: /^Copy full/ })
    .first()
    .click();
  await page
    .waitForFunction((n) => (window.__fixture.copies ?? []).length > n, copies, {
      timeout: 8000,
    })
    .catch(() => {});
  const patchCopy = await page.evaluate(() => window.__fixture.copies?.at(-1) ?? "");
  check(
    `AC-11 Copy full patch is byte-equal (SHA-256), ${tag}`,
    sha256(patchCopy) === sha256(sources.largePatch),
    `copied ${patchCopy.length} chars, source ${sources.largePatch.length} chars`,
    { ac: "AC-11" },
  );
  await toggleRow(patchRow);

  // A patch over 5,000 lines: a placeholder that keeps Open diff and Copy full.
  const lockRow = await find(page, '[data-v2-item-type="file_change"]', "pnpm-lock.yaml");
  await toggleRow(lockRow);
  const placeholder = lockRow?.locator("[data-inline-patch-placeholder]");
  await placeholder
    ?.first()
    .waitFor({ timeout: 6000 })
    .catch(() => {});
  await lockRow?.evaluate((el) => el.scrollIntoView({ block: "start" }));
  await capture(page, shot("too-large-patch"));
  const placeholderText = clean(
    await placeholder
      ?.first()
      .textContent()
      .catch(() => ""),
  );
  // Nothing is drawn under the placeholder, so it offers no page to load either.
  const lockPaging = (await lockRow?.getByRole("button", { name: "Load more" }).count()) ?? 0;
  check(
    `AC-06 a patch over 5,000 lines shows the placeholder with Open diff and Copy full, ${tag}`,
    placeholderText.includes("Too large to show here") &&
      (await lockRow?.getByRole("button", { name: /^Copy full/ }).count()) > 0 &&
      (await lockRow?.getByRole("button", { name: /^Open diff/ }).count()) > 0 &&
      lockPaging === 0,
    `${placeholderText || "no placeholder"}; Load more buttons: ${lockPaging}`,
    { ac: "AC-06", screenshot: shot("too-large-patch") },
  );
}

async function subagentLinks(page, ctx, level) {
  const tag = `${level} ${ctx.theme} ${ctx.width}`;
  const shot = (name) => NodePath.join(output, `${name}-${level}-${ctx.theme}-${ctx.width}.png`);
  await load(page, `thread=thread-flush-timer&theme=${ctx.theme}&detail=${level}`);
  await unfoldAll(page);
  const row = await find(page, '[data-v2-item-type="file_change"]', "flushTimer.ts");
  await capture(page, shot("subagent-thread"));
  await row?.locator('button[aria-label="Open diff"]').first().click();
  await page
    .waitForFunction(
      () => document.querySelector("main")?.dataset.thread === "thread-activity",
      null,
      { timeout: 5000 },
    )
    .catch(() => {});
  const text = await panelText(page, `Edited by subagent ${SUBAGENT} in turn 3`);
  const open = await lastOpen(page);
  const reveal = await revealed(page, "packages/core/src/chat/flushTimer.ts");
  await capture(page, shot("subagent-opendiff"));
  check(
    `AC-19 subagent edit opens the parent's turn with the notice, ${tag}`,
    open?.runId === "thread-activity:run-3" &&
      open?.sourceThreadId === "thread-activity" &&
      open?.attributedTo?.title === SUBAGENT &&
      (await page.locator("main").getAttribute("data-thread")) === "thread-activity" &&
      text.includes(`Edited by subagent ${SUBAGENT} in turn 3`),
    `${JSON.stringify(open)} panel="${text.slice(0, 200)}"`,
    { ac: "AC-19", screenshot: shot("subagent-opendiff") },
  );
  check(`AC-19 subagent's file revealed and expanded, ${tag}`, reveal.pass, reveal.observed, {
    ac: "AC-19",
    screenshot: shot("subagent-opendiff"),
  });
  await closeDiff(page);
}

async function subagentUnloaded(page, ctx) {
  const tag = `${ctx.theme} ${ctx.width}`;
  const shot = (name) => NodePath.join(output, `${name}-${ctx.theme}-${ctx.width}.png`);
  await load(page, `thread=thread-flush-timer&theme=${ctx.theme}&detail=normal&subagents=unloaded`);
  await unfoldAll(page);
  const row = await find(page, '[data-v2-item-type="file_change"]', "flushTimer.ts");
  const rowLinks = row ? await row.locator('button[aria-label^="Open diff"]').count() : -1;
  await toggleRow(row);
  await page.waitForTimeout(500);
  const parentLink = row
    ? await row.getByRole("button", { name: "Open parent thread" }).count()
    : 0;
  await capture(page, shot("subagent-unloaded-thread"));
  check(
    `AC-19 with the parent not loaded, the row offers the parent thread instead of a diff, ${tag}`,
    rowLinks === 0 && parentLink > 0,
    `row Open diff=${rowLinks} Open parent thread=${parentLink}`,
    { ac: "AC-19", screenshot: shot("subagent-unloaded-thread") },
  );
  await load(page, `thread=thread-activity&theme=${ctx.theme}&detail=normal&subagents=unloaded`);
  const card = await find(page, "[data-changed-files-state]", "2 changed files");
  const expand = card?.locator('button[aria-label="Expand all folders"]');
  if (expand && (await expand.count())) await expand.first().click();
  await page.waitForTimeout(200);
  const notReported = clean(
    await card
      ?.locator('[data-changed-files-section="not-reported"]')
      .textContent()
      .catch(() => ""),
  );
  const subagentSection = card
    ? await card.locator('[data-changed-files-section="subagent"]').count()
    : -1;
  await card?.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await capture(page, shot("subagent-unloaded-card"));
  check(
    `AC-19 an unloaded subagent's file stays not-reported, named in the label, ${tag}`,
    subagentSection === 0 &&
      notReported.includes(
        `May include edits by subagent ${SUBAGENT}, whose activity is not loaded here.`,
      ) &&
      notReported.includes("flushTimer.ts"),
    `subagent sections=${subagentSection} not-reported="${notReported.slice(0, 300)}"`,
    { ac: "AC-19", screenshot: shot("subagent-unloaded-card") },
  );
}

async function inherited(page, ctx) {
  const tag = `${ctx.theme} ${ctx.width}`;
  const shot = (name) => NodePath.join(output, `${name}-${ctx.theme}-${ctx.width}.png`);
  await load(page, `thread=thread-fork&theme=${ctx.theme}&detail=normal`);
  await unfoldAll(page);
  const row = await find(page, '[data-v2-item-type="file_change"]', "+3 more");
  await capture(page, shot("inherited-thread"));
  await row?.locator('button[aria-label="Open diff"]').first().click();
  await page
    .waitForFunction(
      () => document.querySelector("main")?.dataset.thread === "thread-activity",
      null,
      { timeout: 5000 },
    )
    .catch(() => {});
  await panelText(page, "Turn 2");
  const open = await lastOpen(page);
  const reveal = await revealed(page, "packages/core/src/chat/streaming.ts");
  await capture(page, shot("inherited-opendiff"));
  check(
    `AC-04 inherited row opens its source thread with the diff, ${tag}`,
    open?.threadId === "thread-fork" &&
      open?.sourceThreadId === "thread-activity" &&
      open?.runId === "thread-activity:run-2" &&
      (await page.locator("main").getAttribute("data-thread")) === "thread-activity" &&
      reveal.pass,
    `${JSON.stringify(open)} ${reveal.observed}`,
    { ac: "AC-04", screenshot: shot("inherited-opendiff") },
  );
  await closeDiff(page);
}

const STATES = [
  ["snapshot-error", "No diff: this turn's snapshot failed"],
  ["snapshot-missing", "No diff: this turn's snapshot is missing"],
  ["snapshot-stale", "No diff: this turn's snapshot is out of date"],
  ["not-git", "No diff: this folder is not a Git repository"],
  ["unrecorded-run", "No diff recorded for this turn"],
  ["other-machine", "This turn's snapshot was taken on Mac mini 2"],
  ["failed-turn", "No diff: this turn ended with an error before a snapshot was taken"],
];

async function diffStates(page, ctx) {
  const tag = `${ctx.theme} ${ctx.width}`;
  const shot = (name) => NodePath.join(output, `state-${name}-${ctx.theme}-${ctx.width}.png`);
  await load(page, `thread=thread-states&theme=${ctx.theme}&detail=normal`);
  await unfoldAll(page);
  const openFor = async (fileName) => {
    const row = await find(page, '[data-v2-item-type="file_change"]', fileName);
    const button = row?.locator('button[aria-label="Open diff"]').first();
    if (!button || (await button.count()) === 0) return false;
    await button.click();
    return true;
  };

  for (const [name, message] of STATES) {
    const opened = await openFor(`${name}.ts`);
    const text = await panelText(page, message);
    await capture(page, shot(name));
    const extra =
      name === "other-machine"
        ? ((await provenance(page)) ?? "").includes("Captured on Mac mini 2, served by MacBook M4")
        : true;
    check(
      `AC-05 ${name} reads "${message}", ${tag}`,
      opened && text.includes(message) && extra,
      `opened=${opened} panel="${text.slice(0, 220)}"`,
      { ac: "AC-05", screenshot: shot(name) },
    );
    if (opened) await closeDiff(page);
  }

  // The turn after a failed turn opens its diff; the panel lists exactly the card's files.
  await openFor("after-failed.ts");
  await panelText(page, "Turn 8");
  await page.waitForTimeout(300);
  const files = (await diffFiles(page)).map((file) => file.path).toSorted();
  await capture(page, shot("after-failed"));
  check(
    `AC-05 the turn after a failed turn opens its diff with the card's files, ${tag}`,
    JSON.stringify(files) ===
      JSON.stringify(["src/states/after-failed.ts", "src/states/failed-turn.ts"]),
    JSON.stringify(files),
    { ac: "AC-05", screenshot: shot("after-failed") },
  );
  await closeDiff(page);

  // Paths missing from the patch: one reason each, and the whitespace toggle.
  for (const [fileName, reason, screenshot] of [
    [
      "outside.md",
      "/tmp/atlas-notes/outside.md is not in this diff: outside the checkpoint folder /Users/anton/Projects/atlas",
      "missing-outside",
    ],
    [
      ".env.local",
      "is not in this diff: not in this turn's snapshot (ignored path, nested repository or reverted)",
      "missing-not-in-snapshot",
    ],
    [
      "whitespace-only.ts",
      "is not in this diff: hidden by Ignore whitespace",
      "missing-whitespace",
    ],
  ]) {
    const opened = await openFor(fileName);
    const text = await panelText(page, reason);
    await capture(page, shot(screenshot));
    check(
      `AC-05 ${fileName} names its reason, ${tag}`,
      opened && text.includes(reason),
      `opened=${opened} panel="${text.slice(0, 260)}"`,
      { ac: "AC-05", screenshot: shot(screenshot) },
    );
    if (fileName === "whitespace-only.ts" && opened) {
      await panel(page).locator("button").filter({ hasText: "Show whitespace changes" }).click();
      const reveal = await revealed(page, "src/states/whitespace-only.ts");
      await capture(page, shot("whitespace-shown"));
      check(
        `AC-05 Show whitespace changes reveals the file, ${tag}`,
        reveal.pass,
        reveal.observed,
        { ac: "AC-05", screenshot: shot("whitespace-shown") },
      );
    }
    if (opened) await closeDiff(page);
  }

  // A cut patch: the 10 MB notice, the files beyond it, and the link's reason.
  {
    const opened = await openFor("beyond-limit.ts");
    const text = await panelText(page, "Diff truncated at 10 MB");
    await capture(page, shot("size-limit"));
    check(
      `AC-05 a cut patch lists the files beyond the size limit, ${tag}`,
      opened &&
        text.includes("Diff truncated at 10 MB") &&
        text.includes("src/states/beyond-limit.ts: beyond the diff size limit") &&
        text.includes("is not in this diff: beyond the diff size limit"),
      `opened=${opened} panel="${text.slice(0, 300)}"`,
      { ac: "AC-05", screenshot: shot("size-limit") },
    );
    if (opened) await closeDiff(page);
  }

  // An unstamped checkpoint and a path from another clone: a unique suffix match, labelled.
  {
    const opened = await openFor("legacy-shim.ts");
    const text = await panelText(page, "Matched by file name");
    const reveal = await revealed(page, "atlas/src/states/legacy-shim.ts");
    await capture(page, shot("matched-by-file-name"));
    check(
      `AC-04 a unique suffix match is labelled "Matched by file name", ${tag}`,
      opened &&
        text.includes("Matched by file name: atlas/src/states/legacy-shim.ts") &&
        reveal.pass,
      `opened=${opened} ${reveal.observed} panel="${text.slice(0, 200)}"`,
      { ac: "AC-04", screenshot: shot("matched-by-file-name") },
    );
    if (opened) await closeDiff(page);
  }

  // A worktree that moved: the file opens in today's folder and the notice names both.
  {
    const opened = await openFor("moved-worktree.ts");
    await panelText(page, "Turn 12");
    const header = (await provenance(page)) ?? "";
    await panel(page)
      .locator("[data-title]")
      .filter({ hasText: "moved-worktree.ts" })
      .first()
      .click();
    await page.waitForTimeout(400);
    const toast = await page.evaluate(() => window.__fixture.toasts?.at(-1) ?? null);
    await capture(page, shot("moved-worktree"));
    check(
      `AC-09 a moved worktree diffs the stamped folder and the notice names both folders, ${tag}`,
      opened &&
        header.replace(/ /g, "").includes(MOVED) &&
        toast?.title === "Showing the current file; it may differ from this turn" &&
        String(toast?.description).includes(MOVED) &&
        String(toast?.description).includes(REPO),
      `header="${header}" toast=${JSON.stringify(toast)}`,
      { ac: "AC-09", screenshot: shot("moved-worktree") },
    );
    if (opened) await closeDiff(page);
  }

  // A running turn: the action is disabled and says why.
  {
    await dismissToasts(page);
    const row = await find(page, '[data-v2-item-type="file_change"]', "running.ts");
    const holder = row?.locator("[data-open-diff-unavailable]");
    const reason = holder && (await holder.count()) ? await holder.getAttribute("title") : null;
    const disabled =
      holder && (await holder.count()) ? await holder.locator("button").isDisabled() : false;
    await capture(page, shot("running"));
    check(
      `AC-05 a running turn's Open diff is disabled: "Diff available when the turn ends", ${tag}`,
      disabled && reason === "Diff available when the turn ends",
      `disabled=${disabled} title=${JSON.stringify(reason)}`,
      { ac: "AC-05", screenshot: shot("running") },
    );
  }
}

async function referenceRows(page, ctx, level) {
  for (const reference of REFERENCES) {
    const tag = `${reference.name} ${level} ${ctx.theme} ${ctx.width}`;
    const screenshot = NodePath.join(
      output,
      `reference-${reference.name}-${level}-${ctx.theme}-${ctx.width}.png`,
    );
    await load(page, `thread=${reference.thread}&theme=${ctx.theme}&detail=${level}`);
    await unfoldAll(page);
    await toEnd(page);
    const row = page.locator(reference.row).filter({ hasText: reference.text }).last();
    const present = (await row.count()) > 0;
    // An open group's own rows follow its header, so bring the header itself into view.
    if (present) await row.evaluate((el) => el.scrollIntoView({ block: "nearest" }));
    await page.waitForTimeout(150);
    await capture(page, screenshot);
    if (reference.name === "thinking" && level === "concise") {
      // Concise hides thinking by contract (AC-15); the row exists from Normal up.
      check(
        `AC-14 reference row ${tag} hidden by the Concise contract`,
        !present,
        present ? "thinking row shown in Concise" : "hidden",
        { ac: "AC-14", screenshot },
      );
      continue;
    }
    if (!present) {
      check(`AC-14 reference row ${tag} on one line`, false, "row not rendered", {
        ac: "AC-14",
        screenshot,
      });
      continue;
    }
    const line = await row.evaluate((el) => {
      // An item row's first child is its header line; a group header is one line itself.
      const head = el.matches("[data-tool-group-header]") ? el : (el.firstElementChild ?? el);
      const label = head.querySelector("p") ?? head;
      const lineHeight = parseFloat(getComputedStyle(label).lineHeight) || 20;
      const scroller = document.querySelector(".messages-timeline-scroll").getBoundingClientRect();
      const r = head.getBoundingClientRect();
      const lr = label.getBoundingClientRect();
      // The last line of the list is the row, not a later one.
      const lastRow = [
        ...document.querySelectorAll("[data-v2-item-type], [data-tool-group-header]"),
      ].reduce((a, b) =>
        b.getBoundingClientRect().bottom > a.getBoundingClientRect().bottom ? b : a,
      );
      return {
        lines: Math.round(lr.height / lineHeight),
        height: Math.round(r.height),
        right: Math.round(r.right),
        inside:
          r.left >= scroller.left - 1 &&
          r.right <= Math.min(scroller.right, innerWidth) + 1 &&
          r.top >= scroller.top - 1 &&
          r.bottom <= scroller.bottom + 1,
        text: (head.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 140),
        title: head.querySelector("[title]")?.getAttribute("title") ?? null,
        // The thread's last item: a group's own rows may follow its header.
        last:
          lastRow === el ||
          el.contains(lastRow) ||
          lastRow.contains(el) ||
          (el.matches("[data-tool-group-header]") &&
            el.closest("[data-timeline-row-kind]")?.contains(lastRow) === true),
      };
    });
    await row.evaluate((el) => el.setAttribute("data-reference-row", ""));
    const m = await measure(page, "[data-reference-row]");
    check(
      `AC-14 reference row ${tag} on one line, fits and ends its thread`,
      line.lines === 1 &&
        line.inside &&
        (line.last || reference.name === "group") &&
        m.pageOverflow <= 0 &&
        m.sideways.length === 0 &&
        m.clipped.length === 0 &&
        m.untitled.length === 0 &&
        m.unreachable.length === 0,
      `${JSON.stringify(line)} clipped=${JSON.stringify(m.clipped)} untitled=${JSON.stringify(m.untitled)} unreachable=${JSON.stringify(m.unreachable)}`,
      { ac: "AC-14", screenshot },
    );
  }
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

const errors = [];
try {
  for (const [width, height] of VIEWPORTS) {
    for (const theme of ["light", "dark"]) {
      const context = await browser.newContext({
        viewport: { width, height },
        reducedMotion: "reduce",
      });
      const page = await context.newPage();
      const pageErrors = [];
      page.on("pageerror", (error) => pageErrors.push(String(error).slice(0, 300)));
      await page.route("**/*", (route) =>
        route.request().url().startsWith(origin) ? route.continue() : route.abort(),
      );
      const ctx = { width, theme };
      for (const level of LEVELS) {
        await activityLevel(page, ctx, level);
        await subagentLinks(page, ctx, level);
        await referenceRows(page, ctx, level);
        // The keyboard reaches every visible row action, without a pointer.
        await load(page, `thread=thread-activity&theme=${theme}&detail=${level}`);
        await unfoldAll(page);
        await find(page, '[data-v2-item-type="file_change"]', "streaming.ts");
        const walk = await tabWalk(page);
        check(
          `AC-14 Tab reaches every visible row action, ${level} ${theme} ${width}`,
          walk.actions > 0 && walk.missing.length === 0,
          `${walk.actions} actions on ${walk.rows} rows; ${walk.missing.join(" || ") || "all reached"}`,
          { ac: "AC-14" },
        );
      }
      await linkSources(page, ctx);
      await paging(page, ctx);
      await subagentUnloaded(page, ctx);
      await inherited(page, ctx);
      await diffStates(page, ctx);
      check(
        `no page errors, ${theme} ${width}`,
        pageErrors.length === 0,
        pageErrors.join(" | ") || "none",
      );
      errors.push(...pageErrors);
      await context.close();
    }
  }
} catch (error) {
  check("verifier completed", false, String(error?.stack ?? error).slice(0, 1200));
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}

const failed = checks.filter((entry) => !entry.pass);
const receipt = {
  fixture: "apps/web/tests/activity-diffs",
  headless: true,
  createdAt: new Date().toISOString(),
  viewports: VIEWPORTS.map(([width, height]) => `${width}x${height}`),
  themes: ["light", "dark"],
  levels: LEVELS,
  passed: checks.length - failed.length,
  failed: failed.length,
  checks,
};
await NodeFSP.writeFile(
  NodePath.join(output, "receipt.json"),
  `${JSON.stringify(receipt, null, 2)}\n`,
);
console.log(
  `${checks.length - failed.length}/${checks.length} checks passed; receipt in ${output}`,
);
process.exit(failed.length === 0 ? 0 : 1);
