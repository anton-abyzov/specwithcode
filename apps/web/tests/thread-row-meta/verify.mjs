// Build first: vp build --config apps/web/tests/thread-row-meta/vite.config.ts
// Supply the installed Playwright entry via STUDIO_PLAYWRIGHT_MODULE. Always headless.
// Usage: node apps/web/tests/thread-row-meta/verify.mjs [/absolute/evidence-dir]
// THREAD_ROW_MEASURE_ONLY=1 records what a build shows without asserting (a before capture).
import * as NodeAssert from "node:assert/strict";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
process.env.PWDEBUG = "0";
process.env.PLAYWRIGHT_HTML_OPEN = "never";
const { chromium } = await import(NodeURL.pathToFileURL(process.env.STUDIO_PLAYWRIGHT_MODULE).href);
const measureOnly = process.env.THREAD_ROW_MEASURE_ONLY === "1";
const root = NodePath.resolve(".artifacts/thread-row-meta/site");
const output = NodePath.resolve(process.argv[2] ?? ".artifacts/thread-row-meta/evidence");
await NodeFSP.mkdir(output, { recursive: true });
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
const receipt = { headless: true, measureOnly, checks: [], rows: [], screenshots: [] };
const check = (name, fn) => {
  if (measureOnly) return;
  fn();
  receipt.checks.push(name);
};

// What each meta line shows: its chips in order, whether any overlap or spill out of the
// line, and which texts are cut short.
const readRows = () =>
  [...document.querySelectorAll(".sws-thread-row")].map((row) => {
    const meta = row.querySelector(".sws-thread-meta");
    const box = meta.getBoundingClientRect();
    const rect = (el) => {
      const r = el.getBoundingClientRect();
      return {
        left: r.left,
        right: r.right,
        top: r.top,
        bottom: r.bottom,
        width: r.width,
        height: r.height,
      };
    };
    const chips = [
      ...meta.querySelectorAll(".sws-thread-meta-lead > *, .sws-thread-meta-rest > *"),
    ].map((child) => ({
      className: child.className,
      text: child.textContent.replace(/\s+/g, " ").trim(),
      ...rect(child),
      hidden: child.getBoundingClientRect().top >= box.bottom - 0.5,
      separator: getComputedStyle(child, "::before").content,
    }));
    const model = meta.querySelector(".sws-model");
    const name = meta.querySelector(".sws-model-name");
    const state = meta.querySelector(".sws-model-state");
    const shown = (selector) => {
      const el = state?.querySelector(selector);
      return !!el && getComputedStyle(el).display !== "none";
    };
    return {
      id: row.getAttribute("data-thread-id"),
      metaWidth: box.width,
      metaTop: box.top,
      metaBottom: box.bottom,
      metaRight: box.right,
      chips,
      unplanned: (() => {
        const tag = meta.querySelector("[data-thread-unplanned]");
        if (!tag) return null;
        const glyph = tag.querySelector("[data-unplanned-glyph]");
        return {
          width: tag.getBoundingClientRect().width,
          glyph: !!glyph,
          glyphWidth: glyph?.getBoundingClientRect().width ?? 0,
          tinted: !!glyph && getComputedStyle(glyph).color === getComputedStyle(tag).color,
          aria: tag.querySelector(".sr-only")?.textContent ?? "",
          pill: getComputedStyle(tag).boxShadow !== "none",
        };
      })(),
      modelCut: name ? name.scrollWidth > name.clientWidth + 1 : false,
      state: state
        ? {
            kind: state.dataset.modelState,
            ...rect(state),
            border: parseFloat(getComputedStyle(state).borderTopWidth),
            full: shown(".sws-model-state-full"),
            short: shown(".sws-model-state-short"),
            aria: state.querySelector(".sr-only")?.textContent,
            // Words or parts after the glyph: none for a fallback.
            parts: state.querySelectorAll("[data-row-part]").length,
            iconWidth: state.querySelector("svg")?.getBoundingClientRect().width ?? 0,
            color: getComputedStyle(state).color,
            muted: getComputedStyle(meta).color,
            modelSeparator: getComputedStyle(model, "::before").content,
            suffixSeparator: getComputedStyle(state, "::before").content,
          }
        : null,
    };
  });

try {
  for (const theme of ["light", "dark"]) {
    for (const width of [360, 520, 900]) {
      const page = await browser.newPage({
        viewport: { width, height: 560 },
        deviceScaleFactor: 2,
        colorScheme: theme,
      });
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(`${origin}/?theme=${theme}`);
      await page.waitForSelector("body[data-fixture-ready]");
      await page.waitForSelector(".sws-thread-row[data-thread-id=matchcam] .sws-thread-meta");
      const rows = await page.evaluate(readRows);
      receipt.rows.push({ theme, width, rows });
      check(`${theme} ${width}px: no page errors`, () => NodeAssert.deepEqual(errors, []));
      for (const row of rows) {
        const shown = row.chips.filter((chip) => !chip.hidden && chip.width > 1);
        check(`${theme} ${width}px ${row.id}: no overlap or partial chips`, () => {
          for (let index = 0; index < shown.length; index++) {
            const chip = shown[index];
            NodeAssert.ok(
              chip.top >= row.metaTop - 0.5 && chip.bottom <= row.metaBottom + 0.5,
              chip.text,
            );
            NodeAssert.ok(chip.right <= row.metaRight + 0.5, `${chip.text} clips horizontally`);
            if (index)
              NodeAssert.ok(chip.left >= shown[index - 1].right - 0.5, `${chip.text} overlaps`);
          }
        });
        check(`${theme} ${width}px ${row.id}: model reads in full`, () =>
          NodeAssert.equal(row.modelCut, false),
        );
        if (row.unplanned)
          check(`${theme} ${width}px ${row.id}: No increment is a named glyph, not a pill`, () => {
            NodeAssert.ok(row.unplanned.glyph);
            // The glyph and the row's separator dot; the old pill took about 70px.
            NodeAssert.ok(row.unplanned.glyphWidth >= 13 && row.unplanned.width <= 32);
            NodeAssert.ok(row.unplanned.tinted);
            NodeAssert.equal(row.unplanned.pill, false);
            NodeAssert.match(row.unplanned.aria, /No increment: changed code without an increment/);
          });
        if (row.state) {
          check(`${theme} ${width}px ${row.id}: state is an inline accessible suffix`, () => {
            NodeAssert.equal(row.state.border, 0);
            NodeAssert.ok(row.state.height <= 18);
            NodeAssert.ok(row.state.iconWidth >= 11);
            NodeAssert.ok(row.state.aria.length > 0);
            NodeAssert.ok(["none", "normal"].includes(row.state.suffixSeparator));
            // Only the model unit gets a separator, never its nested suffix.
            NodeAssert.equal(
              row.chips.filter((c) => c.className.includes("sws-model-state")).length,
              0,
            );
          });
          check(`${theme} ${width}px ${row.id}: suffix follows the measured width tier`, () => {
            // A fallback is its glyph alone at every width; other states keep words.
            const words = row.state.kind !== "fallback";
            NodeAssert.equal(row.state.full, words && row.metaWidth >= 480);
            NodeAssert.equal(row.state.short, words && row.metaWidth < 480 && row.metaWidth >= 340);
            NodeAssert.equal(row.state.parts, 0, JSON.stringify(row.state));
          });
          if (row.state.kind === "preferred")
            check(`${theme} ${width}px: preferred stays muted`, () =>
              NodeAssert.equal(row.state.color, row.state.muted),
            );
        }
      }
      const twin = rows.find((row) => row.id === "twin");
      check(`${theme} ${width}px: same-name fallback is a glyph, named in full for readers`, () => {
        NodeAssert.equal(twin.state.kind, "fallback");
        NodeAssert.equal(twin.state.full || twin.state.short, false);
        NodeAssert.match(twin.state.aria, /fallback for Codex · GPT-6\.1-Sol/);
      });
      const fallback = rows.find((row) => row.id === "matchcam");
      check(`${theme} ${width}px: fallback accessible name names its pick`, () =>
        NodeAssert.match(fallback.state.aria, /fallback for Claude Code · Opus 5\.5/),
      );
      if (width >= 520) {
        const chip = page.locator("[data-header-fixture] .sws-model-chip");
        const headerTabIndex = await chip.getAttribute("tabindex");
        check(`${theme} ${width}px: header is focusable`, () =>
          NodeAssert.equal(headerTabIndex, "0"),
        );
        NodeAssert.equal(await chip.locator(".sws-model-state").count(), 1);
        await chip.focus();
        await page.waitForSelector("[data-slot='tooltip-popup']", { timeout: 3000 });
        NodeAssert.match(
          await page.locator("[data-slot='tooltip-popup']").textContent(),
          /Fallback for your pick/,
        );
        await page.locator("h2").first().click();
      }
      const disk = rows.find((row) => row.id === "diskaudit");
      check(
        `${theme} ${width}px: disk audit fallback is a glyph beside GPT-6-Astra, no pill`,
        () => {
          NodeAssert.equal(disk?.state?.kind, "fallback");
          NodeAssert.equal(disk.state.full || disk.state.short, false);
          NodeAssert.equal(disk.state.border, 0);
          NodeAssert.ok(disk.state.iconWidth >= 13 && disk.state.iconWidth <= 15);
          NodeAssert.equal(disk.modelCut, false);
          NodeAssert.match(disk.state.aria, /fallback for Claude Code · Opus 5\.5/);
        },
      );
      await page
        .locator(".sws-thread-row[data-thread-id=diskaudit]")
        .screenshot({ path: NodePath.join(output, `disk-audit-row-${width}-${theme}.png`) });
      receipt.screenshots.push(NodePath.join(output, `disk-audit-row-${width}-${theme}.png`));
      const file = NodePath.join(output, `thread-rows-${width}-${theme}.png`);
      await page.locator("[data-fixture-pane]").screenshot({ path: file });
      receipt.screenshots.push(file);
      if (width === 900) {
        // The tooltip keeps what the compact form leaves out.
        await page.locator(".sws-thread-row[data-thread-id=matchcam] .sws-model").hover();
        await page.waitForSelector("[data-slot='tooltip-popup']", { timeout: 3000 });
        const tip = path(output, `thread-rows-tooltip-${theme}.png`);
        await page.screenshot({ path: tip });
        receipt.screenshots.push(tip);
        // A same-named model on another provider: the tip names both providers.
        await page.mouse.move(0, 0);
        await page.locator("[data-slot='tooltip-popup']").waitFor({ state: "detached" });
        await page.locator(".sws-thread-row[data-thread-id=twin] .sws-model").hover();
        const twinTip = page.locator("[data-slot='tooltip-popup']", { hasText: "Devin" });
        await twinTip.waitFor({ timeout: 3000 });
        const twinText = await twinTip.textContent();
        check(`${theme}: same-name fallback names the pick's provider`, () => {
          NodeAssert.match(twinText, /Devin · GPT-6\.1 Sol/);
          NodeAssert.match(twinText, /Fallback for your pick, Codex · GPT-6\.1-Sol/);
        });
        const twinShot = path(output, `thread-rows-twin-tooltip-${theme}.png`);
        await page.screenshot({ path: twinShot });
        receipt.screenshots.push(twinShot);
        // The No increment glyph names itself on hover.
        await page.mouse.move(0, 0);
        await page.locator("[data-thread-id=business] [data-thread-unplanned]").hover();
        const unplannedTip = page.locator("[data-slot='tooltip-popup']", {
          hasText: "No increment",
        });
        await unplannedTip.waitFor({ timeout: 3000 });
        const unplannedText = await unplannedTip.textContent();
        check(`${theme}: No increment tooltip explains the glyph`, () =>
          NodeAssert.match(
            unplannedText,
            /Changed code without an increment. Increments are recommended, not required./,
          ),
        );
        const tip2 = path(output, `thread-rows-unplanned-tooltip-${theme}.png`);
        await page.screenshot({ path: tip2 });
        receipt.screenshots.push(tip2);
      }
      await page.close();
    }
  }
  await NodeFSP.writeFile(
    NodePath.join(output, "rows-receipt.json"),
    JSON.stringify(receipt, null, 2),
  );
  console.log(
    measureOnly
      ? `thread row meta measured; evidence in ${output}`
      : `thread row meta ok: ${receipt.checks.length} checks; evidence in ${output}`,
  );
} finally {
  await browser.close();
  server.close();
}

function path(...parts) {
  return NodePath.join(...parts);
}
