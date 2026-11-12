// Build first: node node_modules/vite-plus/bin/vp build --config apps/web/tests/picker-calm/vite.config.ts
// Then: node apps/web/tests/picker-calm/verify-usage.mjs /absolute/report-dir [--before]
// Always headless, fictional data. "Limits by account" in the thread's model picker:
// it must scroll to its last account with the wheel, name each account by logo, plan
// and email, and offer the provider's usage page. --before only takes screenshots.
import * as NodeAssert from "node:assert/strict";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const assert = NodeAssert.default;
const { mkdir, readFile, writeFile } = NodeFSP;
const { extname, join, resolve, sep } = NodePath;

process.env.PWDEBUG = "0";
process.env.PLAYWRIGHT_HTML_OPEN = "never";
const { chromium } = process.env.STUDIO_PLAYWRIGHT_MODULE
  ? await import(NodeURL.pathToFileURL(process.env.STUDIO_PLAYWRIGHT_MODULE).href)
  : NodeModule.createRequire(resolve("apps/server/package.json"))("playwright-core");
const axeSource = await readFile(
  NodeModule.createRequire(resolve("apps/web/package.json")).resolve("axe-core/axe.min.js"),
  "utf8",
);

const before = process.argv.includes("--before");
const root = resolve(".artifacts/picker-calm/site");
const output = resolve(process.argv[2] ?? ".artifacts/picker-calm/usage-evidence");
await mkdir(output, { recursive: true });
const MIME = { ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2" };
const server = NodeHttp.createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, "http://localhost").pathname;
    const file = resolve(root, `.${pathname === "/" ? "/index.html" : pathname}`);
    if (!file.startsWith(root + sep)) return void res.writeHead(403).end();
    const body = await readFile(file);
    res.writeHead(200, { "Content-Type": MIME[extname(file)] ?? "text/html" }).end(body);
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const origin = `http://127.0.0.1:${server.address().port}`;
const AXE_RULES = [
  "color-contrast",
  "button-name",
  "link-name",
  "label",
  "aria-command-name",
  "aria-prohibited-attr",
  "role-img-alt",
  "image-alt",
  "svg-img-alt",
];

const checks = [];
const errors = [];
const browser = await chromium.launch({
  headless: true,
  ...(process.env.STUDIO_CHROMIUM_EXECUTABLE
    ? { executablePath: process.env.STUDIO_CHROMIUM_EXECUTABLE }
    : {}),
});
let passed = false;
try {
  const context = await browser.newContext({
    reducedMotion: "reduce",
    timezoneId: "America/New_York",
    locale: "en-US",
  });
  await context.clock.setFixedTime(new Date("2026-11-10T15:00:00Z"));
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.route("**/*", (route) =>
    route.request().url().startsWith(origin) ? route.continue() : route.abort(),
  );
  const settle = () =>
    page.evaluate(async () => {
      await Promise.all(
        document.getAnimations().map((animation) => animation.finished.catch(() => {})),
      );
      await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
    });
  const axe = async (name) => {
    await page.evaluate(axeSource);
    const result = await page.evaluate(
      (rules) => window.axe.run(document, { runOnly: { type: "rule", values: rules } }),
      AXE_RULES,
    );
    const violations = result.violations.map((violation) => ({
      id: violation.id,
      nodes: violation.nodes.map((node) => ({
        target: node.target.join(" "),
        summary: node.failureSummary,
      })),
    }));
    assert.deepEqual(violations, [], `${name}: axe ${JSON.stringify(violations, null, 1)}`);
  };
  const shot = async (name) => {
    await settle();
    await page.screenshot({ path: join(output, `${name}.png`) });
    if (!before) await axe(name);
    checks.push(name);
  };

  for (const theme of ["light", "dark"]) {
    for (const [size, width, height] of [
      ["390", 390, 760],
      ["desktop", 1280, 820],
    ]) {
      const tag = `${size}-${theme}`;
      await page.setViewportSize({ width, height });
      await page.goto(`${origin}/?scene=limits&theme=${theme}`);
      await page.locator("[data-chat-provider-model-picker]").click();
      await page.locator("[data-model-picker-content]").waitFor();
      await page
        .locator("[data-model-picker-content]")
        .getByRole("button", { name: /Limits by account/ })
        .last()
        .click();
      const panel = page.locator("[data-machine-limits]");
      await panel.waitFor();
      await shot(`limits-top-${tag}`);

      // Scroll with the wheel over the panel, the way a person would.
      const box = await panel.boundingBox();
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      for (let step = 0; step < 12; step += 1) await page.mouse.wheel(0, 400);
      await settle();
      const scroll = await panel.evaluate((node) => ({
        top: node.scrollTop,
        room: node.scrollHeight - node.clientHeight,
      }));
      await shot(`limits-scrolled-${tag}`);
      if (!before) {
        assert.ok(scroll.room > 0, `${tag}: the fixture does not overflow`);
        assert.ok(
          scroll.top >= scroll.room - 2,
          `${tag}: wheel left it at ${scroll.top}/${scroll.room}`,
        );
        const text = (await panel.innerText()).replace(/\s+/g, " ");
        for (const banned of [
          "Usage not read",
          "Usage unavailable",
          "No limits reported",
          "Account not reported",
          "A limit belongs to the account",
        ]) {
          assert.ok(!text.includes(banned), `${tag}: the panel prints "${banned}"`);
        }
        // Each account names its plan and email; Claude and Codex link to their usage page.
        assert.match(text, /dev@example\.com/);
        assert.match(text, /Claude Ultra/);
        const links = await panel
          .locator("a[data-usage-link]")
          .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("href")));
        assert.ok(links.includes("https://claude.ai/settings/usage"), `${tag}: no Claude link`);
        assert.ok(links.includes("https://chatgpt.com/#settings/Usage"), `${tag}: no ChatGPT link`);
        assert.ok(
          (await panel.locator("[data-account-header]").count()) >= 6,
          `${tag}: accounts without a header`,
        );
      }
      // The chip says which account when one product is signed in twice.
      await page.goto(`${origin}/?scene=limits&theme=${theme}&account=copilot-personal`);
      const chip = page.locator("[data-chat-provider-model-picker]");
      await chip.waitFor();
      const accountTag = await page
        .locator("[data-model-chip-part=account]")
        .allInnerTexts()
        .catch(() => []);
      await page.locator("main").screenshot({ path: join(output, `chip-two-accounts-${tag}.png`) });
      checks.push(`chip-two-accounts-${tag}`);
      if (before) continue;
      assert.deepEqual(accountTag, ["Personal"], `${tag}: chip account tag`);
      assert.match((await chip.getAttribute("aria-label")) ?? "", /Personal account/);
    }
  }
  assert.deepEqual(errors, [], `page errors: ${errors.join("; ")}`);
  passed = true;
} finally {
  await browser.close();
  server.close();
  await writeFile(
    join(output, "result.json"),
    JSON.stringify({ before, passed, checks, errors, at: new Date().toISOString() }, null, 2),
  );
}
console.log(
  `usage-surfaces: ${checks.length} screenshots${before ? " (before)" : ""} in ${output}`,
);
