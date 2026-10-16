#!/usr/bin/env node
import { verifyPersonalEnvironment } from "./environment-acceptance.mjs";
// Real HTTP/RPC and browser acceptance. No provider turn, personal store, or service mutation.
import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeModule from "node:module";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeURL from "node:url";
import * as NodeNet from "node:net";
const assert = NodeAssert;
const { spawn, execFileSync } = NodeChildProcess;
const { randomUUID, createHash } = NodeCrypto;
const { createRequire } = NodeModule;
const { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } = NodeFS;
const { dirname, join, resolve } = NodePath;
const { homedir, tmpdir } = NodeOS;
const { fileURLToPath } = NodeURL;
const net = NodeNet;
import { rpc, requiredRpc } from "./rpc.mjs";
import { sourceVersion } from "./version.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const args = process.argv.slice(2);
if (args.includes("--help")) {
  console.log(
    "Node22 acceptance.mjs [--report-dir NEW_DIR] [--browser-deps NODE_MODULES] [--browser-executable FILE]\nUses fresh synthetic state, owned port8428, headless Chromium, disabled providers. Native proof is a separate explicit release gate.",
  );
  process.exit(0);
}
const allowedOptions = new Set(["--report-dir", "--browser-deps", "--browser-executable"]);
for (let i = 0; i < args.length; i += 2)
  assert.ok(
    allowedOptions.has(args[i]) && args[i + 1] && !args[i + 1].startsWith("--"),
    "Unknown or incomplete acceptance option",
  );
const option = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
assert.equal(process.versions.node, "22.20.0", "Use pinned Node22");
process.env.PWDEBUG = "0";
process.env.PLAYWRIGHT_HTML_OPEN = "never";
const port = 8428,
  origin = "http://127.0.0.1:8428";
const reportDir = resolve(
  option("--report-dir", join(tmpdir(), `studio-project-acceptance-${randomUUID()}`)),
);
assert.ok(!existsSync(reportDir), "Evidence directory must be fresh; preserve previous evidence");
const entrypoint = join(root, "apps/server/dist/bin.mjs");
assert.ok(existsSync(entrypoint), "Build integrated server before acceptance");
const version = sourceVersion(root);
const reportedVersion = execFileSync(process.execPath, [entrypoint, "--version"], {
  cwd: root,
  encoding: "utf8",
  timeout: 30000,
}).trim();
assert.equal(
  reportedVersion,
  `specweave-studio v${version}`,
  "Acceptance requires the matching integrated build",
);
await portFree();
mkdirSync(reportDir, { recursive: true, mode: 0o700 });
chmodSync(reportDir, 0o700);
const stateDir = mkdtempSync(join(tmpdir(), "studio-project-state-"));
chmodSync(stateDir, 0o700);
const fakeHome = join(stateDir, "home"),
  dataDir = join(stateDir, "studio");
mkdirSync(fakeHome, { mode: 0o700 });
mkdirSync(join(dataDir, "userdata"), { recursive: true, mode: 0o700 });
const legacyDrivers = ["codex", "claudeAgent", "cursor", "grok", "pi", "opencode", "antigravity"];
const instanceDrivers = [
  "codex",
  "claudeAgent",
  "claude-agent",
  "cursor",
  "grok",
  "pi",
  "opencode",
  "opencode2",
  "antigravity",
];
writeFileSync(
  join(dataDir, "userdata/settings.json"),
  JSON.stringify({
    providers: Object.fromEntries(legacyDrivers.map((driver) => [driver, { enabled: false }])),
    providerInstances: Object.fromEntries(
      instanceDrivers.map((driver) => [driver, { driver, enabled: false, config: {} }]),
    ),
    cursorKeychainUsageEnabled: false,
  }),
  { mode: 0o600 },
);
const projects = [
  { id: randomUUID(), title: "Acceptance Atlas", dir: join(stateDir, "atlas") },
  { id: randomUUID(), title: "Acceptance Other", dir: join(stateDir, "other") },
];
for (const project of projects) {
  mkdirSync(project.dir, { mode: 0o700 });
  writeFileSync(
    join(project.dir, "README.md"),
    "Synthetic acceptance project. No native inference.\n",
  );
  for (const gitArgs of [
    ["init", "-b", "feature/acceptance"],
    ["add", "README.md"],
    [
      "-c",
      "user.name=Acceptance",
      "-c",
      "user.email=acceptance@example.invalid",
      "commit",
      "-m",
      "Synthetic baseline",
    ],
  ])
    execFileSync("/usr/bin/git", gitArgs, {
      cwd: project.dir,
      stdio: "ignore",
      env: { HOME: fakeHome, PATH: "/usr/bin:/bin", GIT_CONFIG_NOSYSTEM: "1" },
    });
}
const scope = {
  projectIds: new Set(projects.map((p) => p.id)),
  routineIds: new Set(),
  threadIds: new Set(),
  providersDisabled: false,
  attachmentIds: new Set(),
};
const coordinatorRequests = [];
let coordinatorAttachmentFiles = [];
const receipt = {
  source: execFileSync("/usr/bin/git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).trim(),
  sourceDirty:
    execFileSync("/usr/bin/git", ["status", "--porcelain", "--untracked-files=no"], {
      cwd: root,
      encoding: "utf8",
    }).trim().length > 0,
  version,
  buildSha256: createHash("sha256").update(readFileSync(entrypoint)).digest("hex"),
  observedAt: new Date().toISOString(),
  node: process.version,
  evidenceKind: "real-isolated-server-and-browser",
  port,
  stateDir,
  browser: { headless: true, PWDEBUG: "0", PLAYWRIGHT_HTML_OPEN: "never", reporterOpen: "never" },
  nativeProof: {
    status: "not_requested",
    providerTurns: 0,
    reason: "Disabled providers and synthetic home; native acceptance is a separate explicit gate.",
  },
  steps: [],
  screenshots: [],
  serverPids: [],
  success: false,
};
const save = () =>
  writeFileSync(join(reportDir, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n", {
    mode: 0o600,
  });
let activeStep = "startup",
  child = null,
  browser = null,
  context = null,
  page = null;
const pause = (ms) => new Promise((done) => setTimeout(done, ms));
async function step(name, fn) {
  activeStep = name;
  await fn();
  receipt.steps.push({ name, passed: true });
  save();
  console.log(JSON.stringify({ name, passed: true }));
}
async function portFree() {
  await new Promise((done, reject) => {
    const probe = net.createServer();
    probe.once("error", () =>
      reject(new Error("Owned port8428 is occupied; existing owner preserved")),
    );
    probe.listen(port, "127.0.0.1", () => probe.close(done));
  });
}
async function stopServer() {
  if (!child) return;
  const own = child;
  child = null;
  if (own.exitCode === null && own.signalCode === null) {
    own.kill("SIGTERM");
    for (let i = 0; i < 50 && own.exitCode === null && own.signalCode === null; i++)
      await pause(100);
    if (own.exitCode === null && own.signalCode === null) own.kill("SIGKILL");
    for (let i = 0; i < 30 && own.exitCode === null && own.signalCode === null; i++)
      await pause(100);
  }
  assert.ok(own.exitCode !== null || own.signalCode !== null, "Owned server did not exit");
  await portFree();
}
async function startServer() {
  await portFree();
  // Do not inherit native auth, endpoint overrides, or shell profile paths.
  const env = {
    HOME: fakeHome,
    USER: "studio-acceptance",
    LOGNAME: "studio-acceptance",
    PATH: dirname(process.execPath) + ":/usr/bin:/bin",
    LANG: "en_US.UTF-8",
    STUDIO_AUTO_BOOTSTRAP_PROJECT_FROM_CWD: "false",
    PWDEBUG: "0",
    PLAYWRIGHT_HTML_OPEN: "never",
  };
  child = spawn(
    process.execPath,
    [
      entrypoint,
      "serve",
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--base-dir",
      dataDir,
      "--no-browser",
    ],
    { cwd: stateDir, env, stdio: ["ignore", "pipe", "pipe"] },
  );
  receipt.serverPids.push(child.pid);
  save();
  const credential = await new Promise((done, reject) => {
    let privateBuffer = "",
      settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      privateBuffer = "";
      fn(value);
    };
    const timer = setTimeout(
      () => finish(reject, new Error("Private server startup timeout")),
      45000,
    );
    const inspect = (chunk) => {
      if (settled) return;
      privateBuffer = (privateBuffer + chunk.toString()).slice(-65536);
      const found = privateBuffer.match(/(?:^|\n)Token: ([^\s]+)/);
      if (found) finish(done, found[1]);
    };
    child.stdout.on("data", inspect);
    child.stderr.on("data", inspect); // Never persist raw server logs.
    child.once("error", () => finish(reject, new Error("Owned server spawn failed")));
    child.once("exit", () => finish(reject, new Error("Owned server exited before ready")));
  });
  const auth = await context.request.post(origin + "/api/auth/browser-session", {
    headers: { Origin: origin },
    data: { credential },
  });
  assert.equal(auth.status(), 200, "Browser session exchange failed");
}
let terminating = false;
async function terminateOwnedRun() {
  if (terminating) return;
  terminating = true;
  receipt.success = false;
  receipt.failure = { step: activeStep, type: "Interrupted" };
  try {
    if (browser) await browser.close();
    await stopServer();
    receipt.ownedProcessStopped = true;
  } catch {
    receipt.ownedProcessStopped = false;
  }
  save();
  process.exit(1);
}
process.once("SIGTERM", () => void terminateOwnedRun());
process.once("SIGINT", () => void terminateOwnedRun());
const required = (tag, payload = {}) => requiredRpc(context, origin, tag, payload, scope);
const optional = (tag, payload = {}) => rpc(context, origin, tag, payload, scope);
async function mutate(project, type, fields = {}, success = true) {
  assert.ok(scope.projectIds.has(project.id));
  const response = await context.request.post(origin + "/api/projects/mutate", {
    headers: { Origin: origin },
    data: { type, commandId: randomUUID(), projectId: project.id, ...fields },
  });
  if (!success) {
    assert.ok(
      response.status() >= 400 && response.status() < 600,
      "Expected rejected project mutation",
    );
    return;
  }
  assert.equal(response.status(), 200, "Project mutation failed");
  return response.json();
}
async function settings(project, patch) {
  const before = await required("projects.workspaceRead", { projectId: project.id });
  await mutate(project, "project.update", {
    workspaceSettings: { expectedRevision: before.settings.revision, ...patch },
  });
  return required("projects.workspaceRead", { projectId: project.id });
}
const observedProjectUrls = new Map();
async function openProject(project) {
  const observedUrl = observedProjectUrls.get(project.id);
  if (observedUrl) {
    receipt.uiSubstep = "open-observed-project-route";
    save();
    await page.goto(observedUrl, { waitUntil: "domcontentloaded" });
    await page.getByRole("region", { name: "Project coordinator", exact: true }).waitFor();
    return;
  }
  await page.goto(origin, { waitUntil: "domcontentloaded" });
  for (let i = 0; i < 3; i++) {
    const next = page.getByRole("button", { name: "Continue", exact: true });
    if (await next.isVisible().catch(() => false)) await next.click();
    else break;
  }
  const skip = page.getByRole("button", { name: "Do not import projects", exact: true });
  if (await skip.isVisible().catch(() => false)) await skip.click();
  const link = page.locator('a[href*="/projects/"]').filter({ hasText: project.title }).first();
  receipt.uiSubstep = "discover-initial-project-link";
  save();
  await link.waitFor({ state: "visible", timeout: 30000 });
  await link.click();
  await page.getByRole("region", { name: "Project coordinator", exact: true }).waitFor();
  assert.ok(
    new URL(page.url()).pathname.startsWith("/projects/"),
    "Project route must be directly addressable",
  );
  observedProjectUrls.set(project.id, page.url());
}
async function uiSubstep(name, run) {
  receipt.uiSubstep = name;
  save();
  return await run();
}
async function screenshot(name) {
  const path = join(reportDir, name + ".png");
  await page.screenshot({ path, fullPage: true });
  receipt.screenshots.push(path);
  save();
}
try {
  const deps = resolve(
    option(
      "--browser-deps",
      join(homedir(), ".cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules"),
    ),
  );
  const { chromium } = createRequire(import.meta.url)(join(deps, "playwright"));
  const executableInput = option("--browser-executable", process.env.PLAYWRIGHT_EXECUTABLE_PATH);
  const executablePath = executableInput
    ? NodeFS.realpathSync(resolve(executableInput))
    : undefined;
  if (executablePath) {
    assert.ok(
      NodeFS.statSync(executablePath).isFile(),
      "Browser executable must be a regular file",
    );
    NodeFS.accessSync(executablePath, NodeFS.constants.X_OK);
    receipt.browser.executablePath = executablePath;
  }
  browser = await chromium.launch({
    headless: true,
    ...(executablePath ? { executablePath } : {}),
  });
  context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    colorScheme: "light",
    reducedMotion: "reduce",
  });
  page = await context.newPage();
  page.on("websocket", (socket) =>
    socket.on("framesent", ({ payload }) => {
      try {
        const parsed = JSON.parse(String(payload));
        for (const item of Array.isArray(parsed) ? parsed : [parsed])
          if (item._tag === "Request" && item.tag === "projects.coordinatorSend")
            coordinatorRequests.push(item.payload);
      } catch {
        /* Binary/control frames are not RPC submissions. */
      }
    }),
  );
  page.setDefaultTimeout(15000);
  let pageErrors = 0;
  page.on("pageerror", () => pageErrors++);
  await step("fresh-authenticated-server", startServer);
  await step("anonymous-access-denied", async () => {
    const anonymous = await browser.newContext();
    try {
      assert.equal((await anonymous.request.get(origin + "/api/projects")).status(), 401);
    } finally {
      await anonymous.close();
    }
  });
  await step("providers-disabled", async () => {
    const config = await required("server.getConfig");
    assert.ok(Array.isArray(config.providers));
    assert.ok(
      config.providers.every((provider) => provider.enabled === false),
      "Every configured provider must be disabled",
    );
    const effective = await required("server.getSettings");
    assert.equal(effective.cursorKeychainUsageEnabled, false);
    assert.ok(Object.values(effective.providers).every((provider) => provider.enabled === false));
    assert.ok(
      Object.values(effective.providerInstances).every((provider) => provider.enabled === false),
    );
    scope.providersDisabled = true;
  });
  const [atlas, other] = projects;
  await step("create-folder-projects", async () => {
    for (const project of projects)
      await mutate(project, "project.create", { title: project.title, workspaceRoot: project.dir });
    const response = await context.request.get(origin + "/api/projects");
    assert.equal(response.status(), 200);
    const list = await response.json();
    assert.equal(list.projects.length, 2, "Synthetic state must have exactly two projects");
  });
  await step("settings-cas-and-project-isolation", async () => {
    const before = await required("projects.workspaceRead", { projectId: atlas.id });
    const after = await settings(atlas, {
      goal: "Keep synthetic work isolated",
      instructions: "Synthetic project-only instructions",
    });
    assert.equal(after.settings.revision, before.settings.revision + 1);
    await mutate(
      atlas,
      "project.update",
      {
        workspaceSettings: { expectedRevision: before.settings.revision, goal: "stale overwrite" },
      },
      false,
    );
    assert.equal(
      (await required("projects.workspaceRead", { projectId: atlas.id })).settings.goal,
      "Keep synthetic work isolated",
    );
    assert.equal(
      (await required("projects.workspaceRead", { projectId: other.id })).settings.goal,
      "",
    );
  });
  await step("memory-crud-cas-and-isolation", async () => {
    const input = { projectId: atlas.id, name: "MEMORY.md" };
    const first = await required("projects.memoryWrite", {
      ...input,
      content: "Synthetic durable fact",
      expectedRevision: null,
    });
    assert.equal((await required("projects.memoryRead", input)).content, "Synthetic durable fact");
    assert.equal(
      (
        await optional("projects.memoryWrite", {
          ...input,
          content: "stale",
          expectedRevision: null,
        })
      ).code,
      "conflict",
    );
    assert.equal(
      (await optional("projects.memoryRead", { ...input, projectId: other.id })).code,
      "not_found",
    );
    const updated = await required("projects.memoryWrite", {
      ...input,
      content: "Synthetic revised fact",
      expectedRevision: first.revision,
    });
    assert.ok(updated.revision > first.revision);
    assert.equal(
      (await optional("projects.memoryDelete", { ...input, expectedRevision: first.revision }))
        .code,
      "conflict",
    );
    const temporary = await required("projects.memoryWrite", {
      projectId: atlas.id,
      name: "temporary.md",
      content: "temporary",
      expectedRevision: null,
    });
    assert.equal(
      (
        await required("projects.memoryDelete", {
          projectId: atlas.id,
          name: "temporary.md",
          expectedRevision: temporary.revision,
        })
      ).deleted,
      true,
    );
    assert.equal(
      (await optional("projects.memoryRead", { projectId: atlas.id, name: "temporary.md" })).code,
      "not_found",
    );
  });
  const atlasThreads = [
    { id: randomUUID(), title: "Synthetic Codex worker", instance: "codex" },
    { id: randomUUID(), title: "Synthetic Claude worker", instance: "claudeAgent" },
  ];
  const otherThread = {
    id: randomUUID(),
    title: "Synthetic other project worker",
    instance: "codex",
  };
  await step("inert-mixed-provider-workers", async () => {
    for (const [project, thread] of [
      ...atlasThreads.map((thread) => [atlas, thread]),
      [other, otherThread],
    ]) {
      scope.threadIds.add(thread.id);
      await required("orchestration.dispatchCommand", {
        type: "thread.create",
        commandId: randomUUID(),
        threadId: thread.id,
        projectId: project.id,
        title: thread.title,
        modelSelection: { instanceId: thread.instance, model: "synthetic-unavailable" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      });
    }
  });
  await step("usage-empty-is-not-fabricated-cost-or-cache", async () => {
    const usage = await required("projects.usageRead", { projectId: atlas.id });
    assert.equal(usage.source, "persisted_provider_turns");
    assert.equal(usage.totals.totalTokens, 0);
    assert.equal(usage.totals.equivalentCostUsd, null);
    assert.equal(usage.cacheReadRatio, null);
    assert.equal(usage.coverage.threads, 2);
    assert.equal(usage.coverage.missingThreads, 2);
    assert.deepEqual(
      usage.threads.map((thread) => thread.threadId).sort(),
      atlasThreads.map((thread) => thread.id).sort(),
    );
  });
  const routineId = randomUUID();
  scope.routineIds.add(routineId);
  await step("routine-and-coordinator-admission", async () => {
    await required("scheduledTasks.upsert", {
      id: routineId,
      projectId: atlas.id,
      title: "Synthetic paused review",
      prompt: "Never execute providers in acceptance",
      enabled: false,
      schedule: { type: "interval", everyMs: 86400000 },
      workspaceStrategy: { type: "root" },
      modelSelection: { instanceId: "codex", model: "synthetic-unavailable" },
      runtimeMode: "full-access",
      interactionMode: "default",
    });
    for (const policy of ["paused", "archived"]) {
      await settings(atlas, { paused: policy === "paused", archived: policy === "archived" });
      const commandId = randomUUID();
      for (let attempt = 0; attempt < 2; attempt++)
        assert.equal(
          (await optional("scheduledTasks.runNow", { id: routineId, commandId })).ok,
          false,
        );
      const coordinator = await optional("projects.coordinatorStart", {
        projectId: atlas.id,
        commandId: randomUUID(),
      });
      assert.equal(coordinator.code, policy);
      const tasks = await required("scheduledTasks.list");
      assert.equal(tasks.tasks.find((task) => task.id === routineId).runCount, 0);
    }
    await settings(atlas, { paused: false, archived: false });
  });
  await step("clickable-thread-pane-and-resolve-reopen", async () => {
    await openProject(atlas);
    const card = page
      .locator("article.project-thread-card")
      .filter({ hasText: atlasThreads[0].title });
    await card.locator("button.sws-thread-open").click();
    await page
      .getByRole("complementary", { name: "Thread " + atlasThreads[0].title, exact: true })
      .waitFor();
    for (const width of [1440, 1024, 768]) {
      await page.setViewportSize({ width, height: 1000 });
      const pane = page.locator(".project-native-thread");
      await pane.locator('[data-chat-layout="embedded"]').waitFor();
      const controls = pane.locator("[data-workspace-titlebar-controls]");
      await controls.first().waitFor();
      const paneBox = await pane.boundingBox();
      const toolbar = await page.locator(".project-workspace-header").boundingBox();
      for (const control of await controls.all()) {
        if (!(await control.isVisible())) continue;
        const box = await control.boundingBox();
        assert.ok(
          box.x >= paneBox.x - 1 && box.x + box.width <= paneBox.x + paneBox.width + 1,
          "Worker controls escape pane horizontally",
        );
        assert.ok(
          box.y >= paneBox.y - 1 && box.y >= toolbar.y + toolbar.height - 1,
          "Worker controls overlap project toolbar",
        );
      }
      if (width === 1440) {
        await pane.getByRole("button", { name: "Toggle right panel", exact: true }).click();
        await page.locator('[data-slot="sheet-popup"]').waitFor();
        await screenshot("worker-right-panel-sheet");
        await page.keyboard.press("Escape");
        await page.locator('[data-slot="sheet-popup"]').waitFor({ state: "hidden" });
      }
      await page.getByRole("button", { name: "Project settings", exact: true }).click();
      await page.getByRole("dialog").waitFor();
      await page.keyboard.press("Escape");
      await page.getByRole("dialog").waitFor({ state: "hidden" });
      await screenshot(`worker-toolbar-contained-${width}`);
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    await screenshot("worker-right-pane");
    await page.getByRole("button", { name: "Back to project threads", exact: true }).click();
    await card.getByRole("button", { name: "Resolve", exact: true }).click();
    await card.getByRole("button", { name: "Reopen", exact: true }).waitFor();
    await card.getByRole("button", { name: "Reopen", exact: true }).click();
    await card.getByRole("button", { name: "Resolve", exact: true }).waitFor();
  });
  await step("worker-attachment-upload-routing-replay-and-preview", async () => {
    const coordinatorId = `project-coordinator:${atlas.id}`;
    scope.threadIds.add(coordinatorId);
    await settings(atlas, {
      coordinatorModelSelection: { instanceId: "codex", model: "synthetic-unavailable" },
    });
    await required("projects.coordinatorStart", { projectId: atlas.id, commandId: randomUUID() });
    await openProject(atlas);
    await page
      .locator("article.project-thread-card")
      .filter({ hasText: atlasThreads[1].title })
      .locator("button.sws-thread-open")
      .click();
    const pane = page.locator(".project-native-thread");
    const bytes = Buffer.from("Project attachment acceptance bytes.\n");
    const editor = pane.locator('[contenteditable="true"]').first();
    await editor.fill("Route this captured file through the coordinator.");
    await pane
      .locator('input[type="file"]')
      .setInputFiles({ name: "acceptance-notes.txt", mimeType: "text/plain", buffer: bytes });
    const send = pane.getByRole("button", { name: "Submit message", exact: true });
    await send.waitFor();
    assert.equal(
      await send.isEnabled(),
      true,
      "Unavailable worker provider must not disable coordinator routing",
    );
    await send.click();
    await page
      .getByText("Sent to the coordinator with this thread as context.", { exact: true })
      .waitFor();
    receipt.uiSubstep = "attachment-send-request";
    receipt.attachmentProof = { coordinatorRequests: coordinatorRequests.length };
    save();
    assert.equal(coordinatorRequests.length, 1);
    const request = coordinatorRequests[0];
    assert.equal(request.projectId, atlas.id);
    assert.equal(request.sourceThreadId, atlasThreads[1].id);
    assert.equal(request.attachments.length, 1);
    assert.equal(request.attachments[0].name, "acceptance-notes.txt");
    for (const attachment of request.attachments) scope.attachmentIds.add(attachment.id);
    receipt.uiSubstep = "attachment-draft-cleared";
    save();
    assert.equal((await editor.innerText()).trim(), "", "Acknowledged composer draft must clear");
    receipt.uiSubstep = "attachment-captured-preview";
    save();
    const preview = page
      .getByRole("region", { name: "Project coordinator", exact: true })
      .getByRole("button", { name: "Preview acceptance-notes.txt", exact: true });
    await preview.waitFor();
    await preview.click();
    await page.getByText("Project attachment acceptance bytes.", { exact: true }).waitFor();
    await screenshot("coordinator-captured-attachment");
    receipt.uiSubstep = "attachment-captured-bytes";
    save();
    const attachmentDir = join(dataDir, "userdata", "attachments");
    coordinatorAttachmentFiles = NodeFS.readdirSync(attachmentDir)
      .filter((name) => !name.startsWith("pending-"))
      .map((name) => join(attachmentDir, name));
    assert.equal(coordinatorAttachmentFiles.length, 1);
    assert.deepEqual(readFileSync(coordinatorAttachmentFiles[0]), bytes);
    // Acknowledged draft cleanup removes the staged retry source. The durable receipt
    // must still replay without another upload, dispatch, or claimed copy.
    for (
      let i = 0;
      i < 40 && NodeFS.readdirSync(attachmentDir).some((name) => name.startsWith("pending-"));
      i++
    )
      await pause(100);
    assert.equal(
      NodeFS.readdirSync(attachmentDir).some((name) => name.startsWith("pending-")),
      false,
    );
    receipt.uiSubstep = "attachment-replay-expired-stage";
    save();
    await required("projects.coordinatorSend", request);
    assert.equal(
      (await optional("projects.coordinatorSend", { ...request, prompt: "Changed request" })).code,
      "conflict",
    );
    assert.equal(NodeFS.readdirSync(attachmentDir).length, 1);
    await page.getByRole("button", { name: "Back to project threads", exact: true }).click();
  });
  await step("project-route-and-settings-ui", async () => {
    await openProject(atlas);
    await uiSubstep("open-settings", () =>
      page.getByRole("button", { name: "Project settings", exact: true }).click(),
    );
    const dialog = page.getByRole("dialog");
    await uiSubstep("settings-dialog-visible", () => dialog.waitFor());
    await uiSubstep("fill-goal", () =>
      dialog
        .getByRole("textbox", { name: "Goal", exact: true })
        .fill("Saved from the real browser"),
    );
    await uiSubstep("save-goal", () =>
      dialog.getByRole("button", { name: "Save changes", exact: true }).click(),
    );
    for (let i = 0; i < 20; i++) {
      if (
        (await required("projects.workspaceRead", { projectId: atlas.id })).settings.goal ===
        "Saved from the real browser"
      )
        break;
      await pause(100);
    }
    assert.equal(
      (await required("projects.workspaceRead", { projectId: atlas.id })).settings.goal,
      "Saved from the real browser",
    );
    await dialog
      .getByRole("navigation", { name: "Project settings sections" })
      .getByRole("button", { name: "Memory", exact: true })
      .click();
    await dialog.getByLabel("New memory filename").fill("browser.md");
    await dialog.getByRole("button", { name: "New file", exact: true }).click();
    await dialog.getByLabel("Content of browser.md").fill("Saved through real project memory UI");
    await dialog.getByRole("button", { name: "Save memory", exact: true }).click();
    for (let i = 0; i < 20; i++) {
      if ((await optional("projects.memoryRead", { projectId: atlas.id, name: "browser.md" })).ok)
        break;
      await pause(100);
    }
    assert.equal(
      (await required("projects.memoryRead", { projectId: atlas.id, name: "browser.md" })).content,
      "Saved through real project memory UI",
    );
    for (const section of ["Usage", "Routines"])
      await dialog
        .getByRole("navigation", { name: "Project settings sections" })
        .getByRole("button", { name: section, exact: true })
        .click();
    await screenshot("settings-routines-desktop");
    await page.keyboard.press("Escape");
  });
  await step("optional-plain-plan-ui-cas-and-real-verification", async () => {
    await openProject(atlas);
    await page.getByRole("button", { name: "Plan", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("button", { name: "Add a plan", exact: true }).click();
    await dialog
      .getByRole("textbox", { name: "Plan spec", exact: true })
      .fill("Verify native project plans without any external CLI.");
    await dialog.getByRole("button", { name: "Add criterion", exact: true }).click();
    await dialog
      .getByRole("textbox", { name: "AC-1 criterion", exact: true })
      .fill("Each explicit verification request runs at most once.");
    await dialog.getByRole("button", { name: "Add task", exact: true }).click();
    await dialog
      .getByRole("textbox", { name: "T-1 title", exact: true })
      .fill("Check durable evidence");
    await dialog.getByRole("checkbox", { name: "AC-1", exact: true }).check();
    await dialog
      .getByRole("checkbox", { name: "Save a verification command", exact: true })
      .check();
    await dialog
      .getByRole("textbox", { name: "T-1 executable", exact: true })
      .fill(process.execPath);
    const verificationOutput = join(atlas.dir, "verification-runs.txt");
    const program =
      "require('node:fs').appendFileSync('verification-runs.txt','run\\n');console.log('actual verification passed')";
    await dialog
      .getByRole("textbox", { name: "T-1 arguments", exact: true })
      .fill("-e\n" + program);
    await dialog.getByRole("button", { name: "Save plan", exact: true }).click();
    await dialog.getByRole("button", { name: "Edit plan", exact: true }).waitFor();
    receipt.uiSubstep = "plan-saved-readback";
    let savedPlan = await required("projects.planRead", { projectId: atlas.id });
    assert.equal(savedPlan.native.tasks[0].verification.args[0], "-e");
    assert.equal(existsSync(verificationOutput), false, "Saving cannot execute a command");
    assert.equal((await required("projects.planRead", { projectId: other.id })).revision, 0);
    await dialog.getByRole("button", { name: "Edit plan", exact: true }).click();
    await dialog
      .getByRole("textbox", { name: "Plan spec", exact: true })
      .fill("Unsaved browser draft survives a conflict");
    const definition = {
      spec: "Updated concurrently through authenticated RPC",
      criteria: savedPlan.native.criteria,
      tasks: savedPlan.native.tasks.map(({ id, title, criterionIds, verification }) => ({
        id,
        title,
        criterionIds,
        verification,
      })),
    };
    await required("projects.planReplace", {
      projectId: atlas.id,
      expectedRevision: savedPlan.revision,
      definition,
    });
    await dialog.getByRole("button", { name: "Save plan", exact: true }).click();
    await dialog.getByRole("alert").filter({ hasText: "plan changed elsewhere" }).waitFor();
    assert.equal(
      await dialog.getByRole("textbox", { name: "Plan spec", exact: true }).inputValue(),
      "Unsaved browser draft survives a conflict",
    );
    await dialog.getByRole("button", { name: "Reload saved plan", exact: true }).click();
    await dialog.getByRole("button", { name: "Discard edit", exact: true }).click();
    await dialog
      .getByText("Updated concurrently through authenticated RPC", { exact: true })
      .waitFor();
    await dialog.getByText("Verification command and evidence", { exact: true }).click();
    await dialog.getByRole("button", { name: "Run verification", exact: true }).click();
    await dialog.getByText("Verified", { exact: true }).waitFor();
    receipt.uiSubstep = "verification-receipt-read";
    savedPlan = await required("projects.planRead", { projectId: atlas.id });
    assert.equal(savedPlan.native.tasks[0].evidence.at(-1).outcome, "passed");
    assert.equal(savedPlan.native.tasks[0].evidence.at(-1).exitCode, 0);
    assert.ok(
      savedPlan.native.tasks[0].evidence.at(-1).stdout.includes("actual verification passed"),
    );
    const firstOutput = readFileSync(verificationOutput, "utf8");
    await dialog.getByRole("button", { name: "Recheck last request", exact: true }).click();
    await dialog
      .getByRole("button", { name: "Recheck last request", exact: true })
      .waitFor({ state: "visible" });
    assert.equal(readFileSync(verificationOutput, "utf8"), firstOutput);
    await dialog.getByRole("button", { name: "New verification attempt", exact: true }).click();
    for (let i = 0; i < 30; i++) {
      if (
        (await required("projects.planRead", { projectId: atlas.id })).native.tasks[0].evidence.at(
          -1,
        )?.outcome === "passed" &&
        readFileSync(verificationOutput, "utf8") === firstOutput + firstOutput
      )
        break;
      await pause(100);
    }
    receipt.uiSubstep = "verification-receipt-read";
    savedPlan = await required("projects.planRead", { projectId: atlas.id });
    assert.equal(savedPlan.native.tasks[0].evidence.length, 2);
    assert.equal(readFileSync(verificationOutput, "utf8"), firstOutput + firstOutput);
    receipt.uiSubstep = "verification-second-receipt-read";
    await screenshot("plain-plan-verified-evidence");
    for (const width of [390, 768]) {
      await page.setViewportSize({ width, height: 1000 });
      const bounds = await dialog.boundingBox();
      assert.ok(
        bounds.x >= 0 && bounds.x + bounds.width <= width + 1,
        "Plan dialog must fit its viewport",
      );
      assert.equal(
        await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
        true,
        "Plan content overflows horizontally",
      );
      await screenshot(`plain-plan-${width}`);
    }
    await page.setViewportSize({ width: 1440, height: 1000 });

    await dialog.getByRole("button", { name: "Plan source", exact: true }).click();
    await dialog.getByRole("textbox", { name: "SpecWeave root", exact: true }).fill(other.dir);
    await dialog.getByRole("textbox", { name: "Increment ID", exact: true }).fill("0888-example");
    await dialog.getByRole("checkbox", { name: /Replace the saved Studio plan/ }).check();
    await dialog.getByRole("button", { name: "Connect SpecWeave source", exact: true }).click();
    await dialog
      .getByRole("alert")
      .filter({ hasText: /outside the project|unavailable/ })
      .waitFor();
    assert.equal(
      (await required("projects.planRead", { projectId: atlas.id })).authority.kind,
      "native",
    );
    await dialog.getByRole("button", { name: "Close project plan", exact: true }).click();
  });
  await step("broken-plan-source-explicit-human-repair", async () => {
    const incrementDir = join(other.dir, ".specweave/increments/0888-example");
    mkdirSync(incrementDir, { recursive: true });
    writeFileSync(
      join(incrementDir, "spec.md"),
      "# Source\n## Tasks\n### T-01 Preserve owner\n- AC: AC-01 | Files: example.ts | Test: npm test\n",
    );
    writeFileSync(
      join(incrementDir, "ledger.jsonl"),
      JSON.stringify({
        t: "T-01",
        e: "claim",
        by: "external-owner",
        at: "2026-10-09T00:00:00.000Z",
      }) + "\n",
    );
    await required("projects.planConfigure", {
      projectId: other.id,
      expectedRevision: 0,
      authority: { kind: "specweave", root: other.dir, incrementId: "0888-example" },
      discardNative: false,
    });
    writeFileSync(join(incrementDir, "ledger.jsonl"), "{malformed source preserved}");
    assert.equal(
      (await optional("projects.planRead", { projectId: other.id })).code,
      "source_invalid",
    );
    assert.equal(
      (await required("projects.planAuthorityRead", { projectId: other.id })).revision,
      1,
    );
    await openProject(other);
    await page.getByRole("button", { name: "Plan", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("region", { name: "Repair plan source", exact: true }).waitFor();
    assert.equal(await dialog.getByRole("button", { name: "Add a plan", exact: true }).count(), 0);
    await screenshot("broken-source-explicit-repair");
    await dialog.getByRole("button", { name: "Use an empty Studio plan", exact: true }).click();
    await dialog.getByRole("button", { name: "Add a plan", exact: true }).waitFor();
    assert.equal(
      (await required("projects.planRead", { projectId: other.id })).authority.kind,
      "native",
    );
    assert.equal(
      readFileSync(join(incrementDir, "ledger.jsonl"), "utf8"),
      "{malformed source preserved}",
    );
    await dialog.getByRole("button", { name: "Close project plan", exact: true }).click();
    await openProject(atlas);
  });
  await step("responsive-light-dark", async () => {
    for (const colorScheme of ["light", "dark"])
      for (const width of [390, 768, 1440]) {
        await page.emulateMedia({ colorScheme });
        await page.setViewportSize({ width, height: 1000 });
        await page.reload({ waitUntil: "domcontentloaded" });
        await page.getByRole("region", { name: "Project coordinator", exact: true }).waitFor();
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 2),
          true,
          "Project page overflows horizontally",
        );
        const dark = await page.evaluate(() => document.documentElement.classList.contains("dark"));
        assert.equal(dark, colorScheme === "dark", "Actual theme must match the screenshot claim");
        await screenshot(`project-${colorScheme}-${width}`);
      }
  });
  await step("persistence-after-owned-server-restart", async () => {
    await context.close();
    await stopServer();
    context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
      colorScheme: "light",
    });
    await startServer();
    assert.equal(
      (await required("projects.workspaceRead", { projectId: atlas.id })).settings.goal,
      "Saved from the real browser",
    );
    assert.equal(
      (await required("projects.memoryRead", { projectId: atlas.id, name: "MEMORY.md" })).content,
      "Synthetic revised fact",
    );
    assert.equal(
      (await required("projects.memoryRead", { projectId: atlas.id, name: "browser.md" })).content,
      "Saved through real project memory UI",
    );
    assert.equal(
      (await required("scheduledTasks.list")).tasks.find((task) => task.id === routineId).runCount,
      0,
    );
    assert.equal(
      (await required("projects.planRead", { projectId: atlas.id })).native.tasks[0].evidence
        .length,
      2,
    );
    await required("projects.coordinatorSend", coordinatorRequests[0]);
    assert.equal(NodeFS.readdirSync(join(dataDir, "userdata", "attachments")).length, 1);
    page = await context.newPage();
    page.on("pageerror", () => pageErrors++);
    await openProject(atlas);
  });
  await step("danger-zone-exact-confirmation-and-purge", async () => {
    await mutate(atlas, "project.delete", { force: true, confirmationTitle: "wrong title" }, false);
    await page.getByRole("button", { name: "Project settings", exact: true }).click();
    const dialog = page.getByRole("dialog");
    const confirm = dialog.getByLabel("Confirm project deletion");
    const remove = dialog.getByRole("button", { name: "Delete project and threads", exact: true });
    assert.equal(await remove.isEnabled(), false);
    await confirm.fill("wrong title");
    assert.equal(await remove.isEnabled(), false);
    await confirm.fill(atlas.title);
    assert.equal(await remove.isEnabled(), true);
    await screenshot("danger-zone-confirmation");
    await remove.click();
    for (let i = 0; i < 30; i++) {
      if (!(await optional("projects.workspaceRead", { projectId: atlas.id })).ok) break;
      await pause(100);
    }
    assert.equal(
      (await optional("projects.workspaceRead", { projectId: atlas.id })).code,
      "not_found",
    );
    assert.equal(
      (await optional("projects.memoryRead", { projectId: atlas.id, name: "MEMORY.md" })).code,
      "not_found",
    );
    assert.equal(
      (await required("scheduledTasks.list")).tasks.some((task) => task.id === routineId),
      false,
    );
    assert.equal(
      (await optional("scheduledTasks.runNow", { id: routineId, commandId: randomUUID() })).ok,
      false,
    );
    assert.equal(
      (await required("projects.workspaceRead", { projectId: other.id })).settings.goal,
      "",
    );
    assert.equal((await optional("projects.planRead", { projectId: atlas.id })).code, "not_found");
    for (let i = 0; i < 50 && coordinatorAttachmentFiles.some(existsSync); i++) await pause(100);
    assert.ok(
      coordinatorAttachmentFiles.every((path) => !existsSync(path)),
      "Project deletion must remove coordinator attachment bytes",
    );
    assert.ok(
      existsSync(join(atlas.dir, "README.md")),
      "Delete project must preserve source files",
    );
  });
  await verifyPersonalEnvironment({
    step,
    required,
    optional,
    settings,
    mutate,
    scope,
    stateDir,
    fakeHome,
    openProject,
    page,
    screenshot,
  });
  await step("no-native-provider-turns-or-browser-errors", async () => {
    const response = await context.request.get(origin + "/api/orchestration/shell", {
      headers: { "x-studio-orchestration-protocol": "2" },
    });
    assert.equal(response.status(), 200);
    const shell = await response.json();
    const threads = [...(shell.threads ?? []), ...(shell.archivedThreads ?? [])];
    assert.equal(threads.length, 1);
    assert.equal(threads[0].id, otherThread.id);
    assert.ok(threads.every((thread) => thread.activeRunId == null));
    assert.equal(pageErrors, 0);
    const { openLiveDatabaseReadOnly } = await import("../lib/live-database.mjs");
    const database = openLiveDatabaseReadOnly(join(dataDir, "userdata", "statev2.sqlite"));
    try {
      const providerTurns = database
        .prepare("SELECT count(*) AS count FROM orchestration_v2_projection_provider_turns")
        .get().count;
      assert.equal(
        providerTurns,
        0,
        "Disabled-provider acceptance must not execute native inference",
      );
      receipt.nativeProof.providerTurns = providerTurns;
      receipt.attachmentProof.appRuns = database
        .prepare(
          "SELECT status, count(*) AS count FROM orchestration_v2_projection_runs GROUP BY status",
        )
        .all();
    } finally {
      database.close();
    }
  });
  receipt.success = true;
} catch (error) {
  receipt.failure = {
    step: activeStep,
    substep: receipt.uiSubstep ?? null,
    type: error?.name ?? "Error",
  };
  // Only authenticated synthetic project pages are eligible. Never capture the
  // pairing page, credential exchange, raw server output, or input values.
  if (page && new URL(page.url()).pathname.startsWith("/projects/")) {
    try {
      await screenshot("failure-synthetic-project");
      const text = await page.locator("body").innerText({ timeout: 3000 });
      writeFileSync(join(reportDir, "failure-synthetic-page.txt"), text.slice(0, 16000), {
        mode: 0o600,
      });
      if (error?.name === "TimeoutError")
        receipt.failure.locatorTimeout = String(error.message).slice(0, 2500);
    } catch {
      receipt.failure.captureUnavailable = true;
    }
  }
  process.exitCode = 1;
  console.error(
    JSON.stringify({
      failedStep: activeStep,
      errorType: error?.name ?? "Error",
      privateDetailsOmitted: true,
    }),
  );
} finally {
  if (browser) await browser.close();
  try {
    await stopServer();
    receipt.ownedProcessStopped = true;
  } catch {
    receipt.success = false;
    receipt.ownedProcessStopped = false;
    process.exitCode = 1;
  }
  save();
  console.log(
    JSON.stringify({
      success: receipt.success,
      receipt: join(reportDir, "receipt.json"),
      nativeProof: receipt.nativeProof.status,
    }),
  );
}
