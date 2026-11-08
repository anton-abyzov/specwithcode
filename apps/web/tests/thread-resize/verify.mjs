// Build first: vp build --config apps/web/tests/thread-resize/vite.config.ts
// Supply the installed Playwright entry via STUDIO_PLAYWRIGHT_MODULE. Always headless.
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
process.env.PWDEBUG = "0";
process.env.PLAYWRIGHT_HTML_OPEN = "never";
const { chromium } = await import(NodeURL.pathToFileURL(process.env.STUDIO_PLAYWRIGHT_MODULE).href);
const root = NodePath.resolve(".artifacts/thread-resize/site");
const output = NodePath.resolve(
  process.env.THREAD_RESIZE_OUTPUT ?? ".artifacts/thread-resize/evidence",
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

const errors = [];
const receipt = [];

/** The first message row whose top edge is at or below the viewport's top, and the list's distance from its end. */
function readPlace(page) {
  return page.evaluate(() => {
    const scroller = document.querySelector(".messages-timeline-scroll");
    const top = scroller.getBoundingClientRect().top;
    const rows = [...scroller.querySelectorAll("[data-message-id]")]
      .map((row) => ({
        id: row.getAttribute("data-message-id"),
        top: row.getBoundingClientRect().top - top,
      }))
      .filter((row) => row.top >= -1)
      .sort((a, b) => a.top - b.top);
    return {
      anchor: rows[0] ?? null,
      fromEnd: Math.round(scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight),
      follow: window.__follow?.liveFollowEnabled ?? null,
    };
  });
}

async function settle(page) {
  await page.waitForTimeout(500);
}

async function check(label, condition, detail) {
  receipt.push({ label, ok: condition, detail });
  if (!condition) errors.push(`${label}: ${JSON.stringify(detail)}`);
}

async function run(name, sizes) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on("pageerror", (error) => errors.push(`${name}: page error ${error.message}`));
  await page.route("**/*", (route) =>
    route.request().url().startsWith(origin) ? route.continue() : route.abort(),
  );
  await page.goto(origin);
  await page.waitForSelector("[data-message-id]");
  await settle(page);
  const scroller = page.locator(".messages-timeline-scroll");
  const box = await scroller.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);

  // Reading: wheel up into the middle of the thread.
  for (let step = 0; step < 6; step += 1) {
    await page.mouse.wheel(0, -900);
    await page.waitForTimeout(40);
  }
  await settle(page);
  const before = await readPlace(page);
  await check(
    `${name}: reader is up the thread`,
    before.fromEnd > 1000 && before.follow === false,
    before,
  );
  for (const [width, height] of sizes) {
    // A window drag resizes in many small steps.
    const current = page.viewportSize();
    const steps = 8;
    for (let step = 1; step <= steps; step += 1) {
      await page.setViewportSize({
        width: Math.round(current.width + ((width - current.width) * step) / steps),
        height: Math.round(current.height + ((height - current.height) * step) / steps),
      });
      await page.waitForTimeout(30);
    }
    await settle(page);
    const after = await readPlace(page);
    await page.screenshot({ path: NodePath.join(output, `${name}-${width}x${height}.png`) });
    await check(
      `${name}: ${width}x${height} keeps the reader up the thread`,
      after.fromEnd > 200 && after.follow === false,
      { before, after },
    );
    await check(
      `${name}: ${width}x${height} keeps the top message`,
      after.anchor?.id === before.anchor?.id && Math.abs(after.anchor.top - before.anchor.top) <= 4,
      { before: before.anchor, after: after.anchor },
    );
  }
  await page.close();

  // At the end: a reader at the latest message stays there through the same resizes.
  const end = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await end.goto(origin);
  await end.waitForSelector("[data-message-id]");
  await settle(end);
  for (const [width, height] of sizes) {
    await end.setViewportSize({ width, height });
    await settle(end);
    const place = await readPlace(end);
    await check(
      `${name}: at end ${width}x${height} stays at the end`,
      place.fromEnd <= 2 && place.follow === true,
      place,
    );
  }
  await end.close();
}

// Near the end: a taller window clamps the reader to the end; shrinking it back
// must return them to the same message, not pin them to the latest.
async function clamp(query) {
  const name = `clamp${query}`;
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on("pageerror", (error) => errors.push(`${name}: page error ${error.message}`));
  await page.goto(`${origin}/${query}`);
  await page.waitForSelector("[data-message-id]");
  await settle(page);
  const box = await page.locator(".messages-timeline-scroll").boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, -250);
  await settle(page);
  const before = await readPlace(page);
  await check(
    `${name}: reader paused near the end`,
    before.fromEnd > 150 && before.follow === false,
    before,
  );
  for (const height of [900, 1000, 1100]) {
    await page.setViewportSize({ width: 1280, height });
    await page.waitForTimeout(30);
  }
  await settle(page);
  const tall = await readPlace(page);
  await page.screenshot({ path: NodePath.join(output, `${name}-tall.png`) });
  await check(`${name}: the clamp to the end keeps the reader paused`, tall.follow === false, tall);
  for (const height of [1000, 900, 800]) {
    await page.setViewportSize({ width: 1280, height });
    await page.waitForTimeout(30);
  }
  await settle(page);
  const back = await readPlace(page);
  await page.screenshot({ path: NodePath.join(output, `${name}-back.png`) });
  await check(
    `${name}: shrinking back keeps the reader off the end`,
    back.fromEnd > 150 && back.follow === false,
    { before, back },
  );
  // Clamped at the end again, one wheel notch down resumes following there.
  for (const height of [900, 1000, 1100]) {
    await page.setViewportSize({ width: 1280, height });
    await page.waitForTimeout(30);
  }
  await settle(page);
  await page.mouse.wheel(0, 100);
  await settle(page);
  const clamped = await readPlace(page);
  await check(
    `${name}: a wheel down while clamped at the end follows again`,
    clamped.fromEnd <= 2 && clamped.follow === true,
    clamped,
  );
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.mouse.wheel(0, -600);
  await settle(page);
  // Moving on toward the end resumes following.
  await page.mouse.wheel(0, 2000);
  await settle(page);
  const resumed = await readPlace(page);
  await check(
    `${name}: scrolling down to the end follows again`,
    resumed.fromEnd <= 2 && resumed.follow === true,
    resumed,
  );
  await page.close();
}

try {
  await clamp(process.env.THREAD_RESIZE_QUERY ?? "");
  await run("narrow-then-wide", [
    [900, 800],
    [1500, 900],
    [1280, 640],
  ]);
  await run("wide-first", [
    [1600, 800],
    [700, 800],
  ]);
  await run("narrow-pane", [
    [520, 800],
    [760, 800],
    [600, 700],
  ]);
} finally {
  await browser.close();
  server.close();
  await NodeFSP.writeFile(
    NodePath.join(output, "receipt.json"),
    JSON.stringify({ errors, receipt }, null, 2),
  );
}
for (const entry of receipt) console.log(`${entry.ok ? "ok  " : "FAIL"} ${entry.label}`);
if (errors.length > 0) {
  console.error(errors.join("\n"));
  process.exit(1);
}
