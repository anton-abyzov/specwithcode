/**
 * Slash commands the app runs itself, without a model turn: stop or continue
 * this thread or every thread in the project, and a one-line project status.
 * Anything else that starts with `/` still reaches the agent.
 */
export type ComposerAppCommand = "stop" | "continue" | "stop-all" | "continue-all" | "status";

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
];

const APP_COMMAND_PATTERN = /^\/(stop-all|continue-all|stop|continue|status)\s*$/i;

/** The app command a whole message is, or null for anything the agent should receive. */
export function parseComposerAppCommand(text: string): ComposerAppCommand | null {
  const match = APP_COMMAND_PATTERN.exec(text.trim());
  return match ? (match[1]!.toLowerCase() as ComposerAppCommand) : null;
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
