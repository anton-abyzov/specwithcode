import { stringifyJson } from "../json.ts";
import * as Schema from "effect/Schema";
import {
  DEFAULT_PROJECT_ENVIRONMENT,
  projectExecutionIsFenced,
  ProjectWorkspaceError,
  type Project,
  ProjectEnvironmentError,
  fullAccessAcpProjectFolders,
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
} from "../orchestration-v2/ProviderAdapter.ts";
import { resolveProjectEnvironment } from "./ProjectEnvironmentPaths.ts";

/** Capture filesystem services once; dispatch effects run after layer construction. */
export const makeEnvironmentRuntime = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  return <E>(
    session: ProviderAdapterV2SessionRuntime,
    read: (projectId: ProjectId) => Effect.Effect<Option.Option<Project>, E>,
  ): ProviderAdapterV2SessionRuntime => {
    const start = (input: ProviderAdapterV2TurnInput, compact = false) =>
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
        // Empty legacy environments retain existing provider behavior and need no filesystem probe.
        if (environment.additionalFolders.length === 0 && environment.repositories.length === 0)
          return yield* compact && session.compactThread
            ? session.compactThread(input)
            : session.startTurn(input);
        const resolved = yield* resolveProjectEnvironment(
          project.id,
          project.workspaceRoot,
          environment,
        ).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, path),
        );
        if (
          resolved.workspaceRoot !== project.workspaceRoot ||
          resolved.additionalFolders.some(
            (folder, index) => folder !== environment.additionalFolders[index],
          )
        )
          return yield* new ProjectEnvironmentError({
            projectId: project.id,
            code: "path_not_approved",
          });
        const directories = [
          ...(input.runtimePolicy.cwd === resolved.workspaceRoot ? [] : [resolved.workspaceRoot]),
          ...resolved.additionalFolders,
        ];
        const unrestrictedAcp =
          session.driver === "acpRegistry" && fullAccessAcpProjectFolders(input.runtimePolicy);
        if (
          directories.length > 0 &&
          ((session.driver !== "codex" && session.driver !== "claudeAgent" && !unrestrictedAcp) ||
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
        return yield* compact && session.compactThread
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
      startTurn: (input) => start(input),
      ...(session.compactThread
        ? { compactThread: (input: ProviderAdapterV2TurnInput) => start(input, true) }
        : {}),
    };
  };
});
