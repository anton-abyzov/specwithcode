// @effect-diagnostics nodeBuiltinImport:off - Apply moves staged files, backs up what it replaces and journals each step.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import { exists, JsonLog, lstatOrNull } from "./durable.ts";
import { type GitResult, originCandidates, remoteEnv, runGit } from "./git.ts";
import { hashFile, type RepositoryInfo } from "./manifest.ts";
import { isSafeRelativePath, linkTargetOnWire } from "./paths.ts";
import { stagedPath } from "./pullWorker.ts";
import type { FileAction, GitStep, Plan } from "./reconcile.ts";

/**
 * One journal line per step, written before the step changes anything (intent)
 * and, for file writes, after it (done). Undo and an interrupted Apply both read
 * this log: what it does not mention, Apply never touched. A record that must be
 * on disk before its step (a backup, a write intent) is synced first; one sync
 * makes every earlier line durable, so intents are synced a batch at a time.
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
  /**
   * Apply restores this path from the copied index (it changed on the source after
   * the Git snapshot) and it holds this afterwards. Synced before the restore runs.
   */
  | {
      readonly t: "restore";
      readonly path: string;
      readonly sha256: string | null;
      readonly linkTarget: string | null;
    }
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
  /** Files and links restored to their Git snapshot version: the copy is older than the source there. */
  readonly restored: ReadonlyArray<string>;
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

/**
 * The temporary name a cross-volume move into `to` copies to. It is fixed per
 * operation (named by its journal) and destination, so a move run again replaces
 * the leftover instead of adding one, and its hash keeps it off anyone's own file.
 */
export const partialPath = (to: string, journalFile: string) =>
  NodePath.join(
    NodePath.dirname(to),
    `.${NodePath.basename(to)}.swc-partial-${NodeCrypto.createHash("sha256")
      .update(`${journalFile}\0${to}`)
      .digest("hex")
      .slice(0, 12)}`,
  );

/** The partial name earlier versions used: `.<name>.swc-<uuid>.partial`. */
const LEGACY_PARTIAL =
  /^\.(.+)\.swc-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.partial$/;

/**
 * Removes what a killed cross-volume move into `to` left beside it, under this
 * name or an earlier version's. Only for a path the journal records Apply writing
 * or backing up. `listings` caches each folder's names across calls.
 */
export async function removePartials(
  to: string,
  journalFile: string,
  listings: Map<string, ReadonlyArray<string>>,
) {
  await NodeFSP.rm(partialPath(to, journalFile), { recursive: true, force: true });
  const folder = NodePath.dirname(to);
  let names = listings.get(folder);
  if (names === undefined) {
    names = await NodeFSP.readdir(folder).catch(() => []);
    listings.set(folder, names);
  }
  const name = NodePath.basename(to);
  for (const other of names)
    if (LEGACY_PARTIAL.exec(other)?.[1] === name)
      await NodeFSP.rm(NodePath.join(folder, other), { recursive: true, force: true });
}

/**
 * Moves `from` to `to`, copying across volumes; links are moved as links. A copy
 * lands under a temporary name first, so `to` never holds half an entry.
 */
export async function moveEntry(from: string, to: string, journalFile: string): Promise<void> {
  try {
    await NodeFSP.rename(from, to);
    return;
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      // The usual case has its folder already; create it only when the rename says so.
      await NodeFSP.mkdir(NodePath.dirname(to), { recursive: true, mode: 0o700 });
      try {
        await NodeFSP.rename(from, to);
        return;
      } catch (again) {
        if ((again as NodeJS.ErrnoException).code !== "EXDEV") throw again;
      }
    } else if (code !== "EXDEV") throw cause;
  }
  const partial = partialPath(to, journalFile);
  try {
    await NodeFSP.rm(partial, { recursive: true, force: true });
    await NodeFSP.cp(from, partial, {
      recursive: true,
      preserveTimestamps: true,
      verbatimSymlinks: true,
      errorOnExist: true,
      force: false,
    });
    await NodeFSP.rename(partial, to);
  } catch (cause) {
    await NodeFSP.rm(partial, { recursive: true, force: true }).catch(() => undefined);
    throw cause;
  }
  await NodeFSP.rm(from, { recursive: true, force: true });
}

/** Folders Apply has seen this run: created or checked as real folders, and recorded. */
interface FolderState {
  readonly journal: JsonLog<JournalEntry>;
  /** Folders with a mkdir record. */
  readonly created: Set<string>;
  /** Folders checked as real folders (not links) in this batch; each is lstat'ed once per batch. */
  readonly verified: Set<string>;
}

/**
 * Creates the folders above `relative` inside the target, refusing any step that
 * is a link or a file: Apply never writes through a link, so nothing can land
 * outside the target folder.
 */
async function ensureFolders(root: string, relative: string, folders: FolderState) {
  const parts = relative.split("/").slice(0, -1);
  let current = root;
  let prefix = "";
  for (const part of parts) {
    current = NodePath.join(current, part);
    prefix = prefix ? `${prefix}/${part}` : part;
    if (folders.verified.has(prefix)) continue;
    const stat = await lstatOrNull(current);
    if (stat?.isSymbolicLink()) throw new ApplyRefusedError("link-in-path", prefix);
    if (stat && !stat.isDirectory()) throw new ApplyRefusedError("not-a-folder", prefix);
    if (!stat) {
      // Usually recorded with the batch's intents; one found missing only now is synced first.
      if (!folders.created.has(prefix))
        await folders.journal.append({ t: "mkdir", path: prefix }, true);
      folders.created.add(prefix);
      await NodeFSP.mkdir(current);
    }
    folders.verified.add(prefix);
  }
}

/**
 * Records, unsynced, a mkdir for each missing folder above `relative` (and
 * `relative` itself for a folder action), so the batch's one sync makes them
 * durable before any is created. Checks nothing: ensureFolders still refuses
 * links and files on the way.
 */
async function recordFolders(
  root: string,
  relative: string,
  self: boolean,
  folders: FolderState,
  looked: Map<string, "absent" | "other">,
) {
  const parts = relative.split("/");
  if (!self) parts.pop();
  let current = root;
  let prefix = "";
  let missing = false;
  for (const part of parts) {
    current = NodePath.join(current, part);
    prefix = prefix ? `${prefix}/${part}` : part;
    if (folders.verified.has(prefix)) continue;
    // Below a missing folder everything is missing; no need to look.
    let state = missing ? "absent" : looked.get(prefix);
    if (state === undefined) {
      const stat = await lstatOrNull(current);
      if (stat?.isDirectory()) {
        folders.verified.add(prefix);
        continue;
      }
      state = stat ? "other" : "absent";
      looked.set(prefix, state);
    }
    // A link or file on the way is for ensureFolders to refuse, or a folder action to replace.
    if (state === "other") return;
    missing = true;
    if (folders.created.has(prefix)) continue;
    await folders.journal.append({ t: "mkdir", path: prefix });
    folders.created.add(prefix);
  }
}

/** Write intents synced together; a batch also bounds the bytes a replay re-hashes. */
const INTENT_BATCH_FILES = 512;
const INTENT_BATCH_BYTES = 64 * 1024 * 1024;

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
  /** Where each recorded backup goes; the move may not have happened. */
  const backups = new Map(
    previous
      .filter((entry) => entry.t === "backup")
      .map((entry) => [
        (entry as { path: string }).path,
        (entry as Extract<JournalEntry, { t: "backup" }>).backup,
      ]),
  );
  /** Write intents from an earlier run: their target may already hold the copied file. */
  const replayed = new Map(
    previous
      .filter((entry) => entry.t === "write")
      .map((entry) => [
        (entry as { path: string }).path,
        entry as Extract<JournalEntry, { t: "write" }>,
      ]),
  );
  /** Every recorded write intent, earlier runs' and this one's. */
  const intents = new Set(replayed.keys());
  const folders: FolderState = {
    journal,
    created: new Set(
      previous
        .filter((entry) => entry.t === "mkdir")
        .map((entry) => (entry as { path: string }).path),
    ),
    verified: new Set(),
  };
  const warnings: Array<string> = [];
  const root = input.targetRoot;

  /**
   * Moves what is at `location` into the backup, recording that first. False when
   * the backup already holds the original, so what is here is a partial earlier write.
   */
  const backUp = async (target: string, location: string) => {
    let backup = backups.get(target);
    if (backup === undefined) {
      backup = backupLocation(input.backupRoot, target);
      await journal.append({ t: "backup", path: target, backup }, true);
      backups.set(target, backup);
    } else if (await exists(backup)) return false;
    // Without a backup on disk the recorded move never happened: this is still the original.
    await moveEntry(location, backup, input.journalFile);
    return true;
  };
  /** Clears a destination path for a write: backed up once, a partial write removed. */
  const clear = async (target: string, location: string, present: NodeFS.Stats) => {
    if (!(await backUp(target, location)))
      await NodeFSP.rm(location, { recursive: true, force: true });
    if (present.isDirectory())
      for (const folder of folders.verified)
        if (folder === target || folder.startsWith(`${target}/`)) folders.verified.delete(folder);
  };

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
        if (await lstatOrNull(location)) await backUp(step.repo, location);
      }
      if (step.kind === "clone") {
        if (!previous.some((entry) => entry.t === "cloned" && entry.path === step.repo)) {
          await ensureFolders(root, `${step.repo}/x`, folders);
          await journal.append({ t: "cloned", path: step.repo }, true);
          await cloneRepository(root, step, warnings);
        } else if (!(await exists(NodePath.join(absoluteIn(root, step.repo), ".git"))))
          // The journal names a clone before it runs: a Retry clones what never arrived.
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

    /**
     * A write marked done by an earlier run whose target is gone: its rename was
     * lost with the folder unsynced while the done mark survived. Redone from staging.
     */
    const lostWrite = async (action: FileAction, location: string) => {
      if (action.kind !== "write" && action.kind !== "keep-both" && action.kind !== "link")
        return false;
      if (await lstatOrNull(location)) return false;
      return (
        action.entry?.type === "symlink" ||
        (await exists(stagedPath(input.stagingRoot, action.path)))
      );
    };

    const listings = new Map<string, ReadonlyArray<string>>();
    const applyAction = async (action: FileAction) => {
      const target = action.writePath;
      const location = absoluteIn(root, target);
      // A cross-volume copy killed mid-way leaves its partial beside the target.
      if (replayed.has(target)) await removePartials(location, input.journalFile, listings);
      if (written.has(target) && !(await lostWrite(action, location))) return;
      await ensureFolders(root, target, folders);
      const present = await lstatOrNull(location);
      // Git checkouts during Apply create plain files; a link or folder the preview never saw is someone else's change.
      if (
        present &&
        !action.replaces &&
        !backups.has(target) &&
        !replayed.has(target) &&
        (present.isSymbolicLink() || (action.kind === "mkdir") !== present.isDirectory())
      )
        throw new ApplyRefusedError(
          "changed-since-preview",
          target,
          `${target} changed after the preview; review the copy again.`,
        );
      if (action.kind === "mkdir") {
        if (!present?.isDirectory()) {
          if (present) await clear(target, location, present);
          if (!folders.created.has(target))
            await journal.append({ t: "mkdir", path: target }, true);
          folders.created.add(target);
          await NodeFSP.mkdir(location, { mode: (action.entry?.mode ?? 0o755) & 0o777 });
        }
        folders.verified.add(target);
        return;
      }
      const intent = writeIntent(action);
      // A replayed write whose rename already happened only needs its done mark.
      if (replayed.has(target) && present) {
        if (
          intent.linkTarget !== null &&
          present.isSymbolicLink() &&
          linkTargetOnWire(await NodeFSP.readlink(location)) === intent.linkTarget
        ) {
          await journal.append({ t: "write-done", path: target });
          return;
        }
        if (
          intent.sha256 &&
          present.isFile() &&
          present.size === action.entry?.size &&
          (await hashFile(location, false)).sha256 === intent.sha256
        ) {
          await journal.append({ t: "write-done", path: target });
          return;
        }
      }
      if (present) await clear(target, location, present);
      // Done marks need no sync of their own: a replay re-checks an intent against the file.
      if (action.kind === "remove") {
        await journal.append({ t: "write-done", path: target });
        return;
      }
      if (!intents.has(target)) {
        await journal.append(intent, true);
        intents.add(target);
      }
      if (intent.linkTarget !== null) {
        await NodeFSP.symlink(intent.linkTarget, location);
      } else {
        const staged = stagedPath(input.stagingRoot, action.path);
        if (!(await exists(staged))) throw new ApplyRefusedError("staged-missing", action.path);
        await moveEntry(staged, location, input.journalFile);
      }
      await journal.append({ t: "write-done", path: target });
    };

    // A batch at a time: record its folders and new write intents, sync once, then act.
    // Writes over existing files record and sync their backup first, one by one.
    // The journal keeps dependency order: a folder's backup and mkdir come before
    // the intents of anything inside it, because Undo walks it newest first.
    const looked = new Map<string, "absent" | "other">();
    for (let start = 0; start < actions.length;) {
      // Each batch checks its folders afresh, narrowing the time another process
      // has to swap a checked folder for a link.
      folders.verified.clear();
      looked.clear();
      let end = start;
      let bytes = 0;
      while (
        end < actions.length &&
        end - start < INTENT_BATCH_FILES &&
        bytes < INTENT_BATCH_BYTES
      ) {
        const action = actions[end]!;
        if (action.kind === "mkdir") {
          const stat = await lstatOrNull(absoluteIn(root, action.writePath));
          if (stat?.isDirectory()) folders.verified.add(action.writePath);
          else if (!stat) looked.set(action.writePath, "absent");
          else {
            // A folder replacing a file or link runs alone, so its backup and mkdir
            // are journaled before the next batch records what goes inside it.
            if (end === start) end += 1;
            break;
          }
        }
        const entry = action.entry;
        bytes += entry?.type === "file" ? entry.size : 0;
        end += 1;
      }
      const batch = actions.slice(start, end);
      start = end;
      for (const action of batch) {
        const target = action.writePath;
        if (written.has(target)) continue;
        absoluteIn(root, target);
        await recordFolders(root, target, action.kind === "mkdir", folders, looked);
        if (action.replaces || intents.has(target)) continue;
        if (action.kind !== "write" && action.kind !== "keep-both" && action.kind !== "link")
          continue;
        await journal.append(writeIntent(action));
        intents.add(target);
      }
      await journal.sync();
      for (const action of batch) await applyAction(action);
    }

    // After files: worktree repair for copied repositories, then verification.
    for (const step of steps) {
      if (step.kind !== "copy") continue;
      const info = byRepo.get(step.repo);
      if (info?.kind === "linked" && info.mainRepository !== null)
        await repairWorktree(root, info, journal, warnings);
    }
    const restored = await restoreSnapshotFiles(input, intents, folders, previous, warnings);
    const checks: Array<RepositoryCheck> = [];
    for (const step of steps)
      if (step.kind === "copy" || step.kind === "replace")
        checks.push(await verifyRepository(input, step, byRepo.get(step.repo)));
    await journal.append({ t: "done" }, true);
    return { checks, warnings, restored };
  } finally {
    await journal.close();
  }
}

/** The write intent for a file or link action: what its target should hold afterwards. */
function writeIntent(action: FileAction): Extract<JournalEntry, { t: "write" }> {
  const entry = action.entry;
  return {
    t: "write",
    path: action.writePath,
    sha256: entry?.type === "file" ? (entry.sha256 ?? null) : null,
    linkTarget: entry?.type === "symlink" ? (entry.target ?? null) : null,
  };
}

async function cloneRepository(root: string, step: GitStep, warnings: Array<string>) {
  const location = absoluteIn(root, step.repo);
  if (!step.origin)
    throw new ApplyRefusedError("git-failed", step.repo, "No origin to clone from.");
  const parent = NodePath.dirname(location);
  // A Retry can find the folder already holding repositories nested in it; Git clones
  // only into an empty folder, so it clones beside them and moves `.git` in.
  const entries = await NodeFSP.readdir(location).catch(() => [] as Array<string>);
  const into = entries.length > 0 ? NodePath.join(location, ".swc-clone") : location;
  if (into !== location) await NodeFSP.rm(into, { recursive: true, force: true });
  let result: GitResult | null = null;
  for (const candidate of originCandidates(step.origin)) {
    // Git removes what a failed clone wrote, so the next address starts from the same folder.
    result = await runGit(parent, ["clone", "--quiet", "--no-checkout", candidate, into], {
      allowFailure: true,
      timeoutMs: 60 * 60_000,
      env: remoteEnv(),
    });
    if (result.code === 0) break;
  }
  if (into !== location) {
    if (result?.code === 0)
      await NodeFSP.rename(NodePath.join(into, ".git"), NodePath.join(location, ".git"));
    await NodeFSP.rm(into, { recursive: true, force: true });
  }
  if (!result || result.code !== 0)
    throw new ApplyRefusedError(
      "git-failed",
      step.repo,
      `Cloning ${step.repo === "." ? "the root repository" : step.repo} from origin failed: this machine cannot read ${step.origin}${cloneFailureReason(result?.stderr ?? "")}. Copy again with that repository copied whole, or sign in to Git here (for example gh auth login) and Retry.`,
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

/** Git's own reason for a failed clone, short and without URLs that could carry tokens. */
function cloneFailureReason(stderr: string): string {
  const line = stderr
    .split("\n")
    .map((item) => item.replace(/^(?:fatal|error|remote): /, "").trim())
    .find((item) => item.length > 0 && !/https?:\/\//.test(item));
  return line ? ` (${line.slice(0, 160)})` : "";
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
  // Git writes the pointer with `/` on Windows; compare in native form.
  if (NodePath.resolve(match[1]!) !== adminDir) {
    // Rewrite in place: Windows refuses to recreate a hidden file, and Git
    // hides `.git` there.
    const handle = await NodeFSP.open(gitFile, "r+");
    try {
      await handle.truncate(0);
      await handle.write(`gitdir: ${adminDir}\n`, 0);
    } finally {
      await handle.close();
    }
  }
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

const STATUS_PATHS_NAMED = 20;

/** A path the copy deliberately left behind, inside one, or a folder holding one. */
const isLeftBehind = (leftBehind: ReadonlySet<string>, path: string) =>
  [...leftBehind].some(
    (left) => left === path || left.startsWith(`${path}/`) || path.startsWith(`${left}/`),
  );

/** Paths per `git check-attr` call, short enough for any command line. */
const CHECK_ATTR_PATHS = 200;

/** Paths whose `filter` attribute is set (Git LFS and the like): their checkout is not plain bytes. */
async function filteredPaths(cwd: string, paths: ReadonlyArray<string>) {
  const result = new Set<string>();
  for (let start = 0; start < paths.length; start += CHECK_ATTR_PATHS) {
    const fields = (
      await runGit(cwd, [
        "check-attr",
        "-z",
        "filter",
        "--",
        ...paths.slice(start, start + CHECK_ATTR_PATHS),
      ])
    ).stdout.split("\0");
    for (let index = 0; index + 2 < fields.length; index += 3)
      if (fields[index + 2] !== "unspecified" && fields[index + 2] !== "unset")
        result.add(fields[index]!);
  }
  return result;
}

/**
 * A copied repository's Git data is the snapshot taken when copying started,
 * but its working files are read later, so a file committed or removed on the
 * source since then arrives newer than the copied index and HEAD. Each such
 * file or link Apply wrote (or left out as unstable) that was clean at the
 * snapshot is restored from the copied index: the copy is the source as it was
 * when copying started. Filtered files (LFS) are left as transferred.
 *
 * Git writes each snapshot version beside the journal first, without touching
 * the copied index, so what every path will hold is journaled and synced before
 * the folder changes. A replay finds the paths not yet restored the same way and
 * reports the ones an earlier run recorded.
 */
async function restoreSnapshotFiles(
  input: ApplyInput,
  intents: ReadonlySet<string>,
  folders: FolderState,
  previous: ReadonlyArray<JournalEntry>,
  warnings: Array<string>,
): Promise<Array<string>> {
  const root = input.targetRoot;
  const recorded = new Map<string, Extract<JournalEntry, { t: "restore" }>>();
  for (const entry of previous) if (entry.t === "restore") recorded.set(entry.path, entry);
  const restored = new Set(recorded.keys());
  const scratch = NodePath.join(NodePath.dirname(input.journalFile), "restore");
  for (const step of input.plan.git) {
    if (step.kind !== "copy" && step.kind !== "replace") continue;
    const info = input.sourceRepositories.find((repo) => repo.path === step.repo);
    if (!info) continue;
    const cwd = absoluteIn(root, step.repo);
    const prefix = step.repo === "." ? "" : `${step.repo}/`;
    // A rename's second field is a bare path; keeping whole lines too errs toward leaving it.
    const atSnapshot = new Set(info.status.flatMap((line) => [line.slice(3), line]));
    const status = await runGit(
      cwd,
      ["status", "--porcelain=v1", "-z", "--untracked-files=no", "--ignore-submodules=all"],
      { allowFailure: true },
    );
    if (status.code !== 0) continue;
    const fields = status.stdout.split("\0");
    const candidates: Array<string> = [];
    for (let index = 0; index < fields.length; index += 1) {
      const field = fields[index]!;
      if (field.length < 4) continue;
      if (field[0] === "R" || field[0] === "C") {
        index += 1;
        continue;
      }
      const path = field.slice(3);
      // Only the working file differs from the copied index; the index itself is the snapshot's.
      if (field[0] !== " " || !"MDT".includes(field[1]!) || atSnapshot.has(path)) continue;
      const full = `${prefix}${path}`;
      const unstable = input.unstable?.has(full) ?? false;
      if (!unstable && (!intents.has(full) || isLeftBehind(input.leftBehind, full))) continue;
      // Apply skipped an unstable path without a backup, so whatever is there is the
      // destination's own (or an earlier run's restore): never overwrite it.
      if (unstable && !recorded.has(full) && (await lstatOrNull(absoluteIn(root, full)))) continue;
      candidates.push(path);
    }
    if (candidates.length === 0) continue;
    const filtered = await filteredPaths(cwd, candidates);
    const paths = candidates.filter((path) => !filtered.has(path));
    if (paths.length === 0) continue;
    await NodeFSP.rm(scratch, { recursive: true, force: true });
    await NodeFSP.mkdir(scratch, { recursive: true, mode: 0o700 });
    try {
      // Without -u, checkout-index leaves the copied index exactly as it arrived.
      const written: Array<string> = [];
      for (let start = 0; start < paths.length; start += CHECK_ATTR_PATHS) {
        const chunk = paths.slice(start, start + CHECK_ATTR_PATHS);
        const result = await runGit(
          cwd,
          ["checkout-index", "-f", `--prefix=${scratch}${NodePath.sep}`, "--", ...chunk],
          { allowFailure: true },
        );
        if (result.code === 0) written.push(...chunk);
      }
      const planned: Array<{ readonly full: string; readonly staged: string }> = [];
      const looked = new Map<string, "absent" | "other">();
      folders.verified.clear();
      for (const path of written) {
        const full = `${prefix}${path}`;
        const staged = NodePath.join(scratch, ...path.split("/"));
        const stat = await lstatOrNull(staged);
        if (!stat || (await lstatOrNull(absoluteIn(root, full)))?.isDirectory()) continue;
        const entry: Extract<JournalEntry, { t: "restore" }> = {
          t: "restore",
          path: full,
          sha256: stat.isFile() ? (await hashFile(staged, false)).sha256 : null,
          linkTarget: stat.isSymbolicLink()
            ? linkTargetOnWire(await NodeFSP.readlink(staged))
            : null,
        };
        if (entry.sha256 === null && entry.linkTarget === null) continue;
        await recordFolders(root, full, false, folders, looked);
        const earlier = recorded.get(full);
        if (earlier?.sha256 !== entry.sha256 || earlier?.linkTarget !== entry.linkTarget)
          await folders.journal.append(entry);
        planned.push({ full, staged });
      }
      // One sync makes every restore and the folders it needs durable before any lands.
      await folders.journal.sync();
      for (const { full, staged } of planned) {
        await ensureFolders(root, full, folders);
        await moveEntry(staged, absoluteIn(root, full), input.journalFile);
        restored.add(full);
      }
    } finally {
      await NodeFSP.rm(scratch, { recursive: true, force: true });
    }
  }
  const list = [...restored];
  if (list.length === 0) return list;
  const named = list.slice(0, STATUS_PATHS_NAMED).join(", ");
  const more =
    list.length > STATUS_PATHS_NAMED ? ` and ${list.length - STATUS_PATHS_NAMED} more` : "";
  warnings.push(
    `${list.length === 1 ? "1 file" : `${list.length} files`} changed on the source after copying started; the copy has them as they were when it started. Copy again to bring the newer versions. (${named}${more})`,
  );
  return list;
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
  const relevant = (line: string) =>
    !isLeftBehind(input.leftBehind, `${prefix}${line.slice(3).replace(/\/$/, "")}`);
  const mine = status.filter(relevant).sort();
  const theirs = info.status.filter(relevant).sort();
  if (mine.join("\n") !== theirs.join("\n"))
    problems.push(
      "git status differs from the source.",
      ...statusDifferences(mine, theirs, prefix),
    );
  return { repo: step.repo, ok: problems.length === 0, problems };
}

/** Names the paths whose `git status` differs, here against the source: what changed during the copy. */
function statusDifferences(
  mine: ReadonlyArray<string>,
  theirs: ReadonlyArray<string>,
  prefix: string,
): Array<string> {
  const codes = (lines: ReadonlyArray<string>) =>
    new Map(lines.map((line) => [line.slice(3), line.slice(0, 2).trim()]));
  const here = codes(mine);
  const source = codes(theirs);
  const paths = [...new Set([...here.keys(), ...source.keys()])]
    .filter((path) => here.get(path) !== source.get(path))
    .sort();
  const named = paths
    .slice(0, STATUS_PATHS_NAMED)
    .map(
      (path) =>
        `${prefix}${path}: ${here.get(path) ?? "unchanged"} here, ${source.get(path) ?? "unchanged"} on the source.`,
    );
  if (paths.length > STATUS_PATHS_NAMED)
    named.push(`${paths.length - STATUS_PATHS_NAMED} more paths differ.`);
  return named;
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
