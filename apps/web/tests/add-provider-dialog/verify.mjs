// Build with vp build --config apps/web/tests/add-provider-dialog/vite.config.ts first.
// Supply the installed Playwright entry via STUDIO_PLAYWRIGHT_MODULE.
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeAssert from "node:assert/strict";
process.env.PWDEBUG = "0";
process.env.PLAYWRIGHT_HTML_OPEN = "never";
const { chromium } = await import(NodeURL.pathToFileURL(process.env.STUDIO_PLAYWRIGHT_MODULE).href);
const root = NodePath.resolve(".artifacts/add-provider-dialog/site");
const output = NodePath.resolve(process.argv[2] ?? ".artifacts/add-provider-dialog/evidence");
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
        : file.endsWith(".svg")
          ? "image/svg+xml"
          : "text/html";
    const data = await NodeFSP.readFile(file);
    res.writeHead(200, { "Content-Type": mime });
    res.end(data);
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
const checks = [];
const errors = [];
const inViewport = async (locator) => {
  const box = await locator.boundingBox();
  const height = await locator.page().evaluate(() => innerHeight);
  return box !== null && box.y >= 0 && box.y + box.height <= height;
};
try {
  const page = await browser.newPage({ reducedMotion: "reduce" });
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.route("**/*", (route) =>
    route.request().url().startsWith(origin) ? route.continue() : route.abort(),
  );
  for (const [width, height] of [
    [1440, 900],
    [1280, 640],
    [390, 700],
  ]) {
    for (const theme of ["light", "dark"]) {
      await page.setViewportSize({ width, height });
      await page.goto(`${origin}/?theme=${theme}`);
      const dialog = page.getByRole("dialog");
      await dialog.getByText("Built-in providers").waitFor();
      await page.screenshot({
        path: NodePath.join(output, `${width}x${height}-${theme}-closed.png`),
      });
      await dialog.getByRole("radio", { name: "Cursor" }).click();
      const next = dialog.getByRole("button", { name: "Next", exact: true });
      await dialog.getByRole("button", { name: /More agents/ }).click();
      await dialog.getByLabel("Search ACP Registry").waitFor();
      NodeAssert.ok(
        await inViewport(next),
        `Next visible at ${width}x${height} with More agents open`,
      );
      await page.screenshot({
        path: NodePath.join(output, `${width}x${height}-${theme}-more-open.png`),
      });
      const overflowing = await page.evaluate(() => {
        const popup = document.querySelector("[data-slot=dialog-popup]");
        const right = popup.getBoundingClientRect().right;
        return [...popup.querySelectorAll("*")].filter(
          (element) => element.getBoundingClientRect().right > right + 1,
        ).length;
      });
      NodeAssert.equal(overflowing, 0, `No content wider than the dialog at ${width}x${height}`);
      checks.push(`${width}x${height} ${theme}: Next stays in view, no overflow`);
    }
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${origin}/`);
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: /More agents/ }).click();
  for (const name of [
    "Codex",
    "Claude Agent",
    "Cursor",
    "OpenCode",
    "OpenCode V2",
    "pi ACP",
    "Google Antigravity",
    "Grok Build",
    "Copilot",
  ]) {
    NodeAssert.equal(
      await dialog.getByRole("button", { name: `Add ${name}`, exact: true }).count(),
      0,
      name,
    );
  }
  // Gemini's featured card shares its registry name; the list must not add a second button.
  NodeAssert.equal(
    await dialog.getByRole("button", { name: "Add Gemini CLI", exact: true }).count(),
    1,
  );
  NodeAssert.equal(await dialog.getByRole("button", { name: "Add Amp", exact: true }).count(), 1);
  checks.push("Registry list repeats no built-in or featured provider");
  NodeAssert.equal(
    await dialog.getByRole("button", { name: "Add Grok Build", exact: true }).count(),
    0,
  );
  await dialog.getByRole("radio", { name: "Grok" }).click();
  await dialog.getByRole("button", { name: "Add Grok Build", exact: true }).waitFor();
  await dialog.getByText("No CLI there?").waitFor();
  await page.screenshot({ path: NodePath.join(output, "1440-grok-selected.png") });
  checks.push("Grok Build installer appears only with the built-in Grok selected");
  await dialog.getByLabel("Search ACP Registry").fill("codex");
  await dialog.getByText("Codex is built in").waitFor();
  await page.screenshot({ path: NodePath.join(output, "1440-search-built-in.png") });
  checks.push("Searching a built-in provider points back to the grid");
  NodeAssert.deepEqual(errors, []);
  await NodeFSP.writeFile(
    NodePath.join(output, "receipt.json"),
    JSON.stringify({ checks }, null, 2),
  );
  console.log(checks.join("\n"));
} finally {
  await browser.close();
  server.close();
}
