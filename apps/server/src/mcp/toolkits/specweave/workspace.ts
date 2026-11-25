// @effect-diagnostics nodeBuiltinImport:off - Resolves real paths so a link cannot lead a run outside the workspace.
/**
 * Where a SpecWeave tool runs (1483): the calling thread's own workspace, by
 * the rule its agent's session uses (`RuntimePolicy.ts`): the thread's
 * worktree when it has one, else the project folder. A worktree that is
 * recorded but missing is refused, never swapped for the project's checkout.
 */
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

export interface CallerWorkspaceInput {
  /** The thread's recorded worktree, or null for a thread in the project folder. */
  readonly worktreePath: string | null;
  /** The project's folder on this machine, or null when it is not here. */
  readonly projectRoot: string | null;
  /** A folder the caller named, relative to the workspace or absolute. */
  readonly folder?: string | undefined;
}

export type CallerWorkspace =
  | {
      readonly ok: true;
      /** The thread's workspace, real path. */
      readonly workspace: string;
      /** The folder holding `.specweave/` that the CLI runs in, real path. */
      readonly specweaveRoot: string;
      readonly kind: "worktree" | "project";
    }
  | {
      readonly ok: false;
      readonly reason: "no-workspace" | "outside" | "no-specweave";
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
  const kind = input.worktreePath !== null ? "worktree" : "project";
  const recorded = input.worktreePath ?? input.projectRoot;
  if (recorded === null) {
    return {
      ok: false,
      reason: "no-workspace",
      message: "This thread's project folder is not on this machine, so SpecWeave cannot run here.",
    };
  }
  const workspace = await realPath(recorded);
  if (workspace === null || !(await isDirectory(workspace))) {
    return {
      ok: false,
      reason: "no-workspace",
      message:
        kind === "worktree"
          ? `This thread's worktree ${recorded} is missing on this machine. SpecWeave tools run only in the thread's own worktree; restore or recreate it first.`
          : `This thread's project folder ${recorded} is missing on this machine.`,
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
        message: `${input.folder} is not a folder inside this thread's workspace ${workspace}. SpecWeave tools run only there.`,
      };
    }
    specweaveRoot = real;
  }
  if (!(await isDirectory(NodePath.join(specweaveRoot, ".specweave")))) {
    return {
      ok: false,
      reason: "no-specweave",
      message: `${specweaveRoot} has no .specweave folder, so it is not a SpecWeave project. Name a folder inside the workspace that has one, or set SpecWeave up from the project's Board.`,
    };
  }
  return { ok: true, workspace, specweaveRoot, kind };
}

/** Whether a workspace offers the SpecWeave tools: it holds `.specweave/` itself. */
export async function workspaceHasSpecweave(input: CallerWorkspaceInput): Promise<boolean> {
  const resolved = await resolveCallerWorkspace({ ...input, folder: undefined });
  return resolved.ok;
}
