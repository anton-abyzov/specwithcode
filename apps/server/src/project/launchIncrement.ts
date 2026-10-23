// @effect-diagnostics nodeBuiltinImport:off - Plain promises over the thread's SpecWeave folder, like ThreadIncrementProgress.
/**
 * The SpecWeave increment a launched thread (delegate_task, create_threads,
 * studio_thread_launch) works on, and what its brief says about it.
 *
 * `increment` is an open `NNNN`, a full folder name, `"new"` (plan one first)
 * or `"none"` (a small fix at most). Omitted, a worker inherits the caller's
 * own claim or branch binding; the coordinator never passes its own on. With
 * neither, the project's `planning.requireIncrement` decides: `enforce`
 * refuses a coordinator's launch, otherwise `remind` or `enforce` only warns.
 * An explicit ref that does not resolve refuses the launch before any thread
 * exists; a failed inheritance never blocks one. A binding is passed on only
 * where the new thread can read it: an increment in the caller's own worktree
 * stays behind when the new thread starts elsewhere.
 *
 * Plain functions over the file system, so the MCP services need no new
 * dependency and their test layers stay as they are.
 */
import * as NodeFSP from "node:fs/promises";

import type { ThreadId } from "@specweave-studio/contracts";

import { nodePath as NodePath } from "../nodePath.ts";
import { INCREMENTS_DIR } from "./ThreadReports.ts";
import {
  bindingRootAccepted,
  CLOSED_INCREMENT_STATES,
  incrementExists,
  incrementRootFor,
  readRequireIncrementMode,
  readThreadIncrementProgress,
  resolveIncrementRef,
  writeLaunchBinding,
  type ThreadIncrementSource,
} from "./ThreadIncrementProgress.ts";

const REF_HINT = 'an open NNNN, a full increment folder name, "new" or "none"';

/** The one sentence the orchestration block and the three launch tools carry. */
export const INCREMENT_LAUNCH_INSTRUCTION =
  'In a SpecWeave project, for feature work pass increment (NNNN, "new" or "none") to delegate_task, create_threads and studio_thread_launch; workers inherit yours when omitted; post the returned spec as [NNNN](<specPath>).';

export const ENFORCED_INCREMENT_MESSAGE =
  'This project requires an increment for each worker: pass increment (an open NNNN, "new", or "none").';
export const REMINDED_INCREMENT_MESSAGE =
  'This project asks for an increment for each worker: pass increment (an open NNNN, "new", or "none") next time.';

export interface LaunchIncrement {
  /** The checkout whose `.specweave/increments` holds it, as resolved before launch. */
  readonly root: string;
  readonly incrementId: string;
  readonly title: string | null;
  readonly specPath: string;
  /** The caller whose binding the worker inherited, when no ref was passed. */
  readonly inheritedFrom?: ThreadId;
}

export interface LaunchIncrementOutcome {
  /** The increment to seed and report; absent for "new", "none" and no increment. */
  readonly increment?: LaunchIncrement;
  /** The line the worker's brief ends with. */
  readonly brief?: string;
  readonly warning?: string;
}

export type LaunchIncrementResolution =
  | { readonly ok: true; readonly value: LaunchIncrementOutcome }
  | { readonly ok: false; readonly message: string };

/** A Markdown link destination that survives spaces and parentheses. */
function linkDestination(path: string): string {
  return /[\s()<>]/u.test(path) ? `<${path}>` : path;
}

function existingBrief(increment: { readonly incrementId: string; readonly specPath: string }) {
  return `Increment ${increment.incrementId} ([spec](${linkDestination(increment.specPath)})): run \`specweave pickup ${increment.incrementId}\` first.`;
}

function newBrief(title: string | undefined): string {
  const name = title?.replace(/["`\\]/gu, "").trim() || "<title>";
  return `Plan it first: \`specweave create-increment "${name}"\`, fill spec.md, then edit code.`;
}

export const NO_INCREMENT_BRIEF = 'If you change code, run `specweave small-fix "<why>"` first.';

/**
 * Whether a thread starting in `worktreePath` (null: the project) reads
 * `increment`: its checkout holds the folder, or `root` is one its plan card
 * and SpecWeave's edit guard accept for that thread.
 */
async function readableFrom(
  workspaceRoot: string,
  worktreePath: string | null,
  increment: { readonly root: string; readonly incrementId: string },
): Promise<"checkout" | "root" | null> {
  if (await incrementExists(workspaceRoot, worktreePath, increment.incrementId)) return "checkout";
  const root = await NodeFSP.realpath(increment.root).catch(() => null);
  const allowed = [workspaceRoot, ...(worktreePath === null ? [] : [worktreePath])];
  return root !== null && (await bindingRootAccepted(root, allowed)) ? "root" : null;
}

function notPassedOn(incrementId: string): string {
  return `Increment ${incrementId} was not passed on: the new thread's checkout does not have it. Pass increment to name one it has.`;
}

function fallbackWarning(incrementId: string): string {
  return `Increment ${incrementId} is in your worktree, not the project root: the new worktree has it only if its base branch does.`;
}

/** The caller's claim or branch binding, when it names an open increment; null on any failure. */
async function inheritedIncrement(
  workspaceRoot: string,
  caller: Omit<ThreadIncrementSource, "link">,
): Promise<LaunchIncrement | null> {
  try {
    const [progress] = await readThreadIncrementProgress(workspaceRoot, [caller]);
    if (
      progress === undefined ||
      (progress.binding !== "claim" && progress.binding !== "branch") ||
      CLOSED_INCREMENT_STATES.has(progress.status)
    ) {
      return null;
    }
    return {
      // incrementPath is <root>/.specweave/increments/<id>.
      root: NodePath.dirname(NodePath.dirname(NodePath.dirname(progress.incrementPath))),
      incrementId: progress.incrementId,
      title: progress.title,
      specPath: progress.specPath ?? progress.incrementPath,
      inheritedFrom: caller.threadId as ThreadId,
    };
  } catch {
    return null;
  }
}

/** Resolves a launch's `increment` (see the module comment). Never rejects. */
export async function resolveLaunchIncrement(input: {
  readonly workspaceRoot: string;
  /** The checkout the new thread starts in, as known before launch. */
  readonly worktreePath: string | null;
  /**
   * Where else an explicit ref may resolve when `worktreePath` lacks it: the
   * caller's worktree, for a new worktree not made yet (its base branch may
   * hold the increment). The seed re-roots it once the worktree exists.
   */
  readonly fallbackWorktreePath?: string | null;
  readonly ref: string | undefined;
  /** The new thread's title, named in the "new" brief. */
  readonly title?: string | undefined;
  /** The launching thread; null for a caller outside a thread or on another machine. */
  readonly caller: Omit<ThreadIncrementSource, "link"> | null;
  readonly isCoordinator: boolean;
}): Promise<LaunchIncrementResolution> {
  const ref = input.ref?.trim();
  if (ref === "none") return { ok: true, value: { brief: NO_INCREMENT_BRIEF } };
  if (ref === "new") return { ok: true, value: { brief: newBrief(input.title) } };
  try {
    if (ref !== undefined && ref !== "") {
      let resolved = await resolveIncrementRef(input.workspaceRoot, input.worktreePath, ref);
      const fallback = input.fallbackWorktreePath ?? null;
      let fellBack = false;
      if (resolved.kind === "not_found" && fallback !== null && fallback !== input.worktreePath) {
        const retried = await resolveIncrementRef(input.workspaceRoot, fallback, ref);
        if (retried.kind !== "not_found") {
          resolved = retried;
          fellBack = retried.kind === "found";
        }
      }
      switch (resolved.kind) {
        case "not_found":
          return {
            ok: false,
            message: `Increment "${ref}" was not found in ${resolved.root}/.specweave/increments. Pass ${REF_HINT}.`,
          };
        case "ambiguous":
          return {
            ok: false,
            message: `Increment number ${ref} matches more than one folder in ${resolved.root}/.specweave/increments; pass the full folder name.`,
          };
        case "closed":
          return {
            ok: false,
            message: `Increment ${resolved.incrementId} is ${resolved.status}. Pass an open increment, "new" for new work, or "none".`,
          };
        case "found": {
          const increment = {
            root: resolved.root,
            incrementId: resolved.incrementId,
            title: resolved.title,
            specPath: resolved.specPath,
          };
          return {
            ok: true,
            value: {
              increment,
              brief: existingBrief(increment),
              ...(fellBack ? { warning: fallbackWarning(increment.incrementId) } : {}),
            },
          };
        }
      }
    }
    // Only a SpecWeave project has increments to inherit or require.
    const root = await incrementRootFor(input.workspaceRoot, input.worktreePath);
    if (!(await hasIncrements(root))) return { ok: true, value: {} };
    const inherited =
      input.isCoordinator || input.caller === null
        ? null
        : await inheritedIncrement(input.workspaceRoot, input.caller);
    const readable =
      inherited === null
        ? null
        : await readableFrom(input.workspaceRoot, input.worktreePath, inherited);
    if (inherited !== null && readable !== null) {
      return { ok: true, value: { increment: inherited, brief: existingBrief(inherited) } };
    }
    const mode = await readRequireIncrementMode(input.workspaceRoot);
    if (mode === "enforce" && input.isCoordinator) {
      return { ok: false, message: ENFORCED_INCREMENT_MESSAGE };
    }
    const warnings = [
      ...(inherited === null ? [] : [notPassedOn(inherited.incrementId)]),
      ...(mode === "enforce"
        ? [ENFORCED_INCREMENT_MESSAGE]
        : mode === "remind"
          ? [REMINDED_INCREMENT_MESSAGE]
          : []),
    ];
    return { ok: true, value: warnings.length === 0 ? {} : { warning: warnings.join(" ") } };
  } catch {
    return { ok: true, value: {} };
  }
}

async function hasIncrements(root: string): Promise<boolean> {
  const stat = await NodeFSP.stat(NodePath.join(root, INCREMENTS_DIR)).catch(() => null);
  return stat?.isDirectory() ?? false;
}

/** The prompt with the increment line appended. */
export function withIncrementBrief(prompt: string, outcome: LaunchIncrementOutcome): string {
  if (outcome.brief === undefined) return prompt;
  return prompt.trim() === "" ? outcome.brief : `${prompt}\n\n${outcome.brief}`;
}

/** The `increment` and `warning` fields of a launch tool's result. */
export function launchIncrementFields(outcome: LaunchIncrementOutcome): {
  readonly increment?: {
    readonly incrementId: string;
    readonly title: string | null;
    readonly specPath: string;
    readonly inheritedFrom?: ThreadId;
  };
  readonly warning?: string;
} {
  const increment = outcome.increment;
  return {
    ...(increment === undefined
      ? {}
      : {
          increment: {
            incrementId: increment.incrementId,
            title: increment.title,
            specPath: increment.specPath,
            ...(increment.inheritedFrom === undefined
              ? {}
              : { inheritedFrom: increment.inheritedFrom }),
          },
        }),
    ...(outcome.warning === undefined ? {} : { warning: outcome.warning }),
  };
}

/**
 * Seeds a launched thread's binding once its checkout is known: the root is
 * that checkout when it holds the increment (a worktree with its own
 * `.specweave`), otherwise the root resolved before launch, but only when the
 * thread's plan card accepts that root (never another thread's worktree).
 * False when nothing was written. Never rejects.
 */
export async function seedLaunchBinding(input: {
  readonly threadId: string;
  readonly increment: { readonly root: string; readonly incrementId: string };
  readonly workspaceRoot: string;
  readonly worktreePath: string | null;
  readonly home?: string;
}): Promise<boolean> {
  try {
    const readable = await readableFrom(input.workspaceRoot, input.worktreePath, input.increment);
    if (readable === null) return false;
    const root =
      readable === "checkout"
        ? await incrementRootFor(input.workspaceRoot, input.worktreePath)
        : input.increment.root;
    return await writeLaunchBinding(
      input.threadId,
      { root, incrementId: input.increment.incrementId },
      input.home,
    );
  } catch {
    return false;
  }
}
