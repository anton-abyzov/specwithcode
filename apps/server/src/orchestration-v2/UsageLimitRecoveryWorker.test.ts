import { sha256 } from "../nodeCrypto.ts";
import * as ProjectAdmission from "../project/ProjectAdmission.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as Option from "effect/Option";
import * as Orchestrator from "./Orchestrator.ts";
import { assert, it } from "@effect/vitest";
import {
  ProjectId,
  CommandId,
  DEFAULT_PROJECT_WORKSPACE_SETTINGS,
  OrchestrationV2Command,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type OrchestrationV2AppThread,
  type OrchestrationV2LimitAvailability,
  type OrchestrationV2ServerCommand,
  type ServerProvider,
} from "@specweave-studio/contracts";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import * as Instances from "../provider/ProviderInstanceRegistry.ts";
import type { ProviderInstance } from "../provider/ProviderDriver.ts";
import * as Providers from "../provider/ProviderRegistry.ts";
import * as Capacity from "../studio/Capacity.ts";
import { provider } from "../studio/fixtures.ts";
import * as Settings from "../serverSettings.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as RuntimePolicy from "./RuntimePolicy.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import * as Availability from "./UsageLimitAvailability.ts";
import { MachineLimitHandoff } from "./MachineLimitHandoff.ts";
import {
  autoResumeByDefault,
  limitRecoveryCommand,
  makeSweep,
  waitRuleArmsResume,
} from "./UsageLimitRecoveryWorker.ts";
import {
  applyLimitObservation,
  hasFreshLimitPermission,
  updateLimitRecovery,
} from "./usageLimitRecovery.ts";

const decodeCommand = Schema.decodeUnknownSync(OrchestrationV2Command);
const id = ProviderInstanceId.make("codex_test_profile");
const resetAt = "1970-01-08T00:00:00.000Z";
function candidate(): ProjectionStore.ProjectionLimitRecoveryCandidate {
  return {
    id: ThreadId.make("limited"),
    providerInstanceId: id,
    status: "failed",
    lastErrorClass: "usage_limit",
    latestRunId: RunId.make("failed-run"),
    latestRunCompletedAt: DateTime.makeUnsafe(-1000),
    updatedAt: DateTime.makeUnsafe(-500),
    usageLimitResetAt: resetAt,
    archivedAt: null,
    settledOverride: null,
    pendingRuntimeRequest: null,
    snoozedUntil: null,
    limitRecovery: {
      requestId: CommandId.make("user-arm"),
      runId: RunId.make("failed-run"),
      resetAt,
      autoResume: true,
      explicitArm: true,
      armedAffinity: {
        instanceId: id,
        continuationKey: sha256(["private-home"], "hex"),
        quotaPoolId: `codex:sha256:${"a".repeat(64)}`,
      },
    },
  };
}
const instance = {
  instanceId: id,
  enabled: true,
  driverKind: "codex",
  continuationIdentity: { driverKind: "codex", continuationKey: "private-home" },
} as ProviderInstance;
function snapshot(at: number): ServerProvider {
  const base = provider(id, "codex", at);
  return {
    ...base,
    usageLimits: {
      ...base.usageLimits!,
      nativeAllowanceObservedAt: DateTime.formatIso(DateTime.makeUnsafe(at)),
      ordinaryUsageAllowed: true,
      spendControlReached: false,
      windows: [{ id: "secondary", kind: "weekly", label: "Weekly", usedPercent: 100 }],
      credits: { hasCredits: true, unlimited: false, balance: "17" },
    },
  };
}

it.effect.each([
  "allowed",
  "denied",
  "spend",
  "unknown",
  "stale",
  "wrong-pool",
  "wrong-profile",
  "legacy",
  "manual",
  "admission-fails",
] as const)("checks actual native permission, account affinity and admission: %s", (scenario) =>
  Effect.gen(function* () {
    const thread = candidate();
    const requests: string[] = [];
    const admissions: string[] = [];
    let instanceRead = 0;
    const chosen =
      scenario === "legacy" || scenario === "manual"
        ? {
            ...thread,
            limitRecovery: {
              ...thread.limitRecovery!,
              explicitArm: false,
              autoResume: scenario === "legacy",
              checkNow: true,
            },
          }
        : thread;
    const deps = Layer.mergeAll(
      Layer.mock(Instances.ProviderInstanceRegistry)({
        getInstance: () =>
          Effect.sync(() =>
            ++instanceRead > 1 && scenario === "wrong-profile"
              ? {
                  ...instance,
                  continuationIdentity: {
                    ...instance.continuationIdentity,
                    continuationKey: "another-home",
                  },
                }
              : instance,
          ),
      }),
      Layer.mock(Providers.ProviderRegistry)({
        getProviders: Effect.succeed([snapshot(0)]),
        refreshInstance: (requested) =>
          Effect.gen(function* () {
            requests.push(requested);
            const now = yield* Clock.currentTimeMillis;
            const fresh = snapshot(now);
            return [
              {
                ...fresh,
                usageLimits: {
                  ...fresh.usageLimits!,
                  ...(scenario === "denied" ? { ordinaryUsageAllowed: false } : {}),
                  ...(scenario === "spend" ? { spendControlReached: true } : {}),
                  ...(scenario === "unknown" ? { ordinaryUsageAllowed: null } : {}),
                  ...(scenario === "stale"
                    ? {
                        nativeAllowanceObservedAt: DateTime.formatIso(
                          DateTime.makeUnsafe(now - 1000),
                        ),
                      }
                    : {}),
                  ...(scenario === "wrong-pool"
                    ? { quotaPoolId: `codex:sha256:${"b".repeat(64)}` }
                    : {}),
                },
              },
            ];
          }),
      }),
      Layer.mock(Capacity.Capacity)({
        assertNativeStart: (requested, cwd) =>
          Effect.gen(function* () {
            admissions.push(requested);
            assert.equal(cwd, "/private-fixture");
            if (scenario === "admission-fails") return yield* Effect.die("denied");
          }),
      }),
      Layer.mock(ProjectionStore.ProjectionStoreV2)({
        getThread: () =>
          Effect.succeed({
            modelSelection: { instanceId: id, model: "test" },
          } as OrchestrationV2AppThread),
      }),
      Layer.mock(RuntimePolicy.RuntimePolicyV2)({
        resolve: () =>
          Effect.succeed({
            cwd: "/private-fixture",
            runtimeMode: "full-access",
            interactionMode: "default",
          }),
      }),
    );
    yield* Effect.gen(function* () {
      const service = yield* Availability.UsageLimitAvailability;
      const result = yield* service.check(chosen);
      assert.equal(
        result.observation?.status,
        ["allowed", "manual"].includes(scenario)
          ? "allowed"
          : ["denied", "spend"].includes(scenario)
            ? "denied"
            : scenario.startsWith("wrong-")
              ? "changed"
              : "unknown",
      );
      assert.deepEqual(requests, [id]);
      if (["allowed", "manual", "admission-fails"].includes(scenario))
        assert.deepEqual(admissions, [id]);
      else assert.deepEqual(admissions, []);
      assert.isNull(
        (yield* service.check({
          ...chosen,
          limitRecovery: { ...chosen.limitRecovery!, checkNow: true },
        })).observation,
      );
      assert.lengthOf(requests, 1);
      yield* TestClock.adjust("1 minute");
      // A stored automatic backoff remains binding after process recreation.
      if (result.observation)
        assert.isNull(
          (yield* service.check({
            ...chosen,
            limitRecovery: {
              ...chosen.limitRecovery!,
              checkNow: false,
              availability: result.observation,
            },
          })).observation,
        );
    }).pipe(Effect.provide(Availability.layer), Effect.provide(deps));
  }),
);

it.effect(
  "persists the check before once-only early dispatch and leaves a manual check unarmed",
  () =>
    Effect.gen(function* () {
      for (const autoResume of [true, false]) {
        let current = {
          ...candidate(),
          limitRecovery: { ...candidate().limitRecovery!, autoResume, checkNow: true },
        };
        const commands: OrchestrationV2ServerCommand[] = [];
        const observation: OrchestrationV2LimitAvailability = {
          checkedAt: "1970-01-01T00:00:00.000Z",
          retryAt: "1970-01-01T00:05:00.000Z",
          status: "allowed",
          threadUpdatedAt: DateTime.formatIso(current.updatedAt),
          affinity: candidate().limitRecovery!.armedAffinity!,
        };
        const deps = Layer.mergeAll(
          ProjectAdmission.layer,
          Layer.mock(Availability.UsageLimitAvailability)({
            check: () => Effect.succeed({ codex: true, mayResume: true, observation }),
          }),
          Layer.mock(ProjectStore.ProjectStoreV2)({
            get: () =>
              Effect.succeed(
                Option.some({ projectId: ProjectId.make("project") } as ProjectStore.ProjectRow),
              ),
          }),
          Settings.layerTest(),
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getLimitRecoveryCandidates: () => Effect.succeed([current]),
            getThreadShell: () =>
              Effect.succeed({ ...current, projectId: ProjectId.make("project") } as never),
          }),
          Layer.mock(ThreadManagement.ThreadManagementService)({
            dispatch: (command) =>
              Effect.gen(function* () {
                commands.push(command);
                if (command.type === "thread.metadata.update") {
                  const observed = applyLimitObservation(
                    { ...current, deletedAt: null },
                    command,
                    yield* DateTime.now,
                  );
                  assert.isNotNull(observed);
                  current = {
                    ...current,
                    updatedAt: yield* DateTime.now,
                    limitRecovery: observed!.limitRecovery!,
                  } as typeof current;
                } else if (command.type === "message.dispatch")
                  current = { ...current, status: "running" };
                return { sequence: 1, storedEvents: [] };
              }),
          }),
        );
        yield* Effect.gen(function* () {
          const sweep = yield* makeSweep;
          yield* sweep();
          yield* sweep();
        }).pipe(Effect.provide(deps));
        assert.deepEqual(
          commands.map((c) => c.type),
          autoResume ? ["thread.metadata.update", "message.dispatch"] : ["thread.metadata.update"],
        );
      }
    }),
);

it("strips client-forged permission observations and policy-arm markers", () => {
  const decoded = decodeCommand({
    type: "thread.metadata.update",
    commandId: "check",
    threadId: "thread",
    limitRecoveryPolicyArm: true,
    limitAvailability: { runId: "run", observation: { status: "allowed" } },
    limitRecovery: {
      runId: "run",
      resetAt: null,
      checkNow: true,
      explicitArm: true,
      availability: { status: "allowed" },
    },
  });
  assert.isFalse("limitAvailability" in decoded);
  assert.isFalse("limitRecoveryPolicyArm" in decoded);
  assert.deepEqual(decoded.type === "thread.metadata.update" && decoded.limitRecovery, {
    runId: RunId.make("run"),
    resetAt: null,
    checkNow: true,
  });
});

it("requires fresh proof and preserves cancellation, snooze, CAS and repeated-failure fences", () => {
  const thread = candidate();
  const observation = {
    checkedAt: DateTime.formatIso(DateTime.makeUnsafe(0)),
    retryAt: DateTime.formatIso(DateTime.makeUnsafe(300000)),
    status: "allowed" as const,
    threadUpdatedAt: DateTime.formatIso(thread.updatedAt),
    affinity: candidate().limitRecovery!.armedAffinity!,
  };
  const permitted = {
    ...thread,
    limitRecovery: { ...thread.limitRecovery!, availability: observation },
  };
  assert.isNotNull(limitRecoveryCommand(permitted, false, 0));
  assert.isFalse(hasFreshLimitPermission(permitted, 60_001));
  for (const patch of [
    { status: "running" as const },
    { archivedAt: DateTime.makeUnsafe(0) },
    { settledOverride: "settled" as const },
    { pendingRuntimeRequest: {} as never },
    { snoozedUntil: DateTime.makeUnsafe(20000) },
    { updatedAt: DateTime.makeUnsafe(0) },
    { providerInstanceId: ProviderInstanceId.make("other") },
  ])
    assert.isNull(limitRecoveryCommand({ ...permitted, ...patch }, false, 0));
  assert.isNull(
    limitRecoveryCommand({ ...thread, latestRunId: RunId.make("failed-again") }, true, 0),
  );
  assert.isNotNull(
    limitRecoveryCommand(
      {
        ...permitted,
        usageLimitResetAt: null,
        limitRecovery: { ...permitted.limitRecovery, resetAt: null },
      },
      false,
      0,
    ),
  );
  const updated = updateLimitRecovery(
    permitted.limitRecovery,
    { runId: thread.latestRunId!, resetAt, checkNow: true },
    CommandId.make("check"),
  );
  assert.equal(updated?.autoResume, true);
  assert.equal(updated?.availability?.status, "unknown");
  assert.isNull(
    applyLimitObservation(
      { ...thread, deletedAt: null },
      {
        type: "thread.metadata.update",
        commandId: CommandId.make("result"),
        threadId: thread.id,
        limitAvailability: {
          runId: thread.latestRunId!,
          requestId: CommandId.make("old-arm"),
          expectedUpdatedAt: DateTime.formatIso(thread.updatedAt),
          observation,
        },
      },
      DateTime.makeUnsafe(0),
    ),
  );
});

it.effect("freezes identity at arm time and refuses an account change before the first check", () =>
  Effect.gen(function* () {
    let current = snapshot(0);
    let probes = 0;
    const deps = Layer.mergeAll(
      Layer.mock(Instances.ProviderInstanceRegistry)({
        getInstance: () => Effect.succeed(instance),
      }),
      Layer.mock(Providers.ProviderRegistry)({
        getProviders: Effect.sync(() => [current]),
        refreshInstance: () =>
          Effect.sync(() => {
            probes++;
            return [current];
          }),
      }),
      Layer.mock(Capacity.Capacity)({
        assertNativeStart: () => Effect.die("must not admit a changed account"),
      }),
      Layer.mock(ProjectionStore.ProjectionStoreV2)({}),
      Layer.mock(RuntimePolicy.RuntimePolicyV2)({}),
    );
    yield* Effect.gen(function* () {
      const service = yield* Availability.UsageLimitAvailability;
      const bound = yield* service.bind(id);
      assert.isNotNull(bound);
      current = {
        ...current,
        usageLimits: { ...current.usageLimits!, quotaPoolId: `codex:sha256:${"b".repeat(64)}` },
      };
      const result = yield* service.check({
        ...candidate(),
        limitRecovery: { ...candidate().limitRecovery!, armedAffinity: bound! },
      });
      assert.equal(result.observation?.status, "changed");
      assert.equal(probes, 0);
      current = { ...current, checkedAt: "1969-12-31T23:00:00.000Z" };
      assert.isNull(yield* service.bind(id));
    }).pipe(Effect.provide(Availability.layer), Effect.provide(deps));
  }),
);

it.effect("captures the server's identity for a user arm and never binds policy arms", () =>
  Effect.gen(function* () {
    const sent: OrchestrationV2ServerCommand[] = [];
    const bound: string[] = [];
    const deps = Layer.mergeAll(
      Layer.mock(Availability.UsageLimitAvailability)({
        bind: (instanceId) =>
          Effect.sync(() => {
            bound.push(instanceId);
            return candidate().limitRecovery!.armedAffinity!;
          }),
      }),
      Layer.mock(Orchestrator.OrchestratorV2)({
        getThreadProjection: () => Effect.succeed({ thread: { providerInstanceId: id } } as never),
        dispatch: (command) =>
          Effect.sync(() => {
            sent.push(command);
            return { sequence: sent.length, storedEvents: [] };
          }),
      }),
    );
    yield* Effect.gen(function* () {
      const service = yield* ThreadManagement.ThreadManagementService;
      const command = {
        type: "thread.metadata.update" as const,
        commandId: CommandId.make("user-choice"),
        threadId: candidate().id,
        limitRecovery: { runId: candidate().latestRunId!, resetAt, autoResume: true },
      };
      yield* service.dispatch(command);
      yield* service.dispatch({
        ...command,
        commandId: CommandId.make("policy-choice"),
        limitRecoveryPolicyArm: true,
      });
    }).pipe(Effect.provide(ThreadManagement.layer), Effect.provide(deps));
    assert.deepEqual(bound, [id]);
    assert.deepEqual(
      sent[0]?.type === "thread.metadata.update" && sent[0].limitRecoveryAffinity,
      candidate().limitRecovery!.armedAffinity,
    );
    assert.isFalse("limitRecoveryAffinity" in sent[1]!);
  }),
);

it.effect.each([
  "active",
  "paused",
  "archived",
  "deleted",
  "missing",
  "rebound",
  "disabled",
] as const)(
  "rechecks project auto-arm policy under admission when the waiting project becomes %s",
  (scenario) =>
    Effect.gen(function* () {
      const projectId = ProjectId.make(`auto-arm-${scenario}`);
      const lockHeld = yield* Deferred.make<void>();
      const initialRead = yield* Deferred.make<void>();
      const releasePolicy = yield* Deferred.make<void>();
      let changed = false;
      let projectReads = 0;
      let availabilityChecks = 0;
      const current = {
        ...candidate(),
        latestRunId: RunId.make("failed-run"),
        limitRecovery: null,
      };
      const commands: OrchestrationV2ServerCommand[] = [];
      const deps = Layer.mergeAll(
        ProjectAdmission.layer,
        Settings.layerTest({
          autoResumeLimitedThreads: false,
          snoozeLimitedThreads: false,
        }),
        Layer.mock(Availability.UsageLimitAvailability)({
          check: () =>
            Effect.sync(() => {
              availabilityChecks++;
              return { codex: false, mayResume: true, observation: null };
            }),
        }),
        Layer.mock(ProjectStore.ProjectStoreV2)({
          get: () =>
            Effect.gen(function* () {
              const observed =
                changed && scenario === "missing"
                  ? Option.none()
                  : Option.some({
                      projectId,
                      deletedAt: changed && scenario === "deleted" ? "2026-10-09T00:00:00Z" : null,
                      workspaceSettings: {
                        ...DEFAULT_PROJECT_WORKSPACE_SETTINGS,
                        autoResume: !(changed && scenario === "disabled"),
                        paused: changed && scenario === "paused",
                        archived: changed && scenario === "archived",
                      },
                    } as ProjectStore.ProjectRow);
              // Snapshot the old policy before allowing the holder to change it and release the lock.
              if (++projectReads === 1) yield* Deferred.succeed(initialRead, undefined);
              return observed;
            }),
        }),
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getLimitRecoveryCandidates: () => Effect.succeed([current]),
          getThreadShell: () =>
            Effect.sync(
              () =>
                ({
                  ...current,
                  projectId:
                    changed && scenario === "rebound"
                      ? ProjectId.make("foreign-project")
                      : projectId,
                }) as never,
            ),
        }),
        Layer.mock(ThreadManagement.ThreadManagementService)({
          dispatch: (command) =>
            Effect.sync(() => {
              commands.push(command);
              return { sequence: commands.length, storedEvents: [] };
            }),
        }),
      );
      yield* Effect.gen(function* () {
        const admission = yield* ProjectAdmission.ProjectAdmission;
        const sweep = yield* makeSweep;
        const changingPolicy = yield* admission
          .withLock(
            projectId,
            Effect.gen(function* () {
              yield* Deferred.succeed(lockHeld, undefined);
              yield* Deferred.await(releasePolicy);
              changed = true;
            }),
          )
          .pipe(Effect.forkScoped);
        yield* Deferred.await(lockHeld);
        const sweeping = yield* sweep().pipe(Effect.forkScoped);
        yield* Deferred.await(initialRead);
        assert.deepEqual(commands, []);
        yield* Deferred.succeed(releasePolicy, undefined);
        yield* Fiber.join(changingPolicy);
        yield* Fiber.join(sweeping);
      }).pipe(Effect.provide(deps));
      assert.equal(projectReads, 2);
      assert.equal(availabilityChecks, 0);
      if (scenario === "active") {
        assert.deepEqual(commands, [
          {
            type: "thread.metadata.update",
            commandId: CommandId.make(
              `limit-arm:${current.id}:${current.latestRunId}:${Date.parse(resetAt)}`,
            ),
            threadId: current.id,
            limitRecoveryPolicyArm: true,
            limitRecovery: { runId: current.latestRunId, resetAt, autoResume: true, snooze: false },
          },
        ]);
      } else assert.deepEqual(commands, []);
    }).pipe(Effect.scoped),
);

it.effect.each(["paused", "archived", "deleted", "missing"] as const)(
  "does not resume when the project becomes %s during quota refresh",
  (scenario) =>
    Effect.gen(function* () {
      const projectId = ProjectId.make("lifecycle-project");
      const enteredCheck = yield* Deferred.make<void>();
      const finishCheck = yield* Deferred.make<void>();
      let changed = false;
      let projectReads = 0;
      let current = {
        ...candidate(),
        limitRecovery: { ...candidate().limitRecovery!, checkNow: true },
      };
      const commands: OrchestrationV2ServerCommand[] = [];
      const observation: OrchestrationV2LimitAvailability = {
        checkedAt: "1970-01-01T00:00:00.000Z",
        retryAt: "1970-01-01T00:05:00.000Z",
        status: "allowed",
        threadUpdatedAt: DateTime.formatIso(current.updatedAt),
        affinity: current.limitRecovery.armedAffinity!,
      };
      const deps = Layer.mergeAll(
        ProjectAdmission.layer,
        Settings.layerTest(),
        Layer.mock(Availability.UsageLimitAvailability)({
          check: () =>
            Effect.gen(function* () {
              yield* Deferred.succeed(enteredCheck, undefined);
              yield* Deferred.await(finishCheck);
              return { codex: true, mayResume: true, observation };
            }),
        }),
        Layer.mock(ProjectStore.ProjectStoreV2)({
          get: () =>
            Effect.sync(() => {
              projectReads++;
              return changed && scenario === "missing"
                ? Option.none()
                : Option.some({
                    projectId,
                    deletedAt:
                      changed && scenario === "deleted" ? "2026-10-09T00:00:00.000Z" : null,
                    workspaceSettings: {
                      ...DEFAULT_PROJECT_WORKSPACE_SETTINGS,
                      paused: changed && scenario === "paused",
                      archived: changed && scenario === "archived",
                    },
                  } as ProjectStore.ProjectRow);
            }),
        }),
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getLimitRecoveryCandidates: () => Effect.succeed([current]),
          getThreadShell: () => Effect.succeed({ ...current, projectId } as never),
        }),
        Layer.mock(ThreadManagement.ThreadManagementService)({
          dispatch: (command) =>
            Effect.gen(function* () {
              commands.push(command);
              if (command.type === "thread.metadata.update") {
                const observed = applyLimitObservation(
                  { ...current, deletedAt: null },
                  command,
                  yield* DateTime.now,
                );
                current = {
                  ...current,
                  updatedAt: yield* DateTime.now,
                  limitRecovery: observed!.limitRecovery!,
                } as typeof current;
              }
              return { sequence: commands.length, storedEvents: [] };
            }),
        }),
      );
      yield* Effect.gen(function* () {
        const admission = yield* ProjectAdmission.ProjectAdmission;
        const sweep = yield* makeSweep;
        const running = yield* sweep().pipe(Effect.forkScoped);
        yield* Deferred.await(enteredCheck);
        // This must complete while quota refresh is still waiting: no network I/O under the lock.
        yield* admission.withLock(
          projectId,
          Effect.sync(() => {
            changed = true;
          }),
        );
        yield* Deferred.succeed(finishCheck, undefined);
        yield* Fiber.join(running);
      }).pipe(Effect.provide(deps));
      assert.isAtLeast(projectReads, 2);
      assert.deepEqual(
        commands.map((command) => command.type),
        ["thread.metadata.update"],
      );
    }).pipe(Effect.scoped),
);

it.effect("serializes final project policy and resume dispatch with a competing pause", () =>
  Effect.gen(function* () {
    const projectId = ProjectId.make("resume-lock-project");
    const finalRead = yield* Deferred.make<void>();
    const allowRead = yield* Deferred.make<void>();
    const pauseAttempted = yield* Deferred.make<void>();
    let paused = false;
    let reads = 0;
    const order: string[] = [];
    const current = {
      ...candidate(),
      usageLimitResetAt: "1969-12-31T23:59:59.750Z",
      limitRecovery: { ...candidate().limitRecovery!, resetAt: "1969-12-31T23:59:59.750Z" },
    };
    const deps = Layer.mergeAll(
      ProjectAdmission.layer,
      Settings.layerTest(),
      Layer.mock(Availability.UsageLimitAvailability)({
        check: () => Effect.succeed({ codex: false, mayResume: true, observation: null }),
      }),
      Layer.mock(ProjectStore.ProjectStoreV2)({
        get: () =>
          Effect.gen(function* () {
            if (++reads === 2) {
              yield* Deferred.succeed(finalRead, undefined);
              yield* Deferred.await(allowRead);
            }
            return Option.some({
              projectId,
              deletedAt: null,
              workspaceSettings: { ...DEFAULT_PROJECT_WORKSPACE_SETTINGS, paused },
            } as ProjectStore.ProjectRow);
          }),
      }),
      Layer.mock(ProjectionStore.ProjectionStoreV2)({
        getLimitRecoveryCandidates: () => Effect.succeed([current]),
        getThreadShell: () => Effect.succeed({ ...current, projectId } as never),
      }),
      Layer.mock(ThreadManagement.ThreadManagementService)({
        dispatch: (command) =>
          Effect.sync(() => {
            assert.isFalse(paused);
            assert.equal(command.type, "message.dispatch");
            order.push("resume");
            return { sequence: 1, storedEvents: [] };
          }),
      }),
    );
    yield* Effect.gen(function* () {
      const admission = yield* ProjectAdmission.ProjectAdmission;
      const sweep = yield* makeSweep;
      const running = yield* sweep().pipe(Effect.forkScoped);
      yield* Deferred.await(finalRead);
      const pausing = yield* Deferred.succeed(pauseAttempted, undefined).pipe(
        Effect.andThen(
          admission.withLock(
            projectId,
            Effect.sync(() => {
              paused = true;
              order.push("pause");
            }),
          ),
        ),
        Effect.forkScoped,
      );
      yield* Deferred.await(pauseAttempted);
      assert.isFalse(paused);
      yield* Deferred.succeed(allowRead, undefined);
      yield* Fiber.join(running);
      yield* Fiber.join(pausing);
    }).pipe(Effect.provide(deps));
    assert.deepEqual(order, ["resume", "pause"]);
  }).pipe(Effect.scoped),
);

it("arms the resume at reset when the wait rule holds back an automatic switch", () => {
  const nowMs = Date.parse("2026-10-09T12:00:00.000Z");
  const at = (minutes: number) => ({
    usageLimitResetAt: DateTime.formatIso(DateTime.makeUnsafe(nowMs + minutes * 60_000)),
  });
  const rule = { providerLimitAction: "switch", providerLimitWaitUnderMinutes: 30 };
  assert.strictEqual(waitRuleArmsResume(at(20), rule, nowMs), true);
  assert.strictEqual(waitRuleArmsResume(at(45), rule, nowMs), false);
  assert.strictEqual(waitRuleArmsResume({ usageLimitResetAt: null }, rule, nowMs), false);
  assert.strictEqual(
    waitRuleArmsResume(at(20), { ...rule, providerLimitWaitUnderMinutes: 0 }, nowMs),
    false,
  );
  // Nothing automatic to hold back: the person's own auto-resume choice stands.
  assert.strictEqual(
    waitRuleArmsResume(at(20), { ...rule, providerLimitAction: "ask" }, nowMs),
    false,
  );
  assert.strictEqual(
    waitRuleArmsResume(at(20), { ...rule, providerLimitAction: "wait" }, nowMs),
    false,
  );
  assert.strictEqual(
    waitRuleArmsResume(
      at(20),
      { ...rule, providerLimitAction: "ask", providerLimitRedeemResets: true },
      nowMs,
    ),
    true,
  );
});

/**
 * A Claude thread stops on its 5-hour limit. Claude has no availability probe,
 * so the reset time alone decides: nothing happens before it, the thread
 * continues once after it, and a sweep built after a restart does the same
 * from the persisted choice.
 */
const claudeLimitStop = (resetMs: number) => {
  const claude = ProviderInstanceId.make("claudeAgent");
  const reset = DateTime.formatIso(DateTime.makeUnsafe(resetMs));
  return {
    ...candidate(),
    id: ThreadId.make("claude-limited"),
    providerInstanceId: claude,
    latestRunCompletedAt: DateTime.makeUnsafe(0),
    updatedAt: DateTime.makeUnsafe(0),
    usageLimitResetAt: reset,
    limitRecovery: null,
  } satisfies ProjectionStore.ProjectionLimitRecoveryCandidate;
};

const claudeSweepHarness = (input: {
  thread: ProjectionStore.ProjectionLimitRecoveryCandidate;
  projectAutoResume?: boolean;
  globalAutoResume?: boolean;
}) => {
  const projectId = ProjectId.make("claude-limit-project");
  const state = {
    current: input.thread,
    commands: [] as OrchestrationV2ServerCommand[],
    /** The persisted handoff state keeps the thread from starting a turn here. */
    handoffBlocked: false,
  };
  const deps = Layer.mergeAll(
    ProjectAdmission.layer,
    Settings.layerTest({
      providerLimitAction: "wait",
      autoResumeLimitedThreads: input.globalAutoResume ?? false,
    }),
    Layer.mock(Availability.UsageLimitAvailability)({
      // What the real service answers for a provider without a native probe.
      check: () => Effect.succeed({ codex: false, observation: null }),
    }),
    Layer.mock(ProjectStore.ProjectStoreV2)({
      get: () =>
        Effect.succeed(
          Option.some({
            projectId,
            deletedAt: null,
            workspaceSettings: {
              ...DEFAULT_PROJECT_WORKSPACE_SETTINGS,
              autoResume: input.projectAutoResume ?? false,
            },
          } as ProjectStore.ProjectRow),
        ),
    }),
    Layer.mock(ProjectionStore.ProjectionStoreV2)({
      getLimitRecoveryCandidates: () => Effect.sync(() => [state.current]),
      getThreadShell: () => Effect.sync(() => ({ ...state.current, projectId }) as never),
    }),
    Layer.mock(ThreadManagement.ThreadManagementService)({
      dispatch: (command) =>
        Effect.sync(() => {
          state.commands.push(command);
          if (command.type === "thread.metadata.update" && command.limitRecovery)
            state.current = {
              ...state.current,
              limitRecovery: updateLimitRecovery(
                state.current.limitRecovery,
                command.limitRecovery,
                command.commandId,
                command.limitRecoveryPolicyArm === true,
              )!,
            };
          return { sequence: state.commands.length, storedEvents: [] };
        }),
    }),
  );
  // A fresh sweep per call: nothing survives in memory, as after a restart.
  const sweep = Effect.flatMap(makeSweep, (run) => run()).pipe(
    Effect.provide(deps),
    Effect.provideService(MachineLimitHandoff, {
      ...MachineLimitHandoff.defaultValue(),
      localTurnBlocked: () => Effect.sync(() => state.handoffBlocked),
    }),
  );
  return { state, sweep };
};

it.effect("auto-continues a Claude thread once its limit resets, across a restart", () =>
  Effect.gen(function* () {
    const resetMs = 5 * 60 * 60_000;
    const { state, sweep } = claudeSweepHarness({ thread: claudeLimitStop(resetMs) });
    // Nothing is armed until the person ticks the box.
    yield* sweep;
    assert.deepEqual(state.commands, []);
    // The checkbox sends exactly this update.
    state.current = {
      ...state.current,
      limitRecovery: updateLimitRecovery(
        null,
        {
          runId: state.current.latestRunId!,
          resetAt: state.current.usageLimitResetAt!,
          autoResume: true,
        },
        CommandId.make("checkbox"),
      )!,
    };
    yield* TestClock.adjust("4 hours");
    yield* sweep;
    assert.deepEqual(state.commands, [], "no resume before the reset");
    yield* TestClock.adjust("1 hour");
    yield* TestClock.adjust("1 minute");
    yield* sweep;
    assert.lengthOf(state.commands, 1);
    const resume = state.commands[0]!;
    assert.equal(resume.type, "message.dispatch");
    if (resume.type !== "message.dispatch") return;
    assert.equal(resume.text, "Continue where you left off.");
    assert.equal(resume.usageLimitContinuationOfRunId, state.current.latestRunId);
    // A second sweep repeats the same command id, which the receipt store dedupes.
    yield* sweep;
    assert.equal(state.commands[1]?.commandId, resume.commandId);
  }),
);

it.effect("never resumes here a thread the handoff state holds, across a restart", () =>
  Effect.gen(function* () {
    const resetMs = 5 * 60 * 60_000;
    const { state, sweep } = claudeSweepHarness({
      thread: claudeLimitStop(resetMs),
      projectAutoResume: true,
    });
    // Handing off (or continued elsewhere), written to disk before the restart.
    state.handoffBlocked = true;
    yield* sweep;
    yield* TestClock.adjust("5 hours");
    yield* TestClock.adjust("1 minute");
    yield* sweep;
    yield* sweep;
    assert.deepEqual(
      state.commands.filter((command) => command.type === "message.dispatch"),
      [],
    );
    // Once the move is settled the other way (refused, lease back), it resumes here.
    state.handoffBlocked = false;
    yield* sweep;
    assert.equal(state.commands.at(-1)?.type, "message.dispatch");
  }),
);

it.effect("arms a Claude stop by itself when only the global auto-resume setting is on", () =>
  Effect.gen(function* () {
    const { state, sweep } = claudeSweepHarness({
      thread: claudeLimitStop(60 * 60_000),
      globalAutoResume: true,
    });
    yield* sweep;
    assert.lengthOf(state.commands, 1);
    assert.equal(state.commands[0]?.type, "thread.metadata.update");
    assert.isTrue(state.current.limitRecovery?.autoResume);
    yield* TestClock.adjust("61 minutes");
    yield* sweep;
    assert.equal(state.commands.at(-1)?.type, "message.dispatch");
  }),
);

it.effect("leaves a Claude stop without a reset time for the person to continue", () =>
  Effect.gen(function* () {
    const { state, sweep } = claudeSweepHarness({
      thread: { ...claudeLimitStop(0), usageLimitResetAt: null },
      globalAutoResume: true,
    });
    yield* TestClock.adjust("6 hours");
    yield* sweep;
    assert.deepEqual(state.commands, []);
  }),
);

it("lets either the project or the global setting arm new stops", () => {
  assert.isTrue(autoResumeByDefault(false, { autoResumeLimitedThreads: true }));
  assert.isTrue(autoResumeByDefault(true, { autoResumeLimitedThreads: false }));
  assert.isTrue(autoResumeByDefault(undefined, { autoResumeLimitedThreads: true }));
  assert.isFalse(autoResumeByDefault(false, { autoResumeLimitedThreads: false }));
});

const policyProjectId = ProjectId.make("recovery-policy-race");
const policyRaceHarness = (
  input: {
    settings?: Parameters<typeof Settings.layerTest>[0];
    query?: Effect.Effect<void>;
    projectRead?: Effect.Effect<void>;
    commit?: Effect.Effect<void>;
    check?: Effect.Effect<void>;
    resume?: Effect.Effect<void>;
  } = {},
) => {
  const state = {
    current: null as ProjectionStore.ProjectionLimitRecoveryCandidate | null,
    commands: [] as OrchestrationV2ServerCommand[],
    queries: 0,
    projectReads: 0,
    checks: 0,
  };
  const deps = Layer.mergeAll(
    ProjectAdmission.layer,
    Settings.layerTest({
      autoResumeLimitedThreads: true,
      snoozeLimitedThreads: false,
      providerLimitAction: "ask",
      ...input.settings,
    }),
    Layer.mock(ProjectStore.ProjectStoreV2)({
      get: () =>
        Effect.gen(function* () {
          if (++state.projectReads === 1 && input.projectRead) yield* input.projectRead;
          return Option.some({
            projectId: policyProjectId,
            deletedAt: null,
            workspaceSettings: DEFAULT_PROJECT_WORKSPACE_SETTINGS,
          } as ProjectStore.ProjectRow);
        }),
    }),
    Layer.mock(ProjectionStore.ProjectionStoreV2)({
      getLimitRecoveryCandidates: () =>
        Effect.gen(function* () {
          if (++state.queries === 1 && input.query) yield* input.query;
          return state.current ? [state.current] : [];
        }),
      getThreadShell: () =>
        Effect.sync(() =>
          state.current ? ({ ...state.current, projectId: policyProjectId } as never) : null,
        ),
    }),
    Layer.mock(Availability.UsageLimitAvailability)({
      check: () =>
        Effect.gen(function* () {
          state.checks++;
          if (input.check) yield* input.check;
          return { codex: false, observation: null };
        }),
    }),
    Layer.mock(ThreadManagement.ThreadManagementService)({
      dispatch: (command) =>
        Effect.gen(function* () {
          if (command.type === "thread.metadata.update" && input.commit) yield* input.commit;
          if (command.type === "message.dispatch" && input.resume) yield* input.resume;
          state.commands.push(command);
          if (command.type === "thread.metadata.update" && command.limitRecovery)
            state.current = {
              ...state.current!,
              limitRecovery: updateLimitRecovery(
                state.current!.limitRecovery,
                command.limitRecovery,
                command.commandId,
                command.limitRecoveryPolicyArm === true,
              )!,
            };
          if (command.type === "message.dispatch")
            state.current = { ...state.current!, status: "running" };
          return { sequence: state.commands.length, storedEvents: [] };
        }),
    }),
  );
  return { state, deps };
};

it.effect.each(["global", "project-wait", "snooze"] as const)(
  "does not use stale %s policy after a blocked candidate query finds a new stop",
  (policy) =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const { state, deps } = policyRaceHarness({
        settings: {
          autoResumeLimitedThreads: policy === "global",
          snoozeLimitedThreads: policy === "snooze",
          ...(policy === "project-wait"
            ? {
                projectSettingsOverrides: {
                  [policyProjectId]: {
                    providerLimitAction: "switch",
                    providerLimitWaitUnderMinutes: 30,
                  },
                },
              }
            : {}),
        },
        query: Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))),
      });
      yield* Effect.gen(function* () {
        const settings = yield* Settings.ServerSettingsService;
        const sweep = yield* makeSweep;
        const running = yield* sweep().pipe(Effect.forkScoped);
        yield* Deferred.await(entered);
        yield* settings.updateSettings({
          autoResumeLimitedThreads: false,
          snoozeLimitedThreads: false,
          projectSettingsOverrides: {
            [policyProjectId]: {
              providerLimitAction: "ask",
              providerLimitRedeemResets: false,
              providerLimitSpendCredits: false,
              providerLimitUseApiCredits: false,
            },
          },
        });
        // The fixture does not even exist until the settings write has completed.
        state.current = claudeLimitStop(60_000);
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(running);
        assert.deepEqual(state.commands, []);
        yield* TestClock.adjust("2 minutes");
        yield* sweep();
        assert.deepEqual(state.commands, []);
        assert.equal(state.checks, 0);
      }).pipe(Effect.provide(deps));
    }).pipe(Effect.scoped),
);

it.effect("rechecks settings after waiting for project admission", () =>
  Effect.gen(function* () {
    const held = yield* Deferred.make<void>();
    const selected = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const { state, deps } = policyRaceHarness({
      projectRead: Deferred.succeed(selected, undefined).pipe(Effect.asVoid),
    });
    state.current = claudeLimitStop(60_000);
    yield* Effect.gen(function* () {
      const admission = yield* ProjectAdmission.ProjectAdmission;
      const settings = yield* Settings.ServerSettingsService;
      const sweep = yield* makeSweep;
      const holder = yield* admission
        .withLock(
          policyProjectId,
          Deferred.succeed(held, undefined).pipe(Effect.andThen(Deferred.await(release))),
        )
        .pipe(Effect.forkScoped);
      yield* Deferred.await(held);
      const running = yield* sweep().pipe(Effect.forkScoped);
      yield* Deferred.await(selected);
      yield* settings.updateSettings({ autoResumeLimitedThreads: false });
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(holder);
      yield* Fiber.join(running);
      assert.deepEqual(state.commands, []);
    }).pipe(Effect.provide(deps));
  }).pipe(Effect.scoped),
);

it.effect("serializes the policy arm commit before a competing settings write", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const attempted = yield* Deferred.make<void>();
    const written = yield* Deferred.make<void>();
    const order: string[] = [];
    const { state, deps } = policyRaceHarness({
      commit: Deferred.succeed(entered, undefined).pipe(
        Effect.andThen(Deferred.await(release)),
        Effect.tap(() =>
          Effect.sync(() => {
            order.push("arm");
          }),
        ),
        Effect.asVoid,
      ),
    });
    state.current = claudeLimitStop(60_000);
    yield* Effect.gen(function* () {
      const settings = yield* Settings.ServerSettingsService;
      const sweep = yield* makeSweep;
      const running = yield* sweep().pipe(Effect.forkScoped);
      yield* Deferred.await(entered);
      const writing = yield* Deferred.succeed(attempted, undefined).pipe(
        Effect.andThen(settings.updateSettings({ autoResumeLimitedThreads: false })),
        Effect.tap(() =>
          Effect.sync(() => {
            order.push("write");
          }),
        ),
        Effect.tap(() => Deferred.succeed(written, undefined)),
        Effect.forkChild({ startImmediately: true }),
      );
      yield* Deferred.await(attempted);
      yield* Effect.yieldNow;
      assert.isTrue(Option.isNone(yield* Deferred.poll(written)));
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(running);
      yield* Fiber.join(writing);
      assert.deepEqual(order, ["arm", "write"]);
      assert.isTrue(state.current!.limitRecovery!.autoResume);
    }).pipe(Effect.provide(deps));
  }).pipe(Effect.scoped),
);

it.effect(
  "keeps explicit recovery and releases settings during availability and continuation",
  () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const resuming = yield* Deferred.make<void>();
      const finishResume = yield* Deferred.make<void>();
      const { state, deps } = policyRaceHarness({
        check: Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))),
        resume: Deferred.succeed(resuming, undefined).pipe(
          Effect.andThen(Deferred.await(finishResume)),
        ),
      });
      const stop = claudeLimitStop(60_000);
      state.current = {
        ...stop,
        limitRecovery: updateLimitRecovery(
          null,
          {
            runId: stop.latestRunId!,
            resetAt: stop.usageLimitResetAt!,
            autoResume: true,
          },
          CommandId.make("explicit-recovery"),
        )!,
      };
      const explicit = state.current.limitRecovery;
      yield* TestClock.adjust("2 minutes");
      yield* Effect.gen(function* () {
        const settings = yield* Settings.ServerSettingsService;
        const sweep = yield* makeSweep;
        const running = yield* sweep().pipe(Effect.forkScoped);
        yield* Deferred.await(entered);
        // Completion before the check is released proves no settings lock spans the probe.
        yield* settings.updateSettings({ autoResumeLimitedThreads: false });
        yield* Deferred.succeed(release, undefined);
        yield* Deferred.await(resuming);
        yield* settings.updateSettings({ snoozeLimitedThreads: true });
        yield* Deferred.succeed(finishResume, undefined);
        yield* Fiber.join(running);
        assert.deepEqual(
          state.commands.map((command) => command.type),
          ["message.dispatch"],
        );
        assert.deepEqual(state.current!.limitRecovery, explicit);
      }).pipe(Effect.provide(deps));
    }).pipe(Effect.scoped),
);

it.effect("does not arm a new stop with policy captured before an availability check", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const { state, deps } = policyRaceHarness({
      check: Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))),
    });
    const stop = claudeLimitStop(60_000);
    state.current = {
      ...stop,
      limitRecovery: updateLimitRecovery(
        null,
        {
          runId: stop.latestRunId!,
          resetAt: stop.usageLimitResetAt!,
          autoResume: true,
        },
        CommandId.make("explicit-before-new-stop"),
      )!,
    };
    yield* TestClock.adjust("2 minutes");
    yield* Effect.gen(function* () {
      const settings = yield* Settings.ServerSettingsService;
      const sweep = yield* makeSweep;
      const running = yield* sweep().pipe(Effect.forkScoped);
      yield* Deferred.await(entered);
      yield* settings.updateSettings({ autoResumeLimitedThreads: false });
      state.current = { ...claudeLimitStop(180_000), latestRunId: RunId.make("new-stop") };
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(running);
      yield* TestClock.adjust("2 minutes");
      yield* sweep();
      assert.deepEqual(state.commands, []);
      assert.isNull(state.current.limitRecovery);
    }).pipe(Effect.provide(deps));
  }).pipe(Effect.scoped),
);

it.effect("skips the candidate read while nothing has changed since one found none", () =>
  Effect.gen(function* () {
    const state = { queries: 0, writes: 0, found: false };
    const deps = Layer.mergeAll(
      ProjectAdmission.layer,
      Settings.layerTest({ autoResumeLimitedThreads: true, snoozeLimitedThreads: false }),
      Layer.mock(ProjectStore.ProjectStoreV2)({}),
      Layer.mock(ProjectionStore.ProjectionStoreV2)({
        writeCount: Effect.sync(() => state.writes),
        getLimitRecoveryCandidates: () =>
          Effect.sync(() => {
            state.queries += 1;
            return state.found ? [candidate()] : [];
          }),
        getThreadShell: () => Effect.succeed(null),
      }),
      Layer.mock(Availability.UsageLimitAvailability)({}),
      Layer.mock(ThreadManagement.ThreadManagementService)({}),
    );
    yield* Effect.gen(function* () {
      const settings = yield* Settings.ServerSettingsService;
      const sweep = yield* makeSweep;
      const tick = Effect.andThen(sweep(), TestClock.adjust("5 seconds"));
      // Before: one read per five-second tick. After: one until something changes.
      for (let index = 0; index < 5; index += 1) yield* tick;
      assert.equal(state.queries, 1);
      // A projection write is a change.
      state.writes += 1;
      yield* tick;
      assert.equal(state.queries, 2);
      // So is the snooze setting, which the read is made against.
      yield* settings.updateSettings({ snoozeLimitedThreads: true });
      yield* tick;
      assert.equal(state.queries, 3);
      // Only the clock can then make a candidate (a snooze ending): read now and then.
      for (let index = 0; index < 6; index += 1) yield* tick;
      assert.equal(state.queries, 4);
      // A read that finds candidates is never skipped after.
      state.writes += 1;
      state.found = true;
      yield* tick;
      yield* tick;
      assert.equal(state.queries, 6);
    }).pipe(Effect.provide(deps));
  }),
);
