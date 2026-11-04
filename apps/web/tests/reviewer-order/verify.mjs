// Headless only: PWDEBUG=0, PLAYWRIGHT_HTML_OPEN=never
import * as NodeAssert from "node:assert/strict";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodePath from "node:path";

process.env.PWDEBUG = "0";
process.env.PLAYWRIGHT_HTML_OPEN = "never";
const { chromium } = await import(process.env.STUDIO_PLAYWRIGHT_MODULE ?? "playwright");

const root = NodePath.resolve(".artifacts/reviewer-order/site");
const output = NodePath.resolve(process.argv[2] ?? ".artifacts/reviewer-order/evidence");
await NodeFSP.mkdir(output, { recursive: true });

const server = NodeHttp.createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, "http://localhost").pathname;
    if (pathname === "/favicon.ico") return void res.writeHead(204).end();
    const file = NodePath.resolve(root, `.${pathname === "/" ? "/index.html" : pathname}`);
    if (!file.startsWith(`${root}${NodePath.sep}`)) return void res.writeHead(403).end();
    const mime = file.endsWith(".js")
      ? "text/javascript"
      : file.endsWith(".css")
        ? "text/css"
        : "text/html";
    const content = await NodeFSP.readFile(file);
    res.writeHead(200, { "Content-Type": mime }).end(content);
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
try {
  for (const [width, theme, scope, state] of [
    [1024, "light", "app", "default"],
    [1024, "dark", "app", "default"],
    [390, "light", "app", "default"],
    [1024, "light", "project", "custom"],
    [1024, "dark", "project", "custom"],
    [390, "dark", "project", "custom"],
  ]) {
    const page = await browser.newPage({
      viewport: { width, height: 900 },
      deviceScaleFactor: 2,
      reducedMotion: "reduce",
      colorScheme: theme,
    });
    page.on("pageerror", (error) => errors.push(String(error)));
    await page.goto(`${origin}/?theme=${theme}&scope=${scope}&state=${state}&fallback=1`);
    const steps = page.getByRole("list", { name: "Reviewer order steps" });
    await steps.waitFor();
    const rows = steps.locator(":scope > li");
    if (state === "default") {
      NodeAssert.equal(await page.locator("[data-reviewer-order=default]").count(), 1);
      // Codex is at its weekly limit, so its Copilot alternates are tried next.
      NodeAssert.match(await rows.nth(0).innerText(), /GPT-6\.1 Sol[\s\S]*Full until/);
      const alternates = await rows.nth(0).getByRole("list").innerText();
      NodeAssert.match(alternates, /Copilot Enterprise \(abycrash\)[\s\S]*Ready/);
      NodeAssert.match(alternates, /Copilot personal \(anton-abyzov\)[\s\S]*Signed out/);
      NodeAssert.match(alternates, /Devin[\s\S]*Billing unknown/);
      NodeAssert.equal(await steps.getByRole("button", { name: /^Move / }).count(), 0);
    } else {
      NodeAssert.equal(await page.locator("[data-reviewer-order=custom]").count(), 1);
      NodeAssert.match(await rows.nth(0).innerText(), /Muse Wonder 1\.0[\s\S]*Ready/);
      await page.getByRole("button", { name: "Add a reviewer model" }).waitFor();
      NodeAssert.ok(await page.getByText("app-wide reviewer order").isVisible());
    }
    const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    NodeAssert.ok(scrollWidth <= width, `no horizontal scroll at ${width}px (got ${scrollWidth})`);
    const name = `after-${scope}-${state}-${theme}-${width}.png`;
    await page.screenshot({ path: NodePath.join(output, name), fullPage: true });
    console.log(`ok ${name}`);
    await page.close();
  }

  // Customize turns the default into an editable order, then a step moves.
  const page = await browser.newPage({ viewport: { width: 1024, height: 900 } });
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.goto(`${origin}/?scope=app&state=default`);
  await page.getByRole("button", { name: "Customize reviewer order" }).click();
  await page.locator("[data-reviewer-order=custom]").waitFor();
  const first = page
    .getByRole("list", { name: "Reviewer order steps" })
    .locator(":scope > li")
    .first();
  NodeAssert.match(await first.innerText(), /GPT-6\.1 Sol/);
  await page.getByRole("button", { name: "Move Codex · GPT-6.1 Sol down" }).click();
  NodeAssert.doesNotMatch(await first.innerText(), /^1?\s*GPT-6\.1 Sol/);
  await page.getByRole("button", { name: /Reset reviewer order/ }).click();
  await page.locator("[data-reviewer-order=default]").waitFor();
  console.log("ok customize, move, reset");
  await page.close();
  NodeAssert.deepEqual(errors, []);
} finally {
  await browser.close();
  server.close();
}
