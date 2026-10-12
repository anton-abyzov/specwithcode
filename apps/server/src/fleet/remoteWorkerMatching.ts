import {
  type ModelSelection,
  type OrchestrationV2Notification,
  type OrchestratorMcpMachineProject,
  type OrchestratorMcpMachineProvider,
  type OrchestratorMcpMachineStatus,
  type ProjectId,
  type RepositoryIdentity,
  type RuntimeMode,
  repositoryGroupingKeyOf,
} from "@specweave-studio/contracts";
import type { StudioFleetWorkers } from "@specweave-studio/contracts/studioFleet";
import { studioThreadLinkLabel } from "@specweave-studio/shared/studioThreadLinks";

/** The parts of a project, here or there, that decide whether two are the same work. */
export interface MatchableProject {
  readonly id: ProjectId;
  readonly title: string;
  readonly workspaceRoot: string;
  readonly repositoryIdentity?: RepositoryIdentity | null | undefined;
}

const normalizePath = (path: string) => path.trim().replaceAll("\\", "/").replace(/\/+$/u, "");

/** Where a project sits inside its repository: "" at the root, null when unknown. */
export function repositoryRelativePath(project: MatchableProject): string | null {
  const rootPath = project.repositoryIdentity?.rootPath;
  if (!rootPath) return null;
  const root = normalizePath(rootPath);
  const workspace = normalizePath(project.workspaceRoot);
  if (root.length === 0 || workspace.length === 0) return null;
  if (workspace === root) return "";
  return workspace.startsWith(`${root}/`) ? workspace.slice(root.length + 1) : null;
}

const groupingKey = (project: MatchableProject) =>
  project.repositoryIdentity ? repositoryGroupingKeyOf(project.repositoryIdentity) : undefined;

export type RemoteProjectMatch = OrchestratorMcpMachineProject & {
  /** Why nothing matched, in words an agent can act on. */
  readonly reason?: string;
};

/**
 * Finds the project on another machine that holds the same work as `local`.
 * An id chosen by the user or the agent wins, as long as it exists there and
 * is not plainly a different repository. Otherwise the repository grouping key
 * and the project's place inside the repository must both match, so two
 * checkouts of one monorepo's different packages never pair up.
 */
export function matchRemoteProject(input: {
  readonly local: MatchableProject;
  readonly remote: ReadonlyArray<MatchableProject>;
  readonly projectId?: ProjectId | null | undefined;
}): RemoteProjectMatch {
  const localKey = groupingKey(input.local);
  if (input.projectId) {
    const chosen = input.remote.find((project) => project.id === input.projectId);
    if (!chosen)
      return {
        match: "none",
        reason: `Project ${input.projectId} does not exist on that machine.`,
      };
    const chosenKey = groupingKey(chosen);
    if (localKey !== undefined && chosenKey !== undefined && localKey !== chosenKey)
      return {
        match: "none",
        reason: `Project ${chosen.title} on that machine is a different repository.`,
      };
    return { match: "configured", projectId: chosen.id, title: chosen.title };
  }
  if (localKey === undefined)
    return {
      match: "none",
      reason:
        "This project has no repository identity to match by; pass machineProjectId or set the project's worker machine project.",
    };
  const localPath = repositoryRelativePath(input.local) ?? "";
  const candidates = input.remote.filter(
    (project) =>
      groupingKey(project) === localKey && (repositoryRelativePath(project) ?? "") === localPath,
  );
  if (candidates.length === 1)
    return { match: "identity", projectId: candidates[0]!.id, title: candidates[0]!.title };
  if (candidates.length === 0)
    return {
      match: "none",
      reason: "No project on that machine is a checkout of this repository.",
    };
  return {
    match: "ambiguous",
    candidates: candidates.map((project) => ({ projectId: project.id, title: project.title })),
    reason: "Several projects on that machine match; pass machineProjectId.",
  };
}

export type ModelTranslation =
  | { readonly type: "same"; readonly modelSelection: ModelSelection }
  | { readonly type: "translated"; readonly modelSelection: ModelSelection }
  | { readonly type: "unavailable" };

/**
 * The same model on another machine. Provider instance ids are local names,
 * so an id that also exists there must offer the model, and otherwise exactly
 * one instance of the same provider kind must.
 */
export function translateModel(input: {
  readonly selection: ModelSelection;
  readonly driverKind: string | undefined;
  readonly remote: ReadonlyArray<OrchestratorMcpMachineProvider>;
}): ModelTranslation {
  const { selection } = input;
  const sameInstance = input.remote.find(
    (provider) => provider.providerInstanceId === selection.instanceId,
  );
  if (sameInstance?.models.includes(selection.model))
    return { type: "same", modelSelection: selection };
  if (input.driverKind === undefined) return { type: "unavailable" };
  const sameKind = input.remote.filter(
    (provider) =>
      provider.driverKind === input.driverKind && provider.models.includes(selection.model),
  );
  if (sameKind.length !== 1) return { type: "unavailable" };
  return {
    type: "translated",
    modelSelection: { ...selection, instanceId: sameKind[0]!.providerInstanceId },
  };
}

const RUNTIME_MODE_RANK: Record<RuntimeMode, number> = {
  "approval-required": 0,
  "auto-accept-edits": 1,
  auto: 2,
  "full-access": 3,
};

/**
 * The runtime mode a remote worker starts with: the caller's own, never above
 * what the user allowed for that machine. An explicit request above that
 * ceiling is refused rather than silently lowered.
 */
export function clampRuntimeMode(input: {
  readonly started: RuntimeMode;
  readonly requested: RuntimeMode | undefined;
  readonly ceiling: RuntimeMode;
}): { readonly ok: true; readonly mode: RuntimeMode } | { readonly ok: false } {
  if (
    input.requested !== undefined &&
    RUNTIME_MODE_RANK[input.requested] > RUNTIME_MODE_RANK[input.ceiling]
  )
    return { ok: false };
  return {
    ok: true,
    mode:
      RUNTIME_MODE_RANK[input.started] > RUNTIME_MODE_RANK[input.ceiling]
        ? input.ceiling
        : input.started,
  };
}

/** A machine's status for agents, from its worker grant here. */
export function grantMachineStatus(workers: StudioFleetWorkers): OrchestratorMcpMachineStatus {
  switch (workers.status) {
    case "allowed":
      return "ready";
    case "expiring":
      return "grant_expiring";
    case "revoked":
      return "grant_revoked";
    case "expired":
      return "grant_expired";
    case "not_allowed":
      return workers.problem === "identity_mismatch"
        ? "identity_mismatch"
        : workers.problem === "unsupported" || workers.problem === "route_mismatch"
          ? "unsupported"
          : workers.problem === "unreachable"
            ? "unreachable"
            : "needs_grant";
  }
}

export const isTerminalThreadStatus = (status: string) =>
  ["idle", "completed", "interrupted", "failed", "cancelled", "rolled_back"].includes(status);

interface RemoteWorkerRef {
  readonly title: string;
  /** `studio://thread/<environment>/<thread>`; tools accept it as the thread id. */
  readonly threadRef: string;
  readonly machineLabel: string;
}

const outcomeOf = (status: string): OrchestrationV2Notification["outcome"] =>
  status === "completed" || status === "idle"
    ? "completed"
    : status === "failed"
      ? "failed"
      : status === "interrupted" || status === "cancelled" || status === "rolled_back"
        ? "cancelled"
        : "unknown";

/**
 * The fixed words a coordinator is woken with; nothing from the remote agent
 * is quoted. People see the notification's summary instead of the text.
 */
export function remoteWorkerWake(input: RemoteWorkerRef & { readonly status: string }): {
  readonly text: string;
  readonly notification: OrchestrationV2Notification;
} {
  const link = `[${linkText(input.title)}](${input.threadRef})`;
  return {
    text: `Remote worker ${link} on ${input.machineLabel} finished: ${input.status}. Read it with studio_thread_read {threadId:"${input.threadRef}"}.`,
    notification: {
      source: { kind: "background_task" },
      outcome: outcomeOf(input.status),
      summary: `${link} on ${input.machineLabel} reported back.`,
    },
  };
}

export function remoteWorkerLost(input: RemoteWorkerRef): {
  readonly text: string;
  readonly notification: OrchestrationV2Notification;
} {
  const link = `[${linkText(input.title)}](${input.threadRef})`;
  return {
    text: `Lost contact with remote worker ${link} on ${input.machineLabel} for 24 hours. Check it with studio_thread_read {threadId:"${input.threadRef}"} once the machine is back.`,
    notification: {
      source: { kind: "background_task" },
      outcome: "unknown",
      summary: `Lost contact with ${link} on ${input.machineLabel}.`,
    },
  };
}

/** Keeps a title from closing the link it sits in. */
const linkText = (title: string) => studioThreadLinkLabel(title.slice(0, 200), "worker");
