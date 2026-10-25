/**
 * "Connect to a project" for one window: which projects a Playground design
 * can move into, whether its thread can follow, the dialog and the move. The
 * gallery and the editor share it; each says what happens once it moved.
 */
import { squashAtomCommandFailure } from "@specweave-studio/client-runtime/state/runtime";
import {
  AuthOrchestrationOperateScope,
  DesignError,
  type DesignId,
  type DesignMoveInput,
  type DesignSummary,
  type DesignThreadBinding,
  type EnvironmentId,
  type ProjectId,
} from "@specweave-studio/contracts";
import * as Schema from "effect/Schema";
import { useCallback, useMemo, useRef, useState, type ReactNode } from "react";

import { useScratchProject } from "~/hooks/useScratchProject";
import { useClientSettings } from "~/hooks/useSettings";
import { newThreadId } from "~/lib/utils";
import {
  deriveLogicalProjectKeyFromSettings,
  selectProjectGroupingSettings,
} from "~/logicalProject";
import { useProjects, useServerConfigs, useThreadShells } from "~/state/entities";
import { useEnvironmentQuery } from "~/state/query";
import { useEnvironmentScope } from "~/state/session";
import { threadEnvironment } from "~/state/threads";
import { useAtomCommand } from "~/state/use-atom-command";
import { useOrchestrationCommand } from "~/state/use-orchestration-command";
import { design } from "~/studio/design";
import { isScratchMember, projectPickerMembers } from "~/studio/projectListVisibility";

import { toastManager } from "../../ui/toast";
import { withoutMissingFolders } from "./boardOwner";
import { ConnectToProjectDialog } from "./ConnectToProjectDialog";
import type { GalleryProject } from "./DesignActions";
import { designRoute, type DesignRoute } from "./designLinks";
import {
  connectDesign,
  type MoveOutcome,
  type Outcome,
  type ThreadMoveRequest,
} from "./designMenuActions";
import { byRecentActivity } from "./galleryModel";

const isDesignError = Schema.is(DesignError);

const failureMessage = (cause: unknown, fallback: string) =>
  cause instanceof Error && cause.message.trim() !== "" ? cause.message : fallback;

/** The design to connect, as a gallery card or the open editor knows it. */
export interface ConnectSubject {
  readonly designId: DesignId;
  readonly title: string;
  readonly hasDesignSystem: boolean;
  readonly thread: DesignThreadBinding | null;
  /** The saved revision to move, read when Move is pressed. */
  readonly revision: () => number;
}

export function connectSubjectOf(summary: DesignSummary): ConnectSubject {
  return {
    designId: summary.ref.designId,
    title: summary.title,
    hasDesignSystem: summary.designSystem !== null,
    thread: summary.thread ?? null,
    revision: () => summary.revision,
  };
}

export interface ConnectedDesign {
  /** The design's new editor route; its id is unchanged. */
  readonly route: DesignRoute;
  readonly project: GalleryProject;
}

/**
 * `available` is false unless this machine's server moves designs and the
 * window is the owner's; `request` opens the dialog and `dialog` renders it.
 */
export function useConnectDesign({
  environmentId,
  owner,
  designs,
  onMoved,
}: {
  readonly environmentId: EnvironmentId | null;
  /** The owner's window on the design's machine; only the owner moves designs. */
  readonly owner: boolean;
  /** Orders the projects by their latest design edit, when the caller has the list. */
  readonly designs?: readonly DesignSummary[] | undefined;
  readonly onMoved: (moved: ConnectedDesign) => void;
}): {
  readonly available: boolean;
  readonly request: (subject: ConnectSubject, projectId?: ProjectId) => void;
  readonly dialog: ReactNode;
} {
  const configs = useServerConfigs();
  const capabilities =
    environmentId === null ? undefined : configs.get(environmentId)?.environment.capabilities;
  const canOperate = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  const allProjects = useProjects();
  const threads = useThreadShells();
  const { scratchWorkspaceRootFor } = useScratchProject();
  const grouping = useClientSettings(selectProjectGroupingSettings);
  const move = useAtomCommand(design.move, { reportFailure: false });
  const moveToProject = useOrchestrationCommand(threadEnvironment.moveToProject, {
    reportFailure: false,
  });

  // The same list the gallery reads; its problems say which project folders are gone.
  const listed = useEnvironmentQuery(
    environmentId === null
      ? null
      : design.list({ environmentId, input: { filter: { kind: "all" } } }),
  );
  const listProblems = listed.data?.problems;

  // The person's own projects on this machine: never its "No project" folder, an
  // archived project, one a check made for itself or one whose folder is missing.
  const projects = useMemo(
    () =>
      byRecentActivity(
        withoutMissingFolders(
          projectPickerMembers(
            allProjects.filter((project) => project.environmentId === environmentId),
            scratchWorkspaceRootFor,
            { purpose: "design" },
          ),
          listProblems ?? [],
        ).map((project): GalleryProject => ({
          id: project.id,
          title: project.title,
          projectKey: deriveLogicalProjectKeyFromSettings(project, grouping),
          icon: project,
          updatedAt: project.updatedAt,
        })),
        designs ?? [],
      ),
    [allProjects, designs, environmentId, grouping, listProblems, scratchWorkspaceRootFor],
  );

  /** The design's thread when it has no project on this machine and the server can move it. */
  const movableThread = (binding: DesignThreadBinding | null) => {
    if (binding === null || binding.environmentId !== environmentId) return null;
    if (capabilities?.threadProjectMove !== true || !canOperate) return null;
    const shell = threads.find(
      (thread) => thread.environmentId === binding.environmentId && thread.id === binding.threadId,
    );
    if (shell === undefined || shell.movedTo !== null) return null;
    const home = allProjects.find(
      (project) => project.environmentId === shell.environmentId && project.id === shell.projectId,
    );
    return home !== undefined && isScratchMember(home, scratchWorkspaceRootFor)
      ? { threadId: shell.id, title: shell.title }
      : null;
  };

  const [pending, setPending] = useState<{
    readonly subject: ConnectSubject;
    readonly projectId: ProjectId | null;
    readonly key: number;
  } | null>(null);
  const opened = useRef(0);
  // After a conflict, Retry moves the revision now on disk, which the dialog just named.
  const latestRevision = useRef<number | null>(null);
  const request = useCallback((subject: ConnectSubject, projectId?: ProjectId) => {
    opened.current += 1;
    latestRevision.current = null;
    setPending({ subject, projectId: projectId ?? null, key: opened.current });
  }, []);

  const available = owner && capabilities?.designMove === true;
  if (environmentId === null || !available) return { available: false, request, dialog: null };

  const runMove = async (input: DesignMoveInput): Promise<MoveOutcome> => {
    const result = await move({ environmentId, input });
    if (result._tag === "Success") return { ok: true, value: { ref: result.value.ref } };
    const cause = squashAtomCommandFailure(result);
    // A stale revision can be retried; any other conflict (already moved elsewhere) is said as is.
    if (isDesignError(cause) && cause.code === "conflict" && cause.currentRevision !== undefined)
      return {
        ok: false,
        message: "The design changed while you were choosing. Retry moves its latest version.",
        currentRevision: cause.currentRevision,
      };
    return { ok: false, message: failureMessage(cause, "The design was not moved.") };
  };

  const runThreadMove = async (input: ThreadMoveRequest): Promise<Outcome<unknown>> => {
    const result = await moveToProject({ environmentId, input });
    return result._tag === "Success"
      ? { ok: true, value: result.value }
      : {
          ok: false,
          message: failureMessage(squashAtomCommandFailure(result), "The thread was not moved."),
        };
  };

  const reportThreadProblem = (
    thread: ThreadMoveRequest,
    project: GalleryProject,
    problem: string,
  ): void => {
    toastManager.add({
      type: "error",
      title: "The design moved, but its thread did not",
      description: problem,
      actionProps: {
        children: "Retry",
        onClick: () =>
          void runThreadMove(thread).then((outcome) => {
            if (outcome.ok)
              toastManager.add({ type: "success", title: `Thread moved to ${project.title}` });
            else reportThreadProblem(thread, project, outcome.message);
          }),
      },
    });
  };

  let dialog: ReactNode = null;
  if (pending !== null) {
    const { subject } = pending;
    const thread = movableThread(subject.thread);
    dialog = (
      <ConnectToProjectDialog
        key={pending.key}
        title={subject.title}
        projects={projects}
        initialProjectId={pending.projectId}
        thread={thread}
        hasDesignSystem={subject.hasDesignSystem}
        onClose={() => setPending(null)}
        onMove={async (projectId, alsoMoveThread) => {
          const project = projects.find((candidate) => candidate.id === projectId);
          if (project === undefined) return "Choose a project.";
          const result = await connectDesign(
            { move: runMove, moveThread: runThreadMove, newThreadId },
            {
              designId: subject.designId,
              expectedRevision: latestRevision.current ?? subject.revision(),
              projectId,
              threadId: alsoMoveThread && thread !== null ? thread.threadId : null,
            },
          );
          if (!result.ok) {
            if (result.currentRevision !== undefined)
              latestRevision.current = result.currentRevision;
            return result.message;
          }
          if (result.thread !== null && result.threadProblem !== null)
            reportThreadProblem(result.thread, project, result.threadProblem);
          setPending(null);
          onMoved({
            route: designRoute({ kind: "project", projectId }, subject.designId),
            project,
          });
          return null;
        }}
      />
    );
  }
  return { available: true, request, dialog };
}
