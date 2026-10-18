import { it } from "@effect/vitest";
import {
  DEFAULT_PROJECT_WORKSPACE_SETTINGS,
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2ThreadShell,
  type ServerProvider,
  type ServerSettings,
} from "@specweave-studio/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";
import { describe, expect } from "vite-plus/test";
import * as ProjectAdmission from "../project/ProjectAdmission.ts";
import * as Projects from "../project/ProjectService.ts";
import * as Instances from "../provider/ProviderInstanceRegistry.ts";
import * as Providers from "../provider/ProviderRegistry.ts";
import * as Settings from "../serverSettings.ts";
import { provider } from "../studio/fixtures.ts";
import { makeSweep, ProviderFallbackEnv } from "./ProviderFallbackWorker.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import { fallbackPolicyTestLayer } from "./providerFallbackPolicyTestHelpers.ts";

const at = Date.parse("2026-10-18T03:00:00Z");
const resetsAt = "2026-10-18T05:00:00Z";
const projectId = ProjectId.make("policy-project");
const claudeId = ProviderInstanceId.make("policy-claude");
const codexId = ProviderInstanceId.make("policy-codex");
const apiId = ProviderInstanceId.make("policy-api");
type Mode = "switch" | "reset" | "credits" | "api";
type Phase = "snapshot" | "probe" | "restart" | "dispatch" | "redemption";
const phases: Phase[] = ["snapshot", "probe", "restart", "dispatch", "redemption"];

function preferences(mode: Mode): ServerSettings {
  return {
    ...DEFAULT_SERVER_SETTINGS,
    providerLimitAction: mode === "switch" ? "switch" : "ask",
    providerLimitRedeemResets: mode === "reset",
    providerLimitSpendCredits: mode === "credits",
    providerLimitUseApiCredits: mode === "api",
    providerLimitWaitUnderMinutes: 0,
    providerLimitFallbackModelSelection: { instanceId: codexId, model: "gpt-6" },
  };
}

const disabled = {
  providerLimitAction: "ask" as const,
  providerLimitRedeemResets: false,
  providerLimitSpendCredits: false,
  providerLimitUseApiCredits: false,
};

function usage(
  id: ProviderInstanceId,
  driver: "claudeAgent" | "codex",
  used: number,
): ServerProvider {
  const base = provider(id, driver, at);
  return {
    ...base,
    models: [
      {
        slug: driver === "codex" ? "gpt-6" : "opus",
        name: "Default",
        isDefault: true,
        isCustom: false,
        capabilities: null,
      },
    ],
    usageLimits: {
      ...base.usageLimits!,
      windows: [
        { id: "five_hour", kind: "session", label: "Session", usedPercent: used, resetsAt },
      ],
    },
  };
}

function harness(mode: Mode, blocked?: Phase) {
  return Effect.gen(function* () {
    yield* TestClock.setTime(at);
    const settings = yield* Settings.ServerSettingsService;
    const admission = yield* ProjectAdmission.ProjectAdmission;
    const gates = {} as Record<
      Phase,
      { entered: Deferred.Deferred<void>; release: Deferred.Deferred<void> }
    >;
    for (const phase of phases)
      gates[phase] = {
        entered: yield* Deferred.make<void>(),
        release: yield* Deferred.make<void>(),
      };
    const attemptingAdmission = yield* Deferred.make<void>();
    const origin = mode === "credits" ? codexId : claudeId;
    const project = {
      id: projectId,
      title: "Policy test",
      workspaceRoot: "/policy-test",
      defaultModelSelection: null,
      workspaceSettings: DEFAULT_PROJECT_WORKSPACE_SETTINGS,
      scripts: [],
      createdAt: "2026-10-18T00:00:00Z",
      updatedAt: "2026-10-18T00:00:00Z",
      deletedAt: null,
    };
    const thread = {
      id: ThreadId.make("policy-thread"),
      projectId,
      providerInstanceId: origin,
      modelSelection: { instanceId: origin, model: mode === "credits" ? "gpt-6" : "opus" },
      status: "failed",
      lastErrorClass: "usage_limit",
      usageLimitResetAt: resetsAt,
      latestRunId: RunId.make("stopped"),
      latestRunCompletedAt: DateTime.makeUnsafe(at - 1_000),
      activeRunId: null,
      pendingRuntimeRequest: null,
      settledOverride: null,
      snoozedUntil: null,
      limitRecovery: null,
    } as OrchestrationV2ThreadShell;
    let claude = usage(claudeId, "claudeAgent", 100);
    let codex = usage(codexId, "codex", mode === "credits" ? 100 : 10);
    if (mode === "reset")
      claude = {
        ...claude,
        usageLimits: { ...claude.usageLimits!, resetCredits: { availableCount: 2 } },
      };
    if (mode === "credits")
      codex = {
        ...codex,
        usageLimits: {
          ...codex.usageLimits!,
          credits: { hasCredits: true, unlimited: false, balance: "25" },
          quotaPoolId: `codex:sha256:${"a".repeat(64)}`,
        },
      };
    const api: ServerProvider = {
      ...usage(apiId, "claudeAgent", 0),
      auth: { status: "authenticated", type: "apiKey", apiKeyBilling: true },
      usageLimits: undefined,
    };
    const state = {
      blocked,
      thread,
      project,
      consumed: 0,
      probed: 0,
      dispatched: [] as OrchestrationV2ServerCommand[],
      providers: mode === "api" ? [claude, api] : mode === "reset" ? [claude] : [claude, codex],
    };
    const pause = (phase: Phase) =>
      Effect.suspend(() =>
        state.blocked === phase
          ? Deferred.succeed(gates[phase].entered, undefined).pipe(
              Effect.andThen(Deferred.await(gates[phase].release)),
            )
          : Effect.void,
      );
    const deps = Layer.mergeAll(
      Layer.succeed(ProjectAdmission.ProjectAdmission, {
        ...admission,
        withLock: (id, effect) =>
          Deferred.succeed(attemptingAdmission, undefined).pipe(
            Effect.andThen(admission.withLock(id, effect)),
          ),
      }),
      Layer.succeed(Settings.ServerSettingsService, settings),
      Layer.mock(Projects.ProjectService)({
        getById: () => Effect.sync(() => Option.some(state.project)),
      }),
      Layer.mock(Providers.ProviderRegistry)({ getProviders: Effect.sync(() => state.providers) }),
      Layer.mock(Instances.ProviderInstanceRegistry)({
        getInstance: (id) =>
          Effect.succeed({
            enabled: true,
            readUsageLimitsNow: Effect.gen(function* () {
              state.probed++;
              yield* pause("probe");
              const value = state.providers.find((p) => p.instanceId === id)?.usageLimits;
              return value && { ...value, checkedAt: DateTime.formatIso(yield* DateTime.now) };
            }),
            consumeResetCredit: () =>
              Effect.gen(function* () {
                state.consumed++;
                yield* pause("redemption");
                return "reset" as const;
              }),
          } as never),
      }),
      Layer.mock(ProjectionStore.ProjectionStoreV2)({
        getShellSnapshot: () =>
          Effect.gen(function* () {
            const observed = { ...state.thread };
            yield* pause("snapshot");
            return { threads: [observed] } as never;
          }),
        getThreadShell: () => Effect.sync(() => state.thread),
        getThreadRecords: (_id, fields) =>
          Effect.gen(function* () {
            if (fields.some((field) => field === "providerThreads")) yield* pause("restart");
            return {
              thread: state.thread,
              runs: [
                {
                  id: "stopped",
                  ordinal: 1,
                  providerInstanceId: origin,
                  modelSelection: thread.modelSelection,
                  userMessageId: "original",
                },
              ],
              providerThreads: [{ appThreadId: thread.id, nativeThreadRef: "native" }],
              turnItems: [],
            } as never;
          }),
      }),
      Layer.mock(ThreadManagement.ThreadManagementService)({
        dispatch: (command) =>
          Effect.gen(function* () {
            yield* pause("dispatch");
            state.dispatched.push(command);
            return { sequence: 1, storedEvents: [] };
          }),
      }),
    );
    const sweep = yield* makeSweep.pipe(
      Effect.provide(deps),
      Effect.provideService(ProviderFallbackEnv, {}),
    );
    return { state, settings, admission, sweep, gates, attemptingAdmission };
  }).pipe(Effect.provide(fallbackPolicyTestLayer(preferences(mode))));
}

describe("fallback current policy commits", () => {
  for (const mode of ["switch", "reset", "credits", "api"] as const) {
    for (const scope of ["global", "project"] as const) {
      it.effect(
        `${mode}: completed ${scope} settings change supersedes an in-flight shell query`,
        () =>
          Effect.gen(function* () {
            const h = yield* harness(mode, "snapshot");
            const sweep = yield* Effect.forkChild(h.sweep());
            yield* Deferred.await(h.gates.snapshot.entered);
            yield* h.settings.updateSettings(
              scope === "global"
                ? disabled
                : { projectSettingsOverrides: { [projectId]: disabled } },
            );
            yield* Deferred.succeed(h.gates.snapshot.release, undefined);
            yield* Fiber.join(sweep);
            expect(h.state.consumed).toBe(0);
            expect(h.state.dispatched).toEqual([]);
          }),
      );
    }
    it.effect(`${mode}: settings can change while waiting for project admission`, () =>
      Effect.gen(function* () {
        const h = yield* harness(mode);
        const held = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const holder = yield* Effect.forkChild(
          h.admission.withLock(
            projectId,
            Deferred.succeed(held, undefined).pipe(Effect.andThen(Deferred.await(release))),
          ),
        );
        yield* Deferred.await(held);
        const sweep = yield* Effect.forkChild(h.sweep());
        yield* Deferred.await(h.attemptingAdmission);
        yield* h.settings.updateSettings(disabled);
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(holder);
        yield* Fiber.join(sweep);
        expect(h.state.consumed).toBe(0);
        expect(h.state.dispatched).toEqual([]);
      }),
    );
    it.effect(`${mode}: current policy is checked after continuation records load`, () =>
      Effect.gen(function* () {
        const h = yield* harness(mode, "restart");
        const sweep = yield* Effect.forkChild(h.sweep());
        yield* Deferred.await(h.gates.restart.entered);
        yield* h.settings.updateSettings(disabled);
        yield* Deferred.succeed(h.gates.restart.release, undefined);
        yield* Fiber.join(sweep);
        expect(h.state.dispatched).toEqual([]);
        expect(h.state.consumed).toBe(mode === "reset" ? 1 : 0);
      }),
    );
    it.effect(`${mode}: an unchanged eligible rule still commits once`, () =>
      Effect.gen(function* () {
        const h = yield* harness(mode);
        yield* h.sweep();
        yield* TestClock.adjust("31 seconds");
        yield* h.sweep();
        expect(h.state.dispatched).toHaveLength(1);
        expect(h.state.consumed).toBe(mode === "reset" ? 1 : 0);
      }),
    );
  }

  for (const mode of ["reset", "api"] as const) {
    it.effect(`${mode}: disabling policy while the native read is pending prevents spending`, () =>
      Effect.gen(function* () {
        const h = yield* harness(mode, "probe");
        const sweep = yield* Effect.forkChild(h.sweep());
        yield* Deferred.await(h.gates.probe.entered);
        yield* h.settings.updateSettings(disabled);
        yield* Deferred.succeed(h.gates.probe.release, undefined);
        yield* Fiber.join(sweep);
        expect(h.state.probed).toBe(1);
        expect(h.state.consumed).toBe(0);
        expect(h.state.dispatched).toEqual([]);
        h.state.blocked = undefined;
        yield* h.settings.updateSettings(preferences(mode));
        yield* TestClock.adjust("31 seconds");
        yield* h.sweep();
        expect(h.state.dispatched).toHaveLength(1);
      }),
    );
  }

  it.effect(
    "an admitted reset releases settings before awaiting the network and rechecks before continuation",
    () =>
      Effect.gen(function* () {
        const h = yield* harness("reset", "redemption");
        const sweep = yield* Effect.forkChild(h.sweep());
        yield* Deferred.await(h.gates.redemption.entered);
        yield* h.settings.updateSettings(disabled);
        expect(h.state.consumed).toBe(1);
        expect(h.state.dispatched).toEqual([]);
        yield* Deferred.succeed(h.gates.redemption.release, undefined);
        yield* Fiber.join(sweep);
        expect(h.state.dispatched).toEqual([]);
      }),
  );

  it.effect("settings writes wait for the admitted command commit", () =>
    Effect.gen(function* () {
      const h = yield* harness("switch", "dispatch");
      const sweep = yield* Effect.forkChild(h.sweep());
      yield* Deferred.await(h.gates.dispatch.entered);
      const attempted = yield* Deferred.make<void>();
      const finished = yield* Deferred.make<void>();
      const writer = yield* Effect.forkChild(
        Deferred.succeed(attempted, undefined).pipe(
          Effect.andThen(h.settings.updateSettings(disabled)),
          Effect.andThen(Deferred.succeed(finished, undefined)),
        ),
        { startImmediately: true },
      );
      yield* Deferred.await(attempted);
      expect(Option.isNone(yield* Deferred.poll(finished))).toBe(true);
      yield* Deferred.succeed(h.gates.dispatch.release, undefined);
      yield* Fiber.join(sweep);
      yield* Fiber.join(writer);
      expect(h.state.dispatched).toHaveLength(1);
      expect((yield* h.settings.getSettings).providerLimitAction).toBe("ask");
    }),
  );

  it.effect(
    "clock movement during a records query does not discard eligible Codex credit intent",
    () =>
      Effect.gen(function* () {
        const h = yield* harness("credits", "restart");
        const sweep = yield* Effect.forkChild(h.sweep());
        yield* Deferred.await(h.gates.restart.entered);
        yield* TestClock.adjust(1);
        yield* Deferred.succeed(h.gates.restart.release, undefined);
        yield* Fiber.join(sweep);
        expect(h.state.dispatched).toHaveLength(1);
      }),
  );
  it.effect("a wait rule set during a native read prevents reset redemption", () =>
    Effect.gen(function* () {
      const h = yield* harness("reset", "probe");
      const sweep = yield* Effect.forkChild(h.sweep());
      yield* Deferred.await(h.gates.probe.entered);
      yield* h.settings.updateSettings({
        projectSettingsOverrides: { [projectId]: { providerLimitWaitUnderMinutes: 180 } },
      });
      yield* Deferred.succeed(h.gates.probe.release, undefined);
      yield* Fiber.join(sweep);
      expect(h.state.consumed).toBe(0);
      expect(h.state.dispatched).toEqual([]);
    }),
  );

  it.effect("project pause and an explicit model choice made during the query are retained", () =>
    Effect.gen(function* () {
      const h = yield* harness("switch", "snapshot");
      const sweep = yield* Effect.forkChild(h.sweep());
      yield* Deferred.await(h.gates.snapshot.entered);
      h.state.project = {
        ...h.state.project,
        workspaceSettings: { ...h.state.project.workspaceSettings, paused: true },
      };
      h.state.thread = {
        ...h.state.thread,
        modelSelection: { instanceId: codexId, model: "user-choice" },
        providerInstanceId: codexId,
      };
      yield* Deferred.succeed(h.gates.snapshot.release, undefined);
      yield* Fiber.join(sweep);
      expect(h.state.dispatched).toEqual([]);
    }),
  );

  it.effect("cancelling an admitted reset never retries its uncertain window", () =>
    Effect.gen(function* () {
      const h = yield* harness("reset", "redemption");
      const sweep = yield* Effect.forkChild(h.sweep());
      yield* Deferred.await(h.gates.redemption.entered);
      yield* Fiber.interrupt(sweep);
      h.state.blocked = undefined;
      yield* TestClock.adjust("31 seconds");
      yield* h.sweep();
      expect(h.state.consumed).toBe(1);
      expect(h.state.dispatched).toEqual([]);
    }),
  );
  for (const field of ["archivedAt", "deletedAt"] as const) {
    it.effect(`a thread ${field} change during the query prevents automatic dispatch`, () =>
      Effect.gen(function* () {
        const h = yield* harness("switch", "snapshot");
        const sweep = yield* Effect.forkChild(h.sweep());
        yield* Deferred.await(h.gates.snapshot.entered);
        h.state.thread = { ...h.state.thread, [field]: DateTime.makeUnsafe(at) };
        yield* Deferred.succeed(h.gates.snapshot.release, undefined);
        yield* Fiber.join(sweep);
        expect(h.state.dispatched).toEqual([]);
      }),
    );
  }
});
