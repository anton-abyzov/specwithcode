import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
const failureOnly = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.result,
    Effect.map((result) => {
      if (Result.isFailure(result)) return result.failure;
      throw new Error("Expected native request to fail");
    }),
  );
import * as Layer from "effect/Layer";

import { fakeStudioMcp } from "./fakeStudioMcp.testkit.ts";
import { ORIGIN, target } from "./fleetMachine.testkit.ts";
import * as FleetTargets from "./FleetTargets.ts";
import * as FleetWorkerGrants from "./FleetWorkerGrants.ts";
import * as RemoteStudioMcpClient from "./RemoteStudioMcpClient.ts";

const remoteThread = { threadId: "thread-remote", title: "Worker", status: "idle" };

const setup = (
  options: {
    readonly grant?: FleetWorkerGrants.FleetWorkerGrantError["reason"];
    readonly tokens?: () => string;
  } = {},
) => {
  const remote = fakeStudioMcp({
    origin: ORIGIN,
    environmentId: "env-m1",
    tokens: ["token-1", "token-2"],
    tools: {
      studio_thread_read: () => ({ result: { thread: remoteThread } }),
      studio_thread_send: () => ({ failure: "Thread thread-remote is archived." }),
      studio_thread_list: () => ({
        raw: new Response("x".repeat(5 * 1024 * 1024), {
          headers: { "content-type": "application/json" },
        }),
      }),
    },
  });
  const rejected: string[] = [];
  let accepted = 0;
  const token = options.tokens ?? (() => "token-1");
  const grants = Layer.mock(FleetWorkerGrants.FleetWorkerGrants)({
    credential: () =>
      options.grant
        ? Effect.fail(new FleetWorkerGrants.FleetWorkerGrantError({ reason: options.grant }))
        : Effect.sync(() => ({
            target,
            accessToken: token(),
            access: "auto" as const,
            expiresAt: "2026-11-11T00:00:00.000Z",
          })),
    reportRejected: (_machineId, accessToken) =>
      Effect.sync(() => {
        rejected.push(accessToken);
      }),
    reportAccepted: () =>
      Effect.sync(() => {
        accepted += 1;
      }),
  });
  const layer = RemoteStudioMcpClient.layer.pipe(
    Layer.provide(grants),
    Layer.provide(
      Layer.succeed(FleetTargets.FleetTargets, {
        load: Effect.succeed({ version: 1 as const, machines: [target] }),
        fetch: remote.fetcher,
      }),
    ),
  );
  return { remote, rejected, accepted: () => accepted, layer };
};

const read = (client: RemoteStudioMcpClient.RemoteStudioMcpClient["Service"]) =>
  client.call({ machineId: "m1", tool: "studio_thread_read", arguments: { threadId: "x" } });

describe("RemoteStudioMcpClient", () => {
  it.effect("calls an allowlisted tool with the grant and returns its structured result", () => {
    const { remote, accepted, layer } = setup();
    return Effect.gen(function* () {
      const client = yield* RemoteStudioMcpClient.RemoteStudioMcpClient;
      expect(yield* read(client)).toEqual({ thread: remoteThread });
      expect(yield* read(client)).toEqual({ thread: remoteThread });
      // One MCP session for both calls, identity checked before the grant left.
      expect(remote.initializations()).toBe(1);
      const firstBearer = remote.requests.findIndex((request) => request.authorization !== null);
      expect(remote.requests[0]?.url).toBe(`${ORIGIN}/.well-known/studio/environment`);
      expect(remote.requests[0]?.authorization).toBeNull();
      expect(firstBearer).toBeGreaterThan(0);
      const mcp = remote.requests.filter((request) => request.url === `${ORIGIN}/mcp`);
      expect(mcp.every((request) => request.authorization === "Bearer token-1")).toBe(true);
      expect(mcp.every((request) => request.origin === null)).toBe(true);
      expect(mcp.every((request) => request.redirect === "error")).toBe(true);
      expect(remote.toolCalls).toEqual([
        { name: "studio_thread_read", args: { threadId: "x" } },
        { name: "studio_thread_read", args: { threadId: "x" } },
      ]);
      expect(accepted()).toBe(2);
    }).pipe(Effect.provide(layer));
  });

  it.effect("refuses tools outside the allowlist without contacting the machine", () => {
    const { remote, layer } = setup();
    return Effect.gen(function* () {
      const client = yield* RemoteStudioMcpClient.RemoteStudioMcpClient;
      const error = yield* client
        .call({
          machineId: "m1",
          tool: "studio_project_delete" as RemoteStudioMcpClient.RemoteTool,
          arguments: {},
        })
        .pipe(failureOnly);
      expect(error.reason).toBe("refused");
      expect(remote.requests).toEqual([]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("passes the other machine's declared failure through as its message", () => {
    const { layer } = setup();
    return Effect.gen(function* () {
      const client = yield* RemoteStudioMcpClient.RemoteStudioMcpClient;
      const error = yield* client
        .call({ machineId: "m1", tool: "studio_thread_send", arguments: {} })
        .pipe(failureOnly);
      expect(error.reason).toBe("tool_failure");
      expect(error.remoteMessage).toBe("Thread thread-remote is archived.");
      expect(error.remoteCode).toBe("orchestration_error");
    }).pipe(Effect.provide(layer));
  });

  it.effect("reports a tool the other machine does not have as unsupported", () => {
    const { layer } = setup();
    return Effect.gen(function* () {
      const client = yield* RemoteStudioMcpClient.RemoteStudioMcpClient;
      const error = yield* client
        .call({ machineId: "m1", tool: "studio_thread_wait", arguments: {} })
        .pipe(failureOnly);
      expect(error.reason).toBe("unsupported");
    }).pipe(Effect.provide(layer));
  });

  it.effect("treats a 401 as a revoked grant and reports the rejected token", () => {
    const { remote, rejected, layer } = setup();
    return Effect.gen(function* () {
      const client = yield* RemoteStudioMcpClient.RemoteStudioMcpClient;
      yield* read(client);
      remote.revoke("token-1");
      const error = yield* read(client).pipe(failureOnly);
      expect(error.reason).toBe("not_authorized");
      expect(error.grant).toBe("revoked");
      expect(rejected).toEqual(["token-1"]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("reopens the session when the grant's token changes", () => {
    let token = "token-1";
    const { remote, layer } = setup({ tokens: () => token });
    return Effect.gen(function* () {
      const client = yield* RemoteStudioMcpClient.RemoteStudioMcpClient;
      yield* read(client);
      token = "token-2";
      yield* read(client);
      expect(remote.initializations()).toBe(2);
      expect(remote.requests.at(-1)?.authorization).toBe("Bearer token-2");
    }).pipe(Effect.provide(layer));
  });

  it.effect("never sends the grant to a machine whose identity changed", () => {
    const { remote, layer } = setup();
    remote.replaceIdentity("env-someone-else");
    return Effect.gen(function* () {
      const client = yield* RemoteStudioMcpClient.RemoteStudioMcpClient;
      const error = yield* read(client).pipe(failureOnly);
      expect(error.reason).toBe("identity_mismatch");
      expect(remote.requests.every((request) => request.authorization === null)).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.effect("maps a missing grant to not_authorized with its reason", () => {
    const { remote, layer } = setup({ grant: "not_allowed" });
    return Effect.gen(function* () {
      const client = yield* RemoteStudioMcpClient.RemoteStudioMcpClient;
      const error = yield* read(client).pipe(failureOnly);
      expect(error.reason).toBe("not_authorized");
      expect(error.grant).toBe("not_allowed");
      expect(remote.requests).toEqual([]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("stops reading an oversized answer", () => {
    const { layer } = setup();
    return Effect.gen(function* () {
      const client = yield* RemoteStudioMcpClient.RemoteStudioMcpClient;
      const error = yield* client
        .call({ machineId: "m1", tool: "studio_thread_list", arguments: {}, timeoutMs: 5_000 })
        .pipe(failureOnly);
      expect(["unreachable", "invalid_response"]).toContain(error.reason);
    }).pipe(Effect.provide(layer));
  });
});
