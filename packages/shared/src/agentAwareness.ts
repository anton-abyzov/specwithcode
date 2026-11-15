import {
  isProviderNativeSubagentThread,
  type EnvironmentId,
  type OrchestrationV2ThreadShell,
  type Project,
  type ThreadId,
} from "@specweave-studio/contracts";
import * as DateTime from "effect/DateTime";

import { backgroundWorkHoldsCompletion } from "./orchestrationV2PendingBackgroundWork.ts";

export type AgentAwarenessPhase =
  | "starting"
  | "running"
  | "waiting_for_approval"
  | "waiting_for_input"
  | "completed"
  | "failed"
  | "stale";

export interface AgentAwarenessState {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly projectTitle: string;
  readonly threadTitle: string;
  readonly phase: AgentAwarenessPhase;
  readonly headline: string;
  readonly detail?: string;
  readonly modelTitle: string;
  readonly updatedAt: string;
  readonly deepLink: string;
}

function buildAgentAwarenessDeepLink(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}): string {
  return `/threads/${encodeURIComponent(input.environmentId)}/${encodeURIComponent(input.threadId)}`;
}

export interface ProjectThreadAwarenessV2Input {
  readonly environmentId: EnvironmentId;
  readonly project: Pick<Project, "title">;
  readonly thread: Pick<
    OrchestrationV2ThreadShell,
    | "activityRunStatus"
    | "creationSource"
    | "id"
    | "lineage"
    | "modelSelection"
    | "pendingBackgroundTasks"
    | "pendingRuntimeRequest"
    | "status"
    | "title"
    | "updatedAt"
  >;
}

/**
 * The request kinds only the person can answer. A dynamic tool call is answered
 * by the app and a sign-in refresh by the account's own flow, so a worker
 * waiting on one of those is working, not waiting on the person.
 */
const PERSON_ANSWERED_REQUEST_KINDS: ReadonlySet<
  NonNullable<OrchestrationV2ThreadShell["pendingRuntimeRequest"]>["kind"]
> = new Set(["command", "file-read", "file-change", "permission", "mcp-elicitation", "user_input"]);

/**
 * A worker a coordinator delegated to that is stopped on the person: an
 * approval, a question, a secret or an access card. Only the person can
 * answer those, so the worker's own row reaches the owner like a top-level
 * thread's. A provider's own subagents ask through their parent thread.
 */
export function delegatedThreadAwaitsPerson(
  thread: Pick<OrchestrationV2ThreadShell, "creationSource" | "lineage" | "pendingRuntimeRequest">,
): boolean {
  const kind = thread.pendingRuntimeRequest?.kind;
  return (
    thread.lineage.relationshipToParent === "subagent" &&
    !isProviderNativeSubagentThread(thread) &&
    kind !== undefined &&
    PERSON_ANSWERED_REQUEST_KINDS.has(kind)
  );
}

/** Build relay activity directly from the V2 shell projection. */
export function projectThreadAwarenessV2(
  input: ProjectThreadAwarenessV2Input,
): AgentAwarenessState | null {
  const { environmentId, project, thread } = input;
  // A delegated worker that is merely working or done stays off the phone.
  if (thread.lineage.relationshipToParent === "subagent" && !delegatedThreadAwaitsPerson(thread))
    return null;
  const phase = resolveThreadAwarenessPhaseV2(thread);
  if (phase === null) {
    return null;
  }
  const detail =
    phase === "completed"
      ? "Review the completed task."
      : phase === "failed"
        ? "The agent run failed."
        : undefined;
  return {
    environmentId,
    threadId: thread.id,
    projectTitle: project.title,
    threadTitle: thread.title,
    phase,
    headline: headlineForPhase(phase),
    ...(detail === undefined ? {} : { detail }),
    modelTitle: thread.modelSelection.model,
    updatedAt: DateTime.formatIso(thread.updatedAt),
    deepLink: buildAgentAwarenessDeepLink({ environmentId, threadId: thread.id }),
  };
}

function resolveThreadAwarenessPhaseV2(
  thread: ProjectThreadAwarenessV2Input["thread"],
): AgentAwarenessPhase | null {
  if (thread.pendingRuntimeRequest?.kind === "user_input") {
    return "waiting_for_input";
  }
  if (
    thread.pendingRuntimeRequest !== null &&
    thread.pendingRuntimeRequest.kind !== "auth_refresh"
  ) {
    return "waiting_for_approval";
  }
  switch (thread.activityRunStatus ?? thread.status) {
    case "preparing":
    case "starting":
      return "starting";
    case "running":
    case "waiting":
      return "running";
    case "completed":
      // Work that will wake the agent keeps the run going; a dev server does not.
      return backgroundWorkHoldsCompletion(thread.pendingBackgroundTasks ?? [])
        ? "running"
        : "completed";
    case "failed":
      return "failed";
    case "idle":
    case "queued":
    case "interrupted":
    case "cancelled":
    case "rolled_back":
      return null;
  }
}

function headlineForPhase(phase: AgentAwarenessPhase): string {
  switch (phase) {
    case "starting":
      return "Starting agent";
    case "running":
      return "Agent is working";
    case "waiting_for_approval":
      return "Approval needed";
    case "waiting_for_input":
      return "Waiting for input";
    case "completed":
      return "Agent finished";
    case "failed":
      return "Agent failed";
    case "stale":
      return "Update delayed";
  }
}
