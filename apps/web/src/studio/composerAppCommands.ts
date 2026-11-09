/**
 * Slash commands the app runs itself, without a model turn: stop or continue
 * this thread or every thread in the project, a one-line project status, and
 * Away mode (`/away` leaves this machine, `/back` brings its work back).
 * Anything else that starts with `/` still reaches the agent.
 */
export type ComposerAppCommand =
  | "stop"
  | "continue"
  | "stop-all"
  | "continue-all"
  | "status"
  | "away"
  | "back";

export interface ComposerAppCommandEntry {
  readonly command: ComposerAppCommand;
  readonly label: `/${ComposerAppCommand}`;
  readonly description: string;
}

export const COMPOSER_APP_COMMANDS: ReadonlyArray<ComposerAppCommandEntry> = [
  { command: "stop", label: "/stop", description: "Stop this thread's running turn" },
  { command: "continue", label: "/continue", description: "Continue this thread where it stopped" },
  {
    command: "stop-all",
    label: "/stop-all",
    description: "Stop every running thread in this project",
  },
  {
    command: "continue-all",
    label: "/continue-all",
    description: "Continue every interrupted thread in this project",
  },
  {
    command: "status",
    label: "/status",
    description: "Count running, interrupted and idle threads",
  },
  {
    command: "away",
    label: "/away",
    description: "Leave this machine: hand its threads, routines and coordinator on",
  },
  { command: "back", label: "/back", description: "Bring work back to this machine" },
];

const APP_COMMAND_PATTERN = /^\/(stop-all|continue-all|stop|continue|status|away|back)\s*$/i;
/**
 * `$away` and `$back` typed as the whole message mean the same as the slash
 * form in every harness, so a skill of that name never gets the turn.
 */
const AWAY_SKILL_PATTERN = /^\$(away|back)\s*$/i;

/** The Away mode commands, which act on the machine rather than on a thread. */
export const AWAY_APP_COMMANDS: ReadonlyArray<ComposerAppCommandEntry> =
  COMPOSER_APP_COMMANDS.filter((entry) => isAwayAppCommand(entry.command));

export function isAwayAppCommand(command: ComposerAppCommand): command is "away" | "back" {
  return command === "away" || command === "back";
}

/** The app command a whole message is, or null for anything the agent should receive. */
export function parseComposerAppCommand(text: string): ComposerAppCommand | null {
  const trimmed = text.trim();
  const match = APP_COMMAND_PATTERN.exec(trimmed) ?? AWAY_SKILL_PATTERN.exec(trimmed);
  return match ? (match[1]!.toLowerCase() as ComposerAppCommand) : null;
}

/**
 * `/away`, `/back`, `$away` or `$back` as the whole message, else null. These
 * act on the machine, not a thread, so every composer runs them, a new draft
 * included, before a thread exists.
 */
export function parseAwayAppCommand(text: string): "away" | "back" | null {
  const command = parseComposerAppCommand(text);
  return command !== null && isAwayAppCommand(command) ? command : null;
}

/**
 * The Away commands a `$query` at the start of a message still matches, so
 * the skill menu offers `$away` and `$back` beside the provider's skills.
 */
export function matchAwaySkillCommands(query: string): ReadonlyArray<ComposerAppCommandEntry> {
  const needle = query.trim().toLowerCase();
  return AWAY_APP_COMMANDS.filter((entry) => entry.command.startsWith(needle));
}

/** The commands a `/query` typed at the start of a message still matches, in menu order. */
export function matchComposerAppCommands(query: string): ReadonlyArray<ComposerAppCommandEntry> {
  const needle = query.replace(/^\/+/, "").trim().toLowerCase();
  if (needle === "") return COMPOSER_APP_COMMANDS;
  const prefix = COMPOSER_APP_COMMANDS.filter((entry) => entry.command.startsWith(needle));
  const rest = COMPOSER_APP_COMMANDS.filter(
    (entry) =>
      !entry.command.startsWith(needle) &&
      (entry.command.includes(needle) || entry.description.toLowerCase().includes(needle)),
  );
  return [...prefix, ...rest];
}

/**
 * The `/word` being typed when the whole draft so far is one slash token, so
 * the coordinator's plain textarea can offer its menu. Null otherwise.
 */
export function leadingSlashQuery(text: string, caret: number): string | null {
  const head = text.slice(0, caret);
  const match = /^\/([\w:.-]*)$/.exec(head);
  if (!match || text.slice(caret).trim() !== "") return null;
  return match[1] ?? "";
}
