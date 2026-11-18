import type { ProviderInteractionMode } from "@specweave-studio/contracts";

/**
 * What an agent must know before it opens a tool. How to call each tool lives
 * in that tool's description (schedule shapes, workspace strategies, review
 * rounds, PR watching), so it is not repeated here. The headless rule comes
 * with the runtime instructions every provider receives.
 */
const WORKER_SUBAGENT_LINE =
  "- Subagents: use your native subagent tool when it supports the model you need, otherwise `delegate_task` (any provider or model listed by `orchestrator_capabilities`). Start top-level threads with `studio_thread_launch` or `create_threads` only when the user asks for separate threads.";

const COORDINATOR_SUBAGENT_LINE =
  "- You are this project's coordinator: you route work, you do not do it. For any real work (research, reading files, settings or logs, running commands, verification, fixes, web or external-service lookups), your next call starts a worker with `delegate_task` in mode async (or `studio_thread_launch` where this project runs its workers), then one line naming where it went with its thread link. Never use native subagents, native workflows, or your own file, shell, edit or web tools for that work, however small it looks. Stay here only for a truly simple answer from this chat, memory or the thread list, summarizing or outputting a result, forwarding a user's answer to its owning worker, recording delivery for an answer-only task, and one-line acknowledgements.";

export const STUDIO_CODE_ORCHESTRATION_INSTRUCTIONS = `

## SpecWithCode orchestration

The \`studio-code\` MCP server's tools describe their own use; read a tool's description before its first call. Decide these first:

- Subagents: use your native subagent tool when it supports the model you need, otherwise \`delegate_task\` (any provider or model listed by \`orchestrator_capabilities\`). Start top-level threads with \`studio_thread_launch\` or \`create_threads\` only when the user asks for separate threads.
- Title a thread after the lasting goal it owns, not a deadline or the first ask's wording; rename it with \`studio_thread_update\` when its scope changes.
- To change this thread's model, call \`studio_thread_configure\` with \`continueWith\` and end your turn. It is not a delegation.
- In a SpecWeave project, for feature work pass \`increment\` (NNNN, "new" or "none") to \`delegate_task\`, \`create_threads\` and \`studio_thread_launch\`; workers inherit yours when omitted; post the returned spec as \`[NNNN](<specPath>)\`.
- Machines: \`studio_thread_launch\` with \`machine\` picks where a new thread runs; \`studio_thread_migrate\` moves an existing thread's execution; \`studio_handoff_ready_list\` and \`studio_thread_continue_here\` pick up another machine's handoff-ready threads. Switching the viewed orchestrator never moves a thread. For iOS Simulator, Xcode build or Mac-only work, pass \`needs\` (\`["ios_simulator"]\` or \`["macos"]\`) so it runs on a Mac; from Linux or Windows, push the branch first (see \`needs\`).
- A file on another machine: rebuild it when its sources and toolchain are here and that is cheap; otherwise use \`studio_file_transfer\`, never SSH, chat or logs. It is also the only route for secrets, and sends files ahead of a launch or move. If it says your machine has no access, end your turn naming the file; your coordinator sends it.
- Never block-wait on another thread or task: send your message or start async work, then end your turn; the reply wakes you.
- Pass on the reasoning effort the user names (\`target.effort\` or \`effort\`; "extra high" is \`xhigh\`).
- Ask the user for a decision with \`ask_user\` and for a secret with \`request_secret\`. Never ask for, invent or repeat a secret in chat.
- Computer use (screenshots, System Settings, native apps) is the \`computer_*\` tools, also where a skill names \`mcp__computer-use__*\`; prefer them to \`defaults write\`. Before driving an app or opening a simulator, call \`request_access\` with the apps and devices (or \`permission\` on "Operation not permitted") and a one-sentence reason; the user answers on a card, and Deny means stop asking this turn.
- The user's signed-in Chrome is the \`chrome_*\` tools, also where a skill names Claude in Chrome. If \`chrome_profiles\` lists none, ask the user to pair.
- Name each file by its own absolute path (~/ is fine), never a bare file name or \`{a,b}\`/\`*\` shorthand. When the user must pick files by hand (an upload dialog, a form), also list them in a plain code block, one absolute path per line.
- Harnesses may attach these tools lazily: make one direct call, such as \`orchestrator_capabilities\`, before concluding they are missing.
`;

/** Only ACP agents get the terminal bridge, so only they are told about it. */
const STUDIO_CODE_ACP_FALLBACK_INSTRUCTIONS = `ACP fallback: when the SpecWithCode tools are absent and \`STUDIO_ACP_MCP_NODE\` is set, call them through the terminal: \`ELECTRON_RUN_AS_NODE=1 "$STUDIO_ACP_MCP_NODE" \${STUDIO_ACP_MCP_ENTRYPOINT:+"$STUDIO_ACP_MCP_ENTRYPOINT"} acp-mcp-call <tool> '<json arguments>'\`, for example \`acp-mcp-call delegate_task '{"task":"...","target":{"providerInstanceId":"...","model":"..."},"mode":"async","clientRequestId":"..."}'\`. If that call is denied or blocked by your sandbox (for example \`approval prompts are disabled\` or \`connect EPERM\`), restarting this session, the app or the machine does not fix it, so never ask for a restart: quote the denial exactly and tell the user that the thread's access mode decides it (on Full access the call normally runs unasked; on Supervised they are normally asked to approve it).`;

export const STUDIO_CODE_BROWSER_TOOL_INSTRUCTIONS = `

## SpecWithCode collaborative browser

You are running inside SpecWithCode. The \`studio-code\` MCP server is the product-native collaborative browser shared with the user. When it exposes \`preview_*\` tools, prefer those tools for browser navigation, inspection, interaction, screenshots, and recordings.

For browser work, first call \`preview_status\`. If no automation-capable preview is attached, call \`preview_open\` before concluding that the browser is unavailable. Then use \`preview_navigate\`, \`preview_snapshot\`, and the focused interaction tools. Prefer snapshot-provided locators over coordinates.

Do not switch to global browser skills, Chrome, Node REPL browser automation, standalone Playwright, or agent-browser merely because the preview is initially closed or a first call fails. Use an alternative browser system only when the SpecWithCode preview tools are absent, the user explicitly requests another browser, or \`preview_open\` returns an explicit unsupported/unavailable error. A failed SpecWithCode preview tool call should be inspected and retried with corrected arguments when the error is actionable.

When the user asks you to act in their own Chrome (their signed-in accounts and open tabs), use the \`chrome_*\` tools: \`chrome_profiles\`, then \`chrome_open\` or \`chrome_tabs\`, \`chrome_snapshot\`, \`chrome_click\`, \`chrome_type\`, \`chrome_upload\` and \`chrome_screenshot\`. They drive the SpecWithCode Browser extension in a paired Chrome profile. Use them only for tasks the user asked for, never for testing your own app, and confirm with the user before payments, purchases, sending messages or changing passwords.
`;

const STUDIO_CODE_ACP_DEFAULT_MODE_INSTRUCTIONS = `## SpecWithCode interaction mode: Default

Prefer making reasonable assumptions and carrying out the user's request. Ask a concise question only when a missing user decision would materially change the result. Treat this mode as active until SpecWithCode supplies a different interaction-mode instruction.`;

const STUDIO_CODE_ACP_PLAN_MODE_INSTRUCTIONS = `## SpecWithCode interaction mode: Plan

Investigate with read-only actions and do not edit files or otherwise execute the implementation. Resolve discoverable facts before asking questions. When the requirements are decision complete, return a concrete implementation plan and do not start implementing it. Treat this mode as active until SpecWithCode supplies a different interaction-mode instruction.`;

/**
 * The orchestration instructions for a thread: a project's coordinator gets
 * the coordinator line instead of the worker subagent line, because the
 * worker line told coordinators to run work with native subagents in their
 * own thread (November 17, 2026: an EU1 migration ran as a workflow inside
 * the coordinator, with no thread link to give the user).
 */
export function studioOrchestrationInstructionsForRole(
  isCoordinator: boolean | undefined,
): string {
  return isCoordinator === true
    ? STUDIO_CODE_ORCHESTRATION_INSTRUCTIONS.replace(WORKER_SUBAGENT_LINE, COORDINATOR_SUBAGENT_LINE)
    : STUDIO_CODE_ORCHESTRATION_INSTRUCTIONS;
}

export interface StudioAcpInstructionState {
  readonly interactionMode: ProviderInteractionMode;
  readonly hasStudioMcp: boolean;
  readonly isCoordinator?: boolean | undefined;
}

/**
 * ACP has no system/developer prompt field, so send SpecWithCode-owned context in the
 * first user prompt and whenever the available tools or interaction mode change.
 */
export function studioAcpPromptWithInstructions(input: {
  readonly prompt: string;
  readonly state: StudioAcpInstructionState;
  readonly previousState?: StudioAcpInstructionState;
}): string {
  // Native slash commands must remain at the start of the prompt.
  if (input.prompt.trimStart().startsWith("/")) return input.prompt;
  if (
    input.previousState?.interactionMode === input.state.interactionMode &&
    input.previousState.hasStudioMcp === input.state.hasStudioMcp &&
    input.previousState.isCoordinator === input.state.isCoordinator
  ) {
    return input.prompt;
  }
  const instructions = [
    input.state.interactionMode === "plan"
      ? STUDIO_CODE_ACP_PLAN_MODE_INSTRUCTIONS
      : STUDIO_CODE_ACP_DEFAULT_MODE_INSTRUCTIONS,
    ...(input.state.hasStudioMcp
      ? [
          STUDIO_CODE_BROWSER_TOOL_INSTRUCTIONS.trim(),
          studioOrchestrationInstructionsForRole(input.state.isCoordinator).trim(),
          STUDIO_CODE_ACP_FALLBACK_INSTRUCTIONS,
        ]
      : []),
  ];
  return `<studio_code_instructions>\n${instructions.join("\n\n")}\n</studio_code_instructions>\n\n<user_request>\n${input.prompt}\n</user_request>`;
}

/**
 * Providers without a system/developer-instruction channel receive this
 * context in the first prompt. Keep the wrapper explicit so it cannot be
 * mistaken for text authored by the user.
 */
function prependStudioOrchestrationInstructions(
  prompt: string,
  isCoordinator: boolean | undefined,
): string {
  return `<studio_code_orchestration_instructions>${studioOrchestrationInstructionsForRole(isCoordinator).trim()}</studio_code_orchestration_instructions>\n\n<user_request>\n${prompt}\n</user_request>`;
}

export function studioOrchestrationPromptForFirstRun(input: {
  readonly prompt: string;
  readonly runOrdinal: number;
  readonly hasStudioMcp: boolean;
  readonly isCoordinator?: boolean | undefined;
}): string {
  // A coordinator gets its routing line on every turn: a thread that became
  // the coordinator after run 1, or switched provider later, would otherwise
  // keep the worker line from its first prompt.
  return input.hasStudioMcp && (input.runOrdinal === 1 || input.isCoordinator === true)
    ? prependStudioOrchestrationInstructions(input.prompt, input.isCoordinator)
    : input.prompt;
}

export function studioOrchestrationSystemPrompt(
  hasStudioMcp: boolean,
  isCoordinator?: boolean | undefined,
): string | undefined {
  return hasStudioMcp ? studioOrchestrationInstructionsForRole(isCoordinator) : undefined;
}
