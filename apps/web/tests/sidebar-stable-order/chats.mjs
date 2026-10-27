// Headless check that a chat is not a project thread: no Resolve, only Archive and
// Move to project, and archived chats one step away in the filter menu.
// Usage: node apps/web/tests/sidebar-stable-order/chats.mjs <evidence-dir> [--site DIR]
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
  args[0] && !args[0].startsWith("--") ? args[0] : ".artifacts/sidebar-stable-order/chats",
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
    "Real StudioSidebar, chat row and filter menus; simulated thread shells and a machine's No project folder; one chat marked resolved by an older server",
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
      `http://127.0.0.1:${server.address().port}/?theme=${theme}&scenario=chats&live=off`,
    );
    const row = (text) => page.locator(".sws-chat-row button.sws-side-row", { hasText: text });
    const fixture = (fn, arg) => page.evaluate(fn, arg);
    const shot = (name) => page.screenshot({ path: join(output, `${width}-${theme}-${name}.png`) });
    const menuItems = () => page.getByRole("menuitem").allTextContents();

    // A chat an older server marked resolved is still listed under the default filter.
    await row("Current Time").waitFor();
    assert.equal(await page.getByText("Archived chats").count(), 0, "archive entry in the list");
    await shot("1-list");

    // Its menu has no Resolve or Reopen: it moves into a project or is archived.
    await row("Current Time").hover();
    await page.getByRole("button", { name: "Actions for Current Time" }).click();
    await page.getByRole("menuitem", { name: "Archive" }).waitFor();
    const chatMenu = await menuItems();
    assert.ok(chatMenu.includes("Move to project…"), `no Move to project in ${chatMenu}`);
    assert.ok(chatMenu.includes("Archive"));
    assert.ok(!chatMenu.some((label) => /Resolve|Reopen/.test(label)), `${chatMenu}`);
    await shot("2-chat-menu");
    await page.getByRole("menuitem", { name: "Move to project…" }).click();
    assert.deepEqual(await fixture(() => window.fixture.moves()), ["time"]);

    // Archived chats wait in the filter menu, one step from the list.
    await page.getByRole("button", { name: "Filter and sort chats" }).click();
    const archived = page.getByRole("menuitem", { name: "Archived chats" });
    await archived.waitFor();
    assert.match(await archived.getAttribute("href"), /\/settings\/archived$/);
    const filterMenu = await menuItems();
    await shot("3-filter-menu");
    await page.keyboard.press("Escape");

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth + 1,
    );
    assert.ok(!overflow, "horizontal overflow");
    assert.deepEqual(errors, []);
    receipt.cases.push({ width, height, theme, chatMenu, filterMenu, overflow, errors });
    await page.close();
  }
  await writeFile(join(output, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n");
  console.log(JSON.stringify(receipt.cases));
} finally {
  await browser.close();
  await new Promise((done) => server.close(done));
}
