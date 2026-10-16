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

const AGENT_LINK =
  /\[([^\]]+)\]\(https:\/\/(?:claude\.ai|claude\.com|www\.anthropic\.com|chatgpt\.com|openai\.com|cursor\.com|github\.com|opencode\.ai|x\.ai|antigravity\.google)(?:\/[^\s)]*)?\)/gi;

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
    const delimiter = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    const marker = delimiter?.[1];
    const remainder = delimiter?.[2] ?? "";
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

/**
 * Whether one prose line credits an agent: a co-author trailer with a known
 * agent address, a "Generated with" footer, or a session trailer or link.
 */
export function isAgentCreditLine(line: string): boolean {
  const text = line.trim().replace(/^(?:[-*]\s+)/, "");
  const author = /^co-authored-by:\s*(.*?)\s*<([^<>]+)>\s*$/i.exec(text);
  // GitHub's generic noreply address is also used by people; require Copilot's name.
  const email = author?.[2]?.toLowerCase();
  const agentAuthor =
    email !== undefined &&
    AGENT_EMAILS.has(email) &&
    (email !== "noreply@github.com" || /^github copilot$|^copilot$/i.test(author![1]!));
  if (agentAuthor || AGENT_SESSION.test(text)) return true;
  return GENERATED_BY_AGENT.test(text.replace(AGENT_LINK, "$1"));
}

/** Remove standalone agent credits while keeping human signatures and quoted examples. */
export function removeAgentCredits(message: string): string {
  const newline = message.includes("\r\n") ? "\r\n" : "\n";
  const lines = message.split(/\r?\n/);
  const literal = literalMarkdownLines(lines);
  const kept = lines.filter((line, index) => literal[index] === true || !isAgentCreditLine(line));
  return kept.length === lines.length
    ? message
    : kept.join(newline).replace(/(?:\r?\n[ \t]*)+$/, "");
}
