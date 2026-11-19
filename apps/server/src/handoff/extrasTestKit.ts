// @effect-diagnostics nodeBuiltinImport:off - disposable real Git fixtures only.
/** Real temporary repositories for the Sync extras tests: a bare remote and the project on two machines. */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { CLONE_STAGING_MARK, cloneStagingMarkText } from "../fleet/cloneStaging.ts";

/** The id of a process that has ended. */
const endedPid = () => NodeChildProcess.spawnSync("true").pid ?? 999_999;

/** One Git command the code under test ran: where, its arguments, and whether on a private index. */
export interface RecordedGit {
  readonly cwd: string;
  readonly args: ReadonlyArray<string>;
  readonly privateIndex: boolean;
  /** The Git folder the command was pinned to (`GIT_DIR`), null when it found its own. */
  readonly gitDir: string | null;
  /** The environment the code under test gave the command, on top of this process's. */
  readonly env: Readonly<Record<string, string | undefined>>;
}
const recorded: Array<RecordedGit> = [];
export const recordedGit = (): ReadonlyArray<RecordedGit> => recorded;

/**
 * Lets a test act at an exact point of the code under test: `before` runs (and
 * is awaited) ahead of a command, `after` once it has ended. Cleared by `cleanUp`.
 */
export const gitHooks: {
  before: ((command: RecordedGit) => Promise<void> | void) | null;
  after: ((command: RecordedGit) => void) | null;
} = { before: null, after: null };

type GitModule = typeof import("../fleet/folderTransfer/git.ts");
/**
 * `folderTransfer/git.ts` with every command noted before it runs. A test file
 * passes this to `vi.mock` for that module, so all the code under test (the
 * sender, the receiver, the bundle and checkpoint helpers) is recorded.
 */
export function recordingGit(actual: GitModule): GitModule {
  const runGit: GitModule["runGit"] = async (cwd, args, options) => {
    const command: RecordedGit = {
      cwd,
      args: [...args],
      privateIndex: options?.env?.GIT_INDEX_FILE !== undefined,
      gitDir: options?.env?.GIT_DIR ?? null,
      env: { ...options?.env },
    };
    recorded.push(command);
    await gitHooks.before?.(command);
    try {
      return await actual.runGit(cwd, args, options);
    } finally {
      gitHooks.after?.(command);
    }
  };
  return {
    ...actual,
    runGit,
    gitText: async (cwd, args) => (await runGit(cwd, args)).stdout.trim(),
    gitList: async (cwd, args) => (await runGit(cwd, args)).stdout.split("\0").filter(Boolean),
  };
}

const READS = new Set([
  "rev-parse",
  "rev-list",
  "for-each-ref",
  "status",
  "symbolic-ref",
  "ls-files",
  "diff",
  "diff-tree",
  "ls-tree",
  "cat-file",
  "log",
  "merge-base",
  "check-ref-format",
]);
/** These only ever run on a private index, never the repository's own. */
const PRIVATE_INDEX_ONLY = new Set(["add", "read-tree", "write-tree", "update-index"]);
const HIDDEN = /^refs\/specwithcode\/extras(-incoming)?\//;
const ARRIVAL = /^refs\/heads\/swc\/from-/;

/**
 * Every recorded command that is not one the extras code may run, as text.
 * Allowed: reads; a snapshot built on a private index; hidden refs under
 * `refs/specwithcode/extras/` and `extras-incoming/` written and removed; a
 * bundle created, verified and fetched into a hidden ref; and an arrival
 * branch `swc/from-…` created only where none exists, or moved forward by
 * a fetch from a hidden ref of the same repository. Nothing else: no reset, rebase, stash, checkout, switch,
 * merge, push, commit, pull, clean, restore or tag.
 */
export function gitCommandsNotAllowed(): Array<string> {
  const out: Array<string> = [];
  for (const { args, privateIndex } of recorded) {
    const [verb, ...rest] = args;
    const ok =
      verb === undefined
        ? false
        : READS.has(verb)
          ? true
          : PRIVATE_INDEX_ONLY.has(verb)
            ? privateIndex
            : verb === "commit-tree"
              ? true
              : verb === "stash"
                ? rest.join(" ") === "list"
                : verb === "worktree"
                  ? rest.join(" ") === "list --porcelain"
                  : verb === "init"
                    ? // Only the send's own private repository, made bare and without templates.
                      /^--bare -q --template= --object-format=(sha1|sha256)$/.test(rest.join(" "))
                    : verb === "bundle"
                      ? ["create", "verify", "list-heads"].includes(rest[0] ?? "")
                      : verb === "update-ref"
                        ? rest[0] === "-d"
                          ? // With the commit it was listed at, or without: only ever a hidden ref.
                            (rest.length === 2 || rest.length === 3) && HIDDEN.test(rest[1] ?? "")
                          : HIDDEN.test(rest[0] ?? "") ||
                            // An arrival branch is created only where no ref of that name exists.
                            (ARRIVAL.test(rest[0] ?? "") && rest.length === 3 && rest[2] === "")
                        : verb === "fetch"
                          ? (rest.length === 5 &&
                              rest.slice(0, 3).join(" ") ===
                                "--quiet --no-tags --no-write-fetch-head" &&
                              /^(\/|[A-Za-z]:[\\/])/.test(rest[3] ?? "") &&
                              /:refs\/specwithcode\/extras-incoming\//.test(rest[4] ?? "")) ||
                            // An arrival branch is moved forward from a hidden ref of this very
                            // repository, with no `+`: Git refuses anything but a fast-forward.
                            (rest.length === 8 &&
                              rest.slice(0, 7).join(" ") ===
                                "--quiet --no-tags --no-prune --no-recurse-submodules --no-write-fetch-head --refmap= ." &&
                              /^refs\/specwithcode\/extras-incoming\/[^:+]+:refs\/heads\/swc\/from-[^:]+$/.test(
                                rest[7] ?? "",
                              ))
                          : false;
    if (!ok) out.push(args.join(" ").slice(0, 300));
  }
  return out;
}

const ISOLATED = { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
const saved: Record<string, string | undefined> = {};

/** The code under test runs Git with this process's environment. */
export function isolateGit(): void {
  for (const [key, value] of Object.entries(ISOLATED)) {
    saved[key] = process.env[key];
    process.env[key] = value;
  }
}
export function restoreGit(): void {
  for (const key of Object.keys(ISOLATED)) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
}

export const git = (cwd: string, ...args: Array<string>) =>
  NodeChildProcess.execFileSync(
    "git",
    ["-c", "user.name=Sync Test", "-c", "user.email=sync@example.invalid", "-C", cwd, ...args],
    {
      encoding: "utf8",
      env: { ...process.env, ...ISOLATED, GIT_TERMINAL_PROMPT: "0" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  ).trim();

export const write = (folder: string, name: string, text: string | Buffer) => {
  NodeFS.mkdirSync(NodePath.dirname(NodePath.join(folder, name)), { recursive: true });
  NodeFS.writeFileSync(NodePath.join(folder, name), text);
};
export const commit = (folder: string, name: string, text: string) => {
  write(folder, name, text);
  git(folder, "add", "-f", "--", name);
  git(folder, "commit", "-q", "-m", `change ${name}`);
  return git(folder, "rev-parse", "HEAD");
};

/** A token-shaped value assembled at run time, so no key-like literal sits in the repository. */
export const fakeToken = () => ["gh", "p_", "A1b2C3d4E5f6".repeat(3)].join("");
export const fakeKeyHeader = () => ["-----BEGIN ", "PRIVATE KEY-----"].join("");

const temporary: Array<string> = [];
/**
 * A clone's staging folder as a server that stopped mid-clone leaves it: the
 * mark (its owner gone), and the half-made clone. `mark: false` makes a person's own folder
 * that merely has such a name; `repository: false` leaves the clone without
 * its `.git` (stopped before Git made it, or half removed).
 */
export function stagingFolder(
  root: string,
  relative: string,
  options: { readonly mark?: boolean; readonly repository?: boolean } = {},
): string {
  const folder = NodePath.join(root, ...relative.split("/"));
  const clone = NodePath.join(folder, "clone");
  NodeFS.mkdirSync(clone, { recursive: true });
  if (options.mark !== false)
    NodeFS.writeFileSync(
      NodePath.join(folder, CLONE_STAGING_MARK),
      // Owned by a server process that has ended.
      cloneStagingMarkText({ pid: endedPid(), started: 1, token: "0".repeat(32) }),
    );
  if (options.repository !== false) git(root, "init", "-q", clone);
  NodeFS.writeFileSync(NodePath.join(clone, "half.ts"), "export const half = 1;\n");
  return folder;
}

export function cleanUp(): void {
  gitHooks.before = null;
  gitHooks.after = null;
  for (const folder of temporary.splice(0)) NodeFS.rmSync(folder, { recursive: true, force: true });
}

export function twoMachines() {
  const base = NodeFS.realpathSync(
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "swc-sync-extras-")),
  );
  temporary.push(base);
  const remote = NodePath.join(base, "remote.git");
  git(base, "init", "-q", "--bare", "-b", "main", remote);
  const a = NodePath.join(base, "a");
  git(base, "clone", "-q", remote, a);
  git(a, "checkout", "-q", "-b", "main");
  commit(a, ".gitignore", "ignored.log\n");
  commit(a, "app.ts", "export const a = 1;\n");
  git(a, "push", "-q", "-u", "origin", "main");
  const b = NodePath.join(base, "b");
  git(base, "clone", "-q", remote, b);
  return { base, remote, a, b };
}

/** Everything an extra must leave alone on either machine. */
export const snapshot = (cwd: string) => ({
  workingTree: git(cwd, "status", "--porcelain=v1", "--untracked-files=all", "--ignored"),
  index: git(cwd, "ls-files", "-s"),
  head: git(cwd, "rev-parse", "HEAD"),
  branch: git(cwd, "rev-parse", "--abbrev-ref", "HEAD"),
  stashes: git(cwd, "stash", "list"),
});
export const branches = (cwd: string) =>
  git(cwd, "for-each-ref", "--format=%(refname:short) %(objectname)", "refs/heads").split("\n");
export const allRefs = (cwd: string) =>
  git(cwd, "for-each-ref", "--format=%(refname) %(objectname)");
export const filesOf = (cwd: string, ref: string) =>
  git(cwd, "ls-tree", "-r", "--name-only", ref).split("\n").filter(Boolean);
