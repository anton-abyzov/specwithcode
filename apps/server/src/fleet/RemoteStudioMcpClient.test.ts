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

// @effect-diagnostics-next-line nodeBuiltinImport:off -- a real fleet key file for the link.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";

import { nodePath as NodePath } from "../nodePath.ts";
import { fakeStudioMcp } from "./fakeStudioMcp.testkit.ts";
import { CONNECT_ORIGIN, ORIGIN, studioToken, target } from "./fleetMachine.testkit.ts";
import { loadOrCreateFleetProofKey } from "./fleetProofKey.ts";
import { makeFleetLink } from "./fleetTransport.ts";
import * as FleetTargets from "./FleetTargets.ts";
import * as FleetWorkerGrants from "./FleetWorkerGrants.ts";
import * as RemoteStudioMcpClient from "./RemoteStudioMcpClient.ts";
import * as WorkerEpochStore from "./WorkerEpochStore.ts";

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
      studio_project_clone: () => ({
        result: {
          cwd: "/home/example/widgets",
          remoteUrl: "git@example.com:o/w.git",
          repository: null,
        },
      }),
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

  it.effect("forwards a clone for studio_project_add_to_machine, never update or delete", () => {
    const { remote, layer } = setup();
    return Effect.gen(function* () {
      expect(RemoteStudioMcpClient.REMOTE_TOOL_ALLOWLIST).toEqual(
        expect.arrayContaining(["studio_project_clone", "studio_project_create"]),
      );
      for (const tool of [
        "studio_project_update",
        "studio_project_delete",
        "studio_project_request",
      ])
        expect(RemoteStudioMcpClient.REMOTE_TOOL_ALLOWLIST as ReadonlyArray<string>).not.toContain(
          tool,
        );
      const client = yield* RemoteStudioMcpClient.RemoteStudioMcpClient;
      const args = { remoteUrl: "git@example.com:o/w.git", destinationPath: "~/widgets" };
      expect(
        yield* client.call({ machineId: "m1", tool: "studio_project_clone", arguments: args }),
      ).toEqual({
        cwd: "/home/example/widgets",
        remoteUrl: "git@example.com:o/w.git",
        repository: null,
      });
      expect(remote.toolCalls).toEqual([{ name: "studio_project_clone", args }]);
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

  // 1086 AC-08: the worker machine fences steering by the epochs a coordinator names.
  it.effect("names this machine's coordinator epochs for the projects it shares there", () => {
    const { remote } = setup();
    const named: Array<string | null> = [];
    let epochs = new Map([["logical:app", 5]]);
    const recording = Layer.succeed(FleetTargets.FleetTargets, {
      load: Effect.succeed({ version: 1 as const, machines: [target] }),
      fetch: (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        if (new URL(input instanceof Request ? input.url : String(input)).pathname === "/mcp")
          named.push(new Headers(init?.headers).get(WorkerEpochStore.COORDINATOR_EPOCHS_HEADER));
        return remote.fetcher(input, init);
      }) as typeof fetch,
    });
    const asked: string[] = [];
    return Effect.gen(function* () {
      const client = yield* RemoteStudioMcpClient.RemoteStudioMcpClient;
      yield* read(client);
      expect(asked.every((environmentId) => environmentId === target.environmentId)).toBe(true);
      expect(named.at(-1)).toBe('{"logical:app":5}');
      // After this machine gave the project away it names none.
      epochs = new Map();
      yield* read(client);
      expect(named.at(-1)).toBeNull();
    }).pipe(
      Effect.provide(
        RemoteStudioMcpClient.layer.pipe(
          Layer.provide(
            Layer.mock(FleetWorkerGrants.FleetWorkerGrants)({
              credential: () =>
                Effect.succeed({
                  target,
                  accessToken: "token-1",
                  access: "auto" as const,
                  expiresAt: "2026-11-11T00:00:00.000Z",
                }),
              reportAccepted: () => Effect.void,
              reportRejected: () => Effect.void,
            }),
          ),
          Layer.provide(recording),
          Layer.provide(
            Layer.succeed(WorkerEpochStore.CoordinatorEpochSource, {
              epochsFor: (environmentId) =>
                Effect.sync(() => {
                  asked.push(environmentId);
                  return epochs;
                }),
            }),
          ),
        ),
      ),
    );
  });
});

describe("RemoteStudioMcpClient over SpecWithCode Connect", () => {
  it.effect("calls the Connect /mcp with DPoP on every request when the tailnet is down", () =>
    Effect.gen(function* () {
      const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "studio-mcp-connect-"));
      const key = yield* Effect.promise(() => loadOrCreateFleetProofKey(baseDir));
      const grant = studioToken({ sid: "grant", jkt: key.thumbprint });
      const remote = fakeStudioMcp({
        origin: ORIGIN,
        alsoAnswersOn: [CONNECT_ORIGIN],
        offline: new Set([ORIGIN]),
        environmentId: "env-m1",
        tokens: [grant],
        tools: { studio_thread_read: () => ({ result: { thread: remoteThread } }) },
      });
      const machine = { ...target, connectUrl: CONNECT_ORIGIN };
      const rejected: string[] = [];
      const layer = RemoteStudioMcpClient.layer.pipe(
        Layer.provide(
          Layer.mock(FleetWorkerGrants.FleetWorkerGrants)({
            credential: () =>
              Effect.succeed({
                target: machine,
                accessToken: grant,
                access: "auto" as const,
                expiresAt: "2026-11-11T00:00:00.000Z",
              }),
            reportRejected: (_machineId, accessToken) =>
              Effect.sync(() => {
                rejected.push(accessToken);
              }),
            reportAccepted: () => Effect.void,
          }),
        ),
        Layer.provide(
          Layer.succeed(FleetTargets.FleetTargets, {
            load: Effect.succeed({ version: 1 as const, machines: [machine] }),
            fetch: remote.fetcher,
            link: makeFleetLink({ fetch: remote.fetcher, baseDir }),
          }),
        ),
      );
      yield* Effect.gen(function* () {
        const client = yield* RemoteStudioMcpClient.RemoteStudioMcpClient;
        expect(yield* read(client)).toEqual({ thread: remoteThread });
        expect(yield* read(client)).toEqual({ thread: remoteThread });
        const mcp = remote.requests.filter((request) => request.url.endsWith("/mcp"));
        expect(mcp.length).toBeGreaterThan(1);
        expect(mcp.every((request) => request.url === `${CONNECT_ORIGIN}/mcp`)).toBe(true);
        expect(mcp.every((request) => request.authorization === `DPoP ${grant}`)).toBe(true);
        // A fresh proof per request: no two alike.
        const proofs = mcp.map((request) => request.dpop);
        expect(proofs.every((proof) => typeof proof === "string")).toBe(true);
        expect(new Set(proofs).size).toBe(proofs.length);
        expect(
          remote.requests.some((request) => request.authorization?.startsWith("Bearer ")),
        ).toBe(false);
        // A revoked grant is still reported as rejected over Connect.
        remote.revoke(grant);
        yield* client.forget("m1");
        const error = yield* failureOnly(read(client));
        expect(error.reason).toBe("not_authorized");
        expect(rejected).toEqual([grant]);
      }).pipe(
        Effect.provide(layer),
        Effect.ensuring(
          Effect.sync(() => NodeFS.rmSync(baseDir, { recursive: true, force: true })),
        ),
      );
    }),
  );

  it.effect("never takes a bearer grant to the Connect address", () =>
    Effect.gen(function* () {
      const remote = fakeStudioMcp({
        origin: ORIGIN,
        alsoAnswersOn: [CONNECT_ORIGIN],
        offline: new Set([ORIGIN]),
        environmentId: "env-m1",
        tokens: ["token-1"],
        tools: { studio_thread_read: () => ({ result: { thread: remoteThread } }) },
      });
      const machine = { ...target, connectUrl: CONNECT_ORIGIN };
      const layer = RemoteStudioMcpClient.layer.pipe(
        Layer.provide(
          Layer.mock(FleetWorkerGrants.FleetWorkerGrants)({
            credential: () =>
              Effect.succeed({
                target: machine,
                accessToken: "token-1",
                access: "auto" as const,
                expiresAt: "2026-11-11T00:00:00.000Z",
              }),
            reportRejected: () => Effect.void,
            reportAccepted: () => Effect.void,
          }),
        ),
        Layer.provide(
          Layer.succeed(FleetTargets.FleetTargets, {
            load: Effect.succeed({ version: 1 as const, machines: [machine] }),
            fetch: remote.fetcher,
          }),
        ),
      );
      yield* Effect.gen(function* () {
        const client = yield* RemoteStudioMcpClient.RemoteStudioMcpClient;
        const error = yield* failureOnly(read(client));
        expect(error.reason).toBe("unreachable");
        // Connect is only asked who it is, with no credential.
        expect(
          remote.requests
            .filter((request) => request.url.startsWith(CONNECT_ORIGIN))
            .map((request) => [request.url, request.authorization]),
        ).toEqual([[`${CONNECT_ORIGIN}/.well-known/studio/environment`, null]]);
      }).pipe(Effect.provide(layer));
    }),
  );
});
