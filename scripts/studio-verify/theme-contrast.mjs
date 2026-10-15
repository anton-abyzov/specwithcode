#!/usr/bin/env node
// Headless WCAG AA text-contrast audit of the built app in light and dark.
// Isolated private server, disabled providers, synthetic project, no provider turns.
// Usage: node scripts/studio-verify/theme-contrast.mjs /absolute/owned/report-dir [--baseline]
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

assert.equal(Number(process.versions.node.split(".")[0]), 22, "Use the project's Node 22 runtime");
process.env.PWDEBUG = "0";
process.env.PLAYWRIGHT_HTML_OPEN = "never";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const output = resolve(process.argv[2] ?? join(tmpdir(), `theme-contrast-${randomUUID()}`));
const reportOnly = process.argv.includes("--baseline");
mkdirSync(output, { recursive: true, mode: 0o700 });
const scan = readFileSync(join(root, "scripts/studio-verify/theme-contrast-scan.js"), "utf8");
const scratch = mkdtempSync(join(tmpdir(), "theme-contrast-"));
const data = join(scratch, "data");
const workspace = join(scratch, "workspace");
mkdirSync(join(data, "userdata"), { recursive: true });
mkdirSync(workspace);
writeFileSync(join(workspace, "README.md"), "Synthetic contrast fixture.\n");
const drivers = ["codex", "claudeAgent", "cursor", "grok", "pi", "opencode", "antigravity"];
writeFileSync(
  join(data, "userdata/settings.json"),
  JSON.stringify({
    providers: Object.fromEntries(drivers.map((driver) => [driver, { enabled: false }])),
    providerInstances: Object.fromEntries(
      drivers.map((driver) => [driver, { driver, enabled: false, config: {} }]),
    ),
  }),
);

const port = await new Promise((done, reject) => {
  const server = createServer();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const value = server.address().port;
    server.close(() => done(value));
  });
});
const origin = `http://127.0.0.1:${port}`;
const child = spawn(
  process.execPath,
  [
    join(root, "apps/server/dist/bin.mjs"),
    "serve",
    "--host",
    "127.0.0.1",
    "--port",
    String(port),
    "--base-dir",
    data,
    "--no-browser",
  ],
  {
    cwd: scratch,
    env: {
      PATH: `${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`,
      HOME: scratch,
      LANG: "en_US.UTF-8",
      STUDIO_AUTO_BOOTSTRAP_PROJECT_FROM_CWD: "false",
      STUDIO_DISABLE_AUTO_UPDATE: "true",
      PWDEBUG: "0",
      PLAYWRIGHT_HTML_OPEN: "never",
    },
    stdio: ["ignore", "pipe", "pipe"],
  },
);

const ONLY = process.env.THEME_CONTRAST_PAGES?.split(",");
const ALL_PAGES = [
  "/",
  "/settings/general",
  "/settings/appearance",
  "/settings/agents",
  "/settings/providers",
  "/settings/connections",
  "/settings/projects",
  "/settings/archived",
  "/settings/source-control",
  "/settings/keybindings",
  "/settings/privacy",
  "/settings/storage",
  "/settings/diagnostics",
  "/settings/scheduled-tasks",
  "/settings/skills",
  "/settings/messaging",
  "/settings/integrations",
  "/usage",
];
const PAGES = ONLY ? ALL_PAGES.filter((path) => ONLY.includes(path)) : ALL_PAGES;

const receipt = { headless: true, providerTurns: 0, pages: [], failures: 0, screenshots: [] };
let browser;
try {
  const credential = await new Promise((done, reject) => {
    let buffer = "";
    const timer = setTimeout(() => reject(new Error("Private server did not become ready")), 45000);
    const observe = (chunk) => {
      buffer = (buffer + chunk).slice(-65536);
      const match = buffer.match(/(?:^|\n)Token: ([^\s]+)/);
      if (match) {
        clearTimeout(timer);
        done(match[1]);
      }
    };
    child.stdout.on("data", observe);
    child.stderr.on("data", observe);
    child.once("exit", (code) => reject(new Error(`Private server exited: ${code}`)));
  });
  const playwrightPath =
    process.env.PLAYWRIGHT_MODULE ??
    join(
      homedir(),
      ".cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright",
    );
  const { chromium } = createRequire(import.meta.url)(playwrightPath);
  browser = await chromium.launch({
    headless: true,
    ...(process.env.STUDIO_TEST_CHROMIUM
      ? { executablePath: process.env.STUDIO_TEST_CHROMIUM }
      : {}),
  });

  let projectId = null;
  let storageState;
  for (const theme of ["light", "dark"]) {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
      colorScheme: theme,
      reducedMotion: "reduce",
      storageState,
    });
    await context.addInitScript(() => {
      if (!localStorage.getItem("studio:client-settings:v1"))
        localStorage.setItem(
          "studio:client-settings:v1",
          JSON.stringify({ onboardingCompletedAt: "2026-10-09T00:00:00.000Z" }),
        );
    });
    if (!storageState) {
      const auth = await context.request.post(origin + "/api/auth/browser-session", {
        data: { credential },
        headers: { Origin: origin },
      });
      assert.equal(auth.status(), 200);
      storageState = await context.storageState();
    }
    if (!projectId) {
      projectId = randomUUID();
      const created = await context.request.post(origin + "/api/projects/mutate", {
        data: {
          type: "project.create",
          commandId: randomUUID(),
          projectId,
          title: "contrast-fixture",
          workspaceRoot: workspace,
        },
        headers: { Origin: origin },
      });
      assert.equal(created.status(), 200, `project.create failed: ${await created.text()}`);
    }
    const page = await context.newPage();
    const record = async (name, { screenshot = true } = {}) => {
      await page.waitForTimeout(1200);
      const { checked, skips, failures } = await page.evaluate(scan);
      receipt.pages.push({ theme, name, checked, skips, failures });
      receipt.failures += failures.length;
      if (screenshot) {
        const file = join(output, `${name.replaceAll("/", "_") || "root"}-${theme}.png`);
        await page.screenshot({ path: file, animations: "disabled" });
        receipt.screenshots.push(file);
      }
    };
    for (const path of PAGES) {
      await page.goto(origin + path, { waitUntil: "load" }).catch(() => {});
      await page.waitForSelector("main, [role=main], h1, h2", { timeout: 15000 }).catch(() => {});
      await record(path);
    }
    // Project page and its settings dialog, including the danger zone.
    await page.goto(origin + "/", { waitUntil: "load" });
    await page.getByText("contrast-fixture").first().click({ timeout: 20000 });
    await page.getByRole("button", { name: "Project settings" }).waitFor({ timeout: 20000 });
    await record("/projects/fixture");
    await page.getByRole("button", { name: "Project settings" }).click();
    await page.waitForTimeout(800);
    {
      for (const tab of ["Memory", "Environment", "Usage", "Routines"]) {
        const button = page.getByRole("button", { name: tab, exact: true }).first();
        if (!(await button.isVisible().catch(() => false))) continue;
        await button.click();
        await record(`/projects/fixture/settings-${tab.toLowerCase()}`);
      }
      await page
        .getByRole("button", { name: "General", exact: true })
        .first()
        .click()
        .catch(() => {});
      await record("/projects/fixture/settings-general");
      const danger = page.getByRole("button", { name: "Delete project and threads" });
      if (await danger.count()) {
        await danger.scrollIntoViewIfNeeded();
        await record(`/projects/fixture/danger-zone`, { screenshot: true });
        await page.getByLabel("Confirm project deletion").fill("contrast-fixture");
        await record(`/projects/fixture/danger-zone-armed`, { screenshot: true });
      }
    }
    await context.close();
  }
  receipt.success = receipt.failures === 0;
} finally {
  writeFileSync(join(output, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n");
  await browser?.close().catch(() => {});
  if (child.exitCode === null) {
    const exited = new Promise((done) => child.once("exit", done));
    child.kill("SIGTERM");
    await Promise.race([exited, new Promise((done) => setTimeout(done, 5000))]);
    if (child.exitCode === null) child.kill("SIGKILL");
  }
  rmSync(scratch, { recursive: true, force: true });
}
const summary = receipt.pages
  .filter((entry) => entry.failures.length || process.env.THEME_CONTRAST_PAGES)
  .map(
    (entry) =>
      `${entry.theme} ${entry.name}: ${entry.failures.length}/${entry.checked} ${JSON.stringify(entry.skips)}`,
  );
console.log(summary.join("\n") || "No AA contrast failures");
console.log(
  `Checked ${receipt.pages.reduce((n, entry) => n + entry.checked, 0)} text elements on ${receipt.pages.length} views`,
);
console.log(`Receipt: ${join(output, "receipt.json")}`);
if (!reportOnly && receipt.failures) process.exitCode = 1;
