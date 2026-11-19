// @effect-diagnostics nodeBuiltinImport:off - plain promises over real Git, like folderTransfer/git.ts.
/**
 * Moving one checkout forward (1390), by the row the named fetch showed and to
 * the commit that fetch brought. `run` compares and moves, or declines; it
 * never plans again and never picks a target.
 *
 * The write is a guarded fast-forward, never a merge: a ref transaction that
 * updates HEAD (through the branch HEAD names) from the recorded commit to the
 * recorded target is prepared, so Git holds HEAD and that branch locked; under
 * the lock the checkout is checked once more (the admission point), the files
 * and the index are moved with `read-tree -m -u`, and then the transaction is
 * committed. No other Git program can switch the branch, commit or move the
 * branch meanwhile. Files, the index and settings cannot be locked: what
 * differs afterwards is reported, never undone.
 */
import * as NodePath from "node:path";

import {
  PROJECT_SYNC_CHANGED_BRANCH_DETAIL,
  PROJECT_SYNC_CHANGED_FOLDER_DETAIL,
  PROJECT_SYNC_CHANGED_HEAD_DETAIL,
  PROJECT_SYNC_CHANGED_UPSTREAM_DETAIL,
  PROJECT_SYNC_GRAFTS_DETAIL,
  PROJECT_SYNC_NO_FETCH_DETAIL,
  PROJECT_SYNC_PATH_UNREAD_DETAIL,
  PROJECT_SYNC_STATE_UNREAD_DETAIL,
  PROJECT_SYNC_TARGET_MISSING_DETAIL,
  PROJECT_SYNC_TARGET_UNRELATED_DETAIL,
  PROJECT_SYNC_UNVERIFIED_DETAIL,
  projectSyncFilesDifferDetail,
  projectSyncFilterDetail,
  projectSyncHeldElsewhereDetail,
  projectSyncInTheWayDetail,
  projectSyncLockedDetail,
  projectSyncObservedDetail,
  projectSyncPartialDetail,
  projectSyncSubmoduleDetail,
  type ProjectSyncStep,
  type ProjectSyncStepResult,
} from "@specweave-studio/contracts";
import * as NodeFSP from "node:fs/promises";

import { gitFolders, unreadFacts } from "./projectSyncFacts.ts";
import { planProjectSyncRepository } from "@specweave-studio/contracts";
import {
  commitOf,
  FETCH_MS,
  gitReason,
  headBranch,
  isLinkedWorktree,
  LOCAL_MS,
  present,
  shortBranch,
  type SyncContext,
  type SyncGit,
  type SyncRepository,
  uncommittedCount,
} from "./projectSyncGit.ts";
import { type Row, sameTuple, upstreamOf } from "./projectSyncRecord.ts";
import { refTransaction } from "./refTransaction.ts";

const stepOf = (
  planned: ProjectSyncStep,
  change: Partial<ProjectSyncStepResult> = {},
): ProjectSyncStepResult => ({ ...planned, moved: 0, downgraded: false, ...change });

/** A step for a checkout with no row to go by. */
const bare = (path: string, otherBranch: string | null): ProjectSyncStep => ({
  path,
  action: "none",
  reason: "refused",
  branch: null,
  otherBranch,
  ahead: 0,
  behind: 0,
  uncommitted: 0,
  inUseBy: null,
  remote: null,
  detail: null,
});

/** What a path in the move's diff is: added, deleted or changed, and its modes. */
interface Change {
  readonly path: string;
  readonly status: string;
  readonly oldMode: string;
  readonly newMode: string;
}

/** The paths `from`..`to` touches, read from `diff-tree -z`; null when Git could not say. */
async function changesOf(
  git: SyncGit,
  cwd: string,
  from: string,
  to: string,
): Promise<Array<Change> | null> {
  const listed = await git(
    cwd,
    ["diff-tree", "-r", "-z", "--no-renames", "--no-commit-id", "--raw", from, to],
    { allowFailure: true, timeoutMs: LOCAL_MS },
  ).catch(() => null);
  if (listed === null || listed.code !== 0) return null;
  const fields = listed.stdout.split("\0");
  const out: Array<Change> = [];
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const meta = fields[index]!;
    const path = fields[index + 1]!;
    const parts = /^:(\d{6}) (\d{6}) [0-9a-f]+ [0-9a-f]+ ([A-Z])$/.exec(meta);
    if (parts === null || path.length === 0) return null;
    out.push({ path, oldMode: parts[1]!, newMode: parts[2]!, status: parts[3]! });
  }
  return out;
}

/**
 * The first path the move would write over that Git does not track here: an
 * added path that exists in any form (a file, a folder, a link, ignored or
 * not), or a folder on its way that is not a real folder. Null when nothing is
 * in the way; undefined when the file system did not say.
 */
async function inTheWay(cwd: string, changes: ReadonlyArray<Change>) {
  for (const change of changes) {
    if (change.status !== "A") continue;
    const parts = change.path.split("/");
    for (let depth = 1; depth < parts.length; depth += 1) {
      const folder = NodePath.join(cwd, ...parts.slice(0, depth));
      const found = await NodeFSP.lstat(folder).then(
        (stat) => (stat.isDirectory() && !stat.isSymbolicLink() ? "folder" : "other"),
        (cause: unknown) =>
          (cause as { readonly code?: unknown }).code === "ENOENT" ? "none" : "unread",
      );
      if (found === "unread") return undefined;
      if (found === "other") return parts.slice(0, depth).join("/");
      if (found === "none") break;
    }
    const leaf = await present(NodePath.join(cwd, ...parts));
    if (leaf === null) return undefined;
    if (leaf) return change.path;
  }
  return null;
}

/** The first changed path a Git filter applies to, here or in the target; undefined when unread. */
async function filtered(
  git: SyncGit,
  cwd: string,
  target: string,
  paths: ReadonlyArray<string>,
): Promise<{ readonly path: string; readonly filter: string } | null | undefined> {
  if (paths.length === 0) return null;
  for (const source of [[], ["--source", target]]) {
    const checked = await git(cwd, ["check-attr", ...source, "-z", "filter", "--stdin"], {
      allowFailure: true,
      timeoutMs: LOCAL_MS,
      input: paths.map((path) => `${path}\0`).join(""),
    }).catch(() => null);
    if (checked === null || checked.code !== 0) return undefined;
    const fields = checked.stdout.split("\0");
    for (let index = 0; index + 2 < fields.length; index += 3) {
      const value = fields[index + 2]!;
      if (value !== "unspecified" && value !== "unset")
        return { path: fields[index]!, filter: value };
    }
  }
  return null;
}

/** Another worktree of the repository that has `branch` checked out; undefined when unread. */
async function heldElsewhere(
  git: SyncGit,
  cwd: string,
  branch: string,
): Promise<string | null | undefined> {
  const listed = await git(cwd, ["worktree", "list", "--porcelain", "-z"], {
    allowFailure: true,
    timeoutMs: LOCAL_MS,
  }).catch(() => null);
  if (listed === null || listed.code !== 0) return undefined;
  let folder: string | null = null;
  for (const field of listed.stdout.split("\0")) {
    if (field.startsWith("worktree ")) folder = field.slice("worktree ".length);
    else if (field === `branch ${branch}` && folder !== null) {
      const real = await NodeFSP.realpath(folder).catch(() => NodePath.resolve(folder!));
      if (real !== cwd) return folder;
    }
  }
  return null;
}

/** The commit graph this move goes by: local grafts would rewrite it (replacements are off). */
async function graftsSet(gitDir: string): Promise<boolean | null> {
  const common = await NodeFSP.readFile(NodePath.join(gitDir, "commondir"), "utf8").then(
    (text) => NodePath.resolve(gitDir, text.trim()),
    (cause: unknown) => ((cause as { readonly code?: unknown }).code === "ENOENT" ? gitDir : null),
  );
  if (common === null) return null;
  return present(NodePath.join(common, "info", "grafts"));
}

/**
 * Moves one checkout forward by its row in the named fetch. Every read is a
 * value, Git's own "absent", or unread; unread declines with its sentence and
 * is never taken for a finding.
 */
export async function fastForwardRepository(
  context: SyncContext,
  repository: SyncRepository,
  otherBranch: string | null,
): Promise<ProjectSyncStepResult> {
  const { git } = context;
  // A folder Sync could not read is left alone, whatever any fetch says of it.
  if (repository.unread === true)
    return stepOf(
      {
        ...planProjectSyncRepository(
          unreadFacts(repository.path, PROJECT_SYNC_PATH_UNREAD_DETAIL),
          null,
        ),
        otherBranch,
      },
      { downgraded: true },
    );
  const lookup = context.record ?? (() => context.fetched);
  const row = lookup()?.rows.get(repository.path);
  if (row === undefined)
    return stepOf(bare(repository.path, otherBranch), {
      detail: PROJECT_SYNC_NO_FETCH_DETAIL,
      downgraded: true,
    });
  const planned: ProjectSyncStep = { ...row.planned, otherBranch };
  const decline = (
    detail: string,
    action: ProjectSyncStep["action"] = "none",
    reason: ProjectSyncStep["reason"] = "refused",
    more: Partial<ProjectSyncStepResult> = {},
  ) => stepOf(planned, { action, reason, detail, downgraded: true, ...more });
  // A row that was not readable, or that was not shown as a fast-forward, moves nothing:
  // it is returned as it was shown.
  if (!row.readable || row.planned.action !== "fast-forward")
    return stepOf(planned, { downgraded: true });
  // The other machine's plan can only keep the checkout from moving.
  if (
    otherBranch !== null &&
    row.branch !== null &&
    shortBranch(otherBranch) !== shortBranch(row.branch)
  )
    return stepOf(planned, { action: "fetch", reason: "other-branch", downgraded: true });
  const linked = repository.path === "." ? false : await isLinkedWorktree(git, repository.cwd);
  if (linked === null) return decline(PROJECT_SYNC_STATE_UNREAD_DETAIL);
  if (linked) return decline("A thread's worktree is never moved by Sync.");
  const head = row.head!;
  const target = row.target!;
  // The same checkout and Git folder as at the fetch, and every later command runs there.
  const where = await gitFolders(git, repository.cwd);
  if (where === null) return decline(PROJECT_SYNC_STATE_UNREAD_DETAIL);
  if (where.cwd !== row.cwd || where.gitDir !== row.gitDir)
    return decline(PROJECT_SYNC_CHANGED_FOLDER_DETAIL);
  const cwd = row.cwd;
  const asFetched = await checkAsFetched(context, cwd, row);
  if (asFetched !== null) return decline(asFetched);
  // The target is in this checkout, and follows from the recorded commit.
  const objects = await git(cwd, ["cat-file", "--batch-check=%(objecttype)"], {
    allowFailure: true,
    timeoutMs: LOCAL_MS,
    input: `${target}\n`,
  }).catch(() => null);
  if (objects === null || objects.code !== 0) return decline(PROJECT_SYNC_STATE_UNREAD_DETAIL);
  if (objects.stdout.trim() !== "commit") return decline(PROJECT_SYNC_TARGET_MISSING_DETAIL);
  const grafts = await graftsSet(row.gitDir);
  if (grafts === null) return decline(PROJECT_SYNC_STATE_UNREAD_DETAIL);
  if (grafts) return decline(PROJECT_SYNC_GRAFTS_DETAIL);
  const ancestor = await git(cwd, ["merge-base", "--is-ancestor", head, target], {
    allowFailure: true,
    timeoutMs: LOCAL_MS,
  }).catch(() => null);
  if (ancestor === null || (ancestor.code !== 0 && ancestor.code !== 1))
    return decline(PROJECT_SYNC_STATE_UNREAD_DETAIL);
  if (ancestor.code === 1) return decline(PROJECT_SYNC_TARGET_UNRELATED_DETAIL);
  const changes = await changesOf(git, cwd, head, target);
  if (changes === null) return decline(PROJECT_SYNC_STATE_UNREAD_DETAIL);
  const gitlink = changes.find(
    (change) => change.oldMode === "160000" || change.newMode === "160000",
  );
  if (gitlink !== undefined) return decline(projectSyncSubmoduleDetail(gitlink.path));
  const filter = await filtered(
    git,
    cwd,
    target,
    changes.map((change) => change.path),
  );
  if (filter === undefined) return decline(PROJECT_SYNC_STATE_UNREAD_DETAIL);
  if (filter !== null) return decline(projectSyncFilterDetail(filter.path, filter.filter));
  // Quick refusals before the lock; every one is read again under it.
  const ready = await readyToWrite(context, cwd, row, changes);
  if (ready !== null) return decline(...ready);

  const transaction = (context.transaction ?? refTransaction)(cwd, "sync: fast-forward");
  const prepared = await transaction.prepare([`update HEAD ${target} ${head}`]);
  if (!prepared.ok) {
    await transaction.abort();
    const reason = gitReason(prepared.reason);
    // The old tip check is part of `prepare`: the branch moved since the fetch.
    return decline(
      /is at [0-9a-f]+ but expected/.test(reason)
        ? PROJECT_SYNC_CHANGED_HEAD_DETAIL
        : projectSyncLockedDetail(reason),
    );
  }
  // The admission point. HEAD and the branch it names are locked now and cannot change;
  // everything else is read for the last time before the write.
  const admitted = await admit(context, lookup, cwd, row, changes);
  if (admitted !== null) {
    await transaction.abort();
    return decline(...admitted);
  }
  // Past this point the decision stands: the files are moved and the transaction is
  // committed, also when the record expires or the call is cancelled meanwhile.
  const tree = await git(
    cwd,
    [
      "-c",
      "submodule.recurse=false",
      "read-tree",
      "-m",
      "-u",
      "--no-recurse-submodules",
      head,
      target,
    ],
    { allowFailure: true, timeoutMs: FETCH_MS },
  ).catch((cause: unknown) => ({
    code: -1,
    stdout: "",
    stderr: cause instanceof Error ? cause.message : "Git did not finish.",
  }));
  if (tree.code !== 0) {
    await transaction.abort();
    return afterFailedTree(context, cwd, row, changes, planned, gitReason(tree.stderr));
  }
  const committed = await transaction.commit().catch(() => null);
  return readBack(context, cwd, row, changes, planned, committed);
}

/** Branch, commit and upstream against the row; a sentence when they differ or are unread. */
async function checkAsFetched(context: SyncContext, cwd: string, row: Row): Promise<string | null> {
  const { git } = context;
  const [branch, head] = await Promise.all([headBranch(git, cwd), commitOf(git, cwd, "HEAD")]);
  if (branch.kind === "unread" || head.kind === "unread") return PROJECT_SYNC_STATE_UNREAD_DETAIL;
  if (branch.kind !== "value" || branch.value !== row.branch)
    return PROJECT_SYNC_CHANGED_BRANCH_DETAIL;
  if (head.kind !== "value" || head.value !== row.head) return PROJECT_SYNC_CHANGED_HEAD_DETAIL;
  const upstream = await upstreamOf(git, cwd, row.branch);
  if (upstream === undefined) return PROJECT_SYNC_STATE_UNREAD_DETAIL;
  if (!sameTuple(upstream?.tuple ?? null, row.upstream))
    return PROJECT_SYNC_CHANGED_UPSTREAM_DETAIL;
  return null;
}

type Declined = [
  string,
  ProjectSyncStep["action"],
  ProjectSyncStep["reason"],
  Partial<ProjectSyncStepResult>,
];

/** Clean, nothing in the way, the branch held by no other worktree, no running thread. */
async function readyToWrite(
  context: SyncContext,
  cwd: string,
  row: Row,
  changes: ReadonlyArray<Change>,
): Promise<Declined | null> {
  const { git } = context;
  const uncommitted = await uncommittedCount(git, cwd);
  if (uncommitted === null) return [PROJECT_SYNC_STATE_UNREAD_DETAIL, "none", "refused", {}];
  if (uncommitted > 0)
    return [
      `Not moved forward: ${uncommitted} uncommitted ${uncommitted === 1 ? "file" : "files"}.`,
      "fetch",
      "uncommitted",
      { uncommitted },
    ];
  const blocked = await inTheWay(cwd, changes);
  if (blocked === undefined) return [PROJECT_SYNC_STATE_UNREAD_DETAIL, "none", "refused", {}];
  if (blocked !== null) return [projectSyncInTheWayDetail(blocked), "none", "refused", {}];
  const holder = await heldElsewhere(git, cwd, row.branch!);
  if (holder === undefined) return [PROJECT_SYNC_STATE_UNREAD_DETAIL, "none", "refused", {}];
  if (holder !== null)
    return [
      projectSyncHeldElsewhereDetail(shortBranch(row.branch!), holder),
      "none",
      "refused",
      {},
    ];
  const thread = await context.inUse(cwd);
  if (thread !== null) return [`In use by ${thread}.`, "fetch", "in-use", { inUseBy: thread }];
  return null;
}

/**
 * The admission point, under Git's lock on HEAD and the branch: HEAD still
 * names the recorded branch in the same Git folder, the named fetch is still
 * kept with this very row, the upstream is the recorded one, the index is
 * refreshed and the checkout clean, nothing is in the way, and no thread
 * started. Upstream, files and threads are observations, not locks.
 */
async function admit(
  context: SyncContext,
  lookup: () => ReturnType<NonNullable<SyncContext["record"]>>,
  cwd: string,
  row: Row,
  changes: ReadonlyArray<Change>,
): Promise<Declined | null> {
  const { git } = context;
  const where = await gitFolders(git, cwd);
  if (where === null) return [PROJECT_SYNC_STATE_UNREAD_DETAIL, "none", "refused", {}];
  if (where.cwd !== row.cwd || where.gitDir !== row.gitDir)
    return [PROJECT_SYNC_CHANGED_FOLDER_DETAIL, "none", "refused", {}];
  if (lookup()?.rows.get(row.path) !== row)
    return [PROJECT_SYNC_NO_FETCH_DETAIL, "none", "refused", {}];
  const changed = await checkAsFetched(context, cwd, row);
  if (changed !== null) return [changed, "none", "refused", {}];
  // Stat data only: a file touched but not changed is not "uncommitted".
  const refreshed = await git(cwd, ["update-index", "-q", "--refresh"], {
    allowFailure: true,
    timeoutMs: LOCAL_MS,
  }).catch(() => null);
  if (refreshed === null) return [PROJECT_SYNC_STATE_UNREAD_DETAIL, "none", "refused", {}];
  return readyToWrite(context, cwd, row, changes);
}

/** The files of the move that differ from `commit` here, the index included; null when unread. */
async function differing(
  git: SyncGit,
  cwd: string,
  commit: string,
  changes: ReadonlyArray<Change>,
  targetSide: boolean,
): Promise<Array<string> | null> {
  const out = new Set<string>();
  const paths = changes.map((change) => change.path);
  for (const args of [
    ["diff-index", "--cached", "--name-only", "-z", "--no-renames", commit, "--", ...paths],
    ["diff", "--name-only", "-z", "--no-renames", commit, "--", ...paths],
  ]) {
    const listed = await git(cwd, args, { allowFailure: true, timeoutMs: LOCAL_MS }).catch(
      () => null,
    );
    if (listed === null || listed.code !== 0) return null;
    for (const path of listed.stdout.split("\0")) if (path.length > 0) out.add(path);
  }
  // A file the commit does not have that is still here (Git could not remove it, or it came
  // back) is not in either diff once the index has moved.
  for (const change of changes) {
    const absentThere = targetSide ? change.status === "D" : change.status === "A";
    if (!absentThere) continue;
    const found = await present(NodePath.join(cwd, ...change.path.split("/")));
    if (found === null) return null;
    if (found) out.add(change.path);
  }
  return [...out].toSorted();
}

/** After `read-tree` failed: the branch did not move; the files are said as they are. */
async function afterFailedTree(
  context: SyncContext,
  cwd: string,
  row: Row,
  changes: ReadonlyArray<Change>,
  planned: ProjectSyncStep,
  reason: string,
): Promise<ProjectSyncStepResult> {
  const { git } = context;
  const at = await commitOf(git, cwd, row.branch!);
  const touched = await differing(git, cwd, row.head!, changes, false);
  if (at.kind !== "value" || touched === null)
    return stepOf(planned, {
      detail: PROJECT_SYNC_UNVERIFIED_DETAIL,
      movedUnverified: true,
      downgraded: true,
    });
  if (at.value !== row.head)
    return stepOf(planned, {
      detail: projectSyncObservedDetail(shortBranch(row.branch!), at.value),
      movedUnverified: true,
      downgraded: true,
    });
  if (touched.length === 0)
    return stepOf(planned, { action: "none", reason: "refused", detail: reason, downgraded: true });
  return stepOf(planned, {
    detail: projectSyncPartialDetail(shortBranch(row.branch!), touched.length, touched[0]!),
    downgraded: true,
  });
}

/**
 * After the commit was sent. A move, and its count, is claimed only when Git
 * answered `commit: ok`, HEAD still names the recorded branch and that branch
 * is at the target. Files that differ from the target are a second fact.
 */
async function readBack(
  context: SyncContext,
  cwd: string,
  row: Row,
  changes: ReadonlyArray<Change>,
  planned: ProjectSyncStep,
  committed: { readonly ok: boolean; readonly reason?: string } | null,
): Promise<ProjectSyncStepResult> {
  const { git } = context;
  const branch = shortBranch(row.branch!);
  const target = row.target!;
  const [at, named] = await Promise.all([commitOf(git, cwd, row.branch!), headBranch(git, cwd)]);
  const unverified = (detail: string = PROJECT_SYNC_UNVERIFIED_DETAIL) =>
    stepOf(planned, { detail, movedUnverified: true, downgraded: true });
  if (at.kind !== "value" || named.kind === "unread") return unverified();
  if (committed === null || !committed.ok) {
    if (at.value === target) return unverified();
    if (at.value !== row.head) return unverified(projectSyncObservedDetail(branch, at.value));
    // The branch stayed; the files had already moved.
    const touched = await differing(git, cwd, row.head!, changes, false);
    if (touched === null) return unverified();
    return stepOf(planned, {
      detail:
        touched.length === 0
          ? gitReason(committed?.reason ?? "")
          : projectSyncPartialDetail(branch, touched.length, touched[0]!),
      ...(touched.length === 0 ? { action: "none", reason: "refused" } : {}),
      downgraded: true,
    });
  }
  if (at.value !== target || named.kind !== "value" || named.value !== row.branch)
    return unverified(projectSyncObservedDetail(branch, at.value));
  const differ = await differing(git, cwd, target, changes, true);
  if (differ === null)
    return stepOf(planned, {
      moved: row.behind,
      detail:
        "Moved forward, but its files could not be read afterwards. Check them before working in it.",
    });
  return stepOf(planned, {
    moved: row.behind,
    ...(differ.length === 0
      ? {}
      : { detail: projectSyncFilesDifferDetail(differ.length, differ[0]!) }),
  });
}
