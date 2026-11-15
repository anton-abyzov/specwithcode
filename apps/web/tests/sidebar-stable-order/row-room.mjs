// Headless check of the room a chat row gives its name: the machine is as wide as its
// own name and ends at the row's edge, a plan count gives way before the name is cut
// shorter, and a narrow sidebar keeps the machine's colored square alone.
// Usage: node apps/web/tests/sidebar-stable-order/row-room.mjs <evidence-dir> [--site DIR] [--capture-only]
// Build first: vp build --config apps/web/tests/sidebar-stable-order/vite.config.ts
import * as NodeAssert from "node:assert/strict";
import * as NodeHttp from "node:http";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodeFS from "node:fs";
const assert = NodeAssert.default;
const { resolve, extname, join } = NodePath;
const { readFile, mkdir, writeFile } = NodeFSP;
process.env.PWDEBUG = "0";
process.env.PLAYWRIGHT_HTML_OPEN = "never";
const { chromium } = NodeModule.createRequire(import.meta.url)(
  process.env.STUDIO_PLAYWRIGHT_MODULE ||
    join(
      NodeOS.homedir(),
      ".cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright",
    ),
);
const args = process.argv.slice(2);
const option = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : null);
const captureOnly = args.includes("--capture-only");
const site = resolve(option("--site") || ".artifacts/sidebar-stable-order/site");
const output = resolve(
  args[0] && !args[0].startsWith("--") ? args[0] : ".artifacts/sidebar-stable-order/row-room",
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
const executablePath = process.env.STUDIO_CHROMIUM_EXECUTABLE;
const browser = await chromium.launch({
  headless: true,
  ...(executablePath && NodeFS.existsSync(executablePath) ? { executablePath } : {}),
});
const receipt = { headless: true, cases: [] };
const url = `http://127.0.0.1:${server.address().port}/?theme=dark&scenario=row-room&live=off`;
// The narrowest sidebar is 208 px, the default 256 px; the list is 17 px narrower than
// the sidebar, and under 224 px it keeps the machine's square alone.
const squareOnly = (sidebar) => sidebar - 17 < 224;
try {
  for (const sidebar of [320, 256, 240, 208]) {
    const page = await browser.newPage({
      viewport: { width: 1000, height: 760 },
      deviceScaleFactor: 2,
    });
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(`${url}&width=${sidebar}`);
    await page.locator(".sws-chat-row").first().waitFor();
    const box = await page.locator(".sws-side-chats").boundingBox();
    await page.screenshot({
      path: join(output, `${sidebar}.png`),
      clip: {
        x: 0,
        y: Math.max(0, box.y - 8),
        width: sidebar,
        height: Math.min(box.height + 16, 760 - box.y),
      },
    });
    const rows = await page.locator(".sws-chat-row").evaluateAll((items) =>
      items.map((item) => {
        const row = item.querySelector(".sws-side-row").getBoundingClientRect();
        const label = item.querySelector(".sws-side-row-label").getBoundingClientRect();
        const plan = item.querySelector(".sws-thread-plan")?.getBoundingClientRect();
        const machine = item.querySelector(".sws-row-machine");
        const tag = machine.getBoundingClientRect();
        const name = machine.querySelector(".sws-row-machine-name").getBoundingClientRect();
        // What ends the name's room: the count beside it, else the machine.
        const planShown = plan !== undefined && plan.width > 0 && plan.top < row.bottom - 1;
        return {
          title: item.querySelector(".sws-side-row-label").textContent,
          machine: machine.textContent,
          labelWidth: Math.round(label.width),
          labelOffCenter: Math.round(
            Math.abs(label.top + label.height / 2 - (row.top + row.height / 2)),
          ),
          hasPlan: plan !== undefined,
          planShown,
          nameShown: name.width > 0,
          tagWidth: Math.round(tag.width),
          tagRight: Math.round(tag.right),
          gap: Math.round(tag.left - (planShown ? plan.right : label.right)),
        };
      }),
    );
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth + 1,
    );
    receipt.cases.push({ sidebar, listWidth: Math.round(box.width), rows, overflow, errors });
    if (!captureOnly) {
      assert.deepEqual(errors, []);
      assert.ok(!overflow, `${sidebar}: horizontal overflow`);
      assert.equal(new Set(rows.map((r) => r.tagRight)).size, 1, `${sidebar}: machines end apart`);
      for (const row of rows) {
        // Nothing but the row's own spacing sits between the name and the machine.
        assert.ok(row.gap <= 10, `${sidebar}: ${row.title}: ${row.gap}px before ${row.machine}`);
        assert.ok(row.labelOffCenter <= 1, `${sidebar}: ${row.title}: name off the row's middle`);
        // A count shows only beside a name that kept its floor.
        if (row.planShown)
          assert.ok(
            row.labelWidth >= 90,
            `${sidebar}: ${row.title}: name cut to ${row.labelWidth}`,
          );
      }
      const short = rows.find((r) => r.machine === "m1" && !r.hasPlan);
      const long = rows.find((r) => r.machine === "linux-mini");
      if (squareOnly(sidebar)) {
        for (const row of rows) {
          assert.ok(!row.nameShown, `${sidebar}: ${row.title}: machine name kept`);
          assert.ok(row.tagWidth >= 7 && row.tagWidth <= 10, `${sidebar}: square ${row.tagWidth}`);
          if (!row.planShown)
            assert.ok(
              row.labelWidth >= sidebar * 0.6,
              `${sidebar}: ${row.title}: ${row.labelWidth}`,
            );
        }
      } else {
        assert.ok(
          rows.every((r) => r.nameShown),
          `${sidebar}: a machine name is hidden`,
        );
        // A short name keeps no room made for the long one in its group.
        assert.ok(short.tagWidth <= 32, `${sidebar}: m1 is ${short.tagWidth}px wide`);
        assert.ok(short.labelWidth > long.labelWidth + 30, `${sidebar}: m1 row gained no room`);
      }
      if (sidebar === 208)
        assert.ok(
          rows.every((r) => !r.planShown),
          "208: a count is kept beside a name with no room",
        );
      if (sidebar === 320)
        assert.ok(
          rows.filter((r) => r.hasPlan).every((r) => r.planShown),
          "320: a count is hidden in a wide sidebar",
        );
    }
    await page.close();
  }
} finally {
  await browser.close();
  server.close();
  await writeFile(join(output, "receipt.json"), JSON.stringify(receipt, null, 2));
}
console.log(`row-room: ${captureOnly ? "captured" : "passed"} -> ${output}`);
