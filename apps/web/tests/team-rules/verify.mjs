import * as NodeAssert from "node:assert/strict";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodePath from "node:path";

const assert = NodeAssert.default;
process.env.PWDEBUG = "0";
process.env.PLAYWRIGHT_HTML_OPEN = "never";
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE);
const site = NodePath.resolve(".artifacts/team-rules/site");
const output = NodePath.resolve(process.argv[2] || ".artifacts/team-rules/evidence");
await NodeFSP.mkdir(output, { recursive: true });
const types = { ".js": "text/javascript", ".css": "text/css", ".html": "text/html" };
const server = NodeHttp.createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, "http://localhost").pathname;
    const file = NodePath.resolve(site, "." + (pathname === "/" ? "/index.html" : pathname));
    if (!file.startsWith(site + "/")) throw Error("path");
    res.setHeader("content-type", types[NodePath.extname(file)] || "application/octet-stream");
    res.end(await NodeFSP.readFile(file));
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH,
});
const page = await browser.newPage({ viewport: { width: 1000, height: 820 } });
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
const base = `http://127.0.0.1:${server.address().port}/`;
const open = async (view, theme = "light") => {
  await page.goto(`${base}?view=${view}&theme=${theme}`);
  await page.waitForFunction(() => document.getElementById("root").childElementCount > 0);
  await page.evaluate(() => document.fonts.ready);
};
const shot = (name) => page.screenshot({ path: NodePath.join(output, `${name}.png`) });
const text = () => page.evaluate(() => document.body.innerText);

await open("settings");
let body = await text();
for (const expected of [
  "Team rules",
  "Set by Acme Engineering",
  "Why this is locked",
  "Your own choices come back if the rules are removed",
  "Broadest permission",
  "Approved models",
  "Fallback at a usage limit stays inside this list",
]) {
  assert.ok(body.includes(expected), `settings: ${expected}`);
}
assert.equal(
  await page
    .locator('[aria-label="Launch arguments"]')
    .evaluate((node) => node.closest("[inert]") !== null),
  true,
  "a locked control is inert",
);
await shot("team-rules-settings");
await open("settings", "dark");
await shot("team-rules-settings-dark");

await open("menu");
body = await text();
assert.ok(body.includes("Above your team's limit"));
assert.equal(await page.locator('[role="option"][aria-disabled="true"]').count(), 3);
await shot("team-rules-permission-menu");

await open("above");
body = await text();
assert.ok(body.includes("Switch to Supervised"));
await shot("team-rules-above-limit-notice");

await open("hold");
body = await text();
assert.ok(body.includes("Agents are paused"));
assert.ok(body.includes("agents.ceiling"));
await shot("team-rules-safe-hold");

assert.deepEqual(errors, []);
await browser.close();
server.close();
console.log(`headless checks passed; screenshots in ${output}`);
