import type {
  ModelSelection,
  OrchestratorMcpTarget,
  Project,
  ThreadId,
} from "@specweave-studio/contracts";

/**
 * The model a coordinator's worker starts on when the coordinator names none:
 * the project's saved worker model, else the host's default (the same pick a
 * coordinator nobody configured starts on). The coordinator is a router; its own
 * possibly cheaper model never silently becomes the worker default.
 */
function workerDefault(
  project: Pick<Project, "defaultModelSelection">,
  hostDefault: ModelSelection | null,
): ModelSelection | null {
  return project.defaultModelSelection ?? hostDefault;
}

function namesModel(target: OrchestratorMcpTarget | undefined): boolean {
  return Boolean(target?.providerInstanceId || target?.driverKind || target?.model);
}

export function projectDelegationTarget(
  project: Pick<Project, "workspaceSettings" | "defaultModelSelection">,
  callerThreadId: ThreadId,
  target: OrchestratorMcpTarget | undefined,
  hostDefault: ModelSelection | null = null,
): OrchestratorMcpTarget | undefined {
  const selected = workerDefault(project, hostDefault);
  if (
    project.workspaceSettings?.coordinatorThreadId !== callerThreadId ||
    !selected ||
    namesModel(target)
  )
    return target;
  return {
    providerInstanceId: selected.instanceId,
    model: selected.model,
    ...(target?.options !== undefined
      ? { options: target.options }
      : selected.options !== undefined
        ? { options: selected.options }
        : {}),
  };
}

/** Only when neither the project nor the host offers a model must the coordinator name one. */
export function needsExplicitWorkerTarget(
  project: Pick<Project, "workspaceSettings" | "defaultModelSelection">,
  callerThreadId: ThreadId,
  target: OrchestratorMcpTarget | undefined,
  hostDefault: ModelSelection | null = null,
): boolean {
  return (
    project.workspaceSettings?.coordinatorThreadId === callerThreadId &&
    !workerDefault(project, hostDefault) &&
    !namesModel(target)
  );
}
