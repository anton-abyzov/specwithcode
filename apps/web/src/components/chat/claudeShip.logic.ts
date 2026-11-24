/**
 * Claude Ship's `/ship` and `/steward` start only in an interactive Claude Code
 * terminal session, from a line the person types there. A thread runs Claude
 * through the Agent SDK, where the CLI refuses them, so the composer hands the
 * line to a Claude Code session in the thread's terminal instead.
 */

export type ClaudeShipCommand = "ship" | "steward";

export interface ClaudeShipLine {
  readonly command: ClaudeShipCommand;
  /** The line exactly as the person should type it, whitespace collapsed. */
  readonly line: string;
}

/** Claude Code release that added `/ship` and `/steward`. */
export const CLAUDE_SHIP_MIN_VERSION = "2.1.330";

const EFFORT = /^(low|medium|high|xhigh|max)$/i;
const PR_NUMBER = /^#?\d{1,9}$/;
const PR_URL = /^https?:\/\/\S+\/pull\/\d+\/?$/i;
const BOT = /^\+[\w.-]{1,60}$/;
const STOP = /^(stop|cancel|abort)$/i;
const TERMS = /^terms$/i;

/**
 * The typed draft when it is only `/ship` or `/steward` with their documented
 * arguments; anything else (`/shipit`, prose after the command) is not ours.
 */
export function parseClaudeShipCommand(text: string): ClaudeShipLine | null {
  const words = text.trim().split(/\s+/);
  const head = words[0]?.toLowerCase();
  if (head !== "/ship" && head !== "/steward") return null;
  const args = words.slice(1);
  const command: ClaudeShipCommand = head === "/ship" ? "ship" : "steward";
  if (args.length === 1 && (STOP.test(args[0]!) || TERMS.test(args[0]!))) {
    return { command, line: `/${command} ${args[0]}` };
  }
  let sawTarget = false;
  for (const [index, arg] of args.entries()) {
    if (EFFORT.test(arg)) {
      if (command !== "ship" || index !== 0) return null;
      continue;
    }
    if (PR_NUMBER.test(arg) || PR_URL.test(arg)) {
      if (sawTarget) return null;
      sawTarget = true;
      continue;
    }
    if (BOT.test(arg)) continue;
    return null;
  }
  return { command, line: [`/${command}`, ...args].join(" ") };
}

type RuntimeMode = "approval-required" | "auto-accept-edits" | "auto" | "full-access";

/**
 * The terminal session's permission mode. A watch never starts under
 * `bypassPermissions`, so full access opens in auto mode.
 */
export function claudeShipPermissionMode(
  runtimeMode: RuntimeMode,
): "default" | "acceptEdits" | "auto" {
  switch (runtimeMode) {
    case "approval-required":
      return "default";
    case "auto-accept-edits":
      return "acceptEdits";
    case "auto":
    case "full-access":
      return "auto";
  }
}

/** Compares dotted versions; a missing or unreadable version is `null`. */
export function isClaudeVersionAtLeast(version: string | null, minimum: string): boolean | null {
  const parse = (value: string) =>
    value
      .match(/\d+(?:\.\d+)*/)?.[0]
      ?.split(".")
      .map(Number);
  const have = version === null ? undefined : parse(version);
  const need = parse(minimum);
  if (have === undefined || need === undefined) return null;
  for (let index = 0; index < Math.max(have.length, need.length); index += 1) {
    const left = have[index] ?? 0;
    const right = need[index] ?? 0;
    if (left !== right) return left > right;
  }
  return true;
}

export type ClaudeShipNote =
  | { readonly kind: "outdated"; readonly version: string }
  | { readonly kind: "plan" }
  | { readonly kind: "full-access" }
  | { readonly kind: "windows" }
  | { readonly kind: "new-session" };

export interface ClaudeShipPlan {
  readonly notes: ReadonlyArray<ClaudeShipNote>;
  /**
   * False when Claude Code is known to be too old, or on Windows, where the
   * terminal's shell is not a POSIX one and no watch starts anyway.
   */
  readonly canOpen: boolean;
}

export function claudeShipPlan(input: {
  readonly cliVersion: string | null;
  readonly interactionMode: "plan" | "default" | string;
  readonly runtimeMode: RuntimeMode;
  readonly platform: string | null;
  readonly sessionId: string | null;
}): ClaudeShipPlan {
  const notes: ClaudeShipNote[] = [];
  const current = isClaudeVersionAtLeast(input.cliVersion, CLAUDE_SHIP_MIN_VERSION);
  if (current === false && input.cliVersion !== null) {
    notes.push({ kind: "outdated", version: input.cliVersion });
  }
  if (input.interactionMode === "plan") notes.push({ kind: "plan" });
  if (input.runtimeMode === "full-access") notes.push({ kind: "full-access" });
  const windows = input.platform === "windows" || input.platform === "win32";
  if (windows) notes.push({ kind: "windows" });
  if (input.sessionId === null) notes.push({ kind: "new-session" });
  return { notes, canOpen: current !== false && !windows };
}

/**
 * Variables that mark a child, SDK or teammate Claude session. The terminal
 * inherits the app server's environment, which carries them when the server
 * itself was started from a Claude session; the CLI then refuses `/ship`.
 */
export const CLAUDE_SESSION_MARKER_VARIABLES = [
  "CLAUDECODE",
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_SESSION_ATTENDED",
  "CLAUDE_CODE_SESSION_KIND",
  "CLAUDE_CODE_MESSAGING_SOCKET",
  "CLAUDE_CODE_MESSAGING_TOKEN",
  "CLAUDE_CODE_CHILD_NOTES_DIR",
  "CLAUDE_CODE_EXECPATH",
  "CLAUDE_AGENT_SDK_VERSION",
  "CLAUDE_PID",
] as const;

const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
// Paths and command names only: no quotes, newlines or shell expansion characters.
const BINARY = /^[A-Za-z0-9_./~ +@:-]{1,1024}$/;

const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

export class ClaudeShipCommandError extends Error {}

/** The login-shell command that opens the Claude Code session for the person. */
export function buildClaudeShipTerminalCommand(input: {
  readonly binaryPath: string;
  readonly sessionId: string | null;
  readonly permissionMode: "default" | "acceptEdits" | "auto";
}): string {
  const binary = input.binaryPath.trim() || "claude";
  if (!BINARY.test(binary) || binary.startsWith("-")) {
    throw new ClaudeShipCommandError(
      "The Claude program path in Settings has characters the terminal cannot run safely.",
    );
  }
  if (input.sessionId !== null && !SESSION_ID.test(input.sessionId)) {
    throw new ClaudeShipCommandError(
      "This thread's Claude session id is not one the app can pass on.",
    );
  }
  // `~/` is expanded by the shell only outside quotes.
  const program = binary.startsWith("~/") ? `"$HOME"/${quote(binary.slice(2))}` : quote(binary);
  const unset = CLAUDE_SESSION_MARKER_VARIABLES.map((name) => `-u ${name}`).join(" ");
  const resume =
    input.sessionId === null ? "" : ` --resume ${quote(input.sessionId)} --fork-session`;
  return `env ${unset} -- ${program} --permission-mode ${quote(input.permissionMode)}${resume}`;
}
