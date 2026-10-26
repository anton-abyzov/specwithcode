// Headless check of a project's Notifications submenu in the sidebar row menu.
// Usage: node apps/web/tests/sidebar-stable-order/notifications.mjs <evidence-dir> [--site DIR]
// Build first: vp build --config apps/web/tests/sidebar-stable-order/vite.config.ts
import * as NodeAssert from "node:assert/strict";
import * as NodeHttp from "node:http";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
const assert = NodeAssert.default;
const { resolve, extname, join } = NodePath;
const { readFile, mkdir, writeFile } = NodeFSP;
const homedir = NodeOS.homedir;
process.env.PWDEBUG = "0";
process.env.PLAYWRIGHT_HTML_OPEN = "never";
const { chromium } = NodeModule.createRequire(import.meta.url)(
  process.env.STUDIO_PLAYWRIGHT_MODULE ||
    join(
      homedir(),
      ".cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright",
    ),
);
const args = process.argv.slice(2);
const option = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : null);
const site = resolve(option("--site") || ".artifacts/sidebar-stable-order/site");
const output = resolve(
  args[0] && !args[0].startsWith("--") ? args[0] : ".artifacts/sidebar-stable-order/notifications",
);
await mkdir(output, { recursive: true });
const server = NodeHttp.createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, "http://localhost").pathname;
    const file = resolve(site, "." + (pathname === "/" ? "/index.html" : pathname));
    if (!file.startsWith(site + "/")) throw Error("path");
    res.setHeader(
      "content-type",
      { ".js": "text/javascript", ".css": "text/css", ".html": "text/html" }[extname(file)] ||
        "application/octet-stream",
    );
    res.end(await readFile(file));
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const browser = await chromium.launch({
  headless: true,
  executablePath:
    process.env.STUDIO_CHROMIUM_EXECUTABLE ||
    join(
      homedir(),
      "Library/Caches/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-mac-arm64/chrome-headless-shell",
    ),
});
const receipt = {
  headless: true,
  scope:
    "Real StudioSidebar, project row menu and Notifications submenu; simulated projects, and the level is stored on the simulated project",
  cases: [],
};
try {
  for (const [width, height, theme] of [
    [1280, 900, "light"],
    [1280, 900, "dark"],
    [390, 844, "light"],
  ]) {
    const page = await browser.newPage({ viewport: { width, height } });
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(
      `http://127.0.0.1:${server.address().port}/?theme=${theme}&live=off&scenario=projects`,
    );
    const shot = (name) => page.screenshot({ path: join(output, `${width}-${theme}-${name}.png`) });
    const row = page.locator('[aria-label="Projects"] .sws-project-row', { hasText: "specweave" });
    await row.waitFor();
    await row.hover();
    await page.getByRole("button", { name: "Actions for specweave" }).click();
    const trigger = page.getByRole("menuitem", { name: /^Notifications/ });
    await trigger.waitFor();
    assert.equal(await trigger.textContent(), "NotificationsCoordinator");
    await trigger.hover();
    const nothing = page.getByRole("menuitemradio", { name: /^Nothing/ });
    await nothing.waitFor();
    const checked = await page
      .locator('[role="menuitemradio"][aria-checked="true"]')
      .allTextContents();
    assert.deepEqual(checked, [
      "Coordinator and requestsThe main chat and anything waiting on you",
    ]);
    await shot("submenu");
    await nothing.click();
    await row.locator('[aria-label="Notifications off"]').waitFor();
    const updates = await page.evaluate(() => window.fixture.projectUpdates());
    assert.deepEqual(updates.at(-1), {
      environmentId: "host",
      input: {
        projectId: "specweave",
        workspaceSettings: { expectedRevision: 1, notifications: "none" },
      },
    });
    await page.locator("aside").screenshot({ path: join(output, `${width}-${theme}-muted.png`) });
    await row.hover();
    await page.getByRole("button", { name: "Actions for specweave" }).click();
    await page.getByRole("menuitem", { name: /^Notifications/ }).hover();
    await page.getByRole("menuitemradio", { name: /^Nothing/ }).waitFor();
    await shot("submenu-nothing");
    assert.deepEqual(errors, []);
    receipt.cases.push({ width, theme, saved: updates.at(-1), errors });
    await page.close();
  }
  await writeFile(join(output, "receipt.json"), JSON.stringify(receipt, null, 2));
  console.log(JSON.stringify(receipt, null, 2));
} finally {
  await browser.close();
  server.close();
}
