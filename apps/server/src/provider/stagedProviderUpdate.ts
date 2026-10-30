// @effect-diagnostics nodeBuiltinImport:off -- Installer boundary; only verified private provider files are accessed.
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
export interface StagedCodexUpdate {
  readonly wrapperPath: string;
  readonly expectedWrapper: string;
  readonly releasesDirectory: string;
  readonly nodePath: string;
  readonly npmCliPath: string;
}

/** No scripts, shell, global installs, auth homes, or old-release mutations. */
export async function stageCodexUpdate(
  input: StagedCodexUpdate,
  version: string,
  run: (command: string, args: readonly string[]) => Promise<string> = async (command, args) =>
    (await exec(command, [...args], { timeout: 240_000, maxBuffer: 64 * 1024 })).stdout,
) {
  if (!/^\d+\.\d+\.\d+$/.test(version))
    throw new Error("Cannot verify the latest stable Codex version. Refresh Providers and retry.");
  const assertUnchanged = async () => {
    for (const target of [
      input.wrapperPath,
      input.releasesDirectory,
      input.nodePath,
      input.npmCliPath,
    ]) {
      if ((await fs.realpath(target)) !== target)
        throw new Error("Provider installation changed. Refresh Providers and retry.");
    }
    if ((await fs.readFile(input.wrapperPath, "utf8")) !== input.expectedWrapper)
      throw new Error("Provider wrapper changed. Refresh Providers and retry.");
  };
  await assertUnchanged();
  const stage = await fs.mkdtemp(path.join(input.releasesDirectory, `codex-${version}-`));
  await fs.chmod(stage, 0o700);
  await run(input.nodePath, [
    input.npmCliPath,
    "install",
    "--prefix",
    stage,
    "--ignore-scripts",
    "--save-exact",
    "--registry=https://registry.npmjs.org",
    `@openai/codex@${version}`,
  ]);
  const packageDirectory = path.join(stage, "node_modules/@openai/codex");
  const manifest = JSON.parse(
    await fs.readFile(path.join(packageDirectory, "package.json"), "utf8"),
  );
  if (manifest.name !== "@openai/codex" || manifest.version !== version)
    throw new Error(
      "The staged Codex package did not match the requested version. Existing installation preserved.",
    );
  const entrypoint = path.join(packageDirectory, "bin/codex.js");
  if ((await fs.realpath(entrypoint)) !== entrypoint)
    throw new Error("The staged Codex entrypoint is redirected. Existing installation preserved.");
  const output = (await run(input.nodePath, [entrypoint, "--version"])).trim();
  if (output !== `codex-cli ${version}`)
    throw new Error(
      `The staged Codex executable reported ${JSON.stringify(output)}. Existing installation preserved.`,
    );
  await assertUnchanged();
  const next = `#!/bin/sh\nset -eu\nexec ${input.nodePath} ${entrypoint} "$@"\n`;
  const temporary = path.join(
    path.dirname(input.wrapperPath),
    `.codex-update-${path.basename(stage)}`,
  );
  await fs.writeFile(temporary, next, { mode: 0o700, flag: "wx" });
  try {
    await assertUnchanged();
    await fs.rename(temporary, input.wrapperPath);
  } finally {
    await fs.unlink(temporary).catch(() => undefined);
  }
  return `Verified Codex ${version}. New sessions use the update; existing release files were preserved.`;
}

/**
 * Exact configured paths and package identities also catch renamed and Node entrypoints;
 * the bare-name match always applies, so a shell-started `claude -p` or `codex exec` counts.
 * When paths or a package are known, a process running from Codex's own managed package
 * store (`~/.codex/packages/`, e.g. the managed app-server daemon) does not: this installer
 * never touches those files.
 */
export function providerProcessesInUse(
  commands: string,
  provider: string,
  paths: readonly string[],
  packageName?: string,
  options: { readonly selfPid?: number } = {},
): boolean {
  return findProviderProcessesInUse(commands, provider, paths, packageName, options).length > 0;
}

interface PsRow {
  readonly pid: number | null;
  readonly ppid: number | null;
  readonly command: string;
}

/** Rows of `ps -o pid=,ppid=,command=`; `pid=,command=` rows and bare commands also parse. */
function parsePsRows(output: string): PsRow[] {
  return output.split("\n").flatMap((line): PsRow[] => {
    if (!line.trim()) return [];
    const full = /^\s*(\d+)\s+(\d+)\s+(\S.*)$/.exec(line);
    if (full) return [{ pid: Number(full[1]), ppid: Number(full[2]), command: full[3]! }];
    const pidOnly = /^\s*(\d+)\s+(\S.*)$/.exec(line);
    if (pidOnly) return [{ pid: Number(pidOnly[1]), ppid: null, command: pidOnly[2]! }];
    return [{ pid: null, ppid: null, command: line }];
  });
}

const INTERACTIVE_SHELLS = new Set([
  "sh",
  "bash",
  "zsh",
  "fish",
  "dash",
  "ksh",
  "tcsh",
  "csh",
  "nu",
  "pwsh",
  "powershell",
]);

/** argv0 basename, leading "-" (login shell) stripped, is an interactive shell. */
function isInteractiveShell(command: string | undefined) {
  if (command === undefined) return false;
  const [argv0 = ""] = command.trim().split(/\s+/);
  const name = (argv0.split("/").pop() ?? argv0).replace(/^-/, "").toLowerCase();
  return INTERACTIVE_SHELLS.has(name.replace(/\.exe$/, ""));
}

/**
 * True when `pid` descends from `selfPid` with no interactive shell strictly between them,
 * so the process is SpecWithCode's own session and not one the user runs in a terminal tab.
 */
function ownedByServer(
  pid: number | null,
  selfPid: number,
  parents: ReadonlyMap<number, number>,
  commandsByPid: ReadonlyMap<number, string>,
) {
  if (pid === null) return false;
  const seen = new Set<number>();
  let throughShell = false;
  for (let current: number | null = pid; current !== null && current > 0 && !seen.has(current);) {
    if (current === selfPid) return !throughShell;
    if (current !== pid && isInteractiveShell(commandsByPid.get(current))) throughShell = true;
    seen.add(current);
    current = parents.get(current) ?? null;
  }
  return false;
}

const basename = (value: string) => value.split("/").pop() ?? value;

/**
 * Processes that would hold this installer's files. `commands` is `ps -o pid=,ppid=,command=`
 * output. `selfPid` (this server) and its descendants, such as SpecWithCode's own provider
 * sessions, never count, unless an interactive shell (a terminal tab's pty) sits between.
 */
export function findProviderProcessesInUse(
  commands: string,
  provider: string,
  paths: readonly string[],
  packageName?: string,
  options: { readonly selfPid?: number } = {},
): Array<{ readonly pid: number | null; readonly command: string }> {
  const name = provider === "claudeAgent" ? "claude" : provider;
  // argv0's basename only, case-sensitive: "Claude" (the desktop app) and a "/codex/" folder
  // in an argument are not the CLI.
  const argv0 = (command: string) => basename(command.trim().split(/\s+/)[0] ?? "");
  const named = (command: string) => argv0(command).replace(/\.(?:exe|cmd)$/i, "") === name;
  const targets = paths.filter((target) => target.length > 0);
  const scoped = targets.length > 0 || !!packageName;
  // `node <dir>/bin/codex`: the CLI's JS entrypoint, often through a version-manager shim.
  const nodeEntrypoint = (command: string) => {
    const [executable = "", script] = command.trim().split(/\s+/);
    const scriptName = script ? basename(script).toLowerCase() : "";
    return (
      /^node(?:js)?(?:\.exe)?$/i.test(basename(executable)) &&
      (scriptName === name.toLowerCase() || scriptName === `${name.toLowerCase()}.js`)
    );
  };
  const runsInstall = (command: string) =>
    targets.some((target) => command.includes(target)) ||
    (!!packageName && command.includes(`/node_modules/${packageName}/`));
  const rows = parsePsRows(commands);
  const parents = new Map<number, number>();
  const commandsByPid = new Map<number, string>();
  for (const row of rows) {
    if (row.pid !== null) commandsByPid.set(row.pid, row.command);
    if (row.pid !== null && row.ppid !== null) parents.set(row.pid, row.ppid);
  }
  // Codex's own managed daemon runs from its package store, never from the install updated here.
  const managedStore = (command: string) =>
    name === "codex" &&
    !targets.some((target) => command.includes(target)) &&
    (command.trim().split(/\s+/)[0] ?? "").includes("/.codex/packages/");
  return rows.flatMap((row) => {
    if (
      options.selfPid !== undefined &&
      ownedByServer(row.pid, options.selfPid, parents, commandsByPid)
    )
      return [];
    if (scoped && managedStore(row.command)) return [];
    const inUse = named(row.command) || nodeEntrypoint(row.command) || runsInstall(row.command);
    return inUse ? [{ pid: row.pid, command: row.command }] : [];
  });
}

/** Executable basename plus a path tail or subcommand; later arguments may hold prompts or secrets. */
export function shortProcessLabel(command: string): string {
  const [executable = "", second] = command.trim().split(/\s+/);
  const tail = (value: string) => {
    const parts = value.split("/").filter(Boolean);
    return parts.length > 2 ? `.../${parts.slice(-2).join("/")}` : value;
  };
  const head = executable.split("/").pop() ?? executable;
  const detail =
    second === undefined
      ? ""
      : second.includes("/")
        ? ` ${tail(second)}`
        : /^[a-z][\w-]{0,30}$/.test(second)
          ? ` ${second}`
          : "";
  return `${head}${detail}`.slice(0, 80);
}

/** The installer-idle check refused because a matching CLI process is running. */
export class ProviderInUseError extends Error {}

export async function assertProviderInstallerIdle(
  provider: string,
  paths: readonly string[] = [],
  packageName?: string,
) {
  const name = provider === "claudeAgent" ? "claude" : provider;
  if (!/^[a-zA-Z0-9_-]+$/.test(name) || process.platform === "win32")
    throw new Error(
      "Cannot verify that this installer is idle. Update with its owning installer after closing provider sessions.",
    );
  const { stdout } = await exec("/bin/ps", ["-axww", "-o", "pid=,ppid=,command="], {
    timeout: 5000,
    maxBuffer: 4 * 1024 * 1024,
  });
  const matches = findProviderProcessesInUse(stdout, provider, paths, packageName, {
    selfPid: process.pid,
  });
  if (matches.length > 0) {
    const first = matches[0]!;
    const more = matches.length > 1 ? ` and ${matches.length - 1} more` : "";
    throw new ProviderInUseError(
      `${name} is running (pid ${first.pid ?? "unknown"}: ${shortProcessLabel(first.command)}${more}). ` +
        "Update anyway to install now; running sessions keep the current version until they restart. No processes were stopped.",
    );
  }
}
