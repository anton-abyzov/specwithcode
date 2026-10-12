#!/usr/bin/env node
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeModule from "node:module";
import * as NodeURL from "node:url";

const args = process.argv.slice(2);
if (args.includes("--help") || !args.includes("--run")) {
  console.log(
    "Usage: node scripts/studio-verify/claude-workflows.mjs --run --output-dir <new absolute directory> [--claude <executable>] [--max-budget-usd <0.01..0.25>]\nRuns one bounded two-worker native workflow using the production policy compiler. Writes only a new scratch directory and native scratch-session state; existing account authentication is read by Claude, never copied. No browser, network tools, shell, edits, API resources or bypass permissions.",
  );
  process.exit(0);
}
function option(name, fallback) {
  const i = args.indexOf(name);
  return i < 0 ? fallback : args[i + 1];
}
const outputDir = NodePath.resolve(option("--output-dir", ""));
if (!option("--output-dir") || !option("--output-dir").startsWith("/"))
  throw new Error("--output-dir must name a new absolute directory.");
const budget = Number(option("--max-budget-usd", "0.25"));
if (!(budget >= 0.01 && budget <= 0.25)) throw new Error("Budget must be between $0.01 and $0.25.");
const cli = option(
  "--claude",
  NodePath.join(NodeOS.homedir(), ".local/share/specweave/providers/bin/claude"),
);
const require = NodeModule.createRequire(
  new URL("../../apps/server/package.json", import.meta.url),
);
const sdkPath = require.resolve("@anthropic-ai/claude-agent-sdk");
const { query } = await import(NodeURL.pathToFileURL(sdkPath).href);
const { compileClaudeWorkflowPolicy } =
  await import("../../apps/server/src/provider/ClaudeWorkflowPolicy.ts");
const { STUDIO_HEADLESS_INSTRUCTIONS } =
  await import("../../apps/server/src/provider/RuntimeInstructions.ts");
await NodeFSP.mkdir(outputDir, { recursive: false });
const fixture = NodePath.join(outputDir, "fixture");
await NodeFSP.mkdir(NodePath.join(fixture, ".claude/workflows"), { recursive: true });
const expected = {
  environment_marker: "SW_ENVIRONMENT_0892",
  project_marker: "SW_PROJECT_0892",
  project_file_marker: "SW_PROJECT_FILE_0892",
  browser_policy: STUDIO_HEADLESS_INSTRUCTIONS.split("\n")[1].split(". ")[0] + ".",
};
await NodeFSP.writeFile(
  NodePath.join(fixture, "CLAUDE.md"),
  "PROJECT_FILE_MARKER = SW_PROJECT_FILE_0892. Follow all inherited Studio instructions. Do not modify project files.\n",
);
await NodeFSP.writeFile(
  NodePath.join(fixture, ".claude/settings.json"),
  JSON.stringify({
    disableAllHooks: true,
    permissions: { deny: ["Bash", "Write", "Edit", "WebFetch", "WebSearch"] },
  }),
);
const workerPrompt =
  "Without tools, report the exact inherited values of ENVIRONMENT_INSTRUCTION_MARKER, PROJECT_INSTRUCTION_MARKER and PROJECT_FILE_MARKER, and the exact first sentence of the inherited browser_automation section. Return MISSING for any absent value. Do not invent values or infer them from another agent. Return JSON with environment_marker, project_marker, project_file_marker and browser_policy.";
const script = `export const meta = { name: 'studio-context-smoke', description: 'Verify two workers receive Studio context', phases: ['Context verification'] };\nphase('Context verification');\nconst prompt = ${JSON.stringify(workerPrompt)};\nconst schema = ${JSON.stringify({ type: "object", required: Object.keys(expected), properties: Object.fromEntries(Object.keys(expected).map((key) => [key, { type: "string" }])) })};\nconst first = await agent(prompt, { label: 'first', schema });\nconst second = await agent(prompt, { label: 'second', schema });\nreturn { first, second };\n`;
await NodeFSP.writeFile(
  NodePath.join(fixture, ".claude/workflows/studio-context-smoke.js"),
  script,
);
const policy = compileClaudeWorkflowPolicy({
  mode: "on-request",
  agentInstructions:
    "<environment_instructions>ENVIRONMENT_INSTRUCTION_MARKER = SW_ENVIRONMENT_0892.</environment_instructions>\n<project_instructions>PROJECT_INSTRUCTION_MARKER = SW_PROJECT_0892.</project_instructions>",
  allowedTools: ["Read", "Workflow(studio-context-smoke)"],
  environment: {
    ...process.env,
    CLAUDE_CODE_WORKFLOW_MAX_CONCURRENT_AGENTS: "2",
    PWDEBUG: "0",
    PLAYWRIGHT_HTML_OPEN: "never",
  },
});
const events = [];
let nativeSessionId;
let lastResult;
try {
  for await (const message of query({
    prompt:
      "Use a workflow. Run the existing saved studio-context-smoke workflow by name and report the two workers' structured outputs when it completes. Do not change the script, inject worker instructions, or use Bash, network, Write or Edit tools.",
    options: {
      cwd: fixture,
      pathToClaudeCodeExecutable: cli,
      model: "haiku",
      tools: ["Read", "Workflow"],
      allowedTools: policy.allowedTools,
      disallowedTools: policy.disallowedTools,
      systemPrompt: {
        type: "preset",
        preset: "claude_code",
        snapshot: false,
        append: policy.instructions,
      },
      settingSources: ["user", "project", "local"],
      extraArgs: policy.extraArgs,
      settings: { ...policy.settings, disableAllHooks: true },
      env: policy.environment,
      permissionMode: "dontAsk",
      strictMcpConfig: true,
      maxBudgetUsd: budget,
      maxTurns: 6,
    },
  })) {
    if (message.type === "system" && message.subtype === "init") {
      nativeSessionId ??= message.session_id;
      events.push({
        type: "init",
        sessionId: message.session_id,
        version: message.claude_code_version,
        model: message.model,
        tools: message.tools,
      });
    } else if (message.type === "system" && /task/.test(message.subtype)) {
      events.push({
        type: message.subtype,
        taskId: message.task_id,
        taskType: message.task_type,
        status: message.status,
        description: message.description,
      });
    } else if (message.type === "result") {
      lastResult = message;
      events.push({
        type: "result",
        subtype: message.subtype,
        result: message.result,
        estimatedCostUsd: message.total_cost_usd,
        permissionDenials: message.permission_denials,
      });
    }
  }
  if (
    !nativeSessionId ||
    !events.some((e) => e.type === "task_notification" && e.status === "completed")
  )
    throw new Error("The native workflow did not report completion.");
  const configHome = process.env.CLAUDE_CONFIG_DIR || NodePath.join(NodeOS.homedir(), ".claude");
  const projectKey = (await NodeFSP.realpath(fixture)).replace(/[^a-zA-Z0-9]/g, "-");
  const ownedSession = NodePath.join(configHome, "projects", projectKey, nativeSessionId);
  const runtimeDir = NodePath.join(ownedSession, "workflows");
  const runtimeFiles = (await NodeFSP.readdir(runtimeDir)).filter((name) => name.endsWith(".json"));
  if (runtimeFiles.length !== 1)
    throw new Error("Expected one workflow runtime result in the owned scratch session.");
  const runtimePath = NodePath.join(runtimeDir, runtimeFiles[0]);
  const runtimeBytes = await NodeFSP.readFile(runtimePath);
  const runtime = JSON.parse(runtimeBytes);
  const journalPath = NodePath.join(
    ownedSession,
    "subagents/workflows",
    runtime.runId,
    "journal.jsonl",
  );
  const journalBytes = await NodeFSP.readFile(journalPath);
  const workerResults = journalBytes
    .toString()
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
    .filter((entry) => entry.type === "result");
  if (runtime.status !== "completed" || runtime.agentCount !== 2 || workerResults.length !== 2)
    throw new Error("Native workflow did not finish exactly two workers.");
  for (const result of workerResults) {
    for (const [key, value] of Object.entries(expected)) {
      if (result.result?.[key] !== value)
        throw new Error(`Native worker failed the ${key} context assertion.`);
    }
  }
  if (
    JSON.stringify(workerResults.map((e) => e.result)) !==
    JSON.stringify([runtime.result.first, runtime.result.second])
  )
    throw new Error("Native runtime results differ from the worker journal.");
  const receipt = {
    verified: true,
    fixture,
    executable: cli,
    sdkVersion: JSON.parse(
      await NodeFSP.readFile(NodePath.join(NodePath.dirname(sdkPath), "package.json"), "utf8"),
    ).version,
    compiler: "apps/server/src/provider/ClaudeWorkflowPolicy.ts",
    mode: policy.mode,
    maxBudgetUsd: budget,
    sourceHash: NodeCrypto.createHash("sha256")
      .update(
        await NodeFSP.readFile(
          new URL("../../apps/server/src/provider/ClaudeWorkflowPolicy.ts", import.meta.url),
        ),
      )
      .digest("hex"),
    events,
    nativeRun: {
      id: runtime.runId,
      status: runtime.status,
      agentCount: runtime.agentCount,
      results: runtime.result,
    },
    nativeJournalResults: workerResults,
    nativeSourceHashes: [runtimePath, journalPath].map((path, i) => ({
      path,
      sha256: NodeCrypto.createHash("sha256")
        .update(i === 0 ? runtimeBytes : journalBytes)
        .digest("hex"),
    })),
    estimatedCostUsd: lastResult?.total_cost_usd,
    permissionDenials: lastResult?.permission_denials,
    scope:
      "One native scratch workflow; no Studio live store, browser, code/network tools, copied auth or Managed Agents API resources.",
  };
  await NodeFSP.writeFile(
    NodePath.join(outputDir, "receipt.json"),
    JSON.stringify(receipt, null, 2) + "\n",
  );
  console.log(
    JSON.stringify({
      verified: true,
      receipt: NodePath.join(outputDir, "receipt.json"),
      estimatedCostUsd: receipt.estimatedCostUsd,
    }),
  );
} catch (error) {
  await NodeFSP.writeFile(
    NodePath.join(outputDir, "failure.json"),
    JSON.stringify({ verified: false, error: error.message, events }, null, 2) + "\n",
  );
  console.error(error.message);
  process.exitCode = 1;
}
