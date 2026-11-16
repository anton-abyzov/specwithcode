/**
 * Where a project connects over SSH, read from the text of its scripts and the
 * URLs of its Git remotes. Nothing is run or sourced: a target written with
 * shell variables is filled in only from plain assignments in the same file,
 * and one that cannot be is reported by its variable's name.
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
const VALUE_OPTIONS = new Set([
  "-b",
  "-B",
  "-c",
  "-D",
  "-e",
  "-E",
  "-F",
  "-i",
  "-I",
  "-J",
  "-l",
  "-L",
  "-m",
  "-o",
  "-O",
  "-p",
  "-P",
  "-Q",
  "-R",
  "-S",
  "-W",
  "-w",
  "-X",
]);

const COMMAND = /(?:^|[\s;&|(`'"=])(?:\/usr\/bin\/)?(?:ssh|scp|rsync)[ \t]+([^\n]*)/gu;
const PART = String.raw`(?:\$\{[A-Za-z_][A-Za-z0-9_]*\}|\$[A-Za-z_][A-Za-z0-9_]*|[A-Za-z0-9_.-]+)`;
const DESTINATION = new RegExp(`^(${PART})@(${PART})(?::.*)?$`, "u");
const VARIABLE = /^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/u;
const LITERAL = /^[A-Za-z0-9_.-]+$/u;

/** Splits on blanks, keeping a quoted run together; quotes are dropped. */
function words(line: string): Array<string> {
  const out: Array<string> = [];
  for (const match of line.slice(0, MAX_LINE).matchAll(/"([^"]*)"|'([^']*)'|(\S+)/gu))
    out.push(match[1] ?? match[2] ?? match[3] ?? "");
  return out;
}

const unquote = (value: string) => value.replace(/^(["'])(.*)\1$/u, "$2");

interface Assignments {
  readonly scalars: Map<string, Set<string>>;
  readonly arrays: Map<string, Set<string>>;
}

/** Plain values a file gives its own variables: `A=x`, `A="${A:-x}"`, `A=(x y)`, `for A in x y`. */
function assignments(text: string): Assignments {
  const scalars = new Map<string, Set<string>>();
  const arrays = new Map<string, Set<string>>();
  const add = (into: Map<string, Set<string>>, name: string, value: string) => {
    if (!LITERAL.test(value)) return;
    const values = into.get(name) ?? new Set<string>();
    into.set(name, values);
    if (values.size < MAX_VALUES) values.add(value);
  };
  const loops: Array<{ readonly name: string; readonly from: string }> = [];
  for (const raw of text.split("\n")) {
    const line = raw.slice(0, MAX_LINE);
    const array = /^\s*(?:export\s+|readonly\s+|local\s+)?([A-Za-z_][A-Za-z0-9_]*)=\(([^)]*)\)/u.exec(
      line,
    );
    if (array) {
      for (const item of words(array[2]!)) add(arrays, array[1]!, item);
      continue;
    }
    const scalar =
      /^\s*(?:export\s+|readonly\s+|local\s+)?([A-Za-z_][A-Za-z0-9_]*)=(\S*)\s*(?:#.*)?$/u.exec(line);
    if (scalar) {
      const value = unquote(scalar[2]!);
      const fallback = /^\$\{[A-Za-z_][A-Za-z0-9_]*:-([^}]*)\}$/u.exec(value);
      add(scalars, scalar[1]!, fallback ? fallback[1]! : value);
      continue;
    }
    const loop = /^\s*for\s+([A-Za-z_][A-Za-z0-9_]*)\s+in\s+(.+?)\s*(?:;|$)/u.exec(line);
    if (loop) {
      const over = /^"?\$\{([A-Za-z_][A-Za-z0-9_]*)\[[@*]\]\}"?$/u.exec(loop[2]!.trim());
      if (over) loops.push({ name: loop[1]!, from: over[1]! });
      else for (const item of words(loop[2]!)) add(scalars, loop[1]!, item);
    }
  }
  for (const loop of loops) for (const item of arrays.get(loop.from) ?? []) add(scalars, loop.name, item);
  return { scalars, arrays };
}

/** A written part as its possible values, or the variable it could not be read from. */
function resolve(
  part: string,
  known: Assignments,
): { readonly values: ReadonlyArray<string>; readonly variable: string | null } {
  const variable = VARIABLE.exec(part);
  if (!variable) return { values: [part], variable: null };
  const values = [...(known.scalars.get(variable[1]!) ?? [])];
  return { values, variable: values.length === 0 ? variable[1]! : null };
}

const key = (target: SshTarget) =>
  `${target.kind}\n${target.user ?? ""}\n${target.host ?? ""}\n${target.variable ?? ""}`;

/** The `user@host` destinations of ssh, scp and rsync commands in a script's text. */
export function sshTargetsInScript(text: string): Array<SshTarget> {
  const found = new Map<string, SshTarget>();
  let known: Assignments | null = null;
  for (const match of text.matchAll(COMMAND)) {
    const tokens = words(match[1]!);
    // A command that brings its own key and ignores the person's SSH setup needs none of it.
    const ownConfig = tokens.some((token, index) => token === "-F" && tokens[index + 1] === "/dev/null");
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
      const userChoices: ReadonlyArray<string | null> = users.length > 0 ? users : [null];
      if (host.variable !== null) {
        if (isShellVariableName(host.variable))
          for (const name of userChoices) {
            const target: SshTarget = { kind: "variable", user: name, host: null, variable: host.variable };
            found.set(key(target), target);
          }
        continue;
      }
      for (const value of host.values) {
        if (!isSafeSshHost(value)) continue;
        for (const name of userChoices) {
          const target: SshTarget = { kind: "server", user: name, host: value, variable: null };
          found.set(key(target), target);
        }
      }
    }
    if (found.size >= MAX_SSH_TARGETS) break;
  }
  return [...found.values()].slice(0, MAX_SSH_TARGETS);
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
