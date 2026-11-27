// @effect-diagnostics nodeBuiltinImport:off - Resolves real paths so a link cannot lead a ledger write outside the worktree.
/**
 * Whose ledger a SpecWeave write tool may touch (1497): the calling thread's
 * own increment, inside its own registered worktree, and nothing else.
 *
 * The increment is the one the thread's plan card follows
 * (ThreadIncrementProgressService), but only through a binding someone gave
 * it or it made itself: a link made by hand, the seed a launch with
 * `increment` writes, the thread's own ledger write, an `inc/NNNN-*` branch,
 * or a spec the thread wrote (reported as `claim`). A number in the title, a
 * session checkpoint or an old ledger line naming the branch is a guess and
 * does not count. Nobody's role matters: a coordinator is held to the same
 * rules.
 *
 * Every path the CLI writes must be a real folder or file inside the real
 * worktree: a link (even one inside the worktree), a second hard link or a
 * leftover temporary file is refused.
 */
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import type { ThreadIncrementProgress } from "@specweave-studio/contracts";

import { isInside, resolveCallerWorkspace } from "./workspace.ts";

/** Bindings that assign an increment; `name` and `checkpoint` only guess one. */
export const ASSIGNING_BINDINGS: ReadonlySet<ThreadIncrementProgress["binding"]> = new Set([
  "manual",
  "claim",
  "branch",
]);

/**
 * An `inc/NNNN-*` branch names its increment. A `branch` binding found only
 * because an old ledger line mentions the branch is a guess for writes.
 */
const INCREMENT_BRANCH = /^inc\/(\d{4,}[A-Za-z]?)-/u;

/**
 * The files `specweave task claim|release|block` may write in the increment
 * folder: the ledger, metadata.json (`updated`, or a planned-to-active move)
 * and spec.md (the status mirror of a spec written before 3.0).
 */
export const LEDGER_FILES = ["ledger.jsonl", "metadata.json", "spec.md"] as const;

/** What a planned-to-active move writes under `.specweave/` besides the increment. */
const STATE_FILE = ["state", "active-increment.json"] as const;

/** The CLI writes `<file>.tmp`, then renames it over `<file>`. */
const TEMP_SUFFIX = ".tmp";

export interface LedgerTarget {
  /** The thread's worktree, real path. */
  readonly workspace: string;
  /** The folder holding `.specweave/` the CLI runs in, real path. */
  readonly specweaveRoot: string;
  /** The increment's full folder name. */
  readonly incrementId: string;
  /** The increment folder, real path. */
  readonly incrementDir: string;
}

export type Ownership =
  | { readonly ok: true; readonly target: LedgerTarget }
  | {
      readonly ok: false;
      readonly code: "capability_denied" | "invalid_request";
      readonly message: string;
    };

const denied = (message: string): Ownership => ({ ok: false, code: "capability_denied", message });

/** `1497` names `1497-some-title`; a full folder name names only itself. */
export function namesIncrement(requested: string, incrementId: string): boolean {
  return requested === incrementId || incrementId.startsWith(`${requested}-`);
}

const realPath = (path: string) => NodeFSP.realpath(path).catch(() => null);

const lstatOrNull = (path: string) => NodeFSP.lstat(path).catch(() => null);

/**
 * Where `path` sits below the real `workspace`: the rest of the path after its
 * highest folder that is the workspace itself (same real path, so another
 * spelling on a disk that ignores case, or a registered worktree path that is
 * a link, still counts). Taking the highest one means a link further down that
 * leads back to the workspace is still part of the rest and gets checked.
 */
async function placeBelow(workspace: string, path: string): Promise<string | null> {
  const resolved = NodePath.resolve(path);
  const { root } = NodePath.parse(resolved);
  const parts = resolved.slice(root.length).split(NodePath.sep).filter((part) => part !== "");
  for (let index = 0; index <= parts.length; index++) {
    if ((await realPath(NodePath.join(root, ...parts.slice(0, index)))) === workspace) {
      return parts.slice(index).join(NodePath.sep);
    }
  }
  return null;
}

/**
 * Whether any folder from `workspace` down to `workspace/below` is a link (or
 * missing). Each step is read as it stands, so a link put in place of a folder
 * is seen, while another spelling of the same folder on a case-insensitive
 * disk is not a link.
 */
async function linkOnTheWay(workspace: string, below: string): Promise<boolean> {
  let path = workspace;
  for (const part of below.split(NodePath.sep).filter((step) => step !== "" && step !== ".")) {
    path = NodePath.join(path, part);
    const stat = await lstatOrNull(path);
    if (stat === null || stat.isSymbolicLink() || !stat.isDirectory()) return true;
  }
  return false;
}

type PathCheck = { readonly ok: true } | { readonly ok: false; readonly message: string };

const OUTSIDE = (path: string, workspace: string) =>
  `${path} leads outside this thread's worktree ${workspace}. SpecWeave write tools change only files inside it.`;

/** A folder the CLI writes through: absent, or a real folder (never a link) inside the worktree. */
async function plainFolder(path: string, workspace: string, required: boolean): Promise<PathCheck> {
  const stat = await lstatOrNull(path);
  if (stat === null) return required ? { ok: false, message: `${path} is missing.` } : { ok: true };
  if (stat.isSymbolicLink()) {
    const real = await realPath(path);
    if (real !== null && !isInside(workspace, real)) {
      return { ok: false, message: OUTSIDE(path, workspace) };
    }
    return {
      ok: false,
      message: `${path} is a link. SpecWeave write tools write only through real folders, so a link cannot send a write to another increment.`,
    };
  }
  if (!stat.isDirectory()) return { ok: false, message: `${path} is not a folder.` };
  const real = await realPath(path);
  return real !== null && isInside(workspace, real)
    ? { ok: true }
    : { ok: false, message: OUTSIDE(path, workspace) };
}

/**
 * A file the CLI writes: absent, or one plain file with no other hard link,
 * and no leftover `<file>.tmp` (the CLI writes that name through any link).
 */
async function plainFile(path: string, workspace: string): Promise<PathCheck> {
  const temp = `${path}${TEMP_SUFFIX}`;
  if ((await lstatOrNull(temp)) !== null) {
    return {
      ok: false,
      message: `${temp} is left over from an interrupted write. Remove it first; SpecWeave writes through that name.`,
    };
  }
  const stat = await lstatOrNull(path);
  if (stat === null) return { ok: true };
  if (stat.isSymbolicLink()) {
    const real = await realPath(path);
    if (real === null)
      return { ok: false, message: `${path} is a link that points nowhere. Fix it first.` };
    if (!isInside(workspace, real)) return { ok: false, message: OUTSIDE(path, workspace) };
    return {
      ok: false,
      message: `${path} is a link. SpecWeave write tools write only to real files; replace the link with the file.`,
    };
  }
  if (!stat.isFile()) return { ok: false, message: `${path} is not a file.` };
  if (stat.nlink > 1) {
    return {
      ok: false,
      message: `${path} has another hard link, which may lie outside this thread's worktree. Replace it with a copy first.`,
    };
  }
  return { ok: true };
}

/**
 * The increment folder and every path the CLI writes there, checked: each
 * folder on the way is real (no link, not even one inside the worktree, which
 * could lead to another increment) and inside the worktree, and each file is
 * absent or one plain file. A file that does not exist yet is fine (the CLI
 * creates `ledger.jsonl` on the first event).
 *
 * This narrows, but cannot close, the gap between this check and the CLI's
 * own writes: the CLI opens names and follows links, so a process that swaps
 * a file in that moment (the thread's own shell, in its own worktree) could
 * still redirect one write. Run it again just before writing.
 */
export async function ledgerPathsInside(input: {
  readonly workspace: string;
  readonly specweaveRoot: string;
  readonly incrementId: string;
}): Promise<
  | { readonly ok: true; readonly incrementDir: string }
  | { readonly ok: false; readonly message: string }
> {
  const marker = NodePath.join(input.specweaveRoot, ".specweave");
  const increments = NodePath.join(marker, "increments");
  const folder = NodePath.join(increments, input.incrementId);
  const incrementDir = await realPath(folder);
  if (incrementDir === null) {
    return {
      ok: false,
      message: `Increment ${input.incrementId} is not in this thread's worktree (${input.specweaveRoot}). SpecWeave write tools change only the copy inside the thread's own worktree.`,
    };
  }
  if (!isInside(input.workspace, incrementDir)) {
    return { ok: false, message: OUTSIDE(folder, input.workspace) };
  }
  for (const [path, required] of [
    [marker, true],
    [increments, true],
    [folder, true],
    [NodePath.join(marker, STATE_FILE[0]), false],
  ] as const) {
    const checked = await plainFolder(path, input.workspace, required);
    if (!checked.ok) return checked;
  }
  for (const file of [
    ...LEDGER_FILES.map((name) => NodePath.join(folder, name)),
    NodePath.join(marker, ...STATE_FILE),
  ]) {
    const checked = await plainFile(file, input.workspace);
    if (!checked.ok) return checked;
  }
  return { ok: true, incrementDir };
}

/** Whether the thread's branch is `inc/NNNN-*` for this increment. */
export function branchNamesIncrement(branch: string | null, incrementId: string): boolean {
  const number = INCREMENT_BRANCH.exec(branch?.trim() ?? "")?.[1];
  return number !== undefined && namesIncrement(number, incrementId);
}

/**
 * Decides whether the caller owns `requested`. `bound` is the caller's entry
 * from the plan-card read, or undefined when nothing binds it. There is one
 * copy to write: the bound copy when it lies inside the worktree (a nested
 * SpecWeave folder included), otherwise the copy at the worktree's own
 * SpecWeave folder. A `folder` naming any other copy is refused, never taken.
 */
export async function decideOwnership(input: {
  readonly worktreePath: string | null;
  readonly branch?: string | null | undefined;
  readonly folder?: string | undefined;
  readonly requested: string;
  readonly bound: ThreadIncrementProgress | undefined;
  /**
   * SpecWeave's binding file for this thread, as read: where the thread's own
   * last write of an increment went. The progress reader drops it once its
   * folder is gone and may then pick another copy; a write never does.
   */
  readonly recorded?: { readonly root?: unknown; readonly incrementId?: unknown } | null;
}): Promise<Ownership> {
  const where = await resolveCallerWorkspace({
    worktreePath: input.worktreePath,
    folder: input.folder,
  });
  if (!where.ok) {
    if (where.reason !== "no-worktree") {
      return { ok: false, code: "invalid_request", message: where.message };
    }
    return denied(
      input.worktreePath === null
        ? "SpecWeave write tools change only a ledger inside the calling thread's own registered worktree, and this thread has none (it works in the project's shared folder). Use `specweave task claim|release|block` in your shell instead."
        : `This thread's worktree ${input.worktreePath} is missing on this machine. SpecWeave write tools change only a ledger inside it; restore or recreate it first.`,
    );
  }
  const bound = input.bound;
  if (bound === undefined) {
    return denied(
      `This thread has no increment assigned, so it may not change increment ${input.requested}. A thread owns an increment when it was launched with it (increment on delegate_task, create_threads or studio_thread_launch), it was linked on the thread's plan card, the thread wrote its spec, or it already claimed one of its tasks from its own shell.`,
    );
  }
  if (!ASSIGNING_BINDINGS.has(bound.binding)) {
    return denied(
      `This thread's increment ${bound.incrementId} is only guessed from its ${bound.binding === "name" ? "title or branch name" : "session checkpoint"}, which does not make it the owner. Link the increment on the thread's plan card, or launch the thread with increment set.`,
    );
  }
  if (
    bound.binding === "branch" &&
    !branchNamesIncrement(input.branch ?? null, bound.incrementId)
  ) {
    return denied(
      `This thread's increment ${bound.incrementId} is only guessed from a ledger line that names its branch, which does not make it the owner. Link the increment on the thread's plan card, or launch the thread with increment set.`,
    );
  }
  if (!namesIncrement(input.requested, bound.incrementId)) {
    return denied(
      `This thread owns increment ${bound.incrementId}, not ${input.requested}. SpecWeave write tools change only the calling thread's own increment; whoever owns ${input.requested} changes it.`,
    );
  }
  // The bound copy's root is read from the recorded path, never from where a
  // link in it leads: `<root>/.specweave/increments/<id>` must be that very
  // folder, with no link on the way, or the copy is refused.
  const boundDir = await realPath(bound.incrementPath);
  // A binding recorded inside the worktree (by path, or by where it leads)
  // must be valid as it stands; only one recorded outside it, in the shared
  // project folder, falls back to the worktree's own copy.
  const recordedInside =
    isInside(where.workspace, bound.incrementPath) ||
    (input.worktreePath !== null && isInside(input.worktreePath, bound.incrementPath)) ||
    (boundDir !== null && isInside(where.workspace, boundDir));
  let specweaveRoot: string;
  if (recordedInside) {
    const recordedRoot = NodePath.dirname(NodePath.dirname(NodePath.dirname(bound.incrementPath)));
    const root = await realPath(recordedRoot);
    const expected =
      root === null ? null : NodePath.join(root, ".specweave", "increments", bound.incrementId);
    if (
      root === null ||
      boundDir === null ||
      !isInside(where.workspace, boundDir) ||
      NodePath.basename(bound.incrementPath) !== bound.incrementId ||
      boundDir !== expected
    ) {
      return denied(
        `${bound.incrementPath} leads to ${boundDir ?? "nowhere"}, not to increment ${bound.incrementId}'s own folder under ${recordedRoot}. SpecWeave write tools write only to the increment's own folder.`,
      );
    }
    const nested = await resolveCallerWorkspace({ worktreePath: input.worktreePath, folder: root });
    if (!nested.ok) return denied(nested.message);
    specweaveRoot = nested.specweaveRoot;
  } else {
    const home =
      input.folder === undefined
        ? where
        : await resolveCallerWorkspace({ worktreePath: input.worktreePath });
    if (!home.ok) return denied(home.message);
    specweaveRoot = home.specweaveRoot;
  }
  const recorded = input.recorded;
  if (
    recorded !== undefined &&
    recorded !== null &&
    typeof recorded.root === "string" &&
    recorded.incrementId === bound.incrementId
  ) {
    const recordedRoot = await realPath(recorded.root);
    // The recorded root's place below the real worktree, from its path alone.
    const below = await placeBelow(where.workspace, recorded.root);
    const inside =
      below !== null || (recordedRoot !== null && isInside(where.workspace, recordedRoot));
    const recordedCopy =
      recordedRoot === null
        ? null
        : await realPath(
            NodePath.join(recordedRoot, ".specweave", "increments", bound.incrementId),
          );
    const problem =
      recordedCopy === null
        ? "that copy is gone"
        : below === null || (await linkOnTheWay(where.workspace, below))
          ? `${recorded.root} now leads to ${recordedRoot} through a link`
          : recordedRoot !== specweaveRoot
            ? `that is not the copy in ${specweaveRoot}`
            : null;
    if (inside && problem !== null) {
      return denied(
        `This thread last wrote increment ${bound.incrementId} in ${recorded.root}, and ${problem}. SpecWeave write tools never switch to another copy of the increment; restore that copy, or use \`specweave task claim|release|block\` in your shell.`,
      );
    }
  }
  if (input.folder !== undefined && where.specweaveRoot !== specweaveRoot) {
    return denied(
      `${input.folder} holds another copy than this thread's increment ${bound.incrementId}, which is in ${specweaveRoot}. Leave folder out; SpecWeave write tools change only that copy.`,
    );
  }
  const paths = await ledgerPathsInside({
    workspace: where.workspace,
    specweaveRoot,
    incrementId: bound.incrementId,
  });
  if (!paths.ok) return denied(paths.message);
  return {
    ok: true,
    target: {
      workspace: where.workspace,
      specweaveRoot,
      incrementId: bound.incrementId,
      incrementDir: paths.incrementDir,
    },
  };
}

/** Checks a decided target again, just before the write, under the increment's lock. */
export async function recheckTarget(target: LedgerTarget): Promise<Ownership> {
  const paths = await ledgerPathsInside(target);
  if (!paths.ok) return denied(paths.message);
  if (paths.incrementDir !== target.incrementDir) {
    return denied(`${target.incrementDir} moved since this call checked it. Try again.`);
  }
  return { ok: true, target };
}
