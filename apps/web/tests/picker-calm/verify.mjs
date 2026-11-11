// Build first: node node_modules/vite-plus/bin/vp build --config apps/web/tests/picker-calm/vite.config.ts
// Then: node apps/web/tests/picker-calm/verify.mjs /absolute/report-dir
// Always headless. Serves the fixture only; every other request is aborted. Fictional data.
// Checks the calm picker (empty query, "carbon", "fast", a typo, signed-out Cursor), the
// Models popover and a composer for two machines, in light and dark at 390px and desktop
// width; saves a screenshot of each and runs axe for contrast and accessible names.
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

const root = resolve(".artifacts/picker-calm/site");
const output = resolve(process.argv[2] ?? ".artifacts/picker-calm/evidence");
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
const NOW = new Date("2026-11-10T15:00:00Z");
// The rules AC-16 names: text contrast, and a name on every control and image.
const AXE_RULES = [
  "color-contrast",
  "button-name",
  "link-name",
  "label",
  "aria-input-field-name",
  "aria-toggle-field-name",
  "aria-command-name",
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
  await context.clock.setFixedTime(NOW);
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
        html: node.html.slice(0, 160),
        summary: node.failureSummary,
      })),
    }));
    assert.deepEqual(
      violations,
      [],
      `${name}: axe violations ${JSON.stringify(violations, null, 1)}`,
    );
  };
  const shot = async (name) => {
    await settle();
    await page.screenshot({ path: join(output, `${name}.png`) });
    await axe(name);
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
      `${name}: page scrolls sideways`,
    );
    checks.push(name);
  };
  const rows = () =>
    page
      .locator("[data-model-picker-content] [role=option]")
      .evaluateAll((nodes) => nodes.map((node) => node.textContent.replace(/\s+/g, " ").trim()));
  const headings = () =>
    page
      .locator("[data-model-search-group], [data-model-search-older]")
      .evaluateAll((nodes) =>
        nodes.map((node) => node.getAttribute("data-model-search-group") ?? node.textContent),
      );
  const search = async (query) => {
    const input = page.locator("[data-model-picker-content] input[data-slot=combobox-input]");
    await input.fill(query);
    await settle();
  };

  for (const theme of ["light", "dark"]) {
    for (const [size, width] of [
      ["390", 390],
      ["desktop", 1280],
    ]) {
      const tag = `${size}-${theme}`;
      await page.setViewportSize({ width, height: 900 });

      // The picker: nothing typed.
      await page.goto(`${origin}/?scene=picker&theme=${theme}`);
      await page.locator("[data-chat-provider-model-picker]").click();
      await page.locator("[data-model-picker-content]").waitFor();
      await settle();
      const text = await page.locator("[data-model-picker-content]").innerText();
      assert.ok(
        !/Billing unverified|Usage not read/.test(text),
        "a row prints the old status text",
      );
      assert.equal(
        await page.locator("[data-model-picker-title]").innerText(),
        "Choosing Model for this thread",
      );
      assert.equal(await page.locator("[data-model-row-effort]").count(), 0, "a row shows effort");
      assert.ok(
        (await page.locator("[data-model-picker-limit-chip]").count()) >= 1,
        "the limits strip has no chip",
      );
      assert.ok(
        (await page.locator("[data-model-picker-limit-chip]").count()) <= 4,
        "the limits strip shows more than four chips",
      );
      assert.equal(
        await page
          .locator("[data-model-picker-limit-chip]")
          .first()
          .getAttribute("data-model-picker-limit-chip"),
        "full",
        "the worst limit is not first",
      );
      // One line per provider row: the logo, a short label, status icons.
      const heights = await page
        .locator("[data-model-picker-content] [role=option]:has([data-model-row-account])")
        .evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().height));
      assert.ok(
        heights.length > 0 && heights.every((height) => height <= 40),
        `tall rows ${heights}`,
      );
      const labels = await page
        .locator("[data-model-row-account]")
        .evaluateAll((nodes) => [...new Set(nodes.map((node) => node.textContent))]);
      for (const label of ["Ultra subscription", "Enterprise", "Personal"]) {
        assert.ok(labels.includes(label), `no row labelled ${label}: ${labels}`);
      }
      for (const kind of ["usage", "limit", "unknown", "perToken", "new"]) {
        assert.ok(
          (await page.locator(`[data-model-status-icon="${kind}"]`).count()) > 0,
          `no ${kind} status icon`,
        );
      }
      // A filled star always shows; an empty one and the shortcut wait for hover or focus.
      assert.equal(
        await page
          .locator('[data-model-row-star="on"]')
          .first()
          .evaluate((node) => getComputedStyle(node).opacity),
        "1",
      );
      await shot(`picker-empty-${tag}`);

      // "carbon": Gemini 4 Carbon and nothing else, marked, with Cursor offered as a sign-in.
      await search("carbon");
      assert.deepEqual(await headings(), ["Gemini 4 Carbon"]);
      assert.equal((await rows()).length, 1);
      assert.equal(await page.locator("[data-model-search-mark]").innerText(), "Carbon");
      assert.match(
        await page.locator("[data-model-search-sign-in]").innerText(),
        /Cursor also offers Gemini 4 Carbon\. It's signed out on M4\./,
      );
      assert.equal(await page.locator("[data-model-picker-sign-in-mark]").count(), 1);
      // Providers without a match leave the rail.
      assert.equal(
        await page.locator('[data-model-picker-provider="codex"]').count(),
        0,
        "a provider without a match stays on the rail",
      );
      await shot(`picker-carbon-${tag}`);

      // "fast": a removable chip, and only models with Fast mode or a small size.
      await search("fast");
      assert.equal(await page.locator('[data-model-search-capability="fast"]').innerText(), "Fast");
      const fast = await headings();
      assert.ok(fast.includes("Claude Opus 5.5") && fast.includes("GPT-6.1 Sol"), `fast: ${fast}`);
      assert.ok(!fast.includes("Gemini 4 Carbon"), "fast lists a model without Fast mode");
      await shot(`picker-fast-${tag}`);

      // A typo: nothing matches directly, so near-misses are offered under their own label.
      await search("cabron");
      assert.equal(
        await page.locator("[data-model-search-closest]").innerText(),
        "CLOSEST MATCHES",
      );
      assert.deepEqual(await headings(), ["Gemini 4 Carbon"]);
      await shot(`picker-typo-${tag}`);

      // Nothing close: the empty state says so, and the signed-out provider is still offered.
      await search("cursor zzzz");
      assert.equal((await rows()).length, 0);
      assert.match(await page.locator("[data-model-search-empty]").innerText(), /none is close/);
      await search("gemini");
      assert.match(
        await page.locator("[data-model-search-sign-in]").innerText(),
        /Cursor also offers Gemini 4 Carbon/,
      );
      await shot(`picker-signed-out-${tag}`);

      // The Models popover.
      await page.goto(`${origin}/?scene=models&theme=${theme}`);
      await page.locator("[data-project-models-popover]").waitFor();
      const popover = await page.locator("[data-project-models-popover]").innerText();
      for (const part of [
        "Coordinator",
        "New threads",
        "Effort for new threads",
        "Runs on",
        "Fast",
        "Ultracode",
      ]) {
        assert.ok(popover.includes(part), `the Models popover lacks ${part}`);
      }
      assert.match(popover, /Medium effort/);
      await shot(`models-popover-${tag}`);
      await page.goto(`${origin}/?scene=models&theme=${theme}&capped`);
      assert.equal(
        await page.locator("[data-coordinator-effort-note]").innerText(),
        "Coordinator effort is capped at High.",
      );

      // Effort, Fast and Ultracode: icon and word with room, icons alone when tight; the
      // tooltip and the accessible name say all of it either way.
      await page.goto(`${origin}/?scene=traits&theme=${theme}`);
      await page.locator("[data-traits=tight] button").waitFor();
      const traits = await page.evaluate(() =>
        Object.fromEntries(
          ["roomy", "tight"].map((name) => {
            const button = document.querySelector(`[data-traits=${name}] button`);
            return [
              name,
              {
                name: button.getAttribute("aria-label"),
                icons: button.querySelectorAll("svg").length,
                words: [...button.querySelectorAll("[data-composer-control-label]")]
                  .filter((label) => getComputedStyle(label).visibility !== "hidden")
                  .map((label) => label.textContent.trim()),
                width: button.getBoundingClientRect().width,
              },
            ];
          }),
        ),
      );
      assert.deepEqual(traits.tight.words, []);
      for (const word of ["High", "Fast", "Ultracode"]) {
        assert.ok(
          traits.roomy.words.includes(word),
          `roomy traits lack ${word}: ${traits.roomy.words}`,
        );
      }
      assert.ok(traits.tight.icons >= 3, `tight traits show ${traits.tight.icons} icons`);
      assert.ok(traits.tight.width < traits.roomy.width, "the icon form is no narrower");
      for (const form of [traits.roomy, traits.tight]) {
        assert.match(form.name, /High effort/);
        assert.match(form.name, /Ultracode/);
        assert.match(form.name, /Fast/);
      }
      await shot(`traits-icons-${tag}`);

      // Two machines: the coordinator on M4, a thread assigned to M1.
      await page.goto(`${origin}/?scene=composer&theme=${theme}`);
      await page.locator("[data-scene=thread]").waitFor();
      const colors = await page.evaluate(() => {
        const edge = (selector, pseudo) => {
          const node = document.querySelector(selector);
          return getComputedStyle(node, pseudo).borderTopColor;
        };
        return {
          coordinator: edge("[data-scene=coordinator] .sws-composer-card"),
          thread: edge("[data-scene=thread] [data-slot=composer-host]", "::after"),
          chip: document
            .querySelector("[data-thread-machine-chip]")
            .getAttribute("data-machine-color"),
          send: getComputedStyle(document.querySelector("[data-send-target]")).backgroundColor,
        };
      });
      assert.notEqual(colors.coordinator, colors.thread, "both machines draw the same edge");
      assert.equal(colors.chip, "teal");
      assert.equal(
        await page.locator("[data-send-target]").getAttribute("aria-label"),
        "Send to M1",
      );
      await shot(`composer-machines-${tag}`);
    }
  }
  assert.deepEqual(errors, [], `page errors: ${errors.join("; ")}`);
  passed = true;
} finally {
  await browser.close();
  server.close();
  await writeFile(
    join(output, "result.json"),
    JSON.stringify({ passed, checks, errors, at: new Date().toISOString() }, null, 2),
  );
}
console.log(`picker-calm: ${checks.length} screenshots, axe clean, in ${output}`);
