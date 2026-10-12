import * as Schema from "effect/Schema";

/** Workflow delegation is independent of the model's reasoning effort. */
export const ClaudeWorkflowMode = Schema.Literals(["disabled", "on-request", "automatic"]);
export type ClaudeWorkflowMode = typeof ClaudeWorkflowMode.Type;

/** The most characters agent instructions may hold. */
export const AGENT_INSTRUCTIONS_MAX_LENGTH = 32_000;
export const AgentInstructions = Schema.String.check(
  Schema.isMaxLength(AGENT_INSTRUCTIONS_MAX_LENGTH),
);

/** Project instructions supplement environment instructions; an empty project cannot erase them. */
export function resolveAgentInstructions(input: {
  readonly globalInstructions?: string | undefined;
  readonly projectInstructions?: string | undefined;
}): string {
  return [
    input.globalInstructions?.trim()
      ? `## Environment instructions\n${input.globalInstructions.trim()}`
      : "",
    input.projectInstructions?.trim()
      ? `## Project instructions\n${input.projectInstructions.trim()}`
      : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

/**
 * How agents write their replies and reports. Concise mirrors Claude Code's
 * Concise output style; detailed lets agents explain their steps. This changes
 * what agents write, not what the timeline shows (that is `timelineDetail`).
 */
export const ResponseStyle = Schema.Literals(["concise", "detailed"]);
export type ResponseStyle = typeof ResponseStyle.Type;
