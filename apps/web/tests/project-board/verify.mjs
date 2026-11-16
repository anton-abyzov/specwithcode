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
  promoted: "0036-rename-threads-in-place",
  idle: "0037-notification-sounds",
  noSpec: "0038-calendar-import",
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

async function openPage(theme, viewport, search = "") {
  const context = await browser.newContext({
    viewport,
    locale: "en-US",
    timezoneId: "UTC",
    colorScheme: theme,
  });
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

const column = (page, name) => page.locator(`[data-column="${name}"]`);
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
      [...document.querySelectorAll("[data-column]")].map((section) => [
        section.dataset.column,
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
    /* The board, wide: four columns, the thread promotion, chips, the filter. */
    {
      const label = `wide ${theme}`;
      const page = await openPage(theme, { width: 1440, height: 1000 });
      await cardOf(page, ID.blocked).waitFor();
      await page.waitForTimeout(250);
      const counts = await headingCounts(page);
      check(
        JSON.stringify(counts) ===
          JSON.stringify({
            planned: { heading: 3, cards: 3 },
            active: { heading: 6, cards: 6 },
            review: { heading: 2, cards: 2 },
            done: { heading: 6, cards: 6 },
          }),
        `${label}: heading counts ${JSON.stringify(counts)}`,
      );
      // A working thread moves its planned card to Active; an idle one leaves it in Planned.
      check(
        (await column(page, "active").locator(`[data-increment="${ID.promoted}"]`).count()) === 1,
        `${label}: promoted card in Active`,
      );
      check(
        (await column(page, "planned").locator(`[data-increment="${ID.idle}"]`).count()) === 1,
        `${label}: idle card in Planned`,
      );
      check(
        (await cardOf(page, ID.idle).locator('.sws-board-thread[data-tone="idle"]').count()) === 1,
        `${label}: idle thread tone`,
      );
      // Paused with every task done stays out of In review.
      check(
        (await column(page, "active").locator(`[data-increment="${ID.pausedDone}"]`).count()) === 1,
        `${label}: paused all-done in Active`,
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
      check((await chip(ID.pausedDone)) === "Paused", `${label}: paused chip`);
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
        (await cardOf(page, ID.seven).locator(".sws-board-thread-more").textContent()) ===
          "4 more threads",
        `${label}: seven threads fold`,
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
      for (const id of [ID.blocked, ID.pausedBlocked, ID.pausedDone]) {
        const ratio = await contrast(cardOf(page, id).locator(".sws-board-chip-blocked"));
        check(ratio >= 4.5, `${label}: blocked chip contrast ${ratio} on ${id}`);
      }
      await noOverflow(page, label);
      await shot(page, `board-wide-${theme}`);

      // Blocked only: pressed, filled, and every column narrowed to its stuck cards.
      const filter = page.locator(".sws-board-filter");
      check((await filter.textContent()) === "Blocked only · 4 cards", `${label}: filter label`);
      check((await filter.getAttribute("aria-pressed")) === "false", `${label}: filter starts off`);
      await page.mouse.move(0, 0);
      const offStyle = await filter.evaluate((node) => getComputedStyle(node).backgroundColor);
      await filter.click();
      await page.mouse.move(0, 0);
      await page.waitForTimeout(150);
      check((await filter.getAttribute("aria-pressed")) === "true", `${label}: filter pressed`);
      const onStyle = await filter.evaluate((node) => getComputedStyle(node).backgroundColor);
      check(onStyle !== offStyle, `${label}: pressed background ${onStyle} equals ${offStyle}`);
      const pressedRatio = await contrast(filter);
      check(pressedRatio >= 4.5, `${label}: pressed filter contrast ${pressedRatio}`);
      const filtered = await headingCounts(page);
      check(
        filtered.active.cards === 4 &&
          filtered.planned.cards === 0 &&
          filtered.review.cards === 0 &&
          filtered.done.cards === 0,
        `${label}: filtered cards ${JSON.stringify(filtered)}`,
      );
      await noOverflow(page, `${label} filtered`);
      await shot(page, `blocked-only-${theme}`);
      await filter.click();
      check((await filter.getAttribute("aria-pressed")) === "false", `${label}: filter off again`);
      // The column's "N blocked" toggles the same filter.
      const headingSwitch = column(page, "active").locator(".sws-board-column-blocked");
      check((await headingSwitch.textContent()) === "4 blocked", `${label}: column blocked count`);
      await headingSwitch.click();
      check(
        (await filter.getAttribute("aria-pressed")) === "true",
        `${label}: heading turns filter on`,
      );
      await headingSwitch.click();
      check(
        (await filter.getAttribute("aria-pressed")) === "false",
        `${label}: heading turns filter off`,
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
      const first = await column(page, "active")
        .locator("[data-board-card]")
        .first()
        .getAttribute("data-board-card");
      const second = await column(page, "active")
        .locator("[data-board-card]")
        .nth(1)
        .getAttribute("data-board-card");
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
      await noOverflow(page, label);
      await shot(page, `phone-board-${theme}`);
      await cardButton(page, ID.blocked).click();
      await waitForView(page, "full");
      await noOverflow(page, `${label} view`);
      await shot(page, `phone-view-${theme}`);
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
      check((await page.locator("[data-column]").count()) === 0, `${label}: no columns`);
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
