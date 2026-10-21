// Build with vp build --config apps/web/tests/provider-auto-enable/vite.config.ts first.
// Supply the installed Playwright entry via STUDIO_PLAYWRIGHT_MODULE. Always headless.
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeAssert from "node:assert/strict";
process.env.PWDEBUG = "0";
process.env.PLAYWRIGHT_HTML_OPEN = "never";
const { chromium } = await import(NodeURL.pathToFileURL(process.env.STUDIO_PLAYWRIGHT_MODULE).href);
const root = NodePath.resolve(".artifacts/provider-auto-enable/site");
const output = NodePath.resolve(".artifacts/provider-auto-enable/evidence");
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
    const data = await NodeFSP.readFile(file);
    res.writeHead(200, { "Content-Type": mime });
    res.end(data);
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true });
const errors = [];
const checks = [];
try {
  const page = await browser.newPage({ reducedMotion: "reduce" });
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.route("**/*", (route) =>
    route.request().url().startsWith(origin) ? route.continue() : route.abort(),
  );
  for (const mode of ["list", "editor"]) {
    for (const [width, theme] of [
      [390, "light"],
      [1280, "dark"],
    ]) {
      await page.setViewportSize({ width, height: 700 });
      await page.goto(`${origin}/?mode=${mode}&theme=${theme}`);
      const notice = page.getByTestId("provider-auto-enabled-notice");
      await notice.waitFor();
      NodeAssert.match(
        await notice.innerText(),
        /Turned on automatically because its CLI is signed in\./,
      );
      NodeAssert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
        false,
      );
      await page.screenshot({
        path: NodePath.join(output, `${mode}-${width}-${theme}.png`),
        fullPage: true,
      });
      // The row's select overlay must not swallow the Undo click.
      const undo = page.getByRole("button", { name: "Undo: turn off grok", exact: true });
      const box = await undo.boundingBox();
      const hit = await page.evaluate(
        ([x, y]) => document.elementFromPoint(x, y)?.textContent,
        [box.x + box.width / 2, box.y + box.height / 2],
      );
      NodeAssert.equal(hit, "Undo");
      await undo.click();
      await page.getByTestId("state").filter({ hasText: "enabled=false selected=0" }).waitFor();
      NodeAssert.equal(await notice.count(), 0);
      checks.push(
        `${mode} ${width} ${theme}: notice shown, Undo turns it off and hides the notice`,
      );
    }
  }
  NodeAssert.deepEqual(errors, []);
} finally {
  await browser.close();
  server.close();
}
await NodeFSP.writeFile(
  NodePath.join(output, "receipt.json"),
  JSON.stringify({ checks, errors }, null, 2),
);
console.log(checks.join("\n"));
