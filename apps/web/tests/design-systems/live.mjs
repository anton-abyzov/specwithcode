// Live check of Settings > Design systems against a real local server.
// Build first, with Node 22:
//   apps/server: node ../../node_modules/vite-plus/bin/vp pack
//   apps/web:    node ../../node_modules/vite-plus/bin/vp build --config tests/design-systems/live.vite.config.ts
// The second build is the real web app, written to
// .artifacts/design-systems/live-web.
// Run from the repository root:
//   node apps/web/tests/design-systems/live.mjs [evidence-folder]
// The server runs from a copy of apps/server/dist that serves that build.
// Everything it creates (server copy, base dir, synthetic project) lives under
// one fresh mkdtemp folder. The browser is headless Chromium. The startup token
// stays in memory and is never written anywhere.
// The real Weave import is read in place from the public specweave checkout
// (DESIGN_SYSTEMS_WEAVE_ROOT); it is reviewed and discarded, never written.
// Acme stands in for ec-uikit, which is private and is not shown.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import net from "node:net";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

assert.ok(process.versions.node.startsWith("22."), "Run with Node 22");
process.env.PWDEBUG = "0";
process.env.PLAYWRIGHT_HTML_OPEN = "never";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const output = resolve(
  process.argv[2] ??
    join(
      homedir(),
      "Projects/github/studio-research-notes/design-workspace-2026-10-20/design-systems/live",
    ),
);
mkdirSync(output, { recursive: true });
rmSync(join(output, "failure.png"), { force: true });
rmSync(join(output, "gallery-refusal-light.png"), { force: true });
const weaveRoot = resolve(
  process.env.DESIGN_SYSTEMS_WEAVE_ROOT ??
    join(homedir(), "Projects/github/specweave-umb/repositories/anton-abyzov/specweave"),
);
assert.ok(
  existsSync(join(weaveRoot, "design/weave/tokens.json")),
  `Weave not found in ${weaveRoot}`,
);
const require = createRequire(join(root, "apps/server/package.json"));
const { chromium } = require("playwright-core");

const work = mkdtempSync(join(tmpdir(), "ds-live-"));
const baseDir = join(work, "base");
const checkout = join(work, "acme-checkout");
mkdirSync(baseDir, { recursive: true, mode: 0o700 });

const receipt = {
  observedAt: new Date().toISOString(),
  source: spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).stdout.trim(),
  node: process.version,
  browser: { engine: "chromium", headless: true, PWDEBUG: "0", PLAYWRIGHT_HTML_OPEN: "never" },
  paths: { work, baseDir, checkout, output, weaveRoot },
  server: null,
  steps: [],
  screenshots: [],
  passed: false,
};
const save = () =>
  writeFileSync(join(output, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n");
const step = (name, pass, detail = {}) => {
  receipt.steps.push({ name, pass, ...detail });
  save();
  console.log(JSON.stringify({ name, pass, ...detail }));
};

// --- Synthetic project ------------------------------------------------------
function writeProject() {
  const file = (path, text) => {
    mkdirSync(dirname(join(checkout, path)), { recursive: true });
    writeFileSync(join(checkout, path), text);
  };
  file(
    "package.json",
    JSON.stringify(
      { name: "acme-live", private: true, dependencies: { react: "^19.0.0" } },
      null,
      2,
    ),
  );
  file(
    "src/styles/theme.css",
    `:root {
  --background: #ffffff;
  --foreground: #101418;
  --primary: #2453d6;
  --primary-foreground: #ffffff;
  --secondary: #eef1f6;
  --secondary-foreground: #1b2330;
  --muted: #f3f4f6;
  --muted-foreground: #5b6472;
  --accent: #e8eefc;
  --border: #d9dee7;
  --ring: #2453d6;
  --danger: #c62828;
  --radius: 0.5rem;
  --spacing-gutter: 16px;
}

.dark {
  --background: #0d1014;
  --foreground: #eef1f6;
  --primary: #6d8ff5;
  --primary-foreground: #0d1014;
  --secondary: #1b2330;
  --secondary-foreground: #eef1f6;
  --muted: #1a1e24;
  --muted-foreground: #9aa3b2;
  --accent: #1f2a44;
  --border: #2a313c;
  --ring: #6d8ff5;
  --danger: #ef6b6b;
}
`,
  );
  file(
    "src/components/ui/AcmeButton.tsx",
    `export interface AcmeButtonProps {
  label: string;
  variant?: "solid" | "ghost";
  onPress?: () => void;
}

export function AcmeButton({ label, variant = "solid", onPress }: AcmeButtonProps) {
  return (
    <button data-variant={variant} onClick={onPress}>
      {label}
    </button>
  );
}
`,
  );
  file(
    "src/components/ui/AcmeCard.tsx",
    `import type { ReactNode } from "react";

export interface AcmeCardProps {
  title: string;
  children?: ReactNode;
}

export function AcmeCard({ title, children }: AcmeCardProps) {
  return (
    <section>
      <h3>{title}</h3>
      {children}
    </section>
  );
}
`,
  );
  file(
    "src/components/ui/index.ts",
    `export { AcmeButton } from "./AcmeButton";
export type { AcmeButtonProps } from "./AcmeButton";
export { AcmeCard } from "./AcmeCard";
export type { AcmeCardProps } from "./AcmeCard";
`,
  );
  for (const args of [
    ["init", "-q", "-b", "main"],
    ["add", "."],
    [
      "-c",
      "user.name=Live Check",
      "-c",
      "user.email=live@example.invalid",
      "commit",
      "-q",
      "-m",
      "Synthetic project",
    ],
  ])
    assert.equal(spawnSync("git", args, { cwd: checkout }).status, 0, `git ${args[0]}`);
}

const freePort = () =>
  new Promise((done, fail) => {
    const probe = net.createServer();
    probe.once("error", fail);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => done(port));
    });
  });

const systemFiles = () => {
  const dir = join(checkout, ".specweave/design/systems");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .map((id) => ({ id, path: join(dir, id, "system.json") }))
    .filter((entry) => existsSync(entry.path));
};

// --- Run --------------------------------------------------------------------
writeProject();
step("synthetic-project", true, {
  checkout,
  hasSpecweave: existsSync(join(checkout, ".specweave")),
});

// A copy of the server bundle whose bundled client is the flag-on web build.
// Dependencies resolve through links to the worktree's node_modules.
const liveWeb = join(root, ".artifacts/design-systems/live-web");
assert.ok(existsSync(join(root, "apps/server/dist/bin.mjs")), "Build apps/server first");
assert.ok(existsSync(join(liveWeb, "index.html")), "Build live.vite.config.ts first");
const serverCopy = join(work, "app/apps/server");
cpSync(join(root, "apps/server/dist"), join(serverCopy, "dist"), {
  recursive: true,
  filter: (path) => !path.endsWith(".map") && !path.includes("/dist/client"),
});
cpSync(liveWeb, join(serverCopy, "dist/client"), { recursive: true });
cpSync(join(root, "apps/server/package.json"), join(serverCopy, "package.json"));
symlinkSync(join(root, "apps/server/node_modules"), join(serverCopy, "node_modules"));
symlinkSync(join(root, "node_modules"), join(work, "app/node_modules"));
const entrypoint = join(serverCopy, "dist/bin.mjs");
receipt.paths.serverCopy = serverCopy;
receipt.paths.webBuild = liveWeb;

const port = await freePort();
const origin = `http://127.0.0.1:${port}`;
const child = spawn(
  process.execPath,
  [
    entrypoint,
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
    env: { ...process.env, PWDEBUG: "0", PLAYWRIGHT_HTML_OPEN: "never" },
    stdio: ["ignore", "pipe", "pipe"],
  },
);
receipt.server = { pid: child.pid, port, startedAt: new Date().toISOString(), stoppedAt: null };
save();

let serverOutput = "";
let credential = null;
let browser;
const pageErrors = [];
const redacted = () =>
  credential ? serverOutput.split(credential).join("<redacted>") : serverOutput;

try {
  credential = await new Promise((ready, fail) => {
    const timer = setTimeout(() => fail(new Error("Server startup timed out")), 60_000);
    const inspect = (chunk) => {
      serverOutput += chunk.toString();
      const match = serverOutput.match(/(?:^|\n)Token: ([^\s]+)/);
      if (match) {
        clearTimeout(timer);
        ready(match[1]);
      }
    };
    child.stdout.on("data", inspect);
    child.stderr.on("data", inspect);
    child.once("exit", (code) => {
      clearTimeout(timer);
      fail(new Error(`Server exited during startup: ${code}`));
    });
  });
  step("server-start", true, { pid: child.pid, port });

  browser = await chromium.launch({
    headless: true,
    ...(process.env.STUDIO_CHROMIUM_EXECUTABLE
      ? { executablePath: process.env.STUDIO_CHROMIUM_EXECUTABLE }
      : {}),
  });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    colorScheme: "light",
    reducedMotion: "reduce",
  });
  const auth = await context.request.post(`${origin}/api/auth/browser-session`, {
    data: { credential },
    headers: { Origin: origin },
  });
  assert.equal(auth.status(), 200, "browser-session exchange");
  step("browser-auth", true, { status: auth.status() });

  const register = async (title, workspaceRoot) => {
    const projectId = randomUUID();
    const created = await context.request.post(`${origin}/api/projects/mutate`, {
      headers: { Origin: origin },
      data: { type: "project.create", commandId: randomUUID(), projectId, title, workspaceRoot },
    });
    assert.equal(created.status(), 200, `project.create ${title}: ${created.status()}`);
    return (await created.json()).id ?? projectId;
  };
  const projectId = await register("Acme Live", checkout);
  step("register-project", true, { projectId });

  const page = await context.newPage();
  page.on("pageerror", (error) => pageErrors.push(String(error).slice(0, 300)));
  const shoot = async (name, kind) => {
    // Unrelated notifications (provider updates) would cover the page.
    const dismiss = page.getByRole("button", { name: "Dismiss notification" });
    for (let i = await dismiss.count(); i > 0; i--)
      await dismiss
        .first()
        .click()
        .catch(() => {});
    for (const theme of ["light", "dark"]) {
      await page.emulateMedia({ colorScheme: theme });
      await page.waitForTimeout(250);
      const path = join(output, `${name}-${theme}.png`);
      await page.screenshot({ path });
      receipt.screenshots.push({ path, theme, kind });
    }
    await page.emulateMedia({ colorScheme: "light" });
    save();
  };

  await page.goto(`${origin}/settings/design-systems`, {
    waitUntil: "networkidle",
    timeout: 60_000,
  });
  const list = page.getByTestId("design-system-list");
  await list.waitFor({ timeout: 30_000 });
  await page.getByText("No design systems yet").waitFor({ timeout: 30_000 });
  step("open-settings", true, { path: new URL(page.url()).pathname });

  // New design system > From this project's code > pick the project > scan.
  await page.getByTestId("new-design-system").click();
  await page.getByRole("menuitem", { name: "From this project's code" }).click();
  const dialog = page.getByTestId("new-design-system-dialog");
  await dialog.waitFor();
  await dialog.getByLabel("Project").click();
  await page.getByRole("option", { name: "Acme Live" }).click();
  await dialog.getByRole("button", { name: "Scan project" }).click();
  await dialog.getByTestId("scan-result").waitFor({ timeout: 60_000 });
  const candidates = await dialog
    .getByTestId("scan-candidate")
    .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-path")));
  assert.ok(candidates.includes("src/styles/theme.css"), `theme.css candidate: ${candidates}`);
  assert.ok(
    candidates.some((path) => path.startsWith("src/components/ui")),
    `component barrel candidate: ${candidates}`,
  );
  const scanCreatedFolder = existsSync(join(checkout, ".specweave"));
  assert.equal(scanCreatedFolder, false, "scan must not create .specweave");
  step("scan", true, { candidates, specweaveAfterScan: scanCreatedFolder });

  // Propose the first suggestion; the review opens.
  await dialog.getByTestId("scan-propose").first().click();
  const review = page.getByTestId("design-system-review-dialog");
  await review.getByTestId("design-system-review").waitFor({ timeout: 60_000 });
  const added = await review
    .locator('[data-testid="token-row"][data-change="added"]')
    .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-name")));
  assert.ok(added.length >= 12, `12+ new tokens in the review, saw ${added.length}`);
  assert.equal(
    existsSync(join(checkout, ".specweave")),
    false,
    "propose must not create .specweave",
  );
  step("propose-review", true, { addedTokens: added.length });
  await shoot("review-dialog", "review dialog");

  // Untick one new token, then confirm.
  const dropped = added.find((name) => /danger/i.test(name)) ?? added.at(-1);
  const droppedRow = review.locator(`[data-testid="token-row"][data-name="${dropped}"]`);
  await droppedRow.getByRole("checkbox").click();
  assert.equal(await droppedRow.getByRole("checkbox").getAttribute("aria-checked"), "false");
  const beforeConfirm = existsSync(join(checkout, ".specweave"));
  assert.equal(beforeConfirm, false, "no .specweave before confirm");
  await review.getByTestId("review-confirm").click();
  await review.waitFor({ state: "detached", timeout: 30_000 });
  step("untick-and-confirm", true, {
    droppedToken: dropped,
    specweaveBeforeConfirm: beforeConfirm,
  });

  // On disk: the system exists and lacks the unticked token.
  const files = systemFiles();
  assert.equal(files.length, 1, `one system on disk, saw ${files.length}`);
  const raw = readFileSync(files[0].path, "utf8");
  const system = JSON.parse(raw);
  const tokenNames = Object.keys(system.tokens ?? {});
  assert.ok(!raw.includes(`"${dropped}"`), `system.json still names ${dropped}`);
  assert.ok(tokenNames.length >= 11, `tokens saved: ${tokenNames.length}`);
  step("system-on-disk", true, {
    systemId: files[0].id,
    path: files[0].path,
    tokens: tokenNames.length,
    components: (Array.isArray(system.components)
      ? system.components
      : Object.values(system.components ?? {})
    ).map((component) => component.name),
    containsDropped: false,
  });

  // The list shows it; Rescan reports up to date.
  const row = list.locator(`[data-testid="system-row"][data-system="${files[0].id}"]`);
  await row.waitFor({ timeout: 30_000 });
  const rowText = (await row.textContent()) ?? "";
  step("list-shows-system", true, { row: rowText.replace(/\s+/g, " ").trim() });
  await row.getByRole("button", { name: /^Rescan / }).click();
  await row
    .getByTestId("rescan-note")
    .filter({ hasText: "No changes" })
    .waitFor({ timeout: 60_000 });
  step("rescan-up-to-date", true, {
    proposalsAfter: await page.getByTestId("proposal-row").count(),
  });
  // The page's Figma desktop row, from the same check the Figma dialog uses.
  const figmaRow = page.getByTestId("figma-desktop");
  await figmaRow.getByText("Figma desktop: off").waitFor({ timeout: 30_000 });
  step("settings-figma-row-off", true, {
    text: ((await figmaRow.textContent()) ?? "").replace(/\s+/g, " ").trim(),
  });
  await shoot("list-after-confirm", "list after confirm, with the Figma desktop row off");

  // From Figma desktop: nothing listens on 127.0.0.1:3845 here.
  await page.getByTestId("new-design-system").click();
  await page.getByRole("menuitem", { name: "From Figma desktop" }).click();
  const figma = page.getByTestId("figma-panel");
  await figma.and(page.locator('[data-state="off"]')).waitFor({ timeout: 30_000 });
  step("figma-off", true, {
    text: ((await figma.getByTestId("figma-off").textContent()) ?? "").trim(),
  });
  await shoot("figma-off", "figma off");
  await page
    .getByTestId("new-design-system-dialog")
    .getByRole("button", { name: "Close" })
    .last()
    .click();

  // The real Weave import (AC-11): scanned and reviewed in place, then discarded.
  const weaveState = () => ({
    designFolder: existsSync(join(weaveRoot, ".specweave/design")),
    status: spawnSync("git", ["status", "--porcelain", "--", "design", ".specweave/design"], {
      cwd: weaveRoot,
      encoding: "utf8",
    }).stdout,
  });
  const weaveBefore = weaveState();
  await register("SpecWeave", weaveRoot);
  await page.goto(`${origin}/settings/design-systems`, {
    waitUntil: "networkidle",
    timeout: 60_000,
  });
  await page.getByTestId("new-design-system").click();
  await page.getByRole("menuitem", { name: "From this project's code" }).click();
  const weaveDialog = page.getByTestId("new-design-system-dialog");
  await weaveDialog.getByLabel("Project").click();
  await page.getByRole("option", { name: "SpecWeave" }).click();
  await weaveDialog.getByRole("button", { name: "Scan project" }).click();
  await weaveDialog.getByTestId("scan-result").waitFor({ timeout: 120_000 });
  const weaveSuggestion = weaveDialog.locator('[data-testid="scan-suggestion"][data-key="weave"]');
  await weaveSuggestion.waitFor({ timeout: 30_000 });
  step("weave-scan", true, {
    suggestion: ((await weaveSuggestion.locator("h4").textContent()) ?? "").trim(),
  });
  await weaveSuggestion.getByTestId("scan-propose").click();
  const weaveReview = page.getByTestId("design-system-review-dialog");
  await weaveReview.getByTestId("design-system-review").waitFor({ timeout: 60_000 });
  const weaveTokens = await weaveReview
    .locator('[data-testid="token-row"][data-change="added"]')
    .count();
  assert.equal(weaveTokens, 51, `51 Weave tokens in the review, saw ${weaveTokens}`);
  const weaveCounts = ((await weaveReview.getByTestId("review-counts").textContent()) ?? "").trim();
  await shoot("review-weave-real-tokens", "real Weave import review, tokens");
  await weaveReview.getByRole("button", { name: /^Components/ }).click();
  await weaveReview.getByTestId("review-components").waitFor();
  const weaveComponents = await weaveReview.getByTestId("component-row").count();
  await shoot("review-weave-real-components", "real Weave import review, components");
  await weaveReview.getByRole("button", { name: "Discard" }).click();
  await weaveReview.waitFor({ state: "detached", timeout: 30_000 });
  await page.keyboard.press("Escape");
  const weaveAfter = weaveState();
  assert.deepEqual(weaveAfter, weaveBefore, "the Weave checkout is unchanged");
  step("weave-review-discarded", true, {
    tokens: weaveTokens,
    components: weaveComponents,
    counts: weaveCounts.replace(/\s+/g, " "),
    checkoutUnchanged: true,
  });

  // Gallery > New design: the picker offers the project's own system (AC-07).
  const systemName = system.name;
  await page.goto(`${origin}/design`, { waitUntil: "networkidle", timeout: 60_000 });
  await page.locator('[data-testid="design-create"][data-kind="design"]').click();
  const newDesign = page.getByTestId("new-design-dialog");
  await newDesign.waitFor({ timeout: 30_000 });
  await newDesign.getByLabel("Title").fill("Live picker check");
  await newDesign.getByLabel("Save in").click();
  await page.getByRole("option", { name: "Acme Live" }).click();
  await newDesign.getByLabel("Design system").click();
  await page.getByRole("option", { name: systemName, exact: true }).waitFor({ timeout: 30_000 });
  await shoot("gallery-new-design-picker", "gallery New design, design system picker open");
  await page.getByRole("option", { name: systemName, exact: true }).click();
  assert.equal(
    ((await newDesign.getByLabel("Design system").textContent()) ?? "").trim(),
    systemName,
  );
  step("gallery-picker", true, { picked: systemName });
  await newDesign.getByRole("button", { name: "Create design" }).click();

  // The editor header shows the same picker with the design's system.
  const editor = page.getByTestId("design-editor");
  await editor.waitFor({ timeout: 60_000 });
  const headerPicker = editor.getByTestId("design-system-picker").getByRole("combobox");
  await headerPicker.filter({ hasText: systemName }).waitFor({ timeout: 30_000 });
  // On disk: the new design names the system it was created with.
  const designRoot = join(checkout, ".specweave/design");
  let stored = null;
  for (let attempt = 0; attempt < 20 && stored === null; attempt++) {
    for (const name of readdirSync(designRoot, { recursive: true })) {
      const path = join(designRoot, String(name));
      if (!path.endsWith("/design.json")) continue;
      const parsed = JSON.parse(readFileSync(path, "utf8"));
      if (parsed?.title === "Live picker check")
        stored = { path, designSystem: parsed.designSystem };
    }
    if (stored === null) await page.waitForTimeout(250);
  }
  assert.equal(
    stored?.designSystem,
    files[0].id,
    `the design stores its system: ${JSON.stringify(stored)}`,
  );
  await shoot("editor-header-picker", "editor header with the design system picker");
  await headerPicker.click();
  await page.getByRole("option", { name: "None" }).waitFor({ timeout: 30_000 });
  await shoot("editor-header-picker-open", "editor header picker open");
  await page.keyboard.press("Escape");
  step("editor-header-picker", true, {
    route: new URL(page.url()).pathname,
    shows: systemName,
    stored,
  });

  assert.deepEqual(pageErrors, [], "no page errors");
  step("no-page-errors", true);
  receipt.passed = true;
  await context.close();
} catch (error) {
  receipt.failure = {
    message: String(error?.message ?? error).slice(0, 2000),
    lastStep: receipt.steps.at(-1)?.name ?? null,
    pageErrors,
  };
  // Server output, token removed, beside the temp project for debugging only.
  writeFileSync(join(work, "server-output.log"), redacted());
  receipt.failure.serverLog = join(work, "server-output.log");
  if (browser) {
    const pages = browser.contexts().flatMap((context) => context.pages());
    if (pages[0]) {
      const path = join(output, "failure.png");
      await pages[0].screenshot({ path }).catch(() => {});
      receipt.failure.screenshot = path;
    }
  }
  save();
  console.error(receipt.failure.message);
  process.exitCode = 1;
} finally {
  if (browser) await browser.close().catch(() => {});
  if (child.exitCode === null) {
    process.kill(child.pid, "SIGTERM");
    await Promise.race([
      new Promise((done) => child.once("exit", done)),
      new Promise((done) => setTimeout(done, 7000)),
    ]);
    if (child.exitCode === null) process.kill(child.pid, "SIGKILL");
  }
  receipt.server.stoppedAt = new Date().toISOString();
  receipt.server.exitCode = child.exitCode;
  credential = null;
  serverOutput = "";
  save();
}
