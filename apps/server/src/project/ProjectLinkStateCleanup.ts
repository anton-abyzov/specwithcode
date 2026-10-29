import type { ProjectId } from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as OrchestrationEventStore from "../persistence/OrchestrationEventStore.ts";
import { forkParked } from "../serverActivation.ts";
import * as CoordinatorReplicas from "./CoordinatorReplicas.ts";
import * as LinkedMemoryHistory from "./LinkedMemoryHistory.ts";

/**
 * A deleted project's linked-memory versions and coordinator replica are
 * files in the state directory, outside the database the deletion clears.
 * They go once the deletion commits, and at startup for projects deleted
 * while this watch was not running, so no stale state outlives a project.
 */
export const make = Effect.gen(function* () {
  const events = yield* OrchestrationEventStore.OrchestrationEventStore;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const histories = yield* LinkedMemoryHistory.LinkedMemoryHistory;
  const replicas = yield* CoordinatorReplicas.CoordinatorReplicas;

  const forget = (projectId: ProjectId) =>
    Effect.all([histories.remove(projectId), replicas.remove(projectId)], { discard: true }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Could not remove a deleted project's linked state", {
          projectId,
          cause,
        }),
      ),
    );

  yield* forkParked(
    Effect.gen(function* () {
      const after = yield* events.latestApplicationSequence;
      const deleted = yield* projects.list({ includeDeleted: true });
      for (const project of deleted)
        if (project.deletedAt !== null) yield* forget(project.projectId);
      yield* Stream.runForEach(events.streamApplicationEvents({ afterSequence: after }), (event) =>
        "aggregateKind" in event && event.type === "project.deleted"
          ? forget(event.aggregateId)
          : Effect.void,
      );
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Deleted project linked-state cleanup stopped", { cause }),
      ),
    ),
  );
});

export const layer = Layer.effectDiscard(make);
