import {
  CommandId,
  DEFAULT_PROJECT_WORKSPACE_SETTINGS,
  ProjectWorkspaceError,
  ThreadId,
  type ProjectCoordinatorResult,
  type ProjectCoordinatorSendInput,
  type ProjectCoordinatorStartInput,
  type ProjectId,
} from "@specweave-studio/contracts";
import { resolveCoordinatorModelSelection } from "@specweave-studio/shared/coordinatorDefault";
import { resolveProjectSettings } from "@specweave-studio/shared/projectSettings";
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
import * as ServerSettings from "../serverSettings.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";

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
>()("studio/project/ProjectCoordinatorService") {}

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
              return yield* fail(input.projectId, "invalid");
            if (existing.archivedAt !== null) return yield* fail(input.projectId, "archived");
            return { threadId, created: false };
          }
          const defaults = yield* serverSettings.getSettings;
          // Nobody chose a model: start on the project's defaults or this host's best
          // signed-in model instead of refusing, in the order the project view shows.
          const modelSelection = resolveCoordinatorModelSelection({
            saved: settings.coordinatorModelSelection,
            projectDefault: project.defaultModelSelection,
            scopedDefault: resolveProjectSettings(defaults, input.projectId, project).settings
              .defaultModelSelection,
            providers: yield* providerRegistry.getProviders,
          });
          if (!modelSelection) return yield* fail(input.projectId, "model_required");
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
  const send = (input: ProjectCoordinatorSendInput) =>
    Effect.gen(function* () {
      yield* CoordinatorAttachments.validate(input);
      if (input.sourceThreadId !== undefined) {
        const source = yield* threads.getThreadShell(input.sourceThreadId);
        if (!source || source.deletedAt !== null || source.projectId !== input.projectId)
          return yield* fail(input.projectId, "invalid");
      }
      const result = yield* ensure(input);
      return yield* admission.withLock(
        input.projectId,
        Effect.gen(function* () {
          if (input.sourceThreadId !== undefined) {
            const source = yield* threads.getThreadShell(input.sourceThreadId);
            if (!source || source.deletedAt !== null || source.projectId !== input.projectId)
              return yield* fail(input.projectId, "invalid");
          }
          yield* workspace.assertAdmission(input.projectId);
          const settings = (yield* workspace.readWorkspace(input)).settings;
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
            ...(settings.coordinatorModelSelection
              ? { modelSelection: settings.coordinatorModelSelection }
              : {}),
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
