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
const open = async (view, theme = "light", rules = "") => {
  await page.goto(`${base}?view=${view}&theme=${theme}${rules ? `&rules=${rules}` : ""}`);
  await page.waitForFunction(() => document.getElementById("root").childElementCount > 0);
  await page.evaluate(() => document.fonts.ready);
};
const shot = (name) => page.screenshot({ path: NodePath.join(output, `${name}.png`) });
const text = () => page.evaluate(() => document.body.innerText);
const lockMarks = () =>
  page.evaluate(() => document.querySelectorAll('[inert], [data-slot="team-rules-set-by"]').length);

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

await open("settings");
body = await text();
for (const expected of ["Phones", "SpecWithCode Connect", "Other machines", "Webhooks"]) {
  assert.ok(body.includes(expected), `settings reach: ${expected}`);
}
for (const expected of ["Chrome", "Computer use", "Google account", "Telegram"]) {
  assert.ok(body.includes(expected), `settings tools: ${expected}`);
}
await page.setViewportSize({ width: 1000, height: 1100 });
await shot("team-rules-settings-reach-tools");
await page.setViewportSize({ width: 1000, height: 820 });

await open("reach");
body = await text();
assert.ok(body.includes("rules turn off phones"));
assert.ok(body.includes("rules turn off SpecWithCode Connect"));
assert.ok(body.includes("rules turn off webhooks"));
assert.ok(body.includes("has different rules"), "same-rules names the machine it refuses");
assert.ok((await page.locator("[inert]").count()) >= 3);
await page.setViewportSize({ width: 1000, height: 1500 });
await shot("team-rules-reach-locks");
await page.setViewportSize({ width: 1000, height: 820 });

await open("tools");
body = await text();
for (const expected of ["agent use of Chrome", "agent use of this computer", "Telegram"]) {
  assert.ok(body.includes(expected), `tools: ${expected}`);
}
assert.equal(await page.locator("[inert]").count(), 4);
assert.equal(
  await page
    .getByRole("button", { name: "Disconnect" })
    .evaluate((node) => node.closest("[inert]") === null),
  true,
  "disconnect stays available",
);
await shot("team-rules-tools-locks");

await open("drift");
body = await text();
for (const expected of [
  "Rules on this machine",
  "Same rules",
  "No rules",
  "On hold",
  "Rules unknown",
  "Work refused.",
  "rules fixture0",
]) {
  assert.ok(body.includes(expected), `drift: ${expected}`);
}
await page.setViewportSize({ width: 1000, height: 1300 });
await shot("team-rules-machines-drift");
await open("drift", "dark");
await shot("team-rules-machines-drift-dark");
await page.setViewportSize({ width: 1000, height: 820 });

await open("carried");
body = await text();
assert.ok(body.includes("came from a machine where Acme Engineering's rules"));
assert.equal(await page.locator('[role="option"][aria-disabled="true"]').count(), 2);
assert.ok(body.includes("Switch to Auto-accept edits"));
await shot("team-rules-carried-ceiling");

// A machine without a rules file: nothing added, nothing locked.
await page.setViewportSize({ width: 1000, height: 1500 });
await open("repository");
body = await text();
for (const expected of [
  "Payments team's repository rules allow up to Supervised",
  "A team agreement, not a security boundary.",
  "Approved connections",
  "Update source",
  "Zone",
  "Repository rules",
]) {
  assert.ok(body.includes(expected), `repository: ${expected}`);
}
await shot("team-rules-repository");
await page.setViewportSize({ width: 1000, height: 820 });
await open("repository-hold");
body = await text();
assert.ok(body.includes("Agents are paused in this repository"));
assert.ok(body.includes("A team agreement, not a security boundary."));
await shot("team-rules-repository-hold");

for (const view of ["reach", "tools", "drift"]) {
  await open(view, "light", "none");
  body = await text();
  assert.equal(await lockMarks(), 0, `no locks without rules: ${view}`);
  for (const absent of ["Team rules", "Same rules", "Rules unknown", "Work refused", "Set by "]) {
    assert.ok(!body.includes(absent), `${view} without rules shows ${absent}`);
  }
}
await page.setViewportSize({ width: 1000, height: 1300 });
await open("drift", "light", "none");
await shot("team-rules-machines-no-rules");

assert.deepEqual(errors, []);
await browser.close();
server.close();
console.log(`headless checks passed; screenshots in ${output}`);
