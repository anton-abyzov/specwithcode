// Records a headless walk through the header's Replies and Show menu, one video per width.
// Build first: vp build --config apps/web/tests/timeline-detail/vite.config.ts
// Supply the installed Playwright entry via STUDIO_PLAYWRIGHT_MODULE. Always headless.
// The walk uses only roles and the trigger's data attribute, so it runs against an
// older build too, for before and after captures.
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
process.env.PWDEBUG = "0";
process.env.PLAYWRIGHT_HTML_OPEN = "never";
const { chromium } = await import(NodeURL.pathToFileURL(process.env.STUDIO_PLAYWRIGHT_MODULE).href);
const root = NodePath.resolve(".artifacts/timeline-detail/site");
const output = NodePath.resolve(
  process.env.TIMELINE_DETAIL_VIDEO_OUTPUT ?? ".artifacts/timeline-detail/videos",
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

const PAUSE = 1400;
const steps = [];

async function walk(page, width) {
  const trigger = page.locator("[data-timeline-detail]");
  const note = async (step) => {
    steps.push({
      width,
      step,
      trigger: (await trigger.innerText()).trim(),
      name: await trigger.getAttribute("aria-label"),
      detail: await page.locator("main").getAttribute("data-detail"),
    });
    await page.waitForTimeout(PAUSE);
  };
  const openMenu = async () => {
    await trigger.click();
    await page.getByRole("menu").first().waitFor();
    await page.waitForTimeout(PAUSE);
  };
  // The first radio of that name is the thread's own choice where the menu has one.
  const pick = async (name, which = "first") => {
    const radios = page.getByRole("menuitemradio", { name: new RegExp(`^${name}`) });
    if ((await radios.count()) === 0) return false;
    await radios[which]().click();
    return true;
  };
  await note("start");
  await openMenu();
  await pick("Everything", "last");
  await note("Everything for every thread");
  await openMenu();
  await pick("Results only");
  await note("Results only chosen first in the menu");
  await page.keyboard.press("Meta+Alt+KeyO");
  await note("shortcut once");
  await page.keyboard.press("Meta+Alt+KeyO");
  await note("shortcut twice");
  await openMenu();
  if ((await pick("Use default")) || (await pick("Every thread"))) await note("back to the default");
  else await page.keyboard.press("Escape");
  await openMenu();
  await page.keyboard.press("Escape");
  await note("end");
}

try {
  for (const [width, height] of [
    [1280, 800],
    [390, 844],
  ]) {
    const context = await browser.newContext({
      viewport: { width, height },
      recordVideo: { dir: output, size: { width, height } },
    });
    const page = await context.newPage();
    await page.route("**/*", (route) =>
      route.request().url().startsWith(origin) ? route.continue() : route.abort(),
    );
    await page.goto(`${origin}/?theme=dark${process.env.TIMELINE_DETAIL_QUERY ?? ""}`);
    await page.locator("main").waitFor();
    await walk(page, width);
    const video = page.video();
    await context.close();
    await NodeFSP.rename(await video.path(), NodePath.join(output, `web-${width}.webm`));
  }
  await NodeFSP.writeFile(NodePath.join(output, "steps.json"), JSON.stringify(steps, null, 2));
  console.log(`Recorded ${output}`);
} finally {
  await browser.close();
  server.close();
}
