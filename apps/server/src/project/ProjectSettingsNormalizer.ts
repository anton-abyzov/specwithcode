/**
 * Brings projects created before projects carried workspace settings up to
 * what a new project has, and saves the coordinator model the project itself
 * already names.
 *
 * Older projects have no settings row at all, or one whose coordinator model
 * is null, and their first coordinator launch never recorded the model it
 * chose. When the project's own coordinator thread, its default worker model
 * or its Settings > Defaults model names one, that model is saved. A project
 * that names none is left to the host default: the project view shows the live
 * default and the first coordinator launch saves it. Saving the host default
 * here would freeze whatever provider happened to be ready at this start (a
 * usage limit or a stale provider cache at boot would pin another provider for
 * good), so this pass never does.
 *
 * It writes through the ordinary revision-checked project update, so the change
 * is an event like any other: open windows follow it and a rebuild keeps it.
 *
 * @module ProjectSettingsNormalizer
 */
import {
  CommandId,
  type ModelSelection,
  type OrchestrationProjectShell,
  type ProjectId,
  type ServerProvider,
  type ServerSettings as ServerSettingsValue,
} from "@specweave-studio/contracts";
import {
  defaultProjectModelSelection,
  providersSettled,
  resolveCoordinatorModelSelection,
  withDefaultModelOptions,
} from "@specweave-studio/shared/coordinatorDefault";
import { resolveProjectSettings } from "@specweave-studio/shared/projectSettings";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ProjectService from "./ProjectService.ts";

/** Bumped only if a later release needs to normalise the same revision again. */
const COMMAND_VERSION = "v1";

export type ProjectNormalizeOutcome =
  /** Saved a model (and, for a project without settings, the full default settings). */
  | "normalized"
  /** Already has a saved model. */
  | "unchanged"
  /** The project names no model of its own; it follows the host default until its first launch. */
  | "hostDefault"
  /** Someone saved the project's settings at the same moment; theirs stand. */
  | "conflict"
  | "failed";

export interface ProjectNormalizeSummary {
  readonly normalized: number;
  readonly unchanged: number;
  readonly hostDefault: number;
  readonly conflict: number;
  readonly failed: number;
}

const emptySummary: ProjectNormalizeSummary = {
  normalized: 0,
  unchanged: 0,
  hostDefault: 0,
  conflict: 0,
  failed: 0,
};

/** Stable per project and revision, so a repeated run replays its receipt. */
export const normalizeCommandId = (projectId: ProjectId, revision: number) =>
  CommandId.make(`project-settings-normalize:${COMMAND_VERSION}:${projectId}:${revision}`);

/** Normalise one active project. */
const normalizeProject = Effect.fn("ProjectSettingsNormalizer.normalizeProject")(function* (
  project: OrchestrationProjectShell,
) {
  const projects = yield* ProjectService.ProjectService;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const settings = project.workspaceSettings;
  // A saved model is the person's choice, even one this host cannot run now.
  if (settings?.coordinatorModelSelection) return "unchanged" as const;
  const threadId = settings?.coordinatorThreadId ?? null;
  const thread = threadId === null ? null : yield* threads.getThreadShell(threadId);
  const coordinatorThreadModel: ModelSelection | null =
    thread && thread.deletedAt === null && thread.projectId === project.id
      ? thread.modelSelection
      : null;
  const scopedDefault = resolveProjectSettings(
    yield* serverSettings.getSettings,
    project.id,
    project,
  ).settings.defaultModelSelection;
  const model = resolveCoordinatorModelSelection({
    coordinatorThreadModel,
    projectDefault: project.defaultModelSelection,
    scopedDefault,
  });
  if (!model) return "hostDefault" as const;
  const revision = settings?.revision ?? 0;
  yield* projects.update({
    projectId: project.id,
    commandId: normalizeCommandId(project.id, revision),
    workspaceSettings: { expectedRevision: revision, coordinatorModelSelection: model },
  });
  yield* Effect.logInfo("Saved a coordinator model for an existing project", {
    projectId: project.id,
    instanceId: model.instanceId,
    model: model.model,
    source: coordinatorThreadModel
      ? "coordinator-thread"
      : project.defaultModelSelection
        ? "project-default"
        : "settings-default",
    fromRevision: revision,
  });
  return "normalized" as const;
});

/**
 * One pass over every active project. Each project is independent: a failure
 * or a concurrent save is logged and leaves that project as it was. A second
 * pass writes nothing.
 */
export const normalizeProjects = Effect.fn("ProjectSettingsNormalizer.normalizeProjects")(
  function* () {
    const store = yield* ProjectStore.ProjectStoreV2;
    const shells = yield* store.listShells();
    const counts = { ...emptySummary };
    for (const project of shells) {
      const outcome: ProjectNormalizeOutcome = yield* normalizeProject(project).pipe(
        Effect.catch((error) =>
          error._tag === "ProjectRequestDeniedError" && error.reason === "settings_conflict"
            ? Effect.logInfo("Project settings changed while normalising; kept them", {
                projectId: project.id,
              }).pipe(Effect.as("conflict" as const))
            : Effect.logWarning("Could not normalise project settings", {
                projectId: project.id,
                error,
              }).pipe(Effect.as("failed" as const)),
        ),
      );
      counts[outcome] += 1;
    }
    return counts satisfies ProjectNormalizeSummary;
  },
);

// ---------------------------------------------------------------------------
// Default models (2026-10): every project names Opus 5.5 with Thinking on.
// ---------------------------------------------------------------------------

export interface ProjectModelDefaultsSummary {
  /** Projects that had no default model and now name Opus 5.5. */
  readonly defaultModel: number;
  /** Coordinator models given the options nobody had chosen (Medium effort, Thinking on). */
  readonly coordinatorOptions: number;
  readonly conflict: number;
  readonly failed: number;
}

/** One write per project, ever: a reused id replays its receipt and changes nothing. */
export const defaultModelCommandId = (projectId: ProjectId) =>
  CommandId.make(`project-default-model:${COMMAND_VERSION}:${projectId}`);

/** Revision-checked like any settings save, so a save made meanwhile always wins. */
export const coordinatorOptionsCommandId = (projectId: ProjectId, revision: number) =>
  CommandId.make(`project-coordinator-options:${COMMAND_VERSION}:${projectId}:${revision}`);

const sameSelection = (left: ModelSelection | null, right: ModelSelection | null) =>
  JSON.stringify(left) === JSON.stringify(right);

const normalizeProjectModels = Effect.fn("ProjectSettingsNormalizer.normalizeProjectModels")(
  function* (
    project: OrchestrationProjectShell,
    providers: ReadonlyArray<ServerProvider>,
    serverSettings: ServerSettingsValue,
  ) {
    const projects = yield* ProjectService.ProjectService;
    let defaultModel = 0;
    let coordinatorOptions = 0;
    // A default someone chose is kept as it is, even one this host cannot run now,
    // and so is one chosen in Settings for every project or for this one.
    if (
      project.defaultModelSelection === null &&
      resolveProjectSettings(serverSettings, project.id, project).settings.defaultModelSelection ===
        null
    ) {
      const model = defaultProjectModelSelection(providers);
      if (model) {
        const saved = yield* projects.update({
          projectId: project.id,
          commandId: defaultModelCommandId(project.id),
          defaultModelSelection: model,
        });
        // A replayed receipt (the person cleared it since) leaves their choice alone.
        if (sameSelection(saved.defaultModelSelection, model)) {
          defaultModel = 1;
          yield* Effect.logInfo("Set the default model of an existing project", {
            projectId: project.id,
            instanceId: model.instanceId,
            model: model.model,
          });
        }
      }
    }
    const settings = project.workspaceSettings;
    const coordinator = settings?.coordinatorModelSelection ?? null;
    if (settings && coordinator) {
      const withOptions = withDefaultModelOptions(coordinator, providers, "coordinator");
      if (withOptions !== coordinator) {
        yield* projects.update({
          projectId: project.id,
          commandId: coordinatorOptionsCommandId(project.id, settings.revision),
          workspaceSettings: {
            expectedRevision: settings.revision,
            coordinatorModelSelection: withOptions,
          },
        });
        coordinatorOptions = 1;
        yield* Effect.logInfo("Saved the default options of a project coordinator", {
          projectId: project.id,
          model: coordinator.model,
          options: withOptions.options,
        });
      }
    }
    return { defaultModel, coordinatorOptions };
  },
);

/**
 * Gives every project that names no default model Opus 5.5 on this host's
 * Claude subscription with Thinking on, and every saved coordinator model the
 * options nobody chose (Medium effort on Opus 5.5, Thinking on). Nothing anyone
 * chose is replaced. Without a signed-in Claude subscription listing Opus 5.5,
 * no default model is written, so a later start tries again.
 */
export const normalizeProjectModelDefaults = Effect.fn(
  "ProjectSettingsNormalizer.normalizeProjectModelDefaults",
)(function* (providers: ReadonlyArray<ServerProvider>) {
  const store = yield* ProjectStore.ProjectStoreV2;
  const shells = yield* store.listShells();
  const serverSettings = yield* (yield* ServerSettings.ServerSettingsService).getSettings;
  const counts = { defaultModel: 0, coordinatorOptions: 0, conflict: 0, failed: 0 };
  for (const project of shells) {
    const outcome = yield* normalizeProjectModels(project, providers, serverSettings).pipe(
      Effect.catch((error) =>
        error._tag === "ProjectRequestDeniedError" && error.reason === "settings_conflict"
          ? Effect.logInfo("Project settings changed while setting default models; kept them", {
              projectId: project.id,
            }).pipe(Effect.as("conflict" as const))
          : Effect.logWarning("Could not set project default models", {
              projectId: project.id,
              error,
            }).pipe(Effect.as("failed" as const)),
      ),
    );
    if (outcome === "conflict" || outcome === "failed") counts[outcome] += 1;
    else {
      counts.defaultModel += outcome.defaultModel;
      counts.coordinatorOptions += outcome.coordinatorOptions;
    }
  }
  return counts satisfies ProjectModelDefaultsSummary;
});

/**
 * This host's providers once each has been checked (or restored from the last
 * session's cache), or none when that takes longer than `timeout`.
 */
export const awaitSettledProviders = Effect.fn("ProjectSettingsNormalizer.awaitSettledProviders")(
  function* (timeout: Duration.Input, poll: Duration.Input = "2 seconds") {
    const registry = yield* ProviderRegistry.ProviderRegistry;
    const settled = Effect.gen(function* () {
      while (true) {
        const providers = yield* registry.getProviders;
        if (providersSettled(providers)) return providers;
        yield* Effect.sleep(poll);
      }
    });
    return yield* settled.pipe(Effect.timeoutOption(timeout));
  },
);

/**
 * Waits for providers, then sets default models. A project whose coordinator
 * had no model of its own now saves the new default as its coordinator model
 * too, and is then given the coordinator's options. A host without providers
 * in time is left as it is until the next start.
 */
export const normalizeProjectModelDefaultsWhenReady = Effect.fn(
  "ProjectSettingsNormalizer.normalizeProjectModelDefaultsWhenReady",
)(function* (timeout: Duration.Input = "3 minutes") {
  const providers = yield* awaitSettledProviders(timeout);
  if (Option.isNone(providers)) {
    yield* Effect.logInfo("Providers were not ready; project default models left for next start");
    return null;
  }
  const first = yield* normalizeProjectModelDefaults(providers.value);
  if (first.defaultModel === 0) return first;
  yield* normalizeProjects();
  const second = yield* normalizeProjectModelDefaults(providers.value);
  return {
    defaultModel: first.defaultModel,
    coordinatorOptions: first.coordinatorOptions + second.coordinatorOptions,
    conflict: first.conflict + second.conflict,
    failed: first.failed + second.failed,
  } satisfies ProjectModelDefaultsSummary;
});
