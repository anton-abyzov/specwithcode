import * as NodeServices from "@effect/platform-node/NodeServices";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { EnvironmentId, WS_METHODS } from "@specweave-studio/contracts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as AuthSessions from "../persistence/AuthSessions.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import { makeManagedUpdatesRpc, makeLegacyServerUpdateRpc } from "./ManagedUpdatesRpc.ts";
import * as ServerSelfUpdate from "../cloud/selfUpdate.ts";
import * as ServiceUpdatePreparation from "../serviceUpdate/ServiceUpdatePreparation.ts";
import * as Stream from "effect/Stream";
import { describe, expect, it } from "@effect/vitest";
import { AuthSessionId } from "@specweave-studio/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { freshManagedUpdateAuthority } from "./ManagedUpdatesAuthority.ts";
import type { AuthSessionRecord } from "../persistence/AuthSessions.ts";

it.effect("keeps RPC metadata out of legacy update callbacks and preserves progress events", () => {
  const result = { targetVersion: "1.0.18", method: "boot-service" as const };
  const calls: unknown[][] = [];
  return Effect.gen(function* () {
    const handlers = yield* makeLegacyServerUpdateRpc;
    // RPC dispatch supplies transport options as a second argument.
    const update = handlers[WS_METHODS.serverUpdateServer];
    const dispatch: (
      input: Parameters<typeof update>[0],
      options: object,
    ) => ReturnType<typeof update> = update;
    expect(yield* dispatch({ targetVersion: "1.0.18" }, { requestId: "transport-only" })).toEqual(
      result,
    );
    expect(calls[0]).toEqual([{ targetVersion: "1.0.18" }]);
    const events = yield* handlers[WS_METHODS.serverUpdateServerWithProgress]({
      targetVersion: "1.0.18",
    }).pipe(Stream.runCollect);
    expect(Array.from(events)).toEqual([
      { type: "progress", stage: "downloading" },
      { type: "complete", result },
    ]);
  }).pipe(
    Effect.provideService(ServerSelfUpdate.ServerSelfUpdate, {
      update: (...args) => {
        calls.push(args);
        return (args[1] ? args[1]("downloading") : Effect.void).pipe(Effect.as(result));
      },
      commitDesktopUpdate: () => Effect.die("not used"),
    }),
    Effect.provideService(ServiceUpdatePreparation.ServiceUpdatePreparation, {
      prepare: () => Effect.die("not used"),
    }),
  );
});

// The helper also rechecks under its lock. This boundary must reject before spawning it.
describe("managed update RPC fresh permission contract", () => {
  it.effect("status is readable without enrollment/admin while check needs maintenance", () =>
    Effect.gen(function* () {
      const identity = { sessionId: AuthSessionId.make("read-only"), subject: "client" };
      const record = {
        ...identity,
        scopes: ["orchestration:read"],
        revokedAt: null,
        expiresAt: DateTime.makeUnsafe("2100-01-01"),
      } as unknown as AuthSessionRecord;
      const read = () => Effect.succeed(Option.some(record));
      expect(yield* freshManagedUpdateAuthority(identity, "status", read)).toBe(record);
      for (const action of ["check", "enroll", "revoke"] as const)
        expect(
          (yield* freshManagedUpdateAuthority(identity, action, read).pipe(Effect.flip)).code,
        ).toBe("unauthorized");
    }),
  );
});

it.effect(
  "constructs the production RPC with narrow dependencies and rechecks a connected session",
  () =>
    Effect.gen(function* () {
      const connected = {
        sessionId: AuthSessionId.make("rpc-principal"),
        subject: "client",
        method: "bearer-access-token",
        scopes: ["access:write", "environment:maintain"],
      } as const;
      const handlers = yield* makeManagedUpdatesRpc(connected);
      const sessions = yield* AuthSessions.AuthSessionRepository;
      const record = {
        ...connected,
        scopes: ["orchestration:read"] as const,
        issuedAt: DateTime.makeUnsafe("2026-01-01"),
        expiresAt: DateTime.makeUnsafe("2100-01-01"),
        client: {
          label: null,
          deviceType: "desktop" as const,
          ipAddress: null,
          userAgent: null,
          os: null,
          browser: null,
        },
      };
      yield* sessions.create(record);
      // Connection-time admin scopes above do not authorize against the current read-only grant.
      const denied = yield* handlers[WS_METHODS.managedUpdatesEnroll]({
        environmentId: EnvironmentId.make("destination"),
        installationId: "desk",
        expectedRevision: 0,
        consent: true,
      }).pipe(Effect.flip);
      expect(denied.code).toBe("unauthorized");
      expect((yield* handlers[WS_METHODS.managedUpdatesStatus]()).support).toBe("unsupported");
      yield* sessions.revoke({
        sessionId: connected.sessionId,
        revokedAt: DateTime.makeUnsafe("2026-10-14"),
      });
      expect((yield* handlers[WS_METHODS.managedUpdatesStatus]().pipe(Effect.flip)).code).toBe(
        "unauthorized",
      );
    }).pipe(
      Effect.provideService(ServerConfig.ServerConfig, {
        stateDir: "/synthetic/userdata",
      } as ServerConfig.ServerConfig["Service"]),
      Effect.provideService(ServerEnvironment.ServerEnvironment, {
        getEnvironmentId: Effect.succeed(EnvironmentId.make("destination")),
        getDescriptor: Effect.die("not used"),
      }),
      Effect.provideService(FileSystem.FileSystem, FileSystem.makeNoop({})),
      Effect.provide(AuthSessions.layer.pipe(Layer.provideMerge(Sqlite.layerMemory))),
      Effect.provide(NodeServices.layer),
    ),
);
