#!/usr/bin/env node
// A chat started without a project has no project settings: the Project settings
// shortcut, the header's right-click menu and the command palette open Chat settings
// (machine, the chat's own folder, model) instead. A real server on a fresh throwaway
// state directory, driven by headless Chromium.
//
//   node apps/web/tests/chat-settings/verify.mjs /absolute/owned/report-dir
//
// Build the web app first (apps/web: vp build). MEASURE_ONLY=1 records failures
// instead of stopping, for a before capture. STUDIO_PLAYWRIGHT_MODULE and
// STUDIO_TEST_CHROMIUM pick Playwright and the browser. The browser is always headless.
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
const log = (...parts) => console.error("[chat-settings]", ...parts);
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

function loadPlaywright() {
  const require = NodeModule.createRequire(import.meta.url);
  for (const candidate of [
    process.env.STUDIO_PLAYWRIGHT_MODULE,
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

const failures = [];
function check(condition, message) {
  if (condition) return;
  if (!measureOnly) throw new Error(message);
  failures.push(message);
  log("FAIL", message);
}

/** Waits until nothing animates, so a screenshot shows the settled frame. */
const settle = (page) =>
  page
    .waitForFunction(() => document.getAnimations({ subtree: true }).length === 0, null, {
      timeout: 5000,
    })
    .catch(() => {});

async function main() {
  const scratch = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "chat-settings-"));
  const baseDir = NodePath.join(scratch, "state");
  NodeFS.mkdirSync(baseDir, { recursive: true });
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
  const results = {};
  const shot = async (page, name) => {
    await settle(page);
    await page.addStyleTag({ content: "[data-position]{display:none!important}" }).catch(() => {});
    await page.screenshot({ path: NodePath.join(reportDir, `${name}.png`) });
  };
  try {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 760 },
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

    await page.goto(origin + "/");
    await page.locator(".sws-sidebar").waitFor({ timeout: 90_000 });
    const plus = page.locator(
      '[aria-labelledby="sws-side-chats"] .sws-side-heading button[aria-label="New chat"]',
    );
    await plus.first().waitFor({ timeout: 60_000 });
    await sleep(1500);
    await plus.first().click();
    await page.waitForURL(/\/draft\//, { timeout: 20_000 });
    await page.locator('[data-testid="composer-editor"]').first().waitFor({ timeout: 20_000 });
    await sleep(1000);
    await shot(page, "1-chat");

    // The Project settings shortcut, used in a chat.
    await page.locator('[data-testid="composer-editor"]').first().click();
    await page.keyboard.press("ControlOrMeta+Shift+Comma");
    await sleep(1200);
    const dialog = page.getByRole("dialog");
    const dialogText =
      (await dialog
        .first()
        .textContent({ timeout: 3000 })
        .catch(() => "")) ?? "";
    results.shortcut = { dialogText: dialogText.slice(0, 600) };
    await shot(page, "2-shortcut");
    check(
      !/Project folder|Use worktrees|Coordinator model/.test(dialogText),
      "the shortcut opened project settings for a chat",
    );
    check(/Chat settings/.test(dialogText), "the shortcut did not open Chat settings");
    check(/Folder/.test(dialogText) && /Machine/.test(dialogText), "Chat settings lacks rows");
    await page.keyboard.press("Escape");
    await sleep(800);

    // The command palette, searched for settings.
    await page.keyboard.press("ControlOrMeta+k");
    await sleep(600);
    await page.keyboard.type("settings");
    await sleep(1200);
    const options = await page
      .getByRole("option")
      .allTextContents()
      .catch(() => []);
    results.palette = { options: options.slice(0, 20) };
    await shot(page, "3-palette");
    check(
      !options.some((text) => /^Project settings/.test(text.trim())),
      "the palette offers Project settings in a chat",
    );
    check(
      options.some((text) => /^Chat settings/.test(text.trim())),
      "the palette offers no Chat settings in a chat",
    );
    await page.keyboard.press("Escape");
    await sleep(600);
    // A sent chat: a real thread with a folder of its own. A fresh state may have no
    // provider that can take the message, so this part records what it saw and only
    // checks the dialog when the thread exists.
    await page.locator('[data-testid="composer-editor"]').first().click();
    await page.keyboard.type("Plan a weekend trip");
    await page.keyboard.press("Enter");
    const sent = await page
      .waitForURL((url) => !url.pathname.includes("/draft/"), { timeout: 20_000 })
      .then(() => true)
      .catch(() => false);
    results.sent = { sent, url: page.url() };
    if (sent) {
      await sleep(2500);
      await page.keyboard.press("Escape");
      await page
        .locator("body")
        .click({ position: { x: 640, y: 120 } })
        .catch(() => {});
      await page.keyboard.press("ControlOrMeta+Shift+Comma");
      await sleep(1200);
      const text =
        (await dialog
          .first()
          .textContent({ timeout: 3000 })
          .catch(() => "")) ?? "";
      results.sent.dialogText = text.slice(0, 600);
      await shot(page, "4-sent-chat");
      check(/Chat settings/.test(text), "a sent chat's shortcut did not open Chat settings");
      check(/scratch/.test(text), "a sent chat's settings do not show its own folder");
      await page.keyboard.press("Escape");
    }
    results.pageErrors = errors;
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
