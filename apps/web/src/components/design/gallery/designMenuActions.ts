/**
 * Rename, Duplicate and Connect to a project from the design menu, over
 * injected `design.apply`, `design.copy`, `design.move` and thread-move calls
 * so the rules are tested without a server.
 */
import {
  CommandId,
  type DesignApplyInput,
  type DesignCopyInput,
  type DesignId,
  type DesignMoveInput,
  type DesignRef,
  type DesignSummary,
  type ProjectId,
  type ThreadId,
} from "@specweave-studio/contracts";

import { ownerInputOf } from "./galleryModel";

/** The longest title the contract accepts. */
export const DESIGN_TITLE_MAX = 180;

export type Outcome<A> =
  | { readonly ok: true; readonly value: A }
  | { readonly ok: false; readonly message: string };

/** Saves a new title at the revision the list showed; resolves to an error message or null. */
export async function renameDesign(
  apply: (input: DesignApplyInput) => Promise<Outcome<unknown>>,
  summary: DesignSummary,
  title: string,
): Promise<string | null> {
  const next = title.trim();
  if (next === "") return "Enter a title.";
  if (next.length > DESIGN_TITLE_MAX) return `Use at most ${DESIGN_TITLE_MAX} characters.`;
  if (next === summary.title) return null;
  const result = await apply({
    owner: ownerInputOf(summary),
    designId: summary.ref.designId,
    expectedRevision: summary.revision,
    operations: [{ op: "set_title", title: next }],
  });
  return result.ok ? null : result.message;
}

/** "Pricing page" becomes "Pricing page copy", cut so it stays within the title limit. */
export function duplicateTitle(title: string): string {
  const base = (title.trim() || "Untitled").slice(0, DESIGN_TITLE_MAX - " copy".length).trimEnd();
  return `${base} copy`;
}

export type DuplicateResult =
  | { readonly ok: false; readonly message: string }
  | {
      readonly ok: true;
      readonly ref: DesignRef;
      readonly title: string;
      /** Set when the copy exists but kept the original title. */
      readonly renameProblem: string | null;
    };

/** Copies a design into its own owner, then titles the copy "<title> copy". */
export async function duplicateDesign(
  calls: {
    readonly copy: (
      input: DesignCopyInput,
    ) => Promise<Outcome<{ readonly ref: DesignRef; readonly document: { revision: number } }>>;
    readonly apply: (input: DesignApplyInput) => Promise<Outcome<unknown>>;
  },
  summary: DesignSummary,
): Promise<DuplicateResult> {
  const owner = ownerInputOf(summary);
  const copied = await calls.copy({ owner, designId: summary.ref.designId, to: owner });
  if (!copied.ok) return copied;
  const title = duplicateTitle(summary.title);
  const renamed = await calls.apply({
    owner,
    designId: copied.value.ref.designId,
    expectedRevision: copied.value.document.revision,
    operations: [{ op: "set_title", title }],
  });
  return renamed.ok
    ? { ok: true, ref: copied.value.ref, title, renameProblem: null }
    : { ok: true, ref: copied.value.ref, title: summary.title, renameProblem: renamed.message };
}

/** What "Connect to a project" moves: a Playground design, and its thread when asked. */
export interface ConnectDesignRequest {
  readonly designId: DesignId;
  readonly expectedRevision: number;
  readonly projectId: ProjectId;
  /** The bound Scratch thread to move along, or null to leave it where it is. */
  readonly threadId: ThreadId | null;
}

/** One `thread.move-to-project`; a retry sends the same ids, so it resumes the same move. */
export interface ThreadMoveRequest {
  readonly commandId: CommandId;
  readonly threadId: ThreadId;
  readonly targetProjectId: ProjectId;
  /** A new id, as the command requires; adopting a Scratch thread keeps the original one. */
  readonly targetThreadId: ThreadId;
}

export type MoveOutcome =
  | { readonly ok: true; readonly value: { readonly ref: DesignRef } }
  | { readonly ok: false; readonly message: string; readonly currentRevision?: number };

export type ConnectDesignResult =
  | Extract<MoveOutcome, { ok: false }>
  | {
      readonly ok: true;
      readonly ref: DesignRef;
      /** The thread move that was sent, to retry with the same ids; null when none was. */
      readonly thread: ThreadMoveRequest | null;
      /** Why the thread did not move; the design moved anyway. */
      readonly threadProblem: string | null;
    };

export function threadMoveRequest(
  threadId: ThreadId,
  targetProjectId: ProjectId,
  targetThreadId: ThreadId,
): ThreadMoveRequest {
  return {
    commandId: CommandId.make(`move:${targetThreadId}`),
    threadId,
    targetProjectId,
    targetThreadId,
  };
}

/**
 * Moves a Playground design into a project, keeping its id, then moves its
 * Scratch thread there when asked. A failed move changes nothing; a thread
 * that does not follow leaves the design moved and returns the request to retry.
 */
export async function connectDesign(
  calls: {
    readonly move: (input: DesignMoveInput) => Promise<MoveOutcome>;
    readonly moveThread: (input: ThreadMoveRequest) => Promise<Outcome<unknown>>;
    readonly newThreadId: () => ThreadId;
  },
  request: ConnectDesignRequest,
): Promise<ConnectDesignResult> {
  const moved = await calls.move({
    owner: { kind: "playground" },
    designId: request.designId,
    to: { kind: "project", projectId: request.projectId },
    expectedRevision: request.expectedRevision,
  });
  if (!moved.ok) return moved;
  if (request.threadId === null)
    return { ok: true, ref: moved.value.ref, thread: null, threadProblem: null };
  const thread = threadMoveRequest(request.threadId, request.projectId, calls.newThreadId());
  const adopted = await calls.moveThread(thread);
  return {
    ok: true,
    ref: moved.value.ref,
    thread,
    threadProblem: adopted.ok ? null : adopted.message,
  };
}
