// Headless check of the question card and queue stacked above the composer on
// small screens: a 14-inch laptop, the narrow side panel and a short window,
// in light and dark. Usage:
//   node apps/web/tests/compact-stack/verify.mjs /absolute/report-dir [--baseline] [--label before]
// --baseline records the measurements and screenshots without failing.
import * as NodeAssert from "node:assert/strict";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const assert = NodeAssert.default;
const fs = NodeFSP;
const path = NodePath;

process.env.PWDEBUG = "0";
process.env.PLAYWRIGHT_HTML_OPEN = "never";
const root = path.resolve(path.dirname(NodeURL.fileURLToPath(import.meta.url)), "../../../..");
const site = path.join(root, ".artifacts/compact-stack/site");
const args = process.argv.slice(2);
const baseline = args.includes("--baseline");
const labelIndex = args.indexOf("--label");
const label = labelIndex === -1 ? (baseline ? "before" : "after") : args[labelIndex + 1];
const outputArg = args.find((arg, index) => !arg.startsWith("--") && args[index - 1] !== "--label");
const output = path.resolve(outputArg ?? path.join(root, ".artifacts/compact-stack/evidence"));
await fs.mkdir(output, { recursive: true });
const { chromium } = NodeModule.createRequire(import.meta.url)(
  process.env.STUDIO_PLAYWRIGHT_MODULE ??
    path.join(
      NodeOS.homedir(),
      ".cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright",
    ),
);

const server = NodeHttp.createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, "http://localhost").pathname;
    const file = path.resolve(site, `.${pathname === "/" ? "/index.html" : pathname}`);
    if (!file.startsWith(`${site}${path.sep}`)) {
      res.writeHead(403).end();
      return;
    }
    const mime =
      { ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2" }[
        path.extname(file)
      ] ?? "text/html";
    res.writeHead(200, { "Content-Type": mime });
    res.end(await fs.readFile(file));
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

const viewports = [
  { name: "laptop-1512x945", width: 1512, height: 945 },
  { name: "side-panel-480x945", width: 480, height: 945 },
  { name: "short-1512x700", width: 1512, height: 700 },
  { name: "short-side-panel-480x700", width: 480, height: 700 },
];

/** Geometry of the stack, the pill and the visible timeline, in CSS pixels. */
const measure = (page) =>
  page.evaluate(() => {
    const rect = (element) => element?.getBoundingClientRect() ?? null;
    const body = rect(document.querySelector("[data-fixture-panel-body]"));
    const main = rect(document.querySelector('[data-chat-composer-main-surface="true"]'));
    const attachments = Array.from(
      document.querySelectorAll('[data-composer-banner-surface="attached"]'),
      (element) => element.getBoundingClientRect(),
    );
    const stackTop = Math.min(...attachments.map((attachment) => attachment.top));
    const pill = rect(document.querySelector("[data-jump-to-latest]"));
    const options = Array.from(document.querySelectorAll("[data-question-option]"), (element) =>
      Math.round(element.getBoundingClientRect().height),
    );
    return {
      panelHeight: Math.round(body.height),
      stackHeight: Math.round(main.top - stackTop),
      stackShare: Number(((main.top - stackTop) / body.height).toFixed(3)),
      timelineVisible: Math.round(stackTop - body.top),
      pillBottom: pill ? Math.round(pill.bottom) : null,
      stackTop: Math.round(stackTop),
      pillOverlapsStack: pill ? pill.bottom > stackTop + 0.5 : false,
      optionHeights: options,
      queueListHidden:
        document.querySelector("ol")?.closest("[data-slot=scroll-area]")?.offsetParent === null ||
        document.querySelector("ol")?.offsetParent === null,
    };
  });

let browser;
const receipt = { headless: true, label, baseline, cases: [] };
try {
  browser = await chromium.launch({
    headless: true,
    ...(process.env.STUDIO_CHROMIUM_EXECUTABLE
      ? { executablePath: process.env.STUDIO_CHROMIUM_EXECUTABLE }
      : {}),
  });
  for (const theme of ["light", "dark"]) {
    for (const viewport of viewports) {
      const context = await browser.newContext({
        viewport: { width: viewport.width, height: viewport.height },
        colorScheme: theme,
      });
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(`${origin}/?theme=${theme}`);
      await page.locator("[data-question-option]").first().waitFor();
      await page.waitForTimeout(150);
      const metrics = await measure(page);
      const shot = path.join(output, `${label}-${viewport.name}-${theme}.png`);
      await page.screenshot({ path: shot });
      const entry = { theme, viewport: viewport.name, metrics, screenshot: shot };
      if (!baseline) {
        // About 40% of the panel at most, and the thread body stays in view.
        assert.ok(
          metrics.stackShare <= 0.45,
          `${viewport.name} ${theme}: stack ${metrics.stackShare}`,
        );
        assert.ok(!metrics.pillOverlapsStack, `${viewport.name} ${theme}: Jump to latest overlaps`);
        // With room for every description the card shows them all and stays
        // still on hover; otherwise one line per option until hovered or focused.
        const optionsLayout = await page
          .locator("[data-question-card]")
          .getAttribute("data-question-options");
        entry.optionsLayout = optionsLayout;
        const compact = optionsLayout === "compact";
        if (compact) {
          for (const height of metrics.optionHeights) assert.ok(height <= 36, `option ${height}px`);
        } else {
          assert.equal(optionsLayout, "all", `options layout ${optionsLayout}`);
        }
        assert.equal(await page.locator("[data-question-recommended]").count(), 1);
        // The queue is one line, its list folded away.
        assert.equal(metrics.queueListHidden, true, "queue list folded by default");
        assert.equal(await page.locator("[data-queue-reason]").count(), 0, "no steer paragraph");

        // Compact: hover expands an option's description; leaving folds it
        // again. All open: hover changes nothing.
        const optionB = page.locator('[data-question-option="B"]');
        const before = (await optionB.boundingBox()).height;
        await optionB.hover();
        await page.waitForTimeout(400);
        const hovered = (await optionB.boundingBox()).height;
        entry.hoverExpands = hovered > before;
        if (!compact) assert.equal(hovered, before, "hover leaves an open card still");
        else if (viewport.width < 1000) assert.ok(hovered > before, "hover shows the full description");
        await page.screenshot({
          path: path.join(output, `${label}-${viewport.name}-${theme}-hover.png`),
        });
        await page.mouse.move(2, 2);
        await page.waitForTimeout(100);
        // Keyboard focus expands too, without picking the option. With every
        // description open it leaves the card as it was.
        const beforeFocus = await measure(page);
        await page.locator('[data-question-option="C"]').focus();
        await page
          .locator('[data-question-option="C"][data-expanded="true"]')
          .waitFor({ timeout: 2000 });
        assert.equal(await page.locator("[data-fixture-result]").innerText(), "waiting");
        if (compact) {
          // The details toggle pins one open for touch, again without picking it.
          await page.locator('[data-question-option="A"] [data-question-option-details]').click();
          await page
            .locator('[data-question-option="A"][data-expanded="true"]')
            .waitFor({ timeout: 2000 });
          assert.equal(await page.locator("[data-fixture-result]").innerText(), "waiting");
        } else {
          assert.equal(await page.locator("[data-question-option-details]").count(), 0);
          assert.deepEqual(
            (await measure(page)).optionHeights,
            beforeFocus.optionHeights,
            "focus leaves an open card still",
          );
        }

        // Collapse to one line; the thread remembers it across a reload.
        await page.locator("[data-pending-user-input-toggle]").click();
        const summary = await page.locator("[data-question-summary]").textContent();
        assert.match(summary, /^Question: .+ · 3 options$/s);
        await page.waitForTimeout(400); // the fold animates
        entry.collapsed = await measure(page);
        assert.ok(!entry.collapsed.pillOverlapsStack, "Jump to latest clears the folded card");
        await page.screenshot({
          path: path.join(output, `${label}-${viewport.name}-${theme}-collapsed.png`),
        });
        await page.reload();
        await page.locator("[data-question-summary]").waitFor();
        assert.equal(
          await page
            .locator("[data-pending-user-input-toggle]")
            .getAttribute("data-pending-user-input-toggle"),
          "collapsed",
        );
        // Another thread still opens its card.
        await page.goto(`${origin}/?theme=${theme}&thread=thread-other`);
        await page.locator("[data-question-option]").first().waitFor();
        await page.locator("[data-pending-user-input-toggle='expanded']").waitFor();

        // A queue with a message of the person's own shows the short steer hint.
        await page.goto(`${origin}/?theme=${theme}&thread=thread-mixed&queue=mixed`);
        const hint = page.locator("[data-queue-steer-hint]");
        await hint.waitFor();
        // Visible words only; the full reason is in its tooltip and for screen readers.
        const visibleHint = await hint.evaluate((node) => node.firstChild?.textContent ?? "");
        assert.ok(visibleHint.length <= 24, `steer hint is short: ${visibleHint}`);
        assert.ok((await hint.boundingBox()).height <= 20, "steer hint is one line");
        assert.match(
          await hint.getAttribute("data-queue-steer-reason"),
          /No provider turn is running/,
        );
        await page.locator('[aria-label="Expand queued messages"]').click();
        await page.waitForTimeout(300);
        const open = await measure(page);
        entry.queueOpen = open;
        assert.equal(open.queueListHidden, false, "queue expands on click");
        assert.ok(!open.pillOverlapsStack, "Jump to latest clears the open queue");
        await page.screenshot({
          path: path.join(output, `${label}-${viewport.name}-${theme}-queue-open.png`),
        });
        assert.deepEqual(errors, []);
      }
      entry.errors = errors;
      receipt.cases.push(entry);
      await context.close();
    }
  }
  await fs.writeFile(
    path.join(output, `${label}-receipt.json`),
    `${JSON.stringify(receipt, null, 2)}\n`,
  );
  console.log(`compact stack ${baseline ? "recorded" : "verified"}; evidence in ${output}`);
  for (const entry of receipt.cases) {
    console.log(
      `${entry.theme} ${entry.viewport}: stack ${entry.metrics.stackHeight}px of ${entry.metrics.panelHeight}px (${entry.metrics.stackShare}), timeline visible ${entry.metrics.timelineVisible}px, pill overlaps ${entry.metrics.pillOverlapsStack}, options ${entry.metrics.optionHeights.join("/")}`,
    );
  }
} finally {
  await browser?.close();
  server.close();
}
