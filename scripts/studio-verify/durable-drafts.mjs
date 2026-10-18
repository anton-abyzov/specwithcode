// Headless proof that unsent composer drafts survive kill -9: types text and
// attaches an image in a project coordinator and a thread, kills the browser
// and the private server by PID, restarts the server, opens a fresh browser
// profile (no local storage) and checks both drafts come back from the host.
// Usage: node scripts/studio-verify/durable-drafts.mjs [/absolute/evidence-dir]
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { createServer } from "node:net";

assert.ok(process.versions.node.startsWith("22."), "Use Node 22 for the candidate runtime");
process.env.PWDEBUG = "0";
process.env.PLAYWRIGHT_HTML_OPEN = "never";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const entrypoint = join(
  resolve(process.env.STUDIO_TEST_CANDIDATE_DIR ?? join(root, "apps/server/dist")),
  "bin.mjs",
);
const privateRoot = join(homedir(), ".local/share/specweave-studio/verification/durable-drafts");
mkdirSync(privateRoot, { recursive: true, mode: 0o700 });
const out = resolve(process.argv[2] ?? join(privateRoot, `run-${Date.now()}`));
mkdirSync(out, { recursive: true });
const state = mkdtempSync(join(privateRoot, "private-state-"));
mkdirSync(join(state, "userdata"));
mkdirSync(join(state, "proof-project"));
writeFileSync(
  join(state, "userdata/settings.json"),
  JSON.stringify({
    providers: Object.fromEntries(
      ["codex", "claudeAgent", "cursor", "grok", "pi", "opencode", "antigravity"].map((id) => [
        id,
        { enabled: false },
      ]),
    ),
    providerInstances: { codex: { driver: "codex", enabled: false, config: {} } },
  }),
);
const imagePath = join(out, "attached.png");
writeFileSync(
  imagePath,
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  ),
);
const port = await new Promise((done, reject) => {
  const socket = createServer();
  socket.once("error", reject);
  socket.listen(0, "127.0.0.1", () => {
    const { port } = socket.address();
    socket.close(() => done(port));
  });
});
const origin = `http://127.0.0.1:${port}`;

function startCandidate() {
  const child = spawn(
    process.execPath,
    [
      entrypoint,
      "serve",
      "--no-browser",
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--base-dir",
      state,
    ],
    {
      cwd: state,
      env: { ...process.env, STUDIO_DISABLE_AUTO_UPDATE: "true" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const credential = new Promise((done, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error("Private server startup timed out")), 45000);
    const observe = (chunk) => {
      output += chunk.toString();
      const match = output.match(/(?:^|\n)Token: ([^\s]+)/);
      if (match) {
        clearTimeout(timer);
        done(match[1]);
      }
    };
    child.stdout.on("data", observe);
    child.stderr.on("data", observe);
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Private server exited ${code}`));
    });
  });
  return { child, credential };
}

/** kill -9 of exactly this PID, then wait for it to be gone. */
async function killNine(child, label) {
  const exited = new Promise((done) => child.once("exit", (_code, signal) => done(signal)));
  process.kill(child.pid, "SIGKILL");
  assert.equal(await exited, "SIGKILL", `${label} must die from SIGKILL`);
}

const req = createRequire(join(root, "apps/server/package.json"));
const { chromium } = req("playwright-core");
const executablePath =
  process.env.STUDIO_TEST_CHROMIUM ??
  join(
    homedir(),
    "Library/Caches/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-mac-arm64/chrome-headless-shell",
  );

async function openBrowser(credential) {
  // A browser server exposes its process, so it can be killed by PID like a crashed app.
  const server = await chromium.launchServer({ headless: true, executablePath });
  const browser = await chromium.connect(server.wsEndpoint());
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const auth = await context.request.post(`${origin}/api/auth/browser-session`, {
    data: { credential },
    headers: { Origin: origin },
  });
  assert.equal(auth.status(), 200);
  await context.addInitScript(() =>
    localStorage.setItem(
      "studio:client-settings:v1",
      JSON.stringify({ onboardingCompletedAt: "2026-10-12T00:00:00Z" }),
    ),
  );
  return { server, browser, context };
}

/**
 * A headless browser on a kept profile, started by this script so its PID can
 * be killed like a crashing app while IndexedDB survives on disk.
 */
async function openProfileBrowser(profileDir, credential, cookies = []) {
  const child = spawn(
    executablePath,
    [
      "--headless",
      `--user-data-dir=${profileDir}`,
      "--remote-debugging-port=0",
      "--no-first-run",
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  const endpoint = await new Promise((done, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error("Headless browser did not start")), 20000);
    child.stderr.on("data", (chunk) => {
      output += chunk.toString();
      const match = output.match(/DevTools listening on (ws:\/\/\S+)/);
      if (match) {
        clearTimeout(timer);
        done(match[1]);
      }
    });
  });
  const browser = await chromium.connectOverCDP(endpoint);
  const context = browser.contexts()[0];
  if (cookies.length > 0) await context.addCookies(cookies);
  const auth = await context.request.post(`${origin}/api/auth/browser-session`, {
    data: { credential },
    headers: { Origin: origin },
  });
  // A pairing token works once; a session already in the profile or handed over stays valid.
  if (auth.status() !== 200) {
    const session = await context.request.post(`${origin}/api/auth/websocket-ticket`, {
      headers: { Origin: origin },
    });
    assert.equal(session.status(), 200, "the kept profile must still be signed in");
  }
  await context.addInitScript(() =>
    localStorage.setItem(
      "studio:client-settings:v1",
      JSON.stringify({ onboardingCompletedAt: "2026-10-12T00:00:00Z" }),
    ),
  );
  return { child, browser, context };
}

async function rpc(context, tag, payload = {}) {
  const ticketResponse = await context.request.post(`${origin}/api/auth/websocket-ticket`, {
    headers: { Origin: origin },
  });
  assert.equal(ticketResponse.status(), 200);
  const { ticket } = await ticketResponse.json();
  const url = new URL(origin);
  url.protocol = "ws:";
  url.pathname = "/ws";
  url.searchParams.set("wsTicket", ticket);
  url.searchParams.set("orchestrationProtocol", "2");
  return new Promise((done, reject) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error(`RPC timeout ${tag}`));
    }, 20000);
    ws.addEventListener("open", () =>
      ws.send(JSON.stringify({ _tag: "Request", id: "1", tag, payload, headers: [] })),
    );
    ws.addEventListener("message", (event) => {
      for (const item of [JSON.parse(event.data)].flat())
        if (item._tag === "Exit" && String(item.requestId) === "1") {
          clearTimeout(timer);
          ws.close();
          if (item.exit?._tag === "Success") done(item.exit.value);
          else reject(new Error(`RPC failed ${tag}: ${JSON.stringify(item.exit).slice(0, 800)}`));
        }
    });
  });
}

const TYPED_DURING_UPDATE = " + typed while the update stopped the host: ✓ 🙂";
const COORDINATOR_TEXT =
  "Coordinator draft before kill -9: émoji 🙂, «quotes», tabs\tand\nnew lines";
const THREAD_TEXT = "Thread draft before kill -9 — symbols ✓ ≠ ∑ 日本語";
const receipt = { headless: true, origin, privateState: state, checks: [], screenshots: [] };
let candidate = startCandidate();
let first;
let second;
let third;
try {
  first = await openBrowser(await candidate.credential);
  const projectId = "durable-drafts-proof";
  await rpc(first.context, "projects.mutate", {
    type: "project.create",
    commandId: "proof-create",
    projectId,
    title: "Durable drafts proof",
    workspaceRoot: join(state, "proof-project"),
    defaultModelSelection: { instanceId: "codex", model: "gpt-6.1-sol" },
  });
  const config = await rpc(first.context, "server.getConfig");
  const environmentId = config.environment.environmentId;
  assert.ok(environmentId, "environment id");
  const threadId = "durable-drafts-thread";
  await rpc(first.context, "orchestration.dispatchCommand", {
    type: "thread.create",
    commandId: "proof-thread",
    threadId,
    projectId,
    title: "Draft proof thread",
    createdBy: "user",
    creationSource: "web",
    modelSelection: { instanceId: "codex", model: "gpt-6.1-sol" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
  });

  const page = await first.context.newPage();
  await page.goto(origin, { waitUntil: "networkidle" });
  await page.getByRole("link", { name: "Durable drafts proof", exact: true }).click();
  await page.locator("#project-prompt").waitFor();
  const projectUrl = page.url();
  await page.locator("#project-prompt").fill(COORDINATOR_TEXT);
  await page.locator('input[type="file"][multiple]').first().setInputFiles(imagePath);
  await page.locator('img[src^="blob:"]').first().waitFor({ timeout: 20000 });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: join(out, "1-coordinator-before-kill.png") });

  const threadUrl = `${origin}/${environmentId}/${threadId}`;
  await page.goto(threadUrl, { waitUntil: "networkidle" });
  const editor = page.locator('[data-testid="composer-editor"]');
  await editor.waitFor();
  await editor.click();
  await page.keyboard.insertText(THREAD_TEXT);
  await page.locator('input[type="file"]').last().setInputFiles(imagePath);
  await page.locator('img[src^="blob:"], img[src^="data:"]').first().waitFor({ timeout: 20000 });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: join(out, "2-thread-before-kill.png") });

  // The app dies without a chance to clean up, and so does the host.
  await killNine(first.server.process(), "browser");
  first = undefined;
  await killNine(candidate.child, "server");
  const saved = readdirSync(join(state, "userdata/composer-drafts"));
  receipt.checks.push({ hostDraftFoldersAfterKill: saved.length });
  assert.ok(saved.length >= 2, "both drafts are on disk");

  candidate = startCandidate();
  // A fresh browser profile: no local storage, as on another device or after a lost profile.
  second = await openBrowser(await candidate.credential);
  const restored = await second.context.newPage();
  await restored.goto(projectUrl, { waitUntil: "networkidle" });
  await restored.locator("#project-prompt").waitFor();
  await restored.waitForFunction(
    (text) => document.querySelector("#project-prompt")?.value === text,
    COORDINATOR_TEXT,
    { timeout: 20000 },
  );
  await restored.locator('img[src^="blob:"]').first().waitFor({ timeout: 20000 });
  receipt.checks.push({ coordinatorTextRestored: true, coordinatorImageRestored: true });
  await restored.screenshot({ path: join(out, "3-coordinator-after-restart.png") });

  await restored.goto(threadUrl, { waitUntil: "networkidle" });
  await restored.waitForFunction(
    (text) =>
      document.querySelector('[data-testid="composer-editor"]')?.textContent?.includes(text),
    THREAD_TEXT,
    { timeout: 20000 },
  );
  await restored
    .locator('img[src^="blob:"], img[src^="data:"]')
    .first()
    .waitFor({ timeout: 20000 });
  receipt.checks.push({ threadTextRestored: true, threadImageRestored: true });
  await restored.screenshot({ path: join(out, "4-thread-after-restart.png") });

  // An update stops the host before the window closes: whatever is typed
  // then never reaches the host, and the app is killed right after.
  const signedIn = await second.context.cookies();
  await second.browser.close();
  await second.server.close();
  second = undefined;
  const profileDir = mkdtempSync(join(state, "profile-"));
  third = await openProfileBrowser(profileDir, await candidate.credential, signedIn);
  const updating = await third.context.newPage();
  await updating.goto(projectUrl, { waitUntil: "networkidle" });
  await updating.waitForFunction(
    (text) => document.querySelector("#project-prompt")?.value === text,
    COORDINATOR_TEXT,
    { timeout: 20000 },
  );
  await killNine(candidate.child, "server (update stops the host)");
  await updating.locator("#project-prompt").focus();
  await updating.keyboard.press("End");
  await updating.keyboard.insertText(TYPED_DURING_UPDATE);
  // No blur, no flush: the app is killed within a moment of the last keystroke.
  await updating.waitForTimeout(150);
  await updating.screenshot({ path: join(out, "5-typed-while-host-down.png") });
  await killNine(third.child, "browser (update relaunch)");
  third = undefined;

  candidate = startCandidate();
  third = await openProfileBrowser(profileDir, await candidate.credential);
  const relaunched = await third.context.newPage();
  await relaunched.goto(projectUrl, { waitUntil: "networkidle" });
  await relaunched.waitForFunction(
    (text) => document.querySelector("#project-prompt")?.value === text,
    COORDINATOR_TEXT + TYPED_DURING_UPDATE,
    { timeout: 20000 },
  );
  receipt.checks.push({ typedWhileHostDownRestored: true });
  // The host gets the text it missed once it is back.
  const hostDeadline = Date.now() + 20000;
  let hostHasIt = false;
  while (!hostHasIt && Date.now() < hostDeadline) {
    const folders = readdirSync(join(state, "userdata/composer-drafts"));
    hostHasIt = folders.some((folder) => {
      try {
        const draft = JSON.parse(
          readFileSync(join(state, "userdata/composer-drafts", folder, "draft.json"), "utf8"),
        );
        return draft.prompt === COORDINATOR_TEXT + TYPED_DURING_UPDATE;
      } catch {
        return false;
      }
    });
    if (!hostHasIt) await relaunched.waitForTimeout(500);
  }
  assert.ok(hostHasIt, "the host received the text typed while it was down");
  receipt.checks.push({ hostCaughtUp: true });
  await relaunched.screenshot({ path: join(out, "6-after-update-relaunch.png") });
  receipt.ok = true;
} catch (error) {
  receipt.failure = error.message;
  for (const session of [first, second, third])
    for (const context of session?.browser.contexts() ?? [])
      for (const page of context.pages())
        await page.screenshot({ path: join(out, "failure.png"), fullPage: true }).catch(() => {});
  throw error;
} finally {
  await second?.browser.close().catch(() => {});
  await second?.server.close().catch(() => {});
  await first?.server.close().catch(() => {});
  await third?.browser.close().catch(() => {});
  if (third && third.child.exitCode === null && third.child.signalCode === null) {
    third.child.kill("SIGTERM");
  }
  if (candidate.child.exitCode === null && candidate.child.signalCode === null) {
    candidate.child.kill("SIGTERM");
  }
  receipt.screenshots = existsSync(out) ? readdirSync(out).filter((f) => f.endsWith(".png")) : [];
  writeFileSync(join(out, "receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`);
  console.log(JSON.stringify(receipt, null, 2));
}
