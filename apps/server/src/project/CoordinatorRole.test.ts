import { type Project, ProjectId } from "@specweave-studio/contracts";
import { afterEach, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import {
  CoordinatorRole,
  coordinatorRoleOf,
  layer as CoordinatorRoleLayer,
} from "./CoordinatorRole.ts";
import { removeCheckouts } from "./ProjectLink.testkit.ts";
import * as ProjectService from "./ProjectService.ts";

afterEach(removeCheckouts);

const standbyId = "55555555-5555-4555-8555-555555555555";
const takeoverId = "66666666-6666-4666-8666-666666666666";

const project = (settings?: Partial<NonNullable<Project["workspaceSettings"]>>) =>
  ({
    id: ProjectId.make("easychamp"),
    deletedAt: null,
    workspaceSettings: settings,
  }) as unknown as Project;

describe("coordinatorRoleOf", () => {
  it("counts a copy with no binding, linked or not, as active at epoch 0", () => {
    expect(coordinatorRoleOf(project())).toEqual({
      projectId: "easychamp",
      logicalProjectId: null,
      active: true,
      epoch: 0,
      state: "active",
    });
  });

  it("follows the copy's own binding", () => {
    const linked = { id: "logical:easychamp", members: [] } as never;
    expect(
      coordinatorRoleOf(
        project({ logicalProject: linked, coordinatorBinding: { epoch: 3, state: "active" } }),
      ),
    ).toMatchObject({ logicalProjectId: "logical:easychamp", active: true, epoch: 3 });
    expect(
      coordinatorRoleOf(
        project({ logicalProject: linked, coordinatorBinding: { epoch: 4, state: "transferred" } }),
      ),
    ).toMatchObject({ active: false, epoch: 4, state: "transferred" });
    expect(
      coordinatorRoleOf(project({ coordinatorBinding: { epoch: 2, state: "transferring" } })),
    ).toMatchObject({ active: false, state: "transferring" });
  });
});

describe("CoordinatorRole", () => {
  it.effect("reads no role for a project this machine lacks or deleted", () =>
    Effect.gen(function* () {
      const role = yield* CoordinatorRole;
      expect(Option.getOrUndefined(yield* role.roleOf(ProjectId.make("easychamp")))).toMatchObject({
        active: true,
        epoch: 0,
      });
      expect(Option.isNone(yield* role.roleOf(ProjectId.make("gone")))).toBe(true);
      expect(Option.isNone(yield* role.roleOf(ProjectId.make("missing")))).toBe(true);
    }).pipe(
      Effect.provide(
        CoordinatorRoleLayer.pipe(
          Layer.provide(
            Layer.succeed(ProjectService.ProjectService, {
              getById: (projectId: ProjectId) =>
                Effect.succeed(
                  projectId === "easychamp"
                    ? Option.some(project())
                    : projectId === "gone"
                      ? Option.some({ ...project(), deletedAt: "2026-10-26T00:00:00.000Z" })
                      : Option.none(),
                ),
            } as unknown as ProjectService.ProjectService["Service"]),
          ),
        ),
      ),
    ),
  );
});
