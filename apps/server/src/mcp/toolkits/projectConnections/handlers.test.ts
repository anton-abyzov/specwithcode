import { expect, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type ProjectConnection,
} from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as Connections from "../../../project/ProjectConnectionService.ts";
import * as Threads from "../../../orchestration-v2/ThreadManagementService.ts";
import * as Context from "../../McpInvocationContext.ts";
import * as Access from "../../McpToolAccess.ts";
import { liveThreadShell } from "../../McpToolAccess.testkit.ts";
import { ProjectConnectionsToolkit } from "./tools.ts";
import * as Handlers from "./handlers.ts";

const caller = liveThreadShell(ThreadId.make("connection-worker"));
const scope: Context.McpInvocationScope = {
  environmentId: EnvironmentId.make("fixture"),
  requestNamespace: "fixture",
  thread: {
    threadId: caller.id,
    providerSessionId: "fixture",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  issuedAt: 0,
  capabilities: new Set(["orchestration"]),
};
const connection: ProjectConnection = {
  id: "synthetic",
  name: "Synthetic",
  command: "host-only-executable",
  args: ["host-only-argument"],
  envKeys: ["HOST_ONLY_KEY"],
  revision: 3,
  status: "ready",
  checkedAt: null,
  tools: [
    { name: "echo", description: "Echo", inputSchema: { type: "object" } },
    { name: "unapproved", description: "Not allowed", inputSchema: { type: "object" } },
  ],
  allowedTools: ["echo"],
};
const request = {
  id: connection.id,
  expectedRevision: 3,
  tool: "echo",
  arguments: { value: "hello" },
  commandId: CommandId.make("stable"),
};
const fixture = () => {
  const calls: { operation: string; input: unknown }[] = [];
  const deps = Layer.mergeAll(
    Layer.mock(Connections.ProjectConnectionService)({
      read: (input) =>
        Effect.sync(() => {
          calls.push({ operation: "read", input });
          return { connections: [connection] };
        }),
      call: (input) =>
        Effect.sync(() => {
          calls.push({ operation: "call", input });
          return { isError: false, content: "Synthetic result" };
        }),
    }),
    Layer.mock(Threads.ThreadManagementService)({ getThreadShell: () => Effect.succeed(caller) }),
    Layer.succeed(Context.McpInvocationContext, scope),
  );
  return {
    calls,
    layer: Access.HandlersLayer.layer(Handlers.layer).pipe(Layer.provideMerge(deps)),
  };
};

it.effect(
  "lists only allowed tool metadata and derives immutable call identity from the authenticated thread",
  () =>
    Effect.gen(function* () {
      const f = fixture();
      yield* Effect.gen(function* () {
        const toolkit = yield* ProjectConnectionsToolkit;
        const listed = yield* toolkit
          .handle("studio_project_connections_list", {})
          .pipe(Stream.unwrap, Stream.runCollect);
        expect(listed.at(-1)?.result).toEqual([
          {
            id: "synthetic",
            name: "Synthetic",
            revision: 3,
            status: "ready",
            tools: [connection.tools[0]],
          },
        ]);
        expect(JSON.stringify(listed)).not.toContain("host-only");
        expect(JSON.stringify(listed)).not.toContain("HOST_ONLY_KEY");
      const spoofed = { ...request, actor: "thread:forged" };
      const result = yield* toolkit
        .handle("studio_project_connection_call", spoofed)
          .pipe(Stream.unwrap, Stream.runCollect);
        expect(result.at(-1)?.result).toEqual({ isError: false, content: "Synthetic result" });
        expect(f.calls).toEqual([
          { operation: "read", input: { projectId: caller.projectId } },
          {
            operation: "call",
            input: {
              ...request,
              projectId: caller.projectId,
              actor: `thread:${caller.id}`,
              commandId: `thread:${caller.id}:stable`,
            },
          },
        ]);
      }).pipe(Effect.provide(f.layer));
    }),
);

it.effect("denies foreign-project lists and calls before entering the connection service", () =>
  Effect.gen(function* () {
    const f = fixture();
    yield* Effect.gen(function* () {
      const toolkit = yield* ProjectConnectionsToolkit;
      const listed = yield* toolkit
        .handle("studio_project_connections_list", { projectId: ProjectId.make("foreign") })
        .pipe(Stream.unwrap, Stream.runCollect);
      const called = yield* toolkit
        .handle("studio_project_connection_call", {
          ...request,
          projectId: ProjectId.make("foreign"),
        })
        .pipe(Stream.unwrap, Stream.runCollect);
      expect(listed.at(-1)?.result).toMatchObject({ code: "capability_denied" });
      expect(called.at(-1)?.result).toMatchObject({ code: "capability_denied" });
      expect(f.calls).toEqual([]);
    }).pipe(Effect.provide(f.layer));
  }),
);

it.effect.each(["read-only", "full-access"] as const)(
  "refuses ambient project connection access to an outside %s client",
  (access) =>
    Effect.gen(function* () {
      const f = fixture();
      yield* Effect.gen(function* () {
        const toolkit = yield* ProjectConnectionsToolkit;
        const listed = yield* toolkit
          .handle("studio_project_connections_list", { projectId: caller.projectId })
          .pipe(Stream.unwrap, Stream.runCollect);
        const called = yield* toolkit
          .handle("studio_project_connection_call", { ...request, projectId: caller.projectId })
          .pipe(Stream.unwrap, Stream.runCollect);
        expect(listed.at(-1)?.result).toMatchObject({ code: "capability_denied" });
        expect(called.at(-1)?.result).toMatchObject({ code: "capability_denied" });
        expect(f.calls).toEqual([]);
      }).pipe(
        Effect.provideService(Context.McpInvocationContext, {
          ...scope,
          thread: undefined,
          client: { sessionId: "outside", label: "Synthetic", access },
        }),
        Effect.provide(f.layer),
      );
    }),
);

it("exposes no agent method to configure or grant connection permissions", () => {
  expect(Object.keys(ProjectConnectionsToolkit.tools).sort()).toEqual([
    "studio_project_connection_call",
    "studio_project_connections_list",
  ]);
});
