// @effect-diagnostics nodeBuiltinImport:off globalDate:off - the probe walks a project folder and runs gh and git directly.
/**
 * What a machine still needs before a copied project runs there. Every check
 * runs on this machine with its own credentials; nothing is copied from another
 * machine and no credential value enters the report.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import type {
  MachineReadiness,
  MachineReadinessGitHub,
  MachineReadinessRepository,
  MachineReadinessTool,
} from "@specweave-studio/contracts";

import { runGit } from "./folderTransfer/git.ts";
import { withoutCredentials } from "./folderTransfer/manifest.ts";
import { parseGitHubAuthStatus } from "../sourceControl/gitHubAuthStatus.ts";

export const MAX_READINESS_REPOSITORIES = 64;
const MAX_FOLDERS_VISITED = 20_000;
const MAX_DEPTH = 8;
const LS_REMOTE_TIMEOUT_MS = 20_000;
const CONCURRENCY = 4;
const SKIPPED_FOLDERS = new Set(["node_modules", ".pnpm-store", ".venv", "venv", "target"]);

export interface ReadinessScript {
  readonly name: string;
  readonly command: string;
}

export interface ReadinessOptions {
  readonly folder: string | null;
  readonly scripts: ReadonlyArray<ReadinessScript>;
  readonly env?: NodeJS.ProcessEnv;
  /** Replaces `gh auth status --json hosts` in tests. */
  readonly ghAuthStatus?: () => Promise<GhResult>;
  readonly now?: () => Date;
}

export interface GhResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly missing: boolean;
}

/** Collapses anything that looks like a credential in tool output before it is shown. */
export function scrubDetail(text: string): string {
  return text
    .replace(/(https?:\/\/)[^\s/@]+@/g, "$1")
    .replace(/\b(gh[pousr]_[A-Za-z0-9]{8,}|github_pat_[A-Za-z0-9_]{8,})\b/g, "[redacted]")
    .replace(/\b(token|password|secret)[=:]\s*\S+/gi, "$1=[redacted]")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 3)
    .join(" ")
    .slice(0, 1000);
}

function runGh(env: NodeJS.ProcessEnv): Promise<GhResult> {
  return new Promise((resolve) => {
    NodeChildProcess.execFile(
      "gh",
      ["auth", "status", "--json", "hosts"],
      { env: { ...env, GH_PROMPT_DISABLED: "1", NO_COLOR: "1" }, timeout: 15_000 },
      (error, stdout) => {
        const code = (error as NodeJS.ErrnoException | null)?.code;
        resolve({
          code: error ? (typeof code === "number" ? code : null) : 0,
          stdout: String(stdout),
          missing: code === "ENOENT",
        });
      },
    );
  });
}

export async function gitHubReadiness(
  probe: () => Promise<GhResult>,
): Promise<MachineReadinessGitHub> {
  const result = await probe().catch(() => null);
  if (!result) return { status: "unknown", accounts: [], detail: "gh could not be started." };
  if (result.missing) return { status: "not-installed", accounts: [], detail: null };
  const parsed = parseGitHubAuthStatus(result.stdout);
  if (!parsed.parsed)
    return {
      status: "unknown",
      accounts: [],
      detail: "This gh is too old to report its sign-in; update it, then check again.",
    };
  const accounts = parsed.accounts
    .filter((account) => account.authenticated)
    .map((account) => ({ host: account.host, login: account.account }));
  if (accounts.length > 0) return { status: "signed-in", accounts, detail: null };
  const failed = parsed.accounts.find((account) => account.error);
  return {
    status: "signed-out",
    accounts: [],
    detail: failed?.error ? scrubDetail(failed.error) : null,
  };
}

/**
 * Repositories under `root`, outermost first: the root itself, nested clones and
 * linked worktrees. Links are never followed and dependency folders are skipped.
 */
export async function findRepositories(
  root: string,
): Promise<{ readonly paths: Array<string>; readonly truncated: boolean }> {
  const paths: Array<string> = [];
  let visited = 0;
  let truncated = false;
  const queue: Array<{ relative: string; depth: number }> = [{ relative: "", depth: 0 }];
  while (queue.length > 0) {
    const { relative, depth } = queue.shift()!;
    if ((visited += 1) > MAX_FOLDERS_VISITED) {
      truncated = true;
      break;
    }
    const absolute = relative ? NodePath.join(root, relative) : root;
    let entries: Array<NodeFS.Dirent>;
    try {
      entries = await NodeFSP.readdir(absolute, { withFileTypes: true });
    } catch {
      continue;
    }
    if (entries.some((entry) => entry.name === ".git" && !entry.isSymbolicLink())) {
      if (paths.length >= MAX_READINESS_REPOSITORIES) {
        truncated = true;
        break;
      }
      paths.push(relative || ".");
    }
    if (depth >= MAX_DEPTH) continue;
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === ".git" || SKIPPED_FOLDERS.has(entry.name))
        continue;
      queue.push({
        relative: relative ? `${relative}/${entry.name}` : entry.name,
        depth: depth + 1,
      });
    }
  }
  return { paths, truncated };
}

async function checkRepository(
  root: string,
  relative: string,
  env: NodeJS.ProcessEnv,
  seen: Map<string, Promise<Pick<MachineReadinessRepository, "status" | "detail">>>,
): Promise<MachineReadinessRepository> {
  const cwd = relative === "." ? root : NodePath.join(root, relative);
  const remote = await runGit(cwd, ["remote", "get-url", "origin"], { allowFailure: true }).catch(
    () => null,
  );
  const raw = remote?.code === 0 ? remote.stdout.trim() : "";
  if (!raw) return { path: relative, origin: null, status: "no-origin", detail: null };
  const origin = withoutCredentials(raw);
  let pending = seen.get(raw);
  if (!pending) {
    pending = runGit(cwd, ["ls-remote", "--heads", "--quiet", "origin"], {
      allowFailure: true,
      timeoutMs: LS_REMOTE_TIMEOUT_MS,
      env: {
        GIT_TERMINAL_PROMPT: "0",
        GCM_INTERACTIVE: "never",
        GIT_ASKPASS: "",
        SSH_ASKPASS: "",
        ...(env.GIT_SSH_COMMAND
          ? {}
          : { GIT_SSH_COMMAND: "ssh -o BatchMode=yes -o ConnectTimeout=10" }),
      },
    }).then(
      (result) =>
        result.code === 0
          ? { status: "ok" as const, detail: null }
          : { status: "no-access" as const, detail: scrubDetail(result.stderr) || null },
      (cause: { code?: number | null }) =>
        cause?.code === null
          ? { status: "timeout" as const, detail: "The origin did not answer within 20 seconds." }
          : { status: "error" as const, detail: "git could not reach the origin." },
    );
    seen.set(raw, pending);
  }
  return { path: relative, origin: origin ? origin.slice(0, 2048) : null, ...(await pending) };
}

const SHELL_WORDS = new Set([
  "cd",
  "export",
  "source",
  ".",
  "echo",
  "exit",
  "set",
  "unset",
  "true",
  "false",
  "test",
  "[",
  "exec",
  "env",
  "sudo",
  "time",
  "if",
  "then",
  "else",
  "fi",
  "do",
  "done",
  "for",
  "while",
]);

/** The programs a shell command line starts: the first word of each pipeline step. */
export function commandsIn(command: string): Array<string> {
  const result: Array<string> = [];
  for (const step of command.split(/&&|\|\||;|\||\n/)) {
    const words = step.trim().split(/\s+/).filter(Boolean);
    let index = 0;
    while (index < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index]!)) index += 1;
    if (words[index] === "env" || words[index] === "sudo" || words[index] === "exec") index += 1;
    while (index < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index]!)) index += 1;
    const word = words[index]?.replace(/^["']|["']$/g, "");
    if (!word || SHELL_WORDS.has(word) || /[$`()<>{}]/.test(word)) continue;
    result.push(word);
  }
  return result;
}

async function isExecutable(file: string) {
  try {
    const stat = await NodeFSP.stat(file);
    if (!stat.isFile()) return false;
    await NodeFSP.access(file, NodeFS.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function findTool(name: string, folder: string | null, env: NodeJS.ProcessEnv) {
  if (name.includes("/")) {
    if (NodePath.isAbsolute(name)) return isExecutable(name);
    return folder ? isExecutable(NodePath.join(folder, name)) : false;
  }
  for (const directory of (env.PATH ?? "").split(NodePath.delimiter)) {
    if (directory && (await isExecutable(NodePath.join(directory, name)))) return true;
  }
  return false;
}

export async function toolReadiness(
  scripts: ReadonlyArray<ReadinessScript>,
  folder: string | null,
  env: NodeJS.ProcessEnv,
): Promise<Array<MachineReadinessTool>> {
  const seen = new Set<string>();
  const result: Array<MachineReadinessTool> = [];
  for (const script of scripts) {
    for (const name of commandsIn(script.command)) {
      if (seen.has(name) || result.length >= 40) continue;
      seen.add(name);
      result.push({
        name: name.slice(0, 200),
        action: script.name.slice(0, 200),
        found: await findTool(name, folder, env),
      });
    }
  }
  return result;
}

async function forEachLimited<T, R>(
  items: ReadonlyArray<T>,
  limit: number,
  run: (item: T) => Promise<R>,
): Promise<Array<R>> {
  const results: Array<R> = Array.from({ length: items.length });
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const index = next;
        next += 1;
        results[index] = await run(items[index]!);
      }
    }),
  );
  return results;
}

export async function checkMachineReadiness(options: ReadinessOptions): Promise<MachineReadiness> {
  const env = options.env ?? process.env;
  const github = await gitHubReadiness(options.ghAuthStatus ?? (() => runGh(env)));
  let repositories: Array<MachineReadinessRepository> = [];
  let truncated = false;
  if (options.folder) {
    const found = await findRepositories(options.folder);
    truncated = found.truncated;
    const seen = new Map<string, Promise<Pick<MachineReadinessRepository, "status" | "detail">>>();
    repositories = await forEachLimited(found.paths, CONCURRENCY, (relative) =>
      checkRepository(options.folder!, relative, env, seen),
    );
  }
  return {
    checkedAt: (options.now?.() ?? new Date()).toISOString(),
    folder: options.folder,
    github,
    repositories,
    repositoriesTruncated: truncated,
    tools: await toolReadiness(options.scripts, options.folder, env),
  };
}
