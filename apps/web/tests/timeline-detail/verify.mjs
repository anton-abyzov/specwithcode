// Build first: vp build --config apps/web/tests/timeline-detail/vite.config.ts
// Supply the installed Playwright entry via STUDIO_PLAYWRIGHT_MODULE. Always headless.
import * as NodeAssert from "node:assert/strict";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
process.env.PWDEBUG = "0";
process.env.PLAYWRIGHT_HTML_OPEN = "never";
const { chromium } = await import(NodeURL.pathToFileURL(process.env.STUDIO_PLAYWRIGHT_MODULE).href);
const root = NodePath.resolve(".artifacts/timeline-detail/site");
const output = NodePath.resolve(
  process.env.TIMELINE_DETAIL_UI_OUTPUT ?? ".artifacts/timeline-detail/evidence",
);
await NodeFSP.mkdir(output, { recursive: true });
const MIME = { ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2" };
const server = NodeHttp.createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, "http://localhost").pathname;
    const file = NodePath.resolve(root, `.${pathname === "/" ? "/index.html" : pathname}`);
    if (!file.startsWith(`${root}${NodePath.sep}`)) {
      res.writeHead(403).end();
      return;
    }
    const body = await NodeFSP.readFile(file);
    res.writeHead(200, { "Content-Type": MIME[NodePath.extname(file)] ?? "text/html" });
    res.end(body);
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

const FINISHED_NOTE = "Running the parser tests to see the failure.";
const FINISHED_ANSWER = "Fixed: quoted keys keep their spaces now, and all 42 parser tests pass.";
const FAILURE_OUTPUT = "Expected 'a b', received 'a'";
const THOUGHT = "The tokenizer stops at the first space even inside quotes.";
const LIVE_NOTE = "Reading the changelog first.";
const LIVE_LATEST = "Adding the entry under Unreleased now.";
const LIVE_THOUGHT = "The entry belongs under Unreleased.";

const errors = [];
const receipt = [];

async function shown(page, text) {
  return (await page.getByText(text, { exact: false }).filter({ visible: true }).count()) > 0;
}

const LEVEL_NAMES = { concise: "Results only", normal: "Folded steps", verbose: "Everything" };

async function expectLevel(page, label, level) {
  const main = page.locator("main");
  await page.waitForFunction(
    (value) => document.querySelector("main")?.dataset.detail === value,
    level,
  );
  const name = LEVEL_NAMES[level];
  const trigger = page.locator("[data-timeline-detail]");
  NodeAssert.ok((await trigger.getAttribute("aria-label"))?.endsWith(`Show: ${name}`), label);
  NodeAssert.equal(await trigger.getAttribute("data-timeline-detail"), level, label);
  NodeAssert.equal(await main.getAttribute("data-detail"), level, label);
  // Without a project the trigger names what the timeline shows.
  const levelName = trigger.locator("[data-timeline-detail-label]");
  NodeAssert.equal(await levelName.innerText(), name, `${label}: level not named`);
  await inHeaderCorner(page, label);
  // Let the list settle after the rows change.
  await page.waitForTimeout(400);
}

// The real ChatHeader: the trigger sits at the header's end, after the thread title,
// left of the room the header keeps for the panel controls.
async function inHeaderCorner(page, label) {
  const header = await page.locator("[data-chat-header]").boundingBox();
  const trigger = await page.locator("[data-timeline-detail]").boundingBox();
  const title = await page.getByRole("heading", { name: "Fix the parser tests" }).boundingBox();
  NodeAssert.ok(trigger.x >= title.x + title.width, `${label}: trigger before the title`);
  const gap = header.x + header.width - (trigger.x + trigger.width);
  NodeAssert.ok(gap >= 96 && gap <= 140, `${label}: trigger ${gap}px from the header's end`);
  NodeAssert.ok(
    trigger.y >= header.y && trigger.y + trigger.height <= header.y + header.height,
    `${label}: trigger inside the header`,
  );
}

async function noOverflow(page, label) {
  NodeAssert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
    false,
    `${label}: horizontal page overflow`,
  );
}

async function chooseFromMenu(page, level) {
  await page.locator("[data-timeline-detail]").click();
  // The default group, the menu's last radio of that name.
  await page
    .getByRole("menuitemradio", { name: new RegExp(`^${LEVEL_NAMES[level]}`) })
    .last()
    .click();
}

try {
  for (const [width, height] of [
    [1280, 900],
    [390, 844],
  ]) {
    // The end of the timeline is always rendered; the start only when the window is tall.
    const wide = width >= 1024;
    for (const theme of ["light", "dark"]) {
      const context = await browser.newContext({
        viewport: { width, height },
        reducedMotion: "reduce",
      });
      const page = await context.newPage();
      page.on("pageerror", (error) => errors.push(String(error)));
      await page.route("**/*", (route) =>
        route.request().url().startsWith(origin) ? route.continue() : route.abort(),
      );
      const shot = (level) => NodePath.join(output, `thread-${level}-${theme}-${width}.png`);
      const row = { width, theme, levels: {} };
      await page.goto(`${origin}/?theme=${theme}`);
      await page.locator("main").waitFor();

      // Normal: the finished turn folds to its answer; the live turn shows its messages.
      let label = `${width}-${theme}-normal`;
      await expectLevel(page, label, "normal");
      NodeAssert.equal(await shown(page, LIVE_NOTE), true, `${label}: live note`);
      NodeAssert.equal(await shown(page, LIVE_LATEST), true, `${label}: latest live message`);
      if (wide) {
        NodeAssert.equal(await shown(page, FINISHED_ANSWER), true, `${label}: answer`);
        NodeAssert.equal(await shown(page, FINISHED_NOTE), false, `${label}: folded note shown`);
        NodeAssert.equal(await shown(page, THOUGHT), false, `${label}: folded thought shown`);
      }
      await noOverflow(page, label);
      await page.screenshot({ path: shot("normal") });
      row.levels.normal = shot("normal");

      // Verbose from the menu: every turn, tool call, output and thought is open.
      await chooseFromMenu(page, "verbose");
      label = `${width}-${theme}-verbose`;
      await expectLevel(page, label, "verbose");
      NodeAssert.equal(await shown(page, LIVE_NOTE), true, `${label}: live note`);
      NodeAssert.equal(
        await shown(page, "sed -n 1,40p CHANGELOG.md"),
        true,
        `${label}: live command`,
      );
      NodeAssert.equal(await shown(page, LIVE_THOUGHT), true, `${label}: live thought`);
      if (wide) {
        NodeAssert.equal(await shown(page, FINISHED_NOTE), true, `${label}: note in finished turn`);
        NodeAssert.equal(await shown(page, FAILURE_OUTPUT), true, `${label}: command output`);
        NodeAssert.equal(await shown(page, THOUGHT), true, `${label}: thought`);
      }
      await noOverflow(page, label);
      await page.screenshot({ path: shot("verbose") });
      row.levels.verbose = shot("verbose");

      // Concise from the shortcut (Verbose wraps to Concise), announced by a toast.
      await page.locator("main").click({ position: { x: 5, y: 60 } });
      await page.keyboard.press("ControlOrMeta+Alt+KeyO");
      label = `${width}-${theme}-concise`;
      await expectLevel(page, label, "concise");
      await page.getByText("Show: Results only", { exact: true }).waitFor();
      NodeAssert.equal(await shown(page, LIVE_LATEST), true, `${label}: latest live message`);
      NodeAssert.equal(await shown(page, LIVE_NOTE), false, `${label}: earlier live message shown`);
      NodeAssert.equal(await shown(page, LIVE_THOUGHT), false, `${label}: live thought shown`);
      if (wide) {
        NodeAssert.equal(await shown(page, FINISHED_ANSWER), true, `${label}: answer`);
        NodeAssert.equal(await shown(page, FINISHED_NOTE), false, `${label}: finished note shown`);
        NodeAssert.equal(
          await shown(page, "Ran 2 commands and changed 1 file"),
          true,
          `${label}: fold summary`,
        );
      }
      await noOverflow(page, label);
      await page.screenshot({ path: shot("concise") });
      row.levels.concise = shot("concise");

      // The level is a saved setting: it survives a reload.
      await page.reload();
      await page.locator("main").waitFor();
      await expectLevel(page, `${label}-reload`, "concise");
      row.persistsAcrossReload = true;

      // Another press wraps back to Normal.
      await page.keyboard.press("ControlOrMeta+Alt+KeyO");
      await expectLevel(page, `${width}-${theme}-cycle`, "normal");
      row.cyclesBackToNormal = true;
      receipt.push(row);
      await context.close();
    }
  }
  NodeAssert.deepEqual(errors, []);
  await NodeFSP.writeFile(
    NodePath.join(output, "receipt.json"),
    JSON.stringify({ headless: true, checks: receipt }, null, 2) + "\n",
  );
  console.log(JSON.stringify({ passed: receipt.length, output }));
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
