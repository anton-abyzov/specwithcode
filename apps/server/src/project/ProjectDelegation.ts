import type {
  ModelSelection,
  OrchestratorMcpTarget,
  Project,
  ServerProvider,
  ServerSettings,
  ThreadId,
} from "@specweave-studio/contracts";
import { isHeldSource } from "@specweave-studio/shared/modelTracks";
import { resolveProjectSettings } from "@specweave-studio/shared/projectSettings";
import { liveQuotaBoosts } from "@specweave-studio/shared/quotaBoost";
import { limitAccountKey } from "@specweave-studio/shared/usageLimits";
import { isModelSelectionProviderEnabled } from "@specweave-studio/shared/serverSettings";
import { accountInGrant } from "../fleet/workGrantPolicy.ts";

/**
 * The project's own thread and worker model: its Project settings override,
 * else the project's saved field, which the Project settings dialog writes
 * ("Recommended model for threads"). Once an install has folded its legacy
 * project fields, the settings resolver no longer reads that field, so it is
 * read here directly. Null when only the machine default would apply, so a
 * project that never chose a model keeps lanes and Auto.
 */
export function projectWorkerModel(
  settings: ServerSettings,
  project: Pick<Project, "id" | "defaultModelSelection">,
): ModelSelection | null {
  const resolved = resolveProjectSettings(settings, project.id, project);
  // On Tracks no single model is the project's: the track for the task decides.
  if (resolved.settings.threadModelMode === "tracks") return null;
  if (resolved.sources.defaultModelSelection === "project")
    return resolved.settings.defaultModelSelection;
  // Like an override, a saved model on a disabled provider does not count.
  const saved = project.defaultModelSelection;
  return saved !== null && isModelSelectionProviderEnabled(settings, saved) ? saved : null;
}

/**
 * The model a quota boost ("Use it for new threads until it resets") starts
 * this project's new worker threads on at `nowMs`, else null. The boost is
 * judged again here, where threads launch, and not trusted as written: it
 * counts only while its provider is on, signed in to the same account, still
 * lists the model and bills it by plan. Anything else and the worker starts
 * as if there were no boost, so a boost can never spend per use. Only new
 * worker launches read this; the coordinator and open threads keep their model.
 */
export function quotaBoostWorkerModel(
  settings: ServerSettings,
  project: Pick<Project, "id">,
  providers: ReadonlyArray<ServerProvider>,
  nowMs: number,
): ModelSelection | null {
  // The quota lost first leads; the first boost that still holds wins.
  for (const boost of liveQuotaBoosts(settings.quotaBoosts, nowMs)) {
    if (boost.projectIds.length > 0 && !boost.projectIds.includes(project.id)) continue;
    if (
      !isModelSelectionProviderEnabled(settings, {
        instanceId: boost.instanceId,
        model: boost.model,
      })
    )
      continue;
    const provider = providers.find((entry) => entry.instanceId === boost.instanceId);
    if (provider === undefined || !provider.enabled) continue;
    if (provider.auth.status === "unauthenticated") continue;
    // Signed in to another account since: that quota is not the one the person chose.
    const account = limitAccountKey(provider.driver, provider.auth.email, provider.usageLimits);
    if (account !== null && account !== boost.accountKey) continue;
    const listed = provider.models.find(
      (model) => model.slug === boost.model || model.aliases?.includes(boost.model) === true,
    );
    if (listed === undefined) continue;
    // Per token, a paid router, Gemini or Vertex spend, or billing nobody can read.
    if (isHeldSource(provider, listed.slug)) continue;
    return { instanceId: boost.instanceId, model: listed.slug };
  }
  return null;
}

/**
 * The model a new worker thread nobody named a model for starts on: a running
 * quota boost, else the project's own model (`projectWorkerModel`).
 */
export function newWorkerModel(
  settings: ServerSettings,
  project: Pick<Project, "id" | "defaultModelSelection">,
  providers: ReadonlyArray<ServerProvider>,
  nowMs: number,
): ModelSelection | null {
  return (
    quotaBoostWorkerModel(settings, project, providers, nowMs) ??
    projectWorkerModel(settings, project)
  );
}

/** Whether the project's unnamed workers start on a track ("Tracks") and not on one saved model. */
export function projectUsesTracks(
  settings: ServerSettings,
  project: Pick<Project, "id" | "defaultModelSelection">,
): boolean {
  return (
    resolveProjectSettings(settings, project.id, project).settings.threadModelMode === "tracks"
  );
}

/**
 * Whether saving `next` as the project's thread model must remove an older
 * Project settings override, which would otherwise outrank it. Only a model
 * that changed counts: the project dialog sends its whole form on every save,
 * and a seeded default (`onlyIfUnset`) is not a person's choice.
 */
export function replacesProjectModelOverride(input: {
  readonly settings: ServerSettings;
  readonly projectId: Project["id"];
  readonly previous: ModelSelection | null;
  readonly next: ModelSelection | null | undefined;
  readonly onlyIfUnset?: boolean | undefined;
}): boolean {
  if (input.next === undefined || input.onlyIfUnset === true) return false;
  if (JSON.stringify(input.next) === JSON.stringify(input.previous)) return false;
  return Object.hasOwn(
    input.settings.projectSettingsOverrides[input.projectId] ?? {},
    "defaultModelSelection",
  );
}

/**
 * The settings a limited thread of `project` falls back by: the project's
 * settings with the same thread model launches use (`projectWorkerModel`) as
 * home, so a limit stop and a launch never disagree on it.
 */
export function projectLimitRule(
  settings: ServerSettings,
  project: Pick<Project, "id" | "defaultModelSelection">,
): ServerSettings {
  const resolved = resolveProjectSettings(settings, project.id, project).settings;
  const model = projectWorkerModel(settings, project);
  return model === null ? resolved : { ...resolved, defaultModelSelection: model };
}

/**
 * The project model a caller's unnamed worker takes under its work grant. A
 * caller other than the coordinator whose grant excludes that model's sign-in
 * keeps its own model instead (null here), as it did before the project model
 * applied to every caller.
 */
export function workerModelUnderGrant(
  model: ModelSelection | null,
  isCoordinator: boolean,
  accounts: Parameters<typeof accountInGrant>[0] | undefined,
): ModelSelection | null {
  return model !== null &&
    !isCoordinator &&
    accounts !== undefined &&
    !accountInGrant(accounts, model.instanceId)
    ? null
    : model;
}

/** The project as worker launches read it: its model is the one `newWorkerModel` names. */
export function withProjectWorkerModel<P extends Pick<Project, "id" | "defaultModelSelection">>(
  settings: ServerSettings,
  project: P,
  providers: ReadonlyArray<ServerProvider>,
  nowMs: number,
): P {
  return {
    ...project,
    defaultModelSelection: newWorkerModel(settings, project, providers, nowMs),
  };
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
