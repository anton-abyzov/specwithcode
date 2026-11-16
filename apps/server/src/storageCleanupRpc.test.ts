import { expect, it } from "@effect/vitest";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthSettingsWriteScope,
  WS_METHODS,
  WsStorageCleanupRpcGroup,
  type AuthEnvironmentScope,
  type StorageCleanupPlan,
} from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as RpcTest from "effect/rpc/RpcTest";

import * as Authorization from "./auth/RpcAuthorization.ts";
import { requiredScopeForRpcMethod } from "./auth/RpcAuthorization.ts";
import { rpcInstrumentationLayer } from "./observability/RpcInstrumentation.ts";
import { StorageCleanupService } from "./storageCleanup.ts";
import * as StorageCleanupRpc from "./storageCleanupRpc.ts";

const PLAN: StorageCleanupPlan = {
  checkedAt: "2026-11-16T12:00:00.000Z",
  items: [
    {
      kind: "worktree",
      path: "/home/me/.specwithcode/worktrees/app/1370-cleanup",
      action: "remove",
      reason: "merged",
      detail: null,
      bytes: 512_000_000,
      threadId: "thread-1",
      threadTitle: "Clean up finished worktrees",
      threadCount: 3,
    },
    {
      kind: "worktree",
      path: "/home/me/.specwithcode/worktrees/app/1371-open",
      action: "keep",
      reason: "unpushed",
      detail: "feature/open",
      bytes: null,
      threadId: "thread-2",
      threadTitle: null,
      threadCount: 1,
    },
    {
      kind: "interrupted-downloads",
      path: "/home/me/.specwithcode/verify/app/.git",
      action: "remove",
      reason: "interrupted-downloads",
      detail: "4 files",
      bytes: 800_000_000,
      threadId: null,
      threadTitle: null,
      threadCount: 0,
    },
  ],
  removableBytes: 1_312_000_000,
  complete: false,
};

/** A cleanup service that records each call instead of touching any folder. */
const fakeCleanup = () => {
  const calls: Array<string> = [];
  const layer = Layer.succeed(StorageCleanupService, {
    start: () => Effect.void,
    drain: Effect.void,
    runOnce: Effect.void,
    plan: Effect.sync(() => {
      calls.push("plan");
      return PLAN;
    }),
    cleanNow: Effect.sync(() => {
      calls.push("cleanNow");
      return {
        removed: [PLAN.items[0]!.path, PLAN.items[2]!.path],
        removedBytes: 1_312_000_000,
        plan: { ...PLAN, items: [PLAN.items[1]!], removableBytes: 0 },
      };
    }),
  });
  return { calls, layer };
};

const clientFor = (
  scopes: ReadonlyArray<AuthEnvironmentScope>,
  cleanup: Layer.Layer<StorageCleanupService>,
) =>
  RpcTest.makeClient(WsStorageCleanupRpcGroup).pipe(
    Effect.provide(
      Layer.mergeAll(StorageCleanupRpc.layerRpcHandlers, Authorization.layer(scopes)).pipe(
        Layer.provide(rpcInstrumentationLayer),
        Layer.provide(cleanup),
      ),
    ),
  );

it("needs the settings write scope for the plan and for Clean up now", () => {
  expect(requiredScopeForRpcMethod(WS_METHODS.serverGetStorageCleanupPlan)).toBe(
    AuthSettingsWriteScope,
  );
  expect(requiredScopeForRpcMethod(WS_METHODS.serverRunStorageCleanup)).toBe(
    AuthSettingsWriteScope,
  );
});

it.effect("refuses both methods without the settings scope and never reaches the cleanup", () =>
  Effect.gen(function* () {
    const cleanup = fakeCleanup();
    const client = yield* clientFor(
      [AuthOrchestrationReadScope, AuthOrchestrationOperateScope],
      cleanup.layer,
    );
    expect(
      yield* client[WS_METHODS.serverGetStorageCleanupPlan]({}).pipe(Effect.flip),
    ).toMatchObject({
      _tag: "EnvironmentAuthorizationError",
      requiredPermission: AuthSettingsWriteScope,
    });
    expect(yield* client[WS_METHODS.serverRunStorageCleanup]({}).pipe(Effect.flip)).toMatchObject({
      _tag: "EnvironmentAuthorizationError",
      requiredPermission: AuthSettingsWriteScope,
    });
    expect(cleanup.calls).toEqual([]);
  }).pipe(Effect.scoped),
);

it.effect("returns the service's plan and the result of one cleanup run", () =>
  Effect.gen(function* () {
    const cleanup = fakeCleanup();
    const client = yield* clientFor([AuthSettingsWriteScope], cleanup.layer);

    const plan = yield* client[WS_METHODS.serverGetStorageCleanupPlan]({});
    expect(plan).toEqual(PLAN);
    expect(cleanup.calls).toEqual(["plan"]);

    const run = yield* client[WS_METHODS.serverRunStorageCleanup]({});
    expect(run.removed).toEqual([
      "/home/me/.specwithcode/worktrees/app/1370-cleanup",
      "/home/me/.specwithcode/verify/app/.git",
    ]);
    expect(run.removedBytes).toBe(1_312_000_000);
    expect(run.plan.items.map((item) => item.reason)).toEqual(["unpushed"]);
    expect(cleanup.calls).toEqual(["plan", "cleanNow"]);
  }).pipe(Effect.scoped),
);
