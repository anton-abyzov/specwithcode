// Build with vp build --config apps/web/tests/overview-1249/vite.config.ts first, then run
// from the repository root. Supply the installed Playwright entry via STUDIO_PLAYWRIGHT_MODULE.
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeAssert from "node:assert/strict";
process.env.PWDEBUG = "0";
process.env.PLAYWRIGHT_HTML_OPEN = "never";
const { chromium } = await import(NodeURL.pathToFileURL(process.env.STUDIO_PLAYWRIGHT_MODULE).href);
const root = NodePath.resolve(".artifacts/overview-1249/site");
const output = NodePath.resolve(
  process.env.OVERVIEW_EVIDENCE ?? ".artifacts/overview-1249/evidence",
);
await NodeFSP.mkdir(output, { recursive: true });
const server = NodeHttp.createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, "http://localhost").pathname;
    const file = NodePath.resolve(root, `.${pathname === "/" ? "/index.html" : pathname}`);
    if (!file.startsWith(`${root}${NodePath.sep}`)) return void res.writeHead(403).end();
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
const receipt = { headless: true, checks: [], screenshots: [] };
const check = (name, ok, detail = "") => {
  receipt.checks.push({ name, ok, detail });
  NodeAssert.ok(ok, `${name} ${detail}`);
};
try {
  // 580 is the content beside the sidebar in the desktop app's 840 px minimum window.
  for (const theme of ["light", "dark"]) {
    for (const width of [1440, 1024, 768, 580, 390]) {
      const page = await browser.newPage({
        viewport: { width, height: 900 },
        deviceScaleFactor: 2,
      });
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(`${origin}/?theme=${theme}`);
      await page.locator("#studio-heading").waitFor();
      const label = `${theme} ${width}`;
      check(`${label}: no page errors`, errors.length === 0, errors.join("; "));
      const overflow = await page.evaluate(() => {
        const scroller = document.querySelector(".studio-scroll");
        const wide = [...document.querySelectorAll(".studio-content *")].filter(
          (element) => element.getBoundingClientRect().right > window.innerWidth + 1,
        );
        return {
          page: document.documentElement.scrollWidth - window.innerWidth,
          scroller: scroller.scrollWidth - scroller.clientWidth,
          wide: wide.slice(0, 3).map((element) => element.className),
        };
      });
      check(
        `${label}: nothing runs off the side`,
        overflow.page <= 0 && overflow.scroller <= 0 && overflow.wide.length === 0,
        JSON.stringify(overflow),
      );
      const unnamed = await page.evaluate(() =>
        [...document.querySelectorAll(".studio-desk a, .studio-desk button, .studio-desk input")]
          .filter((element) => {
            const name =
              element.getAttribute("aria-label") ??
              (element.labels?.[0]?.textContent || element.textContent || "").trim();
            return !name;
          })
          .map((element) => element.outerHTML.slice(0, 80)),
      );
      check(
        `${label}: every link and button has a name`,
        unnamed.length === 0,
        unnamed.join(" | "),
      );
      const file = NodePath.join(output, `overview-${theme}-${width}.png`);
      await page.screenshot({ path: file, fullPage: true });
      receipt.screenshots.push(file);
      if (theme === "light" && width === 1440) {
        // J walks the rows; the first lands on the most urgent chat.
        await page.keyboard.press("j");
        const focused = await page.evaluate(() => document.activeElement?.textContent ?? "");
        check("J focuses the first Needs you row", focused.includes("Fix Sadiya Datadog"), focused);
        await page.screenshot({ path: NodePath.join(output, "overview-keyboard-focus.png") });
        // A machine narrows every list to it.
        await page.getByRole("button", { name: /^M1 Max/ }).click();
        const scope = await page.locator(".studio-scope").textContent();
        check("machine filter names the machine", scope.includes("M1 Max"), scope);
        const rows = await page.locator(".studio-attention-item").count();
        check("machine filter keeps only its chats", rows === 3, String(rows));
        await page.screenshot({
          path: NodePath.join(output, "overview-machine-filter.png"),
          fullPage: true,
        });
      }
      await page.close();
    }
  }
  const page = await browser.newPage({ viewport: { width: 1024, height: 800 } });
  await page.goto(`${origin}/?theme=light&data=empty`);
  await page.locator("#studio-heading").waitFor();
  check(
    "empty workspace says nothing needs you",
    (await page.locator("h1").textContent()) === "Nothing needs you",
  );
  await page.screenshot({
    path: NodePath.join(output, "overview-empty-light-1024.png"),
    fullPage: true,
  });
  await page.close();
} finally {
  await browser.close();
  server.close();
  await NodeFSP.writeFile(NodePath.join(output, "receipt.json"), JSON.stringify(receipt, null, 2));
}
console.log(`${receipt.checks.length} checks passed; evidence in ${output}`);
