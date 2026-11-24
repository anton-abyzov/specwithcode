/**
 * The window's linked memory RPCs (1448 D-13): `projectLink.memoryExport` and
 * `projectLink.memoryMerge` refuse a personal assistant, whose memory moves
 * only between the owner's servers under the share rules, and pass every
 * other project to the memory service as before.
 */
import { assert, describe, it } from "@effect/vitest";
import {
  EnvironmentId,
  type LinkedMemoryExport,
  type Project,
  ProjectId,
  type ProjectLinkError,
} from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { windowMemoryHandlers } from "./ProjectLink.ts";

const PERCY = ProjectId.make("percy-laptop");
const CODE = ProjectId.make("shop-laptop");
const PEER = EnvironmentId.make("env-desktop");

const projectOf = (id: ProjectId, kind: "personal" | "code"): Project =>
  ({
    id,
    title: id,
    deletedAt: null,
    workspaceSettings: { kind, logicalProject: { id: `logical:${id}`, members: [] } },
  }) as unknown as Project;

const harness = () => {
  const calls: string[] = [];
  const stored = new Map([
    [PERCY, projectOf(PERCY, "personal")],
    [CODE, projectOf(CODE, "code")],
  ]);
  const handlers = windowMemoryHandlers(
    {
      memoryExport: (input) =>
        Effect.sync(() => {
          calls.push(`export ${input.projectId}`);
          return {
            environmentId: PEER,
            files: [],
            tombstones: [],
          } as unknown as LinkedMemoryExport;
        }),
      memoryMerge: (input) =>
        Effect.sync(() => {
          calls.push(`merge ${input.projectId}`);
          return {} as never;
        }),
    },
    { getById: (id) => Effect.succeed(Option.fromNullishOr(stored.get(id))) },
  );
  return { handlers, calls };
};

const mergeInput = (projectId: ProjectId) => ({
  projectId,
  peer: { environmentId: PEER, projectId: ProjectId.make("other-seat"), label: "Desktop" },
  export: { environmentId: PEER, files: [], tombstones: [] } as unknown as LinkedMemoryExport,
});

describe("windowMemoryHandlers", () => {
  it.effect("refuses to export or merge a personal assistant's memory through a window", () =>
    Effect.gen(function* () {
      const { handlers, calls } = harness();
      const exported = yield* Effect.flip(handlers.memoryExport({ projectId: PERCY }));
      const merged = yield* Effect.flip(handlers.memoryMerge(mergeInput(PERCY)));
      for (const error of [exported, merged])
        assert.strictEqual((error as ProjectLinkError).code, "not_code_project");
      assert.deepStrictEqual(calls, []);
    }),
  );

  it.effect(
    "passes a code project, and one this machine does not have, to the memory service",
    () =>
      Effect.gen(function* () {
        const { handlers, calls } = harness();
        yield* handlers.memoryExport({ projectId: CODE });
        yield* handlers.memoryMerge(mergeInput(CODE));
        const missing = ProjectId.make("elsewhere");
        yield* handlers.memoryExport({ projectId: missing });
        assert.deepStrictEqual(calls, [`export ${CODE}`, `merge ${CODE}`, `export ${missing}`]);
      }),
  );
});
