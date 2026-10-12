// A leading `NAME=` (optionally exported) that the shell reads as an assignment.
const LEADING_ASSIGNMENT = /^(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*=/;
// A value that captures a command's output: `$(…)`, `"$(…)"` or a backtick pair.
const SUBSTITUTION_OPENER = /^"?(\$\(|`)/;
// `A=1 && cmd`, `A=1; cmd` and `A=1&&cmd` run `cmd` after the assignment.
const COMMAND_SEPARATOR = /^\s*(?:&&|;)\s*/;
// Text that cannot start a command: a pipe, `||`, a lone `&`, a redirect or a stray `)`.
const NOT_A_COMMAND = /^[|&;<>)]/;
const MAX_ASSIGNMENTS = 8;

/** Index of the `)` that closes a `$(` just before `text`, or its length when unclosed. */
function closingParenIndex(text: string): number {
  let depth = 1;
  let quote: "'" | '"' | null = null;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quote !== null) {
      if (char === "\\" && quote === '"') index += 1;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === "\\") index += 1;
    else if (char === "'" || char === '"') quote = char;
    else if (char === "(") depth += 1;
    else if (char === ")") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return text.length;
}

/** Index just past the `"` that closes a double-quoted string `text` sits inside. */
function closingQuoteEnd(text: string): number {
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === "\\") index += 1;
    else if (char === '"') return index + 1;
  }
  return text.length;
}

/** Index where the shell word at the start of `text` ends, honouring quotes and escapes. */
function wordEnd(text: string): number {
  let quote: "'" | '"' | null = null;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quote !== null) {
      if (char === "\\" && quote === '"') index += 1;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === "\\") index += 1;
    else if (char === "'" || char === '"') quote = char;
    else if (char === " " || char === ";" || char === "&" || char === "|") return index;
  }
  return text.length;
}

/** The command that runs after an assignment word, or null when none follows it. */
function commandAfter(remainder: string): string | null {
  const separator = COMMAND_SEPARATOR.exec(remainder);
  let next: string;
  if (separator !== null) next = remainder.slice(separator[0].length);
  else if (/^\s/.test(remainder)) next = remainder.trimStart();
  else return null;
  if (next.length === 0 || NOT_A_COMMAND.test(next)) return null;
  return next;
}

/**
 * The part of a shell command a person recognises at a glance, for a one-line strip.
 *
 * Leading variable assignments read as labels ("ID=$(gh run list …)" looks like an
 * "ID" field), so they are dropped in favour of the command that runs after them:
 * "ID=$(gh run list …); gh run watch $ID" shows "gh run watch $ID", and
 * "PORT=3019 npm run dev" shows "npm run dev". When nothing runs after a captured
 * assignment, the captured command is the work ("ID=$(gh run list …)" shows
 * "gh run list …"). Whitespace collapses to single spaces. Anything else comes
 * back as is, and text that is only a plain assignment keeps its original form.
 */
export function shortenShellCommand(command: string): string {
  const collapsed = command.replace(/\s+/g, " ").trim();
  // What to show when the assignments lead nowhere: the last captured command, if any.
  let fallback = collapsed;
  let rest = collapsed;
  for (let step = 0; step < MAX_ASSIGNMENTS; step += 1) {
    const assignment = LEADING_ASSIGNMENT.exec(rest);
    if (assignment === null) return rest;
    const value = rest.slice(assignment[0].length);
    const substitution = SUBSTITUTION_OPENER.exec(value);
    let remainder: string;
    if (substitution === null) {
      remainder = value.slice(wordEnd(value));
    } else {
      const body = value.slice(substitution[0].length);
      const backtick = substitution[1] === "`";
      const end = backtick ? body.indexOf("`") : closingParenIndex(body);
      const closed = end !== -1 && end < body.length;
      const inner = (closed ? body.slice(0, end) : body).trim();
      if (inner.length > 0) fallback = inner;
      let after = closed ? body.slice(end + 1) : "";
      if (substitution[0].startsWith('"')) after = after.slice(closingQuoteEnd(after));
      remainder = after.slice(wordEnd(after));
    }
    const next = commandAfter(remainder);
    if (next === null) return fallback;
    rest = next;
  }
  return rest;
}
