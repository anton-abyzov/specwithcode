import {
  type EnvironmentId,
  isProjectCoordinatorThreadId,
  type OrchestrationV2ThreadProjectMoveLink,
  type ProjectId,
  type ThreadExecutionRecord,
  type ThreadId,
} from "@specweave-studio/contracts";
import {
  threadRuntimeCanArchive,
  type EnvironmentThreadShell,
} from "@specweave-studio/client-runtime/state/models";

import {
  projectPickerMembers,
  type ProjectListMember,
  type ScratchRootLookup,
} from "../studio/projectListVisibility";

type MovableThread = Pick<
  EnvironmentThreadShell,
  "environmentId" | "id" | "projectId" | "movedTo" | "runtime"
>;

/**
 * Why the thread cannot move to another project, or null when it can. The
 * server checks the same rules again when the move runs.
 */
export function threadMoveBlockedReason(
  thread: MovableThread,
  project:
    | {
        readonly id: ProjectId;
        readonly workspaceSettings?:
          | { readonly coordinatorThreadId?: string | null | undefined }
          | null
          | undefined;
      }
    | undefined,
): string | null {
  if (thread.movedTo != null) return `Already moved to "${thread.movedTo.title}".`;
  const coordinatorThreadId = project?.workspaceSettings?.coordinatorThreadId;
  if (
    isProjectCoordinatorThreadId(thread.id, {
      id: project?.id ?? thread.projectId,
      ...(coordinatorThreadId === undefined ? {} : { workspaceSettings: { coordinatorThreadId } }),
    })
  ) {
    return "A project's coordinator stays with its project.";
  }
  return null;
}

/** Projects the thread can move to: the same machine's main project list, minus its own. */
export function threadMoveTargets<M extends ProjectListMember>(
  thread: MovableThread,
  projects: ReadonlyArray<M>,
  scratchRootFor: ScratchRootLookup,
): M[] {
  return projectPickerMembers(
    projects.filter(
      (project) =>
        project.environmentId === thread.environmentId && project.id !== thread.projectId,
    ),
    scratchRootFor,
  );
}

/**
 * Whether the new thread should start working right away. Work that was still
 * running is restarted; a thread the user had stopped or that had finished waits
 * for them, so cancelled work never resumes on its own.
 */
export function threadMoveStartsByDefault(thread: MovableThread): boolean {
  return !threadRuntimeCanArchive(thread.runtime) || thread.runtime?.status === "queued";
}

/** The banner on a thread that moved or arrived: what happened and the thread at the other end. */
export interface ThreadMoveBanner {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly actionLabel: string;
  readonly target: { readonly environmentId: EnvironmentId; readonly threadId: ThreadId };
  /** The other end is archived (a project move's original): open it once restored. */
  readonly targetArchived: boolean;
}

type BannerThread = {
  readonly environmentId: EnvironmentId;
  readonly id: ThreadId;
  readonly movedTo?: OrchestrationV2ThreadProjectMoveLink | null | undefined;
  readonly movedFrom?: OrchestrationV2ThreadProjectMoveLink | null | undefined;
  readonly execution?: ThreadExecutionRecord | null | undefined;
};

const MOVED_TO = "thread-moved-to:";
/** ChatView's banner for a source fenced by the heartbeat, before any move link is recorded. */
export const HANDOFF_CONTINUED = "thread-handoff-continued:";

/**
 * Whether a move banner (by its id) is the one on a thread whose work moved
 * away: that thread is read-only here, so a usage limit it stopped on is no
 * longer its to recover from, and the move banner leads instead.
 */
export function movedAwayBanner(id: string | null | undefined): boolean {
  return id?.startsWith(MOVED_TO) === true || id?.startsWith(HANDOFF_CONTINUED) === true;
}

/** "Minis", or a plain name when the other end runs on this machine. */
const machineOf = (
  thread: BannerThread,
  environmentId: EnvironmentId | undefined,
  label: string | undefined,
) =>
  environmentId === undefined || environmentId === thread.environmentId
    ? null
    : (label ?? "another machine");

const sentence = (text: string) => (/[.!?…]$/.test(text) ? text : `${text}.`);

/**
 * The move banner for `thread`, or null when it neither moved nor arrived.
 * A project move archives the source and starts fresh; a handoff keeps the
 * source readable (it only refuses new turns) and continues the work with
 * its files and a note, so its banner names the machine and links there.
 * A continuation 0967 created without a target link is told by where its
 * execution came from.
 */
export function threadMoveBanner(
  thread: BannerThread,
  projectTitle: (projectId: ProjectId) => string | undefined,
): ThreadMoveBanner | null {
  const movedTo = thread.movedTo ?? null;
  if (movedTo !== null) {
    const target = {
      environmentId: movedTo.environmentId ?? thread.environmentId,
      threadId: movedTo.threadId,
    };
    if (movedTo.kind === "handoff") {
      const machine = machineOf(thread, movedTo.environmentId, movedTo.machineLabel);
      const readOnly =
        machine === null
          ? "You can read it here. New messages go to the new thread."
          : `You can read it here. New messages go to ${machine}.`;
      return {
        id: `${MOVED_TO}${thread.id}`,
        title: machine === null ? "Continued in a new thread" : `Moved to ${machine}`,
        description:
          movedTo.note === undefined ? readOnly : `${sentence(movedTo.note)} ${readOnly}`,
        actionLabel: machine === null ? "Open new thread" : `Open on ${machine}`,
        target,
        targetArchived: false,
      };
    }
    return {
      id: `${MOVED_TO}${thread.id}`,
      title: `Moved to ${projectTitle(movedTo.projectId) ?? "another project"}`,
      description:
        "This thread was stopped and archived. Its work restarted there as a new thread; this one takes no new messages.",
      actionLabel: "Open new thread",
      target,
      targetArchived: false,
    };
  }
  const movedFrom = thread.movedFrom ?? null;
  if (movedFrom !== null && movedFrom.kind !== "handoff") {
    return {
      id: `thread-moved-from:${thread.id}`,
      title: `Moved here from ${projectTitle(movedFrom.projectId) ?? "another project"}`,
      description: "A fresh start: no conversation, files or memory came from the original thread.",
      actionLabel: "Find original",
      target: {
        environmentId: movedFrom.environmentId ?? thread.environmentId,
        threadId: movedFrom.threadId,
      },
      targetArchived: true,
    };
  }
  const origin =
    movedFrom !== null
      ? {
          environmentId: movedFrom.environmentId,
          label: movedFrom.machineLabel,
          threadId: movedFrom.threadId,
          note: movedFrom.note,
        }
      : thread.execution?.sourceRoot != null && thread.execution.sourceRoot.threadId !== thread.id
        ? {
            environmentId: thread.execution.sourceRoot.environmentId,
            label: thread.execution.sourceRoot.machineLabel,
            threadId: thread.execution.sourceRoot.threadId,
            note: undefined,
          }
        : null;
  if (origin === null) return null;
  const machine = machineOf(thread, origin.environmentId, origin.label);
  const carried =
    machine === null
      ? "Its conversation and file changes came from the original thread's last sync."
      : `Its conversation and file changes came from ${machine}'s last sync.`;
  return {
    id: `thread-moved-from:${thread.id}`,
    title:
      machine === null ? "Continued here from another thread" : `Continued here from ${machine}`,
    description: origin.note === undefined ? carried : `${sentence(origin.note)} ${carried}`,
    actionLabel: "Open original",
    target: {
      environmentId: origin.environmentId ?? thread.environmentId,
      threadId: origin.threadId,
    },
    targetArchived: false,
  };
}
