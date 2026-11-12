// @effect-diagnostics nodeBuiltinImport:off globalDate:off -- walks folders with lstat (symlinks are never followed) and asks git, gh and lsof as child processes.
/**
 * Which review and scratch clones may go once their work is merged.
 *
 * With worktrees off, agents clone a registered project's repository to
 * review or verify a pull request, and the clone stays after the pull request
 * merges: 16 had to be removed by hand on one machine (9.7 GiB), one of them
 * inside a project root where the search index walked it.
 *
 * A clone is removed only when every check passes: its origin is a registered
 * project's repository, nothing changed in its `.git` for the grace period,
 * its work is merged (HEAD is in the remote default branch, or its branch has
 * a merged pull request with that same head), the working tree is clean with
 * no untracked files, no branch has a commit that is on no remote, there is
 * no stash, no project, non-archived thread or live agent session is bound to
 * it or to a folder inside it, and no process works in it or has a file open
 * in it. Anything that cannot be read keeps the clone. Source trees without
 * `.git` are only reported.
 *
 * The owners come from the same reading as `specweave-studio scratch prune`
 * and the worktree sweep (git/worktreeOwnership.ts); `pathInside` is theirs.
 *
 * @module mergedCloneSweep
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { type WorktreeBindings, worktreeThreadState } from "./git/worktreeOwnership.ts";
import { errorText, pathInside, type ScratchLivePath } from "./scratchPrune.ts";

export const MERGED_CLONE_GRACE_MS = 2 * 60 * 60_000;
/** A clone sits at most this many folders below a root: `<root>/<dated folder>/<name>/<clone>`. */
export const MERGED_CLONE_MAX_DEPTH = 3;
/** Folders read in one sweep before it stops looking further. */
export const MERGED_CLONE_WALK_LIMIT = 20_000;
const COMMAND_TIMEOUT_MS = 20_000;

export interface CloneCandidate {
  readonly path: string;
  /** The scan root it was found under. */
  readonly root: string;
  readonly kind: "clone" | "source-tree";
}

export interface CloneDecision extends CloneCandidate {
  readonly action: "remove" | "keep" | "report";
  readonly reason: string;
  readonly origin: string | null;
  readonly head: string | null;
  readonly branch: string | null;
}

interface CommandResult {
  readonly code: number | null;
  readonly stdout: string;
}

function run(
  file: string,
  args: ReadonlyArray<string>,
  cwd: string | undefined,
): Promise<CommandResult> {
  return new Promise((resolve) => {
    NodeChildProcess.execFile(
      file,
      [...args],
      {
        cwd,
        encoding: "utf8",
        timeout: COMMAND_TIMEOUT_MS,
        maxBuffer: 16 * 1024 * 1024,
        // Reading a clone must not touch it: `git status` would otherwise rewrite the index.
        env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" },
      },
      (error, stdout) => {
        if (error === null) return resolve({ code: 0, stdout: stdout.trim() });
        const code = (error as { code?: unknown }).code;
        resolve({ code: typeof code === "number" ? code : null, stdout: stdout.trim() });
      },
    );
  });
}

const git = (clone: string, ...args: ReadonlyArray<string>) => run("git", args, clone);

/**
 * One spelling per repository: `https://github.com/Acme/App.git`,
 * `git@github.com:acme/app` and `ssh://git@github.com/acme/app/` are the
 * same. A local path stays a path, without a trailing `.git` or slash.
 */
export function normalizeRemoteUrl(url: string): string {
  const trimmed = url.trim();
  const strip = (value: string) => value.replace(/[\\/]+$/, "").replace(/\.git$/i, "");
  const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/\/)(.+)$/.exec(trimmed);
  const windowsPath = /^[A-Za-z]:[\\/]/.test(trimmed);
  if (scp !== null && !windowsPath)
    return `${scp[1]!.toLowerCase()}/${strip(scp[2]!).toLowerCase()}`;
  const full = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/(?:[^@/]+@)?([^/]+)\/(.+)$/.exec(trimmed);
  if (full !== null && !/^file:/i.test(trimmed))
    return `${full[1]!.toLowerCase().replace(/:\d+$/, "")}/${strip(full[2]!).toLowerCase()}`;
  return strip(trimmed.replace(/^file:\/\//i, ""));
}

/**
 * Clones and bare source trees under `roots`, at most `maxDepth` folders
 * down. Symlinks are not entered, a clone's inside is not searched, and
 * `node_modules` is skipped. `sourceTreeNames` are the `package.json` names
 * of registered repositories: a folder with one and no `.git` is an exported
 * source tree.
 */
export async function findClones(
  roots: ReadonlyArray<string>,
  options: {
    readonly maxDepth?: number;
    readonly walkLimit?: number;
    readonly sourceTreeNames?: ReadonlyArray<string>;
  } = {},
): Promise<ReadonlyArray<CloneCandidate>> {
  const maxDepth = options.maxDepth ?? MERGED_CLONE_MAX_DEPTH;
  let budget = options.walkLimit ?? MERGED_CLONE_WALK_LIMIT;
  const names = new Set(options.sourceTreeNames ?? []);
  const found = new Map<string, CloneCandidate>();
  for (const given of roots) {
    let root: string;
    try {
      root = await NodeFS.promises.realpath(given);
    } catch {
      continue;
    }
    const pending: Array<readonly [string, number]> = [[root, 0]];
    while (pending.length > 0 && budget > 0) {
      const [folder, depth] = pending.shift()!;
      budget -= 1;
      let entries: Array<NodeFS.Dirent>;
      try {
        entries = await NodeFS.promises.readdir(folder, { withFileTypes: true });
      } catch {
        continue;
      }
      if (depth > 0) {
        if (entries.some((entry) => entry.name === ".git")) {
          if (!found.has(folder)) found.set(folder, { path: folder, root, kind: "clone" });
          continue;
        }
        if (names.size > 0 && entries.some((entry) => entry.name === "package.json")) {
          try {
            const manifest = JSON.parse(
              await NodeFS.promises.readFile(NodePath.join(folder, "package.json"), "utf8"),
            ) as { name?: unknown };
            if (typeof manifest.name === "string" && names.has(manifest.name)) {
              if (!found.has(folder))
                found.set(folder, { path: folder, root, kind: "source-tree" });
              continue;
            }
          } catch {
            // Not a manifest this sweep can read: keep looking below.
          }
        }
      }
      if (depth >= maxDepth) continue;
      for (const entry of entries)
        if (entry.isDirectory() && !entry.isSymbolicLink() && entry.name !== "node_modules")
          pending.push([NodePath.join(folder, entry.name), depth + 1]);
    }
  }
  return [...found.values()].toSorted((left, right) => left.path.localeCompare(right.path));
}

export interface RegisteredRepositories {
  /** Normalized remotes: a clone of any of these is a candidate. */
  readonly remotes: ReadonlySet<string>;
  /** The projects' own checkouts, which are never candidates. */
  readonly checkouts: ReadonlyArray<string>;
  /** `package.json` names of those checkouts, to recognize exported source trees. */
  readonly sourceTreeNames: ReadonlyArray<string>;
  /** Where clones are looked for besides the app's scratch and the system temp folders. */
  readonly projectRoots: ReadonlyArray<string>;
}

/**
 * The repositories of registered projects: each project's folder, its extra
 * folders and the repositories in its settings (`workspace_settings_json`).
 */
export async function registeredRepositories(
  projects: ReadonlyArray<{
    readonly workspace_root: string;
    readonly workspace_settings_json: string | null;
  }>,
): Promise<RegisteredRepositories> {
  const remotes = new Set<string>();
  const checkouts = new Set<string>();
  const names = new Set<string>();
  const projectRoots = new Set<string>();
  for (const project of projects) {
    projectRoots.add(project.workspace_root);
    const folders = [project.workspace_root];
    try {
      const environment = (
        JSON.parse(project.workspace_settings_json ?? "{}") as {
          environment?: {
            additionalFolders?: ReadonlyArray<unknown>;
            repositories?: ReadonlyArray<{ url?: unknown; localPath?: unknown }>;
          };
        }
      ).environment;
      for (const folder of environment?.additionalFolders ?? [])
        if (typeof folder === "string") folders.push(folder);
      for (const repository of environment?.repositories ?? []) {
        if (typeof repository.url === "string" && repository.url.trim().length > 0)
          remotes.add(normalizeRemoteUrl(repository.url));
        if (typeof repository.localPath === "string") folders.push(repository.localPath);
      }
    } catch {
      // Unreadable settings register only the project's own folder.
    }
    for (const folder of folders) {
      if (!NodePath.isAbsolute(folder)) continue;
      const origin = await git(folder, "remote", "get-url", "origin");
      if (origin.code !== 0 || origin.stdout.length === 0) continue;
      remotes.add(normalizeRemoteUrl(origin.stdout));
      checkouts.add(folder);
      try {
        const manifest = JSON.parse(
          await NodeFS.promises.readFile(NodePath.join(folder, "package.json"), "utf8"),
        ) as { name?: unknown };
        if (typeof manifest.name === "string" && manifest.name.length > 0) names.add(manifest.name);
      } catch {
        // No manifest: its exported trees cannot be recognized, so none are reported.
      }
    }
  }
  return {
    remotes,
    checkouts: [...checkouts],
    sourceTreeNames: [...names],
    projectRoots: [...projectRoots],
  };
}

/** A merged pull request whose head is `head`: its number, null when there is none or it cannot be told. */
export type MergedPullRequestLookup = (input: {
  readonly clone: string;
  readonly branch: string | null;
  readonly head: string;
}) => Promise<number | null>;

/** Asks `gh` in the clone. Any failure (no gh, no sign-in, no network) is "not merged". */
export const ghMergedPullRequest: MergedPullRequestLookup = async ({ clone, branch, head }) => {
  const result = await run(
    "gh",
    [
      "pr",
      "list",
      "--state",
      "merged",
      ...(branch === null ? ["--search", head] : ["--head", branch]),
      "--json",
      "number,mergeCommit,headRefOid",
      "--limit",
      "20",
    ],
    clone,
  );
  if (result.code !== 0) return null;
  try {
    const rows = JSON.parse(result.stdout) as ReadonlyArray<{
      number?: unknown;
      headRefOid?: unknown;
    }>;
    // The same branch name merged earlier with other commits does not count.
    const match = rows.find((row) => row.headRefOid === head);
    return typeof match?.number === "number" ? match.number : null;
  } catch {
    return null;
  }
};

/** Whether any process has a file open directly in `folder`; null when lsof could not say. */
export async function hasOpenFilesIn(folder: string): Promise<boolean | null> {
  const result = await run("lsof", ["-n", "-P", "-w", "-Fn", "+d", folder], undefined);
  // lsof exits 1 with no output when nothing is open there.
  if (result.code === 1 && result.stdout.length === 0) return false;
  if (result.code !== 0 && result.stdout.length === 0) return null;
  return result.stdout.split("\n").some((line) => line.startsWith("n"));
}

export interface CloneSweepContext {
  /** Normalized (`normalizeRemoteUrl`) remotes of registered projects' repositories. */
  readonly registeredRemotes: ReadonlySet<string>;
  /** Projects, non-archived threads and live agent sessions, as `scratch prune` reads them. */
  readonly livePaths: ReadonlyArray<ScratchLivePath>;
  /** Working folders of running processes; null when they cannot be listed, which keeps every clone. */
  readonly processCwds: ReadonlyArray<string> | null;
  readonly now: number;
  readonly graceMs?: number;
  readonly foldCase: boolean;
  /** Absent: only the ancestry rule decides "merged". */
  readonly mergedPullRequest?: MergedPullRequestLookup | undefined;
  readonly openFilesIn?: (folder: string) => Promise<boolean | null>;
}

/** The newest change to the files git rewrites when someone works in a clone; null when unknown. */
function gitActivityMs(clone: string): number | null {
  let newest: number | null = null;
  for (const name of ["HEAD", "index", "FETCH_HEAD", "ORIG_HEAD", NodePath.join("logs", "HEAD")]) {
    try {
      const stat = NodeFS.statSync(NodePath.join(clone, ".git", name));
      newest = Math.max(newest ?? 0, stat.mtimeMs);
    } catch (cause) {
      // HEAD is in every clone; the others come and go.
      if (name === "HEAD" || (cause as NodeJS.ErrnoException).code !== "ENOENT") return null;
    }
  }
  return newest;
}

const minutes = (ms: number) => `${Math.max(0, Math.round(ms / 60_000))} min`;

/** Decides one candidate. Never changes anything on disk. */
export async function decideClone(
  candidate: CloneCandidate,
  context: CloneSweepContext,
): Promise<CloneDecision> {
  const clone = candidate.path;
  const facts = {
    origin: null as string | null,
    head: null as string | null,
    branch: null as string | null,
  };
  const decision = (action: CloneDecision["action"], reason: string): CloneDecision => ({
    ...candidate,
    action,
    reason,
    ...facts,
  });
  const keep = (reason: string) => decision("keep", reason);
  if (candidate.kind === "source-tree")
    return decision("report", "source tree without .git: reported only, never removed");

  let dotGit: NodeFS.Stats;
  try {
    if (NodeFS.lstatSync(clone).isSymbolicLink()) return keep("a symlink, not a folder");
    dotGit = NodeFS.lstatSync(NodePath.join(clone, ".git"));
  } catch (cause) {
    return keep(`cannot read it: ${errorText(cause)}`);
  }
  if (!dotGit.isDirectory()) return keep("a linked worktree or submodule (.git is not a folder)");

  const origin = await git(clone, "remote", "get-url", "origin");
  if (origin.code !== 0 || origin.stdout.length === 0) return keep("no origin remote");
  facts.origin = origin.stdout;
  if (!context.registeredRemotes.has(normalizeRemoteUrl(origin.stdout)))
    return keep("origin is not a registered project's repository");

  const owner = context.livePaths.find((live) =>
    live.paths.some((path) => pathInside(clone, path, context.foldCase)),
  );
  if (owner !== undefined) return keep(`in use by ${owner.owner}`);

  const graceMs = context.graceMs ?? MERGED_CLONE_GRACE_MS;
  const activity = gitActivityMs(clone);
  if (activity === null) return keep("age unknown: cannot read .git/HEAD");
  if (!(context.now - activity >= graceMs))
    return keep(
      `changed ${minutes(context.now - activity)} ago, inside the ${minutes(graceMs)} grace period`,
    );

  const head = await git(clone, "rev-parse", "--verify", "HEAD^{commit}");
  if (head.code !== 0) return keep("no commit checked out");
  facts.head = head.stdout;
  const branch = await git(clone, "symbolic-ref", "--quiet", "--short", "HEAD");
  facts.branch = branch.code === 0 && branch.stdout.length > 0 ? branch.stdout : null;

  const status = await git(clone, "status", "--porcelain");
  if (status.code !== 0) return keep("git status failed");
  if (status.stdout.length > 0)
    return keep(`uncommitted or untracked files (${status.stdout.split("\n").length})`);

  const unpushed = await git(
    clone,
    "log",
    "--branches",
    "--not",
    "--remotes",
    "-n",
    "1",
    "--format=%H",
  );
  const detached = await git(clone, "rev-list", "-n", "1", "HEAD", "--not", "--remotes");
  if (unpushed.code !== 0 || detached.code !== 0) return keep("cannot list local commits");
  if (unpushed.stdout.length > 0 || detached.stdout.length > 0)
    return keep("has commits that are on no remote");

  const stash = await git(clone, "stash", "list");
  if (stash.code !== 0) return keep("cannot list stashes");
  if (stash.stdout.length > 0) return keep("has a stash");

  // A linked worktree keeps its HEAD, index and commits inside this clone's .git.
  const worktrees = await git(clone, "worktree", "list", "--porcelain");
  if (worktrees.code !== 0) return keep("cannot list linked worktrees");
  if (worktrees.stdout.split("\n").filter((line) => line.startsWith("worktree ")).length > 1)
    return keep("has linked worktrees");

  if (context.processCwds === null) return keep("cannot list running processes");
  const cwd = context.processCwds.find((path) => pathInside(clone, path, context.foldCase));
  if (cwd !== undefined) return keep(`a process is working in ${cwd}`);
  const open = await (context.openFilesIn ?? hasOpenFilesIn)(clone);
  if (open !== false)
    return keep(open === null ? "cannot check for open files" : "a process has a file open in it");

  const symbolic = await git(
    clone,
    "symbolic-ref",
    "--quiet",
    "--short",
    "refs/remotes/origin/HEAD",
  );
  let base: string | null =
    symbolic.code === 0 && symbolic.stdout.length > 0 ? symbolic.stdout : null;
  for (const name of ["origin/main", "origin/master"]) {
    if (base !== null) break;
    if ((await git(clone, "rev-parse", "--verify", "--quiet", `${name}^{commit}`)).code === 0)
      base = name;
  }
  if (base !== null && (await git(clone, "merge-base", "--is-ancestor", "HEAD", base)).code === 0)
    return decision("remove", `merged: HEAD is in ${base}; clean, nothing unpushed, unused`);
  const number =
    (await context.mergedPullRequest?.({ clone, branch: facts.branch, head: head.stdout })) ?? null;
  if (number !== null)
    return decision("remove", `merged: pull request #${number}; clean, nothing unpushed, unused`);
  return keep(
    `not merged: HEAD is not in ${base ?? "the remote default branch"} and ${
      context.mergedPullRequest === undefined
        ? "pull requests were not checked"
        : "no merged pull request has this head"
    }`,
  );
}

/** Every candidate under `roots`, decided. Nothing is removed. */
export async function planCloneSweep(
  roots: ReadonlyArray<string>,
  context: CloneSweepContext,
  options: Parameters<typeof findClones>[1] = {},
): Promise<ReadonlyArray<CloneDecision>> {
  const decisions: Array<CloneDecision> = [];
  for (const candidate of await findClones(roots, options))
    decisions.push(await decideClone(candidate, context));
  return decisions;
}

export interface CloneRemoval {
  readonly result: "removed" | "skipped" | "failed";
  readonly detail?: string;
  /** The dated parent folder, when the clone was its only entry and it went too. */
  readonly removedParent?: string;
}

/**
 * Removes one clone decided removable, after deciding it again with
 * `context` (read just before). Only the clone's own folder goes, and its
 * dated parent if that is left empty; symlinks inside are unlinked, never
 * followed, and a clone that is not really inside its root is left.
 */
export async function removeClone(
  decision: CloneDecision,
  context: CloneSweepContext,
): Promise<CloneRemoval> {
  if (decision.action !== "remove" || decision.kind !== "clone")
    return { result: "skipped", detail: "not removable" };
  const again = await decideClone(decision, context);
  if (again.action !== "remove")
    return { result: "skipped", detail: `changed since the check: ${again.reason}` };
  try {
    const root = NodeFS.realpathSync(decision.root);
    const real = NodeFS.realpathSync(decision.path);
    if (real !== decision.path || real === root || !pathInside(root, real, false))
      return { result: "skipped", detail: "not a real folder inside its root" };
    NodeFS.rmSync(real, { recursive: true });
    const parent = NodePath.dirname(real);
    if (
      parent !== root &&
      pathInside(root, parent, false) &&
      /^\d{4}-\d{2}-\d{2}/.test(NodePath.basename(parent)) &&
      NodeFS.readdirSync(parent).length === 0
    ) {
      NodeFS.rmdirSync(parent);
      return { result: "removed", removedParent: parent };
    }
    return { result: "removed" };
  } catch (cause) {
    return { result: "failed", detail: errorText(cause) };
  }
}

/** SQL for `registeredRepositories`; the CLI runs it over its read-only live connection. */
export const CLONE_SWEEP_PROJECTS_SQL = `
  SELECT workspace_root, workspace_settings_json FROM projection_projects WHERE deleted_at IS NULL
`;

/**
 * Who keeps a clone: every project, every thread that is not archived, every
 * live agent session, and the projects' own checkouts.
 */
export function cloneSweepLivePaths(
  bindings: WorktreeBindings,
  checkouts: ReadonlyArray<string>,
): ReadonlyArray<ScratchLivePath> {
  return [
    ...bindings.projects.map((owner) => ({
      paths: owner.paths,
      owner: `project ${owner.workspaceRoot}`,
    })),
    ...bindings.threads
      .filter((owner) => !owner.archived)
      .map((owner) => ({
        paths: owner.paths,
        owner: `thread ${owner.threadId} (${worktreeThreadState(owner)})`,
      })),
    ...bindings.sessions.map((owner) => ({
      paths: owner.paths,
      owner: `agent session${owner.threadId === null ? "" : ` of thread ${owner.threadId}`}`,
    })),
    ...checkouts.map((checkout) => ({ paths: [checkout], owner: `project checkout ${checkout}` })),
  ];
}

/** Where clones are looked for: the app's scratch folder, the system temp folders, and each project's `scratch` and `.artifacts`. */
export function cloneSweepRoots(
  home: string,
  projectRoots: ReadonlyArray<string>,
): ReadonlyArray<string> {
  return [
    NodePath.join(home, "scratch"),
    NodeOS.tmpdir(),
    ...(NodePath.sep === "/" ? ["/tmp"] : []),
    ...projectRoots.flatMap((root) => [
      NodePath.join(root, "scratch"),
      NodePath.join(root, ".artifacts"),
    ]),
  ];
}
