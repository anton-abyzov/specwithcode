import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { Tool } from "effect/ai";
import * as Google from "../../../integrations/google/GoogleAccountService.ts";
import { projectGoogleStatus } from "../../../integrations/google/googleAccountHealth.ts";
import * as Threads from "../../../orchestration-v2/ThreadManagementService.ts";
import * as Context from "../../McpInvocationContext.ts";
import * as Access from "../../McpToolAccess.ts";
import { liveThreadShell } from "../../McpToolAccess.testkit.ts";
import { GoogleToolkit } from "./tools.ts";
import * as Handlers from "./handlers.ts";

const caller = liveThreadShell(ThreadId.make("errand-worker"));
const scope: Context.McpInvocationScope = {
  environmentId: EnvironmentId.make("fixture"),
  requestNamespace: "fixture",
  thread: {
    threadId: caller.id,
    providerSessionId: "fixture",
    providerInstanceId: ProviderInstanceId.make("claude"),
  },
  client: undefined,
  issuedAt: 0,
  capabilities: new Set(["orchestration"]),
};

const fixture = () => {
  const calls: Array<{ operation: string; projectId: string; input: unknown }> = [];
  const record = (operation: string) => (projectId: string, input: unknown) =>
    Effect.sync(() => {
      calls.push({ operation, projectId, input });
      return { ok: operation };
    });
  const deps = Layer.mergeAll(
    Layer.mock(Google.GoogleAccountService)({
      projectAccess: (projectId, input) =>
        Effect.sync(() => {
          calls.push({ operation: "status", projectId, input });
          return projectGoogleStatus({
            clientConfigured: true,
            connected: true,
            email: "me@example.com",
            grantedServices: ["gmail"],
            projectServices: ["gmail"],
          });
        }),
      gmailSearch: record("gmailSearch"),
      gmailRead: record("gmailRead"),
      calendarEvents: record("calendarEvents"),
      driveSearch: record("driveSearch"),
      driveRead: record("driveRead"),
    }),
    Layer.mock(Threads.ThreadManagementService)({ getThreadShell: () => Effect.succeed(caller) }),
    Layer.succeed(Context.McpInvocationContext, scope),
  );
  return {
    calls,
    layer: Access.HandlersLayer.layer(Handlers.layer).pipe(Layer.provideMerge(deps)),
  };
};

it.effect("reads Google data for the calling thread's own project only", () =>
  Effect.gen(function* () {
    const f = fixture();
    yield* Effect.gen(function* () {
      const toolkit = yield* GoogleToolkit;
      const status = yield* toolkit
        .handle("studio_google_status", {})
        .pipe(Stream.unwrap, Stream.runCollect);
      expect(status.at(-1)?.result).toMatchObject({
        email: "me@example.com",
        services: ["gmail"],
        connectionState: "configured",
        checkedAt: null,
      });
      yield* toolkit
        .handle("studio_google_status", { checkConnection: true })
        .pipe(Stream.unwrap, Stream.runCollect);
      yield* toolkit
        .handle("studio_google_gmail_search", { query: "is:unread" })
        .pipe(Stream.unwrap, Stream.runCollect);
      yield* toolkit
        .handle("studio_google_drive_read", { fileId: "f1" })
        .pipe(Stream.unwrap, Stream.runCollect);
      expect(f.calls).toEqual([
        { operation: "status", projectId: caller.projectId, input: {} },
        { operation: "status", projectId: caller.projectId, input: { checkConnection: true } },
        { operation: "gmailSearch", projectId: caller.projectId, input: { query: "is:unread" } },
        { operation: "driveRead", projectId: caller.projectId, input: "f1" },
      ]);
    }).pipe(Effect.provide(f.layer));
  }),
);

it.effect.each(["read-only", "full-access"] as const)(
  "gives an outside %s MCP client no Google data",
  (access) =>
    Effect.gen(function* () {
      const f = fixture();
      yield* Effect.gen(function* () {
        const toolkit = yield* GoogleToolkit;
        const result = yield* toolkit
          .handle("studio_google_gmail_search", { query: "is:unread" })
          .pipe(Stream.unwrap, Stream.runCollect);
        expect(result.at(-1)?.result).toMatchObject({ code: "capability_denied" });
        const status = yield* toolkit
          .handle("studio_google_status", { checkConnection: true })
          .pipe(Stream.unwrap, Stream.runCollect);
        expect(status.at(-1)?.result).toMatchObject({ code: "capability_denied" });
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

it("offers agents reads only, and no way to change access", () => {
  expect(Object.keys(GoogleToolkit.tools).sort()).toEqual([
    "studio_google_calendar_events",
    "studio_google_drive_read",
    "studio_google_drive_search",
    "studio_google_gmail_read",
    "studio_google_gmail_search",
    "studio_google_status",
  ]);
  // MCP refuses to register (and the server never starts) without an object root.
  for (const tool of Object.values(GoogleToolkit.tools)) {
    expect(Tool.getJsonSchema(tool)).toMatchObject({ type: "object" });
  }
});
