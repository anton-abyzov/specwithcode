// @effect-diagnostics nodeBuiltinImport:off globalDate:off - runs Git directly, from a Context.Reference that services read without declaring a dependency.
import * as NodeChildProcess from "node:child_process";

import { TEAM_RULES_MAX_BYTES, TEAM_RULES_REPOSITORY_PATH } from "@specweave-studio/contracts";
import {
  parseTeamRulesRepositoryText,
  teamRulesCombine,
  teamRulesHasZones,
  type TeamRulesLayer,
  teamRulesRepositoryLayer,
  type TeamRulesState,
  teamRulesZoneLayers,
} from "@specweave-studio/shared/teamRules";

/** What Git says about a working folder, read only from committed and remote-tracking state. */
export type TeamRulesFolderRead =
  | {
      readonly kind: "read";
      readonly remotes: ReadonlyArray<string>;
      /** The file at the default branch's remote-tracking ref, absent when it has none. */
      readonly repository: string | undefined;
    }
  | { readonly kind: "failed"; readonly reason: string };

interface GitResult {
  readonly code: number | "failed";
  readonly stdout: string;
  readonly stderr: string;
  readonly tooLarge: boolean;
}

export type TeamRulesGitRun = (
  cwd: string,
  args: ReadonlyArray<string>,
  timeoutMs: number,
) => Promise<GitResult>;

const GIT_BUDGET_MS = 3_000;
const FOLDER_CACHE_MS = 5_000;
const MAX_FOLDERS = 256;
const REPOSITORY_REMOTE = "origin";

/** A repository's Git variables, such as GIT_DIR, could point the read at another one. */
const gitEnvironment = (environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv => ({
  ...Object.fromEntries(Object.entries(environment).filter(([name]) => !name.startsWith("GIT_"))),
  // "Not a repository" is matched on Git's English text.
  LC_ALL: "C",
  GIT_OPTIONAL_LOCKS: "0",
  GIT_TERMINAL_PROMPT: "0",
});

const runGit: TeamRulesGitRun = (cwd, args, timeoutMs) =>
  new Promise((resolve) => {
    NodeChildProcess.execFile(
      "git",
      ["-C", cwd, ...args],
      {
        timeout: timeoutMs,
        maxBuffer: TEAM_RULES_MAX_BYTES + 1,
        env: gitEnvironment(process.env),
        windowsHide: true,
        encoding: "utf8",
      },
      (error, stdout, stderr) => {
        const code = (error as (Error & { code?: unknown }) | null)?.code;
        if (code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
          resolve({ code: "failed", stdout: "", stderr: "", tooLarge: true });
        } else if (error === null) {
          resolve({ code: 0, stdout, stderr, tooLarge: false });
        } else {
          resolve({
            code: typeof code === "number" ? code : "failed",
            stdout,
            stderr,
            tooLarge: false,
          });
        }
      },
    );
  });

const NOT_A_REPOSITORY = /not a git repository|inside a git repository|cannot change to/iu;
const REMOTE_URL_LINE = /^remote\.(.+)\.url\s+(.*)$/iu;

/**
 * Reads the folder's remotes and its committed rules. Never the working tree:
 * an agent's uncommitted edit must not change them. Reads no remote either, so
 * a turn never waits on the network; a fetch is what brings a new rule in.
 */
export async function readTeamRulesFolder(
  cwd: string,
  run: TeamRulesGitRun = runGit,
): Promise<TeamRulesFolderRead> {
  const deadline = Date.now() + GIT_BUDGET_MS;
  const git = (args: ReadonlyArray<string>) => run(cwd, args, Math.max(1, deadline - Date.now()));
  const config = await git(["config", "--local", "--get-regexp", "^remote\\..*\\.url$"]);
  if (config.code === 1) return { kind: "read", remotes: [], repository: undefined };
  if (config.code !== 0) {
    return NOT_A_REPOSITORY.test(config.stderr)
      ? { kind: "read", remotes: [], repository: undefined }
      : { kind: "failed", reason: "Git could not read this folder." };
  }
  const named = config.stdout.split("\n").flatMap((line) => {
    const match = REMOTE_URL_LINE.exec(line.trim());
    return match === null ? [] : [{ name: match[1]!, url: match[2]! }];
  });
  const remotes = named.map(({ url }) => url);
  const names = new Set(named.map(({ name }) => name));
  const remote = names.has(REPOSITORY_REMOTE)
    ? REPOSITORY_REMOTE
    : names.size === 1
      ? named[0]?.name
      : undefined;
  if (remote === undefined) return { kind: "read", remotes, repository: undefined };

  const symbolic = await git(["symbolic-ref", "--quiet", `refs/remotes/${remote}/HEAD`]);
  if (symbolic.code === "failed") {
    return { kind: "failed", reason: "Git could not read this folder." };
  }
  let ref: string | undefined = symbolic.code === 0 ? symbolic.stdout.trim() : undefined;
  if (ref === undefined || !ref.startsWith(`refs/remotes/${remote}/`)) {
    ref = undefined;
    for (const branch of ["main", "master"]) {
      const candidate = `refs/remotes/${remote}/${branch}`;
      const found = await git(["rev-parse", "--verify", "--quiet", candidate]);
      if (found.code === "failed") {
        return { kind: "failed", reason: "Git could not read this folder." };
      }
      if (found.code === 0) {
        ref = candidate;
        break;
      }
    }
  }
  if (ref === undefined) return { kind: "read", remotes, repository: undefined };

  const blob = await git(["cat-file", "blob", `${ref}:${TEAM_RULES_REPOSITORY_PATH}`]);
  if (blob.tooLarge) {
    return { kind: "read", remotes, repository: " ".repeat(TEAM_RULES_MAX_BYTES + 1) };
  }
  if (blob.code === "failed") return { kind: "failed", reason: "Git could not read this folder." };
  return { kind: "read", remotes, repository: blob.code === 0 ? blob.stdout : undefined };
}

/** The limits a read adds. The repository's file is judged here, and only here. */
export function teamRulesFolderLayers(
  machine: TeamRulesState,
  read: Extract<TeamRulesFolderRead, { kind: "read" }>,
): ReadonlyArray<TeamRulesLayer> {
  return [
    ...teamRulesZoneLayers(machine, read.remotes),
    ...(read.repository === undefined
      ? []
      : [teamRulesRepositoryLayer(parseTeamRulesRepositoryText(read.repository))]),
  ];
}

/**
 * A read that fails keeps the last answer. With none, a zone could apply, so a
 * machine with zones holds this folder rather than let it run unlimited.
 * Repository rules are an agreement, and do not stop work when Git is slow.
 */
function combineRead(
  machine: TeamRulesState,
  read: TeamRulesFolderRead,
  lastGood: Extract<TeamRulesFolderRead, { kind: "read" }> | undefined,
): TeamRulesState {
  const usable = read.kind === "read" ? read : lastGood;
  if (usable !== undefined)
    return teamRulesCombine(machine, teamRulesFolderLayers(machine, usable));
  if (read.kind === "failed" && teamRulesHasZones(machine)) {
    return teamRulesCombine(machine, [
      {
        status: "hold",
        source: "zone",
        issues: [read.reason],
        ...(machine.status === "active" ? { owner: machine.rules.owner } : {}),
      },
    ]);
  }
  return machine;
}

/** One uncached read, for a CLI that judges a folder once. */
export async function readTeamRulesFolderState(
  machine: TeamRulesState,
  cwd: string,
): Promise<TeamRulesState> {
  if (machine.status === "hold") return machine;
  return combineRead(machine, await readTeamRulesFolder(cwd), undefined);
}

interface FolderEntry {
  readonly at: number;
  readonly read: Promise<TeamRulesFolderRead>;
  lastGood: Extract<TeamRulesFolderRead, { kind: "read" }> | undefined;
}

/**
 * Answers for one folder at a time, at most one Git read per folder per five
 * seconds. A machine hold needs no Git: it outranks anything a folder could add.
 */
export function makeTeamRulesFolderReader(
  machine: () => TeamRulesState,
  run: TeamRulesGitRun = runGit,
): (cwd: string) => Promise<TeamRulesState> {
  const folders = new Map<string, FolderEntry>();
  return async (cwd) => {
    const current = machine();
    if (current.status === "hold") return current;
    const now = Date.now();
    let entry = folders.get(cwd);
    if (entry === undefined || now - entry.at >= FOLDER_CACHE_MS) {
      const next: FolderEntry = {
        at: now,
        read: readTeamRulesFolder(cwd, run),
        lastGood: entry?.lastGood,
      };
      folders.delete(cwd);
      folders.set(cwd, next);
      if (folders.size > MAX_FOLDERS) {
        const oldest = folders.keys().next().value;
        if (oldest !== undefined) folders.delete(oldest);
      }
      entry = next;
    }
    const read = await entry.read;
    if (read.kind === "read") entry.lastGood = read;
    return combineRead(machine(), read, entry.lastGood);
  };
}
