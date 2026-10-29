import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { EnvironmentId, ProjectId, ThreadId } from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as OrchestrationEventStore from "../persistence/OrchestrationEventStore.ts";
import * as CoordinatorReplicas from "./CoordinatorReplicas.ts";
import * as LinkedMemoryHistory from "./LinkedMemoryHistory.ts";
import { recordMemoryWrite } from "./linkedMemoryMerge.ts";
import * as ProjectLinkStateCleanup from "./ProjectLinkStateCleanup.ts";

const deletedEarlier = ProjectId.make("deleted-earlier");
const live = ProjectId.make("live");
const deletedNow = ProjectId.make("deleted-now");

const replica = (projectId: ProjectId) => ({
  from: {
    environmentId: EnvironmentId.make("env-peer"),
    projectId,
    coordinatorThreadId: ThreadId.make(`coordinator:${projectId}`),
  },
  logicalProjectId: "logical:cleanup",
  digest: "digest",
  replicatedAt: "2026-10-28T00:00:00.000Z",
  goal: "",
  instructions: "",
  notes: [],
  notesTruncated: false,
});

const stores = Layer.mergeAll(LinkedMemoryHistory.layer, CoordinatorReplicas.layer).pipe(
  Layer.provideMerge(
    Layer.fresh(ServerConfig.layerTest("/tmp", { prefix: "studio-link-cleanup-" })),
  ),
  Layer.provideMerge(NodeServices.layer),
);

it.layer(stores)("deleted project linked state", (it) => {
  it.effect("removes a deleted project's memory versions and replica, now and at startup", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const histories = yield* LinkedMemoryHistory.LinkedMemoryHistory;
        const replicas = yield* CoordinatorReplicas.CoordinatorReplicas;
        const seed = (projectId: ProjectId) =>
          Effect.gen(function* () {
            yield* histories.modify(projectId, (state) =>
              recordMemoryWrite(state, {
                name: "notes.md",
                previous: undefined,
                hash: LinkedMemoryHistory.memoryContentHash("notes"),
                authoredAt: "2026-10-28T00:00:00.000Z",
              }),
            );
            yield* replicas.write(projectId, replica(projectId));
          });
        const kept = (projectId: ProjectId) =>
          Effect.gen(function* () {
            const history = yield* histories.read(projectId);
            return {
              history: history.files["notes.md"] !== undefined,
              replica: Option.isSome(yield* replicas.read(projectId)),
            };
          });
        for (const projectId of [deletedEarlier, live, deletedNow]) yield* seed(projectId);

        const events = yield* Queue.unbounded<unknown>();
        yield* Layer.build(
          ProjectLinkStateCleanup.layer.pipe(
            Layer.provide(
              Layer.mergeAll(
                Layer.succeed(LinkedMemoryHistory.LinkedMemoryHistory, histories),
                Layer.succeed(CoordinatorReplicas.CoordinatorReplicas, replicas),
                Layer.succeed(ProjectStore.ProjectStoreV2, {
                  list: () =>
                    Effect.succeed([
                      { projectId: deletedEarlier, deletedAt: "2026-10-27T00:00:00.000Z" },
                      { projectId: live, deletedAt: null },
                    ]),
                } as unknown as ProjectStore.ProjectStoreV2["Service"]),
                Layer.succeed(OrchestrationEventStore.OrchestrationEventStore, {
                  latestApplicationSequence: Effect.succeed(7),
                  streamApplicationEvents: () => Stream.fromQueue(events),
                } as unknown as OrchestrationEventStore.OrchestrationEventStore["Service"]),
              ),
            ),
          ),
        );
        const settled = (projectId: ProjectId, expected: boolean) =>
          Effect.gen(function* () {
            for (let attempt = 0; attempt < 200; attempt += 1) {
              // A read can race the removal it is waiting for; that attempt just repeats.
              const state = yield* kept(projectId).pipe(Effect.option);
              if (
                Option.isSome(state) &&
                state.value.history === expected &&
                state.value.replica === expected
              )
                return;
              yield* Effect.yieldNow;
            }
          });

        yield* settled(deletedEarlier, false);
        assert.deepStrictEqual(yield* kept(deletedEarlier), { history: false, replica: false });
        assert.deepStrictEqual(yield* kept(deletedNow), { history: true, replica: true });

        yield* Queue.offer(events, {
          aggregateKind: "project",
          aggregateId: deletedNow,
          type: "project.deleted",
        });
        yield* settled(deletedNow, false);
        assert.deepStrictEqual(yield* kept(deletedNow), { history: false, replica: false });
        assert.deepStrictEqual(yield* kept(live), { history: true, replica: true });

        // Removing again, or a project that never had state, is not an error.
        yield* histories.remove(deletedNow);
        yield* replicas.remove(ProjectId.make("never-linked"));
      }),
    ),
  );
});
