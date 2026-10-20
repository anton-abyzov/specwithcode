// @effect-diagnostics nodeBuiltinImport:off - Apply moves staged files, backs up what it replaces and journals each step.
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import { exists, JsonLog, lstatOrNull } from "./durable.ts";
import { runGit } from "./git.ts";
import { hashFile, type RepositoryInfo } from "./manifest.ts";
import { isSafeRelativePath } from "./paths.ts";
import { stagedPath } from "./pullWorker.ts";
import type { FileAction, GitStep, Plan } from "./reconcile.ts";

/**
 * One journal line per step, written before the step changes anything (intent)
 * and, for file writes, after it (done). Undo and an interrupted Apply both read
 * this log: what it does not mention, Apply never touched.
 */
export type JournalEntry =
  | { readonly t: "root-created"; readonly path: string }
  | { readonly t: "mkdir"; readonly path: string }
  | { readonly t: "backup"; readonly path: string; readonly backup: string }
  | {
      readonly t: "write";
      readonly path: string;
      readonly sha256: string | null;
      readonly linkTarget: string | null;
    }
  | { readonly t: "write-done"; readonly path: string }
  /** Apply itself rewrote a copied file afterwards (worktree repair); Undo compares against this hash. */
  | { readonly t: "rewritten"; readonly path: string; readonly sha256: string }
  | {
      readonly t: "ref";
      readonly repo: string;
      readonly ref: string;
      readonly old: string | null;
      readonly new: string | null;
    }
  | {
      readonly t: "head";
      readonly repo: string;
      readonly old: string | null;
      readonly new: string;
      readonly branch: string | null;
    }
  | { readonly t: "stash"; readonly repo: string; readonly sha: string }
  | { readonly t: "checkout"; readonly repo: string; readonly from: string; readonly to: string }
  | { readonly t: "worktree-added"; readonly main: string; readonly path: string }
  | { readonly t: "cloned"; readonly path: string }
  | { readonly t: "done" };

export type ApplyRefusal =
  | "link-in-path"
  | "not-a-folder"
  | "unsafe-path"
  | "staged-missing"
  | "git-failed"
  | "changed-since-preview";

export class ApplyRefusedError extends Error {
  readonly reason: ApplyRefusal;
  readonly path: string;
  constructor(reason: ApplyRefusal, path: string, detail?: string) {
    super(detail ?? `${reason}: ${path}`);
    this.reason = reason;
    this.path = path;
  }
}

export interface RepositoryCheck {
  readonly repo: string;
  readonly ok: boolean;
  readonly problems: ReadonlyArray<string>;
}

export interface ApplyResult {
  readonly checks: ReadonlyArray<RepositoryCheck>;
  readonly warnings: ReadonlyArray<string>;
}

export interface ApplyInput {
  readonly operationId: string;
  readonly targetRoot: string;
  readonly stagingRoot: string;
  readonly backupRoot: string;
  readonly journalFile: string;
  readonly plan: Plan;
  readonly sourceRepositories: ReadonlyArray<RepositoryInfo>;
  /** Paths deliberately left behind (secrets, rebuildable, unstable), ignored by the status check. */
  readonly leftBehind: ReadonlySet<string>;
  readonly unstable?: ReadonlySet<string>;
}

const absoluteIn = (root: string, relative: string) => {
  if (relative !== "." && !isSafeRelativePath(relative))
    throw new ApplyRefusedError("unsafe-path", relative);
  return relative === "." ? root : NodePath.join(root, ...relative.split("/"));
};

/** Moves `from` to `to`, copying across volumes; links are moved as links. */
export async function moveEntry(from: string, to: string): Promise<void> {
  await NodeFSP.mkdir(NodePath.dirname(to), { recursive: true, mode: 0o700 });
  try {
    await NodeFSP.rename(from, to);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "EXDEV") throw cause;
    await NodeFSP.cp(from, to, {
      recursive: true,
      preserveTimestamps: true,
      verbatimSymlinks: true,
      errorOnExist: true,
      force: false,
    });
    await NodeFSP.rm(from, { recursive: true, force: true });
  }
}

/**
 * Creates the folders above `relative` inside the target, refusing any step that
 * is a link or a file: Apply never writes through a link, so nothing can land
 * outside the target folder.
 */
async function ensureFolders(
  root: string,
  relative: string,
  journal: JsonLog<JournalEntry>,
  recorded: Set<string>,
) {
  const parts = relative.split("/").slice(0, -1);
  let current = root;
  let prefix = "";
  for (const part of parts) {
    current = NodePath.join(current, part);
    prefix = prefix ? `${prefix}/${part}` : part;
    const stat = await lstatOrNull(current);
    if (stat?.isSymbolicLink()) throw new ApplyRefusedError("link-in-path", prefix);
    if (stat && !stat.isDirectory()) throw new ApplyRefusedError("not-a-folder", prefix);
    if (!stat) {
      if (!recorded.has(prefix)) await journal.append({ t: "mkdir", path: prefix }, true);
      recorded.add(prefix);
      await NodeFSP.mkdir(current);
    }
  }
}

const backupLocation = (backupRoot: string, relative: string) =>
  NodePath.join(backupRoot, "files", ...relative.split("/"));

async function currentRef(cwd: string, ref: string): Promise<string | null> {
  const result = await runGit(cwd, ["rev-parse", "--verify", "-q", ref], { allowFailure: true });
  return result.code === 0 ? result.stdout.trim() : null;
}

async function isAncestor(cwd: string, older: string, newer: string) {
  return (
    (await runGit(cwd, ["merge-base", "--is-ancestor", older, newer], { allowFailure: true }))
      .code === 0
  );
}

async function trackedChanges(cwd: string) {
  return (
    (await runGit(cwd, ["status", "--porcelain=v1", "--untracked-files=no"])).stdout.trim().length >
    0
  );
}

/**
 * Applies an approved plan. Safe to run again after a crash: steps the journal
 * shows as finished are skipped, and a half-finished write is completed or
 * redone from staging.
 */
export async function applyPlan(input: ApplyInput): Promise<ApplyResult> {
  const journal = new JsonLog<JournalEntry>(input.journalFile);
  const previous = await journal.read();
  const written = new Set(
    previous
      .filter((entry) => entry.t === "write-done")
      .map((entry) => (entry as { path: string }).path),
  );
  const backedUp = new Set(
    previous
      .filter((entry) => entry.t === "backup")
      .map((entry) => (entry as { path: string }).path),
  );
  const intents = new Map(
    previous
      .filter((entry) => entry.t === "write")
      .map((entry) => [
        (entry as { path: string }).path,
        entry as Extract<JournalEntry, { t: "write" }>,
      ]),
  );
  const created = new Set(
    previous
      .filter((entry) => entry.t === "mkdir")
      .map((entry) => (entry as { path: string }).path),
  );
  const warnings: Array<string> = [];
  const root = input.targetRoot;
  try {
    if (!(await exists(root))) {
      if (!previous.some((entry) => entry.t === "root-created"))
        await journal.append({ t: "root-created", path: root }, true);
      await NodeFSP.mkdir(root, { recursive: true });
    }
    const steps = input.plan.git;
    const byRepo = new Map(input.sourceRepositories.map((repo) => [repo.path, repo]));

    // Before files: replaced folders go to the backup; clones and added worktrees create their folders.
    for (const step of steps) {
      if (step.kind === "replace") {
        const location = absoluteIn(root, step.repo);
        if (!backedUp.has(step.repo) && (await lstatOrNull(location))) {
          await journal.append(
            { t: "backup", path: step.repo, backup: backupLocation(input.backupRoot, step.repo) },
            true,
          );
          await moveEntry(location, backupLocation(input.backupRoot, step.repo));
          backedUp.add(step.repo);
        }
      }
      if (
        step.kind === "clone" &&
        !previous.some((entry) => entry.t === "cloned" && entry.path === step.repo)
      ) {
        await ensureFolders(root, `${step.repo}/x`, journal, created);
        await journal.append({ t: "cloned", path: step.repo }, true);
        await cloneRepository(root, step, warnings);
      }
    }
    for (const step of steps)
      if (step.kind === "existing" && step.fetch) await fetchStaged(input, step);
    for (const step of steps)
      if (
        step.kind === "add-worktree" &&
        !previous.some((entry) => entry.t === "worktree-added" && entry.path === step.repo)
      )
        await addWorktree(input, step, journal, warnings);
    // Branches move before work files: the source's uncommitted changes go on top of its commit.
    for (const step of steps)
      if (step.kind === "existing") await reconcileRefs(input, step, journal, previous);

    // Files: folders, then files, then links, so nothing is written through a link Apply created.
    const order: Record<FileAction["kind"], number> = {
      mkdir: 0,
      write: 1,
      "keep-both": 1,
      remove: 1,
      link: 2,
      stage: 3,
    };
    const actions = [...input.plan.actions]
      .filter((action) => action.kind !== "stage" && !input.unstable?.has(action.path))
      .sort((a, b) => order[a.kind] - order[b.kind] || a.writePath.localeCompare(b.writePath));
    for (const action of actions) {
      const target = action.writePath;
      if (written.has(target)) continue;
      const location = absoluteIn(root, target);
      await ensureFolders(root, target, journal, created);
      const present = await lstatOrNull(location);
      // Git checkouts during Apply create plain files; a link or folder the preview never saw is someone else's change.
      if (
        present &&
        !action.replaces &&
        !backedUp.has(target) &&
        !intents.has(target) &&
        (present.isSymbolicLink() || (action.kind === "mkdir") !== present.isDirectory())
      )
        throw new ApplyRefusedError(
          "changed-since-preview",
          target,
          `${target} changed after the preview; review the copy again.`,
        );
      if (action.kind === "mkdir") {
        if (present?.isDirectory()) continue;
        if (present && !backedUp.has(target)) {
          await journal.append(
            { t: "backup", path: target, backup: backupLocation(input.backupRoot, target) },
            true,
          );
          await moveEntry(location, backupLocation(input.backupRoot, target));
        }
        if (!created.has(target)) await journal.append({ t: "mkdir", path: target }, true);
        created.add(target);
        await NodeFSP.mkdir(location, { mode: (action.entry?.mode ?? 0o755) & 0o777 });
        continue;
      }
      const entry = action.entry;
      const expectedSha = entry?.type === "file" ? (entry.sha256 ?? null) : null;
      const linkTarget = entry?.type === "symlink" ? (entry.target ?? null) : null;
      // A replayed write whose rename already happened only needs its done mark.
      if (intents.has(target) && present) {
        if (
          linkTarget !== null &&
          present.isSymbolicLink() &&
          (await NodeFSP.readlink(location)) === linkTarget
        ) {
          await journal.append({ t: "write-done", path: target }, true);
          continue;
        }
        if (
          expectedSha &&
          present.isFile() &&
          present.size === entry?.size &&
          (await hashFile(location, false)).sha256 === expectedSha
        ) {
          await journal.append({ t: "write-done", path: target }, true);
          continue;
        }
      }
      if (present && !backedUp.has(target)) {
        await journal.append(
          { t: "backup", path: target, backup: backupLocation(input.backupRoot, target) },
          true,
        );
        await moveEntry(location, backupLocation(input.backupRoot, target));
        backedUp.add(target);
      } else if (present) {
        // The original is already in the backup; this is a partial earlier write.
        await NodeFSP.rm(location, { recursive: true, force: true });
      }
      if (action.kind === "remove") {
        await journal.append({ t: "write-done", path: target }, true);
        continue;
      }
      if (!intents.has(target))
        await journal.append({ t: "write", path: target, sha256: expectedSha, linkTarget }, true);
      if (linkTarget !== null) {
        await NodeFSP.symlink(linkTarget, location);
      } else {
        const staged = stagedPath(input.stagingRoot, action.path);
        if (!(await exists(staged))) throw new ApplyRefusedError("staged-missing", action.path);
        await moveEntry(staged, location);
      }
      await journal.append({ t: "write-done", path: target }, true);
    }

    // After files: worktree repair for copied repositories, then verification.
    for (const step of steps) {
      if (step.kind !== "copy") continue;
      const info = byRepo.get(step.repo);
      if (info?.kind === "linked" && info.mainRepository !== null)
        await repairWorktree(root, info, journal, warnings);
    }
    const checks: Array<RepositoryCheck> = [];
    for (const step of steps)
      if (step.kind === "copy" || step.kind === "replace")
        checks.push(await verifyRepository(input, step, byRepo.get(step.repo)));
    await journal.append({ t: "done" }, true);
    return { checks, warnings };
  } finally {
    await journal.close();
  }
}

async function cloneRepository(root: string, step: GitStep, warnings: Array<string>) {
  const location = absoluteIn(root, step.repo);
  if (!step.origin)
    throw new ApplyRefusedError("git-failed", step.repo, "No origin to clone from.");
  const parent = NodePath.dirname(location);
  const result = await runGit(
    parent,
    ["clone", "--quiet", "--no-checkout", step.origin, location],
    {
      allowFailure: true,
      timeoutMs: 60 * 60_000,
    },
  );
  if (result.code !== 0)
    throw new ApplyRefusedError(
      "git-failed",
      step.repo,
      "Cloning from origin failed. Check this machine's access to the repository.",
    );
  const head = step.sourceHead;
  const has = head
    ? (await runGit(location, ["cat-file", "-e", `${head}^{commit}`], { allowFailure: true }))
        .code === 0
    : false;
  if (head && has) {
    if (step.sourceBranch)
      await runGit(location, ["checkout", "-q", "-B", step.sourceBranch, head]);
    else await runGit(location, ["checkout", "-q", "--detach", head]);
  } else {
    await runGit(location, ["checkout", "-q"], { allowFailure: true });
    warnings.push(
      `${step.repo}: the source commit is not on origin; cloned its default branch instead.`,
    );
  }
}

/** Fetches every source branch (and the stash tip) into a private namespace for this operation. */
async function fetchStaged(input: ApplyInput, step: GitStep) {
  const cwd = absoluteIn(input.targetRoot, step.mainRepository ?? step.repo);
  const repoInfo = input.sourceRepositories.find(
    (repo) => repo.path === (step.mainRepository ?? step.repo),
  );
  if (repoInfo?.kind === "linked") return;
  const stagedGit = NodePath.join(
    absoluteIn(input.stagingRoot, step.mainRepository ?? step.repo),
    ".git",
  );
  if (!(await exists(stagedGit))) return;
  const namespace = `refs/swc-incoming/${input.operationId}`;
  const specs = [`+refs/heads/*:${namespace}/heads/*`];
  if (
    (await runGit(stagedGit, ["rev-parse", "--verify", "-q", "refs/stash"], { allowFailure: true }))
      .code === 0
  )
    specs.push(`+refs/stash:${namespace}/stash`);
  const result = await runGit(
    cwd,
    ["fetch", "--quiet", "--no-tags", "--no-write-fetch-head", stagedGit, ...specs],
    {
      allowFailure: true,
      timeoutMs: 60 * 60_000,
    },
  );
  if (result.code !== 0)
    throw new ApplyRefusedError("git-failed", step.repo, "Fetching the copied history failed.");
}

async function setRef(
  cwd: string,
  repo: string,
  ref: string,
  next: string | null,
  journal: JsonLog<JournalEntry>,
  previous: ReadonlyArray<JournalEntry>,
) {
  const old = await currentRef(cwd, ref);
  if (old === next) return;
  const earlier = previous.find(
    (entry) => entry.t === "ref" && entry.repo === repo && entry.ref === ref,
  ) as Extract<JournalEntry, { t: "ref" }> | undefined;
  await journal.append({ t: "ref", repo, ref, old: earlier ? earlier.old : old, new: next }, true);
  if (next === null) await runGit(cwd, ["update-ref", "-d", ref]);
  else await runGit(cwd, ["update-ref", ref, next, ...(old ? [old] : [])]);
}

async function reconcileRefs(
  input: ApplyInput,
  step: GitStep,
  journal: JsonLog<JournalEntry>,
  previous: ReadonlyArray<JournalEntry>,
) {
  const cwd = absoluteIn(input.targetRoot, step.repo);
  const main = absoluteIn(input.targetRoot, step.mainRepository ?? step.repo);
  const namespace = `refs/swc-incoming/${input.operationId}`;
  const checkedOut =
    (
      await runGit(cwd, ["symbolic-ref", "-q", "--short", "HEAD"], { allowFailure: true })
    ).stdout.trim() || null;
  if (step.importBranches) {
    for (const [branch, sha] of Object.entries(step.sourceBranches)) {
      const incoming = await currentRef(main, `${namespace}/heads/${branch}`);
      if (!incoming || incoming !== sha) continue;
      const mine = await currentRef(main, `refs/heads/${branch}`);
      if (mine === sha) continue;
      // The checked-out branch moves only through the HEAD decision below.
      const inUse = branch === checkedOut || (await branchCheckedOutElsewhere(main, branch));
      if (!mine)
        await setRef(
          main,
          step.mainRepository ?? step.repo,
          `refs/heads/${branch}`,
          sha,
          journal,
          previous,
        );
      else if (!inUse && (await isAncestor(main, mine, sha)))
        await setRef(
          main,
          step.mainRepository ?? step.repo,
          `refs/heads/${branch}`,
          sha,
          journal,
          previous,
        );
      else
        await setRef(
          main,
          step.mainRepository ?? step.repo,
          `refs/heads/${step.importPrefix}/${branch}`,
          sha,
          journal,
          previous,
        );
    }
    const stash = await currentRef(main, `${namespace}/stash`);
    if (stash)
      await setRef(
        main,
        step.mainRepository ?? step.repo,
        `refs/heads/${step.importPrefix}/stash`,
        stash,
        journal,
        previous,
      );
  }
  if (step.moveHead !== "none" && step.sourceHead) {
    const head = await currentRef(cwd, "HEAD");
    const resumed = previous.some((entry) => entry.t === "head" && entry.repo === step.repo);
    if (head !== step.sourceHead) {
      if (step.stashDestination && !resumed && (await trackedChanges(cwd))) {
        const message = `swc-handoff-${input.operationId}`;
        await runGit(cwd, ["stash", "push", "--include-untracked", "-q", "-m", message]);
        const sha = await currentRef(cwd, "refs/stash");
        if (sha) await journal.append({ t: "stash", repo: step.repo, sha }, true);
      }
      if (!resumed)
        await journal.append(
          { t: "head", repo: step.repo, old: head, new: step.sourceHead, branch: checkedOut },
          true,
        );
      if (step.moveHead === "take-theirs" && head) {
        await setRef(
          main,
          step.mainRepository ?? step.repo,
          `refs/swc-backup/${input.operationId}/${checkedOut ?? "HEAD"}`,
          head,
          journal,
          previous,
        );
      }
      const command =
        step.moveHead === "fast-forward"
          ? ["merge", "--ff-only", "-q", step.sourceHead]
          : ["reset", "--keep", "-q", step.sourceHead];
      const result = await runGit(cwd, command, { allowFailure: true });
      if (result.code !== 0)
        throw new ApplyRefusedError(
          "git-failed",
          step.repo,
          "Moving the branch to the source commit was refused by Git; local changes would be overwritten.",
        );
    }
  }
  for (const ref of (await runGit(main, ["for-each-ref", "--format=%(refname)", namespace])).stdout
    .split("\n")
    .filter(Boolean))
    await runGit(main, ["update-ref", "-d", ref]);
}

async function branchCheckedOutElsewhere(main: string, branch: string) {
  const listing = (await runGit(main, ["worktree", "list", "--porcelain"])).stdout;
  return listing.split("\n").some((line) => line === `branch refs/heads/${branch}`);
}

async function addWorktree(
  input: ApplyInput,
  step: GitStep,
  journal: JsonLog<JournalEntry>,
  warnings: Array<string>,
) {
  if (!step.mainRepository || !step.sourceHead) return;
  const main = absoluteIn(input.targetRoot, step.mainRepository);
  const location = absoluteIn(input.targetRoot, step.repo);
  const mainStep = input.plan.git.find((item) => item.repo === step.mainRepository);
  if (!mainStep?.fetch) {
    const stagedGit = NodePath.join(absoluteIn(input.stagingRoot, step.mainRepository), ".git");
    if (await exists(stagedGit))
      await runGit(
        main,
        ["fetch", "--quiet", "--no-tags", "--no-write-fetch-head", stagedGit, step.sourceHead],
        { allowFailure: true },
      );
  }
  await journal.append({ t: "worktree-added", main: step.mainRepository, path: step.repo }, true);
  const branch = step.sourceBranch;
  const mine = branch ? await currentRef(main, `refs/heads/${branch}`) : null;
  const args =
    branch && !mine
      ? ["worktree", "add", "-q", "-b", branch, location, step.sourceHead]
      : branch && mine === step.sourceHead && !(await branchCheckedOutElsewhere(main, branch))
        ? ["worktree", "add", "-q", location, branch]
        : ["worktree", "add", "-q", "--detach", location, step.sourceHead];
  if (args.includes("--detach") && branch)
    warnings.push(
      `${step.repo}: branch ${branch} differs here, so the worktree is at the source commit, detached.`,
    );
  const result = await runGit(main, args, { allowFailure: true });
  if (result.code !== 0)
    throw new ApplyRefusedError("git-failed", step.repo, "Adding the worktree failed.");
}

/**
 * A copied linked worktree's `.git` file names its main repository by absolute
 * path. Point it at the copy, then let Git repair the main repository's record.
 */
async function repairWorktree(
  root: string,
  info: RepositoryInfo,
  journal: JsonLog<JournalEntry>,
  warnings: Array<string>,
) {
  const location = absoluteIn(root, info.path);
  const gitFile = NodePath.join(location, ".git");
  const text = await NodeFSP.readFile(gitFile, "utf8").catch(() => null);
  const match = text ? /^gitdir:\s*(.+?)\s*$/m.exec(text) : null;
  if (!match) {
    warnings.push(`${info.path}: its .git file could not be read; run git worktree repair there.`);
    return;
  }
  const name = NodePath.basename(match[1]!);
  const main = absoluteIn(root, info.mainRepository!);
  const adminDir = NodePath.join(main, ".git", "worktrees", name);
  if (!(await exists(adminDir))) {
    warnings.push(
      `${info.path}: its main repository has no record for it; run git worktree repair there.`,
    );
    return;
  }
  if (match[1] !== adminDir) await NodeFSP.writeFile(gitFile, `gitdir: ${adminDir}\n`);
  await runGit(main, ["worktree", "repair", location], { allowFailure: true });
  // Both pointers now name this machine's paths; record them so Undo does not mistake them for edits.
  for (const file of [gitFile, NodePath.join(adminDir, "gitdir")]) {
    const hashed = await hashFile(file, false).catch(() => null);
    if (hashed)
      await journal.append(
        {
          t: "rewritten",
          path: NodePath.relative(root, file).split(NodePath.sep).join("/"),
          sha256: hashed.sha256,
        },
        true,
      );
  }
}

/** fsck, refs, stashes and status of a copied repository against the source manifest. */
async function verifyRepository(
  input: ApplyInput,
  step: GitStep,
  info: RepositoryInfo | undefined,
): Promise<RepositoryCheck> {
  const problems: Array<string> = [];
  const cwd = absoluteIn(input.targetRoot, step.repo);
  if (!info) return { repo: step.repo, ok: true, problems };
  if (info.kind === "main") {
    const fsck = await runGit(cwd, ["fsck", "--connectivity-only", "--no-progress"], {
      allowFailure: true,
      timeoutMs: 60 * 60_000,
    });
    if (fsck.code !== 0) problems.push("git fsck --connectivity-only failed.");
    const branches: Record<string, string> = {};
    for (const line of (
      await runGit(cwd, ["for-each-ref", "--format=%(objectname) %(refname:short)", "refs/heads"])
    ).stdout
      .split("\n")
      .filter(Boolean)) {
      const space = line.indexOf(" ");
      branches[line.slice(space + 1)] = line.slice(0, space);
    }
    for (const [name, sha] of Object.entries(info.branches))
      if (branches[name] !== sha) problems.push(`Branch ${name} does not match the source.`);
    const stashCount = Number(
      (
        await runGit(cwd, ["rev-list", "--walk-reflogs", "--count", "refs/stash"], {
          allowFailure: true,
        })
      ).stdout.trim() || "0",
    );
    if (stashCount !== info.stashCount)
      problems.push(`Stash count ${stashCount} differs from the source's ${info.stashCount}.`);
  }
  const head = await currentRef(cwd, "HEAD");
  if (head !== info.head) problems.push("HEAD does not match the source.");
  const status = (
    await runGit(cwd, [
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=normal",
      "--ignore-submodules=none",
    ])
  ).stdout
    .split("\0")
    .filter((line) => line.length > 3);
  const prefix = step.repo === "." ? "" : `${step.repo}/`;
  const relevant = (line: string) => {
    const path = `${prefix}${line.slice(3).replace(/\/$/, "")}`;
    return ![...input.leftBehind].some(
      (left) => left === path || left.startsWith(`${path}/`) || path.startsWith(`${left}/`),
    );
  };
  const mine = status.filter(relevant).sort();
  const theirs = info.status.filter(relevant).sort();
  if (mine.join("\n") !== theirs.join("\n")) problems.push("git status differs from the source.");
  return { repo: step.repo, ok: problems.length === 0, problems };
}

/** Bytes Apply needs free: staged files (twice when staging and target are on different volumes). */
export function bytesNeeded(plan: Plan, sameVolume: boolean): number {
  const staged = plan.actions.reduce(
    (sum, action) => sum + (action.entry?.type === "file" ? action.entry.size : 0),
    0,
  );
  return sameVolume ? staged : staged * 2;
}

export { NodeFS };
