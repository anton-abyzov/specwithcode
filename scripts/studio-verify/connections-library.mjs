import * as NodeAssert from "node:assert/strict";
import * as NodeHttp from "node:http";
import * as NodeFSP from "node:fs/promises";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
process.env.PWDEBUG = "0";
process.env.PLAYWRIGHT_HTML_OPEN = "never";
NodeAssert.ok(process.versions.node.startsWith("22."), "Use Node 22");
const require = NodeModule.createRequire(NodePath.resolve("apps/server/package.json"));
const { chromium } = require("playwright-core");
const root = NodePath.resolve(".artifacts/connections-library/site");
const out = NodePath.resolve(process.argv[2] ?? "reports/connections-library");
await NodeFSP.mkdir(out, { recursive: true });
const server = NodeHttp.createServer(async (req, res) => {
  try {
    const path = new URL(req.url, "http://localhost").pathname;
    const file = NodePath.resolve(root, `.${path === "/" ? "/index.html" : path}`);
    if (!file.startsWith(root + NodePath.sep)) return res.writeHead(403).end();
    res
      .writeHead(200, {
        "Content-Type": file.endsWith(".js")
          ? "text/javascript"
          : file.endsWith(".css")
            ? "text/css"
            : "text/html",
      })
      .end(await NodeFSP.readFile(file));
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser, page;
const errors = [],
  checks = [];
try {
  browser = await chromium.launch({ headless: true, channel: "chrome" });
  page = await browser.newPage({
    viewport: { width: 1000, height: 900 },
    reducedMotion: "reduce",
  });
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.route("**/*", (route) =>
    route.request().url().startsWith(origin) ? route.continue() : route.abort(),
  );
  // The machine picker is the app's Select (a listbox popup), not a native <select>.
  const pickMachine = async (option) => {
    await page.getByRole("combobox", { name: "Connections execution machine" }).click();
    await page.getByRole("option", { name: option }).click();
    await page.getByRole("listbox").waitFor({ state: "hidden" });
  };
  await page.goto(origin);
  NodeAssert.equal(
    await page.locator("table").evaluate((el) => getComputedStyle(el).tableLayout),
    "fixed",
    "Fixture must include production Tailwind utilities",
  );
  await page.getByRole("button", { name: "PostHog Codex details" }).click();
  await page.getByText("Codex manages native access").waitFor();
  checks.push("Native provenance and unverified session details");
  await page.screenshot({ path: NodePath.join(out, "matrix-desktop.png"), fullPage: true });
  await pickMachine(/^Remote fixture/);
  await page.getByRole("button", { name: "Remote analytics Claude Code details" }).waitFor();
  NodeAssert.equal(await page.getByRole("rowheader", { name: "PostHog" }).count(), 0);
  await page.getByLabel("Project scope").check();
  await page.getByRole("button", { name: "PostHog Codex details" }).waitFor();
  NodeAssert.match(
    await page.getByRole("button", { name: "PostHog Codex details" }).innerText(),
    /Disabled/,
  );
  await pickMachine("/fixture/remote");
  await page.getByRole("button", { name: "Remote analytics Claude Code details" }).click();
  await page.getByText("Project .mcp.json", { exact: true }).first().waitFor();
  checks.push("Machine changes and project overrides without stale cross-machine data");
  for (const [state, expected] of [
    ["offline", "Connect this machine"],
    ["denied", "Filesystem read access"],
    ["error", "Could not inspect"],
    ["loading", "Reading native"],
    ["empty", "No MCP declarations"],
    ["invalid", "No declarations could be confirmed"],
  ]) {
    await page.getByLabel("Fixture state").selectOption(state);
    await page.getByText(expected, { exact: false }).first().waitFor();
  }
  checks.push("Offline, permission, error, loading, empty and invalid states");
  await page.getByLabel("Fixture state").selectOption("ready");
  await page.setViewportSize({ width: 360, height: 900 });
  await page.getByRole("button", { name: "Remote analytics Claude Code details" }).click();
  NodeAssert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth),
    false,
  );
  await page.screenshot({ path: NodePath.join(out, "matrix-mobile.png"), fullPage: true });
  checks.push("360px layout without page overflow");
  NodeAssert.deepEqual(errors, []);
  await NodeFSP.writeFile(
    NodePath.join(out, "browser.json"),
    JSON.stringify({ ok: true, headless: true, runtime: process.version, checks, errors }, null, 2),
  );
  console.log(JSON.stringify({ ok: true, checks }));
} catch (error) {
  await page
    ?.screenshot({ path: NodePath.join(out, "failure.png"), fullPage: true })
    .catch(() => {});
  if (errors.length > 0) console.error("Page errors:", errors);
  throw error;
} finally {
  await browser?.close();
  await new Promise((done) => server.close(done));
}
