import type { ProviderInteractionMode } from "@specweave-studio/contracts";

/**
 * What an agent must know before it opens a tool. How to call each tool lives
 * in that tool's description (schedule shapes, workspace strategies, review
 * rounds, PR watching), so it is not repeated here. The headless rule comes
 * with the runtime instructions every provider receives.
 */
export const STUDIO_CODE_ORCHESTRATION_INSTRUCTIONS = `

## SpecWithCode orchestration

The \`studio-code\` MCP server's tools describe their own use; read a tool's description before its first call. Decide these first:

- Subagents: use your native subagent tool when it supports the model you need, otherwise \`delegate_task\` (any provider or model listed by \`orchestrator_capabilities\`). Start top-level threads with \`studio_thread_launch\` or \`create_threads\` only when the user asks for separate threads.
- Never block-wait on another thread or task: send your message or start async work, then end your turn; the reply wakes you.
- Pass on the reasoning effort the user names (\`target.effort\` or \`effort\`; "extra high" is \`xhigh\`).
- Ask the user for a decision with \`ask_user\` and for a secret with \`request_secret\`. Never ask for, invent or repeat a secret in chat.
- Name every file by its absolute path (~/ is fine), never a bare file name. When the user must pick files by hand (an upload dialog, a form), also list them in a plain code block, one absolute path per line.
- Harnesses may attach these tools lazily: make one direct call, such as \`orchestrator_capabilities\`, before concluding they are missing.
`;

/** Only ACP agents get the terminal bridge, so only they are told about it. */
const STUDIO_CODE_ACP_FALLBACK_INSTRUCTIONS = `ACP fallback: when the SpecWithCode tools are absent and \`STUDIO_ACP_MCP_NODE\` is set, call them through the terminal: \`ELECTRON_RUN_AS_NODE=1 "$STUDIO_ACP_MCP_NODE" \${STUDIO_ACP_MCP_ENTRYPOINT:+"$STUDIO_ACP_MCP_ENTRYPOINT"} acp-mcp-call <tool> '<json arguments>'\`, for example \`acp-mcp-call delegate_task '{"task":"...","target":{"providerInstanceId":"...","model":"..."},"mode":"async","clientRequestId":"..."}'\`.`;

export const STUDIO_CODE_BROWSER_TOOL_INSTRUCTIONS = `

## SpecWithCode collaborative browser

You are running inside SpecWithCode. The \`studio-code\` MCP server is the product-native collaborative browser shared with the user. When it exposes \`preview_*\` tools, prefer those tools for browser navigation, inspection, interaction, screenshots, and recordings.

For browser work, first call \`preview_status\`. If no automation-capable preview is attached, call \`preview_open\` before concluding that the browser is unavailable. Then use \`preview_navigate\`, \`preview_snapshot\`, and the focused interaction tools. Prefer snapshot-provided locators over coordinates.

Do not switch to global browser skills, Chrome, Node REPL browser automation, standalone Playwright, or agent-browser merely because the preview is initially closed or a first call fails. Use an alternative browser system only when the SpecWithCode preview tools are absent, the user explicitly requests another browser, or \`preview_open\` returns an explicit unsupported/unavailable error. A failed SpecWithCode preview tool call should be inspected and retried with corrected arguments when the error is actionable.

When the user asks you to act in their own Chrome (their signed-in accounts and open tabs), use the \`chrome_*\` tools: \`chrome_profiles\`, then \`chrome_open\` or \`chrome_tabs\`, \`chrome_snapshot\`, \`chrome_click\`, \`chrome_type\` and \`chrome_screenshot\`. They drive the SpecWithCode Browser extension in a paired Chrome profile. Use them only for tasks the user asked for, never for testing your own app, and confirm with the user before payments, purchases, sending messages or changing passwords.
`;

const STUDIO_CODE_ACP_DEFAULT_MODE_INSTRUCTIONS = `## SpecWithCode interaction mode: Default

Prefer making reasonable assumptions and carrying out the user's request. Ask a concise question only when a missing user decision would materially change the result. Treat this mode as active until SpecWithCode supplies a different interaction-mode instruction.`;

const STUDIO_CODE_ACP_PLAN_MODE_INSTRUCTIONS = `## SpecWithCode interaction mode: Plan

Investigate with read-only actions and do not edit files or otherwise execute the implementation. Resolve discoverable facts before asking questions. When the requirements are decision complete, return a concrete implementation plan and do not start implementing it. Treat this mode as active until SpecWithCode supplies a different interaction-mode instruction.`;

export interface StudioAcpInstructionState {
  readonly interactionMode: ProviderInteractionMode;
  readonly hasStudioMcp: boolean;
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
    input.previousState.hasStudioMcp === input.state.hasStudioMcp
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
          STUDIO_CODE_ORCHESTRATION_INSTRUCTIONS.trim(),
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
function prependStudioOrchestrationInstructions(prompt: string): string {
  return `<studio_code_orchestration_instructions>${STUDIO_CODE_ORCHESTRATION_INSTRUCTIONS.trim()}</studio_code_orchestration_instructions>\n\n<user_request>\n${prompt}\n</user_request>`;
}

export function studioOrchestrationPromptForFirstRun(input: {
  readonly prompt: string;
  readonly runOrdinal: number;
  readonly hasStudioMcp: boolean;
}): string {
  return input.runOrdinal === 1 && input.hasStudioMcp
    ? prependStudioOrchestrationInstructions(input.prompt)
    : input.prompt;
}

export function studioOrchestrationSystemPrompt(hasStudioMcp: boolean): string | undefined {
  return hasStudioMcp ? STUDIO_CODE_ORCHESTRATION_INSTRUCTIONS : undefined;
}
