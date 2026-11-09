import { describe, expect, it } from "@effect/vitest";
import {
  DEFAULT_PROJECT_WORKSPACE_SETTINGS,
  EnvironmentId,
  ProjectId,
  ThreadId,
} from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import type { EffectiveWorkGrant } from "../fleet/workGrantPolicy.ts";
import { unscopedGrant } from "../fleet/workGrantPolicy.ts";
import * as WorkGrants from "../fleet/WorkGrants.ts";
import { projectFixture } from "../project/ProjectWorkspace.testkit.ts";
import * as Project from "../project/ProjectService.ts";
import { ROUTINES_GRANT_HINT, refuseGrantRoutineChange } from "./workGrantAccess.ts";

const M4 = EnvironmentId.make("env-m4");
const MINIS = EnvironmentId.make("env-minis");
const linkedProject = ProjectId.make("easychamp-minis");
const otherProject = ProjectId.make("private-minis");

const projects = {
  [linkedProject]: projectFixture(linkedProject, {
    title: "EasyChamp",
    workspaceSettings: {
      ...DEFAULT_PROJECT_WORKSPACE_SETTINGS,
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
            projectId: linkedProject,
            coordinatorThreadId: ThreadId.make(`project-coordinator:${linkedProject}`),
          },
        ],
      },
    },
  }),
  [otherProject]: projectFixture(otherProject, { title: "Private" }),
};

const grant = (overrides: Partial<EffectiveWorkGrant> = {}): EffectiveWorkGrant => ({
  coordinatorEnvironmentId: M4,
  projects: { kind: "linked" },
  accounts: { kind: "all" },
  owner: "self",
  hopLimit: 2,
  revoked: false,
  routines: true,
  ...overrides,
});

/** M4's worker client changes a routine in `projectId` here, under `current`. */
const change = (current: EffectiveWorkGrant | undefined, projectId: ProjectId) =>
  Effect.exit(
    refuseGrantRoutineChange(
      {
        scope: { client: { sessionId: "s", label: "worker", access: "full-access" } as never },
        caller: undefined,
      },
      projectId,
    ).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(WorkGrants.WorkGrants, {
            ...WorkGrants.WorkGrants.defaultValue(),
            enabled: true,
            forClient: () => Effect.succeed(current),
          }),
          Layer.mock(Project.ProjectService)({
            getById: (id) =>
              Effect.succeed(Option.fromNullishOr(projects[id as keyof typeof projects])),
          }),
        ),
      ),
    ),
  );

const failureOf = (exit: Exit.Exit<unknown, unknown>) => {
  expect(Exit.isFailure(exit)).toBe(true);
  return JSON.stringify(Exit.isFailure(exit) ? exit.cause : undefined);
};

describe("routines under a work grant", () => {
  it.effect("allows a grant with routines in a project it covers, and names that grant", () =>
    Effect.gen(function* () {
      const exit = yield* change(grant(), linkedProject);
      expect(Exit.isSuccess(exit)).toBe(true);
      if (Exit.isSuccess(exit)) expect(exit.value?.grant.coordinatorEnvironmentId).toBe(M4);
    }),
  );

  it.effect("refuses without the capability, naming the setting", () =>
    Effect.gen(function* () {
      const failure = failureOf(yield* change(grant({ routines: false }), linkedProject));
      expect(failure).toContain("outside_grant_scope");
      expect(failure).toContain("create, change, delete or run its scheduled routines");
      expect(failure).toContain(ROUTINES_GRANT_HINT);
    }),
  );

  it.effect("refuses a project the grant does not cover, and a revoked grant", () =>
    Effect.gen(function* () {
      const outside = failureOf(yield* change(grant(), otherProject));
      expect(outside).toContain("outside_grant_scope");
      expect(outside).toContain("Private");
      const revoked = failureOf(yield* change(grant({ revoked: true }), linkedProject));
      expect(revoked).toContain("machine_not_authorized");
    }),
  );

  it.effect("leaves a legacy grant and a caller without a grant as they were", () =>
    Effect.gen(function* () {
      const legacy = yield* change({ ...unscopedGrant(M4), legacy: true }, otherProject);
      expect(Exit.isSuccess(legacy) && legacy.value === undefined).toBe(true);
      const none = yield* change(undefined, otherProject);
      expect(Exit.isSuccess(none) && none.value === undefined).toBe(true);
    }),
  );
});
