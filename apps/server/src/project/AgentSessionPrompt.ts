/**
 * What a person typed in a transcript's user message, without the blocks a
 * harness writes around it. Codex records its setup (`<environment_context>`,
 * the AGENTS.md instructions) as user messages, Claude Code wraps slash
 * commands in `<command-name>` tags, and automated sessions open with a
 * harness block such as `<wake reason="mention" …>`. None of that is a prompt.
 *
 * Only blocks a harness is known to write are removed, and only from the start
 * of the message. Any other tag is something the person typed or pasted:
 * `<instructions>Refactor the parser</instructions>` is a prompt.
 */

/**
 * Blocks a harness writes and a person does not. The names are matched exactly:
 * every harness writes them in lower case. `image` is the marker Codex leaves
 * where a picture was attached.
 */
const HARNESS_BLOCKS = new Set([
  "environment_context",
  "system-reminder",
  "system_reminder",
  "user_instructions",
  "skills_instructions",
  "collaboration_mode",
  "turn_aborted",
  "subagent_notification",
  "task-notification",
  "scheduled-task",
  "wake",
  "relay",
  "local-command-stdout",
  "local-command-stderr",
  "local-command-caveat",
  "bash-input",
  "bash-stdout",
  "bash-stderr",
  "user-prompt-submit-hook",
  "session-start-hook",
  "ide_opened_file",
  "ide_selection",
  "image",
]);

/** Slash commands that manage the session itself; alone they ask for nothing. */
const SESSION_COMMANDS = new Set([
  "/clear",
  "/compact",
  "/config",
  "/context",
  "/cost",
  "/exit",
  "/fast",
  "/help",
  "/login",
  "/logout",
  "/mcp",
  "/model",
  "/quit",
  "/resume",
  "/status",
  "/usage",
]);

// `\w` is ASCII here; the iPhone's ThreadTitle reads names the same way.
const OPENING_TAG = /^<([A-Za-z][\w:-]*)(\s[^<>]*)?(\/)?>/;
const TAG_NAME = /^<([A-Za-z][\w:-]*)(.?)/;
const AGENTS_HEADING = /^#+ AGENTS\.md instructions[^\n]*(?:\n|$)/;
// Codex writes the project's rules under that heading, in upper case.
const AGENTS_BLOCK = "<INSTRUCTIONS>";
const AGENTS_BLOCK_END = "</INSTRUCTIONS>";
const MAX_BLOCKS = 64;

function isHarnessBlock(name: string): boolean {
  return HARNESS_BLOCKS.has(name) || name.startsWith("command-");
}

function slashCommand(text: string): string | null {
  const name = /<command-name>([\s\S]*?)<\/command-name>/.exec(text)?.[1]?.trim();
  if (!name) return null;
  const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(text)?.[1]?.trim() ?? "";
  if (args === "" && SESSION_COMMANDS.has(name.toLowerCase())) return "";
  return `${name.startsWith("/") ? name : `/${name}`} ${args}`.trim();
}

export function humanPromptText(text: string): string {
  let rest = text.trim();
  // A slash command is one typed line however Claude Code wraps it.
  if (/^<command-(?:name|message|args)>/.test(rest)) {
    const command = slashCommand(rest);
    if (command !== null) return command;
  }
  for (let step = 0; step < MAX_BLOCKS && rest !== ""; step += 1) {
    const heading = AGENTS_HEADING.exec(rest);
    if (heading) {
      rest = rest.slice(heading[0].length).trimStart();
      if (rest.startsWith(AGENTS_BLOCK)) {
        const end = rest.indexOf(AGENTS_BLOCK_END);
        // A block cut short by the transcript's size holds rules to its end.
        rest = end === -1 ? "" : rest.slice(end + AGENTS_BLOCK_END.length).trimStart();
      }
      continue;
    }
    const opening = OPENING_TAG.exec(rest);
    if (!opening) break;
    const [tag, name = "", , selfClosing] = opening;
    if (!isHarnessBlock(name)) break;
    if (selfClosing) {
      rest = rest.slice(tag.length).trimStart();
      continue;
    }
    const closing = `</${name}>`;
    const end = rest.indexOf(closing, tag.length);
    if (end !== -1) {
      rest = rest.slice(end + closing.length).trimStart();
      continue;
    }
    // A harness line that is never closed, alone on its line.
    const lineEnd = rest.indexOf("\n");
    const line = (lineEnd === -1 ? rest : rest.slice(0, lineEnd)).trim();
    if (line !== tag) break;
    rest = lineEnd === -1 ? "" : rest.slice(lineEnd + 1).trimStart();
  }
  return rest.trim();
}

/** The line a list row shows for an imported session, or "" when nothing was typed. */
export function humanPromptTitle(text: string, maxLength = 100): string {
  const line = humanPromptText(text)
    .split("\n")
    .map((part) => part.trim())
    .find((part) => part !== "");
  return line === undefined ? "" : line.slice(0, maxLength).trim();
}

/**
 * The title sessions got before titles skipped harness markup: the first
 * message's first line, whatever it held.
 */
export function legacyImportTitle(text: string, maxLength = 100): string {
  return (text.trim().split("\n")[0] ?? "").slice(0, maxLength).trim();
}

/**
 * True for a stored title that opens with a harness block, such as
 * `<environment_context>` or a `<wake reason="mention" …` cut off by the
 * title's length. A tag no harness writes (`<Button>`, `<T>`) is a title a
 * person could have typed.
 */
export function isHarnessMarkupTitle(title: string): boolean {
  const trimmed = title.trim();
  if (AGENTS_HEADING.test(trimmed)) return true;
  const tag = TAG_NAME.exec(trimmed);
  if (!tag) return false;
  const [, name = "", next = ""] = tag;
  const ends = next === "" || next === ">" || next === "/" || next === " " || next === "\t";
  return ends && isHarnessBlock(name);
}
