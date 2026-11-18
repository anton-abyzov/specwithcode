// @effect-diagnostics nodeBuiltinImport:off - disposable real Git fixtures only.
/** Real temporary repositories for the Sync extras tests: a bare remote and the project on two machines. */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

/** One Git command the code under test ran: where, its arguments, and whether on a private index. */
export interface RecordedGit {
  readonly cwd: string;
  readonly args: ReadonlyArray<string>;
  readonly privateIndex: boolean;
}
const recorded: Array<RecordedGit> = [];
export const recordedGit = (): ReadonlyArray<RecordedGit> => recorded;

type GitModule = typeof import("../fleet/folderTransfer/git.ts");
/**
 * `folderTransfer/git.ts` with every command noted before it runs. A test file
 * passes this to `vi.mock` for that module, so all the code under test (the
 * sender, the receiver, the bundle and checkpoint helpers) is recorded.
 */
export function recordingGit(actual: GitModule): GitModule {
  const runGit: GitModule["runGit"] = (cwd, args, options) => {
    recorded.push({
      cwd,
      args: [...args],
      privateIndex: options?.env?.GIT_INDEX_FILE !== undefined,
    });
    return actual.runGit(cwd, args, options);
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
 * branch `swc/from-…` created only where none exists, or moved by
 * `git branch -f`. Nothing else: no reset, rebase, stash, checkout, switch,
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
                  : verb === "bundle"
                    ? ["create", "verify", "list-heads"].includes(rest[0] ?? "")
                    : verb === "update-ref"
                      ? rest[0] === "-d"
                        ? rest.length === 2 && HIDDEN.test(rest[1] ?? "")
                        : HIDDEN.test(rest[0] ?? "") ||
                          // An arrival branch is created only where no ref of that name exists.
                          (ARRIVAL.test(rest[0] ?? "") && rest.length === 3 && rest[2] === "")
                      : verb === "branch"
                        ? rest.length === 5 &&
                          rest.slice(0, 3).join(" ") === "--no-track -f --" &&
                          (rest[3] ?? "").startsWith("swc/from-")
                        : verb === "fetch"
                          ? rest.length === 5 &&
                            rest.slice(0, 3).join(" ") ===
                              "--quiet --no-tags --no-write-fetch-head" &&
                            /^(\/|[A-Za-z]:[\\/])/.test(rest[3] ?? "") &&
                            /:refs\/specwithcode\/extras-incoming\//.test(rest[4] ?? "")
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
export function cleanUp(): void {
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
