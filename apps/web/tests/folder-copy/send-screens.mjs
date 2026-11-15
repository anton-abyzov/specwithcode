// Headless screenshots of Send to another machine… (increment 1326) on the copy flow: what the
// chosen machine holds (a copy, Main, several copies, nothing), Copy or Move, and the plan.
// Build first: node node_modules/vite-plus/bin/vp build --config apps/web/tests/folder-copy/vite.config.ts
// Run from the repository root: node apps/web/tests/folder-copy/send-screens.mjs /absolute/report-dir
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeAssert from "node:assert/strict";
process.env.PWDEBUG = "0";
process.env.PLAYWRIGHT_HTML_OPEN = "never";
const site = NodePath.join(process.cwd(), ".artifacts/folder-copy/site");
const output = NodePath.resolve(process.argv[2] ?? ".artifacts/folder-copy/send");
await NodeFSP.mkdir(output, { recursive: true });
const { chromium } = NodeModule.createRequire(import.meta.url)(
  process.env.STUDIO_PLAYWRIGHT_MODULE ?? "playwright-core",
);
const shell = () => {
  if (process.env.STUDIO_CHROMIUM_EXECUTABLE) return process.env.STUDIO_CHROMIUM_EXECUTABLE;
  const cache = NodePath.join(NodeOS.homedir(), "Library/Caches/ms-playwright");
  if (!NodeFS.existsSync(cache)) return undefined;
  for (const dir of NodeFS.readdirSync(cache)
    .filter((name) => name.startsWith("chromium_headless_shell-"))
    .sort((a, b) => Number(b.split("-")[1]) - Number(a.split("-")[1]))) {
    // One build per machine sits inside: chrome-headless-shell-<platform>-<arch>.
    const build = NodeFS.readdirSync(NodePath.join(cache, dir)).find((name) =>
      name.startsWith("chrome-headless-shell-"),
    );
    const file = build && NodePath.join(cache, dir, build, "chrome-headless-shell");
    if (file && NodeFS.existsSync(file)) return file;
  }
  return undefined;
};
const server = NodeHttp.createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url, "http://localhost").pathname;
    const file = NodePath.resolve(site, `.${pathname === "/" ? "/index.html" : pathname}`);
    if (!file.startsWith(site + NodePath.sep)) return response.writeHead(403).end();
    const body = await NodeFSP.readFile(file);
    const type = { ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2" };
    response.writeHead(200, { "Content-Type": type[NodePath.extname(file)] ?? "text/html" });
    response.end(body);
  } catch {
    response.writeHead(404).end();
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}/`;
const executablePath = shell();
const browser = await chromium.launch({
  headless: true,
  ...(executablePath ? { executablePath } : {}),
});
const saved = [];
const shot = async (page, name) => {
  const path = NodePath.join(output, `${name}.png`);
  await page.locator('[data-slot="dialog-popup"]').screenshot({ path, animations: "disabled" });
  saved.push(path);
};
const text = async (page, slot) =>
  (await page.locator(`[data-slot="${slot}"]`).count())
    ? await page.locator(`[data-slot="${slot}"]`).textContent()
    : null;
try {
  for (const [name, query, width, theme] of [
    ["copy", "holding=copy", 760, "light"],
    ["copy-dark", "holding=copy", 760, "dark"],
    ["copy-390", "holding=copy", 390, "light"],
    ["move", "holding=copy", 760, "light"],
    ["main", "holding=main", 760, "light"],
    ["several", "holding=several", 760, "light"],
    ["several-main", "holding=several-main", 760, "light"],
    ["none", "holding=none", 760, "light"],
  ]) {
    const page = await browser.newPage({ viewport: { width, height: 1500 }, deviceScaleFactor: 2 });
    await page.goto(`${base}?short=1&secrets=1&uncommitted=18&theme=${theme}&${query}`);
    await page.locator('[data-slot="handoff-coordinator"]').waitFor();
    const dialog = await page.locator('[data-slot="dialog-popup"]').textContent();
    NodeAssert.match(dialog, /Send specweave to m5/);
    // The folder is the existing copy's checkout, never a second one beside it.
    if (name.startsWith("copy") || name === "move" || name === "main" || name === "several-main")
      NodeAssert.match(
        await page.locator('input[aria-label="Folder on m5"]').inputValue(),
        name === "several-main"
          ? /^\/Users\/you\/work\/specweave-umb$/
          : /^\/Users\/you\/Projects\/github\/specweave-umb$/,
      );
    if (name === "move") {
      await page.getByRole("radio", { name: /Move to m5/ }).click();
      await page.getByRole("button", { name: "Copy and move to m5", exact: true }).waitFor();
      NodeAssert.equal(
        await text(page, "send-plan"),
        "Copy 18 changed local files into m5's copy at ~/Projects/github/specweave-umb/repositories/anton-abyzov/specweave, then move Main there. Work continues on m5, and this copy stops starting work.",
      );
    }
    if (name.startsWith("copy"))
      NodeAssert.equal(
        await text(page, "send-plan"),
        "Copy 18 changed local files into m5's copy at ~/Projects/github/specweave-umb/repositories/anton-abyzov/specweave. Main stays on m4.",
      );
    if (name === "main") {
      NodeAssert.match(await text(page, "send-existing-copy"), /m5 already has Main/);
      NodeAssert.equal(await page.locator('[data-send-choice="move"]').count(), 0);
      NodeAssert.match(await text(page, "send-plan"), /Main stays on m5\.$/);
    }
    if (name === "several") {
      NodeAssert.match(await text(page, "send-existing-copy"), /m5 has 2 copies/);
      NodeAssert.equal(await text(page, "send-plan"), null);
      NodeAssert.equal(
        await page.getByRole("button", { name: "Copy to m5", exact: true }).isDisabled(),
        true,
      );
    }
    if (name === "several-main") {
      NodeAssert.equal(await page.locator('[data-send-choice="move"]').count(), 0);
      NodeAssert.match(await text(page, "send-plan"), /Main stays on m5\.$/);
    }
    if (name === "none")
      NodeAssert.equal(await text(page, "send-plan"), "Copy the folder to m5. Main stays on m4.");
    await shot(page, `send-dialog-v2-${name}`);
    await page.close();
  }
  await NodeFSP.writeFile(
    NodePath.join(output, "send-screens.json"),
    JSON.stringify({ headless: true, saved, base: "synthetic fixture, no live state" }, null, 2),
  );
  console.log(saved.join("\n"));
} finally {
  await browser.close();
  server.close();
}
