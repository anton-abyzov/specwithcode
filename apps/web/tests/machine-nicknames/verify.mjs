// Headless: serves the built fixture and shoots narrow and wide, light and dark.
import { createServer } from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import { extname, join } from "node:path";
const [site, out] = process.argv.slice(2);
const { chromium } = await import(process.env.PLAYWRIGHT_CORE);
const types = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".woff2": "font/woff2",
};
const server = createServer(async (req, res) => {
  const path = join(
    site,
    decodeURIComponent(new URL(req.url, "http://x").pathname.replace(/\/$/, "/index.html")),
  );
  try {
    res.writeHead(200, { "content-type": types[extname(path)] ?? "application/octet-stream" });
    res.end(await readFile(path));
  } catch {
    res.writeHead(404);
    res.end();
  }
}).listen(0);
const port = server.address().port;
await mkdir(out, { recursive: true });
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.STUDIO_CHROMIUM_EXECUTABLE,
});
for (const [name, width] of [
  ["narrow", 390],
  ["wide", 900],
]) {
  for (const theme of ["light", "dark"]) {
    const page = await browser.newPage({ viewport: { width, height: 520 }, deviceScaleFactor: 2 });
    page.on("pageerror", (e) => console.error("PAGEERROR", e.message));
    page.on("console", (m) => m.type() === "error" && console.error("CONSOLE", m.text()));
    await page.goto(`http://127.0.0.1:${port}/index.html?theme=${theme}`);
    await page.waitForSelector("[data-case=picker] li");
    const text = await page.locator("body").innerText();
    await page.screenshot({ path: `${out}/nicknames-${name}-${theme}.png` });
    if (name === "wide" && theme === "light") console.log(text);
    await page.close();
  }
}
await browser.close();
server.close();
