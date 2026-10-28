// Headless screenshots of folder-only Claude Code entries in Settings > Connections, light and dark.
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
const out = NodePath.resolve(process.argv[2] ?? "reports/connections-folder-only");
await NodeFSP.mkdir(out, { recursive: true });
const server = NodeHttp.createServer(async (req, res) => {
  try {
    const path = new URL(req.url, "http://localhost").pathname;
    const file = NodePath.resolve(root, `.${path === "/" ? "/index.html" : path}`);
    if (!file.startsWith(root + NodePath.sep)) return res.writeHead(403).end();
    const type = file.endsWith(".js")
      ? "text/javascript"
      : file.endsWith(".css")
        ? "text/css"
        : "text/html";
    res.writeHead(200, { "Content-Type": type }).end(await NodeFSP.readFile(file));
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
const errors = [],
  checks = [];
try {
  browser = await chromium.launch({ headless: true, channel: "chrome" });
  for (const theme of ["light", "dark"]) {
    const page = await browser.newPage({
      viewport: { width: 1000, height: 900 },
      reducedMotion: "reduce",
      colorScheme: theme,
    });
    page.on("pageerror", (e) => errors.push(String(e)));
    await page.route("**/*", (route) =>
      route.request().url().startsWith(origin) ? route.continue() : route.abort(),
    );
    await page.goto(origin);
    if (theme === "dark") await page.evaluate(() => document.documentElement.classList.add("dark"));
    await page.getByLabel("Fixture state").selectOption("folders");
    await page.getByText("Only in one folder (Claude Code) · 3").waitFor();
    // The group note is a tooltip on its info mark.
    await page.getByRole("note", { name: /only when it runs in that folder/ }).hover();
    await page.getByText("Claude Code loads these only when it runs in that folder.").waitFor();
    await page.mouse.move(0, 0);
    await page.getByRole("button", { name: "Detailed" }).click();
    await page
      .getByText("Claude Code, only in sample-portal and 2 more folders · stdio", { exact: true })
      .waitFor();
    NodeAssert.equal(await page.getByText(/private project/i).count(), 0);
    await page.getByRole("button", { name: "design-mcp Claude Code details" }).click();
    await page.getByText("Claude Code, only in sample-portal (~/.claude.json)").waitFor();
    await page.screenshot({ path: NodePath.join(out, `folder-only-${theme}.png`), fullPage: true });
    checks.push(`${theme}: group, row, note and details name the folder-only entry`);
    await page.close();
  }
  NodeAssert.deepEqual(errors, []);
  await NodeFSP.writeFile(
    NodePath.join(out, "browser.json"),
    JSON.stringify({ ok: true, headless: true, runtime: process.version, checks, errors }, null, 2),
  );
  console.log(JSON.stringify({ ok: true, checks }));
} finally {
  await browser?.close();
  await new Promise((done) => server.close(done));
}
