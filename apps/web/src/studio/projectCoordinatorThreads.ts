/**
 * A project's coordinator is its main conversation: the project page shows it in
 * the main column and nowhere else. These rules tell a coordinator thread apart
 * from the project's other threads, so no link, list or URL puts it in the
 * right panel beside itself.
 */

/** How the host names a project's coordinator thread when it starts one. */
const COORDINATOR_THREAD_PREFIX = "project-coordinator:";

/** A project's orchestrator is opened from its project row, not listed as a chat. */
export function isOrchestratorThreadId(id: string): boolean {
  return id.startsWith(COORDINATOR_THREAD_PREFIX);
}

/**
 * - `current`: the coordinator the project page shows in its main column.
 * - `previous`: a coordinator this project had before its settings named another
 *   one. It is not the conversation on screen, so it opens full page, where its
 *   own history is; it is never shown in the right panel.
 *
 * A coordinator of another checkout (another machine) lives in another
 * environment, so the panel already sends it full page on that machine.
 */
export type ProjectCoordinatorRole = "current" | "previous";

export interface ProjectCoordinatorScope {
  readonly projectId: string;
  /** The project's saved coordinator; null until one starts or the settings load. */
  readonly coordinatorThreadId: string | null;
}

/** Which coordinator `threadId` is for the project, or null for any other thread. */
export function projectCoordinatorRole(
  threadId: string,
  scope: ProjectCoordinatorScope,
): ProjectCoordinatorRole | null {
  if (scope.coordinatorThreadId !== null)
    return threadId === scope.coordinatorThreadId
      ? "current"
      : isOrchestratorThreadId(threadId)
        ? "previous"
        : null;
  // Before the settings name one, the id the host gives a new coordinator is
  // taken for the current one, so it never flashes into the panel meanwhile.
  return threadId === `${COORDINATOR_THREAD_PREFIX}${scope.projectId}`
    ? "current"
    : isOrchestratorThreadId(threadId)
      ? "previous"
      : null;
}

/** True for any coordinator thread of the project, current or previous. */
export function isProjectCoordinatorThread(
  threadId: string,
  scope: ProjectCoordinatorScope,
): boolean {
  return projectCoordinatorRole(threadId, scope) !== null;
}

/**
 * Why the coordinator needs its own full page now. The project page shows the
 * coordinator's conversation, but its approval, question, plan and run controls
 * live only on the coordinator's own page (/$environmentId/$threadId). While the
 * coordinator waits on the person, the page offers that page, never the panel.
 */
export interface CoordinatorAttention {
  readonly reason: "approval" | "input" | "plan" | "held" | "failed";
  /** What the page says about it. */
  readonly message: string;
  /** The button that opens the coordinator's own page. */
  readonly action: string;
}

const ACTIVE_RUNTIME_STATUSES: ReadonlySet<string> = new Set([
  "preparing",
  "starting",
  "running",
  "waiting",
]);

export function coordinatorAttention(
  coordinator: {
    readonly hasPendingApprovals: boolean;
    readonly hasPendingUserInput: boolean;
    readonly hasActionableProposedPlan: boolean;
    readonly runtime: { readonly status: string } | null;
    /** Messages waiting in the coordinator's held queue; absent when none. */
    readonly heldQueuedCount?: number;
  } | null,
): CoordinatorAttention | null {
  if (!coordinator) return null;
  if (coordinator.hasPendingApprovals)
    return {
      reason: "approval",
      message: "The coordinator is waiting for your approval.",
      action: "Review the request",
    };
  if (coordinator.hasPendingUserInput)
    return {
      reason: "input",
      message: "The coordinator asked you a question.",
      action: "Answer the coordinator",
    };
  if (coordinator.hasActionableProposedPlan)
    return {
      reason: "plan",
      message: "The coordinator has a plan ready for you.",
      action: "Review the plan",
    };
  const held = coordinator.heldQueuedCount ?? 0;
  // Its own page shows the held queue with Resume and Discard.
  if (held > 0 && !ACTIVE_RUNTIME_STATUSES.has(coordinator.runtime?.status ?? "idle"))
    return {
      reason: "held",
      message: `${held} message${held === 1 ? " to the coordinator is" : "s to the coordinator are"} held and not delivered.`,
      action: "Resume or discard them",
    };
  if (coordinator.runtime?.status === "failed")
    return {
      reason: "failed",
      message: "The coordinator's last run failed.",
      action: "Open the coordinator thread",
    };
  return null;
}
