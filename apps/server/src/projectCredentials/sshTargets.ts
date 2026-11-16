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

const COMMAND = /(?:^|[\s;&|(`'"=])(?:\/usr\/bin\/)?(?:ssh|scp|rsync)[ \t]+([^\n]*)/gu;
const NAME = "[A-Za-z_][A-Za-z0-9_]*";
const PART = String.raw`(?:\$\{${NAME}\}|\$${NAME}|[A-Za-z0-9_.-]+)`;
const DESTINATION = new RegExp(`^(${PART})@(${PART})(?::.*)?$`, "u");
const VARIABLE = new RegExp(String.raw`^\$\{?(${NAME})\}?$`, "u");
const LITERAL = /^[A-Za-z0-9_.-]+$/u;
/** `"$@"`, `$1`, `${2}`: what the caller passed, which a written default stands in for. */
const POSITIONAL = /^\$(?:[@*]|\{?[0-9]+\}?)$/u;
const ARRAY = new RegExp(
  String.raw`^\s*(?:export\s+|readonly\s+|local\s+)?(${NAME})=\(([^)]*)\)`,
  "u",
);
const SCALAR = new RegExp(
  String.raw`^\s*(?:export\s+|readonly\s+|local\s+)?(${NAME})=(\S*)\s*(?:#.*)?$`,
  "u",
);
const FALLBACK = new RegExp(String.raw`^\$\{(?:${NAME}|[0-9]+):-([^}]*)\}$`, "u");
const LOOP = new RegExp(String.raw`^\s*for\s+(${NAME})\s+in\s+(.+?)\s*(?:;|$)`, "u");
const LOOP_OVER = new RegExp(String.raw`^"?\$\{(${NAME})\[[@*]\]\}"?$`, "u");

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
}

/**
 * The plain values a file gives its own variables: `A=x`, `A="${A:-x}"`,
 * `A=(x y)`, `for A in x y`, `for A in "${LIST[@]}"`. A variable counts as
 * known only when the file writes it once (apart from taking the caller's
 * arguments): two different values, or a value from a command, another
 * variable or a file, leave it unknown.
 */
function assignments(text: string): Map<string, ReadonlyArray<string>> {
  const scalars = new Map<string, Written>();
  const arrays = new Map<string, Written>();
  const write = (into: Map<string, Written>, name: string, values: ReadonlyArray<string>) => {
    const written = into.get(name) ?? { sets: [], opaque: false };
    into.set(name, written);
    const passed = values.length > 0 && values.every((value) => POSITIONAL.test(value));
    if (passed) return;
    if (values.length === 0 || values.length > MAX_VALUES || !values.every((v) => LITERAL.test(v)))
      written.opaque = true;
    else written.sets.push(values);
  };
  const loops: Array<{ readonly name: string; readonly from: string }> = [];
  for (const raw of text.split("\n")) {
    const line = raw.slice(0, MAX_LINE);
    const array = ARRAY.exec(line);
    if (array) {
      write(arrays, array[1]!, words(array[2]!));
      continue;
    }
    const scalar = SCALAR.exec(line);
    if (scalar) {
      const value = unquote(scalar[2]!);
      const fallback = FALLBACK.exec(value);
      write(scalars, scalar[1]!, [fallback ? fallback[1]! : value]);
      continue;
    }
    const loop = LOOP.exec(line);
    if (loop) {
      const over = LOOP_OVER.exec(loop[2]!.trim());
      if (over) loops.push({ name: loop[1]!, from: over[1]! });
      else write(scalars, loop[1]!, words(loop[2]!));
    }
  }
  const settled = (written: Written | undefined): ReadonlyArray<string> | null => {
    if (written === undefined || written.opaque || written.sets.length === 0) return null;
    const first = written.sets[0]!.join(" ");
    return written.sets.every((set) => set.join(" ") === first) ? written.sets[0]! : null;
  };
  for (const loop of loops) {
    const items = settled(arrays.get(loop.from));
    if (items === null) write(scalars, loop.name, ["$("]);
    else write(scalars, loop.name, items);
  }
  const known = new Map<string, ReadonlyArray<string>>();
  for (const [name, written] of scalars) {
    const values = settled(written);
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
export function sshTargetsInScript(text: string): {
  readonly targets: Array<SshTarget>;
  readonly more: boolean;
} {
  const found = new Map<string, SshTarget>();
  let known: Map<string, ReadonlyArray<string>> | null = null;
  for (const match of text.matchAll(COMMAND)) {
    const tokens = words(match[1]!);
    // A command that brings its own key and ignores the person's SSH setup needs none of it.
    const ownConfig = tokens.some(
      (token, index) => token === "-F" && tokens[index + 1] === "/dev/null",
    );
    if (ownConfig && tokens.includes("-i")) continue;
    for (let index = 0; index < tokens.length; index += 1) {
      const token = tokens[index]!;
      if (token.startsWith("-")) {
        if (VALUE_OPTIONS.has(token)) index += 1;
        continue;
      }
      const destination = DESTINATION.exec(token);
      if (!destination) continue;
      known ??= assignments(text);
      const user = resolve(destination[1]!, known);
      const host = resolve(destination[2]!, known);
      const users = user.values.filter(isSafeSshUser);
      const names: ReadonlyArray<string | null> = users.length > 0 ? users : [null];
      const variable =
        host.variable !== null && isShellVariableName(host.variable) ? host.variable : null;
      const hosts = host.found ? host.values.filter(isSafeSshHost) : [];
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
  return { targets: targets.slice(0, MAX_SSH_TARGETS), more: targets.length > MAX_SSH_TARGETS };
}

/** A Git remote that travels over SSH, as its user and host; null for HTTPS and local paths. */
export function sshRemoteTarget(url: string): SshTarget | null {
  const value = url.trim();
  const scheme = /^(?:git\+)?ssh:\/\/(?:([^/@:]+)@)?([^/:?#[\]]+)/iu.exec(value);
  const scp = scheme ? null : /^([^/@:\s]+)@([^/:@\s[\]]+):(?!\/\/)/u.exec(value);
  const parts = scheme ?? scp;
  if (!parts) return null;
  const host = parts[2]!.toLowerCase();
  if (!isSafeSshHost(host)) return null;
  const user = parts[1] !== undefined && isSafeSshUser(parts[1]) ? parts[1] : null;
  return { kind: "git", user, host, variable: null };
}
