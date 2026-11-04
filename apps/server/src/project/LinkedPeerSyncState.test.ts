import { assert, describe, it } from "@effect/vitest";
import { EnvironmentId, ProjectId } from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";

import * as LinkedPeerSyncState from "./LinkedPeerSyncState.ts";

const pair = (project: string, peer: string) => ({
  projectId: ProjectId.make(project),
  peerEnvironmentId: EnvironmentId.make(peer),
  peerProjectId: ProjectId.make(`${project}-on-${peer}`),
});

describe("LinkedPeerSyncState", () => {
  it.effect("expedite resets only that project's pairs and wakes the loop", () =>
    Effect.gen(function* () {
      const state = yield* LinkedPeerSyncState.make;
      const mine = pair("p1", "m3");
      const other = pair("p2", "m3");
      const failed = [{ kind: "replica" as const, error: "refused" as const }];
      yield* state.record(mine, 1_000, failed);
      yield* state.record(other, 1_000, failed);
      assert.isFalse(yield* state.due(mine, 1_001));
      const woken = yield* state.nextWake;
      const waiting = yield* Effect.forkChild(woken);
      yield* state.expedite(mine.projectId);
      yield* Fiber.join(waiting);
      assert.isTrue(yield* state.due(mine, 1_001));
      assert.isFalse(yield* state.due(other, 1_001));
    }),
  );
});
