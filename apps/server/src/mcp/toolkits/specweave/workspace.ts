// @effect-diagnostics nodeBuiltinImport:off - Resolves real paths so a link cannot lead a run outside the workspace.
/**
 * Where a SpecWeave tool reads (1483): the calling thread's registered
 * worktree, and nothing else. A thread without one (it works in the project's
 * shared folder) is refused, and so is a worktree that is recorded but
 * missing: neither is ever swapped for the project's checkout.
 */
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

export interface CallerWorkspaceInput {
  /** The thread's registered worktree, or null for a thread in the project folder. */
  readonly worktreePath: string | null;
  /** A folder the caller named, relative to the worktree or absolute. */
  readonly folder?: string | undefined;
}

export type CallerWorkspace =
  | {
      readonly ok: true;
      /** The thread's worktree, real path. */
      readonly workspace: string;
      /** The folder holding `.specweave/` that the CLI reads, real path. */
      readonly specweaveRoot: string;
    }
  | {
      readonly ok: false;
      readonly reason: "no-worktree" | "outside" | "no-specweave";
      readonly message: string;
    };

const realPath = (path: string) => NodeFSP.realpath(path).catch(() => null);

const isDirectory = (path: string) =>
  NodeFSP.stat(path).then(
    (stat) => stat.isDirectory(),
    () => false,
  );

/** True when `inner` is `outer` or inside it; both are real paths. */
export function isInside(outer: string, inner: string): boolean {
  const relative = NodePath.relative(outer, inner);
  return relative === "" || (!relative.startsWith("..") && !NodePath.isAbsolute(relative));
}

export async function resolveCallerWorkspace(
  input: CallerWorkspaceInput,
): Promise<CallerWorkspace> {
  const recorded = input.worktreePath;
  if (recorded === null) {
    return {
      ok: false,
      reason: "no-worktree",
      message:
        "SpecWeave tools read only a thread's own registered worktree, and this thread has none (it works in the project's shared folder). Run `specweave task list` in your shell instead.",
    };
  }
  const workspace = await realPath(recorded);
  if (workspace === null || !(await isDirectory(workspace))) {
    return {
      ok: false,
      reason: "no-worktree",
      message: `This thread's worktree ${recorded} is missing on this machine. SpecWeave tools read only the thread's own worktree; restore or recreate it first.`,
    };
  }
  let specweaveRoot = workspace;
  if (input.folder !== undefined) {
    const named = NodePath.resolve(workspace, input.folder);
    const real = await realPath(named);
    if (real === null || !isInside(workspace, real)) {
      return {
        ok: false,
        reason: "outside",
        message: `${input.folder} is not a folder inside this thread's worktree ${workspace}. SpecWeave tools read only there.`,
      };
    }
    specweaveRoot = real;
  }
  if (!(await isDirectory(NodePath.join(specweaveRoot, ".specweave")))) {
    return {
      ok: false,
      reason: "no-specweave",
      message: `${specweaveRoot} has no .specweave folder, so it is not a SpecWeave project. Name a folder inside the worktree that has one, or set SpecWeave up from the project's Board.`,
    };
  }
  return { ok: true, workspace, specweaveRoot };
}

/** Whether a thread is offered the SpecWeave tools: its worktree holds `.specweave/` itself. */
export async function workspaceHasSpecweave(input: CallerWorkspaceInput): Promise<boolean> {
  const resolved = await resolveCallerWorkspace({ ...input, folder: undefined });
  return resolved.ok;
}
