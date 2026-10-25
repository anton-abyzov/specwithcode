// Run after building apps/web/tests/design-create/vite.config.ts.
// Serves fixture assets only; no account, provider, network or live store access.
// Headless Chromium; screenshots and report.json go to the directory given as the first argument.
// Light and dark at 360, 768 and 1280 px, and 1280 px at 200% zoom (640 CSS px at 2x).
import * as NodeAssert from "node:assert/strict";
import * as NodeHttp from "node:http";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeModule from "node:module";

const assert = NodeAssert.default;
const { createServer } = NodeHttp;
const { mkdir, readFile, writeFile } = NodeFSP;
const { join, resolve, sep } = NodePath;
const { createRequire } = NodeModule;

process.env.PWDEBUG = "0";
process.env.PLAYWRIGHT_HTML_OPEN = "never";
const require = createRequire(resolve("apps/server/package.json"));
const { chromium } = require(process.env.STUDIO_PLAYWRIGHT_MODULE ?? "playwright-core");
const root = resolve(".artifacts/design-create/site");
const output = resolve(process.argv[2] ?? ".artifacts/design-create/evidence");
await mkdir(output, { recursive: true });

const types = { ".js": "text/javascript", ".css": "text/css", ".html": "text/html" };
const server = createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, "http://localhost").pathname;
    const file = resolve(root, `.${pathname === "/" ? "/index.html" : pathname}`);
    if (!file.startsWith(root + sep)) return res.writeHead(403).end();
    const body = await readFile(file);
    const type = types[file.slice(file.lastIndexOf("."))] ?? "application/octet-stream";
    res.writeHead(200, { "Content-Type": type }).end(body);
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const origin = `http://127.0.0.1:${server.address().port}`;

const SIZES = [
  { name: "360", viewport: { width: 360, height: 780 }, scale: 1 },
  { name: "768", viewport: { width: 768, height: 900 }, scale: 1 },
  { name: "1280", viewport: { width: 1280, height: 900 }, scale: 1 },
  { name: "1280-zoom200", viewport: { width: 640, height: 450 }, scale: 2 },
];

const results = [];
const errors = [];
const check = async (name, fn) => {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (error) {
    results.push({ name, ok: false, error: String(error?.stack ?? error) });
  }
};

let browser;
try {
  browser = await chromium.launch({
    headless: true,
    ...(process.env.STUDIO_CHROMIUM_EXECUTABLE
      ? { executablePath: process.env.STUDIO_CHROMIUM_EXECUTABLE }
      : {}),
  });
  const open = async (theme, scene, size = SIZES[2]) => {
    const page = await browser.newPage({
      reducedMotion: "reduce",
      viewport: size.viewport,
      deviceScaleFactor: size.scale,
      colorScheme: theme,
    });
    page.setDefaultTimeout(15_000);
    page.on("pageerror", (error) => errors.push(`${theme}/${scene}/${size.name}: ${error}`));
    page.on("console", (message) => {
      // The canvas frame's HTML probe is meant to be refused by the frame CSP.
      const probe =
        message.location().url === "about:srcdoc" && /Content Security Policy/.test(message.text());
      if (message.type() === "error" && !probe)
        errors.push(`${theme}/${scene}/${size.name}: ${message.text()}`);
    });
    await page.route("**/*", (route) =>
      route.request().url().startsWith(origin) ? route.continue() : route.abort(),
    );
    await page.goto(`${origin}/?theme=${theme}&scene=${scene}`);
    return page;
  };
  const shot = async (page, name, theme, size) => {
    await page.waitForTimeout(150);
    await page.screenshot({ path: join(output, `${name}-${theme}-${size.name}.png`) });
  };
  const calls = (page) => page.evaluate(() => window.__fixture.calls);
  /** The dialog fits the viewport width and nothing scrolls sideways. */
  const fits = async (page, testId) => {
    const box = await page.getByTestId(testId).boundingBox();
    const width = page.viewportSize().width;
    assert.ok(box !== null, `${testId} visible`);
    assert.ok(box.x >= -1 && box.x + box.width <= width + 1, `${testId} within ${width}px`);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    assert.ok(overflow <= 0, `no sideways scroll (${overflow}px)`);
  };
  const openSelect = async (page, testId) => {
    await page.getByTestId(testId).click();
    await page.getByRole("listbox").waitFor();
  };

  for (const theme of ["light", "dark"]) {
    for (const size of SIZES) {
      await check(
        `${theme} ${size.name}: Design from code offers what the repository has`,
        async () => {
          const page = await open(theme, "from-code-found", size);
          await fits(page, "design-from-code-dialog");
          assert.match(await page.getByTestId("creation-system-trigger").textContent(), /ui-kit/);
          const card = page.getByTestId("creation-system-found-card");
          assert.match(await card.textContent(), /repositories\/harbor\/ui-kit/);
          assert.match(
            await card.textContent(),
            /283 tokens, 321 components, light and dark modes/,
          );
          assert.equal(
            await card.getByTestId("creation-system-swatches").locator("span").count(),
            8,
          );
          await shot(page, "from-code-found", theme, size);
          await openSelect(page, "creation-system-trigger");
          const options = await page.getByRole("option").allTextContents();
          assert.match(options[0], /^ui-kit/);
          assert.match(options[1], /^site/);
          assert.ok(options.at(-1) === "No design system", options.join("|"));
          await shot(page, "from-code-picker", theme, size);
          await page.keyboard.press("Escape");
          await page.getByTestId("design-from-code-start").click();
          const start = (await calls(page)).find((call) => call.label === "start");
          assert.equal(start.value.found.key, "pkg:repositories/harbor/ui-kit");
          assert.equal(start.value.designSystem, null);
          await page.close();
        },
      );

      await check(
        `${theme} ${size.name}: New design in a project with a found system`,
        async () => {
          const page = await open(theme, "new-design-found", size);
          await fits(page, "new-design-dialog");
          await page.getByTestId("creation-system-found-card").waitFor();
          await shot(page, "new-design-found", theme, size);
          await page.close();
        },
      );
    }

    const wide = SIZES[2];
    await check(`${theme}: scan states read plainly and never block Start`, async () => {
      for (const [scene, pattern] of [
        ["from-code-scanning", /Looking for a design system in Harbor app/],
        ["from-code-none", /No tokens or component libraries found in Harbor app/],
        [
          "from-code-failed",
          /Could not scan Harbor app: The project folder is not on this machine/,
        ],
      ]) {
        const page = await open(theme, scene, wide);
        const hint = page.getByTestId(
          scene === "from-code-scanning" ? "creation-system-scanning" : "creation-system-hint",
        );
        assert.match(await hint.textContent(), pattern);
        assert.equal(await page.getByTestId("design-from-code-start").isDisabled(), false);
        await shot(page, scene, theme, wide);
        if (scene === "from-code-failed") {
          await page.getByTestId("creation-system-scan-again").click();
          const scans = (await calls(page)).filter((call) => call.label === "scan");
          assert.deepEqual(scans.at(-1).value, { projectId: "harbor-app", again: true });
        }
        await page.close();
      }
    });

    await check(
      `${theme}: another project's system is copied on Start, not on selection`,
      async () => {
        const page = await open(theme, "from-code-copy", wide);
        await openSelect(page, "creation-system-trigger");
        await page.getByTestId("creation-system-copy").first().click();
        assert.match(
          await page.getByTestId("creation-system-hint").textContent(),
          /copied into Harbor app when you start\. Cancel copies nothing\./,
        );
        assert.equal((await calls(page)).filter((call) => call.label === "copy").length, 0);
        await shot(page, "from-code-copy", theme, wide);
        await page.getByTestId("design-from-code-start").click();
        await page.waitForFunction(() =>
          window.__fixture.calls.some((call) => call.label === "start"),
        );
        const log = await calls(page);
        assert.equal(log.filter((call) => call.label === "copy").length, 1);
        assert.equal(log.find((call) => call.label === "start").value.designSystem, "copied");
        await page.close();
      },
    );

    for (const [scene, trigger, row, button] of [
      [
        "from-code-archived",
        "design-from-code-project",
        "design-from-code-project-unavailable",
        "design-from-code-start",
      ],
      [
        "new-design-archived",
        "new-design-where",
        "new-design-where-unavailable",
        "new-design-create",
      ],
    ]) {
      await check(`${theme}: ${scene} shows the archived project as disabled context`, async () => {
        const page = await open(theme, scene, wide);
        assert.match(
          await page.getByTestId(trigger).textContent(),
          /Archived project, not available here/,
        );
        assert.equal(await page.getByTestId(button).isDisabled(), true);
        await shot(page, scene, theme, wide);
        await openSelect(page, trigger);
        const disabled = await page.getByTestId(row).getAttribute("data-disabled");
        assert.notEqual(disabled, null);
        const titles = await page.getByRole("option").allTextContents();
        assert.equal(titles.filter((title) => title.includes("Old marketing site")).length, 1);
        assert.ok(
          !titles.some((title) => title.startsWith("Aide")) || scene.startsWith("new-design"),
        );
        await shot(page, `${scene}-open`, theme, wide);
        await page.close();
      });
    }

    for (const size of SIZES) {
      await check(`${theme} ${size.name}: refused binding still starts the thread`, async () => {
        const page = await open(theme, "editor-refused", size);
        // Narrow windows lay the thread over the canvas behind a toggle.
        const show = page.getByRole("button", { name: "Show thread" });
        await page.getByTestId("design-canvas").waitFor();
        if (await show.isVisible()) await show.click();
        await page.getByRole("button", { name: "Start a thread" }).click();
        const notice = page.getByTestId("bound-thread-notice");
        await notice.waitFor();
        assert.match(await notice.textContent(), /The agent attaches it itself/);
        const [noticeBox, chatBox] = await Promise.all([
          notice.boundingBox(),
          page.getByTestId("fixture-chat").boundingBox(),
        ]);
        assert.ok(noticeBox.y + noticeBox.height <= chatBox.y + 1, "notice sits above the thread");
        assert.ok(noticeBox.width <= chatBox.width + 1, "notice fits the thread column");
        const share = await page.getByRole("button", { name: "Share", exact: true }).boundingBox();
        assert.ok(share.x + share.width <= size.viewport.width, "Share stays on screen");
        const crumbs = page.getByTestId("design-breadcrumb");
        const title = page.getByRole("textbox", { name: "Design title" });
        if (await crumbs.isVisible()) {
          const [a, b] = [await crumbs.boundingBox(), await title.boundingBox()];
          assert.ok(a.x + a.width <= b.x + 1, "crumbs end before the title");
        }
        await shot(page, "editor-refused", theme, size);
        await page.close();
      });
    }

    await check(`${theme}: the editor shows where a reused system comes from`, async () => {
      const page = await open(theme, "editor-reuse", wide);
      await page.getByTestId("design-reuse-chip").click();
      const details = page.getByTestId("design-reuse-details");
      await details.waitFor();
      assert.match(await details.textContent(), /Reuses ui-kit/);
      assert.match(await details.textContent(), /Found in this repository on October 23, 2026/);
      await shot(page, "editor-reuse", theme, wide);
      await page.close();
    });
  }
} finally {
  await browser?.close();
  server.close();
}

const failed = results.filter((result) => !result.ok);
await writeFile(
  join(output, "report.json"),
  JSON.stringify({ origin: "fixture", results, errors }, null, 2),
);
console.log(
  `${results.length - failed.length}/${results.length} checks passed; ${errors.length} page errors`,
);
for (const result of failed) console.log(`FAIL ${result.name}\n${result.error}`);
for (const error of errors) console.log(`ERROR ${error}`);
process.exit(failed.length > 0 || errors.length > 0 ? 1 : 0);
