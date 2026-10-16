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
 * What every coordinator and worker is told unless the user rewrites it in
 * Settings > Agents: how work is organized, and the habits that keep it legible.
 */
export const DEFAULT_AGENT_INSTRUCTIONS = `How SpecWithCode work is organized:
- A project has one coordinator. It starts or reuses threads, called workers, for the work. Workers are listed in Threads and the user can message them.
- A thread's subagents and workflows are internal to that thread. Never start a separate thread for them; summarize what they found in the thread's own reply.
- Never block-wait on another thread or task (a long studio_thread_wait or task_status loop). Send your message or hand the work off, then end your turn: the other thread's reply wakes you.
- Reply concisely. Lead with the result, and put long logs, tables and inventories in a file referenced by path.
- When workflows are available and allowed, use one for work that fans out into many similar, independent steps, such as reviewing many files or verifying many findings. Do small or sequential work directly.
- Call the app SpecWithCode, never "Studio". A coordinator's thread is a worker; a thread's internal helpers are subagents.`;

/**
 * Added to every agent's instructions, after whatever the user wrote: the
 * service's database is live, and a direct open, even read-only, can crash
 * the service or lose its newest writes (M4, October 15 and 16 2026).
 */
export const LIVE_DATABASE_INSTRUCTIONS = `## SpecWithCode database
SpecWithCode keeps its state in a live SQLite database, \`userdata/statev2.sqlite\` with its \`-wal\` and \`-shm\` files, in its home folder (for example \`~/.specwithcode/<machine>/\`, or \`~/.specweave-studio/<machine>/\` before the move). Never open, copy, move or delete those files with sqlite3, Python, Node or any other tool, not even read-only: that can crash the running service or lose its newest writes. To read it, run \`specweave-studio db query "SELECT ..."\`. For a copy, run \`specweave-studio db snapshot <new file>\` and open the copy. Both use STUDIO_HOME, or take \`--base-dir <home>\`.`;

/** The user's instructions followed by the rules SpecWithCode always adds. */
export function withServiceInstructions(instructions: string): string {
  return [instructions.trim(), LIVE_DATABASE_INSTRUCTIONS].filter(Boolean).join("\n\n");
}

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
