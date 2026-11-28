// Build first: node node_modules/vite-plus/bin/vp build --config apps/web/tests/picker-open-model/vite.config.ts
// Then: node apps/web/tests/picker-open-model/verify.mjs /absolute/report-dir
// Always headless. Serves the fixture only; every other request is aborted. Fictional data.
// Checks the picker's open-model routes (increment 1513, AC-03): a DeepSeek "Your key"
// group and an Ollama "Local" group, each with one route pill whose tooltip carries the
// list-price note, no "Subscription" and no plan usage link, beside an unchanged Claude
// plan group. Saves screenshots in light and dark and runs axe for contrast and names.
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

const root = resolve(".artifacts/picker-open-model/site");
const output = resolve(process.argv[2] ?? ".artifacts/picker-open-model/evidence");
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
  "aria-input-field-name",
  "aria-command-name",
  "role-img-alt",
  "image-alt",
  "svg-img-alt",
];
const ROUTES = [
  {
    group: "deepseek-key",
    pill: "Your key",
    note: "DeepSeek bills your key at its own list price.",
    icon: "perToken",
    model: "deepseek-flash",
  },
  {
    group: "ollama-local",
    pill: "Local",
    note: "Runs on your own Ollama.",
    icon: "local",
    model: "qwen3-coder",
  },
];

const checks = [];
const notes = [];
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
  await context.clock.setFixedTime(new Date("2026-11-28T15:00:00Z"));
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
      nodes: violation.nodes.map((node) => node.target.join(" ")),
    }));
    assert.deepEqual(violations, [], `${name}: axe violations ${JSON.stringify(violations)}`);
  };
  // The group header and the rows up to the next header.
  const groupText = (group) =>
    page.evaluate((key) => {
      const header = document.querySelector(`[data-model-picker-group$="${key}"]`);
      if (!header) return null;
      const parts = [header.textContent];
      const option = header.closest("[role=option]") ?? header;
      for (let node = option.nextElementSibling; node; node = node.nextElementSibling) {
        if (node.querySelector("[data-model-picker-group]")) break;
        parts.push(node.textContent);
      }
      return parts.join(" ");
    }, group);

  for (const theme of ["light", "dark"]) {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`${origin}/?theme=${theme}`);
    await page.locator("[data-chat-provider-model-picker]").click();
    await page.locator("[data-model-picker-content]").waitFor();
    // The grouped list: every provider under its own header.
    await page.locator('[data-model-picker-content] button[aria-label="All"]').click();
    await settle();

    // The Claude plan group is unchanged: its plan pill and usage link.
    const claude = page.locator('[data-model-picker-group$="claudeAgent"]');
    await claude.waitFor();
    assert.equal(
      await claude.locator('[data-model-picker-group-plan=""]').innerText(),
      "Max subscription",
    );
    assert.equal(await claude.locator('a[href*="claude.ai/settings/usage"]').count(), 1);

    for (const route of ROUTES) {
      const header = page.locator(`[data-model-picker-group$="${route.group}"]`);
      await header.waitFor();
      const pills = header.locator("[data-model-picker-group-plan]");
      assert.equal(await pills.count(), 1, `${route.group}: one plan pill`);
      assert.equal(await pills.getAttribute("data-model-picker-group-plan"), "open-model");
      assert.equal(await pills.innerText(), route.pill);
      assert.equal(await header.locator("a").count(), 0, `${route.group}: a usage link`);
      const text = await groupText(route.group);
      assert.ok(text, `${route.group}: no group`);
      assert.ok(!/subscription/i.test(text), `${route.group} says Subscription: ${text}`);
      // The server stamps auth.label with the same words; the header says them once.
      const headerText = await header.innerText();
      assert.equal(headerText.split(route.pill).length - 1, 1, `${route.group}: ${headerText}`);
      // The row's billing icon.
      const icon = page
        .locator(`[role=option]:has-text("${route.model}")`)
        .locator(`[data-model-status-icon="${route.icon}"]`)
        .first();
      assert.equal(await icon.count(), 1, `${route.group}: no ${route.icon} icon`);

      // The pill's tooltip carries the list-price note.
      await pills.hover();
      const popup = page.locator("[data-slot=tooltip-popup], [role=tooltip]").filter({
        hasText: route.note,
      });
      await popup.first().waitFor();
      await settle();
      if (theme === "light" && route.group === "deepseek-key") {
        await page.screenshot({ path: join(output, "picker-open-model.png") });
      }
      await page.screenshot({ path: join(output, `pill-${route.group}-${theme}.png`) });
      checks.push(`pill-${route.group}-${theme}`);

      // The row's billing tooltip ends with the same note.
      await icon.hover();
      const rowPopup = page
        .locator("[data-slot=tooltip-popup], [role=tooltip]")
        .filter({ hasText: route.icon === "local" ? "Local model" : "per token" });
      await rowPopup.first().waitFor();
      const rowText = (await rowPopup.first().innerText()).trim();
      assert.ok(rowText.endsWith(route.note), `${route.group} row tooltip: "${rowText}"`);
      assert.ok(!/subscription/i.test(rowText), `${route.group} row tooltip: "${rowText}"`);
      checks.push(`row-note-${route.group}-${theme}`);
      await page.mouse.move(0, 0);
      await settle();
    }
    await axe(`picker-${theme}`);
    await page.screenshot({ path: join(output, `picker-${theme}.png`) });
    checks.push(`picker-${theme}`);
  }
  assert.deepEqual(errors, [], `page errors: ${errors.join("; ")}`);
  passed = true;
} finally {
  await browser.close();
  server.close();
  await writeFile(
    join(output, "result.json"),
    JSON.stringify({ passed, checks, notes, errors, at: new Date().toISOString() }, null, 2),
  );
}
console.log(`picker-open-model: ${checks.length} checks, axe clean, in ${output}`);
for (const note of notes) console.log(`note: ${note}`);
