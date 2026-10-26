// Build first: vp build --config apps/web/tests/chat-density/vite.config.ts
// Supply the installed Playwright entry via STUDIO_PLAYWRIGHT_MODULE. Always headless.
import * as NodeAssert from "node:assert/strict";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
process.env.PWDEBUG = "0";
process.env.PLAYWRIGHT_HTML_OPEN = "never";
const { chromium } = await import(NodeURL.pathToFileURL(process.env.STUDIO_PLAYWRIGHT_MODULE).href);
const root = NodePath.resolve(".artifacts/chat-density/site");
const output = NodePath.resolve(
  process.env.CHAT_DENSITY_UI_OUTPUT ?? ".artifacts/chat-density/evidence",
);
await NodeFSP.mkdir(output, { recursive: true });
const MIME = { ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2" };
const server = NodeHttp.createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, "http://localhost").pathname;
    const file = NodePath.resolve(root, `.${pathname === "/" ? "/index.html" : pathname}`);
    if (!file.startsWith(`${root}${NodePath.sep}`)) {
      res.writeHead(403).end();
      return;
    }
    const body = await NodeFSP.readFile(file);
    res.writeHead(200, { "Content-Type": MIME[NodePath.extname(file)] ?? "text/html" });
    res.end(body);
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({
  headless: true,
  ...(process.env.STUDIO_CHROMIUM_EXECUTABLE
    ? { executablePath: process.env.STUDIO_CHROMIUM_EXECUTABLE }
    : {}),
});

const errors = [];
const receipt = [];
try {
  for (const theme of ["light", "dark"]) {
    for (const [width, height] of [
      [1280, 520],
      [390, 640],
    ]) {
      const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 2 });
      page.on("pageerror", (error) => errors.push(String(error)));
      await page.route("**/*", (route) =>
        route.request().url().startsWith(origin) ? route.continue() : route.abort(),
      );
      await page.goto(`${origin}/?theme=${theme}`);
      await page.waitForSelector('[data-message-role="assistant"]');
      // The folder and run chips and the empty plan share one line.
      const middles = await page.$$eval(
        "[data-thread-header-line] [data-thread-meta], [data-thread-plan-card]",
        (elements) =>
          elements.map((element) => {
            const box = element.getBoundingClientRect();
            return box.top + box.height / 2;
          }),
      );
      NodeAssert.ok(
        Math.max(...middles) - Math.min(...middles) < 2,
        `header chips on one line at ${width}px`,
      );
      NodeAssert.equal(await page.locator("[data-plan-empty]").textContent(), "No plan");
      // An agent's request is a quiet relayed note; where it ran waits in its hover row.
      const request = page.locator('[data-message-role="user"]').first();
      NodeAssert.equal(await request.getByText("Message from another agent").count(), 1);
      const origins = request.locator("[data-request-execution-origin]");
      NodeAssert.equal(await origins.count(), 1);
      NodeAssert.equal(
        await origins.evaluate((element) => getComputedStyle(element.parentElement).opacity),
        "0",
      );
      const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
      NodeAssert.ok(scrollWidth <= width, "no sideways scroll");
      const file = `chat-${theme}-${width}.png`;
      await page.screenshot({ path: NodePath.join(output, file) });
      receipt.push({ theme, width, headerLineMiddle: Math.round(middles[0]), screenshot: file });
      await page.close();
    }
  }
  NodeAssert.deepEqual(errors, []);
  await NodeFSP.writeFile(
    NodePath.join(output, "receipt.json"),
    `${JSON.stringify({ ok: true, checks: receipt }, null, 2)}\n`,
  );
  console.log(`chat density: ${receipt.length} views passed; evidence in ${output}`);
} finally {
  await browser.close();
  server.close();
}
