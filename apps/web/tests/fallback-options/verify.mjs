// Headless only: PWDEBUG=0, PLAYWRIGHT_HTML_OPEN=never
import * as NodeAssert from "node:assert/strict";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodePath from "node:path";

process.env.PWDEBUG = "0";
process.env.PLAYWRIGHT_HTML_OPEN = "never";
const { chromium } = await import(process.env.STUDIO_PLAYWRIGHT_MODULE ?? "playwright");

const root = NodePath.resolve(".artifacts/fallback-options/site");
const output = NodePath.resolve(process.argv[2] ?? ".artifacts/fallback-options/evidence");
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
const checks = [];
try {
  const page = await browser.newPage({ reducedMotion: "reduce" });
  page.on("pageerror", (error) => errors.push(String(error)));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  const row = (text) => page.locator("li", { hasText: text });
  const family = (label) =>
    page.getByRole("button", { name: new RegExp(`^${label}\\b`), exact: false });
  const openAll = async () => {
    const folded = page.locator("h4 button[aria-expanded=false]");
    while ((await folded.count()) > 0) await folded.first().click();
  };

  for (const [width, theme, state, view] of [
    [1024, "light", "default", "folded"],
    [1024, "light", "default", "open"],
    [1024, "dark", "default", "open"],
    [375, "light", "default", "open"],
    [1024, "light", "edited", "open"],
  ]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`${origin}/?theme=${theme}&state=${state}`);
    await page.getByTestId("fallback-options").waitFor();
    if (view === "open") await openAll();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    NodeAssert.ok(overflow <= 0, `horizontal overflow ${overflow}px at ${width}`);
    const shot = NodePath.join(output, `options-${width}-${theme}-${state}-${view}.png`);
    await page.screenshot({ path: shot, fullPage: true });
    checks.push({ width, theme, state, view, overflow, shot });
  }

  await page.setViewportSize({ width: 1024, height: 900 });
  await page.goto(`${origin}/?theme=light`);
  const families = await page.getByTestId("family-label").allTextContents();
  NodeAssert.deepEqual(families, ["Claude", "OpenAI", "Google", "xAI"]);
  // Folded by default: a summary per family and no model rows.
  NodeAssert.equal(await page.locator("li").count(), 0);
  NodeAssert.match(await family("Claude").textContent(), /14 models · 13 ready now/);
  await family("Claude").click();
  // The plan's usage is said once for its twelve models; older versions wait behind a toggle.
  NodeAssert.equal(await page.getByText("Plan usage 49% used").count(), 1);
  NodeAssert.equal(await row("Claude Opus 4.8").count(), 0);
  NodeAssert.match(await row("Claude Haiku 5.5").textContent(), /Claude Haiku 5\.5/);
  await page.getByRole("button", { name: "Show 8 older versions" }).click();
  await NodeAssert.doesNotReject(row("Claude Opus 4.8").waitFor());
  await page.screenshot({
    path: NodePath.join(output, "options-claude-older-shown.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "Hide older versions" }).click();
  NodeAssert.equal(await row("Claude Opus 4.8").count(), 0);
  NodeAssert.match(
    await page.getByRole("region", { name: "Copilot managed models" }).textContent(),
    /Signed out/,
  );
  NodeAssert.match(
    await page.getByRole("region", { name: "GitHub Copilot models" }).textContent(),
    /provider reports no usage/,
  );
  await openAll();
  await NodeAssert.doesNotReject(row("GPT-6 Astra").getByText("#1 in order").waitFor());
  NodeAssert.match(
    await page.getByRole("region", { name: "Gemini CLI (Vertex AI) models" }).textContent(),
    /never automatic/,
  );
  NodeAssert.match(
    await page.getByRole("region", { name: "Grok models" }).textContent(),
    /Can take a limited thread/,
  );
  await page.getByRole("button", { name: "Exclude Grok 4.7" }).click();
  NodeAssert.match(
    await page.getByRole("region", { name: "Grok models" }).textContent(),
    /Excluded from automatic fallback/,
  );
  NodeAssert.equal(await page.getByTestId("excluded-count").textContent(), "1 excluded");
  NodeAssert.match(await family("xAI").textContent(), /1 excluded/);
  await page.screenshot({
    path: NodePath.join(output, "options-grok-excluded.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "Include Grok 4.7" }).click();
  NodeAssert.equal(await page.getByTestId("excluded-count").textContent(), "Nothing excluded");
  checks.push({
    interaction:
      "Folded families with summaries; Claude usage said once; Show/Hide 8 older versions; Exclude then Include Grok 4.7; order rank; Vertex, signed-out and Copilot labels",
  });

  NodeAssert.deepEqual(errors, []);
  const receipt = { headless: true, passed: checks.length, checks, errors };
  await NodeFSP.writeFile(NodePath.join(output, "receipt.json"), JSON.stringify(receipt, null, 2));
  console.log(JSON.stringify({ passed: checks.length, output }));
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
