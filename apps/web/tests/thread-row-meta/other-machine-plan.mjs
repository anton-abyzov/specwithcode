// A thread on another machine shows the increment it works on there.
// Build first: vp build --config apps/web/tests/thread-row-meta/vite.config.ts
// Supply the installed Playwright entry via STUDIO_PLAYWRIGHT_MODULE. Always headless.
// Usage: node apps/web/tests/thread-row-meta/other-machine-plan.mjs [/absolute/evidence-dir]
import * as NodeAssert from "node:assert/strict";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
process.env.PWDEBUG = "0";
process.env.PLAYWRIGHT_HTML_OPEN = "never";
const { chromium } = await import(NodeURL.pathToFileURL(process.env.STUDIO_PLAYWRIGHT_MODULE).href);
const root = NodePath.resolve(".artifacts/thread-row-meta/site");
const output = NodePath.resolve(process.argv[2] ?? ".artifacts/thread-row-meta/evidence");
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
const receipt = { headless: true, checks: [], screenshots: [] };
try {
  for (const theme of ["light", "dark"]) {
    for (const width of [520, 900]) {
      const page = await browser.newPage({
        viewport: { width, height: 900 },
        colorScheme: theme,
      });
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(`${origin}/?theme=${theme}`);
      await page.waitForSelector("body[data-fixture-ready]");
      const chip = (id) =>
        page.locator(`.sws-thread-row[data-thread-id=${id}] [data-plan-progress]`);
      await chip("specos").waitFor({ timeout: 5000 });
      // Read from the thread's own machine, with that machine's project id, and only that thread.
      NodeAssert.deepEqual(await page.evaluate(() => globalThis.planQueries), [
        "env-mini/project-mini/specos",
      ]);
      NodeAssert.equal(await chip("specos").getAttribute("data-plan-source"), "increment");
      NodeAssert.equal(await chip("specos").getAttribute("data-plan-progress"), "12/26");
      NodeAssert.match(await chip("specos").textContent(), /0001 · 12\/26/);
      // This machine's own threads are read as before.
      NodeAssert.equal(await chip("matchcam").getAttribute("data-plan-progress"), "6/6");
      NodeAssert.deepEqual(errors, []);
      receipt.checks.push(`${theme} ${width}px: another machine's thread shows 0001 · 12/26`);
      const shot = NodePath.join(output, `other-machine-plan-${width}-${theme}.png`);
      await page
        .locator(".sws-thread-row[data-thread-id=specos]")
        .screenshot({ path: shot, animations: "disabled" });
      receipt.screenshots.push(shot);
      await page.close();
    }
  }
  await NodeFSP.writeFile(
    NodePath.join(output, "other-machine-plan.json"),
    `${JSON.stringify(receipt, null, 2)}\n`,
  );
  console.log(`other machine plan ok: ${receipt.checks.length} checks; evidence in ${output}`);
} finally {
  await browser.close();
  server.close();
}
