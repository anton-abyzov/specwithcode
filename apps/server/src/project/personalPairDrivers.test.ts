import { assert, describe, it } from "@effect/vitest";
import {
  DEFAULT_PROJECT_WORKSPACE_SETTINGS,
  EnvironmentId,
  type Project,
  ProjectId,
  ThreadId,
} from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";

import {
  fallbackPersonalPairRole,
  personalPairRole,
  personalPairRoles,
} from "./personalPairDrivers.ts";

const desktop = EnvironmentId.make("env-desktop");
const laptop = EnvironmentId.make("env-laptop");
const tower = EnvironmentId.make("env-tower");

describe("personalPairRole", () => {
  it("both can call: the lower id drives, the other reads", () => {
    const both = { selfCanCall: true, peerCanCall: true };
    assert.strictEqual(personalPairRole(desktop, laptop, both), "drive");
    assert.strictEqual(personalPairRole(laptop, desktop, both), "read");
  });
  it("one way: the side that can call drives, the other skips the pair", () => {
    assert.strictEqual(
      personalPairRole(laptop, desktop, { selfCanCall: true, peerCanCall: false }),
      "drive",
    );
    assert.strictEqual(
      personalPairRole(desktop, laptop, { selfCanCall: false, peerCanCall: true }),
      null,
    );
  });
  it("no grant either way, or the same machine: nobody takes part", () => {
    assert.isNull(personalPairRole(desktop, laptop, { selfCanCall: false, peerCanCall: false }));
    assert.isNull(personalPairRole(desktop, desktop, { selfCanCall: true, peerCanCall: true }));
  });
  it("without reach, the lower id drives as before", () => {
    assert.strictEqual(fallbackPersonalPairRole(desktop, laptop), "drive");
    assert.strictEqual(fallbackPersonalPairRole(laptop, desktop), "read");
  });
});

describe("personalPairRoles", () => {
  const project = (kind: "personal" | "project", members: ReadonlyArray<EnvironmentId>) =>
    ({
      id: ProjectId.make(`p-${kind}`),
      deletedAt: null,
      workspaceSettings: {
        ...DEFAULT_PROJECT_WORKSPACE_SETTINGS,
        kind,
        logicalProject: {
          id: "logical:x",
          title: "X",
          coordinatorId: ThreadId.make("t"),
          members: members.map((environmentId) => ({
            environmentId,
            projectId: ProjectId.make(`p-${environmentId}`),
            coordinatorThreadId: ThreadId.make(`t-${environmentId}`),
          })),
        },
      },
    }) as unknown as Project;

  it.effect("reads each personal peer once and leaves ordinary projects alone", () =>
    Effect.gen(function* () {
      const asked: string[] = [];
      const roles = yield* personalPairRoles(
        desktop,
        [project("personal", [desktop, laptop]), project("project", [desktop, tower])],
        (peer) =>
          Effect.sync(() => {
            asked.push(peer);
            return { selfCanCall: true, peerCanCall: true };
          }),
      );
      assert.deepStrictEqual(asked, [laptop]);
      assert.deepStrictEqual([...roles], [[laptop, "drive"]]);
    }),
  );
});
