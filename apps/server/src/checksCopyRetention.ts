// @effect-diagnostics nodeBuiltinImport:off -- plain synchronous file checks and bounded git calls, shared by the storage sweep through an Effect.sync.
/**
 * Retires checks copies nobody uses.
 *
 * `checks copy` keeps one clone per repository at `<home>/verify/<name>`, and
 * nothing removed one again once its repository was no longer checked. A copy
 * goes only when every reading agrees: no use for 7 days (the last-used
 * marker and Git's own `HEAD`, `FETCH_HEAD` and install-state times), a clean
 * tree with no untracked files, no commit made in it, no stash, no process
 * working in it and the heavy-check gate not held from inside it. Anything
 * that cannot be read keeps the copy.
 *
 * The next `checks copy` of the repository makes the copy again.
 *
 * @module checksCopyRetention
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { studioDefaultHome } from "@specweave-studio/shared/studioIdentity";

import {
  HEAVY_CHECK_DIR_ENV,
  heavyCheckPaths,
  type HeavyCheckPaths,
  readHolder,
} from "./cli/heavyCheckLock.ts";
import { CHECKS_COPY_LAST_USED_FILE, VERIFICATION_STATE_FILE } from "./cli/verificationCopy.ts";
import { errorText, pathInside } from "./scratchPrune.ts";
import { verificationCopyGitDirs } from "./staleGitPacks.ts";

/** A checks copy unused for this long may be retired. */
export const CHECKS_COPY_UNUSED_MS = 7 * 86_400_000;
const COMMAND_TIMEOUT_MS = 20_000;

export interface ChecksCopyFacts {
  readonly path: string;
  /** Newest of the last-used marker, `FETCH_HEAD`, `HEAD` and the install state; null when none can be read. */
  readonly lastUsedMs: number | null;
  /** No changed and no untracked files; ignored files do not count. */
  readonly clean: boolean | null;
  /**
   * Commits made in the copy itself, from its reflogs. A copy is checked out
   * at commits fetched by hash, which no remote-tracking ref records, so
   * "on no remote" says nothing here; a commit, merge, rebase or pick does.
   */
  readonly localCommits: number | null;
  readonly stash: boolean | null;
  /** Null when the caller could not list process working folders. */
  readonly processInside: boolean | null;
  /** The heavy-check gate's holder works in the copy or inside it. */
  readonly gateHeldInside: boolean | null;
}

export interface ChecksCopyDecision {
  readonly action: "remove" | "keep";
  readonly reason: string;
}

export interface ChecksCopyReadOptions {
  /** Working folders of the processes on this machine; null when unknown, which keeps every copy. */
  readonly processCwds: ReadonlyArray<string> | null;
  /** The app home: copies live at `<home>/verify/<name>`. */
  readonly home: string;
  /** The heavy-check gate's folder; the machine-wide one by default. Tests pass their own. */
  readonly gatePaths?: HeavyCheckPaths;
}

export interface ChecksCopyRetireOptions extends ChecksCopyReadOptions {
  readonly nowMs: number;
}

export interface ChecksCopyRetirement {
  readonly removed: boolean;
  readonly reason: string;
  /** Size before removal, from `du`; null when it could not be read. */
  readonly bytes?: number | null;
}

const days = (ms: number) => `${Math.floor(ms / 86_400_000)} days`;

/**
 * Whether one checks copy goes. Pure: every unknown reading keeps it, and so
 * does a last use in the future or within `CHECKS_COPY_UNUSED_MS`.
 */
export function decideChecksCopy(facts: ChecksCopyFacts, nowMs: number): ChecksCopyDecision {
  const keep = (reason: string): ChecksCopyDecision => ({ action: "keep", reason });
  const unread: ReadonlyArray<readonly [unknown, string]> = [
    [facts.lastUsedMs, "when it was last used"],
    [facts.clean, "whether its tree is clean"],
    [facts.localCommits, "whether commits were made in it"],
    [facts.stash, "whether it has a stash"],
    [facts.processInside, "whether a process works in it"],
    [facts.gateHeldInside, "whether the heavy-check gate is held from inside it"],
  ];
  for (const [value, what] of unread)
    if (value === null) return keep(`Kept: ${what} could not be read.`);
  const lastUsedMs = facts.lastUsedMs as number;
  if (!Number.isFinite(lastUsedMs) || lastUsedMs > nowMs)
    return keep("Kept: its last use is in the future, so its age is unknown.");
  if (nowMs - lastUsedMs < CHECKS_COPY_UNUSED_MS)
    return keep(`Kept: used ${days(nowMs - lastUsedMs)} ago, within 7 days.`);
  if (facts.clean === false) return keep("Kept: it has uncommitted or untracked files.");
  if ((facts.localCommits as number) > 0)
    return keep(`Kept: ${facts.localCommits} commits were made in it and may be nowhere else.`);
  if (facts.stash === true) return keep("Kept: it has a stash.");
  if (facts.processInside === true) return keep("Kept: a process works in it.");
  if (facts.gateHeldInside === true) return keep("Kept: the heavy-check gate is held from inside it.");
  return { action: "remove", reason: `Unused for ${days(nowMs - lastUsedMs)} with nothing to lose.` };
}

/** Git's output, trimmed, or null when it failed, timed out or could not start. */
function gitOrNull(cwd: string, args: ReadonlyArray<string>): string | null {
  try {
    return NodeChildProcess.execFileSync("git", [...args], {
      cwd,
      encoding: "utf8",
      timeout: COMMAND_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
      // Reading a copy must not touch it: `git status` would otherwise rewrite the index.
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" },
    }).trim();
  } catch {
    return null;
  }
}

function mtimeOrNull(path: string): number | null {
  try {
    const mtimeMs = NodeFS.lstatSync(path).mtimeMs;
    return Number.isFinite(mtimeMs) ? mtimeMs : null;
  } catch {
    return null;
  }
}

function lastUsedMs(copy: string): number | null {
  const gitDir = NodePath.join(copy, ".git");
  const times = [CHECKS_COPY_LAST_USED_FILE, "FETCH_HEAD", "HEAD", VERIFICATION_STATE_FILE]
    .map((name) => mtimeOrNull(NodePath.join(gitDir, name)))
    .filter((time): time is number => time !== null);
  return times.length === 0 ? null : Math.max(...times);
}

function isClean(copy: string): boolean | null {
  // A copy whose first checkout never happened holds only .git; git reports every file as deleted.
  try {
    if (NodeFS.readdirSync(copy).every((name) => name === ".git")) return true;
  } catch {
    return null;
  }
  // `--untracked-files=normal` so a user's `status.showUntrackedFiles=no` cannot hide them.
  const status = gitOrNull(copy, ["status", "--porcelain", "--untracked-files=normal"]);
  return status === null ? null : status.length === 0;
}

/** Reflog subjects of work done in the copy, as Git writes them. */
const LOCAL_COMMIT_SUBJECT = /^(commit|merge|cherry-pick|revert|rebase|am|pull)\b/;

/** Reflog entries, of every ref, that record a commit made in the copy; null when unreadable. */
function localCommits(copy: string): number | null {
  const subjects = gitOrNull(copy, ["log", "-g", "--all", "--format=%gs"]);
  if (subjects === null) return null;
  return subjects.split("\n").filter((subject) => LOCAL_COMMIT_SUBJECT.test(subject)).length;
}

function hasStash(copy: string): boolean | null {
  const list = gitOrNull(copy, ["stash", "list"]);
  return list === null ? null : list.length > 0;
}

/** The copy's own path and its real path, so either spelling of a working folder matches. */
function copySpellings(copy: string): ReadonlyArray<string> {
  try {
    const real = NodeFS.realpathSync(copy);
    return real === copy ? [copy] : [copy, real];
  } catch {
    return [copy];
  }
}

const insideAny = (spellings: ReadonlyArray<string>, cwd: string) =>
  spellings.some((spelling) => pathInside(spelling, NodePath.resolve(cwd), false));

/** The machine-wide gate folder, by the same rule as `machineHeavyCheckPaths` in cli/checks.ts. */
function machineGatePaths(): HeavyCheckPaths {
  const override = process.env[HEAVY_CHECK_DIR_ENV]?.trim();
  return heavyCheckPaths(
    override
      ? NodePath.resolve(override)
      : NodePath.join(studioDefaultHome(NodeOS.homedir()), "locks"),
  );
}

function gateHeldInside(spellings: ReadonlyArray<string>, paths: HeavyCheckPaths): boolean | null {
  let lockExists: boolean;
  try {
    NodeFS.lstatSync(paths.lockFile);
    lockExists = true;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "ENOENT") return null;
    lockExists = false;
  }
  if (!lockExists) return false;
  const holder = readHolder(paths);
  if (holder === null || typeof holder.cwd !== "string") return null;
  return insideAny(spellings, holder.cwd);
}

/** Every reading `decideChecksCopy` needs, for one copy. Never throws; failures read as null. */
export function readChecksCopyFacts(
  copyPath: string,
  options: ChecksCopyReadOptions,
): ChecksCopyFacts {
  const spellings = copySpellings(copyPath);
  return {
    path: copyPath,
    lastUsedMs: lastUsedMs(copyPath),
    clean: isClean(copyPath),
    localCommits: localCommits(copyPath),
    stash: hasStash(copyPath),
    processInside:
      options.processCwds === null
        ? null
        : options.processCwds.some((cwd) => insideAny(spellings, cwd)),
    gateHeldInside: gateHeldInside(spellings, options.gatePaths ?? machineGatePaths()),
  };
}

/**
 * The checks copies under `<baseDir>/verify`: real folders with a real `.git`
 * folder. Links are never followed, so nothing outside `verify` is listed.
 */
export function listChecksCopies(baseDir: string): ReadonlyArray<string> {
  return verificationCopyGitDirs(baseDir).map((gitDir) => NodePath.dirname(gitDir));
}

function sizeOrNull(path: string): number | null {
  try {
    const out = NodeChildProcess.execFileSync("du", ["-sk", path], {
      encoding: "utf8",
      timeout: COMMAND_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "ignore"],
      env: { ...process.env, LC_ALL: "C" },
    });
    const kib = Number.parseInt(out.trim().split(/\s+/)[0] ?? "", 10);
    return Number.isFinite(kib) ? kib * 1024 : null;
  } catch {
    return null;
  }
}

/**
 * Removes one checks copy when `decideChecksCopy` says so on facts read just
 * now. The copy's real path must be exactly `<realpath(home)>/verify/<name>`
 * and not a link. A checks copy is a clone the app made and makes again on
 * the next `checks copy`, so deleting its folder is the only way to retire
 * it: `fs.rmSync(copy, { recursive: true })`, without `force` or retries, and
 * `mergedCloneSweep.removeClone` does not fit (it decides on a different
 * reading and removes dated parents). A removal that throws midway leaves a
 * partial copy, which then reads as dirty and stays; nothing is retried.
 */
export function retireChecksCopy(
  copyPath: string,
  options: ChecksCopyRetireOptions,
): ChecksCopyRetirement {
  const decision = decideChecksCopy(readChecksCopyFacts(copyPath, options), options.nowMs);
  if (decision.action !== "remove") return { removed: false, reason: decision.reason };
  let real: string;
  try {
    const verify = NodePath.join(NodeFS.realpathSync(options.home), "verify");
    real = NodeFS.realpathSync(copyPath);
    const name = NodePath.basename(real);
    if (
      NodeFS.lstatSync(copyPath).isSymbolicLink() ||
      name === "" ||
      name === "." ||
      name === ".." ||
      real !== NodePath.join(verify, name) ||
      NodePath.resolve(copyPath) !== NodePath.join(NodePath.resolve(options.home), "verify", name)
    )
      return { removed: false, reason: "Kept: it is not a checks copy folder inside verify." };
  } catch (cause) {
    return { removed: false, reason: `Kept: its folder could not be checked: ${errorText(cause)}` };
  }
  const bytes = sizeOrNull(real);
  try {
    NodeFS.rmSync(real, { recursive: true });
    return { removed: true, reason: decision.reason, bytes };
  } catch (cause) {
    return { removed: false, reason: `Could not remove it: ${errorText(cause)}`, bytes };
  }
}
