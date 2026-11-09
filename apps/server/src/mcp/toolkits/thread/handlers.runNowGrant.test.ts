import {
  DEFAULT_PROJECT_WORKSPACE_SETTINGS,
  EnvironmentId,
  ProjectId,
  ScheduledTaskId,
  ThreadId,
} from "@specweave-studio/contracts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { describe, expect, it } from "@effect/vitest";

import * as RemoteWorkers from "../../../fleet/RemoteWorkers.ts";
import * as WorkGrants from "../../../fleet/WorkGrants.ts";
import { workerClientName } from "../../../fleet/workerGrantMint.ts";
import type { EffectiveWorkGrant } from "../../../fleet/workGrantPolicy.ts";
import * as Threads from "../../../orchestration-v2/ThreadManagementService.ts";
import { projectFixture } from "../../../project/ProjectWorkspace.testkit.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as ScheduledTasks from "../../../scheduledTasks/ScheduledTaskService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { layer as handlers } from "./handlers.ts";
import { ThreadToolkit } from "./tools.ts";

/**
 * 1267: run_scheduled_task_now from another machine's work under a grant that
 * allows routines starts a run no broader than the caller may work, as an
 * update does: the routine's modes and a bound thread's modes as they are now.
 * The tool already needs a full-access caller (writesEnvironment), so a grant
 * capped lower cannot run routines at all.
 */
const HERE = EnvironmentId.make("env-minis");
const M4 = EnvironmentId.make("env-m4");
const projectId = ProjectId.make("linked");
const bound = ThreadId.make("bound");

const grant: EffectiveWorkGrant = {
  coordinatorEnvironmentId: M4,
  projects: { kind: "all" },
  accounts: { kind: "all" },
  owner: "self",
  hopLimit: 2,
  revoked: false,
  routines: true,
};

const routine = (id: string, overrides: Record<string, unknown> = {}) => ({
  id: ScheduledTaskId.make(id),
  title: id,
  projectId,
  threadId: null,
  runtimeMode: "auto",
  interactionMode: "default",
  lastRunStatus: "never",
  runCount: 0,
  nextRunAt: null,
  ...overrides,
});

const runNow = (taskId: string, access: "auto" | "full-access" = "full-access") => {
  const started: string[] = [];
  const services = Layer.mergeAll(
    NodeCrypto.layer,
    Layer.mock(ProjectService.ProjectService)({
      getById: () =>
        Effect.succeed(
          Option.some(
            projectFixture(projectId, {
              title: "Linked",
              workspaceSettings: DEFAULT_PROJECT_WORKSPACE_SETTINGS,
            }),
          ),
        ),
    }),
    Layer.succeed(McpInvocationContext.McpInvocationContext, {
      environmentId: HERE,
      requestNamespace: "client:m4",
      issuedAt: 1,
      capabilities: new Set(["orchestration" as const]),
      client: {
        sessionId: "session",
        principal: { kind: "coordinator", environmentId: M4 },
        label: workerClientName(M4),
        access,
      },
      thread: undefined,
    }),
    Layer.mock(Threads.ThreadManagementService)({
      getThreadShell: (id) =>
        Effect.succeed(
          id === bound
            ? ({
                id,
                projectId,
                runtimeMode: "full-access",
                interactionMode: "default",
                deletedAt: null,
              } as never)
            : null,
        ),
    }),
    Layer.mock(ScheduledTasks.ScheduledTaskService)({
      list: () =>
        Effect.succeed({
          tasks: [
            routine("within"),
            routine("broader", { runtimeMode: "full-access" }),
            routine("bound", { threadId: bound }),
            routine("owners"),
            routine("others"),
          ],
        } as never),
      // The owner's routine carries no grant; "others" came from a third machine.
      readGrant: (id) =>
        Effect.succeed(
          id === "owners"
            ? undefined
            : {
                coordinatorEnvironmentId: id === "others" ? EnvironmentId.make("env-other") : M4,
                runtimeCap: "full-access",
                accounts: { kind: "all" },
              },
        ) as never,
      runNow: (input) =>
        Effect.sync(() => {
          started.push(input.id);
          return { task: routine(input.id) } as never;
        }),
    }),
    Layer.succeed(WorkGrants.WorkGrants, {
      ...(WorkGrants.WorkGrants.defaultValue() as WorkGrants.WorkGrantsShape),
      enabled: true,
      forClient: () => Effect.succeed(grant),
    }),
    Layer.succeed(RemoteWorkers.RemoteWorkers, {
      ...(RemoteWorkers.RemoteWorkers.defaultValue() as RemoteWorkers.RemoteWorkersShape),
      machineLabels: Effect.succeed(new Map([[M4 as string, "M4MAX"]])),
    }),
  );
  return Effect.gen(function* () {
    const toolkit = yield* ThreadToolkit.pipe(
      Effect.provide(McpToolAccess.HandlersLayer.layer(handlers)),
    );
    const output = yield* toolkit
      .handle("run_scheduled_task_now", { taskId: ScheduledTaskId.make(taskId) })
      .pipe(Stream.unwrap, Stream.runCollect);
    return { result: Array.from(output).at(-1)?.result, started };
  }).pipe(Effect.provide(services));
};

describe("run_scheduled_task_now under a grant", () => {
  it.effect("runs a routine within the caller's modes", () =>
    Effect.gen(function* () {
      const { result, started } = yield* runNow("within");
      expect(result).toMatchObject({ taskId: "within" });
      expect(started).toEqual(["within"]);
    }),
  );

  it.effect(
    "runs a full-access routine, and one bound to a full-access thread, for a full-access grant",
    () =>
      Effect.gen(function* () {
        expect((yield* runNow("broader")).started).toEqual(["broader"]);
        expect((yield* runNow("bound")).started).toEqual(["bound"]);
      }),
  );

  it.effect("refuses every run to a grant capped below full access", () =>
    Effect.gen(function* () {
      for (const id of ["within", "broader", "bound"]) {
        const { result, started } = yield* runNow(id, "auto");
        expect(result).toMatchObject({ code: "capability_denied" });
        expect(started).toEqual([]);
      }
    }),
  );
});

describe("run_scheduled_task_now on a routine the grant did not make", () => {
  it.effect("refuses the owner's routine and another machine's, and starts neither", () =>
    Effect.gen(function* () {
      const owners = yield* runNow("owners");
      expect(owners.result).toMatchObject({
        code: "outside_grant_scope",
        message: `Routine "owners" was set up on this machine, so M4MAX's work can't run it. Ask the user here to run it, or schedule a new routine.`,
      });
      expect(owners.started).toEqual([]);
      const others = yield* runNow("others");
      expect(others.result).toMatchObject({ code: "outside_grant_scope" });
      expect(others.started).toEqual([]);
    }),
  );
});
