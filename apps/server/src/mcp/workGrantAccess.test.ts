import { projectFixture } from "../project/ProjectWorkspace.testkit.ts";
import { describe, expect, it } from "@effect/vitest";
import {
  DEFAULT_PROJECT_WORKSPACE_SETTINGS,
  EnvironmentId,
  ProjectId,
  type ProjectCoordinatorBinding,
  ThreadId,
} from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as WorkGrants from "../fleet/WorkGrants.ts";
import * as Project from "../project/ProjectService.ts";
import { assertThreadWritable, type WorkGrantContext } from "./workGrantAccess.ts";

/** This machine is the Minis; M4 runs the other coordinator of the same linked project. */
const MINIS = EnvironmentId.make("env-minis");
const M4 = EnvironmentId.make("env-m4");
const project = ProjectId.make("easychamp-minis");

const linked = (coordinatorBinding?: ProjectCoordinatorBinding, members = 2) =>
  projectFixture(project, {
    title: "EasyChamp",
    workspaceSettings: {
      ...DEFAULT_PROJECT_WORKSPACE_SETTINGS,
      ...(coordinatorBinding ? { coordinatorBinding } : {}),
      logicalProject: {
        id: "logical:easychamp",
        title: "EasyChamp",
        coordinatorId: "coordinator",
        members: [
          {
            environmentId: M4,
            projectId: ProjectId.make("easychamp-m4"),
            coordinatorThreadId: ThreadId.make("project-coordinator:easychamp-m4"),
          },
          {
            environmentId: MINIS,
            projectId: project,
            coordinatorThreadId: ThreadId.make(`project-coordinator:${project}`),
          },
        ].slice(0, members),
      },
    },
  });

const fromM4: WorkGrantContext = {
  grant: { coordinatorEnvironmentId: M4 } as WorkGrantContext["grant"],
  origin: undefined,
  coordinatorLabel: "M4",
};

const check = (
  current: ReturnType<typeof linked>,
  threadId: string,
  origins: Record<string, EnvironmentId> = {},
) =>
  Effect.exit(
    assertThreadWritable(fromM4, {
      id: ThreadId.make(threadId),
      projectId: project,
      lineage: { rootThreadId: ThreadId.make(threadId), parentThreadId: null },
    } as never).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.mock(Project.ProjectService)({
            getById: () => Effect.succeed(Option.some(current)),
          }),
          Layer.succeed(WorkGrants.WorkGrants, {
            ...(WorkGrants.WorkGrants.defaultValue() as WorkGrants.WorkGrantsShape),
            originOf: (thread) =>
              Effect.succeed(
                origins[thread.id] === undefined
                  ? undefined
                  : { coordinatorEnvironmentId: origins[thread.id]!, path: [], hops: 1 },
              ),
          }),
        ),
      ),
    ),
  );

const refusal = (exit: Exit.Exit<unknown, unknown>) => {
  expect(Exit.isFailure(exit)).toBe(true);
  const error = Exit.isFailure(exit) ? exit.cause : undefined;
  const failure = JSON.stringify(error);
  expect(failure).toContain("outside_grant_scope");
  return failure;
};

describe("assertThreadWritable", () => {
  it.effect(
    "lets the other machine's coordinator steer only the threads its own work started here",
    () =>
      Effect.gen(function* () {
        const active = linked({ epoch: 3, state: "active", operationId: "start-op" });
        expect(
          Exit.isSuccess(yield* check(active, "worker-from-m4", { "worker-from-m4": M4 })),
        ).toBe(true);
        const local = refusal(yield* check(active, "started-on-minis"));
        expect(local).toContain("may read it but not send to");
        refusal(yield* check(active, `project-coordinator:${project}`));
        refusal(yield* check(active, "from-m1", { "from-m1": EnvironmentId.make("env-m1") }));
        // The coordinator thread is never M4's to steer, even if an origin names M4.
        refusal(
          yield* check(active, `project-coordinator:${project}`, {
            [`project-coordinator:${project}`]: M4,
          }),
        );
        // A legacy kept copy (no binding) runs its own coordinator too.
        refusal(yield* check(linked(undefined), "started-on-minis"));
      }),
  );

  it.effect(
    "keeps the single-coordinator rules where this copy runs no coordinator or is not linked",
    () =>
      Effect.gen(function* () {
        const relinquished = linked({
          epoch: 0,
          state: "transferred",
          operationId: "link-op",
        });
        expect(Exit.isSuccess(yield* check(relinquished, "started-on-minis"))).toBe(true);
        expect(Exit.isSuccess(yield* check(linked(undefined, 1), "started-on-minis"))).toBe(true);
        const unlinked = projectFixture(project, { title: "EasyChamp" });
        expect(Exit.isSuccess(yield* check(unlinked, "started-on-minis"))).toBe(true);
      }),
  );
});
