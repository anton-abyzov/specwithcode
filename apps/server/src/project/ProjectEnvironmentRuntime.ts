import { stringifyJson } from "../json.ts";
import * as Schema from "effect/Schema";
import {
  DEFAULT_PROJECT_ENVIRONMENT,
  projectExecutionIsFenced,
  ProjectWorkspaceError,
  type Project,
  ProjectEnvironmentError,
  fullAccessAcpProjectFolders,
  providerEnforcesProjectFolders,
  type ProjectId,
} from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Option from "effect/Option";
import {
  ProviderAdapterTurnStartError,
  type ProviderAdapterV2SessionRuntime,
  type ProviderAdapterV2TurnInput,
  type ProviderAdapterV2Event,
} from "../orchestration-v2/ProviderAdapter.ts";
import {
  type ProjectEnvironmentProblem,
  resolveProjectEnvironmentForRun,
} from "./ProjectEnvironmentPaths.ts";
import { worktreeSetManifestPath } from "../worktreeSet.ts";

/** Capture filesystem services once; dispatch effects run after layer construction. */
export const makeEnvironmentRuntime = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  return <E>(
    session: ProviderAdapterV2SessionRuntime,
    read: (projectId: ProjectId) => Effect.Effect<Option.Option<Project>, E>,
    /** Told once per turn which saved entries this turn skipped, so the run can show it. */
    skipped: (
      input: ProviderAdapterV2TurnInput,
      problems: ReadonlyArray<ProjectEnvironmentProblem>,
    ) => Effect.Effect<void> = () => Effect.void,
  ): ProviderAdapterV2SessionRuntime => {
    const start = (input: ProviderAdapterV2TurnInput, compact = false, prepare = false) =>
      Effect.gen(function* () {
        const found = yield* read(input.appThread.projectId);
        if (Option.isNone(found))
          return yield* new ProjectEnvironmentError({
            projectId: input.appThread.projectId,
            code: "not_found",
          });
        const project = found.value;
        if (projectExecutionIsFenced(project.workspaceSettings, project.id, input.threadId))
          return yield* new ProjectWorkspaceError({ projectId: project.id, code: "transferred" });
        const environment = project.workspaceSettings?.environment ?? DEFAULT_PROJECT_ENVIRONMENT;
        const emptyEnvironment =
          environment.additionalFolders.length === 0 && environment.repositories.length === 0;
        // A thread in a folder of its own (worktreeSet.ts) reads the project folder: its
        // repositories and instruction files are there, not in the thread's folder.
        const cwd = input.runtimePolicy.cwd;
        const ownFolder =
          emptyEnvironment &&
          typeof cwd === "string" &&
          cwd !== project.workspaceRoot &&
          (yield* fs
            .exists(worktreeSetManifestPath(cwd, path))
            .pipe(Effect.orElseSucceed(() => false))) &&
          // Only where the provider can take a folder; otherwise the turn runs as it did.
          (providerEnforcesProjectFolders(session.driver) ||
            (session.driver === "acpRegistry" &&
              fullAccessAcpProjectFolders(input.runtimePolicy))) &&
          !(
            session.driver === "codex" &&
            typeof input.runtimePolicy.sandboxPolicy === "object" &&
            input.runtimePolicy.sandboxPolicy !== null &&
            "type" in input.runtimePolicy.sandboxPolicy &&
            input.runtimePolicy.sandboxPolicy.type === "externalSandbox"
          );
        // Empty legacy environments retain existing provider behavior and need no filesystem probe.
        if (emptyEnvironment && !ownFolder)
          return yield* prepare
            ? session.prepareTurn!(input)
            : compact && session.compactThread
              ? session.compactThread(input)
              : session.startTurn(input);
        // One unusable entry never fails the turn: it is skipped and named, and a moved
        // folder is never followed to where it now leads. Only an execution folder that
        // is gone or now leads elsewhere fails.
        const resolved = yield* resolveProjectEnvironmentForRun(
          project.id,
          project.workspaceRoot,
          environment,
        ).pipe(
          // A stored folder that no longer resolves is the same event: it moved after approval.
          Effect.mapError((error) =>
            error.code === "path_not_approved"
              ? new ProjectEnvironmentError({
                  projectId: project.id,
                  code: "folder_changed",
                  detail: error.detail,
                })
              : error,
          ),
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, path),
        );
        if (resolved.workspaceRoot !== project.workspaceRoot)
          return yield* new ProjectEnvironmentError({
            projectId: project.id,
            code: "folder_changed",
            detail: `The project folder ${project.workspaceRoot} now leads to ${resolved.workspaceRoot}. Move the project to its new folder in project settings.`,
          });
        const directories = [
          ...(input.runtimePolicy.cwd === resolved.workspaceRoot ? [] : [resolved.workspaceRoot]),
          ...resolved.additionalFolders,
        ];
        const unrestrictedAcp =
          session.driver === "acpRegistry" && fullAccessAcpProjectFolders(input.runtimePolicy);
        if (
          directories.length > 0 &&
          ((!providerEnforcesProjectFolders(session.driver) && !unrestrictedAcp) ||
            (session.driver === "codex" &&
              typeof input.runtimePolicy.sandboxPolicy === "object" &&
              input.runtimePolicy.sandboxPolicy !== null &&
              "type" in input.runtimePolicy.sandboxPolicy &&
              input.runtimePolicy.sandboxPolicy.type === "externalSandbox"))
        )
          return yield* new ProjectEnvironmentError({
            projectId: project.id,
            code: "unsupported_provider",
          });
        if (resolved.problems.length > 0 && !prepare) yield* skipped(input, resolved.problems);
        const next = {
          ...input,
          projectAdditionalDirectories: directories,
          message:
            unrestrictedAcp && directories.length > 0
              ? {
                  ...input.message,
                  text: `Approved project folders (paths only; existing permissions apply): ${stringifyJson(directories)}\n\n${input.message.text}`,
                }
              : input.message,
        };
        return yield* prepare
          ? session.prepareTurn!(next)
          : compact && session.compactThread
            ? session.compactThread(next)
            : session.startTurn(next);
      }).pipe(
        Effect.mapError((cause) =>
          Schema.is(ProviderAdapterTurnStartError)(cause)
            ? cause
            : new ProviderAdapterTurnStartError({
                driver: session.driver,
                threadId: input.threadId,
                providerThreadId: input.providerThread.id,
                runId: input.runId,
                cause,
              }),
        ),
      );
    return {
      ...session,
      startTurn: (input) => start(input).pipe(Effect.asVoid),
      ...(session.prepareTurn === undefined
        ? {}
        : {
            prepareTurn: (input: ProviderAdapterV2TurnInput) =>
              start(input, false, true).pipe(
                Effect.map((events): ReadonlyArray<ProviderAdapterV2Event> => events ?? []),
              ),
          }),
      ...(session.compactThread
        ? {
            compactThread: (input: ProviderAdapterV2TurnInput) =>
              start(input, true).pipe(Effect.asVoid),
          }
        : {}),
    };
  };
});
