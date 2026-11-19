/**
 * The project-settings tools: studio_project_update, which keeps the person's
 * own choices (instructions, lifecycle, folders, saved models) out of an
 * agent's reach, and studio_model_preference, the coordinator's learned model
 * rules. Moved out of handlers.ts unchanged.
 *
 * @module projectSettings
 */
import {
  OrchestratorMcpFailure,
  type LearnedModelPreference,
  type OrchestratorMcpModelPreferenceInput,
  type ProjectId,
  type ProjectRepository,
  type ProjectUpdatePayload,
} from "@specweave-studio/contracts";
import {
  learnedPreferenceBillingBlock,
  withLearnedPreference,
} from "@specweave-studio/shared/modelLanes";
import { resolveProjectSettings } from "@specweave-studio/shared/projectSettings";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as Project from "../../../project/ProjectService.ts";
import {
  describeModelSelection,
  duplicateOptionIds,
  projectThreadsUseTracks,
  sameModelSelection,
  savedProjectModel,
} from "../../../project/projectModelChange.ts";
import * as ProviderRegistry from "../../../provider/ProviderRegistry.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import { newCommandId, readCaller, resolveProjectId, unavailable } from "../../threadAccess.ts";
import { assertAccountInGrant, assertProjectReadable } from "../../workGrantAccess.ts";

/** A project service failure as the tool failure an agent reads. */
export function projectFailure(error: Project.ProjectServiceError) {
  if (error._tag === "ProjectOperationError") return unavailable();
  const message =
    error._tag === "ProjectNotFoundError"
      ? "The project was not found."
      : error._tag === "ProjectConflictError"
        ? `${error.workspaceRoot} already belongs to another project. studio_project_list shows which.`
        : Project.projectMutationErrorMessage(error);
  return new OrchestratorMcpFailure({ code: "invalid_request", message });
}

/** studio_project_update: the settings an agent may change, and the reason for each it may not. */
export const updateProject = (input: { readonly projectId: ProjectId } & ProjectUpdatePayload) =>
  Effect.gen(function* () {
    const projects = yield* Project.ProjectService;
    // Another machine's work changes only projects its grant covers, and never
    // the scripts this machine runs when it prepares a worktree.
    const work = yield* assertProjectReadable(yield* readCaller(), input.projectId);
    if (work !== undefined && input.scripts !== undefined)
      return yield* new OrchestratorMcpFailure({
        code: "outside_grant_scope",
        message: `Project scripts run on this machine, so only its user changes them; ${work.coordinatorLabel}'s work cannot. Ask the user here to change them in project settings.`,
      });
    // Pause, archive and auto-resume are the user's lifecycle controls; an agent must not lift them.
    const lifecycle = input.workspaceSettings;
    if (input.workspaceRoot !== undefined)
      return yield* new OrchestratorMcpFailure({
        code: "invalid_request",
        message:
          "Moving a project to another folder needs the user's approval: call studio_project_request with action change_folder and workspaceRoot.",
      });
    if (
      lifecycle?.paused !== undefined ||
      lifecycle?.archived !== undefined ||
      lifecycle?.autoResume !== undefined ||
      lifecycle?.workerMachine !== undefined ||
      lifecycle?.workerMachines !== undefined
    )
      return yield* new OrchestratorMcpFailure({
        code: "invalid_request",
        message:
          "Pause, auto-resume and the worker machines are the user's to change in project settings. To archive or restore a project, call studio_project_request; the user approves it.",
      });
    // Which list a project sits in is the person's choice once the project exists:
    // an agent must not hide their project under Automated or lift a check into theirs.
    if (lifecycle?.origin !== undefined)
      return yield* new OrchestratorMcpFailure({
        code: "invalid_request",
        message:
          "Whether a project is listed under Automated is the user's to change from its sidebar menu. Pass origin when you create a check's project instead.",
      });
    // The context labels these the user's own instructions, ranked above agent memory;
    // an agent that could rewrite them could raise its own text to that rank.
    if (lifecycle?.instructions !== undefined)
      return yield* new OrchestratorMcpFailure({
        code: "invalid_request",
        message:
          "Project instructions are the user's to change in project settings. Save what you learned with studio_project_memory_write instead.",
      });
    // Approved folders, repositories and the project kind are the access evidence the
    // personal assistant routes on and what worktree threads may reach; an agent widening
    // them would grant itself projects and folders without the user's card.
    const environment = lifecycle?.environment;
    if (lifecycle?.kind !== undefined || environment !== undefined) {
      const current = Option.getOrUndefined(
        yield* projects.getById(input.projectId).pipe(Effect.mapError(unavailable)),
      )?.workspaceSettings;
      const same = (left: ReadonlyArray<string>, right: ReadonlyArray<string>) =>
        left.length === right.length && left.every((entry) => right.includes(entry));
      const repositoryKeys = (repositories: ReadonlyArray<ProjectRepository>) =>
        repositories.map((repository) =>
          JSON.stringify([repository.id, repository.url, repository.localPath]),
        );
      if (
        (lifecycle?.kind !== undefined && lifecycle.kind !== (current?.kind ?? "code")) ||
        (environment !== undefined &&
          (!same(environment.additionalFolders, current?.environment.additionalFolders ?? []) ||
            !same(
              repositoryKeys(environment.repositories),
              repositoryKeys(current?.environment.repositories ?? []),
            )))
      )
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message:
            lifecycle?.kind !== undefined && lifecycle.kind !== (current?.kind ?? "code")
              ? "A project's kind is fixed when it is created; make a new project of the kind you need."
              : "Agents cannot change approved folders or repositories themselves; the user decides what agents here can reach. To add a folder, call studio_project_request with action add_folder and folder: the user approves it in a card. Repositories and removing a folder are the user's to change in project settings.",
        });
    }
    // The model new threads start on and the coordinator's model, with their effort,
    // Ultracode and context window, are what the person saved. An agent sets one only
    // where none is saved; replacing or clearing a saved one is theirs to approve.
    const coordinatorModel = lifecycle?.coordinatorModelSelection;
    if (input.defaultModelSelection !== undefined || coordinatorModel !== undefined) {
      const project = Option.getOrUndefined(
        yield* projects.getById(input.projectId).pipe(Effect.mapError(unavailable)),
      );
      // A Project settings override is the person's saved thread model too, and a
      // write to the project's field would remove it.
      const settingsService = yield* Effect.serviceOption(ServerSettings.ServerSettingsService);
      // Unreadable settings could hide one, so nothing is written on a guess.
      const settings = Option.isNone(settingsService)
        ? null
        : yield* settingsService.value.getSettings.pipe(Effect.mapError(unavailable));
      for (const [role, next] of [
        ["threads", input.defaultModelSelection],
        ["coordinator", coordinatorModel],
      ] as const) {
        if (next === undefined || project === undefined) continue;
        // On Tracks the track for the task picks the model: a model written to the
        // project would do nothing now and take over unasked if Tracks were turned off.
        if (
          role === "threads" &&
          projectThreadsUseTracks(project, settings) &&
          !sameModelSelection(project.defaultModelSelection, next)
        )
          return yield* new OrchestratorMcpFailure({
            code: "invalid_request",
            message: `New threads in "${project.title}" start from its model tracks, so no single saved model applies and an agent cannot set one. The user edits the tracks, or picks one model, in project settings. To start a thread on a model, pass modelSelection when you launch it.`,
          });
        const current = savedProjectModel(project, role, settings);
        if (current.saved && !sameModelSelection(current.model, next)) {
          const what =
            role === "coordinator" ? "The coordinator model" : "The model new threads start on";
          return yield* new OrchestratorMcpFailure({
            code: "invalid_request",
            message: `${what} of "${project.title}" is the user's saved choice (${describeModelSelection(current.model, [])}), so an agent cannot replace or clear it. To change it, call studio_project_request with action change_model, role "${role}" and modelSelection, naming every option to keep (effort, Ultracode, context window): the user approves it in a card. Clearing it is the user's to do in project settings.`,
          });
        }
        if (next === null) continue;
        // A first model: on a sign-in the caller's grant allows, one value per option.
        if (work !== undefined) yield* assertAccountInGrant(work, next.instanceId);
        const repeated = duplicateOptionIds(next);
        if (repeated.length > 0)
          return yield* new OrchestratorMcpFailure({
            code: "invalid_request",
            message: `Name each model option once; ${repeated.join(", ")} is repeated.`,
          });
      }
    }
    return yield* projects
      .update({ ...input, commandId: yield* newCommandId() })
      .pipe(Effect.mapError(projectFailure));
  });

/** studio_model_preference: list, delete or record the project's learned model rules. */
export const modelPreference = (input: OrchestratorMcpModelPreferenceInput) =>
  Effect.gen(function* () {
    const context = yield* readCaller();
    const projectId = yield* resolveProjectId(context, input.projectId);
    const settingsService = yield* ServerSettings.ServerSettingsService;
    const settings = yield* settingsService.getSettings.pipe(Effect.mapError(unavailable));
    const projectOverrides = settings.projectSettingsOverrides[projectId] ?? {};
    const preferences = projectOverrides.learnedModelPreferences ?? [];
    if (input.action === "list") {
      return {
        action: "list" as const,
        projectId,
        preferences,
      };
    }
    if (input.action === "delete") {
      if (!input.id) {
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message: "Pass id: the rule id to delete.",
        });
      }
      const updated = preferences.filter((pref) => pref.id !== input.id);
      const deleted = updated.length !== preferences.length;
      if (deleted) {
        yield* settingsService
          .updateSettings({
            projectSettingsOverrideChanges: {
              [projectId]: { set: { learnedModelPreferences: updated } },
            },
          })
          .pipe(Effect.mapError(unavailable));
      }
      return {
        action: "delete" as const,
        projectId,
        preferences: updated,
        deleted,
      };
    }
    if (input.action === "record") {
      if (!input.preference) {
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message:
            "Pass preference: {kind: 'prefer', model}, {kind: 'avoid', model}, or {kind: 'lane', lane}.",
        });
      }
      // A rule recorded here is not the person's own choice: it may not
      // send workers to a paid or unknown-billing model they did not allow
      // (routing checks coordinator rules again when one is used).
      if (input.preference.kind === "prefer") {
        const registry = yield* Effect.serviceOption(ProviderRegistry.ProviderRegistry);
        if (Option.isSome(registry)) {
          const providers = yield* registry.value.getProviders;
          const project = yield* (yield* Project.ProjectService)
            .getById(projectId)
            .pipe(Effect.mapError(unavailable));
          const rule = resolveProjectSettings(
            settings,
            projectId,
            Option.getOrUndefined(project),
          ).settings;
          const blocked = learnedPreferenceBillingBlock(input.preference.model, {
            providers,
            lanes: rule.modelLanes,
            policy: rule.taskRouting,
          });
          if (blocked !== null) {
            return yield* new OrchestratorMcpFailure({
              code: "invalid_request",
              message: `Not recorded: ${input.preference.model.model} on ${input.preference.model.instanceId} is ${blocked}. Only the person can send work there, by adding it to a model lane or allowing paid API models in Auto.`,
            });
          }
        }
      }
      const crypto = yield* Crypto.Crypto;
      const id = `pref-${(yield* crypto.randomUUIDv4.pipe(Effect.orDie)).slice(0, 12)}`;
      const now = yield* DateTime.now;
      const recorded: LearnedModelPreference = {
        id,
        keywords: (input.keywords ?? []).map((k) => k.toLowerCase().trim()),
        ...(input.taskClass !== undefined ? { taskClass: input.taskClass } : {}),
        ...(input.lane !== undefined ? { lane: input.lane } : {}),
        action: input.preference,
        ...(input.note !== undefined ? { note: input.note } : {}),
        recordedBy: "coordinator",
        createdAt: DateTime.formatIso(now),
      };
      const updated = withLearnedPreference(preferences, recorded);
      yield* settingsService
        .updateSettings({
          projectSettingsOverrideChanges: {
            [projectId]: { set: { learnedModelPreferences: updated } },
          },
        })
        .pipe(Effect.mapError(unavailable));
      return {
        action: "record" as const,
        projectId,
        preferences: updated,
        recorded,
      };
    }
    return yield* new OrchestratorMcpFailure({
      code: "invalid_request",
      message: `Unknown action: ${(input as { action: string }).action}`,
    });
  });
