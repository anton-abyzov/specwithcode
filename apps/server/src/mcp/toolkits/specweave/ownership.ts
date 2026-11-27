// @effect-diagnostics nodeBuiltinImport:off - Resolves real paths so a link cannot lead a ledger write outside the worktree.
/**
 * Whose ledger a SpecWeave write tool may touch (1497): the calling thread's
 * own increment, inside its own registered worktree, and nothing else.
 *
 * The increment is the one the thread's plan card follows
 * (ThreadIncrementProgressService), but only through a binding someone gave
 * it or it made itself: a link made by hand, the seed a launch with
 * `increment` writes, the thread's own ledger write or worktree branch, or a
 * spec the thread wrote (reported as `claim`). A number in the title or a
 * session checkpoint is a guess and does not count. Nobody's role matters: a
 * coordinator is held to the same rules.
 *
 * Every file the CLI writes must resolve inside the real worktree, so an
 * `increments` folder or ledger linked into another checkout is refused.
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

/** The files `specweave task claim|release|block` writes in the increment folder. */
export const LEDGER_FILES = ["ledger.jsonl", "metadata.json"] as const;

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
 * The increment folder and the files the CLI writes there, checked to resolve
 * inside the worktree. A file that does not exist yet is fine (the CLI creates
 * `ledger.jsonl` on the first event) unless a dangling link stands in its place.
 */
export async function ledgerPathsInside(input: {
  readonly workspace: string;
  readonly specweaveRoot: string;
  readonly incrementId: string;
}): Promise<
  | { readonly ok: true; readonly incrementDir: string }
  | { readonly ok: false; readonly message: string }
> {
  const folder = NodePath.join(input.specweaveRoot, ".specweave", "increments", input.incrementId);
  const incrementDir = await realPath(folder);
  if (incrementDir === null) {
    return {
      ok: false,
      message: `Increment ${input.incrementId} is not in this thread's worktree (${input.specweaveRoot}). SpecWeave write tools change only the copy inside the thread's own worktree.`,
    };
  }
  if (!isInside(input.workspace, incrementDir)) {
    return {
      ok: false,
      message: `${folder} leads outside this thread's worktree ${input.workspace}. SpecWeave write tools change only files inside it.`,
    };
  }
  for (const name of LEDGER_FILES) {
    const file = NodePath.join(incrementDir, name);
    const real = await realPath(file);
    if (real === null) {
      // Missing is fine; a link that points nowhere is not.
      if ((await lstatOrNull(file)) === null) continue;
      return { ok: false, message: `${file} is a link that points nowhere. Fix it first.` };
    }
    if (!isInside(input.workspace, real)) {
      return {
        ok: false,
        message: `${file} leads outside this thread's worktree ${input.workspace}. SpecWeave write tools change only files inside it.`,
      };
    }
  }
  return { ok: true, incrementDir };
}

/**
 * Decides whether the caller owns `requested`. `bound` is the caller's entry
 * from the plan-card read, or undefined when nothing binds it.
 */
export async function decideOwnership(input: {
  readonly worktreePath: string | null;
  readonly folder?: string | undefined;
  readonly requested: string;
  readonly bound: ThreadIncrementProgress | undefined;
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
  if (!namesIncrement(input.requested, bound.incrementId)) {
    return denied(
      `This thread owns increment ${bound.incrementId}, not ${input.requested}. SpecWeave write tools change only the calling thread's own increment; whoever owns ${input.requested} changes it.`,
    );
  }
  // The bound copy, when it lies inside the worktree (a nested SpecWeave
  // folder included); otherwise the copy in the folder the caller named.
  const boundDir = await realPath(bound.incrementPath);
  let specweaveRoot = where.specweaveRoot;
  if (input.folder === undefined && boundDir !== null && isInside(where.workspace, boundDir)) {
    const root = NodePath.dirname(NodePath.dirname(NodePath.dirname(boundDir)));
    const nested = await resolveCallerWorkspace({
      worktreePath: input.worktreePath,
      folder: root,
    });
    if (nested.ok) specweaveRoot = nested.specweaveRoot;
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
