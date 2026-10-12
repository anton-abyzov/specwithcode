#!/usr/bin/env node
import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
const assert = NodeAssert;
const { spawn, execFileSync } = NodeChildProcess;
const { createHash } = NodeCrypto;
const { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } = NodeFS;
const { dirname, join, resolve } = NodePath;
const { fileURLToPath } = NodeURL;
import { sourceVersion } from "./version.mjs";

// Fixed gates against this checkout. There is deliberately no --command, skip,
// wrapper-success override, or live-provider test glob.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const args = process.argv.slice(2);
if (args.includes("--help")) {
  console.log(
    "Node22 verify-release.mjs --report-dir NEW_DIR [--browser-deps NODE_MODULES] [--browser-executable FILE]\nRuns unit suites, type checks, production web/server builds, brand/version/installer gates, and isolated headless acceptance. Does not package, install a service, or claim native-provider proof.",
  );
  process.exit(0);
}
const valid = new Set(["--report-dir", "--browser-deps", "--browser-executable"]);
for (let i = 0; i < args.length; i += 2)
  assert.ok(
    valid.has(args[i]) && args[i + 1] && !args[i + 1].startsWith("--"),
    "Unknown or missing gate option",
  );
const option = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
assert.equal(process.versions.node, "22.20.0", "Use pinned Node22");
assert.ok(option("--report-dir"), "Choose a fresh evidence directory");
const out = resolve(option("--report-dir"));
assert.ok(!existsSync(out), "Do not overwrite prior release evidence");
const vp = join(root, "node_modules/vite-plus/bin/vp");
assert.ok(existsSync(vp), "Use existing pinned dependencies");
const requiredFiles = [
  "apps/server/src/project/ProjectWorkspaceService.test.ts",
  "apps/server/src/project/ProjectCoordinatorService.test.ts",
  "apps/server/src/project/ProjectCommandAdmission.integration.test.ts",
  "apps/server/src/project/ProjectContextDelivery.test.ts",
  "apps/server/src/project/ProjectPlanService.test.ts",
  "apps/server/src/usage/ProjectUsageService.test.ts",
  "apps/server/src/scheduledTasks/ScheduledTaskService.lifecycle.test.ts",
  "apps/web/src/components/studio/ProjectWorkspace.test.tsx",
  "apps/web/src/studio/projectCoordinatorMessageDisplay.test.ts",
  "apps/web/src/components/studio/ProjectWorkspaceSettings.test.tsx",
  "apps/web/src/components/studio/ProjectPlan.test.tsx",
];
for (const path of requiredFiles)
  assert.ok(existsSync(join(root, path)), `Integrated release prerequisite missing: ${path}`);
mkdirSync(out, { recursive: true, mode: 0o700 });
const env = {
  ...process.env,
  PATH: dirname(process.execPath) + ":" + process.env.PATH,
  PWDEBUG: "0",
  PLAYWRIGHT_HTML_OPEN: "never",
  STUDIO_TEST_NODE: process.execPath,
  // Synthetic Git fixtures must not inherit personal hooks or global aliases.
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
};
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
  observedAt: new Date().toISOString(),
  node: process.version,
  version: sourceVersion(root),
  steps: [],
  applicationGatesPassed: false,
  artifactVerification: "pending",
  nativeProviderProof: "not_run",
  installedRuntimeVerification: "pending",
  releaseReady: false,
};
const save = () =>
  writeFileSync(join(out, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n", {
    mode: 0o600,
  });
const hash = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
let activeChild = null;
async function run(name, command, argv, cwd = root, timeoutMs = 600000) {
  const path = join(out, name + ".log"),
    stream = createWriteStream(path, { mode: 0o600 });
  let timedOut = false;
  let versionStdout = "";
  const began = Date.now();
  const result = await new Promise((done, reject) => {
    const child = spawn(command, argv, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    activeChild = child;
    // Unit/build commands cannot receive browser credentials; acceptance emits only
    // sanitized status labels. Provider live tests are excluded from these scopes.
    child.stdout.pipe(stream, { end: false });
    child.stderr.pipe(stream, { end: false });
    // Keep diagnostics in the evidence log, but version identity is stdout.
    // Node's SQLite warning on stderr must not become part of the CLI version.
    if (name === "cli-version")
      child.stdout.on("data", (chunk) => {
        versionStdout += chunk.toString();
      });
    let escalation;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      escalation = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }, 15000);
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timeout);
      clearTimeout(escalation);
      activeChild = null;
      stream.end();
      reject(error);
    });
    child.once("close", (exitCode, signal) => {
      clearTimeout(timeout);
      clearTimeout(escalation);
      activeChild = null;
      stream.end(() => done({ exitCode, signal, timedOut }));
    });
  });
  receipt.steps.push({
    name,
    command: [command, ...argv],
    cwd,
    ...result,
    elapsedMs: Date.now() - began,
    log: path,
    sha256: hash(path),
  });
  save();
  console.log(JSON.stringify({ name, ...result }));
  assert.equal(result.exitCode, 0, `${name} failed; exact output retained`);
  assert.equal(timedOut, false);
  return versionStdout;
}
const runNode = (name, argv, cwd, timeout) => run(name, process.execPath, argv, cwd, timeout);
try {
  await runNode("release-version", [
    "--test",
    join(root, "scripts/studio-projects/release-version.test.mjs"),
    join(root, "scripts/studio-projects/release-flags.test.mjs"),
  ]);
  await runNode("native-proof-guards", [
    "--test",
    ...[
      "native-acceptance",
      "native-approval",
      "native-tool-detail",
      "native-completion",
      "native-readonly-wait",
      "native-read-output",
      "native-initial-publication",
      "native-canonical-output",
    ].map((name) => join(root, `scripts/studio-projects/${name}.test.mjs`)),
  ]);
  await runNode("tutorial-capture-guards", [
    "--test",
    join(root, "scripts/studio-projects/tutorial-capture.test.mjs"),
    join(root, "scripts/studio-projects/tutorial-personal.test.mjs"),
  ]);
  await run("installer-regressions", "python3", ["-B", "scripts/studio-fleet/test-install.py"]);
  await run("updater-regressions", "python3", ["-B", "scripts/studio-fleet/test-update.py"]);
  await run("desktop-backup-regressions", "python3", [
    "-B",
    "scripts/studio-fleet/test-desktop-backup.py",
  ]);
  await runNode(
    "project-server-suites",
    [
      vp,
      "test",
      "run",
      "--maxWorkers=2",
      "src/project",
      "src/mcp/toolkits/projectConnections",
      "src/auth/RpcAuthorization.test.ts",
      "src/observability/RpcInstrumentation.test.ts",
      "src/usage",
      "src/scheduledTasks",
      "src/scheduling/Scheduler.test.ts",
      "src/scheduling/Scheduler.integration.test.ts",
      "src/orchestration-v2/ThreadLaunchService.test.ts",
      "src/orchestration-v2/ClaudeAutomaticDelivery.integration.test.ts",
      "src/orchestration-v2/SteeringCompletion.integration.test.ts",
      "src/orchestration-v2/OpenCode2OrchestratorV2.integration.test.ts",
      "src/orchestration-v2/TerminalRunReactor.integration.test.ts",
      "src/orchestration-v2/runtimeLayer.test.ts",
      "src/orchestration-v2/testkit/ClaudeReplayFixtures.integration.test.ts",
      "src/orchestration-v2/testkit/OrchestratorReplayFixtures.integration.test.ts",
      "src/orchestration-v2/BackgroundWorkStop.integration.test.ts",
      "src/orchestration-v2/DispatchModeLimit.test.ts",
      "src/orchestration-v2/Orchestrator.control-reads.test.ts",
      "src/orchestration-v2/SelectionRestart.integration.test.ts",
      "src/orchestration-v2/ThreadFork.execution.test.ts",
      "src/orchestration-v2/ThreadStop.test.ts",
      "src/orchestration-v2/ThreadTitleRegenerationService.test.ts",
      "src/orchestration-v2/ThreadWorkspaceTransition.test.ts",
      "src/orchestration-v2/testkit/OrchestratorReplayRecovery.integration.test.ts",
      "src/orchestration-v2/testkit/OrchestratorReplayRestartBackgroundNote.integration.test.ts",
      "src/orchestration-v2/testkit/ProviderSwitch.integration.test.ts",
      "src/orchestration-v2/testkit/ThreadFork.integration.test.ts",
      "src/orchestration-v2/testkit/ThreadMergeBack.integration.test.ts",
      "src/provider/claudeUsageLimits.test.ts",
      "src/provider/providerUsageLimits.test.ts",
      "src/studio/ClaudeQuotaFailure.test.ts",
      "src/studio/capacitySnapshot.test.ts",
      "src/studio/Capacity.test.ts",
      "src/orchestration-v2/ProviderTurnStartService.test.ts",
      "src/orchestration-v2/ProviderTurnStartService.testkit.test.ts",
      "src/orchestration-v2/DelegatedCompletionDelivery.test.ts",
      "src/orchestration-v2/ProviderTurnStartService.memory.test.ts",
      "src/orchestration-v2/UsageLimitRecoveryWorker.test.ts",
      "src/orchestration-v2/Adapters/CodexAdapterV2.test.ts",
      "src/orchestration-v2/Adapters/ClaudeAdapterV2.test.ts",
      "src/orchestration-v2/Adapters/codexManualCredits.test.ts",
      "src/orchestration-v2/Orchestrator.manualCredits.test.ts",
      "src/orchestration-v2/manualCreditRuntime.test.ts",
      "src/provider/ClaudeNativeModels.test.ts",
      "src/provider/ClaudeProvider.test.ts",
      "src/provider/CodexProvider.test.ts",
      "src/provider/ProviderInstanceEnvironment.test.ts",
      "src/git/GitManager.test.ts",
      "src/git/GitWorkflowService.test.ts",
      "src/git/worktreeIntegration.test.ts",
      "src/git/worktreeRemovalSafety.test.ts",
      "src/vcs/GitRemotePaths.test.ts",
      "src/vcs/VcsStatusBroadcaster.test.ts",
      "src/workspace/automaticPullSafety.test.ts",
      "src/serverRuntimeStartup.test.ts",
      "src/provider/TurnTokenUsage.test.ts",
      "src/persistence/Sqlite.test.ts",
    ],
    join(root, "apps/server"),
  );
  await runNode(
    "project-web-suites",
    [
      vp,
      "test",
      "run",
      "--project",
      "unit",
      "--maxWorkers=2",
      "src/components/studio",
      "src/hooks/useScratchProject.test.ts",
      "src/studio",
      "src/components/chat/explicitCreditSend.test.ts",
    ],
    join(root, "apps/web"),
  );
  await runNode("contract-suites", [
    vp,
    "test",
    "run",
    "--maxWorkers=2",
    "packages/contracts/src/project",
    "packages/contracts/src/settings.test.ts",
    "packages/contracts/src/orchestrationV2.test.ts",
    "packages/contracts/src/environmentHttp.test.ts",
    "packages/contracts/src/manualCodexCredits.test.ts",
    "packages/contracts/src/providerUsageLimits.test.ts",
  ]);
  for (const app of ["server", "web", "desktop"])
    await runNode(`${app}-typecheck`, ["--run", "typecheck"], join(root, "apps", app));
  await runNode("web-production", ["--run", "build"], join(root, "apps/web"), 900000);
  await runNode(
    "server-production",
    ["scripts/cli.ts", "build"],
    join(root, "apps/server"),
    900000,
  );
  const versionStdout = await runNode("cli-version", ["apps/server/dist/bin.mjs", "--version"]);
  assert.equal(versionStdout.trim(), `specweave-studio v${receipt.version}`);
  assert.ok(
    existsSync(join(root, "apps/server/dist/client/index.html")),
    "Built server must include the web application",
  );
  receipt.build = {
    entrySha256: hash(join(root, "apps/server/dist/bin.mjs")),
    webIndexSha256: hash(join(root, "apps/server/dist/client/index.html")),
  };
  save();
  const browserArgs = ["--browser-deps", "--browser-executable"].flatMap((name) =>
    option(name) ? [name, resolve(option(name))] : [],
  );
  await runNode(
    "headless-acceptance",
    [
      "scripts/studio-projects/acceptance.mjs",
      "--report-dir",
      join(out, "acceptance"),
      ...browserArgs,
    ],
    root,
    600000,
  );
  const acceptance = JSON.parse(readFileSync(join(out, "acceptance/receipt.json"), "utf8"));
  assert.equal(acceptance.success, true);
  assert.equal(acceptance.ownedProcessStopped, true);
  assert.equal(acceptance.buildSha256, receipt.build.entrySha256);
  assert.equal(acceptance.source, receipt.source);
  assert.ok(acceptance.screenshots.length >= 6);
  assert.equal(acceptance.nativeProof.status, "not_requested");
  receipt.applicationGatesPassed = true;
} catch (error) {
  receipt.failure = {
    type: error?.name ?? "Error",
    gate: receipt.steps.at(-1)?.name ?? "preflight",
  };
  process.exitCode = 1;
} finally {
  if (activeChild && activeChild.exitCode === null && activeChild.signalCode === null)
    activeChild.kill("SIGTERM");
  save();
  console.log(
    JSON.stringify({
      applicationGatesPassed: receipt.applicationGatesPassed,
      releaseReady: false,
      receipt: join(out, "receipt.json"),
    }),
  );
}
