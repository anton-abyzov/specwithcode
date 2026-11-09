import type {
  ModelSelection,
  OrchestratorMcpTarget,
  Project,
  ServerSettings,
  ThreadId,
} from "@specweave-studio/contracts";
import { resolveProjectSettings } from "@specweave-studio/shared/projectSettings";

/**
 * The project's own thread and worker model: its Project settings override,
 * else the project's saved field. Null when only the machine default would
 * apply, so a project that never chose a model keeps lanes and Auto.
 */
export function projectWorkerModel(
  settings: ServerSettings,
  project: Pick<Project, "id" | "defaultModelSelection">,
): ModelSelection | null {
  const resolved = resolveProjectSettings(settings, project.id, project);
  return resolved.sources.defaultModelSelection === "project"
    ? resolved.settings.defaultModelSelection
    : null;
}

/** The project as worker launches read it: its model is the one `projectWorkerModel` names. */
export function withProjectWorkerModel<P extends Pick<Project, "id" | "defaultModelSelection">>(
  settings: ServerSettings,
  project: P,
): P {
  return { ...project, defaultModelSelection: projectWorkerModel(settings, project) };
}

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

/**
 * The model a worker started by `callerThreadId` takes when it names none. The
 * project's own model wins for every caller in the project, so a worker never
 * inherits a parent that fell back to another provider. Only the coordinator
 * also falls back to the host default; any other caller keeps its own model.
 */
export function callerWorkerModel(
  project: Pick<Project, "workspaceSettings" | "defaultModelSelection">,
  callerThreadId: ThreadId,
  hostDefault: ModelSelection | null = null,
): ModelSelection | null {
  return project.workspaceSettings?.coordinatorThreadId === callerThreadId
    ? projectWorkerDefault(project, hostDefault)
    : project.defaultModelSelection;
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
  const preferred = callerWorkerModel(project, callerThreadId, hostDefault);
  if (!preferred || namesModel(target)) return target;
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
