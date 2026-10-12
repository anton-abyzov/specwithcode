import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createWriteStream, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { requireCoverageProvider } from "./coverage-provider.mjs";

// Observation-only acceptance. No provider live test, service or auth mutation.
assert.ok(process.versions.node.startsWith("22."), "An absolute Node22 executable is required");
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const option = process.argv.indexOf("--report-dir");
const reportDir =
  option >= 0
    ? resolve(process.argv[option + 1])
    : join(root, "reports/studio-verification/source");
mkdirSync(reportDir, { recursive: true, mode: 0o700 });
const env = {
  ...process.env,
  PATH: dirname(process.execPath) + ":" + process.env.PATH,
  PWDEBUG: "0",
  PLAYWRIGHT_HTML_OPEN: "never",
};
const vp = join(root, "node_modules/vite-plus/bin/vp");
const receipt = {
  observedAt: new Date().toISOString(),
  node: process.execPath,
  version: process.version,
  browserMode: "headless-only",
  providerLiveTests: false,
  steps: [],
};
const save = () =>
  writeFileSync(join(reportDir, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n", {
    mode: 0o600,
  });
async function run(name, files, cwd, extra = []) {
  assert.ok(
    files.every((file) => !file.includes(".live.test.")),
    "Live provider tests are excluded",
  );
  const args = [vp, "test", "run", ...extra, ...files];
  const logPath = join(reportDir, name + ".log");
  const log = createWriteStream(logPath, { mode: 0o600 });
  const started = Date.now();
  const result = await new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    const timer = setTimeout(() => child.kill("SIGTERM"), 240000);
    child.stdout.pipe(log, { end: false });
    child.stderr.pipe(log, { end: false });
    child.once("error", reject);
    child.once("close", (exitCode, signal) => {
      clearTimeout(timer);
      log.end(() => resolveRun({ exitCode, signal }));
    });
  });
  receipt.steps.push({
    name,
    command: [process.execPath, ...args],
    cwd,
    ...result,
    elapsedMs: Date.now() - started,
    logPath,
  });
  save();
  console.log(JSON.stringify(receipt.steps.at(-1)));
  assert.equal(result.exitCode, 0, name + " failed; original output retained");
}
// Both coverage steps need the out-of-tree plugin; fail here, not halfway through.
receipt.coverageProvider = requireCoverageProvider(
  ["apps/web", "apps/server"].map((dir) => join(root, dir)),
).map(({ dir, version }) => ({ dir, version }));
save();
const web = "src/";
await run(
  "studio-ui-coverage",
  [
    "studio/overviewModel.test.ts",
    "studio/capacity.test.ts",
    "studio/capacityRequest.test.ts",
    "components/studio/StudioOverview.test.tsx",
    "components/studio/CapacityFleet.test.tsx",
  ].map((file) => web + file),
  join(root, "apps/web"),
  [
    "--project",
    "unit",
    "--coverage",
    "--coverage.include=src/studio/*.ts",
    "--coverage.include=src/components/studio/*.tsx",
    "--coverage.reporter=text",
    "--coverage.reporter=json-summary",
    "--coverage.reportsDirectory=" + join(reportDir, "web-coverage"),
  ],
);
await run(
  "native-ui-controls",
  [
    "proposedPlan.test.ts",
    "components/chat/ComposerPendingApprovalPanel.test.tsx",
    "components/chat/ComposerPendingApprovalActions.test.tsx",
    "components/chat/ComposerPendingUserInputPanel.permissions.test.tsx",
    "components/chat/ComposerPrimaryActions.test.tsx",
    "components/chat/QueuedRunsControl.test.tsx",
    "hooks/useThreadActions.permissions.test.ts",
  ].map((file) => web + file),
  join(root, "apps/web"),
  ["--project", "unit"],
);
await run(
  "native-workflow",
  [
    "QueuedRunOrder.test.ts",
    "SteeringCompletion.integration.test.ts",
    "SelectionRestart.integration.test.ts",
    "RestartContinuation.test.ts",
    "ProviderRuntimeRecoveryService.regression.test.ts",
    "ProviderContinuationService.test.ts",
    "CheckpointRestoreSafety.test.ts",
    "CheckpointScopeOwnership.test.ts",
    "CheckpointCaptureService.test.ts",
    "ProviderSwitchService.test.ts",
    "ProviderSessionTransitionPolicy.test.ts",
    "ProviderSelectionTransition.test.ts",
    "ContextHandoffBudget.test.ts",
  ]
    .map((file) => "src/orchestration-v2/" + file)
    .concat("src/scheduling/Scheduler.integration.test.ts"),
  join(root, "apps/server"),
);
await run(
  "usage-limit-recovery",
  ["src/orchestration-v2/runtimeLayer.test.ts"],
  join(root, "apps/server"),
  ["-t", "usage-limit recovery"],
);
await run(
  "studio-security-coverage",
  ["Capacity", "SwitchClient", "capacitySnapshot", "http"].map(
    (file) => "src/studio/" + file + ".test.ts",
  ),
  join(root, "apps/server"),
  [
    "--coverage",
    "--coverage.include=src/studio/*.ts",
    "--coverage.exclude=src/studio/fixtures.ts",
    "--coverage.reporter=text",
    "--coverage.reporter=json-summary",
    "--coverage.reportsDirectory=" + join(reportDir, "server-coverage"),
  ],
);
await run(
  "sqlite-pairing",
  [
    "src/persistence/Sqlite.test.ts",
    "src/auth/EnvironmentAuth.test.ts",
    "src/auth/EnvironmentAuthAdmin.test.ts",
  ],
  join(root, "apps/server"),
);
receipt.coverage = Object.fromEntries(
  ["web", "server"].map((kind) => [
    kind,
    JSON.parse(readFileSync(join(reportDir, kind + "-coverage/coverage-summary.json"), "utf8"))
      .total,
  ]),
);
save();
console.log(
  JSON.stringify({
    checksPassed: receipt.steps.length,
    node: process.execPath,
    version: process.version,
    coverage: receipt.coverage,
  }),
);
