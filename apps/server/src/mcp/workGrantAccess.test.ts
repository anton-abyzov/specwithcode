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
  work: WorkGrantContext = fromM4,
) =>
  Effect.exit(
    assertThreadWritable(work, {
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

  it.effect("keeps taking the project coordinator's work where this copy runs no coordinator", () =>
    Effect.gen(function* () {
      const relinquished = linked({
        epoch: 0,
        state: "transferred",
        operationId: "link-op",
      });
      expect(Exit.isSuccess(yield* check(relinquished, "started-on-minis"))).toBe(true);
    }),
  );

  // Review round 3: steering this machine's own work in a project that is not
  // linked would run it outside the grant's routines, sign-ins and revocation.
  it.effect("steers only its own work's threads in a project that is not linked", () =>
    Effect.gen(function* () {
      for (const current of [
        linked(undefined, 1),
        projectFixture(project, { title: "EasyChamp" }),
      ]) {
        const local = refusal(yield* check(current, "started-on-minis"));
        expect(local).toContain("may read it but not send to");
        refusal(yield* check(current, `project-coordinator:${project}`));
        refusal(yield* check(current, "from-m1", { "from-m1": EnvironmentId.make("env-m1") }));
        expect(
          Exit.isSuccess(yield* check(current, "worker-from-m4", { "worker-from-m4": M4 })),
        ).toBe(true);
      }
    }),
  );

  // Review round 4: the owner's own machines, kept as legacy grants on update,
  // keep steering this machine's threads as they did before grants existed.
  it.effect("lets a legacy grant steer this machine's threads outside linked projects", () =>
    Effect.gen(function* () {
      const legacy: WorkGrantContext = {
        ...fromM4,
        grant: { coordinatorEnvironmentId: M4, legacy: true } as WorkGrantContext["grant"],
      };
      const unlinked = projectFixture(project, { title: "EasyChamp" });
      for (const current of [linked(undefined, 1), unlinked]) {
        for (const threadId of ["started-on-minis", `project-coordinator:${project}`, "from-m1"])
          expect(
            Exit.isSuccess(
              yield* check(current, threadId, { "from-m1": EnvironmentId.make("env-m1") }, legacy),
            ),
          ).toBe(true);
      }
      // In a linked project the other coordinator's threads stay its own, as before.
      const active = linked({ epoch: 3, state: "active", operationId: "start-op" });
      refusal(yield* check(active, "started-on-minis", {}, legacy));
      expect(
        Exit.isSuccess(yield* check(active, "worker-from-m4", { "worker-from-m4": M4 }, legacy)),
      ).toBe(true);
      // A revoked legacy grant steers nothing.
      const revoked: WorkGrantContext = {
        ...legacy,
        grant: { ...legacy.grant, revoked: true },
      };
      expect(JSON.stringify(yield* check(unlinked, "started-on-minis", {}, revoked))).toContain(
        "machine_not_authorized",
      );
    }),
  );
});
