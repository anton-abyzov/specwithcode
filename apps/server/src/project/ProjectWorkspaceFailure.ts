/**
 * Turns whatever a project operation failed with into the `ProjectWorkspaceError`
 * the client sees.
 *
 * A command refused because the service is held for an update keeps its own
 * message ("installing an update"), however deeply the dispatch wrapped it;
 * collapsed into "operation failed" it read as a broken project. Every other
 * unexpected failure is logged with the project and operation before it is
 * collapsed, so the log says what went wrong when the person cannot.
 *
 * @module ProjectWorkspaceFailure
 */
import { ProjectWorkspaceError, type ProjectId } from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { ServiceUpdateInProgressError } from "../serviceUpdate/ServiceUpdateHold.ts";

const isProjectWorkspaceError = Schema.is(ProjectWorkspaceError);
const isServiceUpdateInProgressError = Schema.is(ServiceUpdateInProgressError);

// Dispatch errors wrap their cause, and callers may wrap those again.
const MAX_CAUSE_DEPTH = 8;

/** The update refusal behind `error`, following `cause` links, if there is one. */
export function findUpdateRefusal(error: unknown): ServiceUpdateInProgressError | null {
  let current = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth += 1) {
    if (isServiceUpdateInProgressError(current)) return current;
    if (typeof current !== "object" || current === null || !("cause" in current)) return null;
    current = current.cause;
  }
  return null;
}

/** Maps a failure to the error the client sees; `operation` names it in the log. */
export const mapProjectFailure =
  (projectId: ProjectId, operation: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, ProjectWorkspaceError, R> =>
    Effect.catch(effect, (error: E) => {
      if (isProjectWorkspaceError(error)) return Effect.fail(error);
      const refusal = findUpdateRefusal(error);
      if (refusal !== null) {
        return Effect.fail(
          new ProjectWorkspaceError({
            projectId,
            code: "update_in_progress",
            ...(refusal.verifying === true ? { verifying: true } : {}),
          }),
        );
      }
      return Effect.logWarning("project.operation.failed", {
        projectId,
        operation,
        cause: error,
      }).pipe(
        Effect.andThen(
          Effect.fail(new ProjectWorkspaceError({ projectId, code: "operation_failed" })),
        ),
      );
    });
