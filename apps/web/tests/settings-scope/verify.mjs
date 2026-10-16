// Build with vp build --config apps/web/tests/settings-scope/vite.config.ts first.
// Supply the installed Playwright entry via STUDIO_PLAYWRIGHT_MODULE.
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeAssert from "node:assert/strict";
process.env.PWDEBUG = "0";
process.env.PLAYWRIGHT_HTML_OPEN = "never";
const { chromium } = await import(NodeURL.pathToFileURL(process.env.STUDIO_PLAYWRIGHT_MODULE).href);
const root = NodePath.resolve(".artifacts/settings-scope/site");
const output = NodePath.resolve(".artifacts/settings-scope/evidence");
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
    res.writeHead(200, { "Content-Type": mime }).end(await NodeFSP.readFile(file));
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
const checks = [];
try {
  const page = await browser.newPage({ reducedMotion: "reduce" });
  page.on("pageerror", (error) => errors.push(String(error)));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await page.route("**/*", (route) =>
    route.request().url().startsWith(origin) ? route.continue() : route.abort(),
  );
  const cases = [
    ["missing", "specweave isn't checked out on Anton's MacBook Pro M1Max"],
    ["offline", "Anton's MacBook Pro M1Max is offline"],
  ];
  for (const [view, title] of cases) {
    for (const [width, theme] of [
      [1280, "light"],
      [390, "dark"],
    ]) {
      await page.setViewportSize({ width, height: 700 });
      await page.goto(`${origin}/?view=${view}&theme=${theme}`);
      await page.getByTestId("project-checkout-missing").getByText(title).waitFor();
      NodeAssert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
        false,
      );
      await page.screenshot({
        path: NodePath.join(output, `${view}-${width}-${theme}.png`),
        fullPage: true,
      });
      checks.push(`${view} ${width} ${theme}: explains and offers choices, no overflow`);
    }
  }
  await page.goto(`${origin}/?view=missing`);
  await page.getByRole("button", { name: "Open on Anton's MacBook M4MAX" }).click();
  NodeAssert.equal(
    await page.getByTestId("picked").textContent(),
    JSON.stringify({ project: "specweave", machine: "m4" }),
  );
  checks.push("Open on a machine with a checkout keeps the project and switches environment");
  await page.getByRole("button", { name: "All environments" }).click();
  NodeAssert.equal(
    await page.getByTestId("picked").textContent(),
    JSON.stringify({ project: "specweave" }),
  );
  checks.push("All environments keeps the project");
  NodeAssert.deepEqual(errors, []);
  const receipt = {
    type: "isolated-component-fixture",
    headless: true,
    checks,
    errors,
    screenshotDirectory: output,
  };
  await NodeFSP.writeFile(NodePath.join(output, "receipt.json"), JSON.stringify(receipt, null, 2));
  console.log(JSON.stringify(receipt, null, 2));
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
