#!/usr/bin/env node
// Bounded, opt-in native proof. Default inspection and smoke never enable providers.
import assert from "node:assert/strict";
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  accessSync,
  chmodSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import net from "node:net";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ACTIVE_RUNS,
  MAX_NATIVE_RUNS,
  NATIVE_ORIGIN,
  createNativeScope,
  nativeRpc,
  observeProjection,
  userDispatchReceipt,
} from "./native-rpc.mjs";
import { nativeRouteMetadata } from "../studio-verify/native-proof.mjs";
import { sourceVersion } from "./version.mjs";
import {
  hydrateApprovedToolOutputs,
  readOwnedToolItem,
  toolDetailFailureReason,
} from "./native-tool-detail.mjs";
import {
  APPROVAL_PLAN,
  WORKER_TASK,
  approvalFailureReason,
  approvalObservationReady,
  approvalReceipt,
  completionReceipt,
  completionResultReceipt,
  armSelectedWorker,
  delegateInput,
  enableApprovalPolicy,
  inspectApprovals,
  reserveApproval,
} from "./native-approval.mjs";

const ownPath = fileURLToPath(import.meta.url);

/**
 * Whether text links the thread: the coordinator copies the server's `threadLink`,
 * whose segment is the ID encoded once, but a pasted raw ID opens it too
 * (packages/shared/src/studioThreadLinks.ts reads both forms).
 */
export function linksThread(text, threadId) {
  return [...text.matchAll(/studio:\/\/thread\/([^)\s]+)/g)].some(([, segment]) => {
    if (segment === threadId) return true;
    try {
      return decodeURIComponent(segment) === threadId;
    } catch {
      return false;
    }
  });
}
const toolingRoot = resolve(dirname(ownPath), "../..");
const hash = (value) => createHash("sha256").update(value).digest("hex");
const pause = (ms) => new Promise((done) => setTimeout(done, ms));
const sha = /^[a-f0-9]{64}$/;
const drivers = [
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
export function parseOptions(args) {
  const allowed = new Set([
    "--mode",
    "--review",
    "--report-dir",
    "--browser-deps",
    "--browser-executable",
    "--runtime-root",
  ]);
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    assert.ok(
      allowed.has(args[i]) && args[i + 1] && !args[i + 1].startsWith("--"),
      "Unknown or incomplete option",
    );
    assert.equal(options[args[i]], undefined, "Duplicate option refused");
    options[args[i]] = args[i + 1];
  }
  options["--mode"] ??= "inspect";
  assert.ok(["inspect", "smoke", "execute"].includes(options["--mode"]), "Unknown mode");
  assert.equal(
    Boolean(options["--review"]),
    options["--mode"] === "execute",
    "Only execute accepts and requires a reviewed receipt",
  );
  if (options["--runtime-root"])
    assert.ok(isAbsolute(options["--runtime-root"]), "Runtime root must be absolute");
  return options;
}
export function resolveRuntimeRoot(value = toolingRoot) {
  assert.ok(isAbsolute(value), "Runtime root must be absolute");
  const root = realpathSync(value);
  assert.ok(statSync(root).isDirectory(), "Runtime root must be an existing directory");
  const gitRoot = execFileSync("/usr/bin/git", ["rev-parse", "--show-toplevel"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  assert.equal(realpathSync(gitRoot), root, "Runtime root must be the Git checkout root");
  return root;
}
export function toolingIdentity() {
  const files = [
    "scripts/studio-projects/native-acceptance.mjs",
    "scripts/studio-projects/native-rpc.mjs",
    "scripts/studio-projects/native-approval.mjs",
    "scripts/studio-projects/native-tool-detail.mjs",
    "scripts/studio-projects/rpc.mjs",
    "scripts/studio-projects/version.mjs",
    "scripts/studio-verify/native-proof.mjs",
  ].map((path) => ({ path, sha256: hash(readFileSync(join(toolingRoot, path))) }));
  return {
    root: toolingRoot,
    sourceCommit: execFileSync("/usr/bin/git", ["rev-parse", "HEAD"], {
      cwd: toolingRoot,
      encoding: "utf8",
    }).trim(),
    sourceDirty: Boolean(
      execFileSync("/usr/bin/git", ["status", "--porcelain", "--untracked-files=no"], {
        cwd: toolingRoot,
        encoding: "utf8",
      }).trim(),
    ),
    entrypointSha256: hash(readFileSync(ownPath)),
    files,
    sha256: hash(JSON.stringify(files)),
  };
}
/** Follow only the rendered link for this owned project, after bounded onboarding. */
export async function openOwnedProject(page, project) {
  await page.goto(NATIVE_ORIGIN, { waitUntil: "domcontentloaded" });
  const link = page.locator('a[href*="/projects/"]').filter({ hasText: project.title }).first();
  const next = page.getByRole("button", { name: "Continue", exact: true });
  const skip = page.getByRole("button", { name: "Do not import projects", exact: true });
  let continues = 0,
    skipped = false;
  for (let step = 0; step < 5; step++) {
    // DOMContentLoaded precedes React hydration. Wait for a real control before choosing it.
    await Promise.any(
      [link, next, skip].map((control) => control.waitFor({ state: "visible", timeout: 30000 })),
    );
    if (await next.isVisible()) {
      assert.ok(continues < 3, "Unexpected extra onboarding step");
      continues++;
      await next.click();
      continue;
    }
    if (await skip.isVisible()) {
      assert.equal(skipped, false, "Repeated import prompt refused");
      skipped = true;
      await skip.click();
      continue;
    }
    break;
  }
  await link.waitFor({ state: "visible", timeout: 30000 });
  const href = await link.getAttribute("href");
  assert.ok(href, "Owned project link has no destination");
  const target = new URL(href, NATIVE_ORIGIN);
  assert.equal(target.origin, NATIVE_ORIGIN, "Project link left the owned origin");
  // The route uses the logical folder/repository group key, not necessarily its UUID.
  assert.ok(target.pathname.startsWith("/projects/"), "Rendered link is not a project route");
  await link.click();
  await page
    .getByRole("region", { name: "Project coordinator", exact: true })
    .waitFor({ state: "visible", timeout: 30000 });
  await page
    .getByRole("heading", { name: project.title, exact: true })
    .waitFor({ state: "visible", timeout: 30000 });
  assert.equal(
    new URL(page.url()).href,
    target.href,
    "Browser did not open the observed project link",
  );
  return { url: target.href, continues, skippedImport: skipped };
}
export function nativeEnvironment(source, fakeHome, execute) {
  const env = {
    HOME: execute ? source.HOME : fakeHome,
    USER: execute ? source.USER : "studio-native-smoke",
    LOGNAME: execute ? source.LOGNAME : "studio-native-smoke",
    PATH: dirname(process.execPath) + ":/usr/bin:/bin",
    LANG: "en_US.UTF-8",
    TMPDIR: source.TMPDIR ?? tmpdir(),
    STUDIO_AUTO_BOOTSTRAP_PROJECT_FROM_CWD: "false",
    PWDEBUG: "0",
    PLAYWRIGHT_HTML_OPEN: "never",
  };
  // Preserve the caller's active native homes only; no arbitrary home/account flags exist.
  if (execute)
    for (const key of ["CODEX_HOME", "CLAUDE_CONFIG_DIR"]) if (source[key]) env[key] = source[key];
  assert.ok(env.HOME && isAbsolute(env.HOME), "Existing HOME required");
  return env;
}
function keys(value, expected) {
  assert.deepEqual(
    Object.keys(value).sort(),
    [...expected].sort(),
    "Unreviewed configuration fields refused",
  );
}
export function validateReview(review, observed, now = Date.now()) {
  keys(review, [
    "schemaVersion",
    "authorization",
    "expiresAt",
    "sourceCommit",
    "buildSha256",
    "toolingSha256",
    "approvalPlan",
    "maxRuns",
    "codex",
    "claude",
  ]);
  assert.equal(review.schemaVersion, 2);
  assert.equal(review.authorization, "six-native-project-runs-with-exact-single-use-approvals");
  assert.deepEqual(review.approvalPlan, APPROVAL_PLAN, "Reviewed approval plan differs");
  assert.match(review.toolingSha256, sha);
  assert.equal(review.toolingSha256, observed.tooling?.sha256, "Reviewed tooling differs");
  assert.ok(
    [4, 5, MAX_NATIVE_RUNS].includes(review.maxRuns),
    "Reviewed native run limit must be exactly 4, 5 or 6",
  );
  const expiry = Date.parse(review.expiresAt);
  assert.ok(
    Number.isFinite(expiry) && expiry > now && expiry <= now + 3_600_000,
    "Review must expire within one hour",
  );
  assert.match(review.sourceCommit, /^[a-f0-9]{40}$/);
  assert.match(review.buildSha256, sha);
  assert.equal(review.sourceCommit, observed.sourceCommit, "Reviewed source differs");
  assert.equal(review.buildSha256, observed.buildSha256, "Reviewed build differs");
  assert.equal(observed.sourceDirty, false, "Tracked source must be clean");
  for (const name of ["codex", "claude"]) {
    keys(review[name], ["binaryPath", "binarySha256", "version", "model"]);
    assert.ok(isAbsolute(review[name].binaryPath), "Absolute verified native binary required");
    assert.match(review[name].binarySha256, sha);
    assert.match(review[name].version, /^\d+\.\d+\.\d+(?:[-.][a-zA-Z0-9.-]+)?$/);
    assert.match(review[name].model, /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,120}$/);
  }
  return review;
}
export function providerSettings(review) {
  const execute = Boolean(review);
  const providers = Object.fromEntries(
    drivers
      .filter((d) => !["claude-agent", "opencode2"].includes(d))
      .map((driver) => [driver, { enabled: false }]),
  );
  const providerInstances = Object.fromEntries(
    drivers.map((driver) => [driver, { driver, enabled: false, config: {} }]),
  );
  if (execute) {
    providerInstances.codex = {
      driver: "codex",
      enabled: true,
      config: { setupMode: "existing", binaryPath: review.codex.binaryPath },
    };
    providerInstances.claudeAgent = {
      driver: "claudeAgent",
      enabled: true,
      config: {
        binaryPath: review.claude.binaryPath,
        // Excludes unrelated user's project settings/hooks/MCP, preserving native login.
        launchArgs: "--setting-sources project",
      },
    };
    providers.codex = { enabled: true, binaryPath: review.codex.binaryPath };
    providers.claudeAgent = {
      enabled: true,
      binaryPath: review.claude.binaryPath,
      launchArgs: "--setting-sources project",
    };
  }
  return {
    providers,
    providerInstances,
    cursorKeychainUsageEnabled: false,
    defaultRuntimeMode: "approval-required",
  };
}
export function catalogReceipt(config, review) {
  const permitted = review ? new Set(["codex", "claudeAgent"]) : new Set();
  assert.ok(
    config.providers.every((p) => !p.enabled || permitted.has(p.instanceId)),
    "Unreviewed provider enabled",
  );
  if (!review) return [];
  return [
    ["codex", "codex"],
    ["claude", "claudeAgent"],
  ].map(([name, instanceId]) => {
    const p = config.providers.find((provider) => provider.instanceId === instanceId);
    const authenticated = p?.auth?.status === "authenticated";
    const ready = p?.status === "ready" && p?.availability !== "unavailable";
    return {
      instanceId,
      requestedModel: review[name].model,
      authenticated,
      ready,
      available: Boolean(
        p?.enabled &&
        p?.installed &&
        authenticated &&
        ready &&
        p.models.some((m) => m.slug === review[name].model),
      ),
    };
  });
}
export function buildFingerprint(directory) {
  const entries = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name),
        stat = lstatSync(path);
      assert.ok(!stat.isSymbolicLink(), "Build symlink refused");
      if (stat.isDirectory()) walk(path);
      else if (stat.isFile())
        entries.push([relative(directory, path), stat.size, hash(readFileSync(path))]);
      else assert.fail("Build special file refused");
    }
  };
  walk(directory);
  assert.ok(entries.length > 0, "Empty build");
  return { sha256: hash(JSON.stringify(entries)), files: entries.length };
}
export function cyclePrompts(
  workerModel,
  followupId,
  selectedWorkerId = "<selected worker ID>",
  maxRuns = MAX_NATIVE_RUNS,
) {
  assert.ok(
    [4, 5, MAX_NATIVE_RUNS].includes(maxRuns),
    "Reviewed native run limit must be exactly 4, 5 or 6",
  );
  const workerTask = WORKER_TASK;
  return {
    first: `This is a bounded synthetic coordination test, not development work. Use only Studio orchestration tools. Discover capabilities, then delegate exactly one task with delegate_task: mode async, title Native marker worker, role test, target providerInstanceId claudeAgent, model ${workerModel}, runtimeMode approval-required, and clientRequestId native-proof-initial. Use exactly this input, with no extra fields: ${JSON.stringify(delegateInput(workerModel))}. Do not include the actual marker values in the task prompt. End this turn after delegation. When the completion notification arrives, do not rediscover capabilities; call task_status exactly once with only {"taskId":"<the exact taskId returned by delegate_task>"}, replacing only that placeholder; report its result with a clickable worker link and stop. Do not poll, schedule, create another task, or use shell/browser/filesystem/native subagents. At most ${maxRuns} app runs are authorized for the whole test.`,
    second: `Continue the selected worker's simple marker check, not a new delegated review round. Its current project memory changed. Reuse exactly this selected thread through studio_thread_send with mode auto and clientRequestId ${followupId}, using exactly ${JSON.stringify({ threadId: selectedWorkerId, message: workerTask, mode: "auto", clientRequestId: followupId })}. Do not include actual marker values. Wait once with studio_thread_wait for that exact returned runId (timeoutMs 120000), using exactly ${JSON.stringify({ threadId: selectedWorkerId, runId: "<exact runId from send result>", timeoutMs: 120000 })}; replace only the runId placeholder. If needed, read once using exactly studio_thread_read(${JSON.stringify({ threadId: selectedWorkerId, view: "messages" })}) with no extra fields, then report it with a clickable worker link. Do not delegate/create a new worker, reopen the completed delegated task, schedule, poll repeatedly, use shell/browser/filesystem, or invoke native subagents. If the single wait times out, report timeout and stop.`,
  };
}
export function syntheticAnswer(projection, runId, goal, memory) {
  const text = projection.turnItems
    .filter((i) => i.type === "assistant_message" && i.runId === runId)
    .map((i) => i.text)
    .join("\n");
  const messages = projection.messages.filter(
    (m) => m.role === "user" && m.id === projection.runs.find((r) => r.id === runId)?.userMessageId,
  );
  assert.equal(messages.length, 1, "Worker user message must be observable");
  assert.ok(
    !projection.nodes.some(
      (n) => n.runId === runId && ["tool_call", "subagent", "hook"].includes(n.kind),
    ),
    "Worker used tools; context-only proof failed",
  );
  assert.ok(
    !messages.some((m) => m.text.includes(goal) || m.text.includes(memory)),
    "Markers leaked into the worker prompt",
  );
  return {
    present: text.includes(goal) && text.includes(memory),
    responseSha256: hash(text),
    characters: text.length,
  };
}
export function newestAcceptedContext(receipts, threadId) {
  return receipts
    .filter((r) => r.threadId === threadId && r.accepted)
    .sort(
      (a, b) =>
        b.updatedAt.localeCompare(a.updatedAt) || a.scopeSha256.localeCompare(b.scopeSha256),
    )[0];
}
export function nativeObservationOrder(threadIds, coordinatorId) {
  // A coordinator tool result references an already committed worker run. Read the worker after that result.
  return [...threadIds].sort((a, b) => Number(b === coordinatorId) - Number(a === coordinatorId));
}
// Closed, source-controlled reasons only. Never serialize actual/expected/cause/stack or an arbitrary provider message.
const safeReasons = new Set([
  "Pending approval changed before response",
  "Native permission request; approval withheld",
  "Native attempt/turn ceiling exceeded",
  "Native run ceiling exceeded",
  "Unexpected extra worker",
  "Unbudgeted native subagent",
  "Foreign project refused",
  "Run changed owner",
  "Fresh store contains unowned thread",
  "Native run ended without success",
  "Worker used tools; context-only proof failed",
  "Markers leaked into the worker prompt",
  "Worker user message must be observable",
  "Original async completion must be delivered",
  "Coordinator must receive and report original worker result",
  "Coordinator must link the actual worker",
  "Initial worker context marker absent",
  "Worker native identity must be persisted",
  "Selected worker not reused",
  "Native worker identity changed",
  "Updated worker memory marker absent",
  "Follow-up created another delegated task",
  "Reviewed native model/auth unavailable; no substitute",
  "Reviewed source differs",
  "Reviewed build differs",
  "Reviewed tooling differs",
  "Reviewed approval plan differs",
  "Review must expire within one hour",
  "Runtime source must be clean",
  "Tooling source must be clean",
  "Native binary differs from review",
  "Native binary version differs",
  "Consumer Codex login required",
  "Codex login probe unavailable",
  "Claude settings isolation unsupported",
  "Canonical consumer Codex route required",
  "Owned port8431 occupied; existing owner preserved",
  "Owned server remains live",
  "Native read-only probe unavailable; private output omitted",
  "Private native RPC timeout",
  "Private native transport failure",
  "Private native transport closed",
  "Ticket exchange failed",
  "Cycle 1 timed out; no automatic retry",
  "Cycle 2 timed out; no automatic retry",
]);
export function sanitizedFailure(error) {
  const candidate = typeof error?.message === "string" ? error.message.split("\n")[0] : "";
  return {
    type: error instanceof assert.AssertionError ? "AssertionError" : "Error",
    reason:
      approvalFailureReason(error) ??
      toolDetailFailureReason(error) ??
      (safeReasons.has(candidate) ? candidate : "Private details omitted"),
  };
}
async function portFree() {
  await new Promise((done, reject) => {
    const probe = net.createServer();
    probe.once("error", () =>
      reject(new Error("Owned port8431 occupied; existing owner preserved")),
    );
    probe.listen(8431, "127.0.0.1", () => probe.close(done));
  });
}
function executable(path) {
  assert.ok(isAbsolute(path) && statSync(path).isFile(), "Existing absolute executable required");
  accessSync(path, constants.X_OK);
  return realpathSync(path);
}
function privateProbe(binary, args, env, cwd) {
  try {
    return execFileSync(binary, args, {
      env,
      cwd,
      encoding: "utf8",
      timeout: 20000,
      maxBuffer: 65536,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    throw new Error("Native read-only probe unavailable; private output omitted");
  }
}
async function main() {
  if (process.argv.includes("--help")) {
    console.log(
      "native-acceptance.mjs --mode inspect|smoke|execute [--runtime-root ABSOLUTE_CHECKOUT] [--review FILE] [--report-dir NEW_DIR] [--browser-deps NODE_MODULES] [--browser-executable FILE]\nDefault inspect never starts a provider. Runtime defaults to this tooling checkout; receipts identify both independently. Smoke starts an isolated headless server with disabled providers. Execute requires a fresh exact-runtime-source/build review, existing official binary hashes, two models, a reviewed cap of exactly4,5 or6 runs, tooling hash and the exact schema2 single-use approval plan. No retry/account switch/API fallback.",
    );
    return;
  }
  const options = parseOptions(process.argv.slice(2));
  assert.equal(process.versions.node, "22.20.0", "Use Node22.20.0");
  process.env.PWDEBUG = "0";
  process.env.PLAYWRIGHT_HTML_OPEN = "never";
  const mode = options["--mode"],
    execute = mode === "execute";
  const root = resolveRuntimeRoot(options["--runtime-root"]);
  const dist = join(root, "apps/server/dist"),
    entrypoint = join(dist, "bin.mjs");
  assert.ok(existsSync(entrypoint), "Integrated build required");
  const observed = {
    sourceCommit: execFileSync("/usr/bin/git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    }).trim(),
    sourceDirty: Boolean(
      execFileSync("/usr/bin/git", ["status", "--porcelain", "--untracked-files=no"], {
        cwd: root,
        encoding: "utf8",
      }).trim(),
    ),
    buildSha256: buildFingerprint(dist).sha256,
    runtimeRoot: root,
    tooling: toolingIdentity(),
  };
  if (mode === "inspect") {
    console.log(JSON.stringify({ ...observed, version: sourceVersion(root), nativeRuns: 0, mode }));
    return;
  }
  assert.equal(observed.sourceDirty, false, "Runtime source must be clean");
  assert.equal(observed.tooling.sourceDirty, false, "Tooling source must be clean");
  const review = execute
    ? validateReview(JSON.parse(readFileSync(options["--review"], "utf8")), observed)
    : null;
  assert.equal(
    privateProbe(
      process.execPath,
      [entrypoint, "--version"],
      nativeEnvironment(process.env, tmpdir(), false),
      root,
    ).trim(),
    `specweave-studio v${sourceVersion(root)}`,
    "Build version differs",
  );
  await portFree();
  const reportDir = resolve(
    options["--report-dir"] ?? join(tmpdir(), `studio-native-proof-${randomUUID()}`),
  );
  assert.ok(!existsSync(reportDir), "Evidence directory must be fresh");
  mkdirSync(reportDir, { recursive: true, mode: 0o700 });
  chmodSync(reportDir, 0o700);
  const stateDir = mkdtempSync(join(tmpdir(), "studio-native-state-"));
  chmodSync(stateDir, 0o700);
  const fakeHome = join(stateDir, "home"),
    dataDir = join(stateDir, "studio"),
    projectDir = join(stateDir, "project");
  for (const dir of [fakeHome, join(dataDir, "userdata"), projectDir])
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  const projectId = randomUUID(),
    coordinatorId = `project-coordinator:${projectId}`;
  const scope = createNativeScope(projectId, execute, review?.maxRuns ?? MAX_NATIVE_RUNS);
  const followupId = randomUUID();
  if (execute) enableApprovalPolicy(scope, review, followupId);
  const receipt = {
    schemaVersion: 1,
    ...observed,
    version: sourceVersion(root),
    mode,
    startedAt: new Date().toISOString(),
    reportDir,
    stateDir,
    projectId,
    origin: NATIVE_ORIGIN,
    maxRuns: scope.maxRuns,
    observedRuns: [],
    nativeProof: execute ? "pending" : "not_requested",
    success: false,
    steps: [],
    serverPids: [],
    browser: { headless: true, PWDEBUG: "0", PLAYWRIGHT_HTML_OPEN: "never" },
    limitations: [
      "Polling enforces observed app-run and worker bounds; excess fails and is retained. It cannot prevent a provider from issuing an extra call between polls.",
      "Provider-native inference requests inside one app run are not counted as separate Studio runs.",
      "Cache efficiency and API-equivalent estimates do not prove subscription spend.",
    ],
  };
  const save = () =>
    writeFileSync(join(reportDir, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n", {
      mode: 0o600,
    });
  let child,
    browser,
    context,
    page,
    db,
    monitorPromise,
    monitoring = false,
    guardError = null,
    toolDetailsReady = false,
    stage = "preflight";
  const snapshots = new Map(),
    pendingContext = new Map();
  const rpc = (tag, payload = {}) => nativeRpc(context, NATIVE_ORIGIN, tag, payload, scope);
  const step = (name) => {
    receipt.steps.push({ name, passed: true });
    save();
    console.log(JSON.stringify({ name, passed: true }));
  };
  const env = nativeEnvironment(process.env, fakeHome, execute);
  async function get(path) {
    assert.ok(
      path === "/api/projects" ||
        path === "/api/orchestration/shell" ||
        [...scope.threadIds].some(
          (id) => path === "/api/orchestration/threads/" + encodeURIComponent(id),
        ),
      "Unowned HTTP read refused",
    );
    const response = await context.request.get(NATIVE_ORIGIN + path, {
      headers: { "x-studio-orchestration-protocol": "2" },
      timeout: 10000,
    });
    assert.equal(response.status(), 200, "Owned HTTP read failed");
    return response.json();
  }
  async function mutate(type, fields) {
    assert.ok(["project.create", "project.update"].includes(type));
    const response = await context.request.post(NATIVE_ORIGIN + "/api/projects/mutate", {
      headers: { Origin: NATIVE_ORIGIN },
      data: { type, commandId: randomUUID(), projectId, ...fields },
    });
    assert.equal(response.status(), 200, "Owned project mutation failed");
    return response.json();
  }
  async function interruptOwned() {
    if (!context) return;
    for (const run of scope.runs.values())
      if (ACTIVE_RUNS.has(run.status)) {
        try {
          await rpc("orchestration.dispatchCommand", {
            type: "run.interrupt",
            commandId: randomUUID(),
            threadId: run.threadId,
            runId: run.id,
          });
        } catch {
          receipt.interruptUncertain = true;
        }
      }
  }
  function contextReceipts() {
    if (!db) return [];
    const rows = db
      .prepare(
        "SELECT thread_id, scope_key, updated_at, accepted_json, accepted_epoch, pending_run_id, pending_text FROM project_context_deliveries WHERE project_id = ? ORDER BY updated_at DESC, scope_key ASC",
      )
      .all(projectId);
    for (const row of rows)
      if (row.pending_run_id && typeof row.pending_text === "string")
        pendingContext.set(row.pending_run_id, {
          runId: row.pending_run_id,
          threadId: row.thread_id,
          characters: row.pending_text.length,
          sha256: hash(row.pending_text),
        });
    return rows.map((row) => ({
      threadId: row.thread_id,
      scopeSha256: hash(row.scope_key),
      updatedAt: row.updated_at,
      accepted: row.accepted_json !== null,
      sections: row.accepted_json
        ? JSON.parse(row.accepted_json).map((s) => ({ name: s.name, revision: s.revision }))
        : [],
      snapshotSha256: row.accepted_json ? hash(row.accepted_json) : null,
      pending: row.pending_run_id !== null,
    }));
  }
  async function observe(allowApproval = false) {
    const shell = await get("/api/orchestration/shell");
    const threads = [...shell.threads, ...(shell.archivedThreads ?? [])];
    assert.ok(
      threads.every((t) => t.projectId === projectId),
      "Fresh store contains unowned thread",
    );
    // Record every observed run before raising the budget error so evidence cannot hide excess.
    let failure,
      detailsReady = true;
    for (const threadId of nativeObservationOrder(
      threads.map((thread) => thread.id),
      coordinatorId,
    )) {
      scope.threadIds.add(threadId);
      const { projection } = await get(
        "/api/orchestration/threads/" + encodeURIComponent(threadId),
      );
      snapshots.set(threadId, projection);
      try {
        observeProjection(scope, projection);
        if (execute) {
          const detail = hydrateApprovedToolOutputs(scope, projection, (project, thread, item) =>
            readOwnedToolItem(db, project, thread, item),
          );
          snapshots.set(threadId, detail.projection);
          detailsReady = detail.ready && detailsReady;
        }
      } catch (error) {
        failure ??= error;
      }
    }
    receipt.userDispatches = userDispatchReceipt(scope);
    receipt.observedRuns = [...scope.runs.values()];
    receipt.observedProviderTurns = scope.providerTurns.size;
    receipt.observedAttempts = scope.attempts.size;
    receipt.observedThreads = [...scope.threadIds];
    receipt.context = contextReceipts();
    receipt.pendingContextSamples = [...pendingContext.values()];
    save();
    toolDetailsReady = detailsReady && !failure;
    if (failure) throw failure;
    if (execute && detailsReady) {
      const candidate = inspectApprovals(scope, snapshots);
      toolDetailsReady = detailsReady && approvalObservationReady(scope);
      if (allowApproval && candidate) {
        // Refresh every owner and budget just before reserving one response; never answer during cleanup.
        for (const threadId of nativeObservationOrder(scope.threadIds, coordinatorId)) {
          const { projection } = await get(
            "/api/orchestration/threads/" + encodeURIComponent(threadId),
          );
          snapshots.set(threadId, projection);
          observeProjection(scope, projection);
          const detail = hydrateApprovedToolOutputs(scope, projection, (project, thread, item) =>
            readOwnedToolItem(db, project, thread, item),
          );
          snapshots.set(threadId, detail.projection);
          detailsReady = detail.ready && detailsReady;
        }
        toolDetailsReady = detailsReady;
        if (!detailsReady) return;
        const fresh = inspectApprovals(scope, snapshots);
        toolDetailsReady = detailsReady && approvalObservationReady(scope);
        assert.deepEqual(fresh, candidate, "Pending approval changed before response");
        const command = reserveApproval(scope, fresh);
        try {
          await rpc("orchestration.dispatchCommand", command);
        } finally {
          receipt.approvals = approvalReceipt(scope);
          save();
        }
      }
    }
  }
  async function waitSettled(cycle, minimumRuns, workerRuns) {
    const deadline = Date.now() + 180000;
    let stableSince = null;
    while (Date.now() < deadline) {
      if (guardError) throw guardError;
      const all = [...scope.runs.values()];
      const workers = [...snapshots.values()].filter((p) => p.thread.id !== coordinatorId);
      const parent = snapshots.get(coordinatorId);
      const completionDelivered =
        cycle !== 1 ||
        parent?.subagents.some(
          (s) =>
            s.origin === "app_owned" &&
            ["acknowledged", "delivered"].includes(s.completionDelivery?.state),
        );
      const done =
        toolDetailsReady &&
        completionDelivered &&
        all.length >= minimumRuns &&
        workers.length === 1 &&
        workers[0].runs.length === workerRuns &&
        all.every((r) => r.status === "completed");
      if (done) {
        stableSince ??= Date.now();
        if (Date.now() - stableSince >= 2000) return workers[0];
      } else stableSince = null;
      assert.ok(
        !all.some((r) => ["failed", "cancelled", "interrupted"].includes(r.status)),
        "Native run ended without success",
      );
      await pause(200);
    }
    throw new Error(`Cycle ${cycle} timed out; no automatic retry`);
  }
  async function stopServer() {
    if (!child) return;
    const own = child;
    child = null;
    if (own.exitCode === null && own.signalCode === null) own.kill("SIGTERM");
    for (let i = 0; i < 50 && own.exitCode === null && own.signalCode === null; i++)
      await pause(100);
    if (own.exitCode === null && own.signalCode === null) own.kill("SIGKILL");
    for (let i = 0; i < 30 && own.exitCode === null && own.signalCode === null; i++)
      await pause(100);
    assert.ok(own.exitCode !== null || own.signalCode !== null, "Owned server remains live");
    await portFree();
    receipt.ownedProcessStopped = true;
  }
  let cleanupPromise;
  const cleanup = () =>
    (cleanupPromise ??= (async () => {
      monitoring = false;
      if (monitorPromise) await monitorPromise;
      if (context && execute) {
        try {
          await observe();
        } catch {
          receipt.finalObservationUncertain = true;
          receipt.success = false;
          receipt.nativeProof = "failed_or_unavailable";
        }
      }
      if (guardError) {
        receipt.success = false;
        receipt.nativeProof = "failed_or_unavailable";
        process.exitCode = 1;
      }
      await interruptOwned();
      if (db) db.close();
      if (browser) await browser.close();
      await stopServer();
      save();
    })());
  const interrupted = () => {
    receipt.success = false;
    receipt.failure = { stage, type: "Interrupted" };
    void cleanup().finally(() => process.exit(1));
  };
  process.once("SIGTERM", interrupted);
  process.once("SIGINT", interrupted);
  try {
    if (execute) {
      for (const name of ["codex", "claude"]) {
        executable(review[name].binaryPath);
        assert.equal(
          hash(readFileSync(review[name].binaryPath)),
          review[name].binarySha256,
          "Native binary differs from review",
        );
        const version = privateProbe(
          review[name].binaryPath,
          ["--version"],
          env,
          projectDir,
        ).trim();
        assert.ok(version.includes(review[name].version), "Native binary version differs");
      }
      const codexLogin = spawnSync(review.codex.binaryPath, ["login", "status"], {
        env,
        cwd: projectDir,
        encoding: "utf8",
        timeout: 20000,
        maxBuffer: 65536,
      });
      assert.equal(codexLogin.status, 0, "Codex login probe unavailable");
      assert.equal(
        (codexLogin.stdout + codexLogin.stderr).trim(),
        "Logged in using ChatGPT",
        "Consumer Codex login required",
      );
      assert.ok(
        privateProbe(review.claude.binaryPath, ["--help"], env, projectDir).includes(
          "--setting-sources",
        ),
        "Claude settings isolation unsupported",
      );
      const claudeAuth = JSON.parse(
        privateProbe(review.claude.binaryPath, ["auth", "status", "--json"], env, projectDir),
      );
      assert.equal(claudeAuth.loggedIn, true);
      assert.equal(claudeAuth.authMethod, "claude.ai");
      assert.equal(claudeAuth.apiProvider, "firstParty");
      const route = await nativeRouteMetadata(review.codex.binaryPath, projectDir, env);
      assert.equal(route.routeVerified, true, "Canonical consumer Codex route required");
      receipt.nativePreflight = {
        codex: { version: review.codex.version, login: "ChatGPT", routeVerified: true },
        claude: {
          version: review.claude.version,
          login: "claude.ai",
          apiProvider: "firstParty",
          configuredAbsoluteBinary: true,
        },
      };
      step("native-read-only-preflight");
    }
    writeFileSync(
      join(dataDir, "userdata/settings.json"),
      JSON.stringify(providerSettings(review)),
      { mode: 0o600 },
    );
    writeFileSync(
      join(projectDir, "README.md"),
      "Owned synthetic native acceptance workspace. No production files.\n",
    );
    for (const args of [
      ["init", "-b", "feature/native-proof"],
      ["add", "README.md"],
      [
        "-c",
        "user.name=Native proof",
        "-c",
        "user.email=native-proof@example.invalid",
        "commit",
        "-m",
        "Synthetic baseline",
      ],
    ])
      execFileSync("/usr/bin/git", args, {
        cwd: projectDir,
        env: { HOME: fakeHome, PATH: "/usr/bin:/bin", GIT_CONFIG_NOSYSTEM: "1" },
        stdio: "ignore",
      });
    stage = "headless-browser";
    const deps = resolve(
      options["--browser-deps"] ??
        join(
          homedir(),
          ".cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules",
        ),
    );
    const { chromium } = createRequire(import.meta.url)(join(deps, "playwright"));
    const browserPath = options["--browser-executable"] ?? process.env.PLAYWRIGHT_EXECUTABLE_PATH;
    browser = await chromium.launch({
      headless: true,
      ...(browserPath ? { executablePath: executable(resolve(browserPath)) } : {}),
    });
    context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
      colorScheme: "dark",
    });
    page = await context.newPage();
    stage = "isolated-server";
    await portFree();
    child = spawn(
      process.execPath,
      [
        entrypoint,
        "serve",
        "--host",
        "127.0.0.1",
        "--port",
        "8431",
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
      child.stderr.on("data", inspect);
      child.once("error", () => finish(reject, new Error("Owned server spawn failed")));
      child.once("exit", () => finish(reject, new Error("Owned server exited before ready")));
    });
    const auth = await context.request.post(NATIVE_ORIGIN + "/api/auth/browser-session", {
      headers: { Origin: NATIVE_ORIGIN },
      data: { credential },
    });
    assert.equal(auth.status(), 200);
    step("authenticated-owned-server");
    const initial = await get("/api/projects");
    assert.equal(
      (Array.isArray(initial) ? initial : initial.projects).length,
      0,
      "Store must begin empty",
    );
    const goal = `GOAL_${randomUUID().replaceAll("-", "")}`,
      memory1 = `MEMORY_${randomUUID().replaceAll("-", "")}`,
      memory2 = `MEMORY_${randomUUID().replaceAll("-", "")}`;
    await mutate("project.create", {
      title: "Native Coordination Proof",
      workspaceRoot: projectDir,
      defaultModelSelection: execute
        ? { instanceId: "claudeAgent", model: review.claude.model }
        : null,
    });
    const before = await rpc("projects.workspaceRead", { projectId });
    await mutate("project.update", {
      workspaceSettings: {
        expectedRevision: before.settings.revision,
        goal: `Verify synthetic project context. Goal marker: ${goal}`,
        instructions:
          "Use only the specific native proof request. No file edits, shell, browser, network, schedules or extra workers. Never include marker values in a dispatched worker prompt. Finish after the requested bounded check.",
        ...(execute
          ? { coordinatorModelSelection: { instanceId: "codex", model: review.codex.model } }
          : {}),
      },
    });
    const memory = await rpc("projects.memoryWrite", {
      projectId,
      name: "MEMORY.md",
      content: `Memory marker: ${memory1}\n`,
      expectedRevision: null,
    });
    step("synthetic-project-context");
    stage = "project-browser-route";
    receipt.projectNavigation = await openOwnedProject(page, {
      id: projectId,
      title: "Native Coordination Proof",
    });
    await page.screenshot({ path: join(reportDir, "project-before.png"), fullPage: true });
    step("actual-headless-project-route");
    if (!execute) {
      catalogReceipt(await rpc("server.getConfig"), null);
      const shell = await get("/api/orchestration/shell");
      assert.equal(shell.threads.length, 0);
      receipt.nativeProof = "not_requested";
      receipt.success = true;
      step("smoke-no-native-runs");
      return;
    }
    stage = "native-provider-catalog";
    // Read only: allow initial native catalog/auth probes to finish, without refresh or inference.
    const catalogDeadline = Date.now() + 45000;
    do {
      receipt.providers = catalogReceipt(await rpc("server.getConfig"), review);
      save();
      if (receipt.providers.every((provider) => provider.available)) break;
      await pause(500);
    } while (Date.now() < catalogDeadline);
    assert.ok(
      receipt.providers.every((provider) => provider.available),
      "Reviewed native model/auth unavailable; no substitute",
    );
    const { openLiveDatabaseReadOnly } = await import("../lib/live-database.mjs");
    db = openLiveDatabaseReadOnly(join(dataDir, "userdata/statev2.sqlite"));
    monitoring = true;
    monitorPromise = (async () => {
      while (monitoring) {
        try {
          await observe(true);
        } catch (error) {
          guardError = error;
          receipt.guardFailed = true;
          await interruptOwned();
          monitoring = false;
        }
        if (monitoring) await pause(100);
      }
    })();
    const prompts = cyclePrompts(review.claude.model, followupId, undefined, scope.maxRuns);
    stage = "coordinator-delegation";
    const start = await rpc("projects.coordinatorStart", {
      projectId,
      commandId: randomUUID(),
      prompt: prompts.first,
    });
    assert.equal(start.threadId, coordinatorId);
    const worker1 = await waitSettled(1, 2, 1);
    const parent1 = snapshots.get(coordinatorId);
    assert.equal(worker1.thread.modelSelection.instanceId, "claudeAgent");
    assert.equal(parent1.thread.modelSelection.instanceId, "codex");
    const children = parent1.subagents.filter((s) => s.origin === "app_owned");
    assert.equal(children.length, 1);
    assert.equal(children[0].childThreadId, worker1.thread.id);
    assert.equal(children[0].status, "completed");
    assert.ok(
      ["acknowledged", "delivered"].includes(children[0].completionDelivery?.state),
      "Original async completion must be delivered",
    );
    const parentAnswer = parent1.turnItems
      .filter((i) => i.type === "assistant_message")
      .map((i) => i.text)
      .join("\n");
    assert.ok(
      parentAnswer.includes(goal) && parentAnswer.includes(memory1),
      "Coordinator must receive and report original worker result",
    );
    assert.ok(
      linksThread(parentAnswer, worker1.thread.id),
      "Coordinator must link the actual worker",
    );
    const answer1 = syntheticAnswer(worker1, worker1.runs[0].id, goal, memory1);
    assert.equal(answer1.present, true, "Initial worker context marker absent");
    const nativeId = worker1.providerThreads.find((t) => t.driver === "claudeAgent")
      ?.nativeThreadRef?.nativeId;
    assert.ok(nativeId, "Worker native identity must be persisted");
    const initialContext = contextReceipts();
    receipt.firstCycle = {
      completionDeliveryState: children[0].completionDelivery.state,
      coordinatorReportedResult: true,
      workerId: worker1.thread.id,
      answer: answer1,
      nativeThreadSha256: hash(nativeId),
      completion: completionResultReceipt(scope, parent1),
      coordinatorWakeRuns: completionReceipt(scope)?.wakeRunId
        ? [completionReceipt(scope).wakeRunId]
        : [],
      context: initialContext,
    };
    step("heterogeneous-delegation-and-completion");
    stage = "selected-worker-continuation";
    armSelectedWorker(scope, worker1, parent1);
    await rpc("projects.memoryWrite", {
      projectId,
      name: "MEMORY.md",
      content: `Memory marker: ${memory2}\n`,
      expectedRevision: memory.revision,
    });
    const send = await rpc("projects.coordinatorSend", {
      projectId,
      commandId: randomUUID(),
      prompt: cyclePrompts(review.claude.model, followupId, worker1.thread.id, scope.maxRuns)
        .second,
      sourceThreadId: worker1.thread.id,
    });
    assert.equal(send.threadId, coordinatorId);
    assert.equal(send.created, false);
    const worker2 = await waitSettled(2, 4, 2);
    assert.equal(worker2.thread.id, worker1.thread.id, "Selected worker not reused");
    assert.equal(
      worker2.providerThreads.find((t) => t.driver === "claudeAgent")?.nativeThreadRef?.nativeId,
      nativeId,
      "Native worker identity changed",
    );
    const secondRun = [...worker2.runs].sort((a, b) => a.ordinal - b.ordinal).at(-1);
    const answer2 = syntheticAnswer(worker2, secondRun.id, goal, memory2);
    assert.equal(answer2.present, true, "Updated worker memory marker absent");
    const parent2 = snapshots.get(coordinatorId);
    assert.equal(
      parent2.subagents.filter((s) => s.origin === "app_owned").length,
      1,
      "Follow-up created another delegated task",
    );
    const changedContext = contextReceipts();
    const initialWorkerContext = newestAcceptedContext(initialContext, worker1.thread.id);
    const laterWorkerContext = newestAcceptedContext(changedContext, worker1.thread.id);
    assert.ok(initialWorkerContext && laterWorkerContext);
    assert.notEqual(laterWorkerContext.snapshotSha256, initialWorkerContext.snapshotSha256);
    receipt.secondCycle = {
      workerId: worker2.thread.id,
      answer: answer2,
      nativeThreadRetained: true,
      coordinatorWakeRuns: completionReceipt(scope)?.wakeRunId
        ? [completionReceipt(scope).wakeRunId]
        : [],
      context: changedContext,
    };
    receipt.unchangedContext = {
      sampledEmptyWake: receipt.firstCycle.coordinatorWakeRuns.some(
        (id) => pendingContext.get(id)?.characters === 0,
      ),
      status: receipt.firstCycle.coordinatorWakeRuns.some(
        (id) => pendingContext.get(id)?.characters === 0,
      )
        ? "observed_empty_pending_delivery"
        : "not_observed",
      note: "Retained identity and marker checks are actual native proof. An unsampled unchanged delivery remains unknown; cache hits are never inferred.",
    };
    step("selected-worker-reuse-and-memory-update");
    stage = "actual-usage-and-ui";
    const usage = await rpc("projects.usageRead", { projectId });
    assert.equal(usage.source, "persisted_provider_turns");
    assert.ok(usage.threads.every((t) => scope.threadIds.has(t.threadId)));
    receipt.usage = {
      ...usage,
      threads: usage.threads.map((thread) => ({
        ...thread,
        title:
          thread.threadId === coordinatorId
            ? "Native Coordination Proof coordinator"
            : "Native marker worker",
      })),
    };
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByRole("region", { name: "Project coordinator", exact: true }).waitFor();
    await page.screenshot({ path: join(reportDir, "project-native-result.png"), fullPage: true });
    if (guardError) throw guardError;
    receipt.nativeProof = "passed";
    receipt.success = true;
    step("actual-usage-and-browser-evidence");
  } catch (error) {
    receipt.success = false;
    receipt.nativeProof = execute ? "failed_or_unavailable" : "not_requested";
    receipt.failure = { stage, ...sanitizedFailure(error) };
    console.error(JSON.stringify(receipt.failure));
    process.exitCode = 1;
  } finally {
    receipt.finishedAt = new Date().toISOString();
    try {
      await cleanup();
    } catch {
      receipt.success = false;
      receipt.ownedProcessStopped = false;
      save();
      process.exitCode = 1;
    }
    process.removeListener("SIGTERM", interrupted);
    process.removeListener("SIGINT", interrupted);
    console.log(
      JSON.stringify({
        receipt: join(reportDir, "receipt.json"),
        success: receipt.success,
        nativeProof: receipt.nativeProof,
        observedRuns: scope.runs.size,
      }),
    );
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch((error) => {
    console.error(JSON.stringify({ stage: "preflight", ...sanitizedFailure(error) }));
    process.exitCode = 1;
  });
