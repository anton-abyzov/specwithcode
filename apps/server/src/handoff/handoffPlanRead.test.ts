// @effect-diagnostics nodeBuiltinImport:off - disposable real Git fixtures only.
/**
 * The Hand off dialog's plan, read on the source (1390 AC-17, AC-22): every
 * thread in its group with the reason a row stays, the project's folder work,
 * and what the machine asked adds per provider. Reading it holds, copies and
 * sends nothing.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "@effect/vitest";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EnvironmentId,
  type HandoffPlanRow,
  RpcScopeAuthorization,
  ThreadId,
  WS_METHODS,
  WsAwayRpcGroup,
  handoffBatchRpcs,
} from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as RpcGroup from "effect/rpc/RpcGroup";
import * as RpcTest from "effect/rpc/RpcTest";

import * as RpcAuthorization from "../auth/RpcAuthorization.ts";
import { makeRig, type Rig, type RigMachine } from "./handoffTransfer.test.fixture.ts";

const temporary: Array<string> = [];
afterEach(() => {
  for (const path of temporary.splice(0))
    NodeFS.rmSync(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

const two = (rig: Rig) => rig.machines as [RigMachine, RigMachine];
const running = ThreadId.make("thread:running");
const waiting = ThreadId.make("thread:waiting");
const asking = ThreadId.make("thread:asking");
const queued = ThreadId.make("thread:queued");
const settled = ThreadId.make("thread:settled");

const read = (a: RigMachine, b: RigMachine, measure = true) =>
  a.moves.readPlan({ destinationEnvironmentId: b.environmentId, projectId: null, measure });
const rowOf = (items: ReadonlyArray<HandoffPlanRow>, id: string) =>
  items.find((item) => item.id === id);
const sentCalls = (rig: Rig) =>
  rig.network.calls.filter((call) =>
    ["replicate", "preflight", "takeover", "folder-work"].includes(call.path),
  );

describe("the Hand off dialog's plan (AC-17)", () => {
  it.effect("puts each thread in its group and says why a row stays", () =>
    Effect.gen(function* () {
      const rig = yield* makeRig(temporary);
      const [a, b] = two(rig);
      rig.addThread(a, running, { running: true });
      rig.addThread(a, waiting);
      rig.addThread(a, asking);
      a.threads.get(asking)!.pendingRuntimeRequest = {
        id: "request:ask",
        kind: "user_input",
        createdAt: "2026-11-19T12:00:00.000Z",
      };
      rig.addThread(a, queued);
      a.threads.get(queued)!.heldQueuedCount = 2;
      rig.addThread(a, settled);
      a.threads.get(settled)!.settledAt = "2026-11-19T11:00:00.000Z";

      const plan = yield* read(a, b);

      expect(plan.destinationLabel).toBe("B");
      expect(rowOf(plan.items, running)).toMatchObject({
        group: "running",
        ticked: true,
        canTick: true,
        disposition: "resume",
      });
      expect(rowOf(plan.items, waiting)).toMatchObject({
        group: "waiting",
        ticked: true,
        canTick: true,
      });
      expect(rowOf(plan.items, asking)).toMatchObject({
        group: "stays",
        canTick: false,
        stay: "question",
        reason: "Answer it first",
      });
      // A hand off by hand leaves the held messages here: the row is listed, never ticked.
      expect(rowOf(plan.items, queued)).toMatchObject({
        group: "queued",
        ticked: false,
        canTick: false,
      });
      expect(rowOf(plan.items, queued)?.reason).toContain("queued messages");
      // Settled with nothing unsaved: there is nothing to hand off.
      expect(rowOf(plan.items, settled)).toBeUndefined();
    }),
  );

  it.effect("lists an idle thread with unsaved work under its own group", () =>
    Effect.gen(function* () {
      const rig = yield* makeRig(temporary);
      const [a, b] = two(rig);
      rig.addThread(a, waiting);
      NodeFS.writeFileSync(NodePath.join(a.root, "notes.md"), "draft\n");

      const plan = yield* read(a, b);

      expect(rowOf(plan.items, waiting)).toMatchObject({
        group: "unsaved",
        ticked: true,
        disposition: "ready",
      });
    }),
  );

  it.effect("lists the project's folder work, and a broken folder stays with its path", () =>
    Effect.gen(function* () {
      const rig = yield* makeRig(temporary);
      const [a, b] = two(rig);
      const repository = (path: string, patch: object = {}) => ({
        path,
        notPushed: [],
        onlyHere: [],
        branchesNotListed: 0,
        changedFiles: 0,
        untrackedFiles: 0,
        stashes: 0,
        leftOut: [],
        leftOutNotListed: 0,
        ...patch,
      });
      a.folderSource = {
        inventory: () =>
          Effect.succeed({
            scanLimited: false,
            repositories: [
              repository("", {
                onlyHere: [{ branch: "feature", head: "a".repeat(40), commits: 2 }],
                changedFiles: 1,
              }),
            ],
          }),
        sendExtras: () => Effect.die("not sent while planning"),
        repositories: () => Effect.succeed([""]),
      } as never;
      yield* rig.restart(a);

      const plan = yield* read(a, b);
      const work = plan.items.find((item) => item.kind === "folder-work");
      expect(work).toMatchObject({
        id: a.projectId,
        group: "folder-work",
        ticked: true,
        canTick: true,
        reason: "1 uncommitted file and 1 branch only on A",
      });

      a.folderSource = {
        ...(a.folderSource as object),
        inventory: () =>
          Effect.succeed({
            scanLimited: false,
            repositories: [
              repository("vendor/lib", {
                unreadDetail: "What this repository has that Git does not carry could not be read.",
              }),
            ],
          }),
      } as never;
      yield* rig.restart(a);
      const broken = (yield* read(a, b)).items.find((item) => item.kind === "folder-work");
      expect(broken).toMatchObject({ group: "stays", canTick: false, stay: "broken-folder" });
      expect(broken?.reason).toContain("vendor/lib");
    }),
  );

  it.effect("holds, copies and sends nothing", () =>
    Effect.gen(function* () {
      const rig = yield* makeRig(temporary);
      const [a, b] = two(rig);
      rig.addThread(a, running, { running: true });
      const before = a.document.threads[running];

      yield* read(a, b);

      expect(sentCalls(rig)).toEqual([]);
      expect(rig.callsOf("check", b)).toHaveLength(1);
      expect(a.document.threads[running]).toEqual(before);
      expect(Object.keys(a.transfers.document.transfers)).toEqual([]);
      expect(a.dispatched).toEqual([]);
      expect(b.launches).toEqual([]);
    }),
  );
});

describe("what the machine asked adds (AC-22)", () => {
  const usageWith = (
    source: RigMachine["providerAccount"],
    target: RigMachine["providerAccount"],
  ) =>
    Effect.gen(function* () {
      const rig = yield* makeRig(temporary);
      const [a, b] = two(rig);
      a.providerAccount = source;
      b.providerAccount = target;
      rig.addThread(a, running, { running: true });
      return (yield* read(a, b, false)).usage;
    });

  it.effect("names a different account with what is left on it", () =>
    Effect.gen(function* () {
      expect(
        yield* usageWith(
          { email: "me@example.com", usedPercent: 90 },
          { email: "other@example.com", usedPercent: 40 },
        ),
      ).toEqual([{ providerName: "Claude", kind: "different-account", percentLeft: 60 }]);
    }),
  );

  it.effect("says the same account adds no usage", () =>
    Effect.gen(function* () {
      expect(
        yield* usageWith(
          { email: "me@example.com", usedPercent: 90 },
          { email: "me@example.com", usedPercent: 90 },
        ),
      ).toEqual([{ providerName: "Claude", kind: "same-account", percentLeft: null }]);
    }),
  );

  it.effect("never calls an account different when this machine's own is unknown", () =>
    Effect.gen(function* () {
      expect(yield* usageWith(null, { email: "other@example.com", usedPercent: 40 })).toEqual([
        { providerName: "Claude", kind: "usage-unknown", percentLeft: null },
      ]);
    }),
  );
});

describe("the plan's window call (AC-33)", () => {
  const group = RpcGroup.make(...handoffBatchRpcs).middleware(RpcScopeAuthorization);
  const input = {
    destinationEnvironmentId: EnvironmentId.make("env-b"),
    projectId: null,
    measure: false,
  };

  it("is guarded at orchestration:operate", () => {
    expect(WsAwayRpcGroup.requests.has(WS_METHODS.handoffBatchPlan)).toBe(true);
    expect(RpcAuthorization.requiredScopeForRpcMethod(WS_METHODS.handoffBatchPlan)).toBe(
      AuthOrchestrationOperateScope,
    );
  });

  it.effect("the server refuses the plan to a window that can only read", () =>
    Effect.gen(function* () {
      const handled: Array<string> = [];
      const client = yield* RpcTest.makeClient(group).pipe(
        Effect.provide(
          Layer.mergeAll(
            group.toLayerHandler(WS_METHODS.handoffBatchStart, () => Effect.never),
            group.toLayerHandler(WS_METHODS.handoffBatchRead, () => Effect.succeed([])),
            group.toLayerHandler(WS_METHODS.handoffBatchPlan, () =>
              Effect.sync(() => {
                handled.push("plan");
                return {
                  destinationEnvironmentId: input.destinationEnvironmentId,
                  destinationLabel: "B",
                  sourceLabel: "A",
                  unreachable: null,
                  usage: [],
                  items: [],
                };
              }),
            ),
            RpcAuthorization.layer([AuthOrchestrationReadScope]),
          ),
        ),
      );
      expect(yield* client[WS_METHODS.handoffBatchPlan](input).pipe(Effect.flip)).toMatchObject({
        _tag: "EnvironmentAuthorizationError",
        requiredPermission: AuthOrchestrationOperateScope,
      });
      expect(handled).toEqual([]);
    }).pipe(Effect.scoped),
  );
});
