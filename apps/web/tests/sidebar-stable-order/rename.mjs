// Headless check that a sidebar chat renames in place, like a project row.
// Usage: node apps/web/tests/sidebar-stable-order/rename.mjs <evidence-dir> [--site DIR]
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
  args[0] && !args[0].startsWith("--") ? args[0] : ".artifacts/sidebar-stable-order/rename",
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
    "Real StudioSidebar, chat row and name editor; simulated thread shells streaming live events every 40 ms; the rename command stores the title on the simulated shell",
  cases: [],
};
try {
  for (const [width, height, theme] of [
    [1280, 900, "dark"],
    [390, 844, "light"],
  ]) {
    const page = await browser.newPage({ viewport: { width, height } });
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/?theme=${theme}`);
    const row = (text) => page.locator(".sws-chat-row button.sws-side-row", { hasText: text });
    const field = page.getByRole("textbox", { name: "Chat name" });
    const fixture = (fn, arg) => page.evaluate(fn, arg);
    await row("Current Time").waitFor();
    const shot = (name) => page.screenshot({ path: join(output, `${width}-${theme}-${name}.png`) });

    // A single click opens the chat and does not rename.
    await row("Current Time").click();
    assert.equal(await fixture(() => window.fixture.current()), "Current Time");
    assert.equal(await field.count(), 0, "a single click must not rename");

    // A double click turns the title into a focused, selected field, while live events stream.
    await row("Current Time").dblclick();
    await field.waitFor();
    assert.equal(await field.inputValue(), "Current Time");
    assert.ok(await field.evaluate((el) => el === document.activeElement), "field not focused");
    const selected = await field.evaluate((el) =>
      el.value.slice(el.selectionStart, el.selectionEnd),
    );
    assert.equal(selected, "Current Time", "title not selected for typing over");
    await shot("1-double-click");
    await page.waitForTimeout(600);
    assert.equal(await field.count(), 1, "live updates closed the field");

    // Escape cancels and saves nothing.
    await page.keyboard.type("Thrown away");
    await page.keyboard.press("Escape");
    assert.equal(await field.count(), 0);
    assert.deepEqual(await fixture(() => window.fixture.renames()), []);
    assert.equal(await fixture(() => window.fixture.title("time")), "Current Time");
    assert.ok(
      await row("Current Time").evaluate((el) => el === document.activeElement),
      "Escape must return focus to the row",
    );

    // Blank is refused in place; Enter keeps the field open.
    await row("Current Time").dblclick();
    await page.keyboard.press("Backspace");
    await page.keyboard.press("Enter");
    assert.equal(await field.count(), 1, "blank name closed the field");
    const blankError = await page.locator(".sws-project-rename-error").textContent();
    assert.equal(blankError, "Enter a name.");
    await shot("2-blank-refused");

    // Enter saves a trimmed title; the row shows it and the command carried it.
    await page.keyboard.type("  Plan external drive  ");
    await page.keyboard.press("Enter");
    await row("Plan external drive").waitFor();
    assert.equal(await field.count(), 0);
    assert.deepEqual(await fixture(() => window.fixture.renames()), [
      { threadId: "time", title: "Plan external drive" },
    ]);
    assert.equal(await fixture(() => window.fixture.title("time")), "Plan external drive");
    await shot("3-saved");

    // Clicking away saves a valid new title.
    await row("Plan external drive").dblclick();
    await page.keyboard.type("Drive layout");
    await page.mouse.click(width - 5, height - 5);
    await row("Drive layout").waitFor();
    assert.equal(await fixture(() => window.fixture.title("time")), "Drive layout");

    // A refused save keeps the field open with the server's reason.
    await fixture(() => window.fixture.refuseNextRename("Thread not found."));
    await row("Drive layout").dblclick();
    await page.keyboard.type("Refused title");
    await page.keyboard.press("Enter");
    await page.locator(".sws-project-rename-error", { hasText: "Thread not found." }).waitFor();
    assert.equal(await field.count(), 1);
    await shot("4-refused");
    await page.keyboard.press("Escape");
    assert.equal(await fixture(() => window.fixture.title("time")), "Drive layout");

    // The row menu offers Rename too.
    await row("Count Projects").hover();
    await page.getByRole("button", { name: "Actions for Count Projects on This Machine" }).click();
    await page.getByRole("menuitem", { name: "Rename" }).click();
    await field.waitFor();
    await page.waitForTimeout(300);
    assert.ok(
      await field.evaluate((el) => el === document.activeElement),
      "menu rename lost focus",
    );
    await page.keyboard.type("Count projects");
    await page.keyboard.press("Enter");
    await row("Count projects").waitFor();

    // A chat a coordinator named keeps its title.
    await row("Delegated: audit disk").dblclick();
    await page.waitForTimeout(200);
    assert.equal(await field.count(), 0, "coordinator-named chat must not rename");
    await row("Delegated: audit disk").hover();
    await page.getByRole("button", { name: "Actions for Delegated: audit disk" }).click();
    assert.equal(await page.getByRole("menuitem", { name: "Rename" }).count(), 0);
    await page.keyboard.press("Escape");
    await shot("5-final");

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth + 1,
    );
    assert.ok(!overflow, "horizontal overflow");
    assert.deepEqual(errors, []);
    receipt.cases.push({
      width,
      height,
      theme,
      renames: await fixture(() => window.fixture.renames()),
      liveEvents: await fixture(() => window.fixture.events()),
      blankError,
      overflow,
      errors,
    });
    await page.close();
  }
  await writeFile(join(output, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n");
  console.log(JSON.stringify(receipt.cases));
} finally {
  await browser.close();
  await new Promise((done) => server.close(done));
}
