import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { createServer } from "node:net";
import { DatabaseSync } from "node:sqlite";

import { openLiveDatabaseReadOnly } from "../lib/live-database.mjs";

assert.ok(process.versions.node.startsWith("22."), "Use Node 22 for the candidate runtime");
process.env.PWDEBUG = "0";
process.env.PLAYWRIGHT_HTML_OPEN = "never";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const bundleRoot = resolve(process.env.STUDIO_TEST_CANDIDATE_DIR ?? join(root, "apps/server/dist"));
const entrypoint = join(bundleRoot, "bin.mjs");
const privateRoot = join(homedir(), ".local/share/specweave-studio/verification/0899/headless");
mkdirSync(privateRoot, { recursive: true, mode: 0o700 });
const out = resolve(process.argv[2] ?? join(privateRoot, `run-${Date.now()}`));
mkdirSync(out, { recursive: true, mode: 0o700 });
const state = mkdtempSync(join(privateRoot, "private-state-"));
mkdirSync(join(state, "userdata"));
mkdirSync(join(state, "proof-project"));
mkdirSync(join(state, "archived-project"));
// No copied credentials or live store. Disabled provider deliberately proves the
// failure/review UI without inference; native admission is covered separately.
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
const port = await new Promise((resolvePort, reject) => {
  const socket = createServer();
  socket.once("error", reject);
  socket.listen(0, "127.0.0.1", () => {
    const address = socket.address();
    socket.close(() => resolvePort(address.port));
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
      env: {
        ...process.env,
        STUDIO_DISABLE_AUTO_UPDATE: "true",
        PWDEBUG: "0",
        PLAYWRIGHT_HTML_OPEN: "never",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const credential = new Promise((done, reject) => {
    let output = "";
    const timer = setTimeout(
      () => reject(new Error("Private candidate startup timed out; pairing output omitted")),
      45000,
    );
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
      reject(new Error(`Private candidate exited ${code}; pairing output omitted`));
    });
  });
  return { child, credential };
}
async function stopCandidate(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await new Promise((done, reject) => {
    const timer = setTimeout(() => reject(new Error("Private candidate did not stop")), 10000);
    child.once("exit", () => {
      clearTimeout(timer);
      done();
    });
  });
}
let candidate = startCandidate();
const manifestPath = join(bundleRoot, "studio-manifest.json");
const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf8")) : null;
const bundleDigest = createHash("sha256");
for (const path of readdirSync(bundleRoot, { recursive: true }).sort()) {
  const file = join(bundleRoot, path);
  if (path.startsWith("node_modules/") || !statSync(file).isFile()) continue;
  bundleDigest.update(path).update("\0").update(readFileSync(file)).update("\0");
}
const receipt = {
  sourceHeadAtCheck: execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).trim(),
  artifact: {
    entrypoint,
    manifestSourceCommit: manifest?.sourceCommit ?? null,
    bundleSha256: bundleDigest.digest("hex"),
    sha256: createHash("sha256").update(readFileSync(entrypoint)).digest("hex"),
    modifiedAt: statSync(entrypoint).mtime.toISOString(),
  },
  headless: true,
  runtime: process.version,
  startedAt: new Date().toISOString(),
  privateState: state,
  nativeTurns: 0,
  liveServicesChanged: false,
  checks: [],
  screenshots: [],
};
let browser;
const req = createRequire(join(root, "apps/server/package.json"));
const { chromium } = req("playwright-core");
try {
  const credential = await candidate.credential;
  browser = await chromium.launch({
    headless: true,
    executablePath:
      process.env.STUDIO_TEST_CHROMIUM ??
      join(
        homedir(),
        "Library/Caches/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-mac-arm64/chrome-headless-shell",
      ),
  });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    reducedMotion: "reduce",
  });
  const auth = await context.request.post(origin + "/api/auth/browser-session", {
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
  async function rpc(tag, payload = {}) {
    assert.ok(
      [
        "server.getConfig",
        "projects.mutate",
        "projects.coordinatorStart",
        "projects.coordinatorSend",
        "projects.workspaceRead",
        "orchestration.dispatchCommand",
      ].includes(tag),
    );
    if (tag === "orchestration.dispatchCommand") assert.equal(payload.type, "thread.create");
    const ticketResponse = await context.request.post(origin + "/api/auth/websocket-ticket", {
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
      ws.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new Error(`RPC transport failed ${tag}`));
      });
      ws.addEventListener("message", (event) => {
        const value = JSON.parse(event.data);
        const items = Array.isArray(value) ? value : [value];
        for (const item of items)
          if (item._tag === "Exit" && String(item.requestId) === "1") {
            clearTimeout(timer);
            ws.close();
            if (item.exit?._tag === "Success") done(item.exit.value);
            else
              reject(new Error(`RPC failed ${tag}: ${JSON.stringify(item.exit).slice(0, 1200)}`));
          }
      });
    });
  }
  const projectId = "routing-proof";
  await rpc("projects.mutate", {
    type: "project.create",
    commandId: "proof-create",
    projectId,
    title: "Routing proof",
    workspaceRoot: join(state, "proof-project"),
    defaultModelSelection: { instanceId: "codex", model: "gpt-6.1-sol" },
  });
  const workspace = await rpc("projects.workspaceRead", { projectId });
  await rpc("projects.mutate", {
    type: "project.update",
    commandId: "proof-select-model",
    projectId,
    workspaceSettings: {
      expectedRevision: workspace.settings.revision,
      coordinatorModelSelection: { instanceId: "codex", model: "gpt-6.1-sol" },
    },
  });
  await rpc("projects.mutate", {
    type: "project.create",
    commandId: "proof-archive-create",
    projectId: "archived-proof",
    title: "Archived routing sample",
    workspaceRoot: join(state, "archived-project"),
  });
  const archived = await rpc("projects.workspaceRead", { projectId: "archived-proof" });
  await rpc("projects.mutate", {
    type: "project.update",
    commandId: "proof-archive",
    projectId: "archived-proof",
    workspaceSettings: { expectedRevision: archived.settings.revision, archived: true },
  });
  const coordinator = await rpc("projects.coordinatorStart", {
    projectId,
    commandId: "proof-start",
  });
  receipt.coordinatorId = coordinator.threadId;
  for (const [threadId, title] of [
    ["routing-worker", "Routing worker"],
    ["routing-independent", "Independent request"],
  ]) {
    await rpc("orchestration.dispatchCommand", {
      type: "thread.create",
      commandId: `proof-${threadId}`,
      threadId,
      projectId,
      title,
      createdBy: "user",
      creationSource: "web",
      modelSelection: { instanceId: "codex", model: "gpt-6.1-sol" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
    });
  }
  // Web RPC correctly enforces user provenance. Build one synthetic retained
  // agent fixture offline, in this private store only, without a provider turn.
  await stopCandidate(candidate.child);
  const database = new DatabaseSync(join(state, "userdata/statev2.sqlite"));
  try {
    const row = database
      .prepare("SELECT payload_json FROM orchestration_v2_projection_threads WHERE thread_id = ?")
      .get("routing-worker");
    assert.ok(row, "Private worker fixture must exist");
    const worker = JSON.parse(row.payload_json);
    assert.equal(worker.createdBy, "user");
    worker.createdBy = "agent";
    worker.creationSource = "mcp";
    const update = database
      .prepare(
        "UPDATE orchestration_v2_projection_threads SET payload_json = ? WHERE thread_id = ?",
      )
      .run(JSON.stringify(worker), "routing-worker");
    assert.equal(update.changes, 1);
  } finally {
    database.close();
  }
  receipt.workerFixture = "Synthetic agent provenance in stopped private test store";
  candidate = startCandidate();
  const restartedAuth = await context.request.post(origin + "/api/auth/browser-session", {
    data: { credential: await candidate.credential },
    headers: { Origin: origin },
  });
  assert.equal(restartedAuth.status(), 200);
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(origin, { waitUntil: "networkidle" });
  await page.getByRole("link", { name: "Routing proof", exact: true }).click();
  await page.locator("#project-prompt").waitFor();
  const projectUrl = page.url();
  receipt.checks.push({ projectRoute: new URL(projectUrl).pathname.startsWith("/projects/") });
  await rpc("projects.coordinatorSend", {
    projectId,
    commandId: "proof-failure",
    prompt: "Isolated review fixture; provider disabled, no inference.",
  });
  await page.getByRole("button", { name: /Needs review/i }).waitFor({ timeout: 30000 });
  await page.locator("#project-prompt").fill("Preserve this coordinator draft");
  await page.getByRole("button", { name: /Needs review/i }).click();
  assert.equal(page.url(), projectUrl, "A failed coordinator must stay in its conversation");
  assert.equal(
    await page.getByRole("button", { name: /Back to coordinator|Review coordinator/i }).count(),
    0,
  );
  assert.equal(await page.getByRole("dialog").count(), 0);
  assert.equal(await page.locator("#project-prompt").count(), 1);
  await page.getByText("Error details", { exact: true }).click();
  const retry = page.getByRole("button", { name: "Retry last message", exact: true });
  assert.equal(await retry.getAttribute("data-slot"), "button");
  const historyUrl = `/api/orchestration/threads/${encodeURIComponent(receipt.coordinatorId)}`;
  const beforeRetry = await page.evaluate(async (url) => {
    const response = await fetch(url, { headers: { "x-studio-orchestration-protocol": "2" } });
    if (!response.ok) throw new Error(`Owned thread read failed: ${response.status}`);
    return (await response.json()).projection.runs.at(-1);
  }, historyUrl);
  assert.equal(beforeRetry.status, "failed");
  await retry.click();
  const retriedRun = await page.waitForFunction(
    async ({ url, ordinal }) => {
      const response = await fetch(url, { headers: { "x-studio-orchestration-protocol": "2" } });
      if (!response.ok) return false;
      const run = (await response.json()).projection.runs.at(-1);
      return run && run.ordinal > ordinal && run.status === "failed" ? run : false;
    },
    { url: historyUrl, ordinal: beforeRetry.ordinal },
    { timeout: 30000 },
  );
  const latestRun = await retriedRun.jsonValue();
  await page.waitForFunction(
    (id) => document.querySelector("[data-coordinator-failure] dd")?.textContent === id,
    latestRun.id,
  );
  await page.locator("[data-coordinator-failure]").waitFor({ timeout: 30000 });
  await retry.waitFor({ state: "visible", timeout: 30000 });
  assert.equal(await retry.isEnabled(), true, "Retry must settle and become usable again");
  receipt.checks.push({
    recoveryStaysInConversation: true,
    styledRetry: true,
    retrySettles: true,
    retryStartsNewRun: true,
    errorDetailsMatchLatestRun: true,
    singleCoordinatorComposer: true,
  });
  await page.screenshot({ path: join(out, "coordinator-recovery-desktop.png"), fullPage: true });
  receipt.screenshots.push(join(out, "coordinator-recovery-desktop.png"));
  assert.equal(
    await page.locator("#project-prompt").inputValue(),
    "Preserve this coordinator draft",
  );
  receipt.checks.push({ retryPreservesDraft: true });
  await page.getByText("Routing worker", { exact: true }).click();
  await page.waitForURL(
    (url) => url.pathname.startsWith("/projects/") && url.searchParams.has("thread"),
  );
  await page.locator("#project-prompt").waitFor();
  receipt.checks.push({ workerOpensBesideCoordinator: true });
  await page.screenshot({ path: join(out, "worker-beside-coordinator.png"), fullPage: true });
  receipt.screenshots.push(join(out, "worker-beside-coordinator.png"));
  await page.getByText("Independent request", { exact: true }).click();
  await page.waitForURL(
    (url) => !url.pathname.startsWith("/projects/") && url.pathname.includes("routing-independent"),
  );
  receipt.checks.push({ independentChatKeepsOwnPage: true });
  await page.getByRole("button", { name: /^New chat/ }).click();
  await page.waitForURL(/\/draft\//);
  await page.getByRole("button", { name: "No project", exact: true }).waitFor();
  receipt.checks.push({ newChatStandalone: true });
  await page.getByRole("button", { name: "No project", exact: true }).click();
  assert.equal(
    await page.getByRole("menuitemradio", { name: "Archived routing sample" }).count(),
    0,
  );
  await page.getByRole("menuitemradio", { name: "Routing proof", exact: true }).click();
  await page.waitForURL((url) => url.pathname.startsWith("/projects/"));
  await page.locator("#project-prompt").waitFor();
  receipt.checks.push({ projectPickerOpensCoordinator: true, archivedProjectOmitted: true });
  // Rehydrate an invested draft from the same persisted shape produced by a
  // real Scratch composer. This models an old named-project draft on upgrade.
  await page.getByRole("button", { name: /^New chat/ }).click();
  await page.waitForURL(/\/draft\//);
  const oldDraftId = decodeURIComponent(new URL(page.url()).pathname.split("/").pop());
  await page.waitForFunction((id) => {
    const raw = localStorage.getItem("studio:composer-drafts:v1");
    return raw && JSON.parse(raw).state.draftThreadsByThreadKey[id];
  }, oldDraftId);
  const oldDraftFixture = await page.evaluate(
    ({ id, projectId }) => {
      const value = JSON.parse(localStorage.getItem("studio:composer-drafts:v1"));
      const session = value.state.draftThreadsByThreadKey[id];
      session.projectId = projectId;
      session.branch = "saved-draft-branch";
      value.state.draftsByThreadKey[id] = {
        ...(value.state.draftsByThreadKey[id] ?? {}),
        prompt: "Retained project request with an attachment",
        attachments: [],
        files: [
          { id: "saved-file", name: "scope.pdf", mimeType: "application/pdf", sizeBytes: 32 },
        ],
      };
      return value;
    },
    { id: oldDraftId, projectId },
  );
  await context.addInitScript(
    ({ id, value }) => {
      if (
        location.pathname.endsWith("/draft/" + encodeURIComponent(id)) &&
        !sessionStorage.getItem("studio:0899:old-draft-fixture")
      ) {
        localStorage.setItem("studio:composer-drafts:v1", JSON.stringify(value));
        sessionStorage.setItem("studio:0899:old-draft-fixture", "seeded");
      }
    },
    { id: oldDraftId, value: oldDraftFixture },
  );
  const readThreadCount = () => {
    const database = openLiveDatabaseReadOnly(join(state, "userdata/statev2.sqlite"));
    try {
      return database
        .prepare("SELECT count(*) AS count FROM orchestration_v2_projection_threads")
        .get().count;
    } finally {
      database.close();
    }
  };
  const threadCountBefore = readThreadCount();
  await page.reload({ waitUntil: "networkidle" });
  await page.getByText(/Project work starts in the coordinator/).waitFor();
  await page.getByText("scope.pdf", { exact: true }).waitFor();
  await page.screenshot({ path: join(out, "retained-project-draft.png"), fullPage: true });
  receipt.screenshots.push(join(out, "retained-project-draft.png"));
  await page.waitForFunction((id) => {
    const persisted = JSON.parse(localStorage.getItem("studio:composer-drafts:v1"));
    return persisted.state.draftsByThreadKey[id].prompt.includes(
      "studio-context://v1/file/file_saved-file",
    );
  }, oldDraftId);
  const normalizedPromptBefore = await page.evaluate(
    (id) =>
      JSON.parse(localStorage.getItem("studio:composer-drafts:v1")).state.draftsByThreadKey[id]
        .prompt,
    oldDraftId,
  );
  assert.ok(normalizedPromptBefore.startsWith("Retained project request with an attachment"));
  await page.getByRole("button", { name: "Open project coordinator", exact: true }).click();
  await page.waitForURL(
    (url) => url.pathname.startsWith("/projects/") && url.searchParams.has("checkout"),
  );
  await page.locator("#project-prompt").waitFor();
  const retainedDraft = await page.evaluate(
    (id) =>
      JSON.parse(localStorage.getItem("studio:composer-drafts:v1")).state.draftsByThreadKey[id],
    oldDraftId,
  );
  assert.equal(retainedDraft.prompt, normalizedPromptBefore);
  assert.equal(retainedDraft.files[0].name, "scope.pdf");
  assert.equal(
    readThreadCount(),
    threadCountBefore,
    "Opening coordinator must not create a manual worker",
  );
  receipt.checks.push({
    oldProjectDraftGuardVisible: true,
    attachmentAndPromptRetained: true,
    coordinatorLinkCreatesNoWorker: true,
  });
  for (const [width, theme] of [
    [1440, "light"],
    [390, "dark"],
  ]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.emulateMedia({ colorScheme: theme });
    await page.goto(projectUrl, { waitUntil: "networkidle" });
    await page.locator("#project-prompt").waitFor();
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
      true,
    );
    const path = join(out, `project-${width}-${theme}.png`);
    await page.screenshot({ path, fullPage: true });
    receipt.screenshots.push(path);
  }
  if (process.env.STUDIO_TEST_INCLUDE_PRIVACY === "1") {
    const { verifyPrivacyPage } = await import("./coordinator-privacy.mjs");
    await verifyPrivacyPage({ page, origin, out, receipt });
  }
  assert.deepEqual(errors, []);
  receipt.checks.push({ pageErrors: errors });
  await context.close();
} catch (error) {
  receipt.failure = error.message;
  if (browser)
    for (const context of browser.contexts())
      for (const page of context.pages()) {
        await page.screenshot({ path: join(out, "failure.png"), fullPage: true }).catch(() => {});
        writeFileSync(
          join(out, "failure-page.txt"),
          await page
            .locator("body")
            .innerText()
            .catch(() => ""),
        );
      }
  throw error;
} finally {
  await browser?.close();
  await stopCandidate(candidate.child);
  receipt.candidateStopped = true;
  receipt.completedAt = new Date().toISOString();
  writeFileSync(join(out, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n", {
    mode: 0o600,
  });
}
console.log(JSON.stringify(receipt, null, 2));
