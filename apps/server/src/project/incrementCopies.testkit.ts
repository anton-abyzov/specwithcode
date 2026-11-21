// @effect-diagnostics nodeBuiltinImport:off globalDate:off
/** Scratch repositories with increments, worktrees and a remote branch, for the board's copy tests. */
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

export const git = (cwd: string, ...args: ReadonlyArray<string>): string =>
  NodeChildProcess.execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      PATH: process.env.PATH ?? "",
      HOME: cwd,
      // A file that is never there: Git for Windows cannot open \\.\nul as a config file.
      GIT_CONFIG_GLOBAL: NodePath.join(cwd, ".no-global-gitconfig"),
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
    },
  }).trim();

export const specOf = (tasks: number, title = "Example") =>
  [
    `# ${title}`,
    "",
    "## Problem",
    "",
    `${title} is not shown.`,
    "",
    "## Tasks",
    "",
    ...Array.from({ length: tasks }, (_, index) => {
      const id = `T-${String(index + 1).padStart(2, "0")}`;
      return `### ${id} Step ${index + 1}\n- AC: AC-01 | Files: a.ts | Test: true\n`;
    }),
  ].join("\n");

export const eventOf = (task: string, kind: string, extra: Record<string, string> = {}) =>
  JSON.stringify({ t: task, e: kind, by: "tool@host", at: "2026-11-14T10:00:00.000Z", ...extra });

/** `count` tasks claimed and done, in order: two events each. */
export const doneLedger = (count: number) =>
  Array.from({ length: count }, (_, index) => {
    const id = `T-${String(index + 1).padStart(2, "0")}`;
    return [eventOf(id, "claim"), eventOf(id, "done", { evidence: "abc1234" })];
  }).flat();

export interface IncrementFiles {
  /** Omitted: no `metadata.json` at all. */
  readonly metadata?: Record<string, unknown> | null;
  /** Tasks in `spec.md`; omitted: no spec. */
  readonly tasks?: number;
  readonly title?: string;
  readonly ledger?: ReadonlyArray<string>;
}

export const folderOf = (root: string, id: string) =>
  NodePath.join(root, ".specweave", "increments", id);

/** Writes one copy of an increment under `root`, replacing what was there. */
export async function writeIncrement(
  root: string,
  id: string,
  files: IncrementFiles,
): Promise<string> {
  const folder = folderOf(root, id);
  await NodeFSP.rm(folder, { recursive: true, force: true });
  await NodeFSP.mkdir(folder, { recursive: true });
  if (files.metadata !== null) {
    await NodeFSP.writeFile(
      NodePath.join(folder, "metadata.json"),
      JSON.stringify({
        id,
        status: "active",
        title: files.title ?? `Title of ${id}`,
        updated: "2026-11-01T00:00:00.000Z",
        ...files.metadata,
      }),
    );
  }
  if (files.tasks !== undefined) {
    await NodeFSP.writeFile(NodePath.join(folder, "spec.md"), specOf(files.tasks, files.title));
  }
  if (files.ledger !== undefined) {
    await NodeFSP.writeFile(NodePath.join(folder, "ledger.jsonl"), `${files.ledger.join("\n")}\n`);
  }
  return folder;
}

/** A repository on `main` with an empty increments folder and one commit. Returns its real path. */
export async function repository(prefix: string, roots: string[]): Promise<string> {
  const made = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), prefix));
  roots.push(made);
  const root = await NodeFSP.realpath(made);
  await NodeFSP.mkdir(NodePath.join(root, ".specweave", "increments"), { recursive: true });
  await NodeFSP.writeFile(NodePath.join(root, ".specweave", "config.json"), "{}");
  git(root, "init", "-q", "-b", "main");
  return root;
}

export function commitAll(root: string, message: string): string {
  git(root, "add", "-A");
  git(root, "commit", "-q", "--allow-empty", "-m", message);
  return git(root, "rev-parse", "HEAD");
}

/** Makes `commit` the remote's default branch as last fetched, with no remote at all. */
export function setRemote(root: string, commit: string, branch = "main"): void {
  git(root, "update-ref", `refs/remotes/origin/${branch}`, commit);
  git(root, "symbolic-ref", "refs/remotes/origin/HEAD", `refs/remotes/origin/${branch}`);
}

/** A linked worktree of `root` at `commit`, beside it. Returns its real path. */
export async function worktree(
  root: string,
  name: string,
  commit: string,
  roots: string[],
): Promise<string> {
  const parent = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "board-worktree-"));
  roots.push(parent);
  const path = NodePath.join(await NodeFSP.realpath(parent), name);
  git(root, "worktree", "add", "-q", "--detach", path, commit);
  return path;
}
