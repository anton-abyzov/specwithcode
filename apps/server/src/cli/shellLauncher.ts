// @effect-diagnostics nodeBuiltinImport:off globalRandom:off - Exclusive, no-follow opens and descriptor chmod, which effect/FileSystem cannot express.
/**
 * The `#!/bin/sh` CLI launchers scripts/studio-fleet/launcher.py (render_cli and its two older
 * formats) and scripts/install.sh (render_cli_wrapper) write: a clean `env -i` environment, then
 * Node.js on a release's bin.mjs. Only these exact texts are recognised: the last line is split
 * into shell words, and the launcher is ours only when rendering those words again gives back the
 * file byte for byte. A replacement is rendered the same way, so every operand is quoted as the
 * installers quote it.
 */
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

/** Python's shlex.quote, as launcher.py and install.sh's py_quote quote every operand. */
export const shellQuote = (value: string): string => {
  if (value === "") return "''";
  if (!/[^A-Za-z0-9_@%+=:,./-]/.test(value)) return value;
  return `'${value.replaceAll("'", `'"'"'`)}'`;
};

/**
 * The words of one POSIX shell line: single and double quotes and backslashes, nothing expanded.
 * Undefined for an unterminated quote. Enough for the launchers above, whose texts are then
 * compared byte for byte with a fresh rendering.
 */
export const splitShellWords = (line: string): Array<string> | undefined => {
  const words: Array<string> = [];
  let word: string | undefined;
  for (let index = 0; index < line.length; index++) {
    const char = line[index]!;
    if (char === " " || char === "\t") {
      if (word !== undefined) words.push(word);
      word = undefined;
      continue;
    }
    word ??= "";
    if (char === "'") {
      const end = line.indexOf("'", index + 1);
      if (end === -1) return undefined;
      word += line.slice(index + 1, end);
      index = end;
    } else if (char === '"') {
      let end = index + 1;
      for (; end < line.length && line[end] !== '"'; end++) {
        if (line[end] === "\\" && '$`"\\'.includes(line[end + 1] ?? "")) end++;
        word += line[end];
      }
      if (end >= line.length) return undefined;
      index = end;
    } else if (char === "\\") {
      if (index + 1 >= line.length) return undefined;
      word += line[++index];
    } else {
      word += char;
    }
  }
  if (word !== undefined) words.push(word);
  return words;
};

const HEAD = "#!/bin/sh\nset -eu\numask 077\n";
const BOOTSTRAP = "STUDIO_AUTO_BOOTSTRAP_PROJECT_FROM_CWD";
const CLI_NAME_TOKEN = "STUDIO_CLI_NAME=${0##*/}";

const renderWith = (prefix: ReadonlyArray<string>, name: string) => {
  const environment = prefix
    .slice(0, -2)
    .filter((part) => !part.startsWith(`${BOOTSTRAP}=`))
    .map(shellQuote)
    .join(" ");
  const command = prefix.slice(-2).map(shellQuote).join(" ");
  const plain = `${environment}${name} ${command}`;
  const deliberate = `${environment} "${BOOTSTRAP}=$${BOOTSTRAP}"${name} ${command}`;
  return (
    `${HEAD}if [ "\${${BOOTSTRAP}+x}" = x ]; then\n` +
    `  case "$${BOOTSTRAP}" in true|false) ;; *) exit 2 ;; esac\n` +
    `  exec ${deliberate} "$@"\nfi\nexec ${plain} "$@"\n`
  );
};

/** launcher.py render_cli, render_unnamed_cli and render_legacy_cli. */
const FORMATS: ReadonlyArray<(prefix: ReadonlyArray<string>) => string> = [
  (prefix) => renderWith(prefix, ` "${CLI_NAME_TOKEN}"`),
  (prefix) => renderWith(prefix, ""),
  (prefix) => `${HEAD}exec ${prefix.map(shellQuote).join(" ")} "$@"\n`,
];

export interface ShellLauncher {
  /** `/usr/bin/env -i NAME=value... <node> <entry>`, decoded. */
  readonly prefix: ReadonlyArray<string>;
  /** The launcher's environment, NAME to value. */
  readonly environment: ReadonlyMap<string, string>;
  /** The same format with another prefix. */
  readonly render: (prefix: ReadonlyArray<string>) => string;
}

/** The launcher `text` is, or undefined for any other text (a custom or edited script). */
export const parseShellLauncher = (text: string): ShellLauncher | undefined => {
  const lines = text.split("\n");
  if (lines.length < 5 || lines.at(-1) !== "") return undefined;
  const last = lines.at(-2)!;
  if (!last.startsWith("exec ") || !last.endsWith(' "$@"')) return undefined;
  const words = splitShellWords(last.slice("exec ".length, -' "$@"'.length));
  if (words === undefined) return undefined;
  const prefix = words.filter((word) => word !== CLI_NAME_TOKEN);
  if (prefix.length < 4 || prefix[0] !== "/usr/bin/env" || prefix[1] !== "-i") return undefined;
  const assignments = prefix.slice(2, -2);
  if (!assignments.every((part) => part.indexOf("=") > 0)) return undefined;
  const render = FORMATS.find((format) => format(prefix) === text);
  if (render === undefined) return undefined;
  const environment = new Map<string, string>();
  for (const part of assignments) {
    const name = part.slice(0, part.indexOf("="));
    if (environment.has(name)) return undefined;
    environment.set(name, part.slice(name.length + 1));
  }
  return { prefix, environment, render };
};

export interface OwnedFile {
  readonly text: string;
  readonly mode: number;
  readonly dev: number;
  readonly ino: number;
}

/**
 * A regular file of at most `maxBytes`, read without following a link at `file`; undefined for a
 * link, anything else, or an error. O_NONBLOCK: opening a FIFO for reading would otherwise wait
 * for a writer; the type is checked on the descriptor before anything is read.
 */
export const readRegularFile = async (
  file: string,
  maxBytes: number,
): Promise<OwnedFile | undefined> => {
  const handle = await NodeFSP.open(
    file,
    NodeFS.constants.O_RDONLY | NodeFS.constants.O_NOFOLLOW | NodeFS.constants.O_NONBLOCK,
  ).catch(() => undefined);
  if (handle === undefined) return undefined;
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > maxBytes) return undefined;
    const text = await handle.readFile("utf8");
    return { text, mode: info.mode & 0o777, dev: info.dev, ino: info.ino };
  } catch {
    return undefined;
  } finally {
    await handle.close().catch(() => undefined);
  }
};

/**
 * Replaces `file` with `text` in `mode`, only while it is still the file `expected` read, with
 * the same bytes (an edit in place keeps the inode). The
 * new text goes to a fresh name in the same directory, created exclusively (O_EXCL also refuses a
 * link there) and written and chmodded through its own descriptor, then renamed over `file`. On
 * failure only that new entry is removed, and only while it is still the one created here.
 */
export const replaceRegularFile = async (
  file: string,
  text: string,
  expected: OwnedFile,
): Promise<void> => {
  const temporary = NodePath.join(
    NodePath.dirname(file),
    `.${NodePath.basename(file)}.repoint-${NodeCrypto.randomUUID()}`,
  );
  const handle = await NodeFSP.open(
    temporary,
    NodeFS.constants.O_WRONLY |
      NodeFS.constants.O_CREAT |
      NodeFS.constants.O_EXCL |
      NodeFS.constants.O_NOFOLLOW,
    0o600,
  );
  let created: NodeFS.Stats | undefined;
  let renamed = false;
  try {
    created = await handle.stat();
    await handle.writeFile(text);
    await handle.chmod(expected.mode);
    await handle.sync();
    await handle.close();
    const current = await readRegularFile(file, Buffer.byteLength(expected.text) + 1);
    if (
      current === undefined ||
      current.dev !== expected.dev ||
      current.ino !== expected.ino ||
      current.text !== expected.text
    ) {
      throw new Error(`${file} changed while it was being repointed`);
    }
    await NodeFSP.rename(temporary, file);
    renamed = true;
  } finally {
    await handle.close().catch(() => undefined);
    if (!renamed && created !== undefined) {
      const left = await NodeFSP.lstat(temporary).catch(() => undefined);
      if (left !== undefined && left.dev === created.dev && left.ino === created.ino) {
        await NodeFSP.unlink(temporary).catch(() => undefined);
      }
    }
  }
};
