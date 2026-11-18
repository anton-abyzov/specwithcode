// Headless screenshots of the Sources fixture: the card, Add source open, and
// the list after adding Copilot. Usage: node shoot.mjs <built-site-dir> <out-dir>
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const [site, output] = process.argv.slice(2);
if (!site || !output) throw new Error("usage: node shoot.mjs <site> <out>");
NodeFS.mkdirSync(output, { recursive: true });
const { chromium } = process.env.STUDIO_PLAYWRIGHT_MODULE
  ? await import(NodeURL.pathToFileURL(process.env.STUDIO_PLAYWRIGHT_MODULE).href)
  : await import("playwright");
const types = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
};
const server = NodeHttp.createServer((req, res) => {
  const path = NodePath.join(
    site,
    new URL(req.url, "http://x").pathname === "/"
      ? "index.html"
      : new URL(req.url, "http://x").pathname,
  );
  if (!NodeFS.existsSync(path)) return res.writeHead(404).end();
  res.writeHead(200, {
    "content-type": types[NodePath.extname(path)] ?? "application/octet-stream",
  });
  NodeFS.createReadStream(path).pipe(res);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true });
try {
  for (const theme of ["light", "dark"]) {
    const page = await browser.newPage({
      viewport: { width: 900, height: 1000 },
      deviceScaleFactor: 2,
      colorScheme: theme,
    });
    await page.goto(origin);
    await page.getByRole("region", { name: "Sources" }).waitFor();
    await page.evaluate(
      (dark) => document.documentElement.classList.toggle("dark", dark),
      theme === "dark",
    );
    await page.screenshot({ path: NodePath.join(output, `sources-${theme}.png`), fullPage: true });
    await page.getByRole("button", { name: "Add source" }).click();
    await page.getByRole("button", { name: "Add GitHub Copilot" }).waitFor();
    // The list fades in; capture it settled.
    await page.waitForTimeout(400);
    await page.screenshot({
      path: NodePath.join(output, `sources-add-${theme}.png`),
      fullPage: true,
    });
    await page.getByRole("button", { name: "Add GitHub Copilot" }).click();
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Remove GitHub Copilot" }).waitFor();
    await page.waitForTimeout(400);
    await page.screenshot({
      path: NodePath.join(output, `sources-added-${theme}.png`),
      fullPage: true,
    });
    await page.close();
  }
  console.log(`saved to ${output}`);
} finally {
  await browser.close();
  server.close();
}
