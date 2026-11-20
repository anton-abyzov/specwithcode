// Headless captures of a finished copy opened again (increment 1362): the done view first,
// then the form after "Sync again…". Light and dark, through the real dialog.
// Build first: node node_modules/vite-plus/bin/vp build --config apps/web/tests/folder-copy/vite.config.ts
// Run from the repository root: node apps/web/tests/folder-copy/done-reopen.mjs /absolute/report-dir
import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
process.env.PWDEBUG = "0";
process.env.PLAYWRIGHT_HTML_OPEN = "never";
const site = NodePath.join(process.cwd(), ".artifacts/folder-copy/site");
const output = NodePath.resolve(process.argv[2] ?? ".artifacts/folder-copy/done-reopen");
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
try {
  for (const theme of ["light", "dark"]) {
    // A new context each time: the finished copy's pointer lives in this page's storage.
    const context = await browser.newContext({
      viewport: { width: 760, height: 1100 },
      deviceScaleFactor: 2,
    });
    const page = await context.newPage();
    const popup = page.locator('[data-slot="dialog-popup"]');
    const footer = page.locator('[data-slot="dialog-footer"]');
    const action = (name) => footer.getByRole("button", { name, exact: true });
    const shot = async (name) => {
      const path = NodePath.join(output, `${name}-${theme}.png`);
      await popup.screenshot({ path, animations: "disabled" });
      saved.push(path);
    };
    await page.goto(`${base}?short=1&theme=${theme}`);
    // One click copies to an empty folder; Done is seen, then the dialog is closed.
    await action("Copy to rackF").click();
    await action("Open on rackF").waitFor();
    await page.keyboard.press("Escape");
    await page.getByRole("dialog").waitFor({ state: "detached" });
    // Nothing reopens it; the person opens "Add to another machine…" again.
    await page.waitForTimeout(500);
    NodeAssert.equal(await page.getByRole("dialog").count(), 0, "a closed dialog stays closed");
    await page.locator('[data-slot="fixture-reopen"]').click();
    await action("Open on rackF").waitFor();
    NodeAssert.equal(
      (await popup.locator('[data-slot="dialog-title"], h2').first().textContent()).trim(),
      "specweave is on rackF (added 2h ago)",
    );
    NodeAssert.equal(await action("Copy to rackF").count(), 0, "no Copy button on the done view");
    NodeAssert.equal(await action("Undo…").count(), 1, "the done view offers Undo");
    NodeAssert.doesNotMatch(
      await action("Sync again…").getAttribute("class"),
      /bg-primary/,
      "Sync again… is a secondary action",
    );
    NodeAssert.equal(await page.locator('[data-slot="handoff-coordinator"]').count(), 0);
    await shot("done-view-on-reopen");
    await action("Sync again…").click();
    await action("Copy to rackF").waitFor();
    await page.locator('[data-slot="copy-last"]').waitFor();
    NodeAssert.match(await popup.textContent(), /The last copy to .* on rackF finished\. View it/);
    NodeAssert.equal(
      (await popup.locator('[data-slot="dialog-title"], h2').first().textContent()).trim(),
      "Add specweave to rackF",
    );
    await shot("form-after-copy-changes-again");
    await context.close();
  }
  await NodeFSP.writeFile(
    NodePath.join(output, "done-reopen.json"),
    JSON.stringify({ headless: true, saved, base: "synthetic fixture, no live state" }, null, 2),
  );
  console.log(saved.join("\n"));
} finally {
  await browser.close();
  server.close();
}
