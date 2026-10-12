import type { Settings as ClaudeSdkSettings, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { parseCliArgs } from "@specweave-studio/shared/cliArgs";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import type { ResponseStyle } from "@specweave-studio/contracts";

import { buildRuntimeInstructions } from "./RuntimeInstructions.ts";

export type ClaudeWorkflowMode = "disabled" | "on-request" | "automatic";

const SUBAGENT_PROMPT_FILE_LIMIT = 256 * 1024;

export class ClaudeSubagentPromptFileError extends Schema.TaggedError<ClaudeSubagentPromptFileError>()(
  "ClaudeSubagentPromptFileError",
  { reason: Schema.Literals(["invalid", "unreadable", "too_large"]) },
) {
  override get message(): string {
    return this.reason === "too_large"
      ? "Claude worker instruction files must be at most 256 KiB."
      : "Failed to read the configured Claude worker instruction file.";
  }
}

const isClaudeSubagentPromptFileError = Schema.is(ClaudeSubagentPromptFileError);

/** Resolve a configured addition without leaking file content into failures. */
/**
 * Whether the user turned Claude in Chrome on by default in Claude Code
 * (`claudeInChromeDefaultEnabled` in `.claude.json`). Interactive Claude Code
 * honours it, but a headless SDK session loads Chrome only with `--chrome`, so
 * Studio reads the same setting and passes the flag itself.
 */
export const readClaudeInChromeDefault = Effect.fn("readClaudeInChromeDefault")(function* (input: {
  readonly configDir: string | undefined;
  readonly homeDir: string;
}) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const configDir = input.configDir?.trim();
  const filePath =
    configDir === undefined || configDir.length === 0
      ? path.join(input.homeDir, ".claude.json")
      : path.join(configDir, ".claude.json");
  const text = yield* fileSystem.readFileString(filePath).pipe(Effect.orElseSucceed(() => null));
  if (text === null) return false;
  const match = /"claudeInChromeDefaultEnabled"\s*:\s*(true|false)/u.exec(text);
  return match?.[1] === "true";
});

export const readClaudeSubagentPromptFile = Effect.fn("readClaudeSubagentPromptFile")(
  function* (input: { readonly launchArgs: string; readonly cwd: string | null }) {
    const fileArg = parseCliArgs(input.launchArgs).flags["append-subagent-system-prompt-file"];
    if (fileArg === undefined) return undefined;
    if (fileArg === null || fileArg.trim().length === 0) {
      return yield* new ClaudeSubagentPromptFileError({ reason: "invalid" });
    }
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const filePath = path.resolve(input.cwd ?? ".", fileArg);
    const pathInfo = yield* fileSystem.stat(filePath);
    if (pathInfo.type !== "File") {
      return yield* new ClaudeSubagentPromptFileError({ reason: "invalid" });
    }
    if (pathInfo.size > BigInt(SUBAGENT_PROMPT_FILE_LIMIT)) {
      return yield* new ClaudeSubagentPromptFileError({ reason: "too_large" });
    }
    const file = yield* fileSystem.open(filePath, { flag: "r" });
    const info = yield* file.stat;
    if (info.type !== "File")
      return yield* new ClaudeSubagentPromptFileError({ reason: "invalid" });
    // Read one extra byte to detect growth after stat without an unbounded read.
    const bytes = new Uint8Array(SUBAGENT_PROMPT_FILE_LIMIT + 1);
    let length = 0;
    while (length < bytes.length) {
      const read = Number(yield* file.read(bytes.subarray(length)));
      if (read === 0) break;
      length += read;
    }
    if (length > SUBAGENT_PROMPT_FILE_LIMIT) {
      return yield* new ClaudeSubagentPromptFileError({ reason: "too_large" });
    }
    return yield* Effect.try({
      try: () => new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length)),
      catch: () => new ClaudeSubagentPromptFileError({ reason: "invalid" }),
    });
  },
  (effect) =>
    effect.pipe(
      Effect.scoped,
      Effect.mapError((error) =>
        isClaudeSubagentPromptFileError(error)
          ? error
          : new ClaudeSubagentPromptFileError({ reason: "unreadable" }),
      ),
    ),
);

/** Keep explicit SDK settings while applying the effective orchestration policy. */
export function mergeClaudeWorkflowSettings(
  settings: string | ClaudeSdkSettings | undefined,
  workflowSettings: Pick<ClaudeSdkSettings, "enableWorkflows" | "ultracode">,
): ClaudeSdkSettings {
  if (typeof settings !== "string") return { ...settings, ...workflowSettings };
  let parsed: unknown;
  try {
    parsed = JSON.parse(settings);
  } catch {
    // SDK paths cannot be merged without I/O. Never silently discard a file.
    throw new Error("Claude workflow policy requires settings as an object or JSON object.");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Claude workflow policy requires settings as an object or JSON object.");
  }
  return { ...parsed, ...workflowSettings };
}

/** Native orchestration and reasoning effort are independent session choices. */
export function compileClaudeWorkflowPolicy(input: {
  readonly mode?: ClaudeWorkflowMode | undefined;
  readonly agentInstructions?: string | undefined;
  readonly responseStyle?: ResponseStyle | undefined;
  readonly orchestrationInstructions?: string | undefined;
  readonly subagentPromptFileContents?: string | undefined;
  readonly extraArgs?: Readonly<Record<string, string | null>> | undefined;
  readonly allowedTools?: ReadonlyArray<string> | undefined;
  readonly disallowedTools?: ReadonlyArray<string> | undefined;
  readonly environment: NodeJS.ProcessEnv;
}) {
  const mode = input.mode ?? "on-request";
  if (
    input.extraArgs?.["append-subagent-system-prompt-file"] !== undefined &&
    input.subagentPromptFileContents === undefined
  ) {
    throw new Error(
      "Claude worker instruction file must be resolved before compiling workflow policy.",
    );
  }
  const instructions = [
    input.agentInstructions?.trim(),
    input.extraArgs?.["append-subagent-system-prompt"],
    input.subagentPromptFileContents,
    buildRuntimeInstructions({ harness: "Claude Code", responseStyle: input.responseStyle }),
    input.orchestrationInstructions,
  ]
    .filter((part): part is string => typeof part === "string" && part.length > 0)
    .join("\n\n");
  const extraArgs = { ...input.extraArgs };
  // The CLI rejects simultaneous inline/file additions. Preserve both contents
  // in one append rather than passing conflicting flags or discarding rules.
  delete extraArgs["append-subagent-system-prompt-file"];
  // The CLI alias also selects xhigh effort. Keep that effort while allowing
  // the separate Studio workflow policy to decide orchestration.
  if (extraArgs.effort === "ultracode") extraArgs.effort = "xhigh";
  // An initialize-only SDK append is not inherited by workflow workers.
  // The documented CLI flag is: verified against native worker journals.
  extraArgs["append-subagent-system-prompt"] = instructions;
  const settings = {
    enableWorkflows: mode !== "disabled",
    ultracode: mode === "automatic",
  } satisfies ClaudeSdkSettings;
  const environment = { ...input.environment };
  if (mode === "disabled") environment.CLAUDE_CODE_DISABLE_WORKFLOWS = "1";
  const allowedTools = input.allowedTools?.filter(
    (tool) => mode !== "disabled" || !/^Workflow(?:\(|$)/.test(tool),
  );
  const disallowedTools =
    mode === "disabled"
      ? [...new Set([...(input.disallowedTools ?? []), "Workflow"])]
      : input.disallowedTools;
  return { mode, instructions, settings, extraArgs, environment, allowedTools, disallowedTools };
}

/** Unattributed, scheduled and peer-delivered text must not trigger ultracode. */
export function claudeHumanMessageOrigin(message: {
  readonly createdBy: string;
  readonly creationSource: string;
  readonly scheduledTaskId?: unknown;
  readonly senderThreadId?: unknown;
}): SDKUserMessage["origin"] | undefined {
  return message.createdBy === "user" &&
    (message.creationSource === "web" || message.creationSource === "mobile") &&
    message.scheduledTaskId == null &&
    message.senderThreadId == null
    ? { kind: "human" }
    : undefined;
}
