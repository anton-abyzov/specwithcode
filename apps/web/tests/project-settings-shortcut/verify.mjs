#!/usr/bin/env node
// Project settings opened with mod+shift+, (and from the command palette) must open
// over the thread in view and leave it there: the same URL, the same thread, the same
// scroll once the dialog closes. A real server on a seeded throwaway state directory
// (the load benchmark's seeder, providers disabled), driven by headless Chromium.
//
//   node apps/web/tests/project-settings-shortcut/verify.mjs /absolute/owned/report-dir
//
// Build the web app first. MEASURE_ONLY=1 records failures instead of stopping, for a
// before capture. STUDIO_PLAYWRIGHT_MODULE and STUDIO_TEST_CHROMIUM pick Playwright and
// the browser. The browser is always headless.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

process.env.PWDEBUG = "0";
process.env.PLAYWRIGHT_HTML_OPEN = "never";
const root = NodePath.resolve(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "../../../..",
);
const reportDir = process.argv[2];
if (!reportDir || !NodePath.isAbsolute(reportDir)) {
  console.error("Usage: verify.mjs /absolute/owned/report-dir");
  process.exit(2);
}
NodeFS.mkdirSync(reportDir, { recursive: true });
const measureOnly = process.env.MEASURE_ONLY === "1";
const log = (...parts) => console.error("[project-settings-shortcut]", ...parts);
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

function loadPlaywright() {
  const require = NodeModule.createRequire(import.meta.url);
  for (const candidate of [
    process.env.STUDIO_PLAYWRIGHT_MODULE,
    NodePath.join(NodePath.dirname(process.execPath), "../lib/node_modules/playwright"),
    "playwright",
    NodePath.join(root, "apps/server/node_modules/playwright-core"),
  ].filter(Boolean)) {
    try {
      return require(candidate);
    } catch {}
  }
  throw new Error("Playwright not found; set STUDIO_PLAYWRIGHT_MODULE");
}

const freePort = () =>
  new Promise((done, reject) => {
    const server = NodeNet.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => done(port));
    });
  });

// The load benchmark's seeder, then one agent-started worker the project page opens
// in its right panel. Loading the auth module first settles an import cycle the
// seeders alone trip on.
function seed(baseDir) {
  const auth = NodeURL.pathToFileURL(
    NodePath.join(root, "apps/server/src/auth/EnvironmentAuth.ts"),
  );
  const run = (script, ...args) => {
    const seeder = NodePath.join(root, "apps/server/integration", script);
    const output = NodeChildProcess.execFileSync(
      process.execPath,
      ["--import", auth.href, seeder, baseDir, ...args],
      {
        cwd: NodePath.dirname(seeder),
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        maxBuffer: 64 << 20,
      },
    );
    return JSON.parse(output.trim().split("\n").at(-1));
  };
  return { ...run("loadBenchSeed.ts", "small"), worker: run("projectSettingsShortcutSeed.ts") };
}

async function startServer(baseDir, port) {
  const home = NodePath.join(baseDir, "home");
  NodeFS.mkdirSync(home, { recursive: true });
  const child = NodeChildProcess.spawn(
    process.execPath,
    [
      NodePath.join(root, "apps/server/src/bin.ts"),
      "serve",
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--base-dir",
      baseDir,
      "--no-browser",
    ],
    {
      cwd: baseDir,
      env: {
        PATH: `${NodePath.dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`,
        HOME: home,
        LANG: "en_US.UTF-8",
        STUDIO_AUTO_BOOTSTRAP_PROJECT_FROM_CWD: "false",
        STUDIO_DISABLE_AUTO_UPDATE: "true",
        PWDEBUG: "0",
        PLAYWRIGHT_HTML_OPEN: "never",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const logFile = NodeFS.createWriteStream(NodePath.join(reportDir, "server.log"));
  let buffer = "";
  const credential = await new Promise((done, reject) => {
    const timer = setTimeout(() => reject(new Error("server printed no token in 180 s")), 180_000);
    const observe = (chunk) => {
      logFile.write(chunk);
      buffer = (buffer + chunk).slice(-65536);
      const match = buffer.match(/(?:^|\n)Token: ([^\s]+)/);
      if (match) {
        clearTimeout(timer);
        done(match[1]);
      }
    };
    child.stdout.on("data", observe);
    child.stderr.on("data", observe);
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`server exited ${code}: ${buffer.slice(-2000)}`));
    });
  });
  return { child, credential };
}

// The seeded worker in project load-bench-2.
const THREAD_ID = "settings-shortcut-worker";
const MARKER = "Finished load bench turn 2.";

const failures = [];
function check(condition, message) {
  if (condition) return;
  if (!measureOnly) throw new Error(message);
  failures.push(message);
  log("FAIL", message);
}

/** The nearest scrollable ancestor of the thread's last rendered answer. */
async function threadScroller(page, marker) {
  return page.evaluate((text) => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node && !node.textContent.includes(text)) node = walker.nextNode();
    let element = node?.parentElement ?? null;
    while (
      element &&
      !(
        element.scrollHeight > element.clientHeight + 20 &&
        /(auto|scroll)/.test(getComputedStyle(element).overflowY)
      )
    )
      element = element.parentElement;
    if (!element) return null;
    element.setAttribute("data-psk-scroller", "");
    return { scrollTop: element.scrollTop, scrollHeight: element.scrollHeight };
  }, marker);
}

const readScroll = (page) =>
  page.evaluate(() => document.querySelector("[data-psk-scroller]")?.scrollTop ?? null);

async function scenario(page, name, url, marker, open) {
  log(`${name}: ${url}`);
  await page.goto(url);
  await page
    .getByText(marker)
    .first()
    .waitFor({ timeout: 60_000 })
    .catch(async (error) => {
      await page.screenshot({ path: NodePath.join(reportDir, `${name}-load-failed.png`) });
      throw error;
    });
  await sleep(1500);
  const scroller = await threadScroller(page, marker);
  check(scroller !== null, `${name}: the thread has no scroller`);
  // Scroll up to the middle, away from the end the thread follows.
  await page.evaluate(() => {
    const element = document.querySelector("[data-psk-scroller]");
    element.dispatchEvent(new WheelEvent("wheel", { deltaY: -400, bubbles: true }));
    element.scrollTop = Math.round((element.scrollHeight - element.clientHeight) / 2);
  });
  await sleep(800);
  const before = { url: page.url(), scrollTop: await readScroll(page) };
  await page.screenshot({ path: NodePath.join(reportDir, `${name}-1-thread.png`) });
  await open();
  const dialog = page.getByRole("dialog").filter({ hasText: "General" });
  const opened = await dialog
    .first()
    .waitFor({ timeout: 10_000 })
    .then(() => true)
    .catch(() => false);
  await sleep(500);
  const during = { url: page.url(), dialog: opened };
  await page.screenshot({ path: NodePath.join(reportDir, `${name}-2-settings.png`) });
  check(opened, `${name}: Project settings did not open`);
  check(during.url === before.url, `${name}: the URL changed to ${during.url} (was ${before.url})`);
  if (opened) {
    await page.keyboard.press("Escape");
    await dialog
      .first()
      .waitFor({ state: "detached", timeout: 10_000 })
      .catch(() => {});
  }
  await sleep(800);
  const after = {
    url: page.url(),
    threadShown: await page
      .getByText(marker)
      .first()
      .isVisible()
      .catch(() => false),
    scrollTop: await readScroll(page),
  };
  await page.screenshot({ path: NodePath.join(reportDir, `${name}-3-closed.png`) });
  check(
    after.url === before.url,
    `${name}: after closing, the URL is ${after.url} (was ${before.url})`,
  );
  check(after.threadShown, `${name}: after closing, the thread is no longer shown`);
  check(
    after.scrollTop !== null && Math.abs(after.scrollTop - before.scrollTop) <= 2,
    `${name}: scrollTop moved from ${before.scrollTop} to ${after.scrollTop}`,
  );
  return { name, before, during, after };
}

async function main() {
  const scratch = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "psk-"));
  const baseDir = NodePath.join(scratch, "state");
  const fixture = seed(baseDir);
  log(`seeded ${fixture.threads} threads into ${baseDir}`);
  const port = await freePort();
  const { child, credential } = await startServer(baseDir, port);
  const origin = `http://127.0.0.1:${port}`;
  const playwright = loadPlaywright();
  const browser = await playwright.chromium.launch({
    headless: true,
    ...(process.env.STUDIO_TEST_CHROMIUM
      ? { executablePath: process.env.STUDIO_TEST_CHROMIUM }
      : {}),
  });
  const results = [];
  try {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 560 },
      reducedMotion: "reduce",
      serviceWorkers: "block",
    });
    await context.addInitScript(() => {
      try {
        if (!localStorage.getItem("studio:client-settings:v1"))
          localStorage.setItem(
            "studio:client-settings:v1",
            JSON.stringify({ onboardingCompletedAt: "2026-10-09T00:00:00.000Z" }),
          );
      } catch {}
    });
    const auth = await context.request.post(origin + "/api/auth/browser-session", {
      data: { credential },
      headers: { Origin: origin },
    });
    if (auth.status() !== 200) throw new Error(`browser session failed: ${await auth.text()}`);
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));

    // Full chat route: find the big thread's own URL from the sidebar.
    await page.goto(origin + "/");
    await page
      .getByText("Bench thread", { exact: false })
      .first()
      .waitFor({ timeout: 90_000 })
      .catch(async (error) => {
        await page.screenshot({ path: NodePath.join(reportDir, "start-failed.png") });
        throw error;
      });
    // Seeded projects sit in the sidebar's collapsed Automated group.
    await page
      .getByText(/^Automated \(\d+\)$/)
      .first()
      .click()
      .catch(() => {});
    await sleep(500);
    const links = await page.evaluate(() =>
      [...document.querySelectorAll("a[href]")].map((a) => ({
        href: a.getAttribute("href"),
        text: a.textContent.trim().slice(0, 60),
      })),
    );
    NodeFS.writeFileSync(NodePath.join(reportDir, "links.json"), JSON.stringify(links, null, 2));
    const projectLink = links.find(
      (link) => link.href.startsWith("/projects/") && link.text.endsWith("load-bench-2"),
    );
    if (!projectLink)
      throw new Error(`no project link; see ${NodePath.join(reportDir, "links.json")}`);
    // A sidebar chat opens on the full chat route, which names the environment.
    await page.getByText("Bench thread 2.40", { exact: true }).first().click();
    await page.waitForURL(/\/load-bench-thread-1-39/, { timeout: 30_000 });
    const environmentId = new URL(page.url()).pathname.split("/")[1];
    const threadUrl = `/${environmentId}/${THREAD_ID}`;
    const panelUrl = `${projectLink.href}&thread=${THREAD_ID}`;
    log("chat", threadUrl, "panel", panelUrl);
    const shortcut = () => page.keyboard.press("Meta+Shift+Comma");
    const palette = async () => {
      await page.keyboard.press("Meta+k");
      await page.keyboard.type("Project settings");
      await page
        .getByRole("option", { name: /^Project settings/ })
        .first()
        .waitFor({ timeout: 10_000 });
      await sleep(300);
      await page
        .getByRole("option", { name: /^Project settings/ })
        .first()
        .click();
    };
    results.push(await scenario(page, "panel-shortcut", origin + panelUrl, MARKER, shortcut));
    results.push(await scenario(page, "chat-shortcut", origin + threadUrl, MARKER, shortcut));
    results.push(await scenario(page, "chat-palette", origin + threadUrl, MARKER, palette));
    results.push({ pageErrors: errors });
  } finally {
    NodeFS.writeFileSync(
      NodePath.join(reportDir, "results.json"),
      JSON.stringify({ measureOnly, failures, results }, null, 2),
    );
    await browser.close();
    child.kill("SIGTERM");
    await sleep(1000);
    if (child.exitCode === null) child.kill("SIGKILL");
    NodeFS.rmSync(scratch, { recursive: true, force: true });
  }
  if (failures.length > 0) {
    log(`${failures.length} failure(s); see ${NodePath.join(reportDir, "results.json")}`);
    process.exit(1);
  }
  log(`passed; evidence in ${reportDir}`);
}

main().catch((error) => {
  log(error.stack ?? String(error));
  process.exit(1);
});
