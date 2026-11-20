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
  let started = false;
  let redirecting = false;
  let inBacktick = false;
  const pendingHeredocs: PendingHeredoc[] = [];

  const endWord = () => {
    if (!started) return;
    if (redirecting) writes.push(text);
    else words.push({ text, quoted, assignment });
    text = "";
    quoted = false;
    hasEscape = false;
    assignment = false;
    started = false;
    redirecting = false;
  };
  const endCommand = () => {
    endWord();
    if (words.length > 0 || writes.length > 0) commands.push({ words, writes });
    words = [];
    writes = [];
    redirecting = false;
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
      if (!substitutionEnd(code, index + 2).closed) uncertain = true;
      endCommand();
      index += 1;
      continue;
    }
    if (char === "$" && code[index + 1] === "{") {
      const brace = braceExpansionEnd(code, index + 2);
      if (!brace.closed) uncertain = true;
      const inner = code.slice(index + 2, brace.index);
      text += code.slice(index, brace.closed ? brace.index + 1 : brace.index);
      started = true;
      index = brace.index;
      collectEmbeddedSubstitutions(inner);
      continue;
    }
    if (char === "`") {
      inBacktick = !inBacktick;
      endCommand();
      continue;
    }
    if (char === ">") {
      // `2>` and `&>` belong to the redirection, not to a word.
      if (started && /^[0-9&]$/.test(text) && !quoted) {
        text = "";
        started = false;
      }
      endWord();
      if (code[index + 1] === ">" || code[index + 1] === "|") index += 1;
      redirecting = code[index + 1] !== "&";
      continue;
    }
    if (char === "<") {
      endWord();
      if (code[index + 1] === "<" && code[index + 2] !== "<") {
        const parsed = parseHeredocOperator(code, index);
        if (!parsed) uncertain = true;
        else {
          pendingHeredocs.push(parsed.heredoc);
          index = parsed.nextIndex;
        }
      }
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
    text += char;
    started = true;
  }
  endCommand();
  if (inBacktick || pendingHeredocs.length > 0) uncertain = true;
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
  word !== undefined && !word.quoted && word.text.startsWith("-");

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
        else if (isOption(next)) words = words.slice(runner.values.test(next.text) ? 2 : 1);
        else break;
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
      words = [{ text: "sudoedit", quoted: false, assignment: false }, ...words];
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
