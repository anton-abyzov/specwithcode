#!/usr/bin/env node
// Actual application recording only. Never reads a personal Studio store or starts inference.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { randomUUID, createHash } from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import net from "node:net";
import { sourceVersion } from "./version.mjs";
import { safeFailure } from "./rpc.mjs";
import { createPersonalFixture, capturePersonalEnvironment } from "./tutorial-personal.mjs";

export const ORIGIN = "http://127.0.0.1:8432";
export const TUTORIALS = [
  "memory-and-usage",
  "plans-and-routines",
  "projects-and-threads",
  "personal-and-connections",
];
export const NATIVE_PROOF_CAPTION =
  "Verified here: native project coordination. Device deployment is checked separately.";
const NATIVE_PROOF_SCOPE = {
  proofScope: "functional-project-coordination",
  wholeProfileBytePreservation: "not-established",
  fleetDeploymentVerified: false,
};
// A native fixture proves project coordination only; it must say so, and never claim
// whole-profile byte preservation or a verified fleet deployment.
export function nativeProofScope(fixture) {
  for (const [key, value] of Object.entries(NATIVE_PROOF_SCOPE)) {
    assert.equal(fixture[key], value, `Native proof scope must retain ${key}`);
  }
  return { ...NATIVE_PROOF_SCOPE };
}
const ownPath = fileURLToPath(import.meta.url);
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sha = (data) => createHash("sha256").update(data).digest("hex");
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const writeJson = (file, value) =>
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
const names = ["codex", "claudeAgent", "cursor", "grok", "pi", "opencode", "antigravity"];

export function captureEnvironment(home, temporary) {
  return {
    HOME: home,
    USER: "studio-tutorial",
    LOGNAME: "studio-tutorial",
    TMPDIR: temporary,
    PATH: path.dirname(process.execPath) + ":/usr/bin:/bin",
    LANG: "en_US.UTF-8",
    STUDIO_AUTO_BOOTSTRAP_PROJECT_FROM_CWD: "false",
    PWDEBUG: "0",
    PLAYWRIGHT_HTML_OPEN: "never",
  };
}
export function assertInside(parent, child) {
  const rel = path.relative(fs.realpathSync(parent), fs.realpathSync(child));
  assert(
    rel && rel !== ".." && !rel.startsWith(".." + path.sep) && !path.isAbsolute(rel),
    "Path must remain inside the owned capture directory",
  );
}
export function assertAcceptance(receipt, sourceCommit, buildSha256, version) {
  assert.equal(receipt.success, true, "Acceptance did not pass");
  assert.equal(receipt.source, sourceCommit, "Acceptance source does not match capture");
  assert.equal(receipt.sourceDirty, false, "Acceptance must use clean committed source");
  assert.equal(receipt.buildSha256, buildSha256, "Acceptance build does not match capture");
  assert.equal(receipt.version, version, "Acceptance version does not match capture");
  assert.equal(receipt.browser?.headless, true);
}
export function assertNativeFixture(fixture, sourceCommit) {
  nativeProofScope(fixture);
  assert.equal(fixture.schemaVersion, 1);
  assert.equal(fixture.sourceCommit, sourceCommit);
  assert.equal(fixture.syntheticDataOnly, true);
  assert.equal(fixture.providersDisabled, true);
  assert.equal(
    fixture.captureOwnershipTransferred,
    true,
    "Native capture store needs explicit owner transfer",
  );
  assert.equal(fixture.nativeProviders?.claude, "passed");
  assert.equal(fixture.nativeProviders?.codex, "passed");
  assert(/^[a-f0-9]{64}$/.test(fixture.nativeReceiptSha256));
  assert(
    Array.isArray(fixture.projects) && fixture.projects.length >= 1 && fixture.projects.length <= 3,
  );
  for (const project of fixture.projects) assert(project.id && project.title && project.dir);
  assert(fixture.coordinator?.id && fixture.coordinator.title);
  assert(Array.isArray(fixture.workers) && fixture.workers.length === 1);
  assert.deepEqual(
    new Set([fixture.coordinator.provider, ...fixture.workers.map((w) => w.provider)]),
    new Set(["claude", "codex"]),
  );
  for (const worker of fixture.workers) assert(worker.id && worker.title);
  return fixture;
}
export function assertTutorialRpc(tag, payload, scope) {
  const reads = ["server.getConfig", "server.getSettings", "scheduledTasks.list"];
  const projects = [
    "projects.workspaceRead",
    "projects.environmentRead",
    "projects.connectionsRead",
    "projects.memoryRead",
    "projects.memoryWrite",
    "projects.planRead",
    "projects.planConfigure",
    "projects.usageRead",
  ];
  if (tag === "projects.createNew") {
    assert.equal(scope.personal, true);
    assert.equal(scope.providersDisabled, true);
    assert.deepEqual(payload, { name: "Tutorial Personal", kind: "personal" });
    return;
  }
  assert(
    reads.includes(tag) || projects.includes(tag) || tag === "scheduledTasks.upsert",
    "RPC outside tutorial allowlist",
  );
  if (projects.includes(tag) || tag === "scheduledTasks.upsert")
    assert(scope.projectIds.has(payload.projectId), "Foreign project refused");
  if (tag === "scheduledTasks.upsert") {
    assert(scope.routineIds.has(payload.id), "Foreign routine refused");
    assert.equal(payload.enabled, false, "Tutorial schedules must remain disabled");
  }
}
export function assertNativeUsage(usage, fixture) {
  assert(
    Number.isFinite(usage.totals?.totalTokens) && usage.totals.totalTokens > 0,
    "Native walkthrough requires recorded token usage",
  );
  for (const thread of [fixture.coordinator, ...fixture.workers]) {
    const row = usage.threads?.find((value) => value.threadId === thread.id);
    assert(
      row && Number.isFinite(row.totals?.totalTokens) && row.totals.totalTokens > 0,
      "Each demonstrated native thread needs its own recorded usage",
    );
  }
  assert(
    Array.isArray(usage.models) && usage.models.length >= 2,
    "Independent native models need a recorded breakdown",
  );
}
export function captionsVtt(beats) {
  const stamp = (seconds) => new Date(Math.round(seconds * 1000)).toISOString().slice(11, 23);
  let previous = 0;
  return (
    "WEBVTT\n\n" +
    beats
      .map((beat, index) => {
        assert(
          Number.isFinite(beat.start) &&
            Number.isFinite(beat.end) &&
            beat.start >= previous &&
            beat.end > beat.start,
        );
        assert(
          typeof beat.caption === "string" &&
            beat.caption.length <= 240 &&
            !/[<>\r\n]/.test(beat.caption),
        );
        previous = beat.end;
        return `${index + 1}\n${stamp(beat.start)} --> ${stamp(beat.end)}\n${beat.caption}\n`;
      })
      .join("\n")
  );
}
async function freePort() {
  await new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", () =>
      reject(new Error("Tutorial port8432 is occupied; existing owner preserved")),
    );
    probe.listen(8432, "127.0.0.1", () => probe.close(resolve));
  });
}
async function rpc(context, tag, payload, scope) {
  assertTutorialRpc(tag, payload, scope);
  const exchange = await context.request.post(ORIGIN + "/api/auth/websocket-ticket", {
    headers: { Origin: ORIGIN },
  });
  assert.equal(exchange.status(), 200);
  const { ticket } = await exchange.json();
  assert.equal(typeof ticket, "string");
  const url = new URL(ORIGIN);
  url.protocol = "ws:";
  url.pathname = "/ws";
  url.searchParams.set("wsTicket", ticket);
  url.searchParams.set("orchestrationProtocol", "2");
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    let settled = false;
    const end = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.close();
      fn(value);
    };
    const timer = setTimeout(
      () => end(reject, new Error("Tutorial RPC timed out; transport content omitted")),
      20000,
    );
    socket.addEventListener("open", () =>
      socket.send(JSON.stringify({ _tag: "Request", id: "1", tag, payload, headers: [] })),
    );
    socket.addEventListener("error", () => end(reject, new Error("Tutorial RPC transport failed")));
    socket.addEventListener("close", () => {
      if (!settled) end(reject, new Error("Tutorial RPC closed before acknowledgement"));
    });
    socket.addEventListener("message", ({ data }) => {
      let decoded;
      try {
        decoded = JSON.parse(data);
      } catch {
        return;
      }
      for (const item of Array.isArray(decoded) ? decoded : [decoded])
        if (item._tag === "Exit" && String(item.requestId) === "1") {
          if (item.exit?._tag === "Success") end(resolve, item.exit.value);
          else
            end(
              reject,
              new Error("Tutorial RPC rejected: " + (safeFailure(item.exit) ?? "unknown")),
            );
        }
    });
  });
}
async function startServer(entrypoint, stateDir, dataDir, context) {
  await freePort();
  const child = spawn(
    process.execPath,
    [
      entrypoint,
      "serve",
      "--host",
      "127.0.0.1",
      "--port",
      "8432",
      "--base-dir",
      dataDir,
      "--no-browser",
    ],
    {
      cwd: stateDir,
      env: captureEnvironment(path.join(stateDir, "home"), stateDir),
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  try {
    const credential = await new Promise((resolve, reject) => {
      let buffer = "",
        settled = false;
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        buffer = "";
        fn(value);
      };
      const timer = setTimeout(
        () => finish(reject, new Error("Private tutorial server startup timed out")),
        45000,
      );
      const inspect = (chunk) => {
        if (settled) return;
        buffer = (buffer + chunk.toString()).slice(-65536);
        const found = buffer.match(/(?:^|\n)Token: ([^\s]+)/);
        if (found) finish(resolve, found[1]);
      };
      child.stdout.on("data", inspect);
      child.stderr.on("data", inspect);
      child.once("error", () => finish(reject, new Error("Tutorial server spawn failed")));
      child.once("exit", () => finish(reject, new Error("Tutorial server exited before ready")));
    });
    const auth = await context.request.post(ORIGIN + "/api/auth/browser-session", {
      headers: { Origin: ORIGIN },
      data: { credential },
    });
    assert.equal(auth.status(), 200, "Private browser session exchange failed");
    return child;
  } catch (error) {
    await stopServer(child);
    throw error;
  }
}
async function stopServer(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  for (let i = 0; i < 50 && child.exitCode === null && child.signalCode === null; i++)
    await pause(100);
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  for (let i = 0; i < 30 && child.exitCode === null && child.signalCode === null; i++)
    await pause(100);
  assert(
    child.exitCode !== null || child.signalCode !== null,
    "Owned tutorial server did not exit",
  );
}
async function observedRoute(page, project) {
  await page.goto(ORIGIN, { waitUntil: "domcontentloaded" });
  for (let n = 0; n < 3; n++) {
    const next = page.getByRole("button", { name: "Continue", exact: true });
    if (await next.isVisible().catch(() => false)) await next.click();
    else break;
  }
  const skip = page.getByRole("button", { name: "Do not import projects", exact: true });
  if (await skip.isVisible().catch(() => false)) await skip.click();
  await page.locator('a[href*="/projects/"]').filter({ hasText: project.title }).first().click();
  await page.getByRole("region", { name: "Project coordinator", exact: true }).waitFor();
  const url = new URL(page.url());
  assert.equal(url.origin, ORIGIN);
  assert(url.pathname.startsWith("/projects/"));
  return url.href;
}
async function waitForRead(read, predicate) {
  for (let attempt = 0; attempt < 40; attempt++) {
    const value = await read().catch(() => null);
    if (value !== null && predicate(value)) return value;
    await pause(100);
  }
  throw new Error("Authoritative tutorial readback did not reach the expected state");
}

export async function capture(options) {
  assert.equal(process.versions.node, "22.20.0", "Use pinned Node22.20.0");
  process.env.PWDEBUG = "0";
  process.env.PLAYWRIGHT_HTML_OPEN = "never";
  assert(TUTORIALS.includes(options.tutorial));
  assert(
    /^[a-f0-9]{40}$/.test(options.sourceCommit),
    "Capture requires an exact expected source commit",
  );
  const root = fs.realpathSync(options.buildRoot),
    output = path.resolve(options.output);
  assert(!fs.existsSync(output), "Capture output must be fresh");
  assert(
    output.startsWith("/Volumes/"),
    "Capture media and private state must use external storage",
  );
  assert.equal(
    execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
    options.sourceCommit,
  );
  assert.equal(
    execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], {
      cwd: root,
      encoding: "utf8",
    }).trim(),
    "",
    "Build source must be clean",
  );
  const entrypoint = path.join(root, "apps/server/dist/bin.mjs"),
    buildSha256 = sha(fs.readFileSync(entrypoint));
  const version = sourceVersion(root);
  assert.equal(
    execFileSync(process.execPath, [entrypoint, "--version"], {
      cwd: root,
      encoding: "utf8",
      timeout: 30000,
    }).trim(),
    "specweave-studio v" + version,
  );
  if (options.acceptanceReceipt)
    assertAcceptance(
      readJson(options.acceptanceReceipt),
      options.sourceCommit,
      buildSha256,
      version,
    );
  const native = options.nativeFixture
    ? assertNativeFixture(readJson(options.nativeFixture), options.sourceCommit)
    : null;
  if (options.tutorial === "personal-and-connections") {
    assert(
      options.acceptanceReceipt,
      "Personal walkthrough requires current application acceptance",
    );
    assert.equal(native, null, "Personal walkthrough requires its own fresh synthetic store");
  }
  if (options.tutorial === "projects-and-threads")
    assert(
      native && options.acceptanceReceipt,
      "Mixed-provider capture requires transferred native fixture and current acceptance",
    );
  fs.mkdirSync(output, { recursive: true, mode: 0o700 });
  fs.chmodSync(output, 0o700);
  const stateDir = native ? fs.realpathSync(native.stateDir) : path.join(output, "private-state");
  if (native) {
    assertInside(path.dirname(options.nativeFixture), stateDir);
    assert.equal(
      readJson(path.join(stateDir, "tutorial-owner.json")).nativeReceiptSha256,
      native.nativeReceiptSha256,
    );
    for (const project of native.projects)
      assertInside(path.dirname(options.nativeFixture), project.dir);
  } else fs.mkdirSync(stateDir, { mode: 0o700 });
  const dataDir = path.join(stateDir, "studio");
  fs.mkdirSync(path.join(stateDir, "home"), { recursive: true, mode: 0o700 });
  const projects =
    native?.projects ??
    ["Atlas", "Other", "Disposable"].map((name) => ({
      id: randomUUID(),
      title: `Tutorial ${name}`,
      dir: path.join(stateDir, name.toLowerCase()),
    }));
  if (!native) {
    fs.mkdirSync(path.join(dataDir, "userdata"), { recursive: true, mode: 0o700 });
    writeJson(path.join(dataDir, "userdata/settings.json"), {
      providers: Object.fromEntries(names.map((name) => [name, { enabled: false }])),
      providerInstances: Object.fromEntries(
        [...names, "claude-agent", "opencode2"].map((name) => [
          name,
          { driver: name, enabled: false, config: {} },
        ]),
      ),
      cursorKeychainUsageEnabled: false,
    });
    for (const project of projects) {
      fs.mkdirSync(project.dir, { mode: 0o700 });
      fs.writeFileSync(
        path.join(project.dir, "README.md"),
        "Synthetic tutorial workspace. No personal data.\n",
      );
    }
  }
  const scope = {
    projectIds: new Set(projects.map((p) => p.id)),
    routineIds: new Set(),
    personal: options.tutorial === "personal-and-connections",
    providersDisabled: false,
  };
  const receipt = {
    schemaVersion: 1,
    tutorial: options.tutorial,
    version,
    sourceCommit: options.sourceCommit,
    buildSha256,
    recordedAt: new Date().toISOString(),
    actualApplication: true,
    syntheticDataOnly: true,
    headless: true,
    acceptancePassed: Boolean(options.acceptanceReceipt),
    privacyReviewed: false,
    visualReviewPassed: false,
    captionsReviewed: false,
    nativeProviders: native?.nativeProviders ?? { claude: "not_recorded", codex: "not_recorded" },
    ...(native ? nativeProofScope(native) : {}),
    providerTurnsStartedByRecorder: 0,
    status: "capturing",
    beats: [],
    video: null,
    captions: null,
  };
  const save = () => writeJson(path.join(output, "capture.json"), receipt);
  let browser, authContext, recordContext, recordPage, child;
  const deadline = setTimeout(() => {
    void browser?.close().catch(() => {});
    if (child && child.exitCode === null) child.kill("SIGTERM");
  }, 300000);
  deadline.unref();
  const terminate = () => {
    if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  };
  process.once("SIGINT", terminate);
  process.once("SIGTERM", terminate);
  try {
    const executablePath = fs.realpathSync(options.browserExecutable);
    assert(fs.statSync(executablePath).isFile());
    fs.accessSync(executablePath, fs.constants.X_OK);
    const { chromium } = createRequire(import.meta.url)(
      path.join(fs.realpathSync(options.browserDeps), "playwright"),
    );
    browser = await chromium.launch({ headless: true, executablePath });
    authContext = await browser.newContext({
      viewport: { width: 1920, height: 1080 },
      reducedMotion: "reduce",
    });
    child = await startServer(entrypoint, stateDir, dataDir, authContext);
    const required = (tag, payload = {}) => rpc(authContext, tag, payload, scope);
    const config = await required("server.getConfig"),
      settings = await required("server.getSettings");
    assert(
      config.providers.every((provider) => provider.enabled === false),
      "Recorder cannot capture with active providers",
    );
    assert(Object.values(settings.providers).every((provider) => provider.enabled === false));
    assert(
      Object.values(settings.providerInstances).every((provider) => provider.enabled === false),
    );
    assert.equal(settings.cursorKeychainUsageEnabled, false);
    const mutate = async (project, type, fields = {}) => {
      assert(scope.projectIds.has(project.id));
      assert(["project.create", "project.update"].includes(type));
      const response = await authContext.request.post(ORIGIN + "/api/projects/mutate", {
        headers: { Origin: ORIGIN },
        data: { ...fields, type, projectId: project.id, commandId: randomUUID() },
      });
      assert.equal(response.status(), 200);
      return response.json();
    };
    scope.providersDisabled = true;
    if (!native) {
      if (scope.personal) {
        const created = await required("projects.createNew", {
          name: "Tutorial Personal",
          kind: "personal",
        });
        assertInside(stateDir, created.workspaceRoot);
        scope.projectIds.delete(projects[0].id);
        projects[0] = {
          id: created.projectId,
          title: "Tutorial Personal",
          dir: created.workspaceRoot,
        };
        scope.projectIds.add(created.projectId);
      }
      for (const project of projects.slice(scope.personal ? 1 : 0))
        await mutate(project, "project.create", {
          title: project.title,
          workspaceRoot: project.dir,
        });
    }
    const listing = await authContext.request.get(ORIGIN + "/api/projects");
    assert.equal(listing.status(), 200);
    assert.deepEqual(
      new Set((await listing.json()).projects.map((p) => p.id)),
      scope.projectIds,
      "Capture store contains unapproved projects",
    );
    const [atlas, other, disposable] = projects;
    const personalFixture = scope.personal ? createPersonalFixture(atlas, stateDir) : null;
    if (native)
      assert.equal(
        (await required("projects.workspaceRead", { projectId: atlas.id })).settings
          .coordinatorThreadId,
        native.coordinator.id,
        "Native coordinator identity must match the transferred project",
      );
    if (!native)
      await required("projects.memoryWrite", {
        projectId: atlas.id,
        name: "MEMORY.md",
        content: "Atlas is a synthetic project. Keep decisions concise and evidence linked.",
        expectedRevision: null,
      });
    if (options.tutorial === "plans-and-routines") {
      const increment = path.join(other.dir, ".specweave/increments/0888-example");
      fs.mkdirSync(increment, { recursive: true });
      fs.writeFileSync(
        path.join(increment, "spec.md"),
        "# Existing example plan\n## Tasks\n### T-01 Review the synthetic note\n- AC: AC-01 | Files: README.md | Test: node --version\n",
      );
      fs.writeFileSync(
        path.join(increment, "ledger.jsonl"),
        JSON.stringify({
          t: "T-01",
          e: "done",
          by: "example-owner",
          at: "2026-10-09T00:00:00.000Z",
          evidence: "Synthetic example of an external owner's report; not independently verified.",
        }) + "\n",
      );
      await required("projects.planConfigure", {
        projectId: other.id,
        expectedRevision: 0,
        authority: { kind: "specweave", root: other.dir, incrementId: "0888-example" },
        discardNative: false,
      });
    }
    const setupPage = await authContext.newPage();
    setupPage.setDefaultTimeout(15000);
    const routes = new Map();
    for (const project of projects) routes.set(project.id, await observedRoute(setupPage, project));
    await setupPage.close();
    recordContext = await browser.newContext({
      viewport: { width: 1920, height: 1080 },
      colorScheme: "light",
      reducedMotion: "reduce",
      recordVideo: { dir: path.join(output, "private-raw"), size: { width: 1920, height: 1080 } },
    });
    await recordContext.addCookies(await authContext.cookies()); // Memory only; no storage-state file.
    const page = await recordContext.newPage();
    recordPage = page;
    page.setDefaultTimeout(15000);
    let pageErrors = 0;
    page.on("pageerror", () => pageErrors++);
    const started = performance.now(),
      video = page.video();
    const open = async (project) => {
      await page.goto(routes.get(project.id), { waitUntil: "domcontentloaded" });
      await page.getByRole("region", { name: "Project coordinator", exact: true }).waitFor();
    };
    const beat = async (id, caption, action, seconds = 7) => {
      receipt.activeBeat = id;
      save();
      const start = (performance.now() - started) / 1000;
      await action();
      await pause(seconds * 1000);
      fs.mkdirSync(path.join(output, "private-review"), { recursive: true, mode: 0o700 });
      await page.screenshot({ path: path.join(output, "private-review", id + ".png") });
      const end = (performance.now() - started) / 1000;
      receipt.beats.push({ id, caption, start, end, verified: true });
      save();
      assert(end < 175, "Tutorial exceeds its bounded recording duration");
    };
    const button = (container, name) => container.getByRole("button", { name, exact: true });
    const dialog = () => page.getByRole("dialog");
    const section = async (name) =>
      button(dialog().getByRole("navigation", { name: "Project settings sections" }), name).click();
    if (options.tutorial === "memory-and-usage") {
      await beat("project", "Keep the project goal, instructions and durable facts together.", () =>
        open(atlas),
      );
      await beat(
        "instructions",
        "Instructions guide future turns. They do not replace a provider's native history.",
        async () => {
          await button(page, "Project settings").click();
          await section("Memory");
          const instructions =
            "Use synthetic data. Keep decisions concise and link each conclusion to evidence.";
          await dialog().getByLabel("Project instructions").fill(instructions);
          await button(dialog(), "Save changes").click();
          await waitForRead(
            () => required("projects.workspaceRead", { projectId: atlas.id }),
            (x) => x.settings.instructions === instructions,
          );
        },
      );
      await beat(
        "memory",
        "Memory belongs to this project. Open a file to review its contents.",
        async () => {
          await section("Memory");
          await dialog()
            .getByRole("button", { name: /^MEMORY\.md\s/ })
            .click();
        },
      );
      await beat("new-file", "Give a lasting decision its own small Markdown file.", async () => {
        await dialog().getByLabel("New memory filename").fill("architecture.md");
        await button(dialog(), "New file").click();
      });
      const content =
        "Decision: keep tutorial data synthetic. Evidence: this recorded save and reload.";
      await beat(
        "save",
        "Save the decision. Studio checks the file revision before replacing it.",
        async () => {
          await dialog().getByLabel("Content of architecture.md").fill(content);
          await button(dialog(), "Save memory").click();
          await waitForRead(
            () => required("projects.memoryRead", { projectId: atlas.id, name: "architecture.md" }),
            (x) => x.content === content,
          );
        },
      );
      await beat(
        "reload",
        "Reload and reopen the file to confirm that the decision persisted.",
        async () => {
          await page.reload();
          await button(page, "Project settings").click();
          await section("Memory");
          await dialog()
            .getByRole("button", { name: /^architecture\.md\s/ })
            .click();
          const editor = dialog().getByLabel("Content of architecture.md");
          await waitForRead(
            () => editor.inputValue(),
            (value) => value === content,
          );
          await editor.scrollIntoViewIfNeeded();
        },
      );
      await beat(
        "isolation",
        "A different project keeps a different memory collection.",
        async () => {
          await open(other);
          await button(page, "Project settings").click();
          await section("Memory");
          assert.equal(
            (await required("projects.workspaceRead", { projectId: other.id })).memory.files.length,
            0,
          );
        },
      );
      await beat(
        "usage",
        "Usage comes from recorded provider turns. Missing data remains visible.",
        async () => {
          await open(atlas);
          await button(page, "Usage").click();
          const usage = await required("projects.usageRead", { projectId: atlas.id });
          assert.equal(usage.cacheReadRatio, null);
          assert.equal(usage.totals.equivalentCostUsd, null);
        },
      );
      await beat(
        "honest-cost",
        "No provider turn ran in this walkthrough. An equivalent cost estimate is not a bill.",
        async () => {},
        8,
      );
    } else if (options.tutorial === "plans-and-routines") {
      await beat(
        "optional",
        "Add a plan when acceptance needs evidence. Ordinary chat does not require the CLI.",
        async () => {
          await open(atlas);
          await button(page, "Plan").click();
        },
      );
      await beat(
        "definition",
        "Write a short spec, one acceptance criterion and a task.",
        async () => {
          await button(dialog(), "Add a plan").click();
          await dialog()
            .getByLabel("Plan spec")
            .fill("Confirm the synthetic release note is ready.");
          await button(dialog(), "Add criterion").click();
          await dialog()
            .getByLabel("AC-1 criterion")
            .fill("The local readiness check exits successfully.");
          await button(dialog(), "Add task").click();
          await dialog().getByLabel("T-1 title").fill("Check the release note");
          await dialog().getByRole("checkbox", { name: "AC-1", exact: true }).check();
        },
      );
      const check =
        "const fs=require('node:fs');const ok=fs.existsSync('ready.txt');console.log(ok?'Ready: local check passed':'Not ready: add ready.txt');process.exit(ok?0:1)";
      await beat(
        "command",
        "Review the executable and literal arguments. Saving the command does not run it.",
        async () => {
          await dialog()
            .getByRole("checkbox", { name: "Save a verification command", exact: true })
            .check();
          await dialog().getByLabel("T-1 executable").fill("node");
          await dialog()
            .getByLabel("T-1 arguments")
            .fill("-e\n" + check);
          await button(dialog(), "Save plan").click();
          const plan = await waitForRead(
            () => required("projects.planRead", { projectId: atlas.id }),
            (x) => x.native.tasks.length === 1,
          );
          assert.equal(plan.native.tasks[0].evidence.length, 0);
          await dialog()
            .locator("summary")
            .filter({ hasText: "Verification command and evidence" })
            .click();
          await button(dialog(), "Run verification").scrollIntoViewIfNeeded();
        },
      );
      await beat(
        "failed",
        "Verification runs a real local process. A nonzero exit remains failed.",
        async () => {
          await button(dialog(), "Run verification").click();
          await waitForRead(
            () => required("projects.planRead", { projectId: atlas.id }),
            (x) => x.native.tasks[0].evidence.at(-1)?.outcome === "failed",
          );
          await dialog()
            .getByText("Not ready: add ready.txt", { exact: true })
            .scrollIntoViewIfNeeded();
        },
      );
      await beat(
        "repair",
        "We now create ready.txt in the synthetic source folder. The previous failed receipt stays unchanged.",
        async () => {
          fs.writeFileSync(path.join(atlas.dir, "ready.txt"), "ready\n");
        },
      );
      await beat(
        "passed",
        "Choose a new attempt deliberately. The new receipt records the successful exit.",
        async () => {
          await button(dialog(), "New verification attempt").click();
          await waitForRead(
            () => required("projects.planRead", { projectId: atlas.id }),
            (x) => x.native.tasks[0].status === "verified",
          );
          await dialog()
            .getByText("Ready: local check passed", { exact: true })
            .scrollIntoViewIfNeeded();
        },
      );
      await beat(
        "recheck",
        "Recheck reads the same receipt. It cannot launch that verification again.",
        async () => {
          await button(dialog(), "Recheck last request").click();
          const saved = await required("projects.planRead", { projectId: atlas.id });
          assert.equal(saved.native.tasks[0].evidence.length, 2);
          await dialog()
            .getByText("Ready: local check passed", { exact: true })
            .scrollIntoViewIfNeeded();
        },
      );
      await beat(
        "external-authority",
        "An existing SpecWeave ledger stays authoritative. Its done entry remains external, unverified evidence.",
        async () => {
          await open(other);
          await button(page, "Plan").click();
          await dialog().getByText("External, unverified", { exact: false }).first().waitFor();
          const plan = await required("projects.planRead", { projectId: other.id });
          assert.equal(plan.authority.kind, "specweave");
          assert.equal(plan.external.readOnly, true);
        },
      );
      const routineId = randomUUID();
      scope.routineIds.add(routineId);
      await required("scheduledTasks.upsert", {
        id: routineId,
        projectId: atlas.id,
        title: "Daily project review",
        prompt: "Synthetic demonstration only",
        enabled: false,
        schedule: { type: "interval", everyMs: 86400000 },
        workspaceStrategy: { type: "root" },
        modelSelection: { instanceId: "codex", model: "synthetic-unavailable" },
        runtimeMode: "full-access",
        interactionMode: "default",
      });
      await beat(
        "routines",
        "Routines keep their project and host scope. This demonstration routine is disabled.",
        async () => {
          await open(atlas);
          await button(page, "Project settings").click();
          await section("Routines");
        },
      );
      await beat(
        "pause",
        "Pause the project to refuse new work. It does not kill an already running turn.",
        async () => {
          await section("General");
          await button(dialog(), "Pause").click();
          await waitForRead(
            () => required("projects.workspaceRead", { projectId: atlas.id }),
            (x) => x.settings.paused,
          );
        },
      );
      await beat(
        "guard",
        "New routine runs remain blocked while the project is paused.",
        async () => {
          await section("Routines");
          assert.equal(await button(dialog(), "Run now").isEnabled(), false);
          assert.equal(
            (await required("scheduledTasks.list")).tasks.find((x) => x.id === routineId).runCount,
            0,
          );
        },
      );
      await beat(
        "delete-confirmation",
        "Deletion requires the exact project name. This is a disposable synthetic project.",
        async () => {
          await open(disposable);
          await button(page, "Project settings").click();
          await dialog().getByLabel("Confirm project deletion").fill("wrong title");
          assert.equal(await button(dialog(), "Delete project and threads").isEnabled(), false);
          await dialog().getByLabel("Confirm project deletion").fill(disposable.title);
          await button(dialog(), "Delete project and threads").scrollIntoViewIfNeeded();
        },
      );
      await beat(
        "delete-result",
        "Deleting project history leaves its source folder intact.",
        async () => {
          await button(dialog(), "Delete project and threads").click();
          await waitForRead(
            async () => (await authContext.request.get(ORIGIN + "/api/projects")).json(),
            (x) => !x.projects.some((p) => p.id === disposable.id),
          );
          assert(fs.existsSync(path.join(disposable.dir, "README.md")));
        },
      );
    } else if (scope.personal) {
      receipt.personalEnvironmentProof = await capturePersonalEnvironment({
        project: atlas,
        fixture: personalFixture,
        open,
        page,
        beat,
        button,
        dialog,
        section,
        required,
        waitForRead,
      });
    } else {
      await beat("project", NATIVE_PROOF_CAPTION, () => open(atlas), 9);
      await beat(
        "defaults",
        "Coordinator and worker defaults are independent. Existing threads retain their own model choices.",
        async () => {
          await button(page, "Project settings").click();
        },
        9,
      );
      await page.keyboard.press("Escape");
      await beat(
        "coordinator",
        `This ${native.coordinator.provider === "claude" ? "Claude" : "Codex"} coordinator completed the verified native run. Its conversation stays in the project.`,
        async () => {
          await page.getByRole("region", { name: "Project coordinator", exact: true }).waitFor();
        },
        12,
      );
      for (const worker of native.workers) {
        await beat(
          worker.provider,
          `This ${worker.provider === "claude" ? "Claude" : "Codex"} conversation completed in the verified native run. No new inference starts in this recording.`,
          async () => {
            await page
              .locator("article.project-thread-card")
              .filter({ hasText: worker.title })
              .locator("button.sws-thread-open")
              .click();
            await page
              .getByRole("complementary", { name: "Thread " + worker.title, exact: true })
              .waitFor();
          },
          12,
        );
        await button(page, "Back to project threads").click();
      }
      await beat(
        "routing",
        "The coordinator keeps the routing history while worker details open on the right.",
        async () => {
          assert(
            await page
              .getByRole("region", { name: "Project coordinator", exact: true })
              .isVisible(),
          );
        },
        10,
      );
      const card = page
        .locator("article.project-thread-card")
        .filter({ hasText: native.workers[0].title });
      await beat(
        "resolve",
        "Resolve organizes finished work without deleting its history.",
        async () => {
          await button(card, "Resolve").click();
          await button(card, "Reopen").waitFor();
        },
        8,
      );
      await beat(
        "reopen",
        "Reopen the same thread when related work returns.",
        async () => {
          await button(card, "Reopen").click();
          await button(card, "Resolve").waitFor();
        },
        8,
      );
      await beat(
        "usage",
        "Open Usage to compare the actual coordinator and worker token totals by model.",
        async () => {
          await button(page, "Usage").click();
          assertNativeUsage(await required("projects.usageRead", { projectId: atlas.id }), native);
          await dialog()
            .getByRole("table", { name: "Token breakdown by model" })
            .scrollIntoViewIfNeeded();
        },
        10,
      );
      await beat(
        "usage-threads",
        "Thread shares explain where tokens went. Cache reporting can be incomplete, and API-equivalent cost is not money paid.",
        async () => {
          await dialog()
            .getByRole("button", { name: native.workers[0].title, exact: true })
            .scrollIntoViewIfNeeded();
        },
        10,
      );
    }
    assert.equal(pageErrors, 0, "Browser raised an application error");
    await page.screenshot({ path: path.join(output, "last-frame.png") });
    await recordContext.close();
    recordContext = null;
    const videoPath = await video.path();
    assertInside(output, videoPath);
    const finalPath = path.join(output, "capture.webm");
    fs.renameSync(videoPath, finalPath);
    const captions = captionsVtt(receipt.beats);
    fs.writeFileSync(path.join(output, "captions.vtt"), captions);
    receipt.video = { file: "capture.webm", sha256: sha(fs.readFileSync(finalPath)) };
    receipt.captions = { file: "captions.vtt", sha256: sha(captions) };
    receipt.status = "captured-awaiting-review";
    save();
    console.log(
      JSON.stringify({
        tutorial: options.tutorial,
        status: receipt.status,
        acceptancePassed: receipt.acceptancePassed,
        output,
      }),
    );
  } catch (error) {
    receipt.status = "failed";
    receipt.failure = { type: error?.name ?? "Error" };
    save();
    if (recordPage && !recordPage.isClosed())
      await recordPage
        .screenshot({ path: path.join(output, "private-failure.png") })
        .catch(() => {});
    throw new Error(
      "Tutorial capture failed; inspect the synthetic state and last verified beat. Private error content omitted.",
    );
  } finally {
    clearTimeout(deadline);
    if (recordContext) await recordContext.close().catch(() => {});
    if (authContext) await authContext.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
    await stopServer(child);
    process.removeListener("SIGINT", terminate);
    process.removeListener("SIGTERM", terminate);
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === ownPath) {
  const args = process.argv.slice(2);
  if (args.includes("--help"))
    console.log(
      "tutorial-capture.mjs --tutorial ID --build-root CLEAN_SOURCE --source-commit SHA --output NEW_EXTERNAL_DIR --browser-deps NODE_MODULES --browser-executable FILE [--acceptance-receipt JSON] [--native-fixture JSON]\nOwns only port8432 and synthetic state. No inference, no visible browser, no publication. Without acceptance proof output is rehearsal only.",
    );
  else {
    const options = {},
      keys = {
        "--tutorial": "tutorial",
        "--build-root": "buildRoot",
        "--source-commit": "sourceCommit",
        "--output": "output",
        "--browser-deps": "browserDeps",
        "--browser-executable": "browserExecutable",
        "--acceptance-receipt": "acceptanceReceipt",
        "--native-fixture": "nativeFixture",
      };
    for (let i = 0; i < args.length; i += 2) {
      assert(
        keys[args[i]] && args[i + 1] && !args[i + 1].startsWith("--"),
        "Unknown/incomplete recorder option",
      );
      options[keys[args[i]]] = args[i + 1];
    }
    for (const key of [
      "tutorial",
      "buildRoot",
      "sourceCommit",
      "output",
      "browserDeps",
      "browserExecutable",
    ])
      assert(options[key], "Missing recorder option: " + key);
    await capture(options);
  }
}
