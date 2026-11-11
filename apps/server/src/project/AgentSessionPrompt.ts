/**
 * What a person typed in a transcript's user message, without the blocks a
 * harness writes around it. Codex records its setup (`<environment_context>`,
 * the AGENTS.md instructions) as user messages, Claude Code wraps slash
 * commands in `<command-name>` tags, and automated sessions open with a
 * harness line such as `<wake reason="mention" …>`. None of that is a prompt.
 *
 * Only the start of the message is cleaned. Markup a person pasted after their
 * own words is left alone.
 */

/** Blocks that only ever hold harness text, never the person's words. */
const SETUP_BLOCKS = new Set([
  "environment_context",
  "system-reminder",
  "system_reminder",
  "user_instructions",
  "instructions",
  "permissions",
  "skills_instructions",
  "collaboration_mode",
  "turn_aborted",
  "subagent_notification",
  "task-notification",
  "local-command-stdout",
  "local-command-stderr",
  "local-command-caveat",
  "command-message",
  "command-stdout",
  "command-stderr",
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

const OPENING_TAG = /^<([A-Za-z][\w:-]*)(\s[^<>]*)?(\/)?>/;
const AGENTS_HEADING = /^#+ AGENTS\.md instructions[^\n]*(?:\n|$)/;
const MAX_BLOCKS = 64;

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
      continue;
    }
    const opening = OPENING_TAG.exec(rest);
    if (!opening) break;
    const [tag, name = "", , selfClosing] = opening;
    if (selfClosing) {
      rest = rest.slice(tag.length).trimStart();
      continue;
    }
    const closing = `</${name}>`;
    const end = rest.indexOf(closing, tag.length);
    if (end !== -1) {
      const after = rest.slice(end + closing.length).trimStart();
      if (SETUP_BLOCKS.has(name.toLowerCase())) {
        rest = after;
        continue;
      }
      // An unknown wrapper: the person's words follow it, or sit inside it.
      const typedAfter = humanPromptText(after);
      return typedAfter !== "" ? typedAfter : humanPromptText(rest.slice(tag.length, end));
    }
    // A harness line with no closing tag, such as `<wake reason="mention" …>`.
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

/** True for a stored title that is harness markup, not something a person would name a thread. */
export function isHarnessMarkupTitle(title: string): boolean {
  const trimmed = title.trim();
  if (AGENTS_HEADING.test(trimmed)) return true;
  const opening = OPENING_TAG.exec(trimmed);
  if (!opening) return /^<[A-Za-z][\w:-]*(\s[^<>]*)?$/.test(trimmed);
  // The whole title is the tag, or the tag is a known harness block.
  const name = (opening[1] ?? "").toLowerCase();
  return trimmed === opening[0] || SETUP_BLOCKS.has(name) || name.startsWith("command-");
}
