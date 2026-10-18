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
export function projectWorkerDefault(
  project: Pick<Project, "defaultModelSelection">,
  hostDefault: ModelSelection | null,
): ModelSelection | null {
  return project.defaultModelSelection ?? hostDefault;
}

function namesModel(target: OrchestratorMcpTarget | undefined): boolean {
  return Boolean(target?.providerInstanceId || target?.driverKind || target?.model);
}

/**
 * `launchSelection` replaces the worker default when its provider has no room
 * (see workerLaunchWithRoom); a moved selection carries no options, since the
 * default's belong to another model.
 */
export function projectDelegationTarget(
  project: Pick<Project, "workspaceSettings" | "defaultModelSelection">,
  callerThreadId: ThreadId,
  target: OrchestratorMcpTarget | undefined,
  hostDefault: ModelSelection | null = null,
  launchSelection?: ModelSelection | null,
): OrchestratorMcpTarget | undefined {
  const preferred = projectWorkerDefault(project, hostDefault);
  if (
    project.workspaceSettings?.coordinatorThreadId !== callerThreadId ||
    !preferred ||
    namesModel(target)
  )
    return target;
  const selected = launchSelection ?? preferred;
  return {
    providerInstanceId: selected.instanceId,
    model: selected.model,
    ...(target?.options !== undefined
      ? { options: target.options }
      : selected.options !== undefined
        ? { options: selected.options }
        : {}),
    ...(target?.effort !== undefined ? { effort: target.effort } : {}),
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
    !projectWorkerDefault(project, hostDefault) &&
    !namesModel(target)
  );
}
