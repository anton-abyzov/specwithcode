// The Files list, file states, property cards and the file reader (`/files.html`): rows, states,
// pin, hide and copy by keyboard, a native page opening outside the app, a missing file's
// explained notice, the reader's Close and Escape with focus back on the link, and the D-05
// choice between the panel and the focused viewer. Always headless. Run against the report
// fixture (port 5843, or REPORT_FIXTURE_PORT) with UI_EVIDENCE_DIR set to a new directory.
import * as NodeAssert from "node:assert/strict";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
process.env.PWDEBUG = "0";
process.env.PLAYWRIGHT_HTML_OPEN = "never";
const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE
    ? NodeURL.pathToFileURL(process.env.PLAYWRIGHT_MODULE).href
    : "playwright"
);
const output = process.env.UI_EVIDENCE_DIR;
NodeAssert.ok(output, "Use a new explicit evidence directory");
await NodeFSP.mkdir(output, { recursive: false });
const origin = `http://127.0.0.1:${process.env.REPORT_FIXTURE_PORT ?? 5843}`;
const browser = await chromium.launch({
  headless: true,
  ...(process.env.PLAYWRIGHT_EXECUTABLE
    ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE }
    : {}),
});
const ROOT = "/Users/fixture/work/atlas";
const NATIVE_URL = "https://claude.ai/artifact/ExampleArtifact0001";
const errors = [];
const results = [];

// 640 px at device scale 2 lays out like a 1280 px window at 200% zoom.
const VIEWS = [
  { name: "1280", viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 },
  { name: "360", viewport: { width: 360, height: 780 }, deviceScaleFactor: 2 },
  { name: "zoom200", viewport: { width: 640, height: 450 }, deviceScaleFactor: 2 },
];

const state = (page) => page.evaluate(() => window.fixtureState());
const shot = async (page, name) => {
  await settled(page);
  await page.screenshot({ path: NodePath.join(output, `${name}.png`) });
};
const activeIs = (page, selector) =>
  page.evaluate((selector) => document.activeElement?.matches(selector) ?? false, selector);

/** Popovers and overlays animate in; measure and capture them at rest. */
const settled = (page) =>
  page.waitForFunction(() =>
    document.getAnimations().every((animation) => animation.playState !== "running"),
  );

async function openFiles(page) {
  await page.getByRole("button", { name: /\d+ artifacts/ }).click();
  await page.locator("[data-artifact-shelf]").waitFor();
  await settled(page);
}
async function closeFiles(page) {
  await page.keyboard.press("Escape");
  await page.locator("[data-artifact-shelf]").waitFor({ state: "detached" });
}
const row = (page, name) =>
  page.locator("[data-thread-artifact-row]").filter({ hasText: name }).first();

try {
  for (const view of VIEWS) {
    for (const theme of ["light", "dark"]) {
      const label = `${view.name}-${theme}`;
      const context = await browser.newContext({
        viewport: view.viewport,
        deviceScaleFactor: view.deviceScaleFactor,
        colorScheme: theme,
        permissions: ["clipboard-read", "clipboard-write"],
      });
      const page = await context.newPage();
      page.on("pageerror", (error) => errors.push(`${label}: ${error.message}`));
      await page.goto(`${origin}/files.html?theme=${theme}`);
      await page.locator("[data-structured-kv]").waitFor();
      const result = { label };

      // Property cards: nothing runs past the conversation, keys keep their width, and a
      // selected value copies as written.
      result.cards = await page.evaluate(() => {
        const conversation = document.querySelector("[data-fixture-conversation]");
        const keys = [...document.querySelectorAll("[data-structured-kv] dt")];
        const value = [...document.querySelectorAll("[data-structured-kv] dd")][0];
        const selection = getSelection();
        const range = document.createRange();
        range.selectNodeContents(value);
        selection.removeAllRanges();
        selection.addRange(range);
        const selected = selection.toString();
        selection.removeAllRanges();
        return {
          overflow: conversation.scrollWidth > conversation.clientWidth + 1,
          narrowestKey: Math.min(...keys.map((key) => key.getBoundingClientRect().width)),
          stacked: keys.some(
            (key) =>
              key.nextElementSibling.getBoundingClientRect().top >=
              key.getBoundingClientRect().bottom - 1,
          ),
          selected,
        };
      });
      NodeAssert.equal(result.cards.overflow, false, `${label}: a card overflows`);
      NodeAssert.equal(
        result.cards.selected,
        `${ROOT}/.specweave/increments/0042-season-registration-and-payments/spec.md`,
      );
      await page.locator("[data-fixture-card=kv]").screenshot({
        path: NodePath.join(output, `${label}-cards.png`),
      });

      // The Files list: every state labeled, the native page with its version and note.
      await openFiles(page);
      await shot(page, `${label}-files`);
      const rows = await page.locator("[data-thread-artifact-row]").evaluateAll((items) =>
        items.map((item) => ({
          kind: item.dataset.threadArtifactRow,
          state: item.dataset.artifactState ?? null,
          kindLabel: item.querySelector("[data-artifact-kind]")?.textContent ?? null,
          tag: item.querySelector("[data-artifact-tag]")?.textContent ?? null,
          version: item.querySelector("[data-artifact-version]")?.textContent ?? null,
          note: item.querySelector("[data-artifact-note]")?.textContent ?? null,
          folder:
            item.querySelector("[data-artifact-folder]")?.getAttribute("data-artifact-folder") ??
            null,
          actionSizes: [...item.querySelectorAll("[data-artifact-action]")].map((action) => {
            const box = action.getBoundingClientRect();
            return Math.min(box.width, box.height);
          }),
          overflow: item.scrollWidth > item.clientWidth + 1,
          // The last folder shows whole; the head before it is what gives way.
          folderTail: (() => {
            const tail = item.querySelector("[data-artifact-folder]")?.lastElementChild;
            if (!tail) return null;
            // The text's own width against the box it is clipped to.
            const range = document.createRange();
            range.selectNodeContents(tail);
            const text = range.getBoundingClientRect().width;
            const box = tail.getBoundingClientRect().width;
            return {
              text: tail.textContent,
              whole: text <= box + 0.01,
              textWidth: text,
              boxWidth: box,
            };
          })(),
          // No detail is squeezed to nothing between its dots.
          collapsed: [
            ...item.querySelectorAll("[data-artifact-meta] > *, [data-artifact-origin] > *"),
          ]
            .filter((part) => part.textContent !== "·")
            .filter((part) => part.getBoundingClientRect().width < 12)
            .map((part) => part.textContent),
        })),
      );
      result.rows = rows;
      results.push(result);
      const byState = (value) => rows.filter((entry) => entry.state === value);
      NodeAssert.ok(byState("unreachable").some((entry) => entry.tag === "Unreachable"));
      NodeAssert.ok(byState("remote-only").some((entry) => entry.tag === "Remote only"));
      NodeAssert.ok(byState("unknown").some((entry) => entry.tag === "Checking"));
      const native = rows.find((entry) => entry.kind === "native" && entry.state === "present");
      NodeAssert.equal(native?.version, "Version 2");
      NodeAssert.ok(native?.note, `${label}: the native row explains its link`);
      NodeAssert.ok(
        rows.every((entry) => !entry.overflow),
        `${label}: a row overflows`,
      );
      NodeAssert.ok(
        rows.every((entry) => entry.folderTail === null || entry.folderTail.whole),
        `${label}: a last folder is cut`,
      );
      NodeAssert.deepEqual(
        rows.flatMap((entry) => entry.collapsed),
        [],
        `${label}: a row detail collapsed`,
      );
      NodeAssert.ok(
        rows.every((entry) => entry.actionSizes.every((size) => size >= 24)),
        `${label}: a row action is under 24 px`,
      );

      // Missing files fold into Older, labeled.
      await page.locator("[data-artifact-section-toggle=older]").click();
      const missing = row(page, "report-final.md");
      NodeAssert.equal(await missing.locator("[data-artifact-tag]").textContent(), "Missing");
      await shot(page, `${label}-files-older`);

      // Keyboard: the full path shows on focus, pin keeps focus as the row moves, copy is exact.
      const plan = row(page, "season-plan.md");
      await plan.locator("[data-thread-artifact]").focus();
      const fullPath = page.locator("[data-artifact-full-path]");
      await fullPath.waitFor();
      result.fullPathOnFocus = await fullPath.textContent();
      NodeAssert.equal(result.fullPathOnFocus, `${ROOT}/docs/season-plan.md`);
      await page.keyboard.press("Tab");
      NodeAssert.ok(
        await activeIs(page, "[data-artifact-action=pin]"),
        `${label}: Tab reaches pin`,
      );
      await page.keyboard.press("Enter");
      await page.locator("[data-artifact-section=pinned]").waitFor();
      result.pinKeepsFocus = await activeIs(
        page,
        "[data-artifact-section=pinned] [data-artifact-action=pin][aria-pressed=true]",
      );
      NodeAssert.ok(result.pinKeepsFocus, `${label}: pin keeps focus in Pinned`);
      await page.keyboard.press("Tab");
      await page.keyboard.press("Tab");
      NodeAssert.ok(
        await activeIs(page, "[data-artifact-action=copy]"),
        `${label}: Tab reaches copy`,
      );
      await page.keyboard.press("Enter");
      result.copied = await page.evaluate(() => navigator.clipboard.readText());
      NodeAssert.equal(result.copied, `${ROOT}/docs/season-plan.md`);
      await shot(page, `${label}-files-pinned`);

      // A native page opens in the browser, never in the app.
      await row(page, "Season standings preview").locator("[data-thread-artifact]").first().click();
      result.native = await state(page);
      NodeAssert.equal(result.native.external, NATIVE_URL);
      NodeAssert.equal(result.native.overlay, null);
      // The list closes with a short fade; a reopen before it ends would keep its sections.
      await page.locator("[data-artifact-shelf]").waitFor({ state: "detached" });

      // A missing file opens as an explained notice with its last path and look-alikes.
      await openFiles(page);
      await page.locator("[data-artifact-section-toggle=older]").click();
      await row(page, "report-final.md").locator("[data-thread-artifact]").click();
      const notice = page.locator("[data-missing-file]");
      await notice.waitFor();
      result.missingNotice = {
        path: await notice.getAttribute("data-missing-file"),
        similar: await notice.locator("[data-similar-files] li").count(),
        alert: await page.locator("[role=alert]").count(),
      };
      NodeAssert.equal(result.missingNotice.path, `${ROOT}/reports/archive/report-final.md`);
      result.missingNotice.nameWhole = await page.evaluate(() => {
        const name = document.querySelector(".viewer-overlay-current");
        return name !== null && name.scrollWidth <= name.clientWidth;
      });
      NodeAssert.ok(result.missingNotice.nameWhole, `${label}: the viewer cuts the file name`);
      NodeAssert.ok(result.missingNotice.similar > 0);
      await shot(page, `${label}-missing`);
      await page.keyboard.press("Escape");
      await page.waitForFunction(() => window.fixtureState().overlay === null);

      // A conversation link: beside the conversation when both fit (1280), else in front.
      const link = page.locator('[data-fixture-link="docs/season-plan.md"]');
      await link.click();
      const wide = view.viewport.width >= 1280;
      if (wide) {
        await page.waitForFunction(() => window.fixtureState().panel !== null);
        const close = page.locator("[data-file-reader-close]");
        await close.waitFor();
        result.reader = {
          placement: "panel",
          // The Esc hint is a separate key cap beside the word.
          closeText: (await close.textContent()).replace("Esc", "").trim(),
          closeName: await close.getAttribute("aria-label"),
          closeVisible: await close.isVisible(),
        };
        await shot(page, `${label}-reader-panel`);
        await page.keyboard.press("Escape");
        await page.waitForFunction(() => window.fixtureState().panel === null);
      } else {
        await page.waitForFunction(() => window.fixtureState().focused !== null);
        const move = page.locator("[data-focused-file-move]");
        await move.waitFor();
        const close = page.getByRole("button", { name: /^Close/ }).first();
        result.reader = {
          placement: "focused",
          closeText: (await close.textContent()).replace("Esc", "").trim(),
          closeVisible: await close.isVisible(),
          move: (await move.textContent()).trim(),
        };
        NodeAssert.equal(result.reader.move, "Open in panel");
        result.reader.nameWhole = await page.evaluate(() => {
          const name = document.querySelector(".viewer-overlay-current");
          return name !== null && name.scrollWidth <= name.clientWidth;
        });
        NodeAssert.ok(result.reader.nameWhole, `${label}: the viewer cuts the file name`);
        await shot(page, `${label}-reader-focused`);
        await page.keyboard.press("Escape");
        await page.waitForFunction(() => window.fixtureState().focused === null);
      }
      NodeAssert.equal(result.reader.closeText, "Close");
      NodeAssert.ok(result.reader.closeVisible);
      await page.waitForTimeout(50);
      result.reader.focusBack = await activeIs(page, '[data-fixture-link="docs/season-plan.md"]');
      NodeAssert.ok(result.reader.focusBack, `${label}: focus returns to the link`);

      // In front at 200% zoom, then the window widens: "Open beside" moves it to the panel,
      // and closing the panel still hands focus back to the link.
      if (view.name === "zoom200") {
        await link.click();
        await page.waitForFunction(() => window.fixtureState().focused !== null);
        await page.setViewportSize({ width: 1280, height: 900 });
        const move = page.locator("[data-focused-file-move]");
        await page.waitForFunction(() =>
          document.querySelector("[data-focused-file-move]")?.textContent.includes("Open beside"),
        );
        result.openBeside = (await move.textContent()).trim();
        await shot(page, `${label}-open-beside`);
        await move.click();
        await page.waitForFunction(
          () => window.fixtureState().panel !== null && window.fixtureState().focused === null,
        );
        await shot(page, `${label}-moved-to-panel`);
        await page.locator("[data-file-reader-close]").click();
        await page.waitForFunction(() => window.fixtureState().panel === null);
        await page.waitForTimeout(50);
        result.openBesideFocusBack = await activeIs(
          page,
          '[data-fixture-link="docs/season-plan.md"]',
        );
        NodeAssert.ok(result.openBesideFocusBack, `${label}: focus returns after Open beside`);
      }

      await context.close();
    }
  }

  // An offline machine: the list says so once, and its files open as a notice, unasked.
  for (const theme of ["light", "dark"]) {
    const label = `offline-${theme}`;
    const context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      colorScheme: theme,
    });
    const page = await context.newPage();
    page.on("pageerror", (error) => errors.push(`${label}: ${error.message}`));
    await page.goto(`${origin}/files.html?theme=${theme}&offline=1`);
    await openFiles(page);
    const result = { label };
    result.notice = await page.locator("[data-artifact-shelf-notice]").textContent();
    result.states = await page
      .locator("[data-thread-artifact-row]")
      .evaluateAll((items) => [
        ...new Set(items.map((item) => item.dataset.artifactState ?? "none")),
      ]);
    NodeAssert.match(result.notice, /offline/);
    await shot(page, `${label}-files`);
    await row(page, "season-plan.md").locator("[data-thread-artifact]").click();
    const notice = page.locator("[data-unreachable-file]");
    await notice.waitFor();
    result.unreachable = await notice.getAttribute("data-unreachable-file");
    NodeAssert.equal(result.unreachable, `${ROOT}/docs/season-plan.md`);
    await shot(page, `${label}-unreachable`);
    results.push(result);
    await context.close();
  }
} finally {
  await browser.close();
  await NodeFSP.writeFile(
    NodePath.join(output, "results.json"),
    `${JSON.stringify({ origin, results, errors }, null, 2)}\n`,
  );
}
NodeAssert.deepEqual(errors, [], "page errors");
console.log(`files check passed: ${results.length} runs, evidence in ${output}`);
