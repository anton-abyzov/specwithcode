// Headless check of the Chats list's machine column and filter, wide and narrow.
// Usage: node apps/web/tests/sidebar-stable-order/chat-machines.mjs <evidence-dir> [--site DIR] [--capture-only]
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
const captureOnly = args.includes("--capture-only");
const site = resolve(option("--site") || ".artifacts/sidebar-stable-order/site");
const output = resolve(
  args[0] && !args[0].startsWith("--") ? args[0] : ".artifacts/sidebar-stable-order/chat-machines",
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
const receipt = { headless: true, cases: [] };
const url = `http://127.0.0.1:${server.address().port}/?theme=dark&scenario=chat-machines&live=off`;
try {
  // Wide is the default 16rem sidebar; narrow squeezes it below the column's breakpoint.
  for (const [name, sidebar] of [
    ["wide", 256],
    ["narrow", 216],
  ]) {
    const page = await browser.newPage({ viewport: { width: 1000, height: 640 } });
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(`${url}&width=${sidebar}`);
    await page.locator(".sws-chat-row").first().waitFor();
    const clip = async (file) => {
      const box = await page.locator(".sws-side-chats").boundingBox();
      await page.screenshot({
        path: join(output, `${name}-${file}.png`),
        clip: {
          x: Math.max(0, box.x - 8),
          y: Math.max(0, box.y - 8),
          width: box.width + 16,
          height: Math.min(box.height + 16, 640 - box.y),
        },
      });
    };
    await clip("1-list");
    if (captureOnly) {
      await page.close();
      continue;
    }
    const row = (title) => page.locator(".sws-chat-row", { hasText: title });
    const cell = (title) => row(title).locator(".sws-row-machine");
    // Every row names a machine, and the column's left and right edges line up.
    const boxes = await page.locator(".sws-chat-row .sws-row-machine").evaluateAll((cells) =>
      cells.map((c) => {
        const box = c.getBoundingClientRect();
        return { left: Math.round(box.left), right: Math.round(box.right) };
      }),
    );
    assert.equal(boxes.length, await page.locator(".sws-chat-row").count());
    if (name === "wide")
      assert.equal(
        new Set(boxes.map((b) => b.left)).size,
        1,
        `left edges ${JSON.stringify(boxes)}`,
      );
    assert.equal(new Set(boxes.map((b) => b.right)).size, 1);
    assert.equal((await cell("Chrome extension").textContent()).trim(), "m4");
    assert.equal((await cell("Disk audit").textContent()).trim(), "ministorm");
    assert.match(await cell("the Linux box").textContent(), /ministorm$/);
    assert.equal(await cell("Boot iPhone").locator("svg[data-offline]").count(), 1);
    assert.equal(await cell("silent machine").locator("svg[data-offline]").count(), 1);
    // The dot sits before the column.
    const dot = await row("Disk audit").locator(".sws-dot").boundingBox();
    const disk = await cell("Disk audit").boundingBox();
    assert.ok(dot.x + dot.width <= disk.x, "dot overlaps the column");
    const titleWidth = await row("Update desktop")
      .locator(".sws-side-row-label")
      .evaluate((e) => e.getBoundingClientRect().width);
    assert.ok(titleWidth >= 96, `title squeezed to ${titleWidth}`);
    const nameFits = await cell("Disk audit")
      .locator(".sws-row-machine-name")
      .evaluate((e) => e.scrollWidth <= e.clientWidth + 1);
    if (name === "wide") assert.ok(nameFits, "ministorm cut off in the wide list");

    // The hovered row keeps its column clear of the actions button.
    await row("Disk audit").hover();
    const hovered = await cell("Disk audit").boundingBox();
    const actions = await page
      .getByRole("button", { name: "Actions for Disk audit" })
      .boundingBox();
    assert.ok(hovered.x + hovered.width <= actions.x + 1, "actions cover the column");
    await clip("2-hover");
    await page.mouse.move(800, 600);

    // Machine in the filter menu narrows the list, and the pill sits above the rows.
    await page.getByRole("button", { name: "Filter and sort chats" }).click();
    await page.getByRole("menuitem", { name: /^Machine/ }).click();
    const m1 = page.getByRole("menuitemradio", { name: /^m1, 2 open/ });
    await m1.waitFor();
    await page.screenshot({ path: join(output, `${name}-3-filter-menu.png`) });
    await m1.click();
    await page.mouse.click(800, 600);
    const pill = page.locator("[data-chat-machine-pill]");
    await pill.waitFor();
    assert.match(await pill.textContent(), /On m1/);
    await page.getByRole("menu").first().waitFor({ state: "detached" });
    assert.equal(await page.locator(".sws-chat-row").count(), 2);
    const pillBox = await pill.boundingBox();
    const first = await page.locator(".sws-chat-row").first().boundingBox();
    assert.ok(pillBox.y + pillBox.height <= first.y + 1, "pill below the list");
    await clip("4-filtered");
    // It survives a reload, and Show all undoes it.
    await page.reload();
    await pill.waitFor();
    assert.equal(await page.locator(".sws-chat-row").count(), 2);
    await pill.getByRole("button").click();
    assert.equal(await page.locator(".sws-chat-row").count(), 7);

    // Group by Machine: headings carry the name, so the rows drop the column.
    await page.getByRole("button", { name: "Filter and sort chats" }).click();
    await page.getByRole("menuitem", { name: /^Group by/ }).click();
    await page.getByRole("menuitemradio", { name: "Machine" }).click();
    await page.mouse.click(800, 600);
    await page.getByRole("menu").first().waitFor({ state: "detached" });
    await page.locator(".sws-side-subheading", { hasText: "ministorm" }).waitFor();
    assert.equal(await page.locator(".sws-chat-row .sws-row-machine-name").count(), 0);
    assert.equal(await row("Boot iPhone").locator("svg[data-offline]").count(), 1);
    await clip("5-grouped");
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth + 1,
    );
    assert.ok(!overflow, "horizontal overflow");
    assert.deepEqual(errors, []);
    receipt.cases.push({ name, sidebar, boxes, titleWidth, nameFits, errors });
    await page.close();
  }
  // Short names leave the column at its smallest, where the arrow and mark could push them out.
  if (!captureOnly) {
    const page = await browser.newPage({ viewport: { width: 1000, height: 640 } });
    await page.goto(`${url}&width=256&short=1`);
    await page.locator(".sws-chat-row").first().waitFor();
    const names = await page
      .locator(".sws-row-machine-name")
      .evaluateAll((cells) =>
        cells.map((c) => ({ text: c.textContent, shown: c.clientWidth, needs: c.scrollWidth })),
      );
    for (const { text, shown, needs } of names)
      assert.ok(shown > 0 && needs <= shown + 1, `${text} clipped: ${shown} of ${needs}`);
    await page.locator(".sws-side-chats").screenshot({ path: join(output, "short-names.png") });
    receipt.cases.push({ name: "short", names });
    await page.close();
  }
  await writeFile(join(output, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n");
  console.log(JSON.stringify(receipt.cases));
} finally {
  await browser.close();
  await new Promise((done) => server.close(done));
}
