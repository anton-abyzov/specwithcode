// Build first: vp build --config apps/web/tests/project-board/vite.config.ts
// Usage: node apps/web/tests/project-board/verify.mjs [/absolute/evidence-dir]
// Always headless. Playwright comes from STUDIO_PLAYWRIGHT_MODULE, else apps/server's
// playwright-core; STUDIO_CHROMIUM_EXECUTABLE picks a browser binary.
// Writes only board-built-*.png into the evidence folder and never removes anything there.
import * as NodeAssert from "node:assert/strict";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
process.env.PWDEBUG = "0";
process.env.PLAYWRIGHT_HTML_OPEN = "never";
const { chromium } = process.env.STUDIO_PLAYWRIGHT_MODULE
  ? await import(NodeURL.pathToFileURL(process.env.STUDIO_PLAYWRIGHT_MODULE).href)
  : NodeModule.createRequire(NodePath.resolve("apps/server/package.json"))("playwright-core");
const output = NodePath.resolve(process.argv[2] ?? ".artifacts/project-board/evidence");
await NodeFSP.mkdir(output, { recursive: true });
const root = NodePath.resolve(".artifacts/project-board/site");
const server = NodeHttp.createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, "http://localhost").pathname;
    const file = NodePath.resolve(root, `.${pathname === "/" ? "/index.html" : pathname}`);
    NodeAssert.ok(file.startsWith(root + NodePath.sep));
    res.setHeader(
      "Content-Type",
      { ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2" }[
        NodePath.extname(file)
      ] ?? "text/html",
    );
    res.end(await NodeFSP.readFile(file));
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({
  headless: true,
  ...(process.env.STUDIO_CHROMIUM_EXECUTABLE
    ? { executablePath: process.env.STUDIO_CHROMIUM_EXECUTABLE }
    : {}),
});

// The fixture's increments (mocks.tsx).
const ID = {
  blocked: "0030-search-index-rewrite",
  pausedBlocked: "0031-offline-message-queue",
  longReason: "0032-export-to-shared-drive",
  seven: "0033-weekly-usage-chart",
  pausedDone: "0034-keyboard-shortcuts",
  reviewTasks: "0029-retry-failed-sync",
  promoted: "0036-rename-threads-in-place",
  idle: "0037-notification-sounds",
  noSpec: "0038-calendar-import",
  outOfReach: "0039-dark-theme-contrast",
  done: "0020-passkey-sign-in",
  abandoned: "0019-legacy-report-format",
};

// Every failure is collected, so one run shows them all.
const failures = [];
const check = (ok, message) => {
  if (!ok) failures.push(message);
  return ok;
};
const shots = [];
/** Captures the page; the open view starts at its top unless `keepScroll`. */
async function shot(page, name, { keepScroll = false } = {}) {
  const file = NodePath.join(output, `board-built-${name}.png`);
  NodeAssert.match(NodePath.basename(file), /^board-built-[a-z0-9-]+\.png$/);
  NodeAssert.equal(NodePath.dirname(file), output);
  await page.mouse.move(0, 0);
  // Let any smooth scroll a click started settle first.
  await page.waitForTimeout(500);
  if (!keepScroll)
    await page.evaluate(() =>
      document.querySelector(".sws-board-view")?.scrollTo({ top: 0, behavior: "instant" }),
    );
  await page.waitForTimeout(100);
  await page.screenshot({ path: file });
  shots.push(file);
}

const FOLDS_KEY = "studio:project-board-folded:v1";
/** `folded` names the groups the project's board starts with folded, as a stored choice. */
async function openPage(theme, viewport, search = "", folded = null) {
  const context = await browser.newContext({
    viewport,
    locale: "en-US",
    timezoneId: "UTC",
    colorScheme: theme,
  });
  if (folded)
    await context.addInitScript(
      ([key, value]) => {
        if (localStorage.getItem(key) === null) localStorage.setItem(key, value);
      },
      [FOLDS_KEY, JSON.stringify({ "desk:atlas": folded })],
    );
  const page = await context.newPage();
  page.errors = [];
  page.on("pageerror", (error) => page.errors.push(String(error)));
  await page.goto(`${origin}/?theme=${theme}${search}`);
  return page;
}
async function closePage(page, label) {
  check(page.errors.length === 0, `${label}: page errors ${page.errors.join(" | ")}`);
  await page.context().close();
}

const group = (page, name) => page.locator(`[data-group="${name}"]`);
const groupBar = (page, name) => group(page, name).locator(".sws-group-bar");
const groupOrder = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll("[data-group]")].map((node) => node.dataset.group),
  );
const STACKED = ["blocked", "active", "review", "planned", "done"];
const SIDE_BY_SIDE = ["blocked", "planned", "active", "review", "done"];
const shownCards = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll(".sws-board-card")].map((node) => node.dataset.increment),
  );
const legendEntries = (page) => page.locator(".sws-board-legend-entry").allTextContents();
const legendEntry = (page, id) => page.locator(`.sws-board-legend-entry[data-machine="${id}"]`);
const actionOf = (page, id) => cardOf(page, id).locator(".sws-board-action").allTextContents();
const cardOf = (page, id) => page.locator(`.sws-board-card[data-increment="${id}"]`);
const cardButton = (page, id) => page.locator(`[data-board-card="${id}"]`);
const view = (page) => page.locator(".sws-board-view");
const urlIncrement = (page) => new URL(page.url()).searchParams.get("increment");
const focusedCard = (page) =>
  page.evaluate(() => document.activeElement?.getAttribute("data-board-card") ?? null);
async function waitForView(page, layout) {
  await page.locator(`.sws-board[data-view="${layout}"]`).waitFor();
  await view(page).waitFor();
}

/** Nothing scrolls sideways: the page, the list, the view, and nothing sticks out of them. */
async function noOverflow(page, label) {
  const found = await page.evaluate(() => {
    const problems = [];
    const doc = document.documentElement;
    if (doc.scrollWidth > doc.clientWidth)
      problems.push(`page ${doc.scrollWidth}>${doc.clientWidth}`);
    for (const selector of [".sws-board", ".sws-board-list", ".sws-board-view"]) {
      const box = document.querySelector(selector);
      if (!box || box.getClientRects().length === 0) continue;
      if (box.scrollWidth > box.clientWidth + 1)
        problems.push(`${selector} scrolls ${box.scrollWidth}>${box.clientWidth}`);
      const edge = box.getBoundingClientRect().right + 1;
      for (const node of box.querySelectorAll("*")) {
        if (node.closest(".sr-only")) continue;
        const rect = node.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        if (rect.right > edge)
          problems.push(
            `${selector} > ${node.tagName}.${node.className} right ${Math.round(rect.right)}>${Math.round(edge)}`,
          );
      }
    }
    return problems.slice(0, 5);
  });
  check(found.length === 0, `${label}: overflow ${found.join("; ")}`);
}

/** WCAG contrast of an element's text over what it is painted on, from computed colors. */
async function contrast(locator) {
  return locator.evaluate((element) => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    const parse = (color) => {
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = "#000";
      ctx.fillStyle = color;
      ctx.fillRect(0, 0, 1, 1);
      const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
      return [r, g, b, a / 255];
    };
    const over = (top, bottom) => [0, 1, 2].map((i) => top[i] * top[3] + bottom[i] * (1 - top[3]));
    const layers = [];
    for (let node = element; node; node = node.parentElement) {
      const color = parse(getComputedStyle(node).backgroundColor);
      if (color[3] > 0) layers.push(color);
      if (color[3] >= 1) break;
    }
    let base = [255, 255, 255];
    for (const layer of layers.toReversed()) base = over(layer, base);
    const ink = over(parse(getComputedStyle(element).color), base);
    const lum = ([r, g, b]) => {
      const c = [r, g, b].map((v) => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    };
    const [hi, lo] = [lum(ink), lum(base)].toSorted((a, b) => b - a);
    return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100;
  });
}

const headingCounts = (page) =>
  page.evaluate(() =>
    Object.fromEntries(
      [...document.querySelectorAll("[data-group]")].map((section) => [
        section.dataset.group,
        {
          heading: Number(section.querySelector(".sws-group-count")?.firstChild?.textContent),
          cards: section.querySelectorAll("[data-increment]").length,
        },
      ]),
    ),
  );

const results = [];
try {
  for (const theme of ["light", "dark"]) {
    /* The board, wide: Blocked across the top, the columns, machines, folds, actions. */
    {
      const label = `wide ${theme}`;
      const page = await openPage(theme, { width: 1440, height: 1000 });
      await cardOf(page, ID.blocked).waitFor();
      await page.waitForTimeout(250);
      // Side by side the document order is the order shown: Blocked, then the way work moves.
      check(
        JSON.stringify(await groupOrder(page)) === JSON.stringify(SIDE_BY_SIDE),
        `${label}: group order ${await groupOrder(page)}`,
      );
      check(
        (await page.locator(".sws-board-columns").getAttribute("data-layout")) === "columns",
        `${label}: side by side layout`,
      );
      const counts = await headingCounts(page);
      check(
        JSON.stringify(counts) ===
          JSON.stringify({
            blocked: { heading: 4, cards: 4 },
            planned: { heading: 3, cards: 3 },
            active: { heading: 2, cards: 2 },
            review: { heading: 2, cards: 2 },
            done: { heading: 6, cards: 6 },
          }),
        `${label}: heading counts ${JSON.stringify(counts)}`,
      );
      // The old switch and the "N blocked" heading button are gone.
      check(
        (await page.locator(".sws-board-filter, .sws-board-column-blocked").count()) === 0 &&
          !(await page.locator(".sws-board").textContent()).includes("Blocked only"),
        `${label}: the Blocked only switch is still there`,
      );
      // The band sits above the columns, and the columns share one row.
      const boxes = await page.evaluate(() =>
        Object.fromEntries(
          [...document.querySelectorAll("[data-group]")].map((node) => {
            const rect = node.getBoundingClientRect();
            return [node.dataset.group, { top: rect.top, bottom: rect.bottom, left: rect.left }];
          }),
        ),
      );
      check(
        boxes.blocked.bottom <= boxes.planned.top + 1 &&
          Math.abs(boxes.planned.top - boxes.done.top) <= 1 &&
          boxes.planned.left < boxes.active.left &&
          boxes.active.left < boxes.review.left &&
          boxes.review.left < boxes.done.left,
        `${label}: band and columns ${JSON.stringify(boxes)}`,
      );
      // A working thread moves its planned card to Active; an idle one leaves it in Planned.
      check(
        (await group(page, "active").locator(`[data-increment="${ID.promoted}"]`).count()) === 1,
        `${label}: promoted card in Active`,
      );
      check(
        (await group(page, "planned").locator(`[data-increment="${ID.idle}"]`).count()) === 1,
        `${label}: idle card in Planned`,
      );
      check(
        (await cardOf(page, ID.idle).locator('.sws-board-thread[data-tone="idle"]').count()) === 1,
        `${label}: idle thread tone`,
      );
      // Paused with every task done is stuck, and still says it is Active work.
      check(
        (await group(page, "blocked").locator(`[data-increment="${ID.pausedDone}"]`).count()) === 1,
        `${label}: paused all-done under Blocked`,
      );
      check(
        (await cardOf(page, ID.pausedDone).locator(".sws-board-card-state").textContent()) ===
          "Active",
        `${label}: a blocked card names its state`,
      );
      check(
        (await group(page, "active").locator(".sws-board-card-state").count()) === 0,
        `${label}: a card in its own column repeats its state`,
      );
      const chip = async (id) => cardOf(page, id).locator(".sws-board-chip-blocked").textContent();
      check((await chip(ID.blocked)) === "2 tasks blocked", `${label}: blocked chip`);
      check(
        (await cardOf(page, ID.blocked).locator(".sws-board-rest").count()) === 1,
        `${label}: rest can continue`,
      );
      check(
        (await chip(ID.pausedBlocked)) === "Paused + 1 task blocked",
        `${label}: paused+blocked chip`,
      );
      // Only paused: its reason line starts "Paused:", so no header says it twice.
      check(
        (await cardOf(page, ID.pausedDone).locator(".sws-board-stuck").count()) === 0 &&
          /^Paused:/.test(
            await cardOf(page, ID.pausedDone).locator(".sws-board-reason-text").textContent(),
          ),
        `${label}: paused card says Paused once`,
      );
      check(
        /^Paused: Paused until the design review/.test(
          await cardOf(page, ID.pausedBlocked)
            .locator(".sws-board-reason-text")
            .first()
            .textContent(),
        ),
        `${label}: pause reason first`,
      );
      check(
        (await cardOf(page, ID.seven).locator(".sws-board-thread").count()) === 2 &&
          (await cardOf(page, ID.seven).locator(".sws-board-thread-more").textContent()) ===
            "5 more threads",
        `${label}: seven threads fold to two`,
      );
      const marks = await page
        .locator(".sws-board-machine")
        .evaluateAll((nodes) =>
          nodes.map((node) => ({ moved: node.dataset.moved === "true", text: node.textContent })),
        );
      check(
        marks.some((mark) => mark.moved && mark.text.includes("→ ")),
        `${label}: moved thread arrow`,
      );
      for (const id of [ID.blocked, ID.pausedBlocked]) {
        const ratio = await contrast(cardOf(page, id).locator(".sws-board-chip-blocked"));
        check(ratio >= 4.5, `${label}: blocked chip contrast ${ratio} on ${id}`);
      }
      // The meter's track is one width on every card, in the band and in a column.
      const tracks = await page
        .locator(".sws-board-meter")
        .evaluateAll((nodes) => [...new Set(nodes.map((node) => Math.round(node.offsetWidth)))]);
      check(tracks.length === 1 && tracks[0] === 56, `${label}: meter widths ${tracks}`);

      // Machines: the legend names every color an edge carries, in that color.
      check(
        JSON.stringify(await legendEntries(page)) ===
          JSON.stringify([
            "All",
            "Laptop4 cards",
            "Desk3 cards",
            "Spare2 cards",
            "No thread5 cards",
          ]),
        `${label}: legend ${JSON.stringify(await legendEntries(page))}`,
      );
      const edge = cardOf(page, ID.seven).locator(".sws-board-card-edge");
      check(
        (await edge.getAttribute("aria-label")) === "Runs on Desk, Laptop and Spare",
        `${label}: edge label ${await edge.getAttribute("aria-label")}`,
      );
      const paint = (locator) =>
        locator.evaluateAll((nodes) => nodes.map((node) => getComputedStyle(node).backgroundColor));
      const edgeColors = await paint(edge.locator("span"));
      const dotColors = await paint(
        page.locator(
          ["desk", "laptop", "spare"]
            .map((id) => `.sws-board-legend-entry[data-machine="${id}"] [data-machine-dot]`)
            .join(", "),
        ),
      );
      check(
        edgeColors.length === 3 &&
          new Set(edgeColors).size === 3 &&
          edgeColors.every((color) => dotColors.includes(color)),
        `${label}: edge ${edgeColors} against legend ${dotColors}`,
      );
      // Finished work carries no edge, and a resolved thread colors nothing.
      check(
        (await group(page, "done").locator(".sws-board-card-edge").count()) === 0 &&
          (await cardOf(page, ID.longReason).locator(".sws-board-card-edge").count()) === 0,
        `${label}: an edge on finished or unheld work`,
      );

      // The action ends its row, also on a band card where the row wraps.
      const ends = await cardOf(page, ID.blocked).evaluate((node) => {
        const card = node.getBoundingClientRect();
        const action = node.querySelector(".sws-board-action").getBoundingClientRect();
        return Math.round(card.right - action.right);
      });
      check(ends >= 0 && ends <= 14, `${label}: the action sits ${ends} px from the card's right`);

      // One action a card. A thread that can be opened: open it.
      check(
        JSON.stringify(await actionOf(page, ID.blocked)) === JSON.stringify(["Open thread"]),
        `${label}: action on a card with a live thread ${await actionOf(page, ID.blocked)}`,
      );
      // Only a resolved thread: nobody holds it, so the coordinator is asked.
      check(
        (await actionOf(page, ID.longReason)).length === 1 &&
          (await actionOf(page, ID.longReason))[0] !== "Open thread",
        `${label}: action on a card with only a resolved thread ${await actionOf(page, ID.longReason)}`,
      );
      // Only a thread that cannot be reached: it may hold the work, so the request names it.
      await cardOf(page, ID.outOfReach).locator(".sws-board-action").click();
      const held = await page.evaluate(() => document.body.dataset.asked ?? "");
      check(
        held.includes(ID.outOfReach) &&
          held.includes('Check first: the thread "Check contrast in the dark theme" on Spare'),
        `${label}: the request beside an unreachable thread says ${held}`,
      );
      check(
        (await group(page, "done").locator(".sws-board-action").count()) === 0,
        `${label}: an action on finished work`,
      );
      await cardOf(page, ID.blocked).locator(".sws-board-action").click();
      check(
        (await page.evaluate(() => document.body.dataset.openedThread)) !== undefined &&
          urlIncrement(page) === null,
        `${label}: Open thread opened the view instead`,
      );
      await cardOf(page, ID.longReason).locator(".sws-board-action").click();
      check(
        (await page.evaluate(() => document.body.dataset.asked ?? "")).includes(ID.longReason),
        `${label}: the request names its increment`,
      );

      // Two pull requests: one chip, a menu, and a state only where a thread read one.
      const pulls = cardOf(page, ID.blocked).locator(".sws-board-chip-pulls");
      check((await pulls.textContent()) === "2 PRs", `${label}: pull request chip`);
      await pulls.click();
      const items = page.getByRole("menuitem");
      await items.first().waitFor();
      check(
        JSON.stringify(await items.allTextContents()) === JSON.stringify(["#812Open", "#807"]),
        `${label}: menu ${JSON.stringify(await items.allTextContents())}`,
      );
      await noOverflow(page, `${label} menu`);
      await shot(page, `pull-requests-menu-${theme}`);
      await page.keyboard.press("Escape");
      await items.first().waitFor({ state: "detached" });
      check(
        await pulls.evaluate((node) => node === document.activeElement),
        `${label}: Escape did not return focus to the chip`,
      );
      await pulls.click();
      await items.nth(1).click();
      check(
        (await page.evaluate(() => document.body.dataset.openedLink)) ===
          "https://github.com/acme/app/pull/807",
        `${label}: menu item opened ${await page.evaluate(() => document.body.dataset.openedLink)}`,
      );
      check(urlIncrement(page) === null, `${label}: the menu opened the card's view`);
      await noOverflow(page, label);
      await shot(page, `board-wide-${theme}`);

      // Narrow to one machine: every open group, counted by what it shows.
      await legendEntry(page, "laptop").click();
      await page.waitForTimeout(100);
      const narrowed = await headingCounts(page);
      check(
        JSON.stringify(narrowed) ===
          JSON.stringify({
            blocked: { heading: 1, cards: 1 },
            planned: { heading: 0, cards: 0 },
            active: { heading: 2, cards: 2 },
            review: { heading: 1, cards: 1 },
            done: { heading: 6, cards: 0 },
          }),
        `${label}: on Laptop ${JSON.stringify(narrowed)}`,
      );
      check(
        (await legendEntry(page, "laptop").getAttribute("aria-pressed")) === "true",
        `${label}: chosen machine pressed`,
      );
      check(
        (await group(page, "done").locator(".sws-board-group-note").textContent()) ===
          "Finished work is not sorted by machine. Choose All to see it.",
        `${label}: Done under a machine`,
      );
      check(
        (await contrast(legendEntry(page, "laptop"))) >= 4.5,
        `${label}: pressed entry contrast ${await contrast(legendEntry(page, "laptop"))}`,
      );
      await noOverflow(page, `${label} machine`);
      await shot(page, `machine-wide-${theme}`);
      await legendEntry(page, "no-thread").click();
      check(
        (await shownCards(page)).length === 5 && !(await shownCards(page)).includes(ID.outOfReach),
        `${label}: No thread shows ${await shownCards(page)}`,
      );
      await page.locator(".sws-board-legend-entry", { hasText: /^All$/ }).click();
      check(
        (await shownCards(page)).length === 17,
        `${label}: All shows ${await shownCards(page)}`,
      );

      // Fold a column: it becomes a rail that keeps its name and count, and stays folded on reload.
      await groupBar(page, "done").click();
      const rail = await group(page, "done").evaluate((node) => ({
        width: Math.round(node.getBoundingClientRect().width),
        height: Math.round(node.getBoundingClientRect().height),
        bar: Math.round(node.querySelector(".sws-group-bar").getBoundingClientRect().height),
        expanded: node.querySelector(".sws-group-bar").getAttribute("aria-expanded"),
        cards: node.querySelectorAll(".sws-board-card").length,
        text: node.querySelector("h3").textContent,
      }));
      check(
        rail.width === 36 &&
          rail.expanded === "false" &&
          rail.cards === 0 &&
          // The heading button is the whole rail, less the rail's own padding.
          rail.bar >= rail.height - 12 &&
          rail.text === "Done6 increments",
        `${label}: folded column ${JSON.stringify(rail)}`,
      );
      check(
        await groupBar(page, "done").evaluate((node) => node === document.activeElement),
        `${label}: folding moved focus off the heading`,
      );
      await groupBar(page, "blocked").click();
      check(
        (await group(page, "blocked").locator(".sws-board-card").count()) === 0 &&
          (await group(page, "blocked").locator("h3").textContent()) === "Blocked4 increments",
        `${label}: folded band`,
      );
      await noOverflow(page, `${label} folded`);
      await shot(page, `folded-wide-${theme}`);
      await page.reload();
      await cardOf(page, ID.promoted).waitFor();
      check(
        (await groupBar(page, "done").getAttribute("aria-expanded")) === "false" &&
          (await groupBar(page, "blocked").getAttribute("aria-expanded")) === "false" &&
          (await groupBar(page, "active").getAttribute("aria-expanded")) === "true",
        `${label}: folds after a reload`,
      );
      // A search opens every group and locks the headings; clearing it gives the folds back.
      const find = page.locator('[aria-label="Find an increment"]');
      await find.fill("search");
      await cardOf(page, ID.blocked).waitFor();
      check(
        (await groupBar(page, "blocked").getAttribute("aria-expanded")) === "true" &&
          (await groupBar(page, "blocked").getAttribute("aria-disabled")) === "true",
        `${label}: a search did not open the folded group`,
      );
      // The heading is marked disabled, so the press is sent past that mark.
      await groupBar(page, "blocked").click({ force: true });
      check(
        (await cardOf(page, ID.blocked).count()) === 1,
        `${label}: a locked heading folded its group`,
      );
      await find.fill("");
      await cardOf(page, ID.blocked).waitFor({ state: "detached" });
      check(
        (await groupBar(page, "blocked").getAttribute("aria-expanded")) === "false" &&
          (await groupBar(page, "blocked").getAttribute("aria-disabled")) === null,
        `${label}: folds after the search`,
      );
      await groupBar(page, "blocked").click();
      await groupBar(page, "done").click();
      check(
        (await page.evaluate((key) => localStorage.getItem(key), FOLDS_KEY)) === "{}",
        `${label}: unfolding everything left ${await page.evaluate((key) => localStorage.getItem(key), FOLDS_KEY)}`,
      );

      // The card's "N more" expands in place.
      await cardOf(page, ID.seven).locator(".sws-board-thread-more").click();
      check(
        (await cardOf(page, ID.seven).locator(".sws-board-thread").count()) === 7,
        `${label}: card threads expand`,
      );

      // Keyboard: Enter in search opens nothing, arrows stay in the search box.
      const search = page.locator('[aria-label="Find an increment"]');
      await search.focus();
      await page.keyboard.press("Enter");
      await page.keyboard.press("ArrowDown");
      check(
        urlIncrement(page) === null && (await view(page).count()) === 0,
        `${label}: Enter in search opened a view`,
      );
      check(
        await search.evaluate((node) => node === document.activeElement),
        `${label}: ArrowDown left the search box`,
      );
      // Arrows walk cards only from a card; with no view open they only move focus.
      const first = await group(page, "active")
        .locator("[data-board-card]")
        .first()
        .getAttribute("data-board-card");
      const second = await group(page, "active")
        .locator("[data-board-card]")
        .nth(1)
        .getAttribute("data-board-card");
      // Side by side the walk follows the screen: the band, then each column in turn.
      const lastPlanned = await group(page, "planned")
        .locator("[data-board-card]")
        .last()
        .getAttribute("data-board-card");
      await cardButton(page, lastPlanned).focus();
      await page.keyboard.press("ArrowDown");
      check(
        (await focusedCard(page)) === first,
        `${label}: ArrowDown from Planned went to ${await focusedCard(page)}`,
      );
      await cardButton(page, first).focus();
      await page.keyboard.press("ArrowDown");
      check(
        (await focusedCard(page)) === second,
        `${label}: ArrowDown moved to ${await focusedCard(page)}`,
      );
      check(urlIncrement(page) === null, `${label}: ArrowDown without a view opened one`);
      await page.keyboard.press("ArrowUp");
      check((await focusedCard(page)) === first, `${label}: ArrowUp back to the first card`);
      // Enter opens; in the split the keyboard stays on the card; Escape closes.
      await page.keyboard.press("Enter");
      await waitForView(page, "split");
      check(urlIncrement(page) === first, `${label}: Enter opened ${urlIncrement(page)}`);
      check((await focusedCard(page)) === first, `${label}: focus stays on the card in the split`);
      await page.keyboard.press("ArrowDown");
      await page.waitForFunction(
        (id) => new URL(location.href).searchParams.get("increment") === id,
        second,
      );
      check((await focusedCard(page)) === second, `${label}: ArrowDown walked to the next card`);
      // Beside the open view the board is the stacked list, in the stacked order.
      check(
        JSON.stringify(await groupOrder(page)) === JSON.stringify(STACKED) &&
          (await page.locator(".sws-board-columns").getAttribute("data-layout")) === "stack",
        `${label}: beside the view ${await groupOrder(page)}`,
      );
      // A menu's Escape closes the menu, never the view behind it.
      await cardOf(page, ID.blocked).locator(".sws-board-chip-pulls").click();
      await page.getByRole("menuitem").first().waitFor();
      await page.keyboard.press("Escape");
      await page.getByRole("menuitem").first().waitFor({ state: "detached" });
      check(urlIncrement(page) === second, `${label}: the menu's Escape closed the view`);
      await cardButton(page, second).focus();
      await page.keyboard.press("Escape");
      await page.locator(".sws-board:not([data-view])").waitFor();
      check(urlIncrement(page) === null, `${label}: Escape closed the view`);
      check(
        (await focusedCard(page)) === second,
        `${label}: Escape returned focus to ${await focusedCard(page)}`,
      );

      // A click opens the blocked card beside the board; its ring and the split sizes.
      const ringBefore = await cardOf(page, ID.blocked).evaluate(
        (node) => getComputedStyle(node).boxShadow,
      );
      await cardButton(page, ID.blocked).click();
      await waitForView(page, "split");
      check(urlIncrement(page) === ID.blocked, `${label}: click put ?increment= in the URL`);
      const ringAfter = await cardOf(page, ID.blocked).evaluate(
        (node) => getComputedStyle(node).boxShadow,
      );
      check(
        ringAfter !== "none" && ringAfter !== ringBefore,
        `${label}: open card ring ${ringAfter}`,
      );
      const sizes = await page.evaluate(() => ({
        body: document.querySelector(".sws-board").clientWidth,
        list: document.querySelector(".sws-board-list").getBoundingClientRect().width,
        view: document.querySelector(".sws-board-view").getBoundingClientRect().width,
      }));
      check(
        Math.abs(sizes.view - Math.min(500, sizes.body * 0.45)) <= 2,
        `${label}: view width ${JSON.stringify(sizes)}`,
      );
      check(sizes.list >= 320, `${label}: list width ${sizes.list}`);
      // The view: blockers with the right second action, why, threads, tasks.
      const v = view(page);
      const t18 = v.locator('.sws-board-view-blocker[data-task="T-18"]');
      const t21 = v.locator('.sws-board-view-blocker[data-task="T-21"]');
      check(
        (await t18.getByRole("button", { name: "Open that thread" }).count()) === 1,
        `${label}: T-18 opens its thread`,
      );
      check(
        (await t21
          .getByRole("button", { name: "Ask the coordinator why T-21 is blocked" })
          .count()) === 1,
        `${label}: T-21 asks the coordinator`,
      );
      check(
        (await t21.getByRole("button", { name: "Open that thread" }).count()) === 0,
        `${label}: T-21 has no thread`,
      );
      check(
        /In Active because 14 tasks are done, 2 tasks are blocked, 1 task is claimed and 3 threads are working\. Its status file still says planned\./.test(
          (await v.locator(".sws-board-view-why").textContent()).replace(/\s+/g, " "),
        ),
        `${label}: why line ${await v.locator(".sws-board-view-why").textContent()}`,
      );
      const threadMeta = (await v.locator(".sws-board-view-thread-meta").allTextContents()).join(
        " | ",
      );
      for (const words of ["holds T-18", "holds T-15", "linked, task unknown", "moved from Desk"])
        check(threadMeta.includes(words), `${label}: thread rows lack "${words}": ${threadMeta}`);
      check(
        (await v.getByRole("button", { name: "Show 14 done" }).count()) === 1,
        `${label}: Show 14 done`,
      );
      check((await v.locator(".sws-board-view-task").count()) === 10, `${label}: ten open tasks`);
      await t18.getByRole("button", { name: "Open that thread" }).click();
      check(
        (await page.evaluate(() => document.body.dataset.openedThread)) ===
          "Rebuild the search index",
        `${label}: Open that thread`,
      );
      await t21.getByRole("button", { name: "Ask the coordinator why T-21 is blocked" }).click();
      const asked = await page.evaluate(() => document.body.dataset.asked);
      check(
        /T-21/.test(asked) && /sharing permission/.test(asked) && /agent@laptop/.test(asked),
        `${label}: ask carries task, reason, who: ${asked}`,
      );
      // Enter on a control in the view is that control's own action; arrows stay put.
      const spec = v.getByRole("button", { name: "Spec file", exact: true });
      await spec.focus();
      await page.keyboard.press("ArrowDown");
      check(urlIncrement(page) === ID.blocked, `${label}: ArrowDown inside the view walked cards`);
      await page.keyboard.press("Enter");
      await page.locator("[data-viewer-path]").waitFor();
      check(
        /spec\.md$/.test(await page.locator("[data-viewer-path]").getAttribute("data-viewer-path")),
        `${label}: Enter on Spec file opened the spec`,
      );
      await page.locator("[data-viewer-path]").click();
      await noOverflow(page, `${label} open`);
      await shot(page, `open-wide-${theme}`);
      // Browser back closes it.
      await page.goBack();
      await page.locator(".sws-board:not([data-view])").waitFor();
      check(urlIncrement(page) === null, `${label}: back closed the view`);

      // Edge cases beside the board.
      for (const [id, name, expect] of [
        [
          ID.pausedBlocked,
          "paused-blocked",
          async () => {
            check(
              (await v.locator('.sws-board-view-blocker[data-kind="paused"]').count()) === 1,
              `${label}: paused box`,
            );
            check(
              (await v.locator("[data-primary]").textContent()) === "Resume",
              `${label}: Resume, not Continue`,
            );
          },
        ],
        [
          ID.outOfReach,
          "out-of-reach",
          async () => {
            await v.locator('.sws-board-view-thread-open[data-tone="unknown"]').waitFor();
            // The view's request names the thread that may still hold the work, as the card's does.
            await v.locator("[data-primary]").click();
            const asked = await page.evaluate(() => document.body.dataset.asked ?? "");
            check(
              asked.includes("Check first: the thread") && asked.includes("on Spare"),
              `${label}: the view's request beside an unreachable thread says ${asked}`,
            );
          },
        ],
        [
          ID.done,
          "done",
          async () => {
            check(
              (await v.locator("[data-primary]").count()) === 0,
              `${label}: done has no primary action`,
            );
            const why = (await v.locator(".sws-board-view-why").first().textContent()).trim();
            check(
              why === "Verified on November 12, 2026. Reviewed by reviewer-model: ship.",
              `${label}: done facts "${why}"`,
            );
          },
        ],
        [
          ID.noSpec,
          "no-spec",
          async () => {
            check(
              (await v
                .getByText("No spec yet: this increment has a folder and a title but no spec.md.")
                .count()) === 1,
              `${label}: no spec sentence`,
            );
            check(
              (await v.locator("[data-primary]").textContent()) === "Plan it with the coordinator",
              `${label}: plan it`,
            );
          },
        ],
        [
          ID.seven,
          "seven-threads",
          async () => {
            check(
              (await v.locator(".sws-board-view-thread").count()) === 5,
              `${label}: five threads first`,
            );
            await v.getByRole("button", { name: "2 more" }).click();
            check(
              (await v.locator(".sws-board-view-thread").count()) === 7,
              `${label}: seven after N more`,
            );
            check(
              (await v.locator('.sws-board-view-thread-open[data-tone="unknown"]').count()) === 1,
              `${label}: offline thread row`,
            );
            await v.locator(".sws-board-view-threads").scrollIntoViewIfNeeded();
          },
        ],
      ]) {
        await cardButton(page, id).click();
        await waitForView(page, "split");
        await page.waitForFunction(
          (want) => new URL(location.href).searchParams.get("increment") === want,
          id,
        );
        await expect();
        await noOverflow(page, `${label} ${name}`);
        await shot(page, `${name}-${theme}`, { keepScroll: name === "seven-threads" });
      }
      await closePage(page, label);
      results.push({ theme, layout: "wide" });
    }

    /* Abandoned: off the board, a link opens its view read-only. */
    {
      const label = `abandoned ${theme}`;
      const page = await openPage(
        theme,
        { width: 1440, height: 1000 },
        `&increment=${ID.abandoned}`,
      );
      await waitForView(page, "split");
      const v = view(page);
      await v.getByText("Replaced by the export to the shared drive.").waitFor();
      check(
        (await v.locator(".sws-board-view-column").textContent()) === "Abandoned",
        `${label}: column chip`,
      );
      check((await v.locator("[data-primary]").count()) === 0, `${label}: no primary action`);
      await noOverflow(page, label);
      await shot(page, `abandoned-${theme}`);
      await closePage(page, label);
    }

    /* Middle width: the view takes the panel, a Board button goes back. */
    {
      const label = `middle ${theme}`;
      const page = await openPage(theme, { width: 900, height: 1000 });
      await cardOf(page, ID.blocked).waitFor();
      await cardButton(page, ID.blocked).click();
      await waitForView(page, "full");
      check(!(await page.locator(".sws-board-list").isVisible()), `${label}: list hidden`);
      const back = page.locator(".sws-board-view-back");
      check(await back.isVisible(), `${label}: Board back button`);
      await page.waitForFunction(() =>
        document.activeElement?.classList.contains("sws-board-view-title"),
      );
      await noOverflow(page, label);
      await shot(page, `middle-${theme}`);
      await back.click();
      await page.locator(".sws-board:not([data-view])").waitFor();
      check((await focusedCard(page)) === ID.blocked, `${label}: Board returns focus to the card`);
      await closePage(page, label);
    }

    /* The phone: a stacked list, then the view in its place. */
    {
      const label = `phone ${theme}`;
      const page = await openPage(theme, { width: 390, height: 844 });
      await cardOf(page, ID.blocked).waitFor();
      check(
        JSON.stringify(await groupOrder(page)) === JSON.stringify(STACKED) &&
          (await page.locator(".sws-board-columns").getAttribute("data-layout")) === "stack",
        `${label}: stacked order ${await groupOrder(page)}`,
      );
      // The same card was 124 px tall before this redesign; a quarter less is 93.
      const height = await cardOf(page, ID.reviewTasks).evaluate((node) =>
        Math.round(node.getBoundingClientRect().height),
      );
      results.push({ label, cardHeight: height, before: 124 });
      check(height <= 93, `${label}: card height ${height} px, more than 93`);
      // The legend wraps inside the panel, and a folded group is one row.
      await noOverflow(page, label);
      await shot(page, `phone-board-${theme}`);
      await groupBar(page, "blocked").click();
      await groupBar(page, "done").click();
      const row = await groupBar(page, "blocked").evaluate((node) =>
        Math.round(node.getBoundingClientRect().height),
      );
      check(row <= 36, `${label}: folded group row ${row} px`);
      await noOverflow(page, `${label} folded`);
      await shot(page, `phone-folded-${theme}`);
      await groupBar(page, "blocked").click();
      await groupBar(page, "done").click();
      await cardButton(page, ID.blocked).click();
      await waitForView(page, "full");
      await noOverflow(page, `${label} view`);
      await shot(page, `phone-view-${theme}`);
      await closePage(page, label);
    }

    /* A link to an increment in a folded group opens the group, once, and remembers it. */
    {
      const label = `link into a fold ${theme}`;
      const page = await openPage(theme, { width: 1440, height: 1000 }, `&increment=${ID.done}`, [
        "done",
        "planned",
      ]);
      await waitForView(page, "split");
      await cardOf(page, ID.done).waitFor();
      check(
        (await groupBar(page, "done").getAttribute("aria-expanded")) === "true" &&
          (await groupBar(page, "planned").getAttribute("aria-expanded")) === "false",
        `${label}: the linked group did not open`,
      );
      check(
        (await page.evaluate((key) => localStorage.getItem(key), FOLDS_KEY)) ===
          JSON.stringify({ "desk:atlas": ["planned"] }),
        `${label}: stored ${await page.evaluate((key) => localStorage.getItem(key), FOLDS_KEY)}`,
      );
      // Folding it again with the view open is the person's choice: it stays folded.
      await groupBar(page, "done").click();
      check(
        (await cardOf(page, ID.done).count()) === 0 && urlIncrement(page) === ID.done,
        `${label}: the open card's group would not fold`,
      );
      await noOverflow(page, label);
      await shot(page, `link-into-fold-${theme}`);
      await closePage(page, label);
    }

    /* A refresh that moves or removes the card under the keyboard: focus follows, in a real browser. */
    {
      const label = `focus on refresh ${theme}`;
      const page = await openPage(theme, { width: 900, height: 1000 });
      await cardOf(page, ID.promoted).waitFor();
      await cardButton(page, ID.promoted).focus();
      await page.evaluate((id) => window.fixtureBoard.block(id), ID.promoted);
      await group(page, "blocked").locator(`[data-increment="${ID.promoted}"]`).waitFor();
      check(
        (await focusedCard(page)) === ID.promoted,
        `${label}: focus did not follow the card into Blocked`,
      );
      await cardButton(page, ID.idle).focus();
      await page.evaluate((id) => window.fixtureBoard.remove(id), ID.idle);
      await cardOf(page, ID.idle).waitFor({ state: "detached" });
      check(
        await groupBar(page, "planned").evaluate((node) => node === document.activeElement),
        `${label}: focus did not go to the heading of the group the card left`,
      );
      // Focus that is somewhere else stays there.
      const find = page.locator('[aria-label="Find an increment"]');
      await cardButton(page, ID.noSpec).focus();
      await find.focus();
      await page.evaluate((id) => window.fixtureBoard.remove(id), ID.noSpec);
      await cardOf(page, ID.noSpec).waitFor({ state: "detached" });
      check(
        await find.evaluate((node) => node === document.activeElement),
        `${label}: a refresh took focus from the search box`,
      );
      await closePage(page, label);
    }

    /* Until the threads have answered: machines without counts, nothing to choose, no offer. */
    {
      const label = `threads reading ${theme}`;
      const page = await openPage(theme, { width: 900, height: 1000 }, "&threads=reading");
      await cardOf(page, ID.blocked).waitFor();
      check(
        (await page.locator(".sws-board-legend-note").textContent()) === "Reading threads…",
        `${label}: legend note`,
      );
      check(
        (await page.locator(".sws-board-legend-count").count()) === 0 &&
          (await page.locator(".sws-board-legend-entry[data-machine]:not([disabled])").count()) ===
            0 &&
          (await page.locator('.sws-board-legend-entry[data-machine="no-thread"]').count()) === 0,
        `${label}: a machine can be chosen from a half-read list`,
      );
      // What the unread machine holds is not on the board yet: its card waits in Planned, no edge.
      check(
        (await group(page, "planned").locator(`[data-increment="${ID.promoted}"]`).count()) === 1 &&
          (await cardOf(page, ID.promoted).locator(".sws-board-card-edge").count()) === 0,
        `${label}: a thread of a machine that has not answered is on the board`,
      );
      // A card with no thread known yet is not offered as free; a thread already known still opens.
      const offers = await page
        .locator(".sws-board-action")
        .evaluateAll((nodes) => [...new Set(nodes.map((node) => node.textContent))]);
      check(
        JSON.stringify(offers) === JSON.stringify(["Open thread"]),
        `${label}: offers before the threads answered ${JSON.stringify(offers)}`,
      );
      await noOverflow(page, label);
      await shot(page, `threads-reading-${theme}`);
      await closePage(page, label);
    }

    /* A 400 character reason with no spaces wraps inside its box at 360 px. */
    {
      const label = `long reason ${theme}`;
      const page = await openPage(theme, { width: 360, height: 800 });
      await cardOf(page, ID.longReason).waitFor();
      const cardReason = await cardOf(page, ID.longReason)
        .locator(".sws-board-reason-text")
        .evaluate((node) => {
          const box = node.closest(".sws-board-card").getBoundingClientRect();
          const rect = node.getBoundingClientRect();
          return {
            inside: rect.left >= box.left && rect.right <= box.right + 0.5,
            fits: node.scrollWidth <= node.clientWidth,
          };
        });
      check(
        cardReason.inside && cardReason.fits,
        `${label}: card reason ${JSON.stringify(cardReason)}`,
      );
      await cardButton(page, ID.longReason).click();
      await waitForView(page, "full");
      const reason = view(page).locator(".sws-board-view-blocker-reason").first();
      await reason.scrollIntoViewIfNeeded();
      const wrap = await reason.evaluate((node) => {
        const box = node.closest(".sws-board-view-blocker").getBoundingClientRect();
        const rect = node.getBoundingClientRect();
        const line = parseFloat(getComputedStyle(node).lineHeight);
        return {
          inside: rect.left >= box.left && rect.right <= box.right + 0.5,
          fits: node.scrollWidth <= node.clientWidth,
          lines: Math.round(rect.height / line),
        };
      });
      check(
        wrap.inside && wrap.fits && wrap.lines >= 3,
        `${label}: view reason ${JSON.stringify(wrap)}`,
      );
      await noOverflow(page, label);
      await shot(page, `long-reason-360-${theme}`, { keepScroll: true });
      await closePage(page, label);
    }

    /* A server without the detail read, and an increment removed while open. */
    {
      const label = `old server ${theme}`;
      const page = await openPage(
        theme,
        { width: 1440, height: 1000 },
        `&server=old&increment=${ID.blocked}`,
      );
      await waitForView(page, "split");
      await view(page).getByText("Tasks and criteria need a newer server").waitFor();
      check(
        (await cardOf(page, ID.blocked).locator(".sws-board-chip-blocked").textContent()) ===
          "Blocked",
        `${label}: bare Blocked from an old server`,
      );
      await noOverflow(page, label);
      await shot(page, `old-server-${theme}`);
      await closePage(page, label);
    }
    {
      const label = `removed ${theme}`;
      const page = await openPage(
        theme,
        { width: 1440, height: 1000 },
        `&removed=${ID.pausedBlocked}&increment=${ID.pausedBlocked}`,
      );
      await waitForView(page, "split");
      await view(page).getByText("This increment is no longer on disk.").waitFor();
      // Gone from disk: nothing to resume or open, and no stale blocker boxes.
      check(
        (await view(page).locator("[data-primary]").count()) === 0 &&
          (await view(page).getByRole("button", { name: "Spec file", exact: true }).count()) ===
            0 &&
          (await view(page).locator(".sws-board-view-blocker").count()) === 0,
        `${label}: removed increment still offers actions or blockers`,
      );
      await noOverflow(page, label);
      await shot(page, `removed-${theme}`);
      await view(page).getByRole("button", { name: "Back to the board" }).click();
      await page.locator(".sws-board:not([data-view])").waitFor();
      await closePage(page, label);
    }

    /* A project without SpecWeave: the tab offers to turn the board on. */
    {
      const label = `setup ${theme}`;
      const page = await openPage(theme, { width: 1440, height: 900 }, "&setup=1");
      await page.getByRole("heading", { name: "Start a board for this project" }).waitFor();
      await page.getByRole("button", { name: "Set up SpecWeave" }).waitFor();
      check((await page.locator("[data-group]").count()) === 0, `${label}: no groups`);
      await shot(page, `setup-${theme}`);
      await closePage(page, label);
    }
  }
} finally {
  await browser.close();
  server.close();
}
console.log(JSON.stringify({ results, shots }, null, 2));
if (failures.length > 0) {
  console.error(`${failures.length} failed:\n- ${failures.join("\n- ")}`);
  process.exit(1);
}
console.log(`All checks passed: ${shots.length} captures.`);
