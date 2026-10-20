// Headless check that sidebar chats hold still while live updates stream in.
// Usage: node apps/web/tests/sidebar-stable-order/verify.mjs <evidence-dir> [--site DIR] [--baseline]
// --baseline reports what happens without failing (used to record the old behaviour).
import * as NodeAssert from "node:assert/strict";
import * as NodeHttp from "node:http";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
const assert = NodeAssert.default;
const { resolve, extname, join } = NodePath;
const { readFile, mkdir, writeFile } = NodeFSP;
const homedir = NodeOS.homedir;
process.env.PWDEBUG = "0";
process.env.PLAYWRIGHT_HTML_OPEN = "never";
const { chromium } = NodeModule.createRequire(import.meta.url)(
  process.env.STUDIO_PLAYWRIGHT_MODULE ||
    join(
      homedir(),
      ".cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright",
    ),
);
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : null);
const baseline = flag("--baseline");
const site = resolve(option("--site") || ".artifacts/sidebar-stable-order/site");
const output = resolve(
  args[0] && !args[0].startsWith("--") ? args[0] : ".artifacts/sidebar-stable-order/evidence",
);
await mkdir(output, { recursive: true });
const server = NodeHttp.createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, "http://localhost").pathname;
    const file = resolve(site, "." + (pathname === "/" ? "/index.html" : pathname));
    if (!file.startsWith(site + "/")) throw Error("path");
    res.setHeader(
      "content-type",
      { ".js": "text/javascript", ".css": "text/css", ".html": "text/html" }[extname(file)] ||
        "application/octet-stream",
    );
    res.end(await readFile(file));
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const browser = await chromium.launch({
  headless: true,
  executablePath:
    process.env.STUDIO_CHROMIUM_EXECUTABLE ||
    join(
      homedir(),
      "Library/Caches/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-mac-arm64/chrome-headless-shell",
    ),
});
const receipt = {
  headless: true,
  baseline,
  scope:
    "Real StudioSidebar and chat sort; simulated thread shells streaming updatedAt/status events every 40 ms; no live store or provider",
  cases: [],
};
const check = (condition, message) => {
  if (!baseline) assert.ok(condition, message);
};
try {
  for (const [width, height, theme] of [
    [1280, 900, "dark"],
    [390, 844, "light"],
  ]) {
    const page = await browser.newPage({ viewport: { width, height } });
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/?theme=${theme}`);
    await page.locator(".sws-chat-row").first().waitFor();
    const initial = await page.evaluate(() => window.fixture.order());
    await page.screenshot({ path: join(output, `${width}-${theme}-start.png`) });
    // Watch every frame for 3 s of live events: count reorders, frame gaps and the open row.
    const watch = () =>
      page.evaluate(
        (ms) =>
          new Promise((done) => {
            const start = performance.now();
            let last = window.fixture.order().join("|");
            let previousFrame = start;
            const seen = { reorders: 0, frames: 0, worstFrameMs: 0, currents: new Set() };
            const frame = (t) => {
              seen.frames += 1;
              seen.worstFrameMs = Math.max(seen.worstFrameMs, t - previousFrame);
              previousFrame = t;
              const now = window.fixture.order().join("|");
              if (now !== last) seen.reorders += 1;
              last = now;
              seen.currents.add(window.fixture.current());
              if (t - start < ms) requestAnimationFrame(frame);
              else done({ ...seen, currents: [...seen.currents], order: window.fixture.order() });
            };
            requestAnimationFrame(frame);
          }),
        3000,
      );
    const before = await page.evaluate(() => window.fixture.events());
    const streaming = await watch();
    const events = (await page.evaluate(() => window.fixture.events())) - before;
    await page.screenshot({ path: join(output, `${width}-${theme}-after-${events}-events.png`) });
    check(events >= 40, `only ${events} live events arrived`);
    check(streaming.reorders === 0, `rows reordered ${streaming.reorders} times while streaming`);
    check(
      JSON.stringify(streaming.order) === JSON.stringify(initial),
      `order changed: ${streaming.order}`,
    );
    check(
      JSON.stringify(streaming.currents) === JSON.stringify(["0951 Per-project machine grants"]),
      `open chat changed: ${streaming.currents}`,
    );
    // The person clicks another chat while events keep arriving.
    await page.locator(".sws-chat-row button", { hasText: "0948 Link projects" }).click();
    const clicked = await watch();
    check(
      JSON.stringify(clicked.currents) === JSON.stringify(["0948 Link projects across machines"]),
      `clicked chat not held: ${clicked.currents}`,
    );
    check(clicked.reorders === 0, `rows reordered ${clicked.reorders} times after a click`);
    // Keyboard: next chat is the next row on screen.
    await page.keyboard.press("Control+]");
    const nav = await page.evaluate(() => window.fixture.navigations().at(-1));
    const expectedNext = initial[initial.indexOf("0948 Link projects across machines") + 1];
    const nextTitle = await page.evaluate(() => window.fixture.current());
    check(nextTitle === expectedNext, `Ctrl+] opened ${nextTitle}, expected ${expectedNext}`);
    // Explicit work still moves rows: a sent message and a new chat go to the top.
    await page.evaluate(() => window.fixture.sendMessage("count"));
    const afterMessage = await page.evaluate(() => window.fixture.order());
    check(
      afterMessage[0] === "Count Projects on This Machine",
      `message did not move: ${afterMessage}`,
    );
    await page.evaluate(() => window.fixture.newChat());
    const afterNew = await page.evaluate(() => window.fixture.order());
    check(afterNew[0] === "New chat from the person", `new chat not on top: ${afterNew}`);
    await page.screenshot({ path: join(output, `${width}-${theme}-explicit-moves.png`) });
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth + 1,
    );
    check(!overflow, "horizontal overflow");
    check(errors.length === 0, `page errors: ${errors}`);
    check(streaming.worstFrameMs < 250, `a frame took ${streaming.worstFrameMs} ms`);
    receipt.cases.push({
      width,
      height,
      theme,
      liveEvents: events,
      framesWatched: streaming.frames,
      worstFrameMs: Math.round(streaming.worstFrameMs),
      reordersWhileStreaming: streaming.reorders,
      reordersAfterClick: clicked.reorders,
      openChatWhileStreaming: streaming.currents,
      keyboardNext: { navigatedTo: nav, title: nextTitle, expected: expectedNext },
      topAfterMessage: afterMessage[0],
      topAfterNewChat: afterNew[0],
      initialOrder: initial,
      orderAfterStreaming: streaming.order,
      overflow,
      errors,
    });
    await page.close();
  }
  await writeFile(join(output, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n");
  console.log(
    JSON.stringify(receipt.cases.map(({ initialOrder: _i, orderAfterStreaming: _o, ...c }) => c)),
  );
} finally {
  await browser.close();
  await new Promise((done) => server.close(done));
}
