/**
 * Where a project connects over SSH, read from the text of its scripts and the
 * URLs of its Git remotes. Nothing is run or sourced: a target written with
 * shell variables is filled in only when the same file gives that variable one
 * plain value (or one plain list), and is otherwise reported by the variable's
 * name.
 *
 * Project files are someone else's text. Every user, host and variable name is
 * held to the contract's strict patterns before it is returned, because the
 * dialog puts them inside commands a person copies.
 */
import {
  isSafeSshHost,
  isSafeSshUser,
  isShellVariableName,
  MAX_SSH_TARGETS,
  type ProjectSshTarget,
} from "@specweave-studio/contracts";

export type SshTarget = Omit<ProjectSshTarget, "source">;

const MAX_VALUES = 8;
const MAX_LINE = 2000;

/** Options of ssh, scp and rsync that take the next word as their value. */
const VALUE_OPTIONS = new Set(
  "-b -B -c -D -e -E -F -i -I -J -l -L -m -o -O -p -P -Q -R -S -W -w -X".split(" "),
);

const COMMAND = /(?:^|[\s;&|(`'"=])(?:\/usr\/bin\/)?(ssh|scp|rsync)[ \t]+([^\n]*)/gu;
const NAME = "[A-Za-z_][A-Za-z0-9_]*";
const PART = String.raw`(?:\$\{${NAME}\}|\$${NAME}|[A-Za-z0-9_.-]+)`;
const DESTINATION = new RegExp(`^(${PART})@(${PART})(?::.*)?$`, "u");
const VARIABLE = new RegExp(String.raw`^\$\{?(${NAME})\}?$`, "u");
const LITERAL = /^[A-Za-z0-9_.-]+$/u;
/** `"$@"`, `$1`, `${2}`: what the caller passed, which a written default stands in for. */
const POSITIONAL = /^\$(?:[@*]|\{?[0-9]+\}?)$/u;
const DECLARED = String.raw`(?:(?:export|readonly|local|declare|typeset)\s+(?:-[A-Za-z]+\s+)*)?`;
const ARRAY = new RegExp(String.raw`^\s*${DECLARED}(${NAME})=\(([^)]*)\)\s*(?:#.*)?$`, "u");
const SCALAR = new RegExp(String.raw`^\s*${DECLARED}(${NAME})=(\S*)\s*(?:#.*)?$`, "u");
const FALLBACK = new RegExp(String.raw`^\$\{(${NAME}|[0-9]+):-([^}]*)\}$`, "u");
const LOOP = new RegExp(String.raw`^(\s*for\s+(${NAME}))\s+in\s+(.+?)\s*(?:;|$)`, "u");
const LOOP_OVER = new RegExp(String.raw`^"?\$\{(${NAME})\[[@*]\]\}"?$`, "u");
/** `${A:=x}` and `${A=x}` read a variable and may write it. */
const EXPANSION_WRITE = new RegExp(String.raw`\$\{(${NAME}):?=`, "gu");
/** A read of a variable: `$A`, `${A}`, `${A:-x}`, `${A[@]}`, `${#A}`, `${!A}`. */
const EXPANSION = new RegExp(String.raw`\$\{?[#!]?${NAME}`, "gu");
const WORD = new RegExp(NAME, "gu");
/**
 * Code this file does not hold can write any variable: `eval`, `source x`,
 * `. x` wherever a command can start, and a builtin handed a computed name
 * (`export "$kv"`, `read "$ref"`, `printf -v "$ref"`, a name reference).
 */
const RUNS_OTHER_CODE = new RegExp(
  [
    String.raw`(?:^|[\s;&|(\x60{"'\\])(?:eval|source)(?:["']|\s|$)`,
    String.raw`(?:^|[\s;&|({])\.[ \t]+\S`,
    String.raw`(?:^|[\s;&|(])(?:export|declare|typeset|local|readonly|read|mapfile|readarray|unset)\b[^\n;|&]*?[ \t]["']?\$`,
    String.raw`(?:^|[\s;&|(])printf[ \t]+-v[ \t]+["']?\$`,
    String.raw`(?:^|[\s;&|(])(?:declare|local|typeset)[ \t]+-[A-Za-z]*n`,
  ].join("|"),
  "mu",
);
/** `set --` replaces what the caller passed, so a default no longer stands in for it. */
const RESETS_ARGUMENTS = /(?:^|[\s;&|(])set[ \t]+--/mu;
/** The word that ends a here-document started on this line; `<<<` is not one. */
const HEREDOC = /(?<!<)<<(?!<)-?[ \t]*(["'\\]?)([A-Za-z_][A-Za-z0-9_]*)/u;
/** A destination-shaped word the patterns refuse: the script still uses SSH. */
const LOOSE_DESTINATION = /^[^@\s[\]]+@\S|^ssh:\/\//u;

/** Splits on blanks, keeping a quoted run together; quotes are dropped. */
function words(line: string): Array<string> {
  const out: Array<string> = [];
  for (const match of line.slice(0, MAX_LINE).matchAll(/"([^"]*)"|'([^']*)'|(\S+)/gu))
    out.push(match[1] ?? match[2] ?? match[3] ?? "");
  return out;
}

const unquote = (value: string) => value.replace(/^(["'])(.*)\1$/u, "$2");

/** What a file writes into one variable: each plain value set it is given, and whether anything else is. */
interface Written {
  readonly sets: Array<ReadonlyArray<string>>;
  opaque: boolean;
  /** Given what the caller passed (`$1`, `"$@"`), for which a written default stands in. */
  positional: boolean;
}

/**
 * The plain values a file gives its own variables: `A=x`, `A="${A:-x}"`,
 * `A=(x y)`, `for A in x y`, `for A in "${LIST[@]}"`.
 *
 * A shell has many ways to write a variable (`read`, `mapfile`, `printf -v`,
 * `getopts`, `unset`, a name reference, `A+=x`), and this does not try to know
 * them. It turns the question around: a variable is known only when every
 * place the file names it is one of the plain forms above or a read of it
 * (`$A`, `${A}`). Any other mention of the name leaves it unknown, as do two
 * different values, and a file that runs code it does not hold (`eval`,
 * `source`) has no known variables at all.
 */
function assignments(text: string): Map<string, ReadonlyArray<string>> {
  const known = new Map<string, ReadonlyArray<string>>();
  if (RUNS_OTHER_CODE.test(text)) return known;
  const scalars = new Map<string, Written>();
  const arrays = new Map<string, Written>();
  /** Names the file mentions anywhere outside a plain form or a read. */
  const mentioned = new Set<string>();
  const resets = RESETS_ARGUMENTS.test(text);
  const write = (
    into: Map<string, Written>,
    name: string,
    values: ReadonlyArray<string>,
    fromArgument = false,
  ) => {
    const written = into.get(name) ?? { sets: [], opaque: false, positional: false };
    into.set(name, written);
    if (fromArgument) written.positional = true;
    const passed = values.length > 0 && values.every((value) => POSITIONAL.test(value));
    if (passed) {
      // After a plain value, the caller's argument replaces it: the plain value is not what runs.
      if (written.sets.length > 0) written.opaque = true;
      written.positional = true;
      return;
    }
    if (values.length === 0 || values.length > MAX_VALUES || !values.every((v) => LITERAL.test(v)))
      written.opaque = true;
    else written.sets.push(values);
  };
  const loops: Array<{ readonly name: string; readonly from: string }> = [];
  /** The closing word of the here-document whose body the lines are in. */
  let heredoc: string | null = null;
  for (const line of text.split("\n")) {
    // What is left of the line once its plain form, if it has one, is taken off the front.
    let rest = line;
    // A here-document's body is text for another program: nothing in it sets a variable
    // here, and every name in it counts as a mention. So does a very long line, unparsed.
    const body = heredoc !== null;
    if (body && line.trim() === heredoc) heredoc = null;
    const plain = !body && line.length <= MAX_LINE;
    const array = plain ? ARRAY.exec(line) : null;
    const scalar = plain && !array ? SCALAR.exec(line) : null;
    const loop = plain && !array && !scalar ? LOOP.exec(line) : null;
    if (!body) heredoc = HEREDOC.exec(line)?.[2] ?? null;
    if (array) {
      write(arrays, array[1]!, words(array[2]!));
      rest = array[2]!;
    } else if (scalar) {
      const value = unquote(scalar[2]!);
      const fallback = FALLBACK.exec(value);
      // `A=($(cmd))` fits the one-word form but is a list from a command. A default
      // taken from another variable (`A="${B:-x}"`) is that variable's value, not `x`.
      const argument = fallback !== null && /^[0-9]+$/u.test(fallback[1]!);
      if (value.startsWith("(")) mentioned.add(scalar[1]!);
      else if (fallback && fallback[1] !== scalar[1] && !argument) mentioned.add(scalar[1]!);
      else write(scalars, scalar[1]!, [fallback ? fallback[2]! : value], argument);
      rest = scalar[2]!;
    } else if (loop) {
      const over = LOOP_OVER.exec(loop[3]!.trim());
      if (over) loops.push({ name: loop[2]!, from: over[1]! });
      else write(scalars, loop[2]!, words(loop[3]!));
      // The list and the loop's body on the same line are still read below.
      rest = line.slice(loop[1]!.length);
    }
    for (const match of rest.matchAll(EXPANSION_WRITE)) mentioned.add(match[1]!);
    for (const match of rest.replace(EXPANSION, " ").matchAll(WORD)) mentioned.add(match[0]);
  }
  const settled = (name: string, into: Map<string, Written>): ReadonlyArray<string> | null => {
    const written = into.get(name);
    if (written === undefined || written.opaque || written.sets.length === 0) return null;
    if (mentioned.has(name) || (written.positional && resets)) return null;
    const first = written.sets[0]!.join(" ");
    return written.sets.every((set) => set.join(" ") === first) ? written.sets[0]! : null;
  };
  for (const loop of loops) {
    const items = settled(loop.from, arrays);
    // A list that is not known makes the loop's variable unknown too.
    write(scalars, loop.name, items ?? ["$("]);
  }
  for (const name of scalars.keys()) {
    const values = settled(name, scalars);
    if (values !== null) known.set(name, values);
  }
  return known;
}

/** A written part as its values, and the variable it was read from or could not be. */
function resolve(part: string, known: Map<string, ReadonlyArray<string>>) {
  const variable = VARIABLE.exec(part);
  if (!variable) return { values: [part] as ReadonlyArray<string>, variable: null, found: true };
  const values = known.get(variable[1]!);
  return { values: values ?? [], variable: variable[1]!, found: values !== undefined };
}

const key = (target: SshTarget) =>
  `${target.kind}\n${target.user ?? ""}\n${target.host ?? ""}\n${target.variable ?? ""}`;

/**
 * The `user@host` destinations of ssh, scp and rsync commands in a script's
 * text. `more` says the script names more of them than the list holds.
 */
export function sshTargetsInScript(script: string): {
  readonly targets: Array<SshTarget>;
  readonly more: boolean;
  /** The script connects somewhere, whether or not the place could be read. */
  readonly used: boolean;
} {
  // Comment lines describe a command; they do not run one.
  const text = script
    .split("\n")
    .filter((line) => !/^\s*#/u.test(line))
    .join("\n");
  const found = new Map<string, SshTarget>();
  let used = false;
  let known: Map<string, ReadonlyArray<string>> | null = null;
  for (const match of text.matchAll(COMMAND)) {
    const tokens = words(match[2]!);
    // A command that brings its own key and ignores the person's SSH setup needs none of it.
    const ownConfig = tokens.some(
      (token, index) => token === "-F" && tokens[index + 1] === "/dev/null",
    );
    if (ownConfig && tokens.includes("-i")) continue;
    for (let index = 0; index < tokens.length; index += 1) {
      const token = tokens[index]!;
      if (token.startsWith("-")) {
        // `-p 22`, and flags written together whose last one takes the value: `-vp 22`.
        const bundled = /^-[A-Za-z]{2,}$/u.test(token) && VALUE_OPTIONS.has(`-${token.at(-1)}`);
        if (VALUE_OPTIONS.has(token) || bundled) index += 1;
        continue;
      }
      // After ssh's destination come the words of the remote command, which may hold an `@`.
      const last = match[1] === "ssh";
      if (LOOSE_DESTINATION.test(token)) used = true;
      const destination = DESTINATION.exec(token);
      if (!destination) {
        // Options kept in a variable come before the destination: `ssh $OPTS user@host`.
        if (last && !token.startsWith("$")) break;
        continue;
      }
      if (last) index = tokens.length;
      known ??= assignments(text);
      const user = resolve(destination[1]!, known);
      const host = resolve(destination[2]!, known);
      const users = user.values.filter(isSafeSshUser);
      const names: ReadonlyArray<string | null> = users.length > 0 ? users : [null];
      const variable =
        host.variable !== null && isShellVariableName(host.variable) ? host.variable : null;
      const hosts = host.found
        ? [...new Set(host.values.map((value) => value.toLowerCase()))].filter(isSafeSshHost)
        : [];
      for (const name of names) {
        if (hosts.length === 0) {
          // A literal that failed the pattern is dropped; an unread variable is named.
          if (variable === null) continue;
          const target: SshTarget = { kind: "variable", user: name, host: null, variable };
          found.set(key(target), target);
          continue;
        }
        for (const value of hosts) {
          const target: SshTarget = { kind: "server", user: name, host: value, variable };
          found.set(key(target), target);
        }
      }
    }
  }
  const targets = [...found.values()];
  return {
    targets: targets.slice(0, MAX_SSH_TARGETS),
    more: targets.length > MAX_SSH_TARGETS,
    used,
  };
}

/** A Git remote that travels over SSH, as its user and host; null for HTTPS and local paths. */
export function sshRemoteTarget(url: string): SshTarget | null {
  const value = url.trim();
  let name: string | undefined;
  let place: string;
  const scheme = /^(?:git\+)?ssh:\/\/([^/?#]*)/iu.exec(value);
  if (scheme) {
    // The whole authority first: `user:password@host` must not be read as host `user`.
    const authority = scheme[1]!;
    const at = authority.lastIndexOf("@");
    name = at === -1 ? undefined : authority.slice(0, at);
    if (name !== undefined && (name === "" || /[:@]/u.test(name))) return null;
    place = authority.slice(at + 1).replace(/:[0-9]*$/u, "");
  } else {
    const scp = /^([^/@:\s]+)@([^/:@\s[\]]+):(?!\/\/)/u.exec(value);
    if (!scp) return null;
    name = scp[1]!;
    place = scp[2]!;
  }
  const host = place.toLowerCase();
  if (!isSafeSshHost(host)) return null;
  const user = name !== undefined && isSafeSshUser(name) ? name : null;
  return { kind: "git", user, host, variable: null };
}
