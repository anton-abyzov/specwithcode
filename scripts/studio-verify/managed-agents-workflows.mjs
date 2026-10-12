#!/usr/bin/env node
// Explicit paid beta smoke. Credentials stay in process environment, never receipts.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const root = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "../..");
const args = process.argv.slice(2);
const live = args.includes("--beta-smoke");
const outputIndex = args.indexOf("--output");
const output = outputIndex >= 0 ? args[outputIndex + 1] : undefined;
const key = process.env.ANTHROPIC_API_KEY?.trim();
if (!live) {
  console.log(
    JSON.stringify({
      live: false,
      apiKeyPresent: !!key,
      command:
        "node scripts/studio-verify/managed-agents-workflows.mjs --beta-smoke --output <new-directory>",
      maxCostCents: "100",
      timeoutSeconds: 180,
    }),
  );
  process.exit(0);
}
if (!key || !output) {
  console.error("Live beta smoke requires ANTHROPIC_API_KEY and --output <new-directory>.");
  process.exit(1);
}
await NodeFSP.mkdir(output, { recursive: false, mode: 0o700 });
const save = (name, value) =>
  NodeFSP.writeFile(
    NodePath.resolve(output, name),
    typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`,
    { mode: 0o600 },
  );
const started = Date.now();
const deadline = started + 180_000;
const owned = new Set();
const archived = new Set();
const cleanup = [];
const request = async (method, path, body) => {
  const response = await fetch(`https://api.anthropic.com/v1/${path}`, {
    method,
    headers: {
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "managed-agents-2026-04-01",
      "content-type": "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok)
    throw new Error(
      `Managed Agents ${method} ${path.split("/")[0]} failed (HTTP ${response.status}).`,
    );
  return response.json();
};
let receipt;
let failure;
const prepareSessionArchive = async (path) => {
  let session = await request("GET", path);
  if (session.status === "terminated") return;
  const history = await request("GET", `${path}/events?limit=100`);
  const created = new Set(
    (history.data ?? [])
      .filter((event) => event.type === "workflow_run.created")
      .map((event) => event.workflow_run_id),
  );
  for (const event of history.data ?? [])
    if (event.type === "workflow_run.status_ended") created.delete(event.workflow_run_id);
  const lastIdle = (history.data ?? []).findLast((event) => event.type === "session.status_idle");
  if (session.status === "idle" && lastIdle?.stop_reason?.type === "budget_reached") return;
  const answered = new Set(
    (history.data ?? [])
      .filter((event) => event.type === "user.custom_tool_result")
      .map((event) => event.custom_tool_use_id),
  );
  for (const event of history.data ?? [])
    if (
      event.type === "agent.custom_tool_use" &&
      /^sevt_[A-Za-z0-9]+$/.test(event.id) &&
      !answered.has(event.id)
    )
      await request("POST", `${path}/events`, {
        events: [
          {
            type: "user.custom_tool_result",
            custom_tool_use_id: event.id,
            is_error: true,
            content: [{ type: "text", text: "Studio smoke has ended; this report was canceled." }],
          },
        ],
      });
  if (session.status === "running" || created.size) {
    await request("POST", `${path}/events`, { events: [{ type: "user.interrupt" }] });
    if (created.size)
      await request("POST", `${path}/events`, {
        events: [
          {
            type: "user.message",
            content: [
              {
                type: "text",
                text: "Stop all open workflow runs immediately. Do not start another run. The Studio smoke has ended.",
              },
            ],
          },
        ],
      });
    for (let attempt = 0; attempt < 15; attempt++) {
      session = await request("GET", path);
      const events = await request("GET", `${path}/events?limit=100`);
      for (const event of events.data ?? [])
        if (event.type === "workflow_run.status_ended") created.delete(event.workflow_run_id);
      if (session.status === "terminated" || (session.status === "idle" && !created.size)) return;
      await new Promise((resolveWait) => setTimeout(resolveWait, 500));
    }
    throw new Error("Own beta session could not be stopped within cleanup time.");
  }
};
try {
  const environment = await request("POST", "environments", {
    name: `Studio 0892 bounded smoke ${new Date().toISOString()}`,
    config: {
      type: "cloud",
      networking: {
        type: "limited",
        allowed_hosts: [],
        allow_mcp_servers: false,
        allow_package_managers: false,
      },
    },
  });
  if (!/^env_[A-Za-z0-9]+$/.test(environment.id))
    throw new Error("Environment creation returned an invalid ID.");
  owned.add(`environments/${environment.id}`);
  await save("ownership.json", { resources: [...owned], environment });
  await save("config.json", {
    enabled: true,
    environmentId: environment.id,
    model: "claude-sonnet-4-6",
    maxCostCents: "100",
    timeoutSeconds: 120,
    globalInstructions:
      "Include GLOBAL_0892 in every worker and lead answer. State HEADLESS_TRUE, PWDEBUG_0 and HTML_NEVER to acknowledge the mandatory browser policy. Do not use a browser or any external tool for this text task.",
    projectInstructions:
      "Include PROJECT_0892 in every worker and lead answer. Keep answers short. Arithmetic must be calculated independently in the predefined worker threads.",
  });
  await save(
    "prompt.txt",
    "Use a dynamic workflow. Start one parallel phase with exactly two calls to the predefined worker: task A computes 7 * 6 and labels the result A_RESULT=42; task B computes 81 / 9 and labels it B_RESULT=9. Then start a second phase that combines those worker results in a short report. Workers must each return the inherited global, project and browser-policy markers. Return the two arithmetic labels and the same markers in your final answer. No files, repositories or external tools are needed.",
  );
  const command = [
    NodePath.resolve(root, "apps/server/src/bin.ts"),
    "managed-agents",
    "run",
    "--beta",
    "--config",
    NodePath.resolve(output, "config.json"),
    "--prompt-file",
    NodePath.resolve(output, "prompt.txt"),
    "--receipt",
    NodePath.resolve(output, "receipt.json"),
  ];
  const child = NodeChildProcess.spawn(process.execPath, command, {
    cwd: root,
    env: { ...process.env, PWDEBUG: "0", PLAYWRIGHT_HTML_OPEN: "never" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  let pending = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    const text = chunk.toString();
    stderr += text;
    pending += text;
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) {
      try {
        const value = JSON.parse(line);
        if (/^(agents|sessions)\/[A-Za-z0-9_]+$/.test(value.resourceCreated ?? ""))
          owned.add(value.resourceCreated);
        if (value.resourceArchived && value.success) archived.add(value.resourceArchived);
      } catch {
        /* Progress errors contain no credentials; only structured ownership is accepted. */
      }
    }
  });
  const timer = setTimeout(
    () => child.kill("SIGTERM"),
    Math.max(1, deadline - Date.now() - 35_000),
  );
  const result = await new Promise((resolveChild, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolveChild({ code, signal }));
  }).finally(() => clearTimeout(timer));
  await save("stdout.json", stdout);
  await save("progress.jsonl", stderr);
  await save("process.json", { ...result, elapsedSeconds: (Date.now() - started) / 1000 });
  await save("ownership.json", { resources: [...owned], environment });
  if (result.code !== 0)
    throw new Error(
      `Beta CLI did not complete successfully (exit ${result.code}, signal ${result.signal}).`,
    );
  receipt = JSON.parse(await NodeFSP.readFile(NodePath.resolve(output, "receipt.json"), "utf8"));
} catch (error) {
  failure = error instanceof Error ? error.message : "Beta smoke failed.";
} finally {
  // Only IDs created by this process are eligible. Never enumerate or mutate unrelated resources.
  for (const path of [...owned].toReversed()) {
    try {
      if (!archived.has(path)) {
        if (path.startsWith("sessions/")) await prepareSessionArchive(path);
        await request("POST", `${path}/archive`);
        archived.add(path);
      }
      const resource = await request("GET", path);
      cleanup.push({
        path,
        archiveAccepted: true,
        archivedAt: resource.archived_at ?? null,
        archived: resource.archived ?? resource.is_archived ?? null,
        status: resource.status ?? null,
      });
    } catch {
      cleanup.push({ path, archiveAccepted: archived.has(path), readbackFailed: true });
    }
  }
  await save("cleanup.json", cleanup);
}
const markers = ["GLOBAL_0892", "PROJECT_0892", "HEADLESS_TRUE", "PWDEBUG_0", "HTML_NEVER"];
const workers = receipt?.threadEvidence?.filter((thread) => thread.workflowRunId) ?? [];
const checks = {
  workflowCompleted: receipt?.executionComplete === true,
  allRunsCompleted:
    !!receipt?.state.runs.length && receipt.state.runs.every((run) => run.status === "completed"),
  atLeastTwoEndedPhases:
    (receipt?.state.runs.flatMap((run) => run.phases).filter((phase) => phase.status === "ended")
      .length ?? 0) >= 2,
  independentWorkerAnswers:
    workers.length >= 2 &&
    workers.every(
      (thread) =>
        !thread.failed &&
        thread.instructionsMatch &&
        thread.agentId === receipt.workerId &&
        markers.every((marker) => thread.reportMessages.join("\n").includes(marker)),
    ),
  independentArithmetic:
    workers.some((thread) => thread.reportMessages.join("\n").includes("A_RESULT=42")) &&
    workers.some((thread) => thread.reportMessages.join("\n").includes("B_RESULT=9")),
  leadMarkers: markers.every((marker) => receipt?.state.messages.join("\n").includes(marker)),
  completeEvidence: receipt?.evidenceComplete === true,
  cleanupAccepted:
    cleanup.length === owned.size &&
    cleanup.every(
      (resource) => resource.archiveAccepted && !!resource.archivedAt && !resource.readbackFailed,
    ),
  bounded: Date.now() - started <= 180_000,
};
const result = {
  passed: !failure && Object.values(checks).every(Boolean),
  failure: failure ?? null,
  checks,
  sessionId: receipt?.sessionId ?? null,
  runIds: receipt?.state.runs.map((run) => run.id) ?? [],
  workerThreadIds: workers.map((thread) => thread.id),
  usage: receipt?.usage ?? null,
  elapsedSeconds: (Date.now() - started) / 1000,
  resources: [...owned],
};
await save("verification.json", result);
console.log(JSON.stringify(result, null, 2));
if (!result.passed) process.exitCode = 1;
