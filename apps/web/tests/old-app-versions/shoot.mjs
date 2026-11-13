// Build with vp build --config apps/web/tests/old-app-versions/vite.config.ts first.
// Supply the installed Playwright entry via STUDIO_PLAYWRIGHT_MODULE. Headless only.
import * as fs from "node:fs/promises";
import * as http from "node:http";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";
process.env.PWDEBUG = "0";
process.env.PLAYWRIGHT_HTML_OPEN = "never";
const { chromium } = await import(pathToFileURL(process.env.STUDIO_PLAYWRIGHT_MODULE).href);
const root = path.resolve(".artifacts/old-app-versions/site");
const output = path.resolve(".artifacts/old-app-versions/evidence");
await fs.mkdir(output, { recursive: true });
const server = http.createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, "http://localhost").pathname;
    const file = path.resolve(root, `.${pathname === "/" ? "/index.html" : pathname}`);
    if (!file.startsWith(`${root}${path.sep}`)) return void res.writeHead(403).end();
    const mime = file.endsWith(".js")
      ? "text/javascript"
      : file.endsWith(".css")
        ? "text/css"
        : "text/html";
    res.writeHead(200, { "Content-Type": mime });
    res.end(await fs.readFile(file));
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
try {
  for (const theme of ["light", "dark"]) {
    const page = await browser.newPage({ viewport: { width: 1040, height: 420 } });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${origin}/?theme=${theme}`);
    await page.locator('[data-case="after"]').waitFor();
    const before = await page.locator('[data-case="before"]').innerText();
    const after = await page.locator('[data-case="after"]').innerText();
    assert.match(before, /other 66 GB/);
    assert.doesNotMatch(before, /old app versions/);
    assert.match(after, /old app versions 48 GB/);
    assert.match(after, /Remove old app versions \(48 GB\)/);
    assert.deepEqual(errors, []);
    await page.screenshot({ path: path.join(output, `low-disk-before-after-${theme}.png`) });
    await page.close();
  }
  console.log(JSON.stringify({ headless: true, ok: true, output }));
} finally {
  await browser.close();
  server.close();
}
