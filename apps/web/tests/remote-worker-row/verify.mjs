// Build with vp build --config apps/web/tests/remote-worker-row/vite.config.ts first.
// Usage: node apps/web/tests/remote-worker-row/verify.mjs <evidence-dir> [--no-assert]
// Supply the installed Playwright entry via STUDIO_PLAYWRIGHT_MODULE, or it is found under apps/server.
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
process.env.PWDEBUG = "0";
process.env.PLAYWRIGHT_HTML_OPEN = "never";
const playwright =
  process.env.STUDIO_PLAYWRIGHT_MODULE ??
  NodePath.resolve("apps/server/node_modules/playwright-core/index.mjs");
const { chromium } = await import(NodeURL.pathToFileURL(playwright).href);
const root = NodePath.resolve(".artifacts/remote-worker-row/site");
const output = NodePath.resolve(process.argv[2] ?? ".artifacts/remote-worker-row/evidence");
const assertLayout = !process.argv.includes("--no-assert");
await NodeFSP.mkdir(output, { recursive: true });
const server = NodeHttp.createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, "http://localhost").pathname;
    const file = NodePath.resolve(root, `.${pathname === "/" ? "/index.html" : pathname}`);
    if (!file.startsWith(`${root}${NodePath.sep}`)) {
      res.writeHead(403).end();
      return;
    }
    const mime = file.endsWith(".js")
      ? "text/javascript"
      : file.endsWith(".css")
        ? "text/css"
        : "text/html";
    res.writeHead(200, { "Content-Type": mime });
    res.end(await NodeFSP.readFile(file));
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
const receipt = { headless: true, failures: [], screenshots: [] };
try {
  for (const theme of ["light", "dark"]) {
    // The Threads pane at its narrow widths, and a roomy one.
    for (const width of [280, 340, 520]) {
      const page = await browser.newPage({
        viewport: { width, height: 420 },
        deviceScaleFactor: 2,
      });
      await page.goto(`${origin}/?theme=${theme}`);
      await page.waitForSelector("[data-remote-worker]");
      const rows = await page.$$eval("[data-case]", (items) =>
        items.map((item) => {
          const card = item.querySelector("[data-remote-worker]").getBoundingClientRect();
          const parts = [
            ...item.querySelectorAll(
              ".sws-thread-card-title, .sws-machine-chip, .sws-thread-card-status, .sws-thread-card-action",
            ),
          ].map((element) => {
            const box = element.getBoundingClientRect();
            return {
              kind: element.className,
              text: element.textContent,
              left: box.left,
              right: box.right,
              top: box.top,
              bottom: box.bottom,
              width: box.width,
              clipped: element.scrollWidth > element.clientWidth + 1,
              title: element.closest("[title]")?.getAttribute("title") ?? null,
            };
          });
          return { id: item.dataset.case, card: { left: card.left, right: card.right }, parts };
        }),
      );
      for (const row of rows) {
        const where = `${theme} ${width}px ${row.id}`;
        const visible = row.parts.filter((part) => part.width > 0.5);
        const statuses = visible.filter((part) => part.kind.includes("sws-thread-card-status"));
        if (statuses.length > 1)
          receipt.failures.push(`${where}: ${statuses.length} messages shown`);
        for (let a = 0; a < visible.length; a += 1)
          for (let b = a + 1; b < visible.length; b += 1) {
            const [x, y] = [visible[a], visible[b]];
            const across = x.left < y.right - 0.5 && y.left < x.right - 0.5;
            const down = x.top < y.bottom - 0.5 && y.top < x.bottom - 0.5;
            if (across && down) receipt.failures.push(`${where}: "${x.text}" overlaps "${y.text}"`);
          }
        for (const part of visible)
          if (part.right > row.card.right + 0.5)
            receipt.failures.push(`${where}: "${part.text}" runs past the card`);
        const title = row.parts.find((part) => part.kind.includes("sws-thread-card-title"));
        if (!title || title.width < 24)
          receipt.failures.push(`${where}: title squeezed to ${title?.width ?? 0}px`);
      }
      const file = NodePath.join(output, `remote-worker-rows-${theme}-${width}.png`);
      await page.locator("main").screenshot({ path: file });
      receipt.screenshots.push(file);
      receipt[`${theme}-${width}`] = rows;
      await page.close();
    }
  }
} finally {
  await browser.close();
  server.close();
}
await NodeFSP.writeFile(
  NodePath.join(output, "receipt.json"),
  `${JSON.stringify(receipt, null, 2)}\n`,
);
console.log(receipt.screenshots.join("\n"));
if (receipt.failures.length > 0) {
  console.error(receipt.failures.join("\n"));
  if (assertLayout) process.exit(1);
}
