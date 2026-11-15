/**
 * Office artifacts for agents: a thread saves and reads the sheets of its own
 * project, and no other project's.
 */
import { ProjectLibraryError, type ProjectId, type ThreadId } from "@specweave-studio/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import { type SavedSheet, readSheetArtifact, writeSheetArtifact } from "./OfficeArtifacts.ts";
import { ProjectLibraryProblem } from "./ProjectLibrary.ts";

export class OfficeArtifactService extends Context.Service<
  OfficeArtifactService,
  {
    readonly writeSheet: (input: {
      readonly projectId: ProjectId;
      readonly threadId: ThreadId;
      readonly sheet: unknown;
      readonly name?: string | undefined;
      readonly merge?: boolean | undefined;
    }) => Effect.Effect<SavedSheet, ProjectLibraryError>;
    readonly readSheet: (input: {
      readonly projectId: ProjectId;
      readonly threadId: ThreadId;
      readonly name: string;
    }) => Effect.Effect<SavedSheet, ProjectLibraryError>;
  }
>()("specweave-studio/project/OfficeArtifactService") {}

export const make = Effect.gen(function* () {
  const projects = yield* ProjectStore.ProjectStoreV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;

  const failure =
    (projectId: ProjectId) =>
    (error: unknown): ProjectLibraryError =>
      Schema.is(ProjectLibraryError)(error)
        ? error
        : error instanceof ProjectLibraryProblem
          ? new ProjectLibraryError({ projectId, code: error.code, detail: error.message })
          : new ProjectLibraryError({
              projectId,
              code: "operation_failed",
              detail: "The sheet could not be read or saved. Try again.",
            });

  /** The project's folder, checking the thread belongs to that project. */
  const locate = (projectId: ProjectId, threadId: ThreadId) =>
    Effect.gen(function* () {
      const notFound = new ProjectLibraryError({
        projectId,
        code: "not_found",
        detail: "This thread is no longer in the project.",
      });
      const project = yield* projects.get(projectId);
      if (Option.isNone(project)) return yield* notFound;
      const thread = yield* projections.getThreadShell(threadId);
      if (thread === null || thread.projectId !== projectId) return yield* notFound;
      // Artifacts live in the project folder, not a thread's worktree: the shelf,
      // the Library and the viewer all read them there.
      return project.value.workspaceRoot;
    }).pipe(Effect.mapError(failure(projectId)));

  return OfficeArtifactService.of({
    writeSheet: (input) =>
      locate(input.projectId, input.threadId).pipe(
        Effect.flatMap((workspaceRoot) =>
          Effect.tryPromise({
            try: () =>
              writeSheetArtifact(workspaceRoot, input.sheet, {
                name: input.name,
                merge: input.merge,
              }),
            catch: failure(input.projectId),
          }),
        ),
      ),
    readSheet: (input) =>
      locate(input.projectId, input.threadId).pipe(
        Effect.flatMap((workspaceRoot) =>
          Effect.tryPromise({
            try: () => readSheetArtifact(workspaceRoot, input.name),
            catch: failure(input.projectId),
          }),
        ),
      ),
  });
});

export const layer = Layer.effect(OfficeArtifactService, make);
