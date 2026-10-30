// Build with vp build --config apps/web/tests/provider-updates-dialog/vite.config.ts first.
// Supply the installed Playwright entry via STUDIO_PLAYWRIGHT_MODULE.
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeAssert from "node:assert/strict";
process.env.PWDEBUG = "0";
process.env.PLAYWRIGHT_HTML_OPEN = "never";
const { chromium } = await import(NodeURL.pathToFileURL(process.env.STUDIO_PLAYWRIGHT_MODULE).href);
const root = NodePath.resolve(
  process.env.STUDIO_FIXTURE_SITE ?? ".artifacts/provider-updates-dialog/site",
);
const output = NodePath.resolve(process.argv[2] ?? ".artifacts/provider-updates-dialog/evidence");
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
const platform = process.env.STUDIO_FIXTURE_PLATFORM ?? "local";
const checks = [];
const errors = [];
try {
  const page = await browser.newPage({ reducedMotion: "reduce" });
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.route("**/*", (route) =>
    route.request().url().startsWith(origin) ? route.continue() : route.abort(),
  );
  for (const [width, height] of [
    [1280, 800],
    [390, 760],
  ]) {
    for (const theme of ["light", "dark"]) {
      const name = `${platform}-${width}x${height}-${theme}`;
      await page.setViewportSize({ width, height });
      await page.goto(`${origin}/?theme=${theme}`);
      await page.getByRole("dialog").getByText("Update Codex").waitFor();
      await page.waitForTimeout(250);
      await page.screenshot({ path: NodePath.join(output, `${name}.png`) });
      const layout = await page.evaluate(() => {
        const popup = document.querySelector("[data-slot=dialog-popup]").getBoundingClientRect();
        const leaves = [...document.querySelectorAll("[data-slot=dialog-popup] *")].filter(
          (element) =>
            !element.closest("[data-slot=dialog-close]") &&
            [...element.childNodes].some((node) => node.nodeType === 3 && node.textContent.trim()),
        );
        const outside = leaves
          .map((element) => ({
            text: element.textContent.trim().slice(0, 40),
            box: element.getBoundingClientRect(),
          }))
          .filter(({ box }) => box.left < popup.left + 16 || box.right > popup.right - 16)
          .map(
            ({ text, box }) =>
              `${text} [${Math.round(box.left - popup.left)}..${Math.round(popup.right - box.right)}]`,
          );
        const title = document.querySelector("[data-slot=dialog-title]").getBoundingClientRect();
        const action = [...document.querySelectorAll("[data-slot=dialog-popup] button")]
          .find((button) => /Update \d+ selected/.test(button.textContent))
          .getBoundingClientRect();
        const checkbox = document
          .querySelector("[data-slot=dialog-popup] [data-slot=checkbox]")
          ?.getBoundingClientRect();
        const rowTitle = document
          .querySelector("[data-provider-update-row] [data-row-title]")
          ?.getBoundingClientRect();
        return {
          outside,
          titleInset: title.top - popup.top,
          actionInset: popup.bottom - action.bottom,
          checkboxOffset:
            checkbox && rowTitle
              ? Math.abs(checkbox.top + checkbox.height / 2 - (rowTitle.top + rowTitle.height / 2))
              : null,
          overflowX: document.documentElement.scrollWidth > innerWidth,
        };
      });
      NodeAssert.deepEqual(layout.outside, [], `${name}: text keeps 16px from the dialog edges`);
      NodeAssert.ok(layout.titleInset >= 16, `${name}: title inset ${layout.titleInset}`);
      NodeAssert.ok(layout.actionInset >= 12, `${name}: action inset ${layout.actionInset}`);
      NodeAssert.ok(
        layout.checkboxOffset !== null && layout.checkboxOffset <= 3,
        `${name}: checkbox aligned (${layout.checkboxOffset})`,
      );
      NodeAssert.equal(layout.overflowX, false, `${name}: no horizontal overflow`);
      checks.push({ name, ...layout });
    }
  }
  NodeAssert.deepEqual(errors, []);
} finally {
  await browser.close();
  server.close();
  await NodeFSP.writeFile(
    NodePath.join(output, `receipt-${platform}.json`),
    `${JSON.stringify({ platform, checks, errors }, null, 2)}\n`,
  );
}
console.log(`provider-updates-dialog: ${checks.length} layouts passed on ${platform}`);
