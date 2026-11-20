/**
 * What a shell code block would do with administrator rights, read from its
 * text before anything runs. It decides whether the Run button asks first and
 * whether the run goes through the machine's administrator prompt.
 */

export interface ShellRunElevation {
  /** A command in the block runs through `sudo` or `doas`. */
  readonly administrator: boolean;
  /** System paths or commands the block changes, in the order they appear. */
  readonly systemChanges: ReadonlyArray<string>;
}

interface Word {
  readonly text: string;
  /** Quoted text is never a command name, an option or a redirection. */
  readonly quoted: boolean;
}

interface SimpleCommand {
  readonly words: ReadonlyArray<Word>;
  /** Targets of `>` and `>>`. */
  readonly writes: ReadonlyArray<string>;
}

const SEPARATORS = new Set([";", "&", "|", "\n", "(", ")", "{", "}", "`"]);

/** Splits a block into simple commands; quotes, comments and `$(` are honoured. */
function simpleCommands(code: string): SimpleCommand[] {
  const commands: SimpleCommand[] = [];
  let words: Word[] = [];
  let writes: string[] = [];
  let text = "";
  let quoted = false;
  let started = false;
  let redirecting = false;

  const endWord = () => {
    if (!started) return;
    if (redirecting) writes.push(text);
    else words.push({ text, quoted });
    text = "";
    quoted = false;
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

  for (let index = 0; index < code.length; index += 1) {
    const char = code[index] ?? "";
    if (char === "\\") {
      const next = code[index + 1] ?? "";
      // A line continuation joins two lines; any other escape is the next character.
      if (next !== "\n") {
        text += next;
        started = true;
      }
      index += 1;
      continue;
    }
    if (char === "'" || char === '"') {
      const close = code.indexOf(char, index + 1);
      const end = close === -1 ? code.length : close;
      text += code.slice(index + 1, end);
      quoted = true;
      started = true;
      index = end;
      continue;
    }
    if (char === "#" && !started) {
      const lineEnd = code.indexOf("\n", index);
      index = (lineEnd === -1 ? code.length : lineEnd) - 1;
      continue;
    }
    if (char === "$" && code[index + 1] === "(") {
      endCommand();
      index += 1;
      continue;
    }
    if (char === ">") {
      // `2>` and `&>` belong to the redirection, not to a word.
      if (started && /^[0-9&]$/.test(text) && !quoted) {
        text = "";
        started = false;
      }
      endWord();
      if (code[index + 1] === ">") index += 1;
      redirecting = code[index + 1] !== "&";
      continue;
    }
    if (char === "<") {
      endWord();
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
    text += char;
    started = true;
  }
  endCommand();
  return commands;
}

/** Words a shell puts in front of the command they run. */
const PREFIX_WORDS = new Set([
  "then",
  "do",
  "else",
  "elif",
  "if",
  "while",
  "until",
  "!",
  "time",
  "exec",
  "command",
  "builtin",
  "nohup",
  "env",
  "xargs",
]);

const ADMINISTRATOR_COMMANDS = new Set(["sudo", "doas"]);
/** `sudo` options that take a value as the next word. */
const SUDO_VALUE_OPTIONS = new Set(["-u", "-g", "-h", "-p", "-C", "-D", "-R", "-T", "-U"]);

const baseName = (word: string): string => word.slice(word.lastIndexOf("/") + 1);
const isAssignment = (word: Word): boolean =>
  !word.quoted && /^[A-Za-z_][A-Za-z0-9_]*=/.test(word.text);

/** The command a simple command really runs, and whether it runs as administrator. */
function effectiveCommand(command: SimpleCommand): {
  readonly administrator: boolean;
  readonly words: ReadonlyArray<Word>;
} {
  let words = command.words;
  let administrator = false;
  for (;;) {
    const first = words[0];
    if (first === undefined) break;
    if (isAssignment(first) || (!first.quoted && PREFIX_WORDS.has(first.text))) {
      words = words.slice(1);
      continue;
    }
    if (first.quoted || !ADMINISTRATOR_COMMANDS.has(baseName(first.text))) break;
    administrator = true;
    words = words.slice(1);
    while (words[0] !== undefined && !words[0].quoted && words[0].text.startsWith("-")) {
      const option = words[0].text;
      words = words.slice(option !== "--" && SUDO_VALUE_OPTIONS.has(option) ? 2 : 1);
      if (option === "--") break;
    }
  }
  return { administrator, words };
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
  "open",
  "strings",
  "xxd",
  "hexdump",
  "readlink",
  "realpath",
  "basename",
  "dirname",
  "source",
  ".",
  "export",
]);

/** System tools that change machine settings, with the subcommands that only read. */
const SETTINGS_COMMANDS: ReadonlyMap<string, RegExp | null> = new Map([
  ["csrutil", /^status$/],
  ["spctl", /^(?:--status|--assess|-a)$/],
  ["dscl", null],
  ["pfctl", /^-s/],
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
  if (first === undefined || first.quoted) return changes;
  const name = baseName(first.text);
  const rest = words.slice(1);
  const second = rest[0]?.text ?? "";

  if (name === "defaults") {
    const domain = rest[1]?.text ?? "";
    if ((second === "write" || second === "delete" || second === "import") && isSystemPath(domain))
      changes.push(domain);
    return changes;
  }
  if (name === "launchctl") {
    if (LAUNCHCTL_CHANGES.has(second)) changes.push(`launchctl ${second}`);
    return changes;
  }
  if (name === "plutil") {
    if (second === "-p" || second === "-lint") return changes;
  } else if (name === "dscl") {
    // `dscl . -read /Users/me` and `-list` only read.
    if (!rest.some((word) => /^-(?:read|list|search|readall)$/.test(word.text)))
      changes.push("dscl");
    return changes;
  } else if (SETTINGS_COMMANDS.has(name)) {
    const readOnly = SETTINGS_COMMANDS.get(name) ?? null;
    if (readOnly === null || !readOnly.test(second))
      changes.push(second ? `${name} ${second}` : name);
    return changes;
  } else if (READ_ONLY_COMMANDS.has(name)) {
    return changes;
  } else if (name === "find") {
    if (!rest.some((word) => /^-(?:delete|exec|execdir|ok)$/.test(word.text))) return changes;
  }
  for (const word of rest) if (isSystemPath(word.text)) changes.push(word.text);
  return changes;
}

/** Reads a shell block's need for administrator rights and its system changes. */
export function shellRunElevation(code: string): ShellRunElevation {
  let administrator = false;
  const systemChanges: string[] = [];
  for (const command of simpleCommands(code)) {
    const effective = effectiveCommand(command);
    administrator ||= effective.administrator;
    for (const change of systemChangesOf(command, effective.words))
      if (!systemChanges.includes(change)) systemChanges.push(change);
  }
  return { administrator, systemChanges };
}

/** Whether a block must ask before it runs, in every permission mode. */
export function shellRunNeedsElevationConfirm(elevation: ShellRunElevation): boolean {
  return elevation.administrator || elevation.systemChanges.length > 0;
}
