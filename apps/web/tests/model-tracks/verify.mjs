// Headless only: PWDEBUG=0, PLAYWRIGHT_HTML_OPEN=never
import * as NodeAssert from "node:assert/strict";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";

process.env.PWDEBUG = "0";
process.env.PLAYWRIGHT_HTML_OPEN = "never";
const require = NodeModule.createRequire(NodePath.resolve("apps/server/package.json"));
const { chromium } = process.env.STUDIO_PLAYWRIGHT_MODULE
  ? await import(process.env.STUDIO_PLAYWRIGHT_MODULE)
  : require("playwright-core");

const root = NodePath.resolve(".artifacts/model-tracks/site");
const output = NodePath.resolve(process.argv[2] ?? ".artifacts/model-tracks/evidence");
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
const open = async (width, theme, state) => {
  const page = await browser.newPage({
    viewport: { width, height: 900 },
    deviceScaleFactor: 2,
    reducedMotion: "reduce",
    colorScheme: theme,
  });
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.goto(`${origin}/?theme=${theme}&state=${state}`);
  await page.getByRole("list", { name: "Sources order" }).waitFor();
  return page;
};
const texts = (page, name) =>
  page.getByRole("list", { name, exact: true }).locator(":scope > li").allInnerTexts();
// dnd-kit attaches its key listeners a tick after the grip takes the drag.
const key = async (page, name, times = 1) => {
  for (let i = 0; i < times; i++) {
    await page.keyboard.press(name);
    await page.waitForTimeout(120);
  }
};
const saved = (page) => page.evaluate(() => window.fixtureSettings());

try {
  for (const [width, theme, state] of [
    [1024, "light", "default"],
    [1024, "dark", "default"],
    [390, "dark", "default"],
    [1024, "light", "custom"],
  ]) {
    const page = await open(width, theme, state);
    NodeAssert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      true,
      `no sideways scroll at ${width}`,
    );
    await page.screenshot({
      path: NodePath.join(output, `tracks-${state}-${theme}-${width}.png`),
      fullPage: true,
    });
    await page.close();
  }

  // Built-in orders, harness first, no percent on any row.
  const page = await open(1024, "light", "default");
  const daily = await texts(page, "Daily order");
  NodeAssert.equal(daily.length, 4);
  NodeAssert.match(
    daily[0],
    /Claude Opus 5\.5[\s\S]*Claude Code[\s\S]*then[\s\S]*GitHub Copilot Enterprise/,
  );
  NodeAssert.match(daily[1], /Claude Sonnet 5\.5[\s\S]*Claude Code/);
  NodeAssert.match(daily[2], /GPT-6\.1 Sol[\s\S]*Codex[\s\S]*Limit until/);
  NodeAssert.doesNotMatch((await texts(page, "Daily order")).join("\n"), /Muse/);
  NodeAssert.doesNotMatch((await texts(page, "Complex order")).join("\n"), /Muse/);
  // Each row's effort: Medium unless it names one; Muse Wonder Full reviews at Extra High.
  const effort = (track, name) =>
    page
      .locator(`#model-track-${track}`)
      .getByRole("combobox", { name: `Effort for ${name}`, exact: true })
      .innerText();
  NodeAssert.equal(await effort("daily", "Claude Opus 5.5"), "Medium");
  NodeAssert.equal(await effort("daily", "GPT-6.1 Sol"), "Medium");
  NodeAssert.equal(await effort("review", "Muse Wonder Full 1.0"), "Extra High");
  NodeAssert.match(daily[3], /GPT-6 Luna[\s\S]*Free, used last[\s\S]*Codex \(ChatGPT Free\)/);
  NodeAssert.doesNotMatch(await page.locator("main").innerText(), /\d+\s?%/);
  const review = await texts(page, "Review order");
  NodeAssert.match(review.at(-1), /Gemini 4 Carbon[\s\S]*Not installed/);
  const sources = await texts(page, "Sources order");
  NodeAssert.match(sources[0], /Claude Code[\s\S]*Harness/);
  NodeAssert.match(sources.at(-1), /Claude API key[\s\S]*never automatic/);

  // Keyboard: move GitHub Copilot Enterprise to the top of Sources; the order is saved.
  const copilot = page.getByRole("button", { name: /Reorder GitHub Copilot Enterprise/ });
  await copilot.focus();
  await key(page, "Space");
  await key(page, "ArrowUp", 6);
  await key(page, "Space");
  await page.waitForFunction(() => window.fixtureSettings().defaultModelProviders?.length > 0);
  NodeAssert.equal((await saved(page)).defaultModelProviders[0], "acpRegistry_copilot");
  NodeAssert.match(
    (await texts(page, "Daily order"))[0],
    /GitHub Copilot Enterprise[\s\S]*then[\s\S]*Claude Code/,
  );
  // A source never picked on its own cannot be dragged.
  NodeAssert.equal(
    await page.getByRole("button", { name: /Reorder Claude API key/ }).isDisabled(),
    true,
  );

  // Keyboard: move the third Daily row to the top; the built-in order becomes a saved one.
  const solGrip = page.getByRole("button", { name: /Reorder GPT-6\.1 Sol/ }).first();
  await solGrip.focus();
  await key(page, "Space");
  await key(page, "ArrowUp", 2);
  await key(page, "Space");
  await page.waitForFunction(() => window.fixtureSettings().modelLanes?.routine?.length > 0);
  NodeAssert.equal((await saved(page)).modelLanes.routine[0].model, "gpt-6.1-sol");
  await page.screenshot({
    path: NodePath.join(output, "tracks-after-reorder-light-1024.png"),
    fullPage: true,
  });
  // Back to the built-in order.
  await page
    .locator("#model-track-daily")
    .getByRole("button", { name: "Use the built-in order" })
    .click();
  await page.waitForFunction(() => window.fixtureSettings().modelLanes.routine.length === 0);
  await page.close();

  // A Review list in one family warns.
  const custom = await open(1024, "light", "custom");
  await custom.getByText(/Every reviewer here is from one model family/).waitFor();
  await custom.close();

  NodeAssert.deepEqual(errors, []);
  console.log(`model tracks fixture ok, screenshots in ${output}`);
} finally {
  await browser.close();
  server.close();
}
