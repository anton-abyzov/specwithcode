import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type ProjectPlanSnapshot,
} from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as Plans from "../../../project/ProjectPlanService.ts";
import * as Threads from "../../../orchestration-v2/ThreadManagementService.ts";
import * as Context from "../../McpInvocationContext.ts";
import * as Access from "../../McpToolAccess.ts";
import { liveThreadShell } from "../../McpToolAccess.testkit.ts";
import { ProjectPlanToolkit } from "./tools.ts";
import * as Handlers from "./handlers.ts";
const caller = liveThreadShell(ThreadId.make("plan-worker"));
const scope = {
  environmentId: EnvironmentId.make("fixture"),
  requestNamespace: "fixture",
  thread: {
    threadId: caller.id,
    providerSessionId: "fixture",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  issuedAt: 0,
  capabilities: new Set(["orchestration" as const]),
};
const result: ProjectPlanSnapshot = {
  projectId: caller.projectId,
  revision: 1,
  authority: { kind: "native" },
  native: { spec: "", criteria: [], tasks: [], contentRevision: 1 },
  external: null,
};
const calls: Array<{ operation: string; input: unknown }> = [];
const capture = (operation: string) => (input: unknown) =>
  Effect.sync(() => {
    calls.push({ operation, input });
    return result;
  });
const dependencies = Layer.mergeAll(
  Layer.mock(Plans.ProjectPlanService)({
    read: capture("read"),
    claim: capture("claim"),
    release: capture("release"),
    report: capture("report"),
    configure: () => Effect.die("Agents cannot configure"),
    verify: () => Effect.die("Agents cannot verify"),
  }),
  Layer.mock(Threads.ThreadManagementService)({ getThreadShell: () => Effect.succeed(caller) }),
  Layer.succeed(Context.McpInvocationContext, scope),
);
const layer = Access.HandlersLayer.layer(Handlers.layer).pipe(Layer.provideMerge(dependencies));
it.effect(
  "derives assignment identity from the authenticated thread and rejects foreign projects",
  () =>
    Effect.gen(function* () {
      calls.length = 0;
      const toolkit = yield* ProjectPlanToolkit;
      const spoof = {
        taskId: "T-1",
        expectedRevision: 1,
        actor: { kind: "user" },
        expectedOwner: { kind: "user" },
      };
      yield* toolkit
        .handle("studio_project_plan_claim", spoof)
        .pipe(Stream.unwrap, Stream.runCollect);
      yield* toolkit
        .handle("studio_project_plan_release", spoof)
        .pipe(Stream.unwrap, Stream.runCollect);
      expect(calls).toEqual([
        {
          operation: "claim",
          input: {
            taskId: "T-1",
            expectedRevision: 1,
            projectId: caller.projectId,
            actor: { kind: "thread", threadId: caller.id },
          },
        },
        {
          operation: "release",
          input: {
            taskId: "T-1",
            expectedRevision: 1,
            projectId: caller.projectId,
            actor: { kind: "thread", threadId: caller.id },
            expectedOwner: { kind: "thread", threadId: caller.id },
          },
        },
      ]);
      const denied = yield* toolkit
        .handle("studio_project_plan_read", { projectId: ProjectId.make("foreign") })
        .pipe(Stream.unwrap, Stream.runCollect);
      expect(denied.at(-1)?.result).toMatchObject({ code: "capability_denied" });
      expect(calls.length).toBe(2);
    }).pipe(Effect.provide(layer)),
);
it.effect("external clients cannot impersonate human plan actions, even with full access", () =>
  Effect.gen(function* () {
    const toolkit = yield* ProjectPlanToolkit;
    const denied = yield* toolkit
      .handle("studio_project_plan_claim", {
        projectId: caller.projectId,
        taskId: "T-1",
        expectedRevision: 1,
      })
      .pipe(Stream.unwrap, Stream.runCollect);
    expect(denied.at(-1)?.result).toMatchObject({ code: "capability_denied" });
  }).pipe(
    Effect.provideService(Context.McpInvocationContext, {
      ...scope,
      thread: undefined,
      client: { sessionId: "external", label: "Fixture", access: "full-access" },
    }),
    Effect.provide(layer),
  ),
);
it("offers no configure, replace or verification tool", () => {
  expect(Object.keys(ProjectPlanToolkit.tools).sort()).toEqual([
    "studio_project_plan_claim",
    "studio_project_plan_read",
    "studio_project_plan_release",
    "studio_project_plan_report",
  ]);
});
