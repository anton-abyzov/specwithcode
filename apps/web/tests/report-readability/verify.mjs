// Build first: vp build --config apps/web/tests/report-readability/vite.config.ts
// Supply the installed Playwright entry via STUDIO_PLAYWRIGHT_MODULE. Always headless.
// Usage: node verify.mjs [evidence-dir] [--local <file.md>] [--measure-only]
import * as NodeAssert from "node:assert/strict";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
process.env.PWDEBUG = "0";
process.env.PLAYWRIGHT_HTML_OPEN = "never";
const { chromium } = await import(NodeURL.pathToFileURL(process.env.STUDIO_PLAYWRIGHT_MODULE).href);

const args = process.argv.slice(2);
const localIndex = args.indexOf("--local");
const localFile = localIndex >= 0 ? args[localIndex + 1] : null;
const measureOnly = args.includes("--measure-only");
const outputArg = args.find(
  (arg, index) => !arg.startsWith("--") && (localIndex < 0 || index !== localIndex + 1),
);
const root = NodePath.resolve(".artifacts/report-readability/site");
const output = NodePath.resolve(outputArg ?? ".artifacts/report-readability/evidence");
await NodeFSP.mkdir(output, { recursive: true });
const extraDocs = localFile ? { [localFile]: await NodeFSP.readFile(localFile, "utf8") } : {};

const MIME = { ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2" };
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

// The fixture's files (hostFiles.ts), each opened from its chip in the message.
const FOLDER = "/Users/example/Downloads/release-evidence";
const DOCS = {
  statements: `${FOLDER}/release-result.md`,
  wrapped: `${FOLDER}/notes.md`,
  structured: `${FOLDER}/structured.md`,
  longTokens: `${FOLDER}/long-values.md`,
  comparison: `${FOLDER}/skills-comparison.md`,
  moves: `${FOLDER}/home-cleanup.md`,
  ...(localFile ? { local: localFile } : {}),
};
const errors = [];
const receipt = [];

/**
 * What a reader sees of the document body: its blocks, line breaks, tokens and
 * overflow. Only a wide table may leave the page, and nothing may leave the
 * reader; a table's own scrolled content is its frame's business.
 */
const measure = (page) =>
  page.locator('[data-report-reader-body="true"]').evaluate((body) => {
    const prose = body.querySelector("[data-markdown-body] .chat-markdown");
    const blocks = prose ? [...prose.children].map((node) => node.tagName.toLowerCase()) : [];
    const bounds = body.getBoundingClientRect();
    const pageBounds = body.querySelector(".report-document-page").getBoundingClientRect();
    const outside = (box, edge) => box.right > edge.right + 1 || box.left < edge.left - 1;
    const nodes = body.querySelectorAll(".report-document-page, .report-document-page *");
    const overflowing = [...nodes].filter((node) => {
      if (node.closest('[data-slot="scroll-area-viewport"] > *')) return false;
      const box = node.getBoundingClientRect();
      // A line-break hint (wbr) has no box to overflow with.
      if (box.width === 0 && box.height === 0) return false;
      if (outside(box, bounds)) return true;
      return !node.closest(".chat-markdown-table-container") && outside(box, pageBounds);
    });
    return {
      blocks,
      paragraphs: prose ? prose.querySelectorAll(":scope > p").length : 0,
      lineBreaks: prose ? prose.querySelectorAll("br").length : 0,
      codeTokens: prose ? prose.querySelectorAll(":not(pre) > code").length : 0,
      fileLinks: prose ? prose.querySelectorAll("a").length : 0,
      text: prose?.innerText ?? "",
      overflowing: overflowing.map((node) => node.tagName.toLowerCase()),
      readerScrollsSideways: body.scrollWidth > body.clientWidth + 1,
    };
  });

/**
 * Each table as laid out: its frame against the page's text column, whether it
 * scrolls inside its frame, and any word or code token drawn on more than one
 * line. Prose may break after a hyphen; code only at its spaces.
 */
const measureTables = (page) =>
  page.locator('[data-report-reader-body="true"]').evaluate((body) => {
    const pageElement = body.querySelector(".report-document-page");
    const style = getComputedStyle(pageElement);
    const pageBox = pageElement.getBoundingClientRect();
    const column = {
      left: pageBox.left + Number.parseFloat(style.paddingLeft),
      right: pageBox.right - Number.parseFloat(style.paddingRight),
    };
    const lines = (rects) =>
      new Set([...rects].filter((r) => r.width > 0).map((r) => Math.round(r.top))).size;
    const paragraphs = [...body.querySelectorAll(".chat-markdown > p")].map(
      (p) => p.getBoundingClientRect().width,
    );
    const tables = [...body.querySelectorAll(".chat-markdown-table-container")].map((container) => {
      const frame = container.firstElementChild.getBoundingClientRect();
      const viewport = container.querySelector('[data-slot="scroll-area-viewport"]');
      const table = container.querySelector("table");
      const split = [];
      for (const cell of table.querySelectorAll("th, td")) {
        const walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT);
        for (let text = walker.nextNode(); text; text = walker.nextNode()) {
          const pattern = text.parentElement.closest("code") ? /\S+/gu : /[^\s-]+-?/gu;
          for (const match of text.data.matchAll(pattern)) {
            const range = document.createRange();
            range.setStart(text, match.index);
            range.setEnd(text, match.index + match[0].length);
            if (lines(range.getClientRects()) > 1) split.push(match[0]);
          }
        }
      }
      return {
        columns: table.rows[0].cells.length,
        frameLeft: Math.round(frame.left),
        frameWidth: Math.round(frame.width),
        frameCenterOffset: Math.round(
          (frame.left + frame.right) / 2 - (column.left + column.right) / 2,
        ),
        insideReader:
          frame.left >= body.getBoundingClientRect().left - 1 &&
          frame.right <= body.getBoundingClientRect().right + 1,
        scrollsInFrame: viewport.scrollWidth > viewport.clientWidth + 1,
        split,
        wrappedCode: [...table.querySelectorAll("code")].filter(
          (code) => lines(code.getClientRects()) > 1,
        ).length,
        maxRow: Math.round(
          Math.max(...[...table.tBodies[0].rows].map((row) => row.getBoundingClientRect().height)),
        ),
        // A cell whose text wraps stays within 28rem, or within its widest
        // unbreakable piece (a whole chip, token or link chunk).
        longLines: [...table.querySelectorAll(".chat-markdown-cell")]
          .filter((cell) => {
            const range = document.createRange();
            range.selectNodeContents(cell);
            const width = cell.getBoundingClientRect().width;
            cell.style.width = "min-content";
            const piece = cell.getBoundingClientRect().width;
            cell.style.width = "";
            return width > Math.max(449, piece + 1) && lines(range.getClientRects()) > 1;
          })
          .map((cell) => cell.textContent.slice(0, 40)),
        truncatedChips: [...table.querySelectorAll(".chat-markdown-file-link .truncate")].filter(
          (label) => label.scrollWidth > label.clientWidth + 1,
        ).length,
        ...(() => {
          // The first and last columns are whole at either end of the frame's scroll.
          const box = viewport.getBoundingClientRect();
          const head = table.rows[0].cells;
          const firstWhole = () => head[0].getBoundingClientRect().left >= box.left - 1;
          const lastWhole = () =>
            head[head.length - 1].getBoundingClientRect().right <= box.right + 1;
          const start = viewport.scrollLeft;
          viewport.scrollLeft = 0;
          const firstColumnWhole = firstWhole();
          viewport.scrollLeft = viewport.scrollWidth;
          const lastColumnReachable = lastWhole();
          viewport.scrollLeft = start;
          return { firstColumnWhole, lastColumnReachable };
        })(),
        cellText: [...table.querySelectorAll("th, td")].map((cell) => cell.textContent.trim()),
        links: [...table.querySelectorAll("a")].map((a) => a.getAttribute("href")),
      };
    });
    const outline = body.querySelector(":scope > .report-outline");
    const inline = Number.parseFloat(style.paddingLeft);
    return {
      columnWidth: Math.round(column.right - column.left),
      // The room a wide table may take: the reader beside the outline, less the page margins.
      room: Math.round(
        body.clientWidth - (outline ? outline.getBoundingClientRect().width : 0) - 2 * inline,
      ),
      widestParagraph: Math.round(Math.max(0, ...paragraphs)),
      tables,
    };
  });

/** Tab from the top of the reader until the named table's scroll region has focus. */
async function tabToTable(page, index) {
  const viewport = page
    .locator('[data-report-reader-body="true"] .chat-markdown-table-container')
    .nth(index)
    .locator('[data-slot="scroll-area-viewport"]');
  await page.locator('[data-report-reader-body="true"]').evaluate((body) => body.focus());
  for (let step = 0; step < 60; step += 1) {
    if (await viewport.evaluate((node) => node === document.activeElement)) break;
    await page.keyboard.press("Tab");
  }
  return viewport.evaluate((node) => {
    // The ring draws on the scroll root, where the viewport's scroll fades cannot mask it.
    const ring = getComputedStyle(node.parentElement);
    return {
      focused: node === document.activeElement,
      focusVisible: node.matches(":focus-visible"),
      role: node.getAttribute("role"),
      label: node.getAttribute("aria-label"),
      outline: `${ring.outlineStyle} ${ring.outlineWidth}`,
      ringMasked: (ring.maskImage ?? ring.webkitMaskImage ?? "none") !== "none",
    };
  });
}

/**
 * The comparison's controls: keyboard scrolling of the values table, the
 * expanded state, and Copy as Markdown and CSV of the five-column table.
 */
async function exerciseTables(page, label) {
  const tables = page.locator('[data-report-reader-body="true"] .chat-markdown-table-container');
  const keyboard = await tabToTable(page, 2);
  const values = tables.nth(2).locator('[data-slot="scroll-area-viewport"]');
  const before = await values.evaluate((node) => node.scrollLeft);
  for (let step = 0; step < 4; step += 1) await page.keyboard.press("ArrowRight");
  // Arrow keys scroll smoothly; read the position once the scroll settles.
  await page.waitForTimeout(400);
  keyboard.scrolledBy = (await values.evaluate((node) => node.scrollLeft)) - before;
  await page.screenshot({ path: NodePath.join(output, `${label}-comparison-keyboard.png`) });
  await values.evaluate((node) => {
    node.scrollLeft = 0;
  });

  // The outline's heading list opens above a wide table beside it.
  await page.locator('[data-report-reader-body="true"]').evaluate((body) => {
    body.scrollTop = body.querySelector(".chat-markdown-table-container").offsetTop;
  });
  await page.locator("nav.report-outline").hover();
  await page.waitForTimeout(200);
  const outlineOnTop = await page.evaluate(() => {
    const list = document.querySelector(".report-outline-list").getBoundingClientRect();
    const hit = document.elementFromPoint(list.right - 12, list.top + list.height / 2);
    return Boolean(hit?.closest(".report-outline-list"));
  });
  await page.mouse.move(0, 0);

  const copies = {};
  for (const format of ["Markdown", "CSV"]) {
    await tables.nth(0).getByRole("button", { name: /^Copy/u }).click();
    await page.getByRole("menuitem", { name: `Copy as ${format}` }).click();
    await page.waitForTimeout(100);
    copies[format] = await page.evaluate(() => navigator.clipboard.readText());
  }

  // The toggle starts from the word-wrap setting; check the other state, then go back.
  const toggle = tables.nth(0).getByRole("button", { name: /table cells$/u });
  await toggle.click();
  await page.waitForTimeout(100);
  const toggled = (await measureTables(page)).tables[0];
  const state = await toggle.getAttribute("aria-label");
  await page.screenshot({ path: NodePath.join(output, `${label}-comparison-toggled.png`) });
  await toggle.click();
  return {
    keyboard,
    outlineOnTop,
    copies,
    toggled: { state, split: toggled.split, frameWidth: toggled.frameWidth },
  };
}

/**
 * The home cleanup table: the arrow keys reach its last column, and focusing a
 * file chip at the frame's edge scrolls the frame to show it (the browser's own
 * rule, which left the screenshot's first column clipped after a return).
 */
async function exerciseMoves(page, label) {
  const viewport = page
    .locator('[data-report-reader-body="true"] .chat-markdown-table-container')
    .first()
    .locator('[data-slot="scroll-area-viewport"]');
  const keyboard = await tabToTable(page, 0);
  const end = await viewport.evaluate((node) => node.scrollWidth - node.clientWidth);
  for (let step = 0; step < 60; step += 1) {
    if ((await viewport.evaluate((node) => node.scrollLeft)) >= end - 1) break;
    await page.keyboard.press("ArrowRight");
    await page.waitForTimeout(60);
  }
  await page.waitForTimeout(400);
  keyboard.reachedEnd = (await viewport.evaluate((node) => node.scrollLeft)) >= end - 1;
  keyboard.scrollable = end > 1;
  await page.screenshot({ path: NodePath.join(output, `${label}-moves-keyboard-end.png`) });
  const chipFocus = await viewport.evaluate(async (node) => {
    node.scrollLeft = 0;
    const chips = node.querySelectorAll("tbody tr:first-child a");
    chips[chips.length - 1]?.focus();
    await new Promise((resolve) => setTimeout(resolve, 400));
    const shifted = node.scrollLeft;
    node.scrollLeft = 0;
    return { scrollLeftAfterFocus: Math.round(shifted) };
  });
  return { keyboard, chipFocus };
}

try {
  for (const theme of ["dark", "light"]) {
    // `zoom200`: a 1440-pixel window at 200% zoom lays out 720 CSS pixels wide.
    // `hidden`: the viewer's thread pane is closed, so the reader takes the window.
    for (const [width, zoom, hidden] of [
      [2400, 1],
      [1440, 1],
      [1440, 1, true],
      [1100, 1],
      [390, 1],
      [720, 2],
    ]) {
      const label = zoom === 2 ? `${theme}-zoom200` : `${theme}-${width}${hidden ? "-hidden" : ""}`;
      const context = await browser.newContext({
        viewport: { width, height: 900 },
        deviceScaleFactor: zoom,
      });
      await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin });
      await context.addInitScript((docs) => {
        window.__EXTRA_DOCS__ = docs;
      }, extraDocs);
      const page = await context.newPage();
      page.on("pageerror", (error) => errors.push(`${label}: ${String(error)}`));
      await page.route("**/*", (route) =>
        route.request().url().startsWith(origin) ? route.continue() : route.abort(),
      );
      await page.goto(`${origin}/?theme=${theme}`);
      for (const [doc, path] of Object.entries(DOCS)) {
        await page.locator(`main a[href="${path}"]`).first().click();
        await page.locator('[data-report-reader-body="true"] [data-markdown-body]').waitFor();
        const hide = page.getByRole("button", { name: "Hide thread" });
        if (hidden && (await hide.count()) > 0) await hide.click();
        await page.mouse.move(0, 0);
        await page.waitForTimeout(300);
        const shot = NodePath.join(output, `${label}-${doc}.png`);
        await page.screenshot({ path: shot });
        const metrics = await measure(page);
        const entry = { label, doc, shot, ...metrics, ...(await measureTables(page)) };
        if (doc === "comparison") Object.assign(entry, await exerciseTables(page, label));
        if (doc === "moves") Object.assign(entry, await exerciseMoves(page, label));
        receipt.push(entry);
        await page.keyboard.press("Escape");
        await page.locator('[data-report-reader-body="true"]').waitFor({ state: "detached" });
      }
      await context.close();
    }
  }
  if (!measureOnly) {
    const row = (label, doc) => receipt.find((entry) => entry.label === label && entry.doc === doc);
    const labels = ["dark", "light"].flatMap((theme) =>
      ["2400", "1440", "1440-hidden", "1100", "390", "zoom200"].map((size) => `${theme}-${size}`),
    );
    for (const label of labels) {
      const statements = row(label, "statements");
      // Six statements, one block each, every digit and hash exactly as written.
      NodeAssert.equal(statements.paragraphs, 6, `${label}: one paragraph per statement`);
      NodeAssert.match(statements.text, /merged at 4be1f0c9d2a7e65b31c8f09a7d4e2b6c58a1f3e0;/u);
      // Commit, digest and both paths, each shown in full.
      NodeAssert.equal(statements.codeTokens, 4, `${label}: digests and paths set as code`);
      NodeAssert.match(
        statements.text,
        /\/Users\/example\/Downloads\/release-evidence\/report\.html/u,
      );
      // Hard-wrapped prose stays one paragraph; short label lines keep their lines.
      const wrapped = row(label, "wrapped");
      NodeAssert.equal(wrapped.paragraphs, 2, `${label}: wrapped prose stays joined`);
      NodeAssert.equal(wrapped.lineBreaks, 2, `${label}: label lines keep their breaks`);
      // A well-formed report renders as it did.
      const structured = row(label, "structured");
      NodeAssert.equal(structured.lineBreaks, 0, `${label}: no breaks added to a clean report`);
      for (const entry of receipt.filter((item) => item.label === label)) {
        NodeAssert.deepEqual(entry.overflowing, [], `${label} ${entry.doc}: nothing overflows`);
        NodeAssert.equal(
          entry.readerScrollsSideways,
          false,
          `${label} ${entry.doc}: no sideways page`,
        );
        for (const [index, table] of entry.tables.entries()) {
          // AC-01: no word or code token breaks across lines.
          NodeAssert.deepEqual(
            table.split,
            [],
            `${label} ${entry.doc} table ${index}: whole words`,
          );
          NodeAssert.ok(
            table.insideReader,
            `${label} ${entry.doc} table ${index}: inside the reader`,
          );
          NodeAssert.ok(
            Math.abs(table.frameCenterOffset) <= 2,
            `${label} ${entry.doc} table ${index}: centered on the page`,
          );
          // AC-02: a frame is at least the page's column and at most the room;
          // it scrolls only once it has the whole room.
          NodeAssert.ok(
            table.frameWidth >= entry.columnWidth - 2 && table.frameWidth <= entry.room + 2,
            `${label} ${entry.doc} table ${index}: frame between the column and the room`,
          );
          if (table.scrollsInFrame) {
            NodeAssert.ok(
              table.frameWidth >= entry.room - 2,
              `${label} ${entry.doc} table ${index}: scrolls only with the whole room`,
            );
          }
          NodeAssert.deepEqual(
            table.longLines,
            [],
            `${label} ${entry.doc} table ${index}: lines by 28rem`,
          );
          NodeAssert.equal(
            table.truncatedChips,
            0,
            `${label} ${entry.doc} table ${index}: whole chips`,
          );
          // AC-03: both end columns can be shown whole.
          NodeAssert.ok(
            table.firstColumnWhole && table.lastColumnReachable,
            `${label} ${entry.doc} table ${index}: first and last columns reachable`,
          );
        }
      }

      const comparison = row(label, "comparison");
      const [skills, checks, values, commands] = comparison.tables;
      // AC-02: prose keeps its measure (36rem) while tables leave it.
      NodeAssert.ok(comparison.widestParagraph <= 577, `${label}: prose keeps its measure`);
      NodeAssert.equal(checks.scrollsInFrame, false, `${label}: a two-column prose table fits`);
      // AC-01: a command wraps at its spaces instead of scrolling while it fits.
      NodeAssert.ok(commands.wrappedCode > 0, `${label}: commands wrap at their spaces`);
      if (/-(2400|1440|1100)$/u.test(label)) {
        NodeAssert.equal(commands.scrollsInFrame, false, `${label}: commands fit the measure`);
      }
      if (/-(2400|1440-hidden)$/u.test(label)) {
        // With the room the defect's reader had, the comparison fits, wider than prose.
        NodeAssert.ok(
          skills.frameWidth >= comparison.columnWidth + 200,
          `${label}: wider than prose`,
        );
        NodeAssert.equal(
          skills.scrollsInFrame,
          false,
          `${label}: the comparison fits without scrolling`,
        );
      }
      if (label.endsWith("390") || label.endsWith("zoom200")) {
        // AC-03: what cannot fit scrolls inside its frame, never the page.
        NodeAssert.ok(values.scrollsInFrame, `${label}: long values scroll inside their frame`);
      }
      if (label.endsWith("390")) {
        // A path longer than a narrow page scrolls in its two-column frame, not the page.
        NodeAssert.ok(commands.scrollsInFrame, `${label}: a long path scrolls inside its frame`);
      }
      // AC-03: the scroll region is a labeled stop with a visible focus ring.
      const { keyboard } = comparison;
      NodeAssert.ok(
        keyboard.focused && keyboard.focusVisible,
        `${label}: keyboard reaches the table`,
      );
      NodeAssert.equal(keyboard.role, "region", `${label}: the scroll region is a region`);
      NodeAssert.ok(keyboard.label, `${label}: the scroll region is labeled`);
      NodeAssert.match(keyboard.outline, /^solid [2-9]/u, `${label}: focus ring visible`);
      NodeAssert.equal(keyboard.ringMasked, false, `${label}: no scroll fade masks the ring`);
      if (values.scrollsInFrame) {
        NodeAssert.ok(keyboard.scrolledBy > 0, `${label}: arrow keys scroll the table`);
      }
      NodeAssert.ok(comparison.outlineOnTop, `${label}: the outline list opens above the table`);
      // AC-04: content, links, copy and the expanded state are unchanged.
      NodeAssert.ok(skills.cellText.includes("sw-grill-me"), `${label}: identifier text intact`);
      NodeAssert.ok(
        skills.links.includes(DOCS.statements),
        `${label}: a file link in a cell stays a link`,
      );
      for (const token of ["sw-grill-me", "planning.deepInterview: deep", "sw:done", "51e280c05"]) {
        NodeAssert.ok(
          comparison.copies.Markdown.includes(token),
          `${label}: Markdown copy has ${token}`,
        );
        NodeAssert.ok(comparison.copies.CSV.includes(token), `${label}: CSV copy has ${token}`);
      }
      NodeAssert.ok(
        comparison.copies.Markdown.includes("`planning.deepInterview: deep`"),
        `${label}: Markdown copy keeps code as one span`,
      );
      // A failed CSV copy would leave the Markdown copy on the clipboard.
      NodeAssert.match(comparison.copies.Markdown, /\| --- \|/u, `${label}: Markdown copy`);
      NodeAssert.ok(
        comparison.copies.CSV.includes(",") && !comparison.copies.CSV.includes("| --- |"),
        `${label}: CSV copy is CSV`,
      );
      NodeAssert.deepEqual(
        comparison.toggled.split,
        [],
        `${label}: both cell states keep words whole`,
      );

      // The screenshot's table: compact rows, every column reachable by keyboard.
      const moves = row(label, "moves");
      const [actions] = moves.tables;
      if (/-(2400|1440-hidden)$/u.test(label)) {
        NodeAssert.equal(actions.scrollsInFrame, false, `${label}: the moves table fits`);
        NodeAssert.ok(actions.maxRow <= 48, `${label}: one-line rows (${actions.maxRow})`);
      } else if (label.endsWith("390")) {
        NodeAssert.ok(actions.maxRow <= 140, `${label}: compact rows (${actions.maxRow})`);
      } else {
        NodeAssert.ok(actions.maxRow <= 70, `${label}: two-line rows (${actions.maxRow})`);
      }
      NodeAssert.ok(moves.keyboard.focused && moves.keyboard.focusVisible, `${label}: moves focus`);
      if (moves.keyboard.scrollable) {
        NodeAssert.ok(moves.keyboard.reachedEnd, `${label}: arrow keys reach the last column`);
      }
    }
  }
  NodeAssert.deepEqual(errors, [], "no page errors");
} finally {
  await NodeFSP.writeFile(
    NodePath.join(output, "receipt.json"),
    `${JSON.stringify({ at: new Date().toISOString(), measureOnly, errors, receipt }, null, 2)}\n`,
  );
  await browser.close();
  server.close();
}
console.log(`report-readability: ${receipt.length} documents rendered; evidence in ${output}`);
