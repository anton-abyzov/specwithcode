// @effect-diagnostics nodeBuiltinImport:off - disposable real Git fixtures only.
/** Real temporary repositories for the Sync extras tests: a bare remote and the project on two machines. */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

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
