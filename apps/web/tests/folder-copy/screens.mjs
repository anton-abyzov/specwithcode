// Headless screenshots of the one Copy to another machine flow (increment 1325): setup in
// light and dark, Move selected, the review with secrets listed, and the Git only screen.
// Build first: node node_modules/vite-plus/bin/vp build --config apps/web/tests/folder-copy/vite.config.ts
// Run from the repository root: node apps/web/tests/folder-copy/screens.mjs /absolute/report-dir
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
const output = NodePath.resolve(process.argv[2] ?? ".artifacts/folder-copy/screens");
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
try {
  const page = await browser.newPage({
    viewport: { width: 760, height: 1500 },
    deviceScaleFactor: 2,
  });
  for (const theme of ["light", "dark"]) {
    await page.goto(`${base}?short=1&secrets=1&uncommitted=18&theme=${theme}`);
    await page.locator('[data-slot="handoff-coordinator"]').waitFor();
    const text = await page.locator('[data-slot="dialog-popup"]').textContent();
    NodeAssert.match(text, /Copy specweave to m5/);
    NodeAssert.match(text, /What comes along/);
    NodeAssert.match(text, /including 18 uncommitted files/);
    NodeAssert.match(text, /Secrets \(\.env, keys\): included/);
    NodeAssert.match(text, /Where should the coordinator run\?/);
    NodeAssert.doesNotMatch(text, /Hand off and continue there|Copy local files/);
    // Details is kept mounted but closed: the Workspace locations rows are not on screen.
    NodeAssert.equal(
      await page.locator('[data-slot="handoff-workspace-summary"]').isVisible(),
      false,
    );
    await shot(page, `after-setup-${theme}`);
  }
  await page.getByRole("radio", { name: /Move to m5/ }).click();
  await page.getByRole("button", { name: "Copy and move to m5", exact: true }).waitFor();
  await shot(page, "after-setup-move");
  await page.getByRole("radio", { name: /Keep on m4/ }).click();
  await page.getByRole("button", { name: "Details" }).click();
  await page.locator('[data-slot="handoff-workspace-summary"]').waitFor();
  await shot(page, "after-setup-details");
  // An empty destination copies in one click; choosing file types first stops on the review.
  await page.getByRole("checkbox", { name: "Let me choose file types first" }).click();
  await page.getByRole("button", { name: "Copy to m5", exact: true }).click();
  await page.getByRole("button", { name: "Preview on m5", exact: true }).click();
  await page.locator('[data-slot="copy-secrets"]').waitFor();
  NodeAssert.match(
    await page.locator('[data-slot="copy-secrets"]').textContent(),
    /Secrets \(\.env, keys\): 6 files, included/,
  );
  await page.locator('[data-slot="copy-secrets-show"]').click();
  await page.locator('[aria-label="Send .env"]').waitFor();
  await page.locator('[data-slot="copy-secrets"]').scrollIntoViewIfNeeded();
  await shot(page, "after-review-secrets");
  await page.goto(`${base}?git=1`);
  await page.locator('[data-slot="handoff-along"]').waitFor();
  NodeAssert.match(
    await page.locator('[data-slot="handoff-source-changes"]').textContent(),
    /18 uncommitted files stay on m4: Git carries commits only/,
  );
  await shot(page, "after-git-only");
  await NodeFSP.writeFile(
    NodePath.join(output, "screens.json"),
    JSON.stringify({ headless: true, saved, base: "synthetic fixture, no live state" }, null, 2),
  );
  console.log(saved.join("\n"));
} finally {
  await browser.close();
  server.close();
}
