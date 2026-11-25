const AGENT_EMAILS = new Set([
  "noreply@anthropic.com",
  "claude@anthropic.com",
  "noreply@openai.com",
  "codex@openai.com",
  "cursoragent@cursor.com",
  "copilot@github.com",
  "noreply@github.com",
]);

const GENERATED_BY_AGENT =
  /^(?:🤖\s*)?generated (?:with|by)\s+(?:claude(?: code)?|codex|cursor|github copilot|copilot|opencode|grok|antigravity)[.!]?$/i;

// Link text excludes `[`, so a run of unmatched brackets cannot make each start rescan the rest,
// and the path stops at brackets and parentheses, so an unclosed link cannot run into the next.
const AGENT_LINK =
  /\[([^[\]\r\n]+)\]\(https:\/\/(?:claude\.ai|claude\.com|www\.anthropic\.com|chatgpt\.com|openai\.com|cursor\.com|github\.com|opencode\.ai|x\.ai|antigravity\.google)(?:\/[^\s()[\]]*)?\)/gi;

// A `Claude-Session:` style trailer, or a bare link to an agent's session or task.
const AGENT_SESSION =
  /^(?:(?:claude|codex|cursor|copilot|opencode|grok|antigravity)-session:\s*\S+|<?https:\/\/(?:claude\.ai\/code\/session_|chatgpt\.com\/codex\/tasks\/)[\w-]+\/?>?)$/i;

/**
 * Marks each line that holds literal text rather than prose: indented code,
 * fence delimiters and fenced content. Credit removal and style checks leave
 * these lines alone, so quoted examples survive.
 */
export function literalMarkdownLines(lines: ReadonlyArray<string>): ReadonlyArray<boolean> {
  let fence: string | undefined;
  return lines.map((line) => {
    if (/^(?: {4}|\t)/.test(line)) return true;
    // The remainder is sliced off rather than matched: `.` stops at a line separator, and
    // backtracking through a long marker to find one would rescan the line from each tick.
    const delimiter = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    const marker = delimiter?.[1];
    const remainder = delimiter === null ? "" : line.slice(delimiter[0].length);
    if (marker !== undefined) {
      if (fence === undefined) {
        if (marker[0] === "~" || !remainder.includes("`")) fence = marker;
      } else if (
        marker[0] === fence[0] &&
        marker.length >= fence.length &&
        /^[ \t]*$/.test(remainder)
      ) {
        fence = undefined;
      }
      return true;
    }
    return fence !== undefined;
  });
}

const CO_AUTHOR_PREFIX = "co-authored-by:";

/**
 * Whether a trailer `Co-authored-by: Name <email>` names a known agent. Read by position rather
 * than with one pattern, because the text comes from whoever opened the pull request and lazy
 * name matching between optional whitespace backtracks cubically on padded input.
 */
function isAgentCoAuthor(text: string): boolean {
  if (text.slice(0, CO_AUTHOR_PREFIX.length).toLowerCase() !== CO_AUTHOR_PREFIX) return false;
  if (!text.endsWith(">")) return false;
  const emailStart = text.lastIndexOf("<");
  if (emailStart < CO_AUTHOR_PREFIX.length) return false;
  const email = text.slice(emailStart + 1, -1).toLowerCase();
  if (email.length === 0 || email.includes(">") || !AGENT_EMAILS.has(email)) return false;
  // GitHub's generic noreply address is also used by people; require Copilot's name.
  if (email !== "noreply@github.com") return true;
  const name = text.slice(CO_AUTHOR_PREFIX.length, emailStart).trim();
  return /^(?:github copilot|copilot)$/i.test(name);
}

/**
 * Whether one prose line credits an agent: a co-author trailer with a known
 * agent address, a "Generated with" footer, or a session trailer or link.
 */
export function isAgentCreditLine(line: string): boolean {
  const text = line.trim().replace(/^(?:[-*]\s+)/, "");
  if (isAgentCoAuthor(text) || AGENT_SESSION.test(text)) return true;
  return GENERATED_BY_AGENT.test(text.replace(AGENT_LINK, "$1"));
}

/** Remove standalone agent credits while keeping human signatures and quoted examples. */
export function removeAgentCredits(message: string): string {
  const newline = message.includes("\r\n") ? "\r\n" : "\n";
  const lines = message.split(/\r?\n/);
  const literal = literalMarkdownLines(lines);
  const kept = lines.filter((line, index) => literal[index] === true || !isAgentCreditLine(line));
  if (kept.length === lines.length) return message;
  // Blank tail lines are dropped one at a time; a trailing-run pattern rescans from every line.
  while (kept.length > 1 && /^[ \t]*$/.test(kept.at(-1)!)) kept.pop();
  return kept.join(newline);
}
