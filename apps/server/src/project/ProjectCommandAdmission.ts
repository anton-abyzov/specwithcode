import {
  ProjectWorkspaceError,
  type OrchestrationV2ServerCommand,
  type ProjectId,
} from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import type * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import type * as Admission from "./ProjectAdmission.ts";

/** Guards the durable creation boundary, including direct RPC and app-owned child creation.
 * A delegated request commits its child thread and run in the same transaction; delayed
 * provider effects therefore cannot create an unrecorded child after a project deletion.
 */
export function guardProjectCreation<E>(services: {
  admission: Admission.ProjectAdmission["Service"];
  projects: ProjectStore.ProjectStoreV2["Service"];
  projections: Pick<ProjectionStore.ProjectionStoreV2["Service"], "getThreadRecords">;
  reject: (command: OrchestrationV2ServerCommand, error: unknown) => E;
}) {
  return <A, E2, R>(
    command: OrchestrationV2ServerCommand,
    effect: Effect.Effect<A, E2, R>,
  ): Effect.Effect<A, E | E2, R> => {
    if (
      command.type !== "thread.create" &&
      command.type !== "thread.fork" &&
      command.type !== "delegated_task.request" &&
      command.type !== "thread.delete" &&
      command.type !== "thread.archive"
    )
      return effect;
    const projectId: Effect.Effect<ProjectId, E> =
      command.type === "thread.create"
        ? Effect.succeed(command.projectId)
        : services.projections
            .getThreadRecords(
              command.type === "thread.fork"
                ? command.sourceThreadId
                : command.type === "thread.delete" || command.type === "thread.archive"
                  ? command.threadId
                  : command.parentThreadId,
              [],
            )
            .pipe(
              Effect.map((records) => records.thread.projectId),
              Effect.mapError((error) => services.reject(command, error)),
            );
    return Effect.flatMap(projectId, (id) =>
      services.admission.withLock(
        id,
        services.projects.get(id).pipe(
          Effect.mapError((error) => services.reject(command, error)),
          Effect.flatMap((project) => {
            if (command.type === "thread.delete" || command.type === "thread.archive") {
              // Archiving the coordinator would lock the project behind a misleading "archived" error.
              return Option.isSome(project) &&
                project.value.workspaceSettings?.coordinatorThreadId === command.threadId
                ? Effect.fail(
                    services.reject(
                      command,
                      command.type === "thread.delete"
                        ? "The project coordinator is retained. Delete the project from project settings, or resolve this thread."
                        : "The project coordinator is retained. Archive the project from project settings, or resolve this thread.",
                    ),
                  )
                : Effect.void;
            }
            const code =
              Option.isNone(project) || project.value.deletedAt !== null
                ? "not_found"
                : project.value.workspaceSettings?.archived
                  ? "archived"
                  : project.value.workspaceSettings?.paused
                    ? "paused"
                    : null;
            return code === null
              ? Effect.void
              : Effect.fail(
                  services.reject(command, new ProjectWorkspaceError({ projectId: id, code })),
                );
          }),
          Effect.andThen(effect),
        ),
      ),
    );
  };
}
