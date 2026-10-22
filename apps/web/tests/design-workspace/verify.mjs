// Run after building apps/web/tests/design-workspace/vite.config.ts.
// Serves fixture assets only; no account, provider, network or live store access.
// Headless Chromium; screenshots go to the report directory given as the first argument.
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
const root = resolve(".artifacts/design-workspace/site");
const output = resolve(process.argv[2] ?? ".artifacts/design-workspace/evidence");
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

const results = [];
const errors = [];
const check = (name, fn) =>
  fn().then(
    () => results.push({ name, ok: true }),
    (error) => {
      results.push({ name, ok: false, error: String(error?.stack ?? error) });
      throw error;
    },
  );

let browser;
try {
  browser = await chromium.launch({
    headless: true,
    ...(process.env.STUDIO_CHROMIUM_EXECUTABLE
      ? { executablePath: process.env.STUDIO_CHROMIUM_EXECUTABLE }
      : {}),
  });
  for (const theme of ["light", "dark"]) {
    const open = async (scene, viewport = { width: 1280, height: 900 }) => {
      const page = await browser.newPage({ reducedMotion: "reduce", viewport, colorScheme: theme });
      page.setDefaultTimeout(15_000);
      page.on("pageerror", (error) => errors.push(`${theme}/${scene}: ${error}`));
      page.on("console", (message) => {
        if (message.type() === "error") errors.push(`${theme}/${scene}: ${message.text()}`);
      });
      await page.route("**/*", (route) =>
        route.request().url().startsWith(origin) ? route.continue() : route.abort(),
      );
      await page.goto(`${origin}/?theme=${theme}&scene=${scene}`);
      return page;
    };
    const shot = (page, name) =>
      page.screenshot({ path: join(output, `${name}-${theme}.png`), fullPage: false });

    await check(`${theme}: gallery`, async () => {
      const page = await open("gallery");
      const gallery = page.getByTestId("design-gallery");
      await gallery.waitFor();
      const tabs = await page.getByTestId("design-tab").allTextContents();
      assert.deepEqual(tabs, ["All", "Playground", "Projects"]);
      const kinds = await page
        .getByTestId("design-create")
        .evaluateAll((nodes) => nodes.map((node) => node.dataset.kind));
      assert.deepEqual(
        kinds,
        ["slides", "design", "design-from-code", "design-system"],
        "only kinds that work are offered",
      );
      const cards = page.getByTestId("design-card");
      assert.equal(await cards.count(), 6);
      const owners = await page.getByTestId("design-owner").allTextContents();
      assert.deepEqual(owners, [
        "Playground",
        "Atlas web",
        "Atlas web",
        "Borealis API",
        "Borealis API",
        "Playground",
      ]);
      const edited = await page.getByTestId("design-edited").allTextContents();
      assert.deepEqual(edited.slice(0, 3), [
        "Edited 1 min ago",
        "Edited 4 min ago",
        "Edited 38 min ago",
      ]);
      // Live thumbnails: the shared renderer in opaque-origin iframes, no same-origin.
      await page
        .locator('[data-slot="design-thumbnail"][data-state="ready"] iframe')
        .first()
        .waitFor();
      const frames = await page
        .locator('[data-slot="design-thumbnail"] iframe')
        .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("sandbox")));
      assert.equal(frames.length, 6);
      assert.ok(
        frames.every((sandbox) => sandbox === ""),
        `sandbox: ${frames}`,
      );
      assert.equal(await page.locator(".lucide-lock").count(), 0, "no lock icon");
      await shot(page, "gallery");

      await page.locator('[data-tab="playground"]').click();
      assert.equal(await cards.count(), 2);
      await page.locator('[data-tab="projects"]').click();
      assert.equal(await cards.count(), 4);
      await page.getByRole("combobox", { name: "Project" }).click();
      await page.getByRole("option", { name: "Borealis API" }).click();
      assert.deepEqual(await page.getByTestId("design-owner").allTextContents(), [
        "Borealis API",
        "Borealis API",
      ]);
      await shot(page, "gallery-projects-filter");
      await page.locator('[data-tab="all"]').click();
      await page.getByRole("searchbox", { name: "Search designs" }).fill("pricing");
      assert.equal(await cards.count(), 1);
      await page.getByRole("searchbox", { name: "Search designs" }).fill("");

      await page.getByRole("button", { name: "List view" }).click();
      assert.equal(await page.getByTestId("design-row").count(), 6);
      await shot(page, "gallery-list");
      await page.getByRole("button", { name: "Grid view" }).click();

      await page.getByRole("button", { name: "Actions for Pricing page" }).click();
      await page.getByRole("menuitem", { name: "Delete" }).waitFor();
      const items = await page
        .locator('[data-slot="menu-item"], [data-slot="menu-sub-trigger"]')
        .allTextContents();
      assert.deepEqual(items, [
        "Open",
        "Rename…",
        "Duplicate",
        "Copy link",
        "Open project",
        "Copy to project…",
        "Copy to Playground",
        "Delete…",
      ]);
      assert.equal(await page.locator('[data-slot="menu-separator"]').count(), 2);
      await shot(page, "gallery-card-menu");
      await page.getByRole("menuitem", { name: "Copy to project…" }).hover();
      await page.getByRole("menuitem", { name: "Borealis API" }).waitFor();
      await shot(page, "gallery-card-menu-copy");
      await page.getByRole("menuitem", { name: "Borealis API" }).click();
      await page.getByRole("button", { name: "Actions for Pricing page" }).click();
      await page.getByRole("menuitem", { name: "Duplicate" }).click();
      await page.getByRole("button", { name: "Actions for Pricing page" }).click();
      await page.getByRole("menuitem", { name: "Open project" }).click();

      // Rename…: Escape cancels and returns focus to the trigger; Enter saves.
      const trigger = page.getByRole("button", { name: "Actions for Pricing page" });
      await trigger.click();
      await page.getByRole("menuitem", { name: "Rename…" }).click();
      const rename = page.getByTestId("rename-design-dialog");
      const field = rename.getByRole("textbox", { name: "Title" });
      await field.waitFor();
      await page.waitForFunction(() => document.activeElement?.tagName === "INPUT");
      assert.equal(await field.inputValue(), "Pricing page");
      assert.equal(await field.getAttribute("maxlength"), "180");
      await page.keyboard.press("Escape");
      await rename.waitFor({ state: "detached" });
      await page.waitForFunction(
        () => document.activeElement?.getAttribute("aria-label") === "Actions for Pricing page",
      );
      await trigger.click();
      await page.getByRole("menuitem", { name: "Rename…" }).click();
      await field.waitFor();
      await page.waitForFunction(() => document.activeElement?.tagName === "INPUT");
      await field.fill("Pricing page v2");
      await page.waitForTimeout(250);
      await shot(page, "gallery-rename-dialog");
      await page.keyboard.press("Enter");
      await rename.waitFor({ state: "detached" });
      await page.waitForFunction(
        () => document.activeElement?.getAttribute("aria-label") === "Actions for Pricing page v2",
      );

      await page.getByRole("button", { name: "Actions for Pricing page v2" }).click();
      await page.getByRole("menuitem", { name: "Delete…" }).click();
      await page.getByRole("alertdialog").waitFor();
      await shot(page, "gallery-delete-confirm");
      await page.getByTestId("design-delete-confirm").click();
      await page.getByRole("alertdialog").waitFor({ state: "detached" });
      assert.equal(await cards.count(), 5);
      const calls = await page.evaluate(() => window.__fixture.calls);
      assert.deepEqual(
        calls.map((call) => call.label),
        ["copy", "duplicate", "openProject", "rename", "delete"],
      );
      assert.deepEqual(calls[0].value, {
        designId: "d_pricing",
        to: { kind: "project", projectId: "borealis-api" },
      });
      assert.equal(calls[1].value, "d_pricing");
      assert.deepEqual(calls[2].value, {
        designId: "d_pricing",
        projectKey: "logical-project:atlas-web",
      });
      assert.deepEqual(calls[3].value, {
        designId: "d_pricing",
        title: "Pricing page v2",
        expectedRevision: 4,
      });

      // A Playground design has no Open project or Copy to Playground.
      await page.getByRole("button", { name: "Actions for Moodboard" }).click();
      await page.getByRole("menuitem", { name: "Delete…" }).waitFor();
      assert.deepEqual(
        await page
          .locator('[data-slot="menu-item"], [data-slot="menu-sub-trigger"]')
          .allTextContents(),
        ["Open", "Rename…", "Duplicate", "Copy link", "Copy to project…", "Delete…"],
      );
      await page.keyboard.press("Escape");
      await page.close();
    });

    await check(`${theme}: design from code dialog`, async () => {
      const page = await open("dialog");
      const dialog = page.getByTestId("design-from-code-dialog");
      await dialog.waitFor();
      assert.match(await dialog.textContent(), /Design from code/);
      assert.equal(
        await page.getByTestId("design-from-code-worker").textContent(),
        "Starts a thread in Atlas web on Claude Opus 5.5, high effort.",
      );
      await page
        .getByLabel("What should this design show?")
        .fill("A notifications settings page in the style of the app");
      await page.waitForTimeout(250);
      await shot(page, "design-from-code-dialog");
      await page.getByTestId("design-from-code-start").click();
      await dialog.waitFor({ state: "detached" });
      const calls = await page.evaluate(() => window.__fixture.calls);
      assert.deepEqual(calls.at(-1), {
        label: "start",
        value: {
          projectId: "atlas-web",
          designSystem: null,
          brief: "A notifications settings page in the style of the app",
        },
      });
      await page.close();
    });

    await check(`${theme}: new design dialog`, async () => {
      const page = await open("new");
      await page.getByTestId("new-design-dialog").waitFor();
      await page.waitForTimeout(250);
      await shot(page, "new-design-dialog");
      await page.close();
    });

    await check(`${theme}: library designs group`, async () => {
      const page = await open("library");
      const labels = page.locator(".sws-library-row .sws-library-label");
      await labels.first().waitFor();
      assert.deepEqual((await labels.allTextContents()).slice(0, 3), [
        "Designs",
        "Pricing page",
        "Onboarding, step 2",
      ]);
      await page.getByRole("button", { name: "Actions for Pricing page" }).click();
      await page.getByRole("menuitem", { name: "Show file" }).waitFor();
      assert.deepEqual(await page.locator('[data-slot="menu-item"]').allTextContents(), [
        "Open",
        "Copy to Playground",
        "Show file",
      ]);
      await shot(page, "library-designs-menu");
      await page.getByRole("menuitem", { name: "Copy to Playground" }).click();
      await page.getByRole("button", { name: "Actions for Pricing page" }).click();
      await page.getByRole("menuitem", { name: "Show file" }).click();
      const state = await page.evaluate(() => ({
        calls: window.__fixture.calls,
        opened: window.__fixture.opened,
      }));
      assert.deepEqual(state.calls.at(-1), {
        label: "design.copy",
        value: {
          environmentId: "host",
          input: {
            owner: { kind: "project", projectId: "atlas-web" },
            designId: "d_pricing",
            to: { kind: "playground" },
          },
        },
      });
      assert.equal(state.opened.at(-1), ".specweave/design/d_pricing/design.json");
      await page.keyboard.press("Escape");
      await page.locator(".sws-library-name button", { hasText: "Pricing page" }).click();
      assert.deepEqual(await page.evaluate(() => window.__fixture.pushed), [
        "/design/p.atlas-web.d_pricing",
      ]);
      await shot(page, "library-designs");
      await page.close();
    });
  }
  assert.deepEqual(errors, [], `page errors:\n${errors.join("\n")}`);
} finally {
  await browser?.close();
  server.close();
  await writeFile(
    join(output, "design-workspace-results.json"),
    JSON.stringify({ results, errors }, null, 2),
  );
}
console.log(
  `${results.filter((result) => result.ok).length}/${results.length} checks passed; evidence in ${output}`,
);
