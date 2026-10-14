#!/usr/bin/env node
import { spawnSync, execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const report = resolve(process.argv[2] ?? "coverage/logical-project");
mkdirSync(report, { recursive: true });
console.log(
  "Source commit:",
  execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
);
const tests = [
  "apps/desktop/src/window/DesktopProjectWindow.test.ts",
  "apps/server/src/fleet/MachineHandoff.modelSelection.test.ts",
  "apps/server/src/fleet/MachineHandoff.test.ts",
  "apps/server/src/fleet/RemoteWorkers.test.ts",
  "apps/server/src/fleet/remoteWorkerMatching.test.ts",
  "apps/server/src/mcp/toolkits/orchestrator/federatedProjectThreads.test.ts",
  "apps/server/src/mcp/toolkits/orchestrator/remote.test.ts",
  "apps/server/src/mcp/OrchestratorMcpService.test.ts",
  "apps/server/src/mcp/OrchestratorMcpToolkit.integration.test.ts",
  "apps/server/src/orchestration-v2/ProjectCommands.test.ts",
  "apps/server/src/project/ProjectCommandAdmission.test.ts",
  "apps/server/src/project/ProjectEnvironmentRuntime.test.ts",
  "apps/server/src/project/ProjectService.test.ts",
  "apps/server/src/scheduledTasks/ScheduledTaskAdmission.test.ts",
  "apps/web/src/components/chat/UserMessageProvenance.test.tsx",
  "apps/web/src/components/chat/MessagesTimeline.test.tsx",
  "apps/web/src/components/settings/ProjectSettingsPanel.test.tsx",
  "apps/web/src/components/studio/ProjectWorkspaceSettings.test.tsx",
  "apps/web/src/components/studio/ProjectMachineHandoff.test.tsx",
  "apps/web/src/components/studio/MachineHandoffDialog.test.tsx",
  "apps/web/src/components/studio/ProjectWorkspace.test.tsx",
  "apps/web/src/components/studio/ProjectWorkspace.attachments.test.tsx",
  "apps/web/src/components/studio/ProjectWorkspace.lifecycle.test.tsx",
  "apps/web/src/components/studio/ProjectWorkspace.threads.test.tsx",
  "apps/web/src/components/studio/ProjectWorkspace.fleet.test.tsx",
  "apps/web/src/components/studio/ProjectHandoffRecovery.test.tsx",
  "apps/web/src/components/studio/ProjectExecutionHistory.test.tsx",
  "apps/web/src/components/studio/ProjectWorkerPane.test.tsx",
  "apps/web/src/components/studio/shell/StudioSidebar.test.tsx",
  "apps/web/src/studio/projectDomain.test.ts",
  "apps/web/src/studio/projectPaneThreads.test.ts",
  "packages/client-runtime/src/state/projectGrouping.test.ts",
  "packages/contracts/src/logicalProject.test.ts",
  "packages/contracts/src/orchestratorMcp.test.ts",
];
const features = [
  "packages/contracts/src/logicalProject.ts",
  "apps/server/src/fleet/MachineHandoff.ts",
  "apps/server/src/project/ProjectAdmission.ts",
  "apps/server/src/project/ProjectCommandAdmission.ts",
  "apps/server/src/fleet/RemoteWorkers.ts",
  "apps/server/src/fleet/remoteWorkerMatching.ts",
  "apps/server/src/mcp/toolkits/orchestrator/federatedProjectThreads.ts",
  "apps/server/src/mcp/OrchestratorMcpThreadList.ts",
  "packages/client-runtime/src/state/projectGrouping.ts",
  "apps/web/src/studio/projectDomain.ts",
  "apps/web/src/components/chat/UserMessageProvenance.tsx",
  "apps/web/src/components/studio/ProjectMachineHandoff.tsx",
  "apps/web/src/components/studio/ProjectExecutionHistory.tsx",
  "apps/web/src/components/studio/ProjectWorkerPane.tsx",
  "apps/web/src/components/studio/ProjectHandoffRecovery.tsx",
];
const result = spawnSync(
  process.execPath,
  [
    "node_modules/vite-plus/bin/vp",
    "test",
    "run",
    ...tests,
    "--no-file-parallelism",
    "--coverage",
    "--coverage.reportOnFailure",
    ...features.map((file) => `--coverage.include=${file}`),
    "--coverage.reporter=text",
    "--coverage.reporter=json-summary",
    "--coverage.reporter=json",
    `--coverage.reportsDirectory=${report}`,
    "--coverage.thresholds.lines=90",
    "--coverage.thresholds.branches=60",
    "--coverage.thresholds.functions=60",
    "--coverage.thresholds.statements=90",
  ],
  {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, PWDEBUG: "0", PLAYWRIGHT_HTML_OPEN: "never" },
  },
);
process.exitCode = result.status ?? 1;
