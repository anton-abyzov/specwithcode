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

  for (const [width, theme, state] of [
    [1024, "light", "default"],
    [1024, "dark", "default"],
    [375, "light", "default"],
    [1024, "light", "edited"],
  ]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`${origin}/?theme=${theme}&state=${state}`);
    await page.getByTestId("fallback-options").waitFor();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    NodeAssert.ok(overflow <= 0, `horizontal overflow ${overflow}px at ${width}`);
    const shot = NodePath.join(output, `options-${width}-${theme}-${state}.png`);
    await page.screenshot({ path: shot, fullPage: true });
    checks.push({ width, theme, state, overflow, shot });
  }

  await page.setViewportSize({ width: 1024, height: 900 });
  await page.goto(`${origin}/?theme=light`);
  const families = await page.locator("section h4").allTextContents();
  NodeAssert.deepEqual(families, ["Claude", "OpenAI", "Google", "xAI"]);
  await NodeAssert.doesNotReject(row("GPT-6 Astra").getByText("#1 in order").waitFor());
  NodeAssert.match(await row("Gemini Argon 4").textContent(), /never automatic/);
  NodeAssert.match(await row("Copilot managed").textContent(), /Signed out/);
  NodeAssert.match(await row("GitHub Copilot").textContent(), /provider reports no usage/);
  NodeAssert.match(await row("Grok 4.7").textContent(), /Can take a limited thread/);
  await page.getByRole("button", { name: "Exclude Grok 4.7" }).click();
  NodeAssert.match(await row("Grok 4.7").textContent(), /Excluded from automatic fallback/);
  NodeAssert.equal(await page.getByTestId("excluded-count").textContent(), "1 excluded");
  await page.screenshot({
    path: NodePath.join(output, "options-grok-excluded.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "Include Grok 4.7" }).click();
  NodeAssert.equal(await page.getByTestId("excluded-count").textContent(), "Nothing excluded");
  checks.push({
    interaction:
      "Exclude then Include Grok 4.7; family order; order rank; Vertex, signed-out and Copilot labels",
  });

  NodeAssert.deepEqual(errors, []);
  const receipt = { headless: true, passed: checks.length, checks, errors };
  await NodeFSP.writeFile(NodePath.join(output, "receipt.json"), JSON.stringify(receipt, null, 2));
  console.log(JSON.stringify({ passed: checks.length, output }));
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
