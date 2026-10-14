import {
  CommandId,
  DEFAULT_PROJECT_WORKSPACE_SETTINGS,
  ProjectWorkspaceError,
  ThreadId,
  type ModelSelection,
  type ProjectCoordinatorResult,
  type ProjectCoordinatorSendInput,
  type ProjectCoordinatorStartInput,
  type ProjectId,
} from "@specweave-studio/contracts";
import { resolveCoordinatorModelSelection } from "@specweave-studio/shared/coordinatorDefault";
import { resolveProjectSettings } from "@specweave-studio/shared/projectSettings";
import {
  limitStopWaitsForReset,
  resolveCoordinatorTurnSelection,
} from "@specweave-studio/shared/providerFallback";
import * as DateTime from "effect/DateTime";
import * as KeyedLock from "@specweave-studio/shared/KeyedLock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as ServerConfig from "../config.ts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as ProjectAdmission from "./ProjectAdmission.ts";
import * as ProjectService from "./ProjectService.ts";
import * as ProjectWorkspaceService from "./ProjectWorkspaceService.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as CoordinatorAttachments from "./ProjectCoordinatorAttachments.ts";
import {
  isProjectModelSelectionCompatible,
  projectCompatibleProviders,
} from "./ProjectProviderCompatibility.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import { simulatedUsageLimitInstances } from "../orchestration-v2/ProviderFailure.ts";
import {
  limitStopIsCurrent,
  ProviderFallbackEnv,
} from "../orchestration-v2/ProviderFallbackWorker.ts";

export class ProjectCoordinatorService extends Context.Service<
  ProjectCoordinatorService,
  {
    readonly start: (
      input: ProjectCoordinatorStartInput,
    ) => Effect.Effect<ProjectCoordinatorResult, ProjectWorkspaceError>;
    readonly send: (
      input: ProjectCoordinatorSendInput,
    ) => Effect.Effect<ProjectCoordinatorResult, ProjectWorkspaceError>;
  }
>()("specweave-studio/project/ProjectCoordinatorService") {}

const isProjectWorkspaceError = Schema.is(ProjectWorkspaceError);

const make = Effect.gen(function* () {
  const eventSink = yield* EventSink.EventSinkV2;
  const fileSystem = yield* FileSystem.FileSystem;
  const config = yield* ServerConfig.ServerConfig;
  const admission = yield* ProjectAdmission.ProjectAdmission;
  const projects = yield* ProjectService.ProjectService;
  const workspace = yield* ProjectWorkspaceService.ProjectWorkspaceService;
  const launches = yield* ThreadLaunchService.ThreadLaunchService;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const providerRegistry = yield* ProviderRegistry.ProviderRegistry;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const locks = yield* KeyedLock.make<ProjectId>();
  const fail = (projectId: ProjectId, code: ProjectWorkspaceError["code"]) =>
    new ProjectWorkspaceError({ projectId, code });
  const mapFailure = (projectId: ProjectId) =>
    Effect.mapError((error: unknown) =>
      isProjectWorkspaceError(error) ? error : fail(projectId, "operation_failed"),
    );
  const ensure = (input: ProjectCoordinatorStartInput) =>
    locks
      .withLock(
        input.projectId,
        Effect.gen(function* () {
          yield* workspace.assertAdmission(input.projectId);
          const projectOption = yield* projects.getById(input.projectId);
          if (Option.isNone(projectOption)) return yield* fail(input.projectId, "not_found");
          const project = projectOption.value;
          const settings = project.workspaceSettings ?? DEFAULT_PROJECT_WORKSPACE_SETTINGS;
          const threadId =
            settings.coordinatorThreadId ?? ThreadId.make(`project-coordinator:${input.projectId}`);
          const existing = yield* threads.getThreadShell(threadId);
          if (existing) {
            if (existing.deletedAt !== null || existing.projectId !== input.projectId)
              return yield* fail(input.projectId, "invalid_coordinator");
            if (existing.archivedAt !== null) return yield* fail(input.projectId, "archived");
            return { threadId, created: false };
          }
          const defaults = resolveProjectSettings(
            yield* serverSettings.getSettings,
            input.projectId,
            project,
          ).settings;
          const providers = yield* providerRegistry.getProviders;
          const runtimePolicy = {
            runtimeMode: defaults.defaultRuntimeMode,
            interactionMode: "default",
          };
          // Nobody chose a model: start on the project's defaults or this host's best
          // signed-in model instead of refusing, in the order the project view shows.
          const modelSelection = resolveCoordinatorModelSelection({
            saved: settings.coordinatorModelSelection,
            projectDefault: project.defaultModelSelection,
            scopedDefault: resolveProjectSettings(defaults, input.projectId, project).settings
              .defaultModelSelection,
            providers: projectCompatibleProviders({
              project,
              providers,
              cwd: project.workspaceRoot,
              runtimePolicy,
            }),
          });
          if (!modelSelection) return yield* fail(input.projectId, "model_required");
          if (
            !isProjectModelSelectionCompatible({
              project,
              providers,
              cwd: project.workspaceRoot,
              selection: modelSelection,
              runtimePolicy,
            })
          )
            return yield* fail(input.projectId, "unsupported_provider");
          // Persist the reservation before launch. Both IDs survive a lost response or server restart.
          if (settings.coordinatorThreadId === null) {
            const bind = projects.update({
              projectId: input.projectId,
              commandId: CommandId.make(`coordinator-bind:${input.projectId}`),
              coordinatorThreadId: threadId,
            });
            // A fallback model is saved with the reservation, so the project names the
            // model its coordinator runs on and a later default change cannot drift from it.
            yield* settings.coordinatorModelSelection
              ? bind
              : projects
                  .update({
                    projectId: input.projectId,
                    commandId: CommandId.make(
                      `coordinator-bind:${input.projectId}:${settings.revision}`,
                    ),
                    coordinatorThreadId: threadId,
                    workspaceSettings: {
                      expectedRevision: settings.revision,
                      coordinatorModelSelection: modelSelection,
                    },
                  })
                  .pipe(
                    // Settings saved elsewhere meanwhile win; the reservation still goes in.
                    Effect.catchTags({
                      ProjectRequestDeniedError: (error) =>
                        error.reason === "settings_conflict" ? bind : Effect.fail(error),
                    }),
                  );
          }
          yield* workspace.assertAdmission(input.projectId);
          yield* launches.launch({
            commandId: CommandId.make(`coordinator-launch:${input.projectId}`),
            threadId,
            projectId: input.projectId,
            title: `${project.title} coordinator`,
            modelSelection,
            runtimeMode: defaults.defaultRuntimeMode,
            interactionMode: "default",
            workspaceStrategy: { type: "root" },
            createdBy: "user",
            creationSource: "web",
          });
          return { threadId, created: true };
        }),
      )
      .pipe(mapFailure(input.projectId));
  /**
   * The model the next coordinator turn names: the saved one unless its
   * provider is limited (see resolveCoordinatorTurnSelection), so a
   * coordinator moved to a fallback is not pulled back into the limit by
   * every message.
   */
  const turnSelection = (
    projectId: ProjectId,
    threadId: ThreadId,
    settings: { readonly coordinatorModelSelection: ModelSelection | null },
  ) =>
    Effect.gen(function* () {
      const saved = settings.coordinatorModelSelection;
      const shell = yield* threads.getThreadShell(threadId).pipe(Effect.orElseSucceed(() => null));
      const found = yield* projects.getById(projectId);
      if (Option.isNone(found)) return yield* fail(projectId, "not_found");
      const project = found.value;
      const providers = yield* providerRegistry.getProviders;
      const compatibility = {
        project,
        providers,
        cwd: shell?.worktreePath ?? project.workspaceRoot,
        ...(shell
          ? {
              runtimePolicy: {
                runtimeMode: shell.runtimeMode,
                interactionMode: shell.interactionMode,
              },
            }
          : {}),
      };
      const selection = yield* Effect.gen(function* () {
        if (saved === null) return null;
        const rule = resolveProjectSettings(
          yield* serverSettings.getSettings,
          projectId,
          project,
        ).settings;
        const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
        const limited = new Set<string>(simulatedUsageLimitInstances(yield* ProviderFallbackEnv));
        if (
          shell &&
          shell.status === "failed" &&
          shell.lastErrorClass === "usage_limit" &&
          limitStopIsCurrent(shell, nowMs) &&
          !limitStopWaitsForReset({
            resetAt: shell.usageLimitResetAt,
            waitUnderMinutes: rule.providerLimitWaitUnderMinutes,
            nowMs,
          })
        )
          limited.add(shell.providerInstanceId);
        // Moved off the saved model: when its last run there failed, which keeps
        // it off that model until a newer usage read shows room.
        const savedStoppedAtMs =
          shell && shell.modelSelection.instanceId !== saved.instanceId
            ? yield* projections.getThreadRecords(threadId, ["runs"]).pipe(
                Effect.map(({ runs }) => {
                  let last: (typeof runs)[number] | undefined;
                  for (const run of runs)
                    if (
                      run.providerInstanceId === saved.instanceId &&
                      (!last || run.ordinal > last.ordinal)
                    )
                      last = run;
                  return last?.status === "failed" && last.completedAt
                    ? DateTime.toEpochMillis(last.completedAt)
                    : null;
                }),
                Effect.orElseSucceed(() => null),
              )
            : null;
        const decision = resolveCoordinatorTurnSelection({
          saved,
          thread: shell?.modelSelection ?? null,
          providers: projectCompatibleProviders(compatibility),
          rule,
          nowMs,
          limitedInstanceIds: limited,
          savedStoppedAtMs,
        });
        if (decision.reason !== "saved")
          yield* Effect.logInfo("project.coordinator.turn-model", {
            projectId,
            threadId,
            reason: decision.reason,
            saved: saved.instanceId,
            selected: decision.selection.instanceId,
            model: decision.selection.model,
          });
        return decision.selection;
      }).pipe(Effect.orElseSucceed(() => settings.coordinatorModelSelection));
      // Read/usage recovery can retain the saved choice. Validate after that
      // recovery so it never turns an incompatible primary into a send.
      const effectiveSelection = selection ?? shell?.modelSelection;
      if (
        effectiveSelection &&
        !isProjectModelSelectionCompatible({ ...compatibility, selection: effectiveSelection })
      )
        return yield* fail(projectId, "unsupported_provider");
      return selection;
    });
  const send = (input: ProjectCoordinatorSendInput) =>
    Effect.gen(function* () {
      yield* CoordinatorAttachments.validate(input);
      if (input.sourceThreadId !== undefined) {
        const source = yield* threads.getThreadShell(input.sourceThreadId);
        if (!source || source.deletedAt !== null || source.projectId !== input.projectId)
          return yield* fail(input.projectId, "invalid_source_thread");
      }
      const result = yield* ensure(input);
      return yield* admission.withLock(
        input.projectId,
        Effect.gen(function* () {
          if (input.sourceThreadId !== undefined) {
            const source = yield* threads.getThreadShell(input.sourceThreadId);
            if (!source || source.deletedAt !== null || source.projectId !== input.projectId)
              return yield* fail(input.projectId, "invalid_source_thread");
          }
          yield* workspace.assertAdmission(input.projectId);
          const settings = (yield* workspace.readWorkspace(input)).settings;
          const modelSelection = yield* turnSelection(input.projectId, result.threadId, settings);
          yield* CoordinatorAttachments.send({
            projectId: input.projectId,
            threadId: result.threadId,
            commandId: CommandId.make(`coordinator-send:${input.projectId}:${input.commandId}`),
            messageId: CoordinatorAttachments.messageId(input),
            ...(input.sourceThreadId === undefined ? {} : { senderThreadId: input.sourceThreadId }),
            text:
              input.sourceThreadId === undefined
                ? input.prompt
                : `User follow-up from selected worker ${input.sourceThreadId}. Review that thread and decide whether to reuse it or route elsewhere.\n\n${input.prompt}`,
            ...(modelSelection ? { modelSelection } : {}),
            attachments: input.attachments ?? [],
            mode: "queue",
            createdBy: "user",
            creationSource: "web",
          }).pipe(
            Effect.provideService(EventSink.EventSinkV2, eventSink),
            Effect.provideService(FileSystem.FileSystem, fileSystem),
            Effect.provideService(ServerConfig.ServerConfig, config),
            Effect.provideService(ThreadManagementService.ThreadManagementService, threads),
          );
          return result;
        }),
      );
    }).pipe(mapFailure(input.projectId));
  const start = (input: ProjectCoordinatorStartInput) =>
    input.prompt?.trim() ? send({ ...input, prompt: input.prompt }) : ensure(input);
  return ProjectCoordinatorService.of({ start, send });
});
export const layer = Layer.effect(ProjectCoordinatorService, make).pipe(
  Layer.provide(ProjectAdmission.layer),
);
