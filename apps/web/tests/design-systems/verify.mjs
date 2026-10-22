// Run after building apps/web/tests/design-systems/vite.config.ts.
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
const root = resolve(".artifacts/design-systems/site");
const output = resolve(process.argv[2] ?? ".artifacts/design-systems/evidence");
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
    const shot = async (page, name) => {
      await page.waitForTimeout(200);
      await page.screenshot({ path: join(output, `${name}-${theme}.png`), fullPage: false });
    };
    const calls = (page) => page.evaluate(() => window.__fixture.calls);

    await check(`${theme}: settings list and proposals`, async () => {
      const page = await open("settings");
      await page.getByTestId("design-systems-settings").waitFor();
      const rows = page.getByTestId("system-row");
      assert.equal(await rows.count(), 5);
      const sources = await page.getByTestId("system-sources").allTextContents();
      assert.ok(sources.includes("Code · 2 files"), sources.join("|"));
      assert.ok(sources.includes("Figma export"), sources.join("|"));
      assert.ok(sources.includes("Figma desktop"), sources.join("|"));
      assert.equal(await page.getByRole("button", { name: /^Rescan / }).count(), 2);
      assert.equal(await page.getByTestId("rescan-note").textContent(), "No changes");
      const proposals = page.getByTestId("proposal-row");
      assert.equal(await proposals.count(), 2);
      assert.match(
        await proposals.first().textContent(),
        /Proposed by an agent in thread Moodboard for the launch/,
      );
      assert.equal(
        await page.locator(".lucide-lock, .lucide-brain").count(),
        0,
        "no lock/brain icons",
      );
      await shot(page, "settings");

      await page.getByRole("searchbox", { name: "Search design systems" }).fill("wea");
      assert.equal(await rows.count(), 1);
      await page.getByRole("searchbox", { name: "Search design systems" }).fill("");

      await page.getByTestId("new-design-system").click();
      await page.getByRole("menuitem", { name: "Describe it" }).waitFor();
      assert.deepEqual(await page.getByRole("menuitem").allTextContents(), [
        "From this project's code",
        "From a tokens file",
        "From Figma desktop",
        "Describe it",
      ]);
      await shot(page, "settings-new-menu");
      await page.getByRole("menuitem", { name: "Describe it" }).click();
      await page.getByTestId("describe-panel").waitFor();
      assert.match(await page.getByTestId("describe-panel").textContent(), /design_system_propose/);
      await shot(page, "describe");
      await page.close();
    });

    await check(`${theme}: review of an update`, async () => {
      const page = await open("review-weave");
      await page.getByTestId("design-system-review").waitFor();
      assert.match(
        await page.getByTestId("review-finding").first().textContent(),
        /--wv-scrim only in vskill-platform copy/,
      );
      await shot(page, "review-weave-tokens");
      await page.getByTestId("review-unchanged-toggle").click();
      await page.getByTestId("review-unchanged").waitFor();
      await page.getByTestId("review-unchanged").scrollIntoViewIfNeeded();
      await shot(page, "review-weave-unchanged");
      await page.getByRole("button", { name: /^Components/ }).click();
      await page.getByTestId("review-components").waitFor();
      await page.getByLabel("Include .wv-tooltip").click();
      await shot(page, "review-weave-components");
      await page.getByTestId("review-confirm").click();
      const last = (await calls(page)).at(-1);
      assert.deepEqual(last, {
        label: "confirm",
        value: {
          proposalId: "prop_weave",
          excludeTokens: [],
          excludeComponents: ["css:.wv-tooltip"],
        },
      });
      await page.close();
    });

    await check(`${theme}: review of a new system`, async () => {
      const page = await open("review-acme");
      await page.getByTestId("design-system-review").waitFor();
      assert.equal(await page.getByLabel("Name").inputValue(), "Acme UI");
      await shot(page, "review-acme-tokens");
      await page.getByRole("button", { name: /^Components/ }).click();
      assert.equal(await page.getByTestId("component-row").count(), 11);
      await shot(page, "review-acme-components");
      await page.close();
    });

    await check(`${theme}: review conflict`, async () => {
      const page = await open("review-conflict");
      await page.getByTestId("review-error").waitFor();
      assert.match(await page.getByTestId("review-error").textContent(), /revision 5/);
      await shot(page, "review-conflict");
      await page.close();
    });

    await check(`${theme}: from code`, async () => {
      const page = await open("code");
      await page.getByRole("button", { name: "Scan project" }).click();
      await page.getByTestId("scan-result").waitFor();
      assert.equal(await page.getByTestId("scan-suggestion").count(), 2);
      await shot(page, "scan-candidates");
      await page.getByTestId("scan-propose").first().click();
      const last = (await calls(page)).at(-1);
      assert.deepEqual(last.value.from.paths, ["weave/tokens.json", "weave/weave.css"]);
      await page.close();
    });

    await check(`${theme}: Figma off`, async () => {
      const page = await open("figma-off");
      const off = page.getByTestId("figma-off");
      await off.waitFor();
      assert.match(
        await off.textContent(),
        /In Figma, open Preferences and turn on Enable desktop MCP server\./,
      );
      assert.equal(await page.getByRole("button", { name: "Read variables" }).count(), 0);
      await shot(page, "figma-off");
      await page.getByTestId("figma-use-file").click();
      await page.getByTestId("tokens-file-panel").waitFor();
      await page.close();
    });

    await check(`${theme}: Figma connected`, async () => {
      const page = await open("figma-connected");
      await page.getByRole("button", { name: "Read variables" }).waitFor();
      await shot(page, "figma-connected");
      await page.close();
    });

    await check(`${theme}: tokens file`, async () => {
      const page = await open("tokens-file");
      await page.getByTestId("tokens-file-panel").waitFor();
      await page.getByTestId("tokens-file-input").setInputFiles([
        {
          name: "Brand.Light.tokens.json",
          mimeType: "application/json",
          buffer: Buffer.from('{"color":{"brand":{"$type":"color","$value":"#7c3aed"}}}'),
        },
        {
          name: "Brand.Dark.tokens.json",
          mimeType: "application/json",
          buffer: Buffer.from('{"color":{"brand":{"$type":"color","$value":"#a78bfa"}}}'),
        },
      ]);
      await page.getByTestId("tokens-file-list").waitFor();
      await shot(page, "tokens-file");
      await page.getByTestId("tokens-file-propose").click();
      const last = (await calls(page)).at(-1);
      assert.equal(last.label, "propose");
      assert.deepEqual(
        last.value.from.files.map((file) => file.fileName),
        ["Brand.Light.tokens.json", "Brand.Dark.tokens.json"],
      );
      await page.close();
    });

    await check(`${theme}: picker`, async () => {
      const page = await open("picker");
      await page.getByRole("combobox").click();
      await page.getByRole("option", { name: /^Weave/ }).waitFor();
      await shot(page, "picker-open");
      await page.getByRole("option", { name: /^Weave/ }).click();
      await page.waitForTimeout(100);
      assert.deepEqual((await calls(page)).slice(-2), [
        { label: "copy", value: "weave" },
        { label: "change", value: "weave-copy" },
      ]);
      assert.equal(await page.getByRole("combobox").textContent(), "Weave");
      await shot(page, "picker-copied");
      await page.close();
    });
  }
  assert.deepEqual(errors, [], `page errors:\n${errors.join("\n")}`);
} finally {
  await browser?.close();
  server.close();
  await writeFile(
    join(output, "design-systems-results.json"),
    JSON.stringify({ results, errors }, null, 2),
  );
}
console.log(
  `${results.filter((result) => result.ok).length}/${results.length} checks passed; evidence in ${output}`,
);
