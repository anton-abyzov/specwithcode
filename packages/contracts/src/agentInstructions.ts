import * as Schema from "effect/Schema";

/** Workflow delegation is independent of the model's reasoning effort. */
export const ClaudeWorkflowMode = Schema.Literals(["disabled", "on-request", "automatic"]);
export type ClaudeWorkflowMode = typeof ClaudeWorkflowMode.Type;

/** The most characters agent instructions may hold. */
export const AGENT_INSTRUCTIONS_MAX_LENGTH = 32_000;
export const AgentInstructions = Schema.String.check(
  Schema.isMaxLength(AGENT_INSTRUCTIONS_MAX_LENGTH),
);

/**
 * Settings > Agents starts empty: it holds only what the user writes. The
 * rules SpecWithCode needs live in the server's runtime instructions and in
 * code, so editing or clearing this text cannot remove them.
 */
export const DEFAULT_AGENT_INSTRUCTIONS = "";

/**
 * The default this setting shipped with before the rules moved into the app
 * (October 2026). A saved value equal to it was never the user's own text, so
 * it counts as empty.
 */
export const LEGACY_DEFAULT_AGENT_INSTRUCTIONS = `How SpecWithCode work is organized:
- A project has one coordinator. It starts or reuses threads, called workers, for the work. Workers are listed in Threads and the user can message them.
- A thread's subagents and workflows are internal to that thread. Never start a separate thread for them; summarize what they found in the thread's own reply.
- Never block-wait on another thread or task (a long studio_thread_wait or task_status loop). Send your message or hand the work off, then end your turn: the other thread's reply wakes you.
- Reply concisely. Lead with the result, and put long logs, tables and inventories in a file referenced by path.
- When workflows are available and allowed, use one for work that fans out into many similar, independent steps, such as reviewing many files or verifying many findings. Do small or sequential work directly.
- Call the app SpecWithCode, never "Studio". A coordinator's thread is a worker; a thread's internal helpers are subagents.`;

/** The user's own text, with the retired shipped default treated as nothing written. */
export function userAgentInstructions(value: string | undefined): string {
  const trimmed = value?.trim() ?? "";
  return trimmed === LEGACY_DEFAULT_AGENT_INSTRUCTIONS ? "" : trimmed;
}

/**
 * Added to every agent's instructions, after whatever the user wrote: the
 * service's database is live, and a direct open, even read-only, can crash
 * the service or lose its newest writes (M4, October 15 and 16 2026).
 */
export const LIVE_DATABASE_INSTRUCTIONS = `<live_database>
Never open, copy, move or delete SpecWithCode's \`userdata/statev2.sqlite*\` files (under \`~/.specwithcode/\` or \`~/.specweave-studio/\`) with any tool, even read-only: it can crash the service. Read with \`specweave-studio db query "SELECT ..."\` or copy with \`specweave-studio db snapshot <file>\`.
</live_database>`;

/** The user's instructions followed by the rules SpecWithCode always adds. */
export function withServiceInstructions(instructions: string): string {
  return [instructions.trim(), LIVE_DATABASE_INSTRUCTIONS].filter(Boolean).join("\n\n");
}

/** Project instructions supplement environment instructions; an empty project cannot erase them. */
export function resolveAgentInstructions(input: {
  readonly globalInstructions?: string | undefined;
  readonly projectInstructions?: string | undefined;
}): string {
  const global = userAgentInstructions(input.globalInstructions);
  const project = userAgentInstructions(input.projectInstructions);
  return [
    global ? `## Environment instructions\n${global}` : "",
    project ? `## Project instructions\n${project}` : "",
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
