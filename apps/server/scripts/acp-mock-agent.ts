#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import { randomUUID } from "node:crypto";
import * as NodeFS from "node:fs";

import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Deferred from "effect/Deferred";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";

import * as EffectAcpAgent from "@specweave-studio/effect-acp/agent";
import * as AcpError from "@specweave-studio/effect-acp/errors";
import type * as AcpSchema from "@specweave-studio/effect-acp/schema";
import type * as AcpCompat from "@specweave-studio/effect-acp/compat";

import { beginAcpMockPrompt } from "./acpMockCancellationState.ts";

const requestLogPath = process.env.STUDIO_ACP_REQUEST_LOG_PATH;
const exitLogPath = process.env.STUDIO_ACP_EXIT_LOG_PATH;
const antigravityProfile = process.env.STUDIO_ACP_ANTIGRAVITY === "1";
const emitToolCalls = process.env.STUDIO_ACP_EMIT_TOOL_CALLS === "1";
const emitInterleavedAssistantToolCalls =
  process.env.STUDIO_ACP_EMIT_INTERLEAVED_ASSISTANT_TOOL_CALLS === "1";
const emitV2Fidelity = process.env.STUDIO_ACP_EMIT_V2_FIDELITY === "1";
const vibeRetryOutcome = process.env.STUDIO_ACP_VIBE_RETRY_OUTCOME;
const emitGenericToolPlaceholders = process.env.STUDIO_ACP_EMIT_GENERIC_TOOL_PLACEHOLDERS === "1";
const emitPostSettleMonitorFlow = process.env.STUDIO_ACP_EMIT_POST_SETTLE_MONITOR_FLOW === "1";
const emitInTurnTaskOutputThenLateDuplicate =
  process.env.STUDIO_ACP_EMIT_IN_TURN_TASKOUTPUT_THEN_LATE_DUPLICATE === "1";
const injectedReportTriggerPath = process.env.STUDIO_ACP_INJECTED_REPORT_TRIGGER_PATH;
const emitBackgroundToolDuringAnswer =
  process.env.STUDIO_ACP_EMIT_BACKGROUND_TOOL_DURING_ANSWER === "1";
const emitAskQuestion = process.env.STUDIO_ACP_EMIT_ASK_QUESTION === "1";
const emitElicitation = process.env.STUDIO_ACP_EMIT_ELICITATION === "1";
const emitMcpToolApprovalElicitation =
  process.env.STUDIO_ACP_EMIT_MCP_TOOL_APPROVAL_ELICITATION === "1";
const emitUrlElicitation = process.env.STUDIO_ACP_EMIT_URL_ELICITATION === "1";
const emitXAiAskUserQuestion = process.env.STUDIO_ACP_EMIT_XAI_ASK_USER_QUESTION === "1";
const emitXAiExitPlanMode = process.env.STUDIO_ACP_EMIT_XAI_EXIT_PLAN_MODE === "1";
const emitXAiPlanMdWrite = process.env.STUDIO_ACP_EMIT_XAI_PLAN_MD_WRITE === "1";
const emitXAiPromptCompleteThenHang =
  process.env.STUDIO_ACP_EMIT_XAI_PROMPT_COMPLETE_THEN_HANG === "1";
const emitXAiRateLimitThenHang = process.env.STUDIO_ACP_EMIT_XAI_RATE_LIMIT_THEN_HANG === "1";
const emitXAiAskUserQuestionThenHang =
  process.env.STUDIO_ACP_EMIT_XAI_ASK_USER_QUESTION_THEN_HANG === "1";
const emitContentThenHang = process.env.STUDIO_ACP_EMIT_CONTENT_THEN_HANG === "1";
const emitPlanThenHang = process.env.STUDIO_ACP_EMIT_PLAN_THEN_HANG === "1";
const emitActiveToolThenHang = process.env.STUDIO_ACP_EMIT_ACTIVE_TOOL_THEN_HANG === "1";
const emitGrokMonitorPostTurnPoll = process.env.STUDIO_ACP_EMIT_GROK_MONITOR_POST_TURN_POLL === "1";
const emitGrokBackgroundTaskStarted =
  process.env.STUDIO_ACP_EMIT_GROK_BACKGROUND_TASK_STARTED === "1";
const emitForeignSessionUpdates = process.env.STUDIO_ACP_EMIT_FOREIGN_SESSION_UPDATES === "1";
const waitForResumeRelease = process.env.STUDIO_ACP_WAIT_FOR_RESUME_RELEASE === "1";
const completeFirstPromptOnCancel = process.env.STUDIO_ACP_COMPLETE_FIRST_PROMPT_ON_CANCEL === "1";
const floodStderr = process.env.STUDIO_ACP_FLOOD_STDERR === "1";
const hangPromptForever = process.env.STUDIO_ACP_HANG_PROMPT_FOREVER === "1";
// Sends fs/write_text_file for this path, then fs/read_text_file, at the start of
// each prompt whatever the client advertised, and appends each outcome as a JSON
// line to STUDIO_ACP_CLIENT_FS_PROBE_LOG_PATH.
const clientFsProbePath = process.env.STUDIO_ACP_CLIENT_FS_PROBE_PATH;
const clientFsProbeLogPath = process.env.STUDIO_ACP_CLIENT_FS_PROBE_LOG_PATH;
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const hangAfterPermission = process.env.STUDIO_ACP_HANG_AFTER_PERMISSION === "1";
const hangFirstPromptForever = process.env.STUDIO_ACP_HANG_FIRST_PROMPT_FOREVER === "1";
const emitLateUpdateAfterCancel = process.env.STUDIO_ACP_EMIT_LATE_UPDATE_AFTER_CANCEL === "1";
const emitTaskBackgroundedAfterCancel =
  process.env.STUDIO_ACP_EMIT_TASK_BACKGROUNDED_AFTER_CANCEL === "1";
const residualCallbackResponseLogPath = process.env.STUDIO_ACP_RESIDUAL_CALLBACK_RESPONSE_LOG_PATH;
const residualCallbackTriggerPath = process.env.STUDIO_ACP_RESIDUAL_CALLBACK_TRIGGER_PATH;
const exitAfterResidualCallbacks = process.env.STUDIO_ACP_EXIT_AFTER_RESIDUAL_CALLBACKS === "1";
const emitRunningCommandThenHang = process.env.STUDIO_ACP_EMIT_RUNNING_COMMAND_THEN_HANG === "1";
const emitRunningCommandThenHangOnFirstPrompt =
  process.env.STUDIO_ACP_EMIT_RUNNING_COMMAND_THEN_HANG_FIRST_PROMPT === "1";
const emitEmptySuccessfulBash = process.env.STUDIO_ACP_EMIT_EMPTY_SUCCESSFUL_BASH === "1";
const emitEmptySuccessfulBashThenHang =
  process.env.STUDIO_ACP_EMIT_EMPTY_SUCCESSFUL_BASH_THEN_HANG === "1";
const exitOnCancel = process.env.STUDIO_ACP_EXIT_ON_CANCEL === "1";
const runningCommandIgnoresTerm = process.env.STUDIO_ACP_RUNNING_COMMAND_IGNORE_TERM === "1";
const runningCommandPidPath = process.env.STUDIO_ACP_RUNNING_COMMAND_PID_PATH;
const runningCommandSeparateSession =
  process.env.STUDIO_ACP_RUNNING_COMMAND_SEPARATE_SESSION === "1";
const exitAfterRunningCommandLaunch =
  process.env.STUDIO_ACP_EXIT_AFTER_RUNNING_COMMAND_LAUNCH === "1";
const omitXAiPromptCompleteStopReason =
  process.env.STUDIO_ACP_OMIT_XAI_PROMPT_COMPLETE_STOP_REASON === "1";
const failLoadSession = process.env.STUDIO_ACP_FAIL_LOAD_SESSION === "1";
const failLoadSessionAfterConfigReplay =
  process.env.STUDIO_ACP_FAIL_LOAD_SESSION_AFTER_CONFIG_REPLAY === "1";
const emitLoadReplay = process.env.STUDIO_ACP_EMIT_LOAD_REPLAY === "1";
const hangLoadSessionAfterReplay = process.env.STUDIO_ACP_HANG_LOAD_SESSION_AFTER_REPLAY === "1";
const delayLoadSessionAfterReplay = process.env.STUDIO_ACP_DELAY_LOAD_SESSION_AFTER_REPLAY === "1";
const loadSessionDelayMs = Number(process.env.STUDIO_ACP_LOAD_SESSION_DELAY_MS ?? "5000");
const emitStaleXAiPromptCompleteBeforeSecondHang =
  process.env.STUDIO_ACP_EMIT_STALE_XAI_PROMPT_COMPLETE_BEFORE_SECOND_HANG === "1";
const emitOverlappingXAiPromptCompleteOutOfOrder =
  process.env.STUDIO_ACP_EMIT_OVERLAPPING_XAI_PROMPT_COMPLETE_OUT_OF_ORDER === "1";
const failPrompt = process.env.STUDIO_ACP_FAIL_PROMPT === "1";
const failPromptMessage = process.env.STUDIO_ACP_FAIL_PROMPT_MESSAGE;
const failSetConfigOption = process.env.STUDIO_ACP_FAIL_SET_CONFIG_OPTION === "1";
const exitOnSetConfigOption = process.env.STUDIO_ACP_EXIT_ON_SET_CONFIG_OPTION === "1";
const omitModelConfigOption = process.env.STUDIO_ACP_OMIT_MODEL_CONFIG_OPTION === "1";
const promptResponseText = process.env.STUDIO_ACP_PROMPT_RESPONSE_TEXT;
const initialGrokReasoningEffort =
  process.env.STUDIO_ACP_INITIAL_GROK_REASONING_EFFORT?.trim() || undefined;
const promptDelayMs = Number(process.env.STUDIO_ACP_PROMPT_DELAY_MS ?? "0");
const supportsSessionLifecycle = process.env.STUDIO_ACP_SESSION_LIFECYCLE === "1";
const supportsAcpMcp = process.env.STUDIO_ACP_MCP_ACP === "1";
const supportsHttpMcp = process.env.STUDIO_ACP_MCP_HTTP === "1";
const agentName = process.env.STUDIO_ACP_AGENT_NAME ?? "studio-acp-mock-agent";
const supportsV2Management = process.env.STUDIO_ACP_V2_MANAGEMENT === "1";
const omitSessionListHandler = process.env.STUDIO_ACP_OMIT_SESSION_LIST_HANDLER === "1";
const advertisedAuthMethodId = process.env.STUDIO_ACP_AUTH_METHOD_ID?.trim();
const initializeAuthMethodId =
  advertisedAuthMethodId ?? (supportsSessionLifecycle ? "test" : undefined);
const requiresAuthentication = process.env.STUDIO_ACP_REQUIRE_AUTH === "1";
const commandAdvertisementDelayMs = Number(
  process.env.STUDIO_ACP_COMMAND_ADVERTISEMENT_DELAY_MS ?? "-1",
);
const permissionOptionIds = {
  allowOnce: process.env.STUDIO_ACP_ALLOW_ONCE_OPTION_ID ?? "allow-once",
  allowAlways: process.env.STUDIO_ACP_ALLOW_ALWAYS_OPTION_ID ?? "allow-always",
  rejectOnce: process.env.STUDIO_ACP_REJECT_ONCE_OPTION_ID ?? "reject-once",
};
const omitAllowAlways = process.env.STUDIO_ACP_OMIT_ALLOW_ALWAYS === "1";
const permissionRequestCount = Math.max(
  1,
  Number(process.env.STUDIO_ACP_PERMISSION_REQUEST_COUNT ?? "1") || 1,
);
const sessionId =
  process.env.STUDIO_ACP_ACTIVITY_SCENARIO === "1"
    ? `mock-session-${randomUUID()}`
    : "mock-session-1";

let currentModeId = antigravityProfile ? "default" : "ask";
let currentModelId = antigravityProfile ? "gemini-test-low" : "default";
let parameterizedModelPicker = false;
let currentReasoning = "medium";
let currentContext = "272k";
let currentFast = false;
let authenticated = !requiresAuthentication;
let promptCount = 0;
let overlappingFirstPromptId: string | undefined;
const cancelledSessions = new Set<string>();
let configuredProvider: AcpSchema.ProviderCurrentConfig | null = null;

function promptIdFromRequestMeta(
  request: Pick<AcpSchema.PromptRequest, "_meta">,
): string | undefined {
  const meta = request._meta;
  if (meta === null || typeof meta !== "object") {
    return undefined;
  }
  const promptId = meta.promptId ?? meta.requestId;
  return typeof promptId === "string" && promptId.length > 0 ? promptId : undefined;
}

function logExit(reason: string): void {
  if (!exitLogPath) {
    return;
  }
  NodeFS.appendFileSync(exitLogPath, `${reason}\n`, "utf8");
}

function writeJsonRpcNotification(method: string, params: unknown): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
}

function logResidualCallbackResponse(kind: string): void {
  if (!residualCallbackResponseLogPath) return;
  NodeFS.appendFileSync(residualCallbackResponseLogPath, `${kind}\n`, "utf8");
}

process.once("SIGTERM", () => {
  logExit("SIGTERM");
  process.exit(0);
});

process.once("SIGINT", () => {
  logExit("SIGINT");
  process.exit(0);
});

process.once("exit", (code) => {
  logExit(`exit:${code}`);
});

function configOptions(): ReadonlyArray<AcpSchema.SessionConfigOption> {
  if (omitModelConfigOption) {
    return [];
  }
  if (antigravityProfile) {
    return [
      {
        configId: "model",
        name: "Model",
        category: "model",
        type: "select",
        currentValue: currentModelId,
        options: antigravityModels.map((model) => ({ value: model.modelId, name: model.name })),
      },
      {
        configId: "mode",
        name: "Mode",
        category: "mode",
        type: "select",
        currentValue: currentModeId,
        options: availableModes.map((mode) => ({ value: mode.id, name: mode.name })),
      },
    ];
  }
  if (parameterizedModelPicker) {
    const baseOptions: Array<AcpSchema.SessionConfigOption> = [
      {
        configId: "mode",
        name: "Mode",
        category: "mode",
        type: "select",
        currentValue: currentModeId,
        options: availableModes.map((mode) => ({
          value: mode.id,
          name: mode.name,
          ...(mode.description ? { description: mode.description } : {}),
        })),
      },
      {
        configId: "model",
        name: "Model",
        category: "model",
        type: "select",
        currentValue: currentModelId,
        options: [
          { value: "default", name: "Auto" },
          { value: "composer-2", name: "Composer 2" },
          { value: "gpt-5.4", name: "GPT-5.4" },
          { value: "claude-opus-4-6", name: "Opus 4.6" },
        ],
      },
    ];

    switch (currentModelId) {
      case "gpt-5.4":
        return [
          ...baseOptions,
          {
            configId: "reasoning",
            name: "Reasoning",
            category: "thought_level",
            type: "select",
            currentValue: currentReasoning,
            options: [
              { value: "none", name: "None" },
              { value: "low", name: "Low" },
              { value: "medium", name: "Medium" },
              { value: "high", name: "High" },
              { value: "extra-high", name: "Extra High" },
            ],
          },
          {
            configId: "context",
            name: "Context",
            category: "model_config",
            type: "select",
            currentValue: currentContext,
            options: [
              { value: "272k", name: "272K" },
              { value: "1m", name: "1M" },
            ],
          },
          {
            configId: "fast",
            name: "Fast",
            category: "model_config",
            type: "select",
            currentValue: String(currentFast),
            options: [
              { value: "false", name: "Off" },
              { value: "true", name: "Fast" },
            ],
          },
        ];
      case "composer-2":
        return [
          ...baseOptions,
          {
            configId: "fast",
            name: "Fast",
            category: "model_config",
            type: "select",
            currentValue: String(currentFast),
            options: [
              { value: "false", name: "Off" },
              { value: "true", name: "Fast" },
            ],
          },
        ];
      case "claude-opus-4-6":
        return [
          ...baseOptions,
          {
            configId: "reasoning",
            name: "Reasoning",
            category: "thought_level",
            type: "select",
            currentValue: currentReasoning,
            options: [
              { value: "low", name: "Low" },
              { value: "medium", name: "Medium" },
              { value: "high", name: "High" },
            ],
          },
          {
            configId: "thinking",
            name: "Thinking",
            category: "model_config",
            type: "boolean",
            currentValue: true,
          },
        ];
      default:
        return baseOptions;
    }
  }

  return [
    {
      configId: "mode",
      name: "Mode",
      category: "mode",
      type: "select" as const,
      currentValue: currentModeId,
      options: availableModes.map((mode) => ({
        value: mode.id,
        name: mode.name,
        ...(mode.description ? { description: mode.description } : {}),
      })),
    },
    {
      configId: "model",
      name: "Model",
      category: "model",
      type: "select" as const,
      currentValue: currentModelId,
      options: [
        { value: "default", name: "Auto" },
        { value: "composer-2", name: "Composer 2" },
        { value: "composer-2[fast=true]", name: "Composer 2 Fast" },
        { value: "gpt-5.3-codex[reasoning=medium,fast=false]", name: "Codex 5.3" },
      ],
    },
  ];
}

function modelConfigOptionsFor(modelId: string): ReadonlyArray<AcpSchema.SessionConfigOption> {
  const previousModelId = currentModelId;
  try {
    currentModelId = modelId;
    return configOptions().filter(
      (option) => option.category !== "mode" && option.category !== "model",
    );
  } finally {
    currentModelId = previousModelId;
  }
}

function availableModels(): ReadonlyArray<{
  readonly value: string;
  readonly name: string;
  readonly configOptions: ReadonlyArray<AcpSchema.SessionConfigOption>;
}> {
  return [
    { value: "default", name: "Auto" },
    { value: "composer-2", name: "Composer 2" },
    { value: "gpt-5.4", name: "GPT-5.4" },
    { value: "claude-opus-4-6", name: "Opus 4.6" },
  ].map((model) => ({
    value: model.value,
    name: model.name,
    configOptions: modelConfigOptionsFor(model.value),
  }));
}

const antigravityModels = [
  { modelId: "gemini-test-low", name: "Gemini Test Low" },
  { modelId: "gemini-test-high", name: "Gemini Test High" },
] satisfies ReadonlyArray<AcpCompat.ModelInfo>;

const availableModes: ReadonlyArray<AcpCompat.SessionMode> = antigravityProfile
  ? [
      { id: "default", name: "Default" },
      { id: "auto_edit", name: "Auto edit" },
      { id: "yolo", name: "YOLO" },
    ]
  : [
      {
        id: "ask",
        name: "Ask",
        description: "Request permission before making any changes",
      },
      {
        id: "architect",
        name: "Architect",
        description: "Design and plan software systems without implementation",
      },
      {
        id: "code",
        name: "Code",
        description: "Write and modify code with full tool access",
      },
    ];

function modeState(): AcpCompat.SessionModeState {
  return {
    currentModeId,
    availableModes,
  };
}

// Mirrors the real Grok ACP: it advertises versioned model ids, never the CLI's own
// "grok-build" product name. Native helper model switching has its own v1 fixture.
const grokAcpModels: ReadonlyArray<AcpCompat.ModelInfo> = [
  {
    modelId: "grok-4.6",
    name: "Grok 4.6",
    _meta: {
      totalContextTokens: 500_000,
      supportsReasoningEffort: true,
      reasoningEffort: initialGrokReasoningEffort ?? "high",
      reasoningEfforts: [
        { id: "xhigh", value: "xhigh", label: "Extra High Effort", default: false },
        { id: "high", value: "high", label: "High Effort", default: true },
        { id: "low", value: "low", label: "Low Effort", default: false },
      ],
    },
  },
  { modelId: "grok-mock-alt", name: "Grok Mock Alt" },
];

function modelState(): AcpCompat.SessionModelState {
  if (antigravityProfile) {
    return { currentModelId, availableModels: antigravityModels };
  }
  const modelId = grokAcpModels.some((model) => model.modelId === currentModelId)
    ? currentModelId
    : "grok-4.6";
  return {
    currentModelId: modelId,
    availableModels: grokAcpModels,
  };
}

// STUDIO_ACP_ACTIVITY_SCENARIO=1 plays the two scripted turns of the activity-diffs
// capture (scripts/studio-verify/activity-diffs-capture.mjs). It never calls a model and
// works only in the session cwd, which must hold that capture's scratch repository:
//   SCENARIO:edit      exploration, one edit tool call changing 3 files, a `sed -i` edit,
//                      one failing command, a 340 KiB plain-string output, final message.
//   SCENARIO:readonly  reads and read-only commands, no edits.
// Any other prompt gets a short reply and no tools.
const activityScenario = process.env.STUDIO_ACP_ACTIVITY_SCENARIO === "1";
const ACTIVITY_SCRATCH_FILES = ["packages/core/src/chat/flushPolicy.ts", "logs/stream-trace.log"];
const ACTIVITY_SKILL = ".claude/skills/streaming-flush-tuning/references/SKILL.md";
let activityToolCount = 0;
let activityMessageCount = 0;
// Leave with the client: a capture server that stops hard must not leave the mock running.
if (activityScenario) process.stdin.once("end", () => process.exit(0));

type ActivityEmit = (update: AcpSchema.SessionUpdate) => Effect.Effect<void, AcpError.AcpError>;
type ActivityToolResult = Omit<
  Extract<AcpSchema.SessionUpdate, { readonly sessionUpdate: "tool_call_update" }>,
  "sessionUpdate" | "toolCallId"
>;

function activityShell(cwd: string, command: string) {
  const nodeDirectory = process.execPath.slice(0, process.execPath.lastIndexOf("/"));
  try {
    const stdout = NodeChildProcess.execSync(command, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 64 * 1024 * 1024,
      shell: "/bin/sh",
      env: { ...process.env, PATH: `${nodeDirectory}:/usr/bin:/bin:/usr/sbin:/sbin` },
    });
    return { stdout, stderr: "", code: 0 };
  } catch (error) {
    const failure = error as { stdout?: unknown; stderr?: unknown; status?: unknown };
    return {
      stdout: String(failure.stdout ?? ""),
      stderr: String(failure.stderr ?? ""),
      code: typeof failure.status === "number" ? failure.status : 1,
    };
  }
}

/** A git patch with one hunk around the changed lines (both texts end in a newline). */
function activityPatch(file: string, oldText: string, newText: string): string {
  const before = oldText.slice(0, -1).split("\n");
  const after = newText.slice(0, -1).split("\n");
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) {
    start += 1;
  }
  let beforeEnd = before.length;
  let afterEnd = after.length;
  while (beforeEnd > start && afterEnd > start && before[beforeEnd - 1] === after[afterEnd - 1]) {
    beforeEnd -= 1;
    afterEnd -= 1;
  }
  const from = Math.max(0, start - 3);
  const trailing = Math.min(3, before.length - beforeEnd);
  return [
    `diff --git a/${file} b/${file}`,
    `--- a/${file}`,
    `+++ b/${file}`,
    `@@ -${from + 1},${beforeEnd + trailing - from} +${from + 1},${afterEnd + trailing - from} @@`,
    ...before.slice(from, start).map((line) => ` ${line}`),
    ...before.slice(start, beforeEnd).map((line) => `-${line}`),
    ...after.slice(start, afterEnd).map((line) => `+${line}`),
    ...before.slice(beforeEnd, beforeEnd + trailing).map((line) => ` ${line}`),
    "",
  ].join("\n");
}

function activityText(
  emit: ActivityEmit,
  kind: "agent_message_chunk" | "agent_thought_chunk",
  text: string,
) {
  activityMessageCount += 1;
  return emit({
    sessionUpdate: kind,
    messageId: `activity-${kind === "agent_thought_chunk" ? "thought" : "message"}-${activityMessageCount}`,
    content: { type: "text", text },
  });
}

function activityTool(
  emit: ActivityEmit,
  start: Pick<ActivityToolResult, "title" | "kind" | "rawInput">,
  run: () => ActivityToolResult,
) {
  return Effect.gen(function* () {
    activityToolCount += 1;
    const toolCallId = `activity-tool-${activityToolCount}`;
    yield* emit({ sessionUpdate: "tool_call_update", toolCallId, ...start, status: "pending" });
    yield* Effect.sleep("60 millis");
    yield* emit({ sessionUpdate: "tool_call_update", toolCallId, status: "in_progress" });
    yield* Effect.sleep("90 millis");
    yield* emit({ sessionUpdate: "tool_call_update", toolCallId, ...run() });
    yield* Effect.sleep("60 millis");
  });
}

function activityCommand(emit: ActivityEmit, cwd: string, command: string, plainString = false) {
  return activityTool(
    emit,
    { title: `\`${command}\``, kind: "execute", rawInput: { variant: "Bash", command } },
    () => {
      const result = activityShell(cwd, command);
      const status = result.code === 0 ? "completed" : "failed";
      return plainString
        ? { status, rawOutput: result.stdout + result.stderr }
        : {
            status,
            rawOutput: {
              type: "bash",
              stdout: result.stdout,
              stderr: result.stderr,
              exit_code: result.code,
            },
          };
    },
  );
}

/** Reads a file in the session cwd, or reports `content` without touching the disk. */
function activityRead(emit: ActivityEmit, path: string, content?: string) {
  return activityTool(
    emit,
    { title: `Read ${path.split("/").at(-1)}`, kind: "read", rawInput: { path } },
    () => ({
      status: "completed",
      rawOutput: { content: content ?? NodeFS.readFileSync(path, "utf8") },
      locations: [{ path }],
    }),
  );
}

function activityEditScenario(emit: ActivityEmit, cwd: string) {
  return Effect.gen(function* () {
    yield* activityText(
      emit,
      "agent_thought_chunk",
      "The flush interval lives in packages/core/src/chat/streaming.ts. I will read the skill notes and the flush code, then raise the interval in the three places that copy it.",
    );
    yield* Effect.sleep("120 millis");
    yield* activityText(
      emit,
      "agent_message_chunk",
      "Reading the streaming code and the skill notes first.\n\n",
    );
    yield* activityRead(emit, `${cwd}/${ACTIVITY_SKILL}`);
    yield* activityCommand(emit, cwd, "sed -n 240,500p packages/core/src/chat/streaming.ts");
    yield* activityCommand(emit, cwd, 'grep -rn "FLUSH_INTERVAL_MS" packages docs');
    yield* activityCommand(emit, cwd, "git status --short");
    yield* activityText(
      emit,
      "agent_message_chunk",
      "Raising the flush interval in the three files that define it.\n\n",
    );
    const targets = [
      [
        "packages/core/src/chat/flushPolicy.ts",
        "export const FLUSH_INTERVAL_MS = 16;",
        "export const FLUSH_INTERVAL_MS = 32;",
      ],
      [
        "packages/client-runtime/src/stream/bufferedWriter.ts",
        "const FLUSH_INTERVAL_MS = 16; // keep in sync with core",
        "const FLUSH_INTERVAL_MS = 32; // keep in sync with core",
      ],
      [
        "docs/streaming.md",
        "The writer flushes every 16 ms.",
        "The writer flushes every 32 ms, which halves render work on long turns.",
      ],
    ] as const;
    yield* activityTool(
      emit,
      {
        title: "Edit 3 files",
        kind: "edit",
        rawInput: { files: targets.map(([file]) => `${cwd}/${file}`) },
      },
      () => ({
        status: "completed",
        content: targets.map(([file, from, to]) => {
          const path = `${cwd}/${file}`;
          const oldText = NodeFS.readFileSync(path, "utf8");
          const newText = oldText.replace(from, to);
          NodeFS.writeFileSync(path, newText);
          return {
            type: "diff" as const,
            changes: [{ operation: "modify" as const, path, fileType: "text" as const }],
            patch: { format: "git_patch", text: activityPatch(file, oldText, newText) },
          };
        }),
        locations: targets.map(([file]) => ({ path: `${cwd}/${file}` })),
      }),
    );
    // GNU and BSD sed both take -i.bak; a bare -i '' is BSD only.
    yield* activityCommand(
      emit,
      cwd,
      "sed -i.bak 's/const MAX_BUFFERED_CHUNKS = 64;/const MAX_BUFFERED_CHUNKS = 128;/' packages/core/src/chat/streaming.ts && rm packages/core/src/chat/streaming.ts.bak",
    );
    yield* activityCommand(emit, cwd, "node --test test/streaming.test.mjs");
    yield* activityCommand(emit, cwd, "cat logs/stream-trace.log", true);
    yield* activityText(
      emit,
      "agent_message_chunk",
      [
        "Raised the flush interval from 16 ms to 32 ms.",
        "",
        "- `packages/core/src/chat/flushPolicy.ts`, `packages/client-runtime/src/stream/bufferedWriter.ts` and `docs/streaming.md` now say 32 ms (edit tool).",
        "- `packages/core/src/chat/streaming.ts` buffers up to 128 chunks (`sed -i`).",
        "- `node --test test/streaming.test.mjs` fails: the test still expects a 16 ms flush. I left it failing so you can decide whether the old timing is a contract.",
        "- The stream trace is 340 KiB; nothing in it points at a dropped chunk.",
      ].join("\n"),
    );
  });
}

function activityReadonlyScenario(emit: ActivityEmit, cwd: string) {
  return Effect.gen(function* () {
    yield* activityText(
      emit,
      "agent_thought_chunk",
      "Only questions here, so no edits. I will read the brief and the skill, then look at how the flush is wired.",
    );
    yield* Effect.sleep("120 millis");
    yield* activityText(
      emit,
      "agent_message_chunk",
      "Looking around without changing anything.\n\n",
    );
    yield* activityRead(
      emit,
      "/tmp/sk-cost-arch/brief.md",
      "# Cost architecture brief\n\nKeep render work proportional to visible rows.\n",
    );
    yield* activityRead(emit, `${cwd}/${ACTIVITY_SKILL}`);
    yield* activityCommand(emit, cwd, "sed -n 240,500p packages/core/src/chat/streaming.ts");
    for (const command of [
      "git log --oneline -5",
      "ls packages/core/src/chat",
      "wc -l packages/core/src/chat/streaming.ts",
      'grep -rn "MAX_BUFFERED_CHUNKS" packages',
      'grep -rn "flush" docs',
      "git diff --stat",
    ]) {
      yield* activityCommand(emit, cwd, command);
    }
    yield* activityText(
      emit,
      "agent_message_chunk",
      "The flush interval is defined in three places and documented once. Nothing was changed in this turn.",
    );
  });
}

function runActivityScenario(
  prompt: AcpSchema.PromptRequest["prompt"],
  cwd: string,
  emit: ActivityEmit,
) {
  const text = prompt.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
  const scenario = !text.includes("<user_request>")
    ? undefined
    : text.includes("SCENARIO:edit")
      ? activityEditScenario
      : text.includes("SCENARIO:readonly")
        ? activityReadonlyScenario
        : undefined;
  if (scenario === undefined) return activityText(emit, "agent_message_chunk", "Mock reply.");
  if (!ACTIVITY_SCRATCH_FILES.every((file) => NodeFS.existsSync(`${cwd}/${file}`))) {
    return activityText(
      emit,
      "agent_message_chunk",
      "The activity scenario runs only in the capture's scratch repository.",
    );
  }
  return scenario(emit, cwd);
}

const program = Effect.gen(function* () {
  const agent = yield* EffectAcpAgent.AcpAgent;
  const resumeRelease = yield* Deferred.make<void>();
  const nativeCancelRequested = yield* Deferred.make<void>();
  const nativeCancelRelease = yield* Deferred.make<void>();
  const publishAntigravityCommands = (targetSessionId: string) =>
    agent.client.sessionUpdate({
      sessionId: targetSessionId,
      update: {
        sessionUpdate: "available_commands_update",
        availableCommands: [
          { name: "plan", description: "Plan a task", input: { hint: "task" } },
          { name: "logout", description: "Sign out" },
        ],
      },
    });

  const finishPrompt = (
    targetSessionId: string,
    stopReason: AcpSchema.StopReason,
    _meta?: NonNullable<AcpSchema.PromptResponse["_meta"]>,
  ) =>
    agent.client
      .sessionUpdate({
        sessionId: targetSessionId,
        update: {
          sessionUpdate: "state_update",
          state: "idle",
          stopReason,
          ...(_meta === undefined ? {} : { _meta }),
        },
      })
      .pipe(Effect.as(_meta === undefined ? {} : { _meta }));

  yield* agent.handleInitialize((request) =>
    Effect.gen(function* () {
      if (floodStderr) {
        yield* Effect.promise(
          () =>
            new Promise<void>((resolve) => {
              process.stderr.write("stderr".repeat(350_000), () => resolve());
            }),
        );
      }
      parameterizedModelPicker = request.capabilities?._meta?.parameterizedModelPicker === true;
      return {
        protocolVersion: 2,
        info: { name: agentName, version: "0.0.0" },
        _meta: { modelState: modelState() },
        capabilities: {
          session: {
            ...(supportsSessionLifecycle ? { fork: {}, additionalDirectories: {} } : {}),
            ...(supportsV2Management ? { delete: {} } : {}),
            ...(supportsAcpMcp || supportsHttpMcp
              ? {
                  mcp: {
                    ...(supportsAcpMcp ? { acp: {} } : {}),
                    ...(supportsHttpMcp ? { http: {} } : {}),
                  },
                }
              : {}),
          },
          ...(supportsV2Management ? { providers: {} } : {}),
        },
        ...(initializeAuthMethodId
          ? {
              authMethods: [
                {
                  type: "agent" as const,
                  methodId: initializeAuthMethodId,
                  name: "Mock agent authentication",
                },
              ],
            }
          : {}),
      };
    }),
  );

  // Mirrors the real Antigravity agent: the API key method reads
  // GEMINI_API_KEY from the process environment and rejects when it is missing.
  yield* agent.handleAuthenticate((request) =>
    Effect.gen(function* () {
      if (antigravityProfile) {
        if (
          request.methodId !== "oauth-personal" &&
          !(request.methodId === "gemini-api-key" && process.env.GEMINI_API_KEY)
        ) {
          return yield* AcpError.AcpRequestError.invalidParams(
            `Mock Antigravity rejected auth method ${request.methodId}.`,
          );
        }
      } else if (advertisedAuthMethodId && request.methodId !== advertisedAuthMethodId) {
        return yield* AcpError.AcpRequestError.invalidParams(
          `Unknown mock authentication method: ${request.methodId}`,
        );
      }
      authenticated = true;
      return {};
    }),
  );
  if (antigravityProfile) {
    yield* agent.handleLogout(() => Effect.succeed({}));
  }

  yield* agent.handleLogout(() =>
    Effect.sync(() => {
      authenticated = false;
      return {};
    }),
  );

  const requireAuthentication = Effect.fn("acpMockAgent.requireAuthentication")(function* () {
    if (!authenticated) {
      return yield* AcpError.AcpRequestError.authRequired();
    }
  });

  yield* agent.handleCreateSession(() =>
    Effect.gen(function* () {
      yield* requireAuthentication();
      if (antigravityProfile) {
        yield* publishAntigravityCommands(sessionId);
      }
      if (commandAdvertisementDelayMs >= 0) {
        yield* Effect.sleep(`${commandAdvertisementDelayMs} millis`).pipe(
          Effect.andThen(
            agent.client.sessionUpdate({
              sessionId,
              update: {
                sessionUpdate: "available_commands_update",
                availableCommands: [
                  {
                    name: "review",
                    description: "Review the current changes",
                    input: { type: "text", hint: "focus" },
                  },
                  {
                    name: "$workspace-skill",
                    description: "Run the workspace skill",
                    input: null,
                  },
                ],
              },
            }),
          ),
          Effect.forkDetach,
        );
      }
      return {
        sessionId,
        configOptions: configOptions(),
      };
    }),
  );

  yield* agent.handleResumeSession((request) =>
    Effect.gen(function* () {
      yield* requireAuthentication();
      yield* agent.client.sessionUpdate({
        sessionId: request.sessionId,
        update: {
          sessionUpdate: "user_message_chunk",
          content: { type: "text", text: "native-resume-started" },
        },
      });
      if (waitForResumeRelease) {
        yield* Deferred.await(resumeRelease);
      }
      if (antigravityProfile) {
        yield* publishAntigravityCommands(request.sessionId);
      }
      return {
        modes: modeState(),
        models: modelState(),
        configOptions: configOptions(),
        _meta: { nativeResume: true },
      };
    }),
  );

  const emitLoadReplayNotifications = (requestedSessionId: string) => {
    writeJsonRpcNotification("session/update", {
      _meta: { isReplay: true },
      sessionId: requestedSessionId,
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "replay-tool-1",
        title: "Replay tool",
        kind: "search",
        status: "completed",
      },
    });
    writeJsonRpcNotification("session/update", {
      _meta: { isReplay: true },
      sessionId: requestedSessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        messageId: "mock-agent-message",
        content: { type: "text", text: "replayed assistant text" },
      },
    });
  };

  yield* agent.handleLoadSession((request) =>
    Effect.gen(function* () {
      const requestedSessionId = String(request.sessionId ?? sessionId);
      if (failLoadSession) {
        return yield* AcpError.AcpRequestError.internalError("Mock load session failure");
      }
      if (failLoadSessionAfterConfigReplay) {
        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "config_option_update",
            configOptions: [
              {
                configId: "candidate-only",
                name: "Candidate only",
                type: "boolean",
                currentValue: true,
              },
            ],
          },
        });
        return yield* AcpError.AcpRequestError.internalError(
          "Mock load session failure after config replay",
        );
      }
      if (hangLoadSessionAfterReplay || delayLoadSessionAfterReplay) {
        emitLoadReplayNotifications(requestedSessionId);
        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "user_message_chunk",
            messageId: "mock-user-message",
            content: { type: "text", text: "replay-tail" },
          },
        });
        yield* Effect.sleep(loadSessionDelayMs);
        return {
          configOptions: configOptions(),
        };
      }
      if (emitLoadReplay) {
        emitLoadReplayNotifications(requestedSessionId);
      }
      yield* agent.client.sessionUpdate({
        sessionId: requestedSessionId,
        update: {
          sessionUpdate: "user_message_chunk",
          messageId: "mock-user-message",
          content: { type: "text", text: "replay" },
        },
      });
      return {
        configOptions: configOptions(),
      };
    }),
  );

  if (!omitSessionListHandler) {
    yield* agent.handleListSessions((request) =>
      Effect.gen(function* () {
        yield* requireAuthentication();
        return {
          sessions: [
            {
              sessionId,
              cwd: request.cwd ?? process.cwd(),
              title: "Mock session",
              updatedAt: "1970-01-01T00:00:00.000Z",
            },
          ],
        };
      }),
    );
  }

  yield* agent.handleForkSession((request) =>
    Effect.gen(function* () {
      yield* requireAuthentication();
      return {
        sessionId: `${request.sessionId}-fork`,
        configOptions: configOptions(),
      };
    }),
  );

  yield* agent.handleCloseSession(() =>
    Effect.gen(function* () {
      yield* requireAuthentication();
      return {};
    }),
  );

  yield* agent.handleDeleteSession(() =>
    Effect.gen(function* () {
      yield* requireAuthentication();
      return {};
    }),
  );

  yield* agent.handleListProviders(() =>
    Effect.gen(function* () {
      yield* requireAuthentication();
      return {
        providers: [
          {
            providerId: "mock-provider",
            supported: ["openai", "anthropic"],
            required: false,
            current: configuredProvider,
          },
        ],
      };
    }),
  );

  yield* agent.handleSetProvider((request) =>
    Effect.gen(function* () {
      yield* requireAuthentication();
      configuredProvider = { apiType: request.apiType, baseUrl: request.baseUrl };
      return {};
    }),
  );

  yield* agent.handleDisableProvider(() =>
    Effect.gen(function* () {
      yield* requireAuthentication();
      configuredProvider = null;
      return {};
    }),
  );

  yield* agent.handleSetSessionConfigOption((request) =>
    Effect.gen(function* () {
      if (exitOnSetConfigOption) {
        return yield* Effect.sync(() => {
          process.exit(7);
        });
      }
      if (failSetConfigOption) {
        return yield* AcpError.AcpRequestError.invalidParams(
          "Mock invalid params for session/set_config_option",
          {
            method: "session/set_config_option",
            params: request,
          },
        );
      }
      if (request.configId === "mode" && typeof request.value === "string") {
        currentModeId = request.value;
      }
      if (request.configId === "model" && typeof request.value === "string") {
        currentModelId = request.value;
      }
      if (request.configId === "reasoning" && typeof request.value === "string") {
        currentReasoning = request.value;
      }
      if (request.configId === "context" && typeof request.value === "string") {
        currentContext = request.value;
      }
      if (request.configId === "fast") {
        currentFast = request.value === true || request.value === "true";
      }
      return {
        configOptions: configOptions(),
      };
    }),
  );

  yield* agent.handleCancel(({ sessionId }) =>
    Effect.gen(function* () {
      const cancelledSessionId = String(sessionId ?? "mock-session-1");
      cancelledSessions.add(cancelledSessionId);
      if (exitOnCancel) {
        return yield* Effect.sync(() => process.exit(0));
      }
      if (completeFirstPromptOnCancel) {
        yield* Deferred.succeed(nativeCancelRequested, undefined);
        yield* agent.client.sessionUpdate({
          sessionId: cancelledSessionId,
          update: {
            sessionUpdate: "agent_thought_chunk",
            content: { type: "text", text: "native-cancel-received" },
          },
        });
      }
      if (emitLateUpdateAfterCancel) {
        yield* Effect.sleep("50 millis");
        yield* Effect.sync(() => {
          writeJsonRpcNotification("session/update", {
            sessionId: cancelledSessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              messageId: "mock-agent-message",
              content: { type: "text", text: "late after cancel" },
            },
          });
        });
      }
      if (emitTaskBackgroundedAfterCancel) {
        // Grok cancel-as-detach: the foreground command is re-run as a
        // background task that later completes on its own.
        yield* Effect.sync(() => {
          writeJsonRpcNotification("_x.ai/task_backgrounded", {
            sessionId: cancelledSessionId,
            update: {
              sessionUpdate: "task_backgrounded",
              tool_call_id: "task-bg-1",
              task_id: "task-bg-1",
              command: "sleep 30",
            },
          });
        });
        yield* Effect.sleep("1200 millis")
          .pipe(
            Effect.andThen(
              Effect.sync(() => {
                writeJsonRpcNotification("_x.ai/task_completed", {
                  sessionId: cancelledSessionId,
                  update: {
                    sessionUpdate: "task_completed",
                    task_snapshot: { task_id: "task-bg-1", command: "sleep 30" },
                  },
                });
              }),
            ),
          )
          .pipe(Effect.forkDetach);
      }
    }),
  );

  yield* agent.handlePrompt((request) =>
    Effect.gen(function* () {
      const requestedSessionId = String(request.sessionId ?? sessionId);
      beginAcpMockPrompt(cancelledSessions, requestedSessionId);
      promptCount += 1;
      if (
        process.env.STUDIO_ACP_CRASH_PROMPT === "1" &&
        request.prompt.some((part) => part.type === "text" && part.text === "crash now")
      ) {
        return yield* Effect.sync(() => process.exit(23));
      }

      if (activityScenario) {
        // A local acpRegistry agent is spawned in the session cwd.
        yield* runActivityScenario(request.prompt, process.cwd(), (update) =>
          agent.client.sessionUpdate({ sessionId: requestedSessionId, update }),
        );
        return yield* finishPrompt(requestedSessionId, "end_turn");
      }

      if (clientFsProbePath !== undefined && clientFsProbeLogPath !== undefined) {
        const probes = [
          [
            "fs/write_text_file",
            { sessionId: requestedSessionId, path: clientFsProbePath, content: "probe" },
          ],
          ["fs/read_text_file", { sessionId: requestedSessionId, path: clientFsProbePath }],
        ] as const;
        for (const [method, params] of probes) {
          const outcome = yield* agent.raw.request(method, params).pipe(
            Effect.map((result) => ({ method, result })),
            Effect.catch((error) =>
              Effect.succeed({
                method,
                errorCode: error._tag === "AcpRequestError" ? error.code : error._tag,
              }),
            ),
          );
          NodeFS.appendFileSync(clientFsProbeLogPath, `${encodeJson(outcome)}\n`, "utf8");
        }
      }

      if (vibeRetryOutcome !== undefined) {
        if (vibeRetryOutcome === "recovered") {
          yield* Effect.sync(() =>
            writeJsonRpcNotification("session/update", {
              sessionId: requestedSessionId,
              update: {
                sessionUpdate: "tool_call",
                toolCallId: "tool-before-retry",
                title: "Read file",
                kind: "read",
                status: "in_progress",
              },
            }),
          );
        }
        for (const [index, noticeSessionId] of [
          "unrelated-session",
          requestedSessionId,
          requestedSessionId,
        ].entries()) {
          // Progress from an earlier tool must not end the retry.
          if (index === 2 && vibeRetryOutcome === "recovered") {
            yield* Effect.sync(() =>
              writeJsonRpcNotification("session/update", {
                sessionId: requestedSessionId,
                update: {
                  sessionUpdate: "tool_call_update",
                  toolCallId: "tool-before-retry",
                  status: "in_progress",
                  rawOutput: { progress: "still reading" },
                },
              }),
            );
          }
          yield* Effect.sync(() =>
            writeJsonRpcNotification("_session/retrying", {
              sessionId: noticeSessionId,
              category: "rate_limited",
              detail: "Rate limit reached. Retrying. api_key=private-key",
            }),
          );
        }
        if (vibeRetryOutcome === "failed") {
          return yield* new AcpError.AcpRequestError({
            code: -31001,
            errorMessage: "Rate limit exceeded for mistral (model: mistral-vibe-cli-latest).",
          });
        }
        if (vibeRetryOutcome === "completed") {
          return yield* finishPrompt(requestedSessionId, "end_turn");
        }
        if (vibeRetryOutcome === "cancelled") {
          return yield* finishPrompt(requestedSessionId, "cancelled");
        }
        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "Recovered answer" },
          },
        });
        return yield* finishPrompt(requestedSessionId, "end_turn");
      }

      if (emitV2Fidelity) {
        yield* agent.client.sessionUpdate({
          sessionId: `${requestedSessionId}-child`,
          update: {
            sessionUpdate: "terminal_update",
            terminalId: "standalone-terminal",
            command: "printf child",
            output: { data: Buffer.from("child").toString("base64") },
          },
        });
        const updates: ReadonlyArray<AcpSchema.SessionUpdate> = [
          {
            sessionUpdate: "user_message_chunk",
            messageId: "user-1",
            content: { type: "text", text: "stale user text" },
          },
          { sessionUpdate: "user_message", messageId: "user-1", content: null },
          {
            sessionUpdate: "agent_thought_chunk",
            messageId: "thought-1",
            content: { type: "text", text: "stale thought" },
          },
          {
            sessionUpdate: "agent_message_chunk",
            messageId: "assistant-1",
            content: { type: "text", text: "interleaved answer" },
          },
          {
            sessionUpdate: "agent_message",
            messageId: "assistant-1",
            content: [{ type: "text", text: "authoritative answer" }],
          },
          { sessionUpdate: "agent_message", messageId: "assistant-1" },
          {
            sessionUpdate: "agent_thought",
            messageId: "thought-1",
            content: [{ type: "text", text: "final thought" }],
          },
          {
            sessionUpdate: "plan_update",
            plan: { type: "markdown", planId: "plan-a", content: "# Plan A" },
          },
          {
            sessionUpdate: "plan_update",
            plan: {
              type: "items",
              planId: "plan-b",
              entries: [{ content: "Ship B", priority: "high", status: "in_progress" }],
            },
          },
          { sessionUpdate: "plan_removed", planId: "plan-a" },
          {
            sessionUpdate: "terminal_update",
            terminalId: "standalone-terminal",
            command: "printf proof",
            cwd: process.cwd(),
          },
          {
            sessionUpdate: "terminal_output_chunk",
            terminalId: "standalone-terminal",
            data: Buffer.from("proof").toString("base64"),
          },
          {
            sessionUpdate: "terminal_update",
            terminalId: "standalone-terminal",
            exitStatus: { exitCode: 0 },
          },
          { sessionUpdate: "state_update", state: "requires_action" },
          { sessionUpdate: "state_update", state: "running" },
          {
            sessionUpdate: "tool_call_update",
            toolCallId: "structured-diff",
            title: "Edit files",
            kind: "edit",
            status: "completed",
            content: [
              {
                type: "diff",
                changes: [
                  {
                    operation: "move",
                    oldPath: "/workspace/old.ts",
                    path: "/workspace/new.ts",
                    fileType: "text",
                    mimeType: "text/typescript",
                  },
                ],
                patch: {
                  format: "git_patch",
                  text: "diff --git a/old.ts b/new.ts\nrename from old.ts\nrename to new.ts\n",
                },
              },
            ],
          },
          {
            sessionUpdate: "tool_call_update",
            toolCallId: "structured-read",
            title: "Read `src/env.ts`",
            kind: "read",
            status: "completed",
            rawInput: { path: "src/env.ts" },
            locations: [{ path: "src/env.ts" }],
          },
          {
            sessionUpdate: "tool_call_update",
            toolCallId: "structured-search",
            title: "Grep",
            kind: "search",
            status: "completed",
            rawInput: { query: "TODO", path: "apps/web" },
          },
          // Grok backend searches: the query only arrives in the completed rawOutput.
          {
            sessionUpdate: "tool_call_update",
            toolCallId: "grok-x-search",
            title: "X search:",
            kind: "search",
            status: "in_progress",
            rawInput: { variant: "XSearch", backend: true },
          },
          {
            sessionUpdate: "tool_call_update",
            toolCallId: "grok-x-search",
            title: "X search:",
            status: "completed",
            rawOutput: {
              call_id: "xs_call-1",
              input: '{"query":"conversation_id:42","limit":"10","mode":"Latest"}',
              name: "x_keyword_search",
              id: "grok-x-search",
            },
          },
          {
            sessionUpdate: "tool_call_update",
            toolCallId: "grok-web-search",
            title: "Web search:",
            kind: "search",
            status: "completed",
            rawInput: { variant: "WebSearch", backend: true },
            rawOutput: {
              action: {
                type: "search",
                query: "specweave-studio code",
                sources: [
                  { type: "url", url: "https://studio.invalid" },
                  { type: "url", url: "https://studio.invalid" },
                  { type: "url", url: "https://github.com/anton-abyzov/specwithcode" },
                ],
              },
              id: "grok-web-search",
              status: "completed",
            },
          },
          {
            sessionUpdate: "tool_call_update",
            toolCallId: "grok-web-fetch",
            title: "Fetch: https://studio.invalid",
            kind: "fetch",
            status: "completed",
            rawInput: { variant: "WebFetch", url: "https://studio.invalid" },
            rawOutput: {
              type: "WebFetch",
              Content: { url: "https://studio.invalid", content: "SpecWithCode page" },
            },
            content: [{ type: "content", content: { type: "text", text: "SpecWithCode page" } }],
          },
          {
            sessionUpdate: "tool_call_update",
            toolCallId: "antigravity-shell",
            title: "run_command",
            kind: "execute",
            status: "completed",
            rawInput: { command: "cat probe.txt" },
            rawOutput: { commandLine: "cat probe.txt", exitCode: 0, combinedOutput: "after\n" },
          },
          {
            sessionUpdate: "compaction_update",
            compactionId: "compact-1",
            status: "in_progress",
          },
          {
            sessionUpdate: "compaction_summary_chunk",
            compactionId: "compact-1",
            content: { type: "text", text: "Retained decisions." },
          },
          {
            sessionUpdate: "compaction_update",
            compactionId: "compact-1",
            status: "completed",
            summary: [{ type: "text", text: "Retained decisions." }],
          },
        ];
        for (const update of updates) {
          yield* agent.client.sessionUpdate({ sessionId: requestedSessionId, update });
        }
        return yield* finishPrompt(requestedSessionId, "end_turn");
      }

      if (residualCallbackTriggerPath !== undefined) {
        yield* Effect.gen(function* () {
          while (!(yield* Effect.sync(() => NodeFS.existsSync(residualCallbackTriggerPath)))) {
            yield* Effect.sleep("20 millis");
          }
          yield* Effect.sync(() => {
            writeJsonRpcNotification("session/update", {
              sessionId: requestedSessionId,
              update: {
                sessionUpdate: "agent_message_chunk",
                messageId: "mock-agent-message",
                content: { type: "text", text: "residual assistant callback" },
              },
            });
            writeJsonRpcNotification("session/update", {
              sessionId: requestedSessionId,
              update: {
                sessionUpdate: "tool_call_update",
                toolCallId: "residual-tool-call",
                title: "Residual tool callback",
                kind: "other",
                status: "pending",
                rawInput: {},
              },
            });
            writeJsonRpcNotification("session/update", {
              sessionId: requestedSessionId,
              update: {
                sessionUpdate: "plan_update",
                plan: {
                  type: "items",
                  planId: "mock-plan",
                  entries: [
                    { content: "Residual plan callback", priority: "high", status: "pending" },
                  ],
                },
              },
            });
          });
          yield* agent.client
            .requestPermission({
              sessionId: requestedSessionId,
              title: "Residual permission callback",
              subject: {
                type: "tool_call",
                toolCall: {
                  toolCallId: "residual-permission",
                  title: "Residual permission callback",
                },
              },
              options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
            })
            .pipe(
              Effect.exit,
              Effect.tap(() => Effect.sync(() => logResidualCallbackResponse("permission"))),
              Effect.ignore,
              Effect.forkDetach,
            );
          yield* agent.client
            .elicit({
              sessionId: requestedSessionId,
              message: "Residual elicitation callback",
              mode: "form",
              requestedSchema: {
                type: "object",
                properties: {
                  approved: { type: "boolean", title: "Approved" },
                },
              },
            })
            .pipe(
              Effect.exit,
              Effect.tap(() => Effect.sync(() => logResidualCallbackResponse("elicitation"))),
              Effect.ignore,
              Effect.forkDetach,
            );
          if (exitAfterResidualCallbacks) {
            yield* Effect.sleep("100 millis");
            return yield* Effect.sync(() => process.exit(0));
          }
        }).pipe(Effect.forkDetach);
      }
      if (completeFirstPromptOnCancel && promptCount === 1) {
        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: "native-cancel-tool",
            title: "Long command",
            kind: "execute",
            status: "in_progress",
          },
        });
        yield* Deferred.await(nativeCancelRequested);
        yield* Deferred.await(nativeCancelRelease);
        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: "native-cancel-tool",
            status: "failed",
            content: [{ type: "content", content: { type: "text", text: "Cancelled." } }],
          },
        });
        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "Request cancelled." },
          },
        });
        return yield* finishPrompt(requestedSessionId, "cancelled", { nativeCancel: true });
      }

      if (Number.isFinite(promptDelayMs) && promptDelayMs > 0) {
        yield* Effect.sleep(`${promptDelayMs} millis`);
      }

      if (failPrompt) {
        return yield* AcpError.AcpRequestError.internalError(
          failPromptMessage ?? "Mock prompt failure",
        );
      }

      if (emitStaleXAiPromptCompleteBeforeSecondHang && promptCount === 1) {
        return yield* finishPrompt(requestedSessionId, "end_turn", {
          promptId: "mock-stale-xai-prompt-1",
          requestId: "mock-stale-xai-prompt-1",
        });
      }

      if (emitStaleXAiPromptCompleteBeforeSecondHang && promptCount === 2) {
        const currentPromptId = promptIdFromRequestMeta(request) ?? "mock-current-xai-prompt-2";
        writeJsonRpcNotification("_x.ai/session/prompt_complete", {
          sessionId: requestedSessionId,
          promptId: "mock-stale-xai-prompt-1",
          stopReason: "end_turn",
          agentResult: null,
        });

        writeJsonRpcNotification("_x.ai/session/prompt_complete", {
          sessionId: requestedSessionId,
          promptId: currentPromptId,
          stopReason: "end_turn",
          agentResult: null,
        });

        return yield* Effect.never;
      }

      if (emitOverlappingXAiPromptCompleteOutOfOrder && promptCount === 1) {
        overlappingFirstPromptId = promptIdFromRequestMeta(request);
        return yield* Effect.never;
      }

      if (emitOverlappingXAiPromptCompleteOutOfOrder && promptCount === 2) {
        const secondPromptId = promptIdFromRequestMeta(request);
        if (overlappingFirstPromptId !== undefined && secondPromptId !== undefined) {
          writeJsonRpcNotification("_x.ai/session/prompt_complete", {
            sessionId: requestedSessionId,
            promptId: secondPromptId,
            stopReason: "end_turn",
            agentResult: null,
          });
          writeJsonRpcNotification("_x.ai/session/prompt_complete", {
            sessionId: requestedSessionId,
            promptId: overlappingFirstPromptId,
            stopReason: "end_turn",
            agentResult: null,
          });
        }
        return yield* Effect.never;
      }

      if (
        hangPromptForever ||
        (hangFirstPromptForever && promptCount === 1) ||
        (emitEmptySuccessfulBashThenHang && promptCount === 2)
      ) {
        return yield* Effect.never;
      }

      if (
        emitRunningCommandThenHang ||
        (emitRunningCommandThenHangOnFirstPrompt && promptCount === 1)
      ) {
        const toolCallId = "tool-call-running-1";
        if (runningCommandPidPath !== undefined) {
          const command = runningCommandIgnoresTerm
            ? 'trap "" TERM; bash -c \'trap "" TERM; while :; do sleep 1; done\' & child=$!; printf "%s %s\n" "$$" "$child" > "$1"; wait "$child"'
            : 'sleep 120 & child=$!; printf "%s %s\n" "$$" "$child" > "$1"; wait "$child"';
          if (runningCommandSeparateSession) {
            const launcher = [
              'const { spawn } = require("node:child_process");',
              "const child = spawn(process.argv[1], process.argv.slice(2), { stdio: 'ignore' });",
              "child.once('exit', (code, signal) => process.exitCode = code ?? (signal ? 1 : 0));",
            ].join(" ");
            const detachedCommand = runningCommandIgnoresTerm
              ? 'trap "" TERM; bash -c \'trap "" TERM; while :; do sleep 1; done\' & child=$!; printf "%s %s %s\n" "$PPID" "$$" "$child" > "$1"; wait "$child"'
              : 'sleep 120 & child=$!; printf "%s %s %s\n" "$PPID" "$$" "$child" > "$1"; wait "$child"';
            // Nested bash publishes "$PPID $$ $child" once it starts. Do not
            // write the launcher PID alone here: that races with bash and can
            // clobber the triple that interrupt tests wait for.
            const detachedLauncher = NodeChildProcess.spawn(
              process.execPath,
              ["-e", launcher, "bash", "-c", detachedCommand, "bash", runningCommandPidPath],
              { detached: true, stdio: "ignore" },
            );
            detachedLauncher.unref();
          } else if (process.platform === "win32") {
            // Git Bash reports MSYS PIDs, not Windows ones, so on Windows the
            // root and its long-running child are Node processes.
            const windowsCommand = [
              'const { spawn } = require("node:child_process");',
              "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
              'require("node:fs").writeFileSync(process.argv[1], `${process.pid} ${child.pid}\\n`);',
              "child.once('exit', () => process.exit());",
            ].join(" ");
            NodeChildProcess.spawn(
              process.execPath,
              ["-e", windowsCommand, runningCommandPidPath],
              {
                stdio: "ignore",
              },
            );
          } else {
            NodeChildProcess.spawn("bash", ["-c", command, "bash", runningCommandPidPath], {
              stdio: "ignore",
            });
          }
        }
        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId,
            title: "Terminal",
            kind: "execute",
            status: "pending",
            rawInput: {
              command: ["sleep", "120"],
            },
          },
        });
        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId,
            title: "Terminal",
            kind: "execute",
            status: "in_progress",
            rawInput: {
              command: ["sleep", "120"],
            },
            // Grok-like mid-stream Bash re-report: exit_code 0 while still running.
            rawOutput: { type: "Bash", exit_code: 0 },
          },
        });
        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: "tool-call-output-1",
            title: "get_command_or_subagent_output",
            kind: "other",
            status: "pending",
            rawInput: { task_id: "task-running-1" },
          },
        });
        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: "tool-call-output-1",
            status: "in_progress",
            rawOutput: { task_id: "task-running-1", status: "running" },
          },
        });
        if (exitAfterRunningCommandLaunch) {
          yield* Effect.sleep("100 millis");
          return yield* Effect.sync(() => process.exit(0));
        }
        // Stay open until session/cancel so interrupt tests can observe a running tool.
        while (!cancelledSessions.has(requestedSessionId)) {
          yield* Effect.sleep("25 millis");
        }
        cancelledSessions.delete(requestedSessionId);
        return yield* finishPrompt(requestedSessionId, "cancelled");
      }

      if (emitXAiRateLimitThenHang) {
        writeJsonRpcNotification("_x.ai/session/prompt_complete", {
          sessionId: requestedSessionId,
          promptId: promptIdFromRequestMeta(request) ?? "mock-xai-rate-limit-prompt-1",
          stopReason: "rate_limit",
          agentResult: null,
        });
        return yield* Effect.never;
      }

      if (emitContentThenHang) {
        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "partial before stall" },
          },
        });
        return yield* Effect.never;
      }

      if (emitPlanThenHang) {
        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "plan",
            entries: [
              {
                content: "Wait for more ACP progress",
                priority: "high",
                status: "in_progress",
              },
            ],
          },
        });
        return yield* Effect.never;
      }

      if (emitActiveToolThenHang) {
        const toolCallId = "tool-call-long-running-1";
        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId,
            title: "Long-running tool",
            kind: "execute",
            status: "pending",
            rawInput: { command: ["long-running-tool"] },
          },
        });
        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId,
            status: "in_progress",
          },
        });
        return yield* Effect.never;
      }
      if (emitEmptySuccessfulBash || (emitEmptySuccessfulBashThenHang && promptCount === 1)) {
        const update = {
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: "tool-call-empty-success-1",
            title: "Terminal",
            kind: "execute",
            status: "completed",
            rawInput: { command: "true" },
            rawOutput: { type: "Bash", exit_code: 0 },
          },
        } as const;
        yield* agent.client.sessionUpdate(update);
        yield* Effect.sleep("25 millis");
        yield* agent.client.sessionUpdate(update);
        return yield* finishPrompt(requestedSessionId, "end_turn");
      }

      if (emitXAiPromptCompleteThenHang) {
        writeJsonRpcNotification("session/update", {
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            messageId: "mock-agent-message",
            content: { type: "text", text: "hello from" },
          },
        });

        if (emitForeignSessionUpdates) {
          writeJsonRpcNotification("session/update", {
            sessionId: "mock-child-session-1",
            update: {
              sessionUpdate: "agent_message_chunk",
              messageId: "mock-agent-message",
              content: { type: "text", text: "child before completion" },
            },
          });
        }

        writeJsonRpcNotification("_x.ai/session/prompt_complete", {
          sessionId: requestedSessionId,
          promptId: promptIdFromRequestMeta(request) ?? "mock-xai-prompt-1",
          ...(omitXAiPromptCompleteStopReason ? {} : { stopReason: "end_turn" }),
          agentResult: null,
        });

        if (emitForeignSessionUpdates) {
          writeJsonRpcNotification("session/update", {
            sessionId: "mock-child-session-1",
            update: {
              sessionUpdate: "tool_call_update",
              toolCallId: "child-tool-call-1",
              title: "Child-only tool",
              kind: "other",
              status: "pending",
              rawInput: {},
            },
          });
          writeJsonRpcNotification("session/update", {
            sessionId: "mock-child-session-1",
            update: {
              sessionUpdate: "agent_message_chunk",
              messageId: "mock-agent-message",
              content: { type: "text", text: "child after completion" },
            },
          });
        }

        for (const text of [" ", "mo", "ck"]) {
          writeJsonRpcNotification("session/update", {
            sessionId: requestedSessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              messageId: "mock-agent-message",
              content: { type: "text", text },
            },
          });
        }

        return yield* Effect.never;
      }

      if (emitGrokMonitorPostTurnPoll) {
        const monitorCallId = "call-monitor-1";
        const pollCallId = "call-monitor-poll-1";
        const taskId = "01a05f41-5107-7550-821e-79e8d1cd7687";
        const description = "Watch count-sheet Typst unit until done";
        writeJsonRpcNotification("session/update", {
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "tool_call",
            toolCallId: monitorCallId,
            title: "monitor",
            kind: "other",
            status: "pending",
            rawInput: { description },
            _meta: {
              "x.ai/tool": { version: 1, name: "monitor", kind: "task", namespace: "grok_build" },
            },
          },
        });
        writeJsonRpcNotification("session/update", {
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: monitorCallId,
            status: "completed",
            rawInput: { description },
            rawOutput: {
              type: "Monitor",
              taskId,
              timeoutMs: 36_000_000,
            },
          },
        });
        writeJsonRpcNotification("_x.ai/session/prompt_complete", {
          sessionId: requestedSessionId,
          promptId: promptIdFromRequestMeta(request) ?? "mock-xai-prompt-1",
          stopReason: "end_turn",
          agentResult: null,
        });
        yield* Effect.sleep("120 millis");
        writeJsonRpcNotification("session/update", {
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "tool_call",
            toolCallId: pollCallId,
            title: "get_command_or_subagent_output",
            kind: "other",
            status: "completed",
            rawInput: { variant: "TaskOutput", task_ids: [taskId], timeout_ms: 0 },
            rawOutput: {
              type: "TaskOutput",
              Result: {
                task_id: taskId,
                command: `[monitor] ${description}`,
                status: "completed",
                exit_code: 0,
                output: "Monitor finished.",
              },
            },
          },
        });
        return yield* Effect.never;
      }

      if (emitGrokBackgroundTaskStarted) {
        const toolCallId = "call-fb9d0000-0000-0000-0000-000000000026";
        const command = "sleep 40; echo done-a";
        writeJsonRpcNotification("session/update", {
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "tool_call",
            toolCallId,
            title: "run_terminal_command",
            kind: "execute",
            status: "in_progress",
            rawInput: { command },
          },
        });
        writeJsonRpcNotification("session/update", {
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId,
            status: "completed",
            rawOutput: {
              type: "BackgroundTaskStarted",
              task_id: toolCallId,
              task_type: "bash",
              status: "running",
              command,
            },
          },
        });
        writeJsonRpcNotification("_x.ai/session/prompt_complete", {
          sessionId: requestedSessionId,
          promptId: promptIdFromRequestMeta(request) ?? "mock-xai-prompt-1",
          stopReason: "end_turn",
          agentResult: null,
        });
        return yield* Effect.never;
      }

      if (emitBackgroundToolDuringAnswer) {
        // A command backgrounded earlier reports progress and then finishes
        // while the next answer is still streaming.
        const toolCallId = "background-1";
        const say = (text: string) =>
          agent.client.sessionUpdate({
            sessionId: requestedSessionId,
            update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
          });
        const progress = (status: "in_progress" | "completed", stdout: string) =>
          agent.client.sessionUpdate({
            sessionId: requestedSessionId,
            update: {
              sessionUpdate: "tool_call_update",
              toolCallId,
              status,
              rawOutput: { stdout },
            },
          });
        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId,
            title: "Terminal",
            kind: "execute",
            status: "in_progress",
            rawInput: { command: "sleep 3 && echo done" },
          },
        });
        yield* say("| a | b |\n|---|---|\n| 1 ");
        yield* progress("in_progress", ".");
        yield* say("| x |\n");
        yield* progress("completed", "done");
        yield* say("| 2 | y |\n");
        // Agents can repeat a terminal update after the call finished.
        yield* progress("completed", "done");
        yield* say("| 3 | z |");
        return yield* finishPrompt(requestedSessionId, "end_turn");
      }

      if (emitInterleavedAssistantToolCalls) {
        const toolCallId = "tool-call-1";

        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            messageId: "mock-agent-message",
            content: { type: "text", text: "before tool" },
          },
        });

        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId,
            title: "Terminal",
            kind: "execute",
            status: "pending",
            rawInput: {
              command: ["echo", "hello"],
            },
          },
        });

        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId,
            status: "completed",
            rawOutput: {
              exitCode: 0,
              stdout: "hello",
              stderr: "",
            },
          },
        });

        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            messageId: "mock-agent-message",
            content: { type: "text", text: "after tool" },
          },
        });

        return yield* finishPrompt(requestedSessionId, "end_turn");
      }

      if (emitElicitation || emitMcpToolApprovalElicitation) {
        yield* agent.client.elicit({
          sessionId: requestedSessionId,
          message: "Approve this request?",
          mode: "form",
          requestedSchema: {
            type: "object",
            properties: {
              approved: { type: "boolean", title: "Approved" },
            },
          },
          ...(emitMcpToolApprovalElicitation
            ? { _meta: { codex_approval_kind: "mcp_tool_call" } }
            : {}),
        });
        return yield* finishPrompt(requestedSessionId, "end_turn");
      }

      if (emitUrlElicitation) {
        yield* agent.client.elicit({
          sessionId: requestedSessionId,
          message: "Open authentication page",
          mode: "url",
          url: "https://example.com/auth",
          elicitationId: "url-elicitation-1",
        });
        return yield* finishPrompt(requestedSessionId, "end_turn");
      }

      if (emitToolCalls) {
        const toolCallId = "tool-call-1";

        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId,
            title: "Terminal",
            kind: "execute",
            status: "pending",
            rawInput: {
              command: ["cat", "server/package.json"],
            },
          },
        });

        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId,
            status: "in_progress",
          },
        });

        const permissionOptions: Array<AcpSchema.PermissionOption> = [
          { optionId: permissionOptionIds.allowOnce, name: "Allow once", kind: "allow_once" },
          ...(omitAllowAlways
            ? []
            : [
                {
                  optionId: permissionOptionIds.allowAlways,
                  name: "Allow always",
                  kind: "allow_always" as const,
                },
              ]),
          { optionId: permissionOptionIds.rejectOnce, name: "Reject", kind: "reject_once" },
        ];

        let cancelled = cancelledSessions.delete(requestedSessionId);
        for (let index = 0; index < permissionRequestCount; index++) {
          const command =
            index > 0
              ? (process.env.STUDIO_ACP_SECOND_PERMISSION_COMMAND ?? "cat server/package.json")
              : "cat server/package.json";
          const permission = yield* agent.client.requestPermission({
            sessionId: requestedSessionId,
            title: process.env.STUDIO_ACP_PERMISSION_TITLE ?? `\`${command}\``,
            subject: {
              type: "tool_call",
              toolCall: {
                toolCallId: index === 0 ? toolCallId : `${toolCallId}-${index + 1}`,
                title: process.env.STUDIO_ACP_PERMISSION_TITLE ?? `\`${command}\``,
                kind: "execute",
                status: "pending",
                rawInput: {
                  variant: "Bash",
                  command,
                  description: index === 0 ? "Read package metadata" : "Read it again",
                },
                content: [
                  {
                    type: "content",
                    content: {
                      type: "text",
                      text: `Not in allowlist: ${command}`,
                    },
                  },
                ],
              },
            },
            options: permissionOptions,
          });
          cancelled =
            cancelled ||
            cancelledSessions.delete(requestedSessionId) ||
            permission.outcome.outcome === "cancelled";
          if (cancelled) {
            break;
          }
        }

        if (hangAfterPermission) {
          return yield* Effect.never;
        }

        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId,
            title: "Terminal",
            kind: "execute",
            status: "completed",
            rawOutput: {
              exitCode: 0,
              stdout: '{ "name": "specweave-studio" }',
              stderr: "",
            },
          },
        });

        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            messageId: "mock-agent-message",
            content: { type: "text", text: promptResponseText ?? "hello from mock" },
          },
        });

        return yield* finishPrompt(requestedSessionId, cancelled ? "cancelled" : "end_turn");
      }

      if (emitGenericToolPlaceholders) {
        const toolCallId = "tool-call-generic-1";

        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId,
            title: "Read File",
            kind: "read",
            status: "pending",
            rawInput: {},
          },
        });

        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId,
            status: "in_progress",
          },
        });

        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId,
            status: "completed",
            rawOutput: {
              content: "package.json\n",
            },
          },
        });

        return yield* finishPrompt(requestedSessionId, "end_turn");
      }

      // In-turn monitor + TaskOutput hydrate, then a late post-finalize
      // duplicate terminal TaskOutput for the same task. Exercises the
      // already-handled short-circuit: must not pin hasPendingBackgroundWork.
      if (emitInTurnTaskOutputThenLateDuplicate) {
        const monitorToolCallId = "tool-call-monitor-1";
        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: monitorToolCallId,
            title: "Monitor: mock background task",
            kind: "execute",
            status: "pending",
            rawInput: {},
          },
        });
        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: monitorToolCallId,
            status: "in_progress",
          },
        });
        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: "tool-call-fetch-1",
            title: "get_command_or_subagent_output",
            kind: "other",
            status: "pending",
            rawInput: { task_id: "task-monitor-1" },
          },
        });
        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: "tool-call-fetch-1",
            status: "completed",
            rawOutput: { output: "MONITOR_LISTING_TOKEN" },
          },
        });
        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            messageId: "mock-agent-message",
            content: { type: "text", text: "Monitor listing ready in-turn." },
          },
        });
        // After deferred finalize (~2s) clears activeTurn, re-emit a terminal
        // TaskOutput for the same task so bufferPostSettleWake sees
        // alreadyHandledToolUpdate with a non-empty wake path.
        yield* Effect.gen(function* () {
          yield* Effect.sleep("2500 millis");
          yield* Effect.sync(() => {
            writeJsonRpcNotification("session/update", {
              sessionId: requestedSessionId,
              update: {
                sessionUpdate: "tool_call_update",
                toolCallId: "tool-call-fetch-1",
                title: "get_command_or_subagent_output",
                kind: "other",
                status: "completed",
                rawOutput: { output: "MONITOR_LISTING_TOKEN_LATE" },
              },
            });
          });
        }).pipe(Effect.forkDetach);
        return yield* finishPrompt(requestedSessionId, "end_turn");
      }

      if (emitPostSettleMonitorFlow) {
        const monitorToolCallId = "tool-call-monitor-1";

        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: monitorToolCallId,
            title: "Monitor: mock background task",
            kind: "execute",
            status: "pending",
            rawInput: {},
          },
        });

        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: monitorToolCallId,
            status: "in_progress",
          },
        });

        // After the prompt settles, replay the CLI-injected monitor-event
        // turn: end notice, TaskOutput hydration, then (once the trigger
        // file exists) the report chunk. Detached fiber on the real clock;
        // it outlives the prompt handler.
        yield* Effect.gen(function* () {
          yield* Effect.sleep("150 millis");
          yield* Effect.sync(() => {
            writeJsonRpcNotification("session/update", {
              sessionId: requestedSessionId,
              update: {
                sessionUpdate: "user_message_chunk",
                messageId: "mock-user-message",
                content: {
                  type: "text",
                  text: 'Monitor "task-monitor-1" ended: [monitor ended: exit 0]',
                },
              },
            });
            writeJsonRpcNotification("session/update", {
              sessionId: requestedSessionId,
              update: {
                sessionUpdate: "tool_call_update",
                toolCallId: "tool-call-fetch-1",
                title: "get_command_or_subagent_output",
                kind: "other",
                status: "pending",
                rawInput: { task_id: "task-monitor-1" },
              },
            });
            writeJsonRpcNotification("session/update", {
              sessionId: requestedSessionId,
              update: {
                sessionUpdate: "tool_call_update",
                toolCallId: "tool-call-fetch-1",
                status: "completed",
                rawOutput: { output: "MONITOR_LISTING_TOKEN" },
              },
            });
          });
          if (injectedReportTriggerPath === undefined) return;
          while (!(yield* Effect.sync(() => NodeFS.existsSync(injectedReportTriggerPath)))) {
            yield* Effect.sleep("20 millis");
          }
          yield* Effect.sync(() => {
            writeJsonRpcNotification("session/update", {
              sessionId: requestedSessionId,
              update: {
                sessionUpdate: "agent_message_chunk",
                messageId: "mock-agent-message",
                content: { type: "text", text: "Monitor finished. MONITOR_REPORT_TOKEN" },
              },
            });
          });
        }).pipe(Effect.forkDetach);

        return yield* finishPrompt(requestedSessionId, "end_turn");
      }

      if (emitAskQuestion) {
        yield* agent.client.extRequest("cursor/ask_question", {
          toolCallId: "ask-question-tool-call-1",
          title: "Question",
          questions: [
            {
              id: "scope",
              prompt: "Which scope?",
              options: [
                { id: "workspace", label: "Workspace" },
                { id: "session", label: "Session" },
              ],
            },
          ],
        });

        return yield* finishPrompt(requestedSessionId, "end_turn");
      }

      if (emitXAiAskUserQuestion || emitXAiAskUserQuestionThenHang) {
        const result = yield* agent.client.extRequest("_x.ai/ask_user_question", {
          method: "x.ai/ask_user_question",
          params: {
            sessionId: requestedSessionId,
            toolCallId: "ask-user-question-tool-call-1",
            questions: [
              {
                question: "Which scope should Grok use?",
                multiSelect: null,
                options: [
                  { label: "Workspace", description: "Use the current workspace" },
                  { label: "Session", description: "Only use this session" },
                ],
              },
            ],
            mode: "default",
          },
        });
        if (typeof result !== "object" || result === null || !("outcome" in result)) {
          throw new Error("Expected _x.ai/ask_user_question response outcome.");
        }
        if (result.outcome === "cancelled") {
          return yield* finishPrompt(requestedSessionId, "end_turn");
        }
        if (
          result.outcome !== "accepted" ||
          !("answers" in result) ||
          typeof result.answers !== "object" ||
          result.answers === null
        ) {
          throw new Error("Expected accepted _x.ai/ask_user_question response answers.");
        }

        if (emitXAiAskUserQuestionThenHang) {
          return yield* Effect.never;
        }

        return yield* finishPrompt(requestedSessionId, "end_turn");
      }

      if (emitXAiPlanMdWrite) {
        // Match Grok's real session layout so isGrokPlanMarkdownPath accepts it.
        const planRoot = process.env.STUDIO_ACP_PLAN_ROOT ?? "/tmp/mock-home/.grok";
        const planPath = `${planRoot}/sessions/${requestedSessionId}/plan.md`;
        const planBody = "# Mock plan\n\n- Write the feature\n- Add a test\n- Ship it\n";
        // enter_plan_mode first so the adapter arms planModeActive.
        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: "enter-plan-mode-1",
            title: "enter_plan_mode",
            kind: "other",
            status: "completed",
            rawInput: { variant: "EnterPlanMode" },
          },
        });
        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: "plan-md-write-1",
            title: "write",
            kind: "edit",
            status: "pending",
            rawInput: { file_path: planPath, content: planBody },
          },
        });
        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: "plan-md-write-1",
            kind: "edit",
            status: "completed",
            title: `Write \`${planPath}\``,
            rawInput: { file_path: planPath, content: planBody },
            content: [
              {
                type: "diff",
                path: planPath,
                oldText: "",
                newText: planBody,
              },
            ],
          },
        });
        return yield* finishPrompt(requestedSessionId, "end_turn");
      }

      if (emitXAiExitPlanMode) {
        const result = yield* agent.client.extRequest("_x.ai/exit_plan_mode", {
          method: "x.ai/exit_plan_mode",
          params: {
            sessionId: requestedSessionId,
            toolCallId: "exit-plan-mode-tool-call-1",
            planContent: "# Exit plan\n\n- Step one\n- Step two\n",
          },
        });
        if (typeof result !== "object" || result === null || !("outcome" in result)) {
          throw new Error("Expected _x.ai/exit_plan_mode response outcome.");
        }
        if (
          result.outcome !== "abandoned" &&
          result.outcome !== "approved" &&
          result.outcome !== "request_changes"
        ) {
          throw new Error(
            `Expected exit_plan_mode outcome abandoned|approved|request_changes, got ${String(result.outcome)}`,
          );
        }
        return yield* finishPrompt(requestedSessionId, "end_turn");
      }

      if (emitForeignSessionUpdates) {
        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            messageId: "mock-agent-message",
            content: { type: "text", text: "root before child" },
          },
        });
        yield* agent.client.sessionUpdate({
          sessionId: "mock-child-session-1",
          update: {
            sessionUpdate: "agent_message_chunk",
            messageId: "mock-agent-message",
            content: { type: "text", text: "child content" },
          },
        });
        yield* agent.client.sessionUpdate({
          sessionId: "mock-child-session-1",
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: "child-tool-call-1",
            title: "Child-only tool",
            kind: "other",
            status: "pending",
            rawInput: {},
          },
        });
        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            messageId: "mock-agent-message",
            content: { type: "text", text: " root after child" },
          },
        });
        return yield* finishPrompt(requestedSessionId, "end_turn");
      }

      yield* agent.client.sessionUpdate({
        sessionId: requestedSessionId,
        update: {
          sessionUpdate: "plan_update",
          plan: {
            type: "items",
            planId: "mock-plan",
            entries: [
              {
                content: "Inspect mock ACP state",
                priority: "high",
                status: "completed",
              },
              {
                content: "Implement the requested change",
                priority: "high",
                status: "in_progress",
              },
            ],
          },
        },
      });

      yield* agent.client.sessionUpdate({
        sessionId: requestedSessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          messageId: "mock-agent-message",
          content: { type: "text", text: promptResponseText ?? "hello from mock" },
        },
      });

      return yield* finishPrompt(requestedSessionId, "end_turn");
    }),
  );

  yield* agent.handleUnknownExtRequest((method, params) => {
    if (method === "_test/environment") {
      return Effect.succeed({
        inherited: process.env.STUDIO_ACP_RUNTIME_AMBIENT === "sentinel",
        explicit: process.env.STUDIO_ACP_RUNTIME_EXPLICIT === "kept",
      });
    }
    if (method === "_test/release-resume") {
      return Deferred.succeed(resumeRelease, undefined).pipe(Effect.as({}));
    }
    if (method === "_test/finish-cancel") {
      return Deferred.succeed(nativeCancelRelease, undefined).pipe(Effect.as({}));
    }
    if (method === "_test/startup-metadata") {
      return Effect.gen(function* () {
        for (const [metadataSessionId, commandName, modeId] of [
          [sessionId, "plan", "code"],
          ["child-session", "foreign-command", "ask"],
        ] as const) {
          yield* agent.client.sessionUpdate({
            sessionId: metadataSessionId,
            update: {
              sessionUpdate: "available_commands_update",
              availableCommands: [{ name: commandName, description: "Native command" }],
            },
          });
          currentModeId = modeId;
          yield* agent.client.sessionUpdate({
            sessionId: metadataSessionId,
            update: {
              sessionUpdate: "config_option_update",
              configOptions: configOptions().map((option) =>
                option.type === "select" && option.category === "model"
                  ? {
                      ...option,
                      currentValue: metadataSessionId === sessionId ? "gpt-5.4" : "default",
                    }
                  : option,
              ),
            },
          });
          yield* agent.client.sessionUpdate({
            sessionId: metadataSessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: "Startup transcript must not replay." },
            },
          });
        }
        return {};
      });
    }
    if (method === "cursor/list_available_models") {
      return Effect.succeed({
        models: availableModels(),
      });
    }

    if (method !== "session/mode/set") {
      return Effect.fail(AcpError.AcpRequestError.methodNotFound(method));
    }

    const nextModeId =
      typeof params === "object" &&
      params !== null &&
      "modeId" in params &&
      typeof params.modeId === "string"
        ? params.modeId
        : typeof params === "object" &&
            params !== null &&
            "mode" in params &&
            typeof params.mode === "string"
          ? params.mode
          : undefined;
    const requestedSessionId =
      typeof params === "object" &&
      params !== null &&
      "sessionId" in params &&
      typeof params.sessionId === "string"
        ? params.sessionId
        : sessionId;

    if (typeof nextModeId === "string" && nextModeId.trim()) {
      currentModeId = nextModeId.trim();
      return agent.client
        .sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "current_mode_update",
            currentModeId,
          },
        })
        .pipe(Effect.as({}));
    }

    return Effect.succeed({});
  });

  yield* agent.handleUnknownExtNotification((method) =>
    method === "_test/exit" ? Effect.sync(() => process.exit(19)) : Effect.void,
  );

  return yield* Effect.never;
}).pipe(
  Effect.provide(
    EffectAcpAgent.layerStdio(
      requestLogPath
        ? {
            logIncoming: true,
            logger: (event) => {
              if (event.direction !== "incoming" || event.stage !== "raw") {
                return Effect.void;
              }
              if (typeof event.payload !== "string") {
                return Effect.void;
              }
              const payload = event.payload;
              return Effect.sync(() => {
                NodeFS.appendFileSync(
                  requestLogPath,
                  payload.endsWith("\n") ? payload : `${payload}\n`,
                  "utf8",
                );
              });
            },
          }
        : {},
    ),
  ),
  Effect.scoped,
  Effect.provide(NodeServices.layer),
);

NodeRuntime.runMain(program);
