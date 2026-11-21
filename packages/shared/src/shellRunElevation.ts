/**
 * What a shell code block would do with administrator rights, read from its
 * text before anything runs. It decides whether the Run button asks first and
 * whether the run goes through the machine's administrator prompt.
 *
 * It reads text, so it can be fooled by a block built to fool it (a command
 * assembled from variables, a script it calls). It errs toward asking.
 */

export interface ShellRunElevation {
  /** A command in the block asks for administrator rights, by any means. */
  readonly administrator: boolean;
  /** It does so through `sudo`, which the machine's prompt can serve. */
  readonly sudo: boolean;
  /** System paths or commands the block changes, in the order they appear. */
  readonly systemChanges: ReadonlyArray<string>;
  /** True when unclosed quotes or substitutions kept the parser from safely classifying the block. */
  readonly uncertain?: boolean;
}

interface Word {
  readonly text: string;
  /** Quoted text is never an option or a redirection target. */
  readonly quoted: boolean;
  /** True when an unquoted `NAME=` prefix started the word, even if its value is quoted. */
  readonly assignment: boolean;
  /** True when the word contains unquoted or double-quoted shell expansion syntax. */
  readonly dynamic: boolean;
}

interface SimpleCommand {
  readonly words: ReadonlyArray<Word>;
  /** Targets of `>`, `>>` and `>|`. */
  readonly writes: ReadonlyArray<string>;
}

const SEPARATORS = new Set([";", "&", "|", "\n", "(", ")", "{", "}", "`"]);
const WORD_BOUNDARY_CHARS = new Set([
  " ",
  "\t",
  "\n",
  ";",
  "&",
  "|",
  "(",
  ")",
  "{",
  "}",
  "<",
  ">",
  "`",
]);

interface ScanResult {
  readonly index: number;
  readonly closed: boolean;
}

interface PendingHeredoc {
  readonly delimiter: string;
  readonly stripTabs: boolean;
  readonly quoted: boolean;
}

/**
 * Parses a `<<` or `<<-` heredoc operator starting at `start` (where `code[start]` is `<`).
 * Returns null if the delimiter is empty, unclosed, or contains dynamic expansion.
 */
function parseHeredocOperator(
  code: string,
  start: number,
): { readonly heredoc: PendingHeredoc; readonly nextIndex: number } | null {
  let index = start + 2;
  let stripTabs = false;
  if (code[index] === "-") {
    stripTabs = true;
    index += 1;
  }
  while (code[index] === " " || code[index] === "\t") index += 1;

  let delimiter = "";
  let quoted = false;
  while (index < code.length) {
    const char = code[index] ?? "";
    if (WORD_BOUNDARY_CHARS.has(char)) break;
    if (char === "'") {
      quoted = true;
      const close = code.indexOf("'", index + 1);
      if (close === -1) return null;
      delimiter += code.slice(index + 1, close);
      index = close + 1;
      continue;
    }
    if (char === '"') {
      quoted = true;
      index += 1;
      let closed = false;
      while (index < code.length) {
        const inner = code[index] ?? "";
        if (inner === "\\") {
          const next = code[index + 1];
          if (next === undefined) return null;
          delimiter += next;
          index += 2;
          continue;
        }
        if (inner === "$" || inner === "`") return null;
        if (inner === '"') {
          closed = true;
          index += 1;
          break;
        }
        delimiter += inner;
        index += 1;
      }
      if (!closed) return null;
      continue;
    }
    if (char === "\\") {
      quoted = true;
      const next = code[index + 1];
      if (next === undefined) return null;
      delimiter += next;
      index += 2;
      continue;
    }
    if (char === "$") return null;
    delimiter += char;
    index += 1;
  }

  if (delimiter.length === 0) return null;
  return {
    heredoc: { delimiter, stripTabs, quoted },
    nextIndex: index - 1,
  };
}

/**
 * Consumes queued heredoc bodies starting at `lineStart` (immediately after `\n`).
 * Returns unquoted bodies whose embedded substitutions still run.
 */
function consumePendingHeredocs(
  code: string,
  lineStart: number,
  pending: PendingHeredoc[],
): {
  readonly nextIndex: number;
  readonly closed: boolean;
  readonly unquotedBodies: string[];
} {
  const unquotedBodies: string[] = [];
  let cursor = lineStart;
  for (const heredoc of pending) {
    const bodyStart = cursor;
    let found = false;
    while (cursor <= code.length) {
      const nl = code.indexOf("\n", cursor);
      const rawLine = nl === -1 ? code.slice(cursor) : code.slice(cursor, nl);
      const candidate = heredoc.stripTabs ? rawLine.replace(/^\t+/, "") : rawLine;
      if (candidate === heredoc.delimiter) {
        if (!heredoc.quoted) unquotedBodies.push(code.slice(bodyStart, cursor));
        cursor = nl === -1 ? code.length : nl + 1;
        found = true;
        break;
      }
      if (nl === -1) break;
      cursor = nl + 1;
    }
    if (!found) {
      pending.length = 0;
      return { nextIndex: code.length, closed: false, unquotedBodies };
    }
  }
  pending.length = 0;
  return { nextIndex: cursor - 1, closed: true, unquotedBodies };
}

/**
 * The index of the `}` that closes a `${` whose body starts at `start`.
 * Honours quotes, escapes, backticks, nested `${...}`, and `$(...)`.
 */
function braceExpansionEnd(code: string, start: number): ScanResult {
  for (let index = start; index < code.length; index += 1) {
    const char = code[index] ?? "";
    if (char === "\\") {
      index += 1;
      continue;
    }
    if (char === "'") {
      const close = code.indexOf("'", index + 1);
      if (close === -1) return { index: code.length, closed: false };
      index = close;
      continue;
    }
    if (char === '"') {
      const dq = doubleQuoteEnd(code, index + 1);
      if (!dq.closed) return { index: code.length, closed: false };
      index = dq.index;
      continue;
    }
    if (char === "`") {
      let end = index + 1;
      while (end < code.length) {
        if (code[end] === "\\") {
          end += 2;
          continue;
        }
        if (code[end] === "`") break;
        end += 1;
      }
      if (end >= code.length) return { index: code.length, closed: false };
      index = end;
      continue;
    }
    if (char === "$" && code[index + 1] === "(") {
      const sub = substitutionEnd(code, index + 2);
      if (!sub.closed) return { index: code.length, closed: false };
      index = sub.index;
      continue;
    }
    if (char === "$" && code[index + 1] === "{") {
      const nested = braceExpansionEnd(code, index + 2);
      if (!nested.closed) return { index: code.length, closed: false };
      index = nested.index;
      continue;
    }
    if (char === "}") return { index, closed: true };
  }
  return { index: code.length, closed: false };
}

/**
 * The index of the `)` that closes a `$(` whose body starts at `start`.
 * Honours quotes, escapes, comments, backticks, heredocs, `${...}`, and `case ... ) ... esac`.
 */
function substitutionEnd(code: string, start: number): ScanResult {
  let depth = 1;
  let caseDepth = 0;
  let inCasePattern = false;
  let atCommandStart = true;
  let word = "";
  let wordClean = true;
  const pendingHeredocs: PendingHeredoc[] = [];

  const flushWord = () => {
    if (wordClean && word.length > 0) {
      if (atCommandStart && word === "case") {
        caseDepth += 1;
        atCommandStart = false;
      } else if (word === "in" && caseDepth > 0) {
        inCasePattern = true;
        atCommandStart = false;
      } else if (word === "esac" && caseDepth > 0) {
        caseDepth -= 1;
        inCasePattern = false;
        atCommandStart = false;
      } else if (atCommandStart && KEYWORDS.has(word)) {
        atCommandStart = true;
      } else {
        atCommandStart = false;
      }
    } else if (!wordClean || word.length > 0) {
      atCommandStart = false;
    }
    word = "";
    wordClean = true;
  };

  for (let index = start; index < code.length; index += 1) {
    const char = code[index] ?? "";
    if (char === "\\") {
      wordClean = false;
      index += 1;
      continue;
    }
    if (char === "'") {
      wordClean = false;
      const close = code.indexOf("'", index + 1);
      if (close === -1) return { index: code.length, closed: false };
      index = close;
      continue;
    }
    if (char === '"') {
      wordClean = false;
      const dq = doubleQuoteEnd(code, index + 1);
      if (!dq.closed) return { index: code.length, closed: false };
      index = dq.index;
      continue;
    }
    if (char === "`") {
      wordClean = false;
      let end = index + 1;
      while (end < code.length) {
        if (code[end] === "\\") {
          end += 2;
          continue;
        }
        if (code[end] === "`") break;
        end += 1;
      }
      if (end >= code.length) return { index: code.length, closed: false };
      index = end;
      continue;
    }
    if (char === "$" && code[index + 1] === "{") {
      wordClean = false;
      const brace = braceExpansionEnd(code, index + 2);
      if (!brace.closed) return { index: code.length, closed: false };
      index = brace.index;
      continue;
    }
    if (
      char === "#" &&
      word.length === 0 &&
      wordClean &&
      (index === start || WORD_BOUNDARY_CHARS.has(code[index - 1] ?? ""))
    ) {
      const lineEnd = code.indexOf("\n", index);
      if (lineEnd === -1) return { index: code.length, closed: false };
      index = lineEnd - 1;
      continue;
    }
    if (char === "<" && code[index + 1] === "<" && code[index + 2] !== "<") {
      flushWord();
      const parsed = parseHeredocOperator(code, index);
      if (!parsed) return { index: code.length, closed: false };
      pendingHeredocs.push(parsed.heredoc);
      index = parsed.nextIndex;
      continue;
    }
    if (char === "\n") {
      flushWord();
      atCommandStart = true;
      if (pendingHeredocs.length > 0) {
        const consumed = consumePendingHeredocs(code, index + 1, pendingHeredocs);
        if (!consumed.closed) return { index: code.length, closed: false };
        index = consumed.nextIndex;
      }
      continue;
    }
    if (char === ";" && code[index + 1] === ";") {
      flushWord();
      if (caseDepth > 0) inCasePattern = true;
      atCommandStart = true;
      index += 1;
      continue;
    }
    if (char === "(") {
      flushWord();
      depth += 1;
      atCommandStart = true;
      continue;
    }
    if (char === ")") {
      flushWord();
      if (inCasePattern && depth === 1) {
        inCasePattern = false;
        atCommandStart = true;
        continue;
      }
      depth -= 1;
      if (depth === 1 && inCasePattern) inCasePattern = false;
      if (depth === 0) {
        if (pendingHeredocs.length > 0) return { index: code.length, closed: false };
        return { index, closed: true };
      }
      atCommandStart = false;
      continue;
    }
    if (SEPARATORS.has(char)) {
      flushWord();
      atCommandStart = true;
      continue;
    }
    if (WORD_BOUNDARY_CHARS.has(char)) {
      flushWord();
      continue;
    }
    word += char;
  }
  return { index: code.length, closed: false };
}

/**
 * The end of a double-quoted string that starts after `start`. `\"` does not
 * end it, and neither does a quote inside `$( )` or `${ }`: "$(echo "a"; sudo id)".
 */
function doubleQuoteEnd(code: string, start: number): ScanResult {
  for (let index = start; index < code.length; index += 1) {
    const char = code[index];
    if (char === "\\") index += 1;
    else if (char === "$" && code[index + 1] === "(") {
      const sub = substitutionEnd(code, index + 2);
      if (!sub.closed) return { index: code.length, closed: false };
      index = sub.index;
    } else if (char === "$" && code[index + 1] === "{") {
      const brace = braceExpansionEnd(code, index + 2);
      if (!brace.closed) return { index: code.length, closed: false };
      index = brace.index;
    } else if (char === '"') return { index, closed: true };
  }
  return { index: code.length, closed: false };
}

/** Whether double-quoted inner text contains an unescaped `$` or backtick expansion. */
function hasUnescapedDoubleQuoteExpansion(inner: string): boolean {
  for (let index = 0; index < inner.length; index += 1) {
    const char = inner[index];
    if (char === "\\") {
      index += 1;
      continue;
    }
    if (char === "$" || char === "`") return true;
  }
  return false;
}

/** Command substitution bodies (`$(...)` and `` `...` ``) embedded in a double-quoted string. */
function doubleQuoteSubstitutions(inner: string): {
  readonly bodies: string[];
  readonly uncertain: boolean;
} {
  const bodies: string[] = [];
  let uncertain = false;
  for (let index = 0; index < inner.length; index += 1) {
    const char = inner[index];
    if (char === "\\") {
      index += 1;
      continue;
    }
    if (char === "$" && inner[index + 1] === "(") {
      const sub = substitutionEnd(inner, index + 2);
      if (!sub.closed) uncertain = true;
      bodies.push(inner.slice(index + 2, sub.index));
      index = sub.index;
      continue;
    }
    if (char === "`") {
      let end = index + 1;
      while (end < inner.length) {
        if (inner[end] === "\\") {
          end += 2;
          continue;
        }
        if (inner[end] === "`") break;
        end += 1;
      }
      if (end >= inner.length) uncertain = true;
      bodies.push(inner.slice(index + 1, end).replace(/\\(["\\$`])/g, "$1"));
      index = end;
    }
  }
  return { bodies, uncertain };
}

/** Splits a block into simple commands; quotes, comments and substitutions are honoured. */
function simpleCommands(code: string): {
  readonly commands: SimpleCommand[];
  readonly uncertain: boolean;
} {
  const commands: SimpleCommand[] = [];
  let uncertain = false;
  let words: Word[] = [];
  let writes: string[] = [];
  let text = "";
  let quoted = false;
  let hasEscape = false;
  let assignment = false;
  let dynamic = false;
  let started = false;
  let redirectMode: "none" | "write" | "read" = "none";
  const pendingHeredocs: PendingHeredoc[] = [];

  const endWord = () => {
    if (!started) return;
    if (redirectMode === "write") writes.push(text);
    else if (redirectMode === "none") words.push({ text, quoted, assignment, dynamic });
    text = "";
    quoted = false;
    hasEscape = false;
    assignment = false;
    dynamic = false;
    started = false;
    redirectMode = "none";
  };
  const endCommand = () => {
    endWord();
    if (words.length > 0 || writes.length > 0) commands.push({ words, writes });
    words = [];
    writes = [];
    redirectMode = "none";
  };
  const collectEmbeddedSubstitutions = (source: string) => {
    const subs = doubleQuoteSubstitutions(source);
    if (subs.uncertain) uncertain = true;
    for (const body of subs.bodies) {
      const nested = simpleCommands(body);
      if (nested.uncertain) uncertain = true;
      commands.push(...nested.commands);
    }
  };

  for (let index = 0; index < code.length; index += 1) {
    const char = code[index] ?? "";
    if (char === "\\") {
      const next = code[index + 1] ?? "";
      // A line continuation joins two lines; any other escape is the next character.
      if (next !== "\n") {
        text += next;
        started = true;
        hasEscape = true;
      }
      index += 1;
      continue;
    }
    if (char === "'") {
      const close = code.indexOf("'", index + 1);
      if (close === -1) uncertain = true;
      const end = close === -1 ? code.length : close;
      text += code.slice(index + 1, end);
      quoted = true;
      started = true;
      index = end;
      continue;
    }
    if (char === '"') {
      const dq = doubleQuoteEnd(code, index + 1);
      if (!dq.closed) uncertain = true;
      const inner = code.slice(index + 1, dq.index);
      if (hasUnescapedDoubleQuoteExpansion(inner)) dynamic = true;
      text += inner.replace(/\\(["\\$`])/g, "$1");
      quoted = true;
      started = true;
      index = dq.index;
      // Commands still run inside double quotes: "$(sudo id)" and "`sudo id`".
      collectEmbeddedSubstitutions(inner);
      continue;
    }
    if (char === "#" && !started) {
      const lineEnd = code.indexOf("\n", index);
      index = (lineEnd === -1 ? code.length : lineEnd) - 1;
      continue;
    }
    if (char === "$" && code[index + 1] === "(") {
      const sub = substitutionEnd(code, index + 2);
      if (!sub.closed) uncertain = true;
      const inner = code.slice(index + 2, sub.index);
      text += code.slice(index, sub.closed ? sub.index + 1 : sub.index);
      dynamic = true;
      started = true;
      index = sub.index;
      const nested = simpleCommands(inner);
      if (nested.uncertain) uncertain = true;
      commands.push(...nested.commands);
      continue;
    }
    if (char === "$" && code[index + 1] === "{") {
      const brace = braceExpansionEnd(code, index + 2);
      if (!brace.closed) uncertain = true;
      const inner = code.slice(index + 2, brace.index);
      text += code.slice(index, brace.closed ? brace.index + 1 : brace.index);
      dynamic = true;
      started = true;
      index = brace.index;
      collectEmbeddedSubstitutions(inner);
      continue;
    }
    if (char === "`") {
      let close = index + 1;
      while (close < code.length) {
        if (code[close] === "\\") {
          close += 2;
          continue;
        }
        if (code[close] === "`") break;
        close += 1;
      }
      const closed = close < code.length;
      if (!closed) uncertain = true;
      const rawInner = code.slice(index + 1, close);
      text += code.slice(index, closed ? close + 1 : close);
      dynamic = true;
      started = true;
      index = close;
      const nested = simpleCommands(rawInner.replace(/\\([$`\\])/g, "$1"));
      if (nested.uncertain) uncertain = true;
      commands.push(...nested.commands);
      continue;
    }
    if ((char === "<" || char === ">") && code[index + 1] === "(") {
      const sub = substitutionEnd(code, index + 2);
      if (!sub.closed) uncertain = true;
      const inner = code.slice(index + 2, sub.index);
      text += code.slice(index, sub.closed ? sub.index + 1 : sub.index);
      dynamic = true;
      started = true;
      index = sub.index;
      const nested = simpleCommands(inner);
      if (nested.uncertain) uncertain = true;
      commands.push(...nested.commands);
      continue;
    }
    if (char === "&" && code[index + 1] === "&") {
      endCommand();
      index += 1;
      continue;
    }
    if (char === "&" && code[index + 1] === ">") {
      endWord();
      index += 1;
      if (code[index + 1] === ">") index += 1;
      redirectMode = "write";
      continue;
    }
    if (char === ">") {
      // `2>` and `10>` carry a file descriptor, not a command word.
      const hadFd = started && /^[0-9]+$/.test(text) && !quoted && !hasEscape;
      if (hadFd) {
        text = "";
        started = false;
      }
      endWord();
      if (code[index + 1] === "&") {
        index += 1;
        redirectMode = hadFd ? "read" : "write";
        continue;
      }
      if (code[index + 1] === ">" || code[index + 1] === "|") index += 1;
      redirectMode = "write";
      continue;
    }
    if (char === "<") {
      if (started && /^[0-9]+$/.test(text) && !quoted && !hasEscape) {
        text = "";
        started = false;
      }
      endWord();
      if (code[index + 1] === "<") {
        if (code[index + 2] === "<") {
          index += 2;
          redirectMode = "read";
        } else {
          const parsed = parseHeredocOperator(code, index);
          if (!parsed) uncertain = true;
          else {
            pendingHeredocs.push(parsed.heredoc);
            index = parsed.nextIndex;
          }
        }
        continue;
      }
      if (code[index + 1] === ">") {
        index += 1;
        redirectMode = "write";
        continue;
      }
      if (code[index + 1] === "&") {
        index += 1;
        redirectMode = "read";
        continue;
      }
      redirectMode = "read";
      continue;
    }
    if (char === "\n") {
      endCommand();
      if (pendingHeredocs.length > 0) {
        const consumed = consumePendingHeredocs(code, index + 1, pendingHeredocs);
        if (!consumed.closed) uncertain = true;
        for (const body of consumed.unquotedBodies) {
          collectEmbeddedSubstitutions(body);
        }
        index = consumed.nextIndex;
      }
      continue;
    }
    if (SEPARATORS.has(char)) {
      endCommand();
      continue;
    }
    if (char === " " || char === "\t") {
      endWord();
      continue;
    }
    if (
      char === "=" &&
      !assignment &&
      !quoted &&
      !hasEscape &&
      /^[A-Za-z_][A-Za-z0-9_]*$/.test(text)
    ) {
      assignment = true;
    }
    if (
      char === "$" ||
      char === "*" ||
      char === "?" ||
      char === "[" ||
      (char === "~" && !started)
    ) {
      dynamic = true;
    }
    text += char;
    started = true;
  }
  endCommand();
  if (pendingHeredocs.length > 0) uncertain = true;
  return { commands, uncertain };
}

/** Shell keywords that stand in front of the command they run. */
const KEYWORDS = new Set(["then", "do", "else", "elif", "if", "while", "until", "!"]);
/**
 * Programs that run the command given to them. Each lists its options that
 * take a value, and how many words of its own come before the command.
 */
const RUNNERS: ReadonlyMap<string, { readonly values: RegExp; readonly own: number }> = new Map([
  ["time", { values: /^-[of]$/, own: 0 }],
  ["exec", { values: /^-a$/, own: 0 }],
  ["command", { values: /^$/, own: 0 }],
  ["builtin", { values: /^$/, own: 0 }],
  ["nohup", { values: /^$/, own: 0 }],
  ["env", { values: /^-[uCSP]$|^--(?:unset|chdir|split-string)$/, own: 0 }],
  ["xargs", { values: /^-[IJLnPsERS]$|^--(?:max-args|max-procs|replace|delimiter)$/, own: 0 }],
  ["nice", { values: /^-n$|^--adjustment$/, own: 0 }],
  ["ionice", { values: /^-[cnp]$/, own: 0 }],
  ["timeout", { values: /^-[sk]$|^--(?:signal|kill-after)$/, own: 1 }],
  ["caffeinate", { values: /^-[tw]$/, own: 0 }],
  ["stdbuf", { values: /^-[ioe]$/, own: 0 }],
  ["watch", { values: /^-n$|^--interval$/, own: 0 }],
  ["arch", { values: /^-(?:arch|e|d)$/, own: 0 }],
]);

const SUDO_COMMANDS = new Set(["sudo", "sudoedit"]);
/** Other ways to become an administrator; they ask for themselves. */
const OTHER_ADMINISTRATOR_COMMANDS = new Set(["su", "pkexec", "doas"]);
const SCRIPTED_ADMINISTRATOR_REGEX = /with\s+administrator\s+privileges/i;
/** `sudo` options that take a value as the next word. */
const SUDO_VALUE_LONG_OPTIONS = new Set([
  "--user",
  "--group",
  "--host",
  "--prompt",
  "--close-from",
  "--chdir",
  "--chroot",
  "--command-timeout",
  "--other-user",
  "--role",
  "--type",
]);
const SUDO_VALUE_SHORT_OPTION = /^-[A-Za-z]*[ughpCDRTUrt]$/;

const baseName = (word: string): string => word.slice(word.lastIndexOf("/") + 1);
const isAssignment = (word: Word): boolean => word.assignment;
const isOption = (word: Word | undefined): word is Word =>
  word !== undefined && word.text.startsWith("-") && word.text !== "-";

/** The command a simple command really runs, and how it asks for administrator rights. */
function effectiveCommand(command: SimpleCommand): {
  readonly sudo: boolean;
  readonly otherAdministrator: boolean;
  readonly words: ReadonlyArray<Word>;
} {
  let words = command.words;
  let sudo = false;
  let otherAdministrator = false;
  for (;;) {
    const first = words[0];
    if (first === undefined) break;
    if (isAssignment(first) || (!first.quoted && KEYWORDS.has(first.text))) {
      words = words.slice(1);
      continue;
    }
    const name = baseName(first.text);
    const runner = RUNNERS.get(name);
    if (runner !== undefined) {
      // `command -v` / `command -V` (including quoted or combined flags before `--`) only look up a command.
      if (name === "command") {
        let lookupOnly = false;
        for (let index = 1; index < words.length; index += 1) {
          const arg = words[index];
          if (arg === undefined || arg.text === "--" || !arg.text.startsWith("-")) break;
          if (!/^-[pVv]+$/.test(arg.text)) break;
          if (/[vV]/.test(arg.text)) {
            lookupOnly = true;
            break;
          }
        }
        if (lookupOnly) break;
      }
      // A runner option this does not know could hide the command: `xargs --weird 1 sudo rm`.
      const administratorAt = words.findIndex(
        (word, index) =>
          index > 0 &&
          !word.quoted &&
          (SUDO_COMMANDS.has(baseName(word.text)) ||
            OTHER_ADMINISTRATOR_COMMANDS.has(baseName(word.text))),
      );
      if (administratorAt > 0) {
        words = words.slice(administratorAt);
        continue;
      }
      // `nice -n 5 launchctl disable x`: the runner's own options and values come first.
      words = words.slice(1);
      for (;;) {
        const next = words[0];
        if (next === undefined) break;
        if (isAssignment(next)) words = words.slice(1);
        else if (isOption(next)) {
          words = words.slice(runner.values.test(next.text) ? 2 : 1);
          if (next.text === "--") break;
        } else break;
      }
      words = words.slice(runner.own);
      continue;
    }
    if (OTHER_ADMINISTRATOR_COMMANDS.has(name)) {
      otherAdministrator = true;
      break;
    }
    if (!SUDO_COMMANDS.has(name)) break;
    sudo = true;
    words = words.slice(1);
    while (isOption(words[0])) {
      const option = words[0].text;
      if (option === "--") {
        words = words.slice(1);
        break;
      }
      const takesValue =
        SUDO_VALUE_LONG_OPTIONS.has(option) || SUDO_VALUE_SHORT_OPTION.test(option);
      words = words.slice(takesValue ? 2 : 1);
    }
    // `sudoedit /etc/hosts` edits what follows it.
    if (name === "sudoedit") {
      words = [{ text: "sudoedit", quoted: false, assignment: false, dynamic: false }, ...words];
      break;
    }
  }
  return { sudo, otherAdministrator, words };
}

const SYSTEM_PATH = /^\/(?:System|Library|etc|private|usr|bin|sbin|var)(?:\/|$)/;
const USER_WRITABLE_PATH =
  /^\/(?:usr\/local|private\/tmp|private\/var\/folders|var\/folders|var\/tmp)(?:\/|$)/;

/** A path in a folder the operating system owns. */
export function isSystemPath(path: string): boolean {
  return SYSTEM_PATH.test(path) && !USER_WRITABLE_PATH.test(path);
}

/** Commands that only read what they are given. */
const READ_ONLY_COMMANDS = new Set([
  "cat",
  "ls",
  "grep",
  "egrep",
  "fgrep",
  "rg",
  "head",
  "tail",
  "stat",
  "file",
  "less",
  "more",
  "wc",
  "diff",
  "cmp",
  "test",
  "[",
  "[[",
  "echo",
  "printf",
  "cd",
  "pushd",
  "which",
  "type",
  "du",
  "df",
  "md5",
  "shasum",
  "sha256sum",
  "open",
  "strings",
  "xxd",
  "od",
  "hexdump",
  "readlink",
  "realpath",
  "basename",
  "dirname",
  "source",
  ".",
  "export",
  "awk",
  "jq",
  "sort",
  "uniq",
  "cut",
  "tr",
  "nl",
  "column",
]);

const texts = (words: ReadonlyArray<Word>): string[] => words.map((word) => word.text);
const firstMatches = (pattern: RegExp) => (rest: string[]) => pattern.test(rest[0] ?? "");

/**
 * System tools that change machine settings. Each entry answers whether this
 * use only reads; anything else is a change.
 */
const SETTINGS_COMMANDS: ReadonlyMap<string, (rest: string[]) => boolean> = new Map([
  ["csrutil", firstMatches(/^status$/)],
  ["spctl", firstMatches(/^(?:--status|--assess|-a)$/)],
  [
    "pfctl",
    (rest: string[]) => {
      const options = rest.filter((word) => word.startsWith("-"));
      return options.length > 0 && options.every((option) => /^-(?:s\w*|v+|q|a)$/.test(option));
    },
  ],
  [
    "dscl",
    (rest: string[]) =>
      !rest.some((word) => /^-?(?:create|append|merge|delete|change|passwd)$/.test(word)) &&
      rest.some((word) => /^-?(?:read|list|search|readall|readpl)$/.test(word)),
  ],
  ["networksetup", firstMatches(/^-(?:get|list|show|is|print|version|help)/i)],
  ["scutil", (rest: string[]) => !rest.includes("--set")],
  ["pmset", firstMatches(/^-g/)],
  ["nvram", (rest: string[]) => !rest.some((word) => word.includes("=") || /^-[dcf]$/.test(word))],
  ["systemsetup", firstMatches(/^-(?:get|list|print|help)/i)],
  [
    "tmutil",
    firstMatches(
      /^(?:list\w*|status|destinationinfo|latestbackup|machinedirectory|compare|calculatedrift|uniquesize|verifychecksums|version|isexcluded)$/,
    ),
  ],
  [
    "diskutil",
    (rest: string[]) =>
      /^(?:list|info|information|activity|listFilesystems)$/.test(rest[0] ?? "") ||
      (/^(?:apfs|cs|coreStorage|ar|appleRAID)$/.test(rest[0] ?? "") && rest[1] === "list"),
  ],
  ["softwareupdate", firstMatches(/^(?:-l|--list|--history|--help|-h)$/)],
  [
    "dseditgroup",
    (rest: string[]) => {
      const opIndex = rest.indexOf("-o");
      return opIndex !== -1 && /^(?:read|checkmember)$/.test(rest[opIndex + 1] ?? "");
    },
  ],
  ["sysadminctl", firstMatches(/^-(?:secureTokenStatus|h|help)$/)],
]);

const LAUNCHCTL_CHANGES = new Set([
  "bootstrap",
  "bootout",
  "enable",
  "disable",
  "load",
  "unload",
  "kickstart",
  "remove",
]);

function systemChangesOf(command: SimpleCommand, words: ReadonlyArray<Word>): string[] {
  const changes = command.writes.filter(isSystemPath);
  const first = words[0];
  if (first === undefined) return changes;
  const name = baseName(first.text);
  const rest = texts(words.slice(1));
  const second = rest[0] ?? "";

  if (name === "defaults") {
    // `defaults -currentHost write ...` and `defaults -host name write ...`.
    const from = rest[0] === "-currentHost" ? 1 : rest[0] === "-host" ? 2 : 0;
    const verb = rest[from] ?? "";
    const domain = rest[from + 1] ?? "";
    if ((verb === "write" || verb === "delete" || verb === "import") && isSystemPath(domain))
      changes.push(domain);
    return changes;
  }
  if (name === "launchctl") {
    if (LAUNCHCTL_CHANGES.has(second)) changes.push(`launchctl ${second}`);
    return changes;
  }
  const readsSettings = SETTINGS_COMMANDS.get(name);
  if (readsSettings !== undefined) {
    if (!readsSettings(rest)) {
      // pfctl mixes reading options with the one that changes: `pfctl -sr -f file`.
      const shown =
        (name === "pfctl" ? rest.find((word) => !/^-(?:s\w*|v+|q)$/.test(word)) : second) ?? second;
      changes.push(name === "dscl" || !shown ? name : `${name} ${shown}`);
    }
    return changes;
  }
  if (name === "plutil" && (second === "-p" || second === "-lint")) return changes;
  if (READ_ONLY_COMMANDS.has(name)) return changes;
  if (name === "sed" && !rest.some((word) => /^-[A-Za-z]*i|^--in-place/.test(word))) return changes;
  if (name === "find" && !rest.some((word) => /^-(?:delete|exec|execdir|ok|okdir)$/.test(word)))
    return changes;
  for (const word of rest) if (isSystemPath(word)) changes.push(word);
  return changes;
}

/** Reads a shell block's need for administrator rights and its system changes. */
export function shellRunElevation(code: string): ShellRunElevation {
  let sudo = false;
  let administrator = SCRIPTED_ADMINISTRATOR_REGEX.test(code);
  const systemChanges: string[] = [];
  const parsed = simpleCommands(code);
  for (const command of parsed.commands) {
    const effective = effectiveCommand(command);
    sudo ||= effective.sudo;
    administrator ||= effective.sudo || effective.otherAdministrator;
    for (const change of systemChangesOf(command, effective.words))
      if (!systemChanges.includes(change)) systemChanges.push(change);
  }
  return parsed.uncertain
    ? { administrator, sudo, systemChanges, uncertain: true }
    : { administrator, sudo, systemChanges };
}

/** Whether a block must ask before it runs, in every permission mode. */
export function shellRunNeedsElevationConfirm(elevation: ShellRunElevation): boolean {
  return (
    elevation.administrator || elevation.systemChanges.length > 0 || elevation.uncertain === true
  );
}

/** One static `sudo` invocation extracted from a shell block for pre-execution policy verification. */
export interface SudoInvocationCheck {
  readonly user: string | null;
  readonly group: string | null;
  readonly command: ReadonlyArray<string>;
}

export type ElevatedSudoAnalysis =
  | { readonly kind: "supported"; readonly checks: ReadonlyArray<SudoInvocationCheck> }
  | { readonly kind: "unsupported"; readonly reason: string };

const ALLOWED_SUDO_LONG_FLAGS = new Set([
  "--non-interactive",
  "--set-home",
  "--preserve-groups",
  "--no-update",
  "--bell",
]);
const ALLOWED_SUDO_VALUE_LONG_FLAGS = new Set(["--prompt"]);
const ALLOWED_SUDO_SHORT_FLAGS = new Set(["B", "H", "N", "n", "P"]);
const ALLOWED_SUDO_VALUE_SHORT_FLAGS = new Set(["p"]);

function unwrapRunnersToPrivilegeCommand(command: SimpleCommand): {
  readonly words: ReadonlyArray<Word>;
  readonly otherAdministrator: boolean;
} {
  let words = command.words;
  for (;;) {
    const first = words[0];
    if (first === undefined) return { words, otherAdministrator: false };
    if (isAssignment(first) || (!first.quoted && KEYWORDS.has(first.text))) {
      words = words.slice(1);
      continue;
    }
    const name = baseName(first.text);
    const runner = RUNNERS.get(name);
    if (runner !== undefined) {
      if (name === "command") {
        let lookupOnly = false;
        for (let index = 1; index < words.length; index += 1) {
          const arg = words[index];
          if (arg === undefined || arg.text === "--" || !arg.text.startsWith("-")) break;
          if (!/^-[pVv]+$/.test(arg.text)) break;
          if (/[vV]/.test(arg.text)) {
            lookupOnly = true;
            break;
          }
        }
        if (lookupOnly) return { words: [], otherAdministrator: false };
      }
      const administratorAt = words.findIndex(
        (word, index) =>
          index > 0 &&
          !word.quoted &&
          (SUDO_COMMANDS.has(baseName(word.text)) ||
            OTHER_ADMINISTRATOR_COMMANDS.has(baseName(word.text))),
      );
      if (administratorAt > 0) {
        words = words.slice(administratorAt);
        continue;
      }
      words = words.slice(1);
      for (;;) {
        const next = words[0];
        if (next === undefined) break;
        if (isAssignment(next)) words = words.slice(1);
        else if (isOption(next)) {
          words = words.slice(runner.values.test(next.text) ? 2 : 1);
          if (next.text === "--") break;
        } else break;
      }
      words = words.slice(runner.own);
      continue;
    }
    if (OTHER_ADMINISTRATOR_COMMANDS.has(name)) {
      return { words, otherAdministrator: true };
    }
    return { words, otherAdministrator: false };
  }
}

/**
 * Inspects every `sudo` invocation in a shell block so the macOS elevated wrapper
 * can verify per-target and per-command noninteractive authorization before running
 * any line, and fail closed on ticket-defeating or statically unprovable forms.
 */
export function analyzeElevatedSudoInvocations(code: string): ElevatedSudoAnalysis {
  if (SCRIPTED_ADMINISTRATOR_REGEX.test(code)) {
    return { kind: "unsupported", reason: "scripted-administrator" };
  }
  const parsed = simpleCommands(code);
  if (parsed.uncertain) {
    return { kind: "unsupported", reason: "uncertain-syntax" };
  }

  const checks: SudoInvocationCheck[] = [];
  const seen = new Set<string>();

  for (const command of parsed.commands) {
    const unwrapped = unwrapRunnersToPrivilegeCommand(command);
    if (unwrapped.otherAdministrator) {
      return { kind: "unsupported", reason: "other-administrator" };
    }
    const first = unwrapped.words[0];
    if (first === undefined) continue;
    const name = baseName(first.text);
    if (name === "sudoedit") {
      return { kind: "unsupported", reason: "sudoedit" };
    }
    if (name !== "sudo") continue;

    let user: string | null = null;
    let group: string | null = null;
    let index = 1;
    const words = unwrapped.words;

    while (index < words.length) {
      const word = words[index];
      if (word === undefined || !isOption(word)) break;
      const opt = word.text;
      if (opt === "--") {
        index += 1;
        break;
      }
      if (opt.startsWith("--")) {
        const eq = opt.indexOf("=");
        const flag = eq === -1 ? opt : opt.slice(0, eq);
        if (flag === "--user") {
          if (user !== null) return { kind: "unsupported", reason: "duplicate-user" };
          if (eq !== -1) {
            const value = opt.slice(eq + 1);
            if (!value || word.dynamic) return { kind: "unsupported", reason: "dynamic-user" };
            user = value;
            index += 1;
          } else {
            const next = words[index + 1];
            if (!next || !next.text || next.dynamic) {
              return { kind: "unsupported", reason: "dynamic-user" };
            }
            user = next.text;
            index += 2;
          }
          continue;
        }
        if (flag === "--group") {
          if (group !== null) return { kind: "unsupported", reason: "duplicate-group" };
          if (eq !== -1) {
            const value = opt.slice(eq + 1);
            if (!value || word.dynamic) return { kind: "unsupported", reason: "dynamic-group" };
            group = value;
            index += 1;
          } else {
            const next = words[index + 1];
            if (!next || !next.text || next.dynamic) {
              return { kind: "unsupported", reason: "dynamic-group" };
            }
            group = next.text;
            index += 2;
          }
          continue;
        }
        if (ALLOWED_SUDO_LONG_FLAGS.has(opt)) {
          index += 1;
          continue;
        }
        if (ALLOWED_SUDO_VALUE_LONG_FLAGS.has(flag)) {
          if (eq !== -1) {
            if (word.dynamic) return { kind: "unsupported", reason: `dynamic-option:${flag}` };
            index += 1;
          } else {
            const next = words[index + 1];
            if (next === undefined) {
              return { kind: "unsupported", reason: "missing-option-value" };
            }
            if (next.dynamic) return { kind: "unsupported", reason: `dynamic-option:${flag}` };
            index += 2;
          }
          continue;
        }
        return { kind: "unsupported", reason: `unsupported-option:${flag}` };
      }

      // Short option cluster: `-u nobody`, `-unobody`, `-Hn`, etc.
      let consumedNext = false;
      for (let pos = 1; pos < opt.length; pos += 1) {
        const ch = opt[pos] ?? "";
        if (ALLOWED_SUDO_SHORT_FLAGS.has(ch)) continue;
        if (ch === "u" || ch === "g") {
          const isUser = ch === "u";
          if (isUser ? user !== null : group !== null) {
            return { kind: "unsupported", reason: isUser ? "duplicate-user" : "duplicate-group" };
          }
          const inlineValue = opt.slice(pos + 1);
          let value: string;
          let valueDynamic: boolean;
          if (inlineValue.length > 0) {
            value = inlineValue;
            valueDynamic = word.dynamic;
          } else {
            const next = words[index + 1];
            if (!next) {
              return { kind: "unsupported", reason: isUser ? "dynamic-user" : "dynamic-group" };
            }
            value = next.text;
            valueDynamic = next.dynamic;
            consumedNext = true;
          }
          if (!value || valueDynamic) {
            return { kind: "unsupported", reason: isUser ? "dynamic-user" : "dynamic-group" };
          }
          if (isUser) user = value;
          else group = value;
          break;
        }
        if (ALLOWED_SUDO_VALUE_SHORT_FLAGS.has(ch)) {
          if (pos + 1 === opt.length) {
            const next = words[index + 1];
            if (next === undefined) {
              return { kind: "unsupported", reason: "missing-option-value" };
            }
            if (next.dynamic) return { kind: "unsupported", reason: `dynamic-option:-${ch}` };
            consumedNext = true;
          } else if (word.dynamic) {
            return { kind: "unsupported", reason: `dynamic-option:-${ch}` };
          }
          break;
        }
        return { kind: "unsupported", reason: `unsupported-option:-${ch}` };
      }
      index += consumedNext ? 2 : 1;
    }

    // Leading VAR=value assignments depend on SETENV / env_keep policy that
    // `sudo -l -- <command>` does not verify.
    if (words[index]?.assignment) {
      return { kind: "unsupported", reason: "sudo-env-assignment" };
    }

    const targetCommand = words[index];
    if (
      targetCommand === undefined ||
      targetCommand.text.length === 0 ||
      targetCommand.dynamic ||
      targetCommand.text.startsWith("-")
    ) {
      return { kind: "unsupported", reason: "dynamic-or-missing-command" };
    }

    // Nested `sudo sudo ...` or `sudo sudoedit ...` is not supported here.
    const nestedName = baseName(targetCommand.text);
    if (SUDO_COMMANDS.has(nestedName) || OTHER_ADMINISTRATOR_COMMANDS.has(nestedName)) {
      return { kind: "unsupported", reason: "nested-administrator" };
    }

    const argWords = words.slice(index + 1);
    if (argWords.some((arg) => arg.dynamic)) {
      return { kind: "unsupported", reason: "dynamic-args" };
    }
    const commandArgv = [targetCommand.text, ...argWords.map((arg) => arg.text)];

    const key = JSON.stringify([user, group, commandArgv]);
    if (!seen.has(key)) {
      seen.add(key);
      checks.push({ user, group, command: commandArgv });
    }
  }

  return { kind: "supported", checks };
}
