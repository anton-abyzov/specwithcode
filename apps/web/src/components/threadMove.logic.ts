import {
  type EnvironmentId,
  isProjectCoordinatorThreadId,
  type OrchestrationV2ThreadProjectMoveLink,
  type ProjectId,
  type ThreadExecutionRecord,
  type ThreadId,
} from "@specweave-studio/contracts";
import { isPersonalAssistantProject } from "@specweave-studio/shared/personalAssistant";
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
          | {
              readonly coordinatorThreadId?: string | null | undefined;
              readonly kind?: string | undefined;
            }
          | null
          | undefined;
      }
    | undefined,
): string | null {
  if (thread.movedTo != null) return `Already moved to "${thread.movedTo.title}".`;
  if (isPersonalAssistantProject(project)) return ASSISTANT_TOPIC_STAYS;
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

/** Why a topic of the personal assistant has no Move to project. */
export const ASSISTANT_TOPIC_STAYS =
  "Aide's topics stay private, so they cannot move to a project.";

/**
 * Projects the thread can move to: the same machine's main project list, minus its own.
 * A personal assistant is never a target, and its own topics move nowhere.
 */
export function threadMoveTargets<M extends ProjectListMember>(
  thread: MovableThread,
  projects: ReadonlyArray<M>,
  scratchRootFor: ScratchRootLookup,
): M[] {
  const source = projects.find(
    (project) => project.environmentId === thread.environmentId && project.id === thread.projectId,
  );
  if (isPersonalAssistantProject(source)) return [];
  return projectPickerMembers(
    projects.filter(
      (project) =>
        project.environmentId === thread.environmentId && project.id !== thread.projectId,
    ),
    scratchRootFor,
  );
}

/** What the move dialog needs to tell projects of one name apart. */
export interface MoveTargetProject {
  readonly environmentId: EnvironmentId;
  readonly id: ProjectId;
  readonly title: string;
  readonly workspaceRoot?: string | undefined;
  readonly workspaceSettings?:
    | {
        readonly logicalProject?:
          | {
              readonly title?: string | undefined;
              readonly members: ReadonlyArray<{
                readonly environmentId: EnvironmentId;
                readonly projectId: ProjectId;
              }>;
            }
          | null
          | undefined;
      }
    | null
    | undefined;
}

export interface MoveTargetLabel {
  readonly title: string;
  /** Shown muted after the title when another project has the same name; null otherwise. */
  readonly hint: string | null;
}

const isShared = (project: MoveTargetProject) =>
  (project.workspaceSettings?.logicalProject?.members ?? []).some(
    (member) => member.environmentId !== project.environmentId || member.projectId !== project.id,
  );
const nameKey = (title: string) => title.trim().toLowerCase();
const folderName = (root: string | undefined) =>
  root?.replaceAll("\\", "/").replace(/\/+$/u, "").split("/").findLast(Boolean) ?? null;

/**
 * Labels for the move dialog's projects. Two projects can share a name: the same
 * repository added on this machine on its own is listed next to the shared project
 * that spans several machines. Each row then says which one it is, "shared" or
 * "this machine only", and a folder name when that still leaves two alike.
 */
export function threadMoveTargetLabels(
  targets: ReadonlyArray<MoveTargetProject>,
  allProjects: ReadonlyArray<MoveTargetProject>,
): Map<string, MoveTargetLabel> {
  const sharedNames = new Set(
    allProjects.filter(isShared).map((project) => nameKey(titleOf(project))),
  );
  const counts = new Map<string, number>();
  for (const target of targets) {
    const key = nameKey(titleOf(target));
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const labels = new Map<string, MoveTargetLabel>();
  for (const target of targets) {
    const title = titleOf(target);
    const key = nameKey(title);
    const shared = isShared(target);
    const namesake = (counts.get(key) ?? 0) > 1 || (!shared && sharedNames.has(key));
    if (!namesake) {
      labels.set(target.id, { title, hint: null });
      continue;
    }
    const parts = [shared ? "shared" : "this machine only"];
    const folder = folderName(target.workspaceRoot);
    if ((counts.get(key) ?? 0) > 1 && folder !== null) parts.push(folder);
    labels.set(target.id, { title, hint: parts.join(" · ") });
  }
  return labels;
}

/** A shared project's name, as every machine shows it; else this copy's own. */
function titleOf(project: MoveTargetProject): string {
  return project.workspaceSettings?.logicalProject?.title?.trim() || project.title;
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
  machineName?: (environmentId: EnvironmentId, hostLabel?: string | null) => string,
) =>
  environmentId === undefined || environmentId === thread.environmentId
    ? null
    : machineName
      ? machineName(environmentId, label)
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
  /** The display name for a machine: its nickname when the user set one. */
  machineName?: (environmentId: EnvironmentId, hostLabel?: string | null) => string,
): ThreadMoveBanner | null {
  const movedTo = thread.movedTo ?? null;
  if (movedTo !== null) {
    const target = {
      environmentId: movedTo.environmentId ?? thread.environmentId,
      threadId: movedTo.threadId,
    };
    if (movedTo.kind === "handoff") {
      const machine = machineOf(thread, movedTo.environmentId, movedTo.machineLabel, machineName);
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
  const machine = machineOf(thread, origin.environmentId, origin.label, machineName);
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
