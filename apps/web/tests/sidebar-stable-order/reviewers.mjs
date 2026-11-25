// Headless check of reviewer chat rows: one status per row, the name before the checklist.
// Usage: node apps/web/tests/sidebar-stable-order/reviewers.mjs <evidence-dir> [--site DIR] [--capture-only]
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
  args[0] && !args[0].startsWith("--") ? args[0] : ".artifacts/sidebar-stable-order/reviewers",
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
const url = `http://127.0.0.1:${server.address().port}/?theme=dark&scenario=reviewers&live=off`;
try {
  for (const [name, sidebar] of [
    ["wide", 300],
    ["narrow", 236],
  ]) {
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
      path: join(output, `${name}.png`),
      clip: {
        x: Math.max(0, box.x - 8),
        y: Math.max(0, box.y - 8),
        width: box.width + 16,
        height: Math.min(box.height + 16, 760 - box.y),
      },
    });
    const rows = await page.locator(".sws-chat-row").evaluateAll((items) =>
      items.map((row) => {
        const label = row.querySelector(".sws-side-row-label");
        const machine = row.querySelector(".sws-row-machine");
        const plan = row.querySelector(".sws-thread-plan");
        return {
          title: label?.textContent ?? "",
          tone: row.getAttribute("data-tone"),
          labelWidth: Math.round(label?.getBoundingClientRect().width ?? 0),
          plan:
            plan && plan.getBoundingClientRect().width > 0
              ? (plan.querySelector("[aria-hidden]:not(svg)")?.textContent ?? "")
              : null,
          dot: row.querySelector(".sws-dot") !== null,
          gap:
            machine && label
              ? Math.round(
                  (
                    machine.querySelector(".sws-row-machine-name") ?? machine
                  ).getBoundingClientRect().left - label.getBoundingClientRect().right,
                )
              : null,
          tip: row.querySelector("button")?.getAttribute("aria-label") ?? null,
        };
      }),
    );
    receipt.cases.push({ name, sidebar, rows, errors });
    if (!captureOnly) {
      assert.deepEqual(errors, []);
      for (const row of rows.filter((r) => r.title.startsWith("Review:"))) {
        // One status per row: a failed run shows its dot alone, never a plan count beside it.
        if (row.tone === "failed")
          assert.equal(row.plan, null, `${row.title}: plan beside failure`);
        // A finished checklist says nothing on the row; an open one is a bare count.
        if (row.plan !== null) assert.match(row.plan, /^\d+\/\d+$/u, row.title);
        // The name keeps most of the row.
        assert.ok(
          row.labelWidth >= sidebar * 0.4,
          `${row.title}: name squeezed to ${row.labelWidth}px`,
        );
      }
      // A reviewer a project's worker asked for on another machine groups with that project.
      assert.ok(!rows.some((r) => r.title.includes("PR 341")), "requested reviewer left in Chats");
      // So does a helper a project's subagent worker asked for (November 25, 2026).
      assert.ok(
        !rows.some((r) => r.title.includes("Git push credentials")),
        "helper left in Chats",
      );
      // A helper whose requester is not loaded stays reachable in Chats.
      assert.ok(
        rows.some((r) => r.title.includes("Disk check for specweave")),
        "orphan helper lost",
      );
      const done = rows.find((r) => r.title.includes("PR 343"));
      assert.equal(done.plan, null, "a finished checklist is hidden");
      // A bare row's name runs up to its machine: no room kept for a longer name elsewhere.
      for (const row of rows.filter((r) => r.gap !== null && r.plan === null && !r.dot))
        assert.ok(row.gap <= 32, `${row.title}: gap ${row.gap}px`);
    }
    await page.close();
  }
} finally {
  await browser.close();
  server.close();
  await writeFile(join(output, "receipt.json"), JSON.stringify(receipt, null, 2));
}
console.log(`reviewers: ${captureOnly ? "captured" : "passed"} -> ${output}`);
