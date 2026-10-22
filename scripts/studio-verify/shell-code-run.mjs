// Headless check of inline Run on chat shell code blocks against the isolated fixture in
// apps/web/tests/shell-code-run. Saves screenshots and receipt.json to the evidence directory.
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as http from "node:http";
import * as path from "node:path";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

process.env.PWDEBUG = "0";
process.env.PLAYWRIGHT_HTML_OPEN = "never";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const site = path.join(root, ".artifacts/shell-code-run/site");
const output = path.resolve(
  process.argv[2] ?? path.join(root, ".artifacts/shell-code-run/evidence"),
);
await fs.mkdir(output, { recursive: true });
const { chromium } = createRequire(import.meta.url)(
  process.env.STUDIO_PLAYWRIGHT_MODULE ??
    path.join(
      homedir(),
      ".cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright",
    ),
);
const server = http.createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, "http://localhost").pathname;
    const file = path.resolve(site, `.${pathname === "/" ? "/index.html" : pathname}`);
    if (!file.startsWith(`${site}${path.sep}`)) return void res.writeHead(403).end();
    const mime =
      {
        ".js": "text/javascript",
        ".css": "text/css",
        ".woff2": "font/woff2",
        ".wasm": "application/wasm",
      }[path.extname(file)] ?? "text/html";
    const contents = await fs.readFile(file);
    res.writeHead(200, { "Content-Type": mime });
    res.end(contents);
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const receipt = {
  headless: true,
  scope: "Real ChatMarkdown and inline Run UI; in-memory terminal stub",
  cases: [],
};
let browser;
try {
  browser = await chromium.launch({
    headless: true,
    ...(process.env.STUDIO_CHROMIUM_EXECUTABLE
      ? { executablePath: process.env.STUDIO_CHROMIUM_EXECUTABLE }
      : {}),
  });
  for (const [width, theme] of [
    [390, "dark"],
    [1024, "dark"],
    [1024, "light"],
  ]) {
    const context = await browser.newContext({
      viewport: { width, height: 1100 },
      colorScheme: theme,
      reducedMotion: "reduce",
    });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("**/*", (route) =>
      route.request().url().startsWith(origin) ? route.continue() : route.abort(),
    );
    await page.goto(`${origin}/?theme=${theme}`);
    const coordinator = page.getByTestId("coordinator");
    const thread = page.getByTestId("thread");
    await coordinator.locator(".chat-markdown-word").first().waitFor();
    const shot = (name) => path.join(output, `${width}-${theme}-${name}.png`);

    // 1. Labeled as bash, and every word fits on one line (no break inside `-d`).
    const block = coordinator.locator(".chat-markdown-codeblock");
    assert.equal(await block.getAttribute("data-language"), "bash");
    const words = await block
      .locator(".chat-markdown-word")
      .evaluateAll((nodes) =>
        nodes.map((node) => ({ text: node.textContent, lines: node.getClientRects().length })),
      );
    assert.ok(
      words.some((word) => word.text === "-d"),
      "the -d flag is one word",
    );
    assert.deepEqual(
      words.filter((word) => word.lines !== 1),
      [],
      "no word splits across lines",
    );
    const codeLines = await block.locator("pre").evaluate((pre) => {
      const range = document.createRange();
      range.selectNodeContents(pre);
      const tops = new Set([...range.getClientRects()].map((rect) => Math.round(rect.top)));
      return tops.size;
    });
    await coordinator.screenshot({ path: shot("1-labeled-and-wrapped") });

    // 2. Full access runs on click and shows output with the exit code.
    await block.getByRole("button", { name: "Run command" }).click();
    await block.getByText("Exit 0").waitFor();
    const output1 = await block.getByLabel("Command output").textContent();
    assert.match(output1, /inflating: unpacked\/manifest.json/);
    await coordinator.screenshot({ path: shot("2-full-access-output") });

    // 3. Supervised asks first; nothing runs until the confirmation.
    const failing = thread.locator(".chat-markdown-codeblock").nth(0);
    await failing.getByRole("button", { name: "Run command" }).click();
    await failing.getByRole("group", { name: "Confirm command" }).waitFor();
    assert.equal(await failing.getByLabel("Command output").count(), 0);
    await thread.screenshot({ path: shot("3-supervised-confirm") });
    await failing.locator("[data-shell-run-confirm]").click();
    await failing.getByText("Exit 1").waitFor();
    const failedOutput = await failing.getByLabel("Command output").textContent();
    assert.equal(failedOutput.includes("\u001b"), false, "escape codes are removed");

    // 4. A long-running command shows Stop; Stop ends it with Ctrl-C.
    const longRunning = thread.locator(".chat-markdown-codeblock").nth(1);
    await longRunning.getByRole("button", { name: "Run command" }).click();
    await longRunning.locator("[data-shell-run-confirm]").click();
    await longRunning.getByText("Waiting for the dev server").waitFor();
    assert.equal(await longRunning.getByRole("button", { name: "Stop command" }).count(), 1);
    await thread.screenshot({ path: shot("4-running-and-failed") });
    await longRunning.getByRole("button", { name: "Stop command" }).click();
    await longRunning.getByText("Stopped", { exact: true }).waitFor();
    assert.equal(
      await longRunning.locator('[data-shell-run="exited"]').getAttribute("data-shell-run-exit"),
      "0",
      "a native zero exit code plus SIGINT is shown as stopped, not successful",
    );
    await page.screenshot({ path: shot("5-full-page"), fullPage: true });

    assert.deepEqual(errors, []);
    receipt.cases.push({
      width,
      theme,
      codeLines,
      words: words.length,
      errors,
      screenshots: (await fs.readdir(output)).filter((name) =>
        name.startsWith(`${width}-${theme}-`),
      ),
    });
    await context.close();
  }
  await fs.writeFile(path.join(output, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n");
  console.log(JSON.stringify(receipt, null, 2));
} finally {
  await browser?.close();
  server.close();
}
