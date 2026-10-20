import {
  DEFAULT_PROJECT_WORKSPACE_SETTINGS,
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  type OrchestrationV2ServerCommand,
  type OrchestratorMcpMachine,
  type OrchestratorMcpMachineListResult,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderLimitMachineTarget,
  RunId,
  type ServerProvider,
  type ServerSettings,
  ThreadId,
} from "@specweave-studio/contracts";
import { it as itEffect } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";
import { describe, expect, it } from "vite-plus/test";

import * as Instances from "../provider/ProviderInstanceRegistry.ts";
import * as Providers from "../provider/ProviderRegistry.ts";
import * as Projects from "../project/ProjectService.ts";
import { provider } from "../studio/fixtures.ts";
import { accountFingerprint, accountPoolKey } from "../usage/providerUsageSummary.ts";
import {
  LIMIT_PREMOVE_RECENT_MS,
  type LimitHandoffOutcome,
  type LimitHandoffRequest,
  limitHandoffTrigger,
  make,
  MachineLimitHandoff,
} from "./MachineLimitHandoff.ts";
import { makeSweep, ProviderFallbackEnv } from "./ProviderFallbackWorker.ts";
import { fallbackPolicyTestLayer } from "./providerFallbackPolicyTestHelpers.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

const stoppedAt = Date.parse("2026-10-20T13:54:00.000Z");
const resetsAt = "2026-10-20T18:00:00.000Z";
const claudeId = ProviderInstanceId.make("claudeAgent");
const codexId = ProviderInstanceId.make("codex");
const minis = EnvironmentId.make("env-minis");
const m3 = EnvironmentId.make("env-m3");
const project = {
  id: ProjectId.make("easychamp"),
  title: "EasyChamp",
  workspaceRoot: "/project",
  defaultModelSelection: null,
  workspaceSettings: DEFAULT_PROJECT_WORKSPACE_SETTINGS,
  scripts: [],
  createdAt: "2026-10-09T00:00:00Z",
  updatedAt: "2026-10-09T00:00:00Z",
  deletedAt: null,
};

function withUsage(base: ServerProvider, usedPercent: number, slug: string): ServerProvider {
  return {
    ...base,
    models: [{ slug, name: slug, isCustom: false, isDefault: true, capabilities: null }],
    usageLimits: {
      ...base.usageLimits!,
      windows: [{ id: "five_hour", kind: "session", label: "Session", usedPercent, resetsAt }],
    },
  };
}

const claudeSpent = (at: number) => withUsage(provider(claudeId, "claudeAgent", at), 100, "opus");
const codex = (at: number, used: number) =>
  withUsage(provider(codexId, "codex", at), used, "gpt-6");
const sourcePool = accountFingerprint(accountPoolKey(claudeSpent(stoppedAt))!);
const otherPool = `sha256:${"b".repeat(64)}`;

const limited = {
  id: ThreadId.make("t1"),
  projectId: project.id,
  providerInstanceId: claudeId,
  modelSelection: { instanceId: claudeId, model: "opus" },
  status: "failed" as const,
  lastErrorClass: "usage_limit" as const,
  latestRunId: RunId.make("r1"),
  activeRunId: null,
  pendingRuntimeRequest: null,
  settledOverride: null,
  usageLimitResetAt: resetsAt,
  latestRunCompletedAt: DateTime.makeUnsafe(stoppedAt),
};

const target = (environmentId: EnvironmentId, label: string): ProviderLimitMachineTarget => ({
  environmentId,
  label,
  modelSelection: { instanceId: claudeId, model: "opus" },
});

function machine(
  environmentId: EnvironmentId,
  label: string,
  overrides: Partial<OrchestratorMcpMachine> = {},
  usage: { accountFingerprint?: string | null; usedPercent?: number | null } = {},
): OrchestratorMcpMachine {
  return {
    id: label.toLowerCase(),
    label,
    environmentId,
    status: "ready",
    access: "full-access",
    grantExpiresAt: null,
    project: { match: "configured", projectId: ProjectId.make("remote"), title: "EasyChamp" },
    providers: [
      {
        providerInstanceId: claudeId,
        driverKind: ProviderDriverKind.make("claudeAgent"),
        models: ["opus"],
        available: true,
        usage: {
          accountFingerprint: otherPool,
          usedPercent: 30,
          resetsAt,
          signedIn: true,
          observedAt: DateTime.formatIso(DateTime.makeUnsafe(stoppedAt)),
          ...usage,
        },
      },
    ],
    ...overrides,
  } as OrchestratorMcpMachine;
}

interface Scenario {
  readonly settings?: Partial<ServerSettings>;
  readonly thread?: Record<string, unknown>;
  readonly machines: ReadonlyArray<OrchestratorMcpMachine>;
  /** Answer per destination; a missing entry moves the thread. */
  readonly answers?: Record<string, LimitHandoffOutcome | "die">;
  /** Leave the port and fleet unbound, as a server without 0967 is. */
  readonly unbound?: boolean;
  /** Spend this machine's other provider too, so nothing local qualifies. */
  readonly localSpent?: boolean;
}

function run(scenario: Scenario, sweeps = 1) {
  const requests: LimitHandoffRequest[] = [];
  const dispatched: OrchestrationV2ServerCommand[] = [];
  const settings: ServerSettings = {
    ...DEFAULT_SERVER_SETTINGS,
    providerLimitAction: "switch",
    providerLimitFallbackModelSelection: null,
    providerLimitFallbackModels: [{ instanceId: codexId, model: "gpt-6" }],
    providerLimitMachineTargets: [target(minis, "Minis"), target(m3, "M3")],
    ...scenario.settings,
  };
  const thread = { ...limited, ...scenario.thread };
  const providers = () => [
    claudeSpent(stoppedAt),
    codex(stoppedAt, scenario.localSpent ? 100 : 20),
  ];
  const deps = Layer.mergeAll(
    Layer.mock(Projects.ProjectService)({
      getById: () => Effect.succeed(Option.some(project)),
    }),
    fallbackPolicyTestLayer(settings),
    Layer.mock(Providers.ProviderRegistry)({
      getProviders: Effect.sync(providers),
      refreshInstance: () => Effect.sync(providers),
    }),
    Layer.mock(Instances.ProviderInstanceRegistry)({
      getInstance: () => Effect.succeed(undefined),
    }),
    Layer.mock(ProjectionStore.ProjectionStoreV2)({
      getShellSnapshot: () => Effect.succeed({ threads: [thread] } as never),
      getThreadShell: () => Effect.succeed(thread as never),
      getThreadRecords: (threadId) =>
        Effect.fail(new ProjectionStore.ProjectionStoreThreadNotFoundError({ threadId })),
    }),
    Layer.mock(ThreadManagement.ThreadManagementService)({
      dispatch: (command) =>
        Effect.sync(() => (dispatched.push(command), { sequence: 1, storedEvents: [] })),
    }),
  );
  const list: OrchestratorMcpMachineListResult = {
    local: { id: "local", label: "M4", environmentId: EnvironmentId.make("env-m4") },
    machines: scenario.machines,
    projectWorkerMachine: null,
  };
  return Effect.gen(function* () {
    yield* TestClock.setTime(stoppedAt + 30_000);
    const handoff = yield* MachineLimitHandoff;
    if (!scenario.unbound)
      yield* handoff.bind({
        listMachines: () => Effect.succeed(list),
        port: {
          available: true,
          handOff: (request) => {
            requests.push(request);
            const answer = scenario.answers?.[request.destinationEnvironmentId];
            if (answer === "die") return Effect.die(new Error("connection reset"));
            return Effect.succeed(
              answer ?? {
                type: "moved",
                machineLabel: request.destinationEnvironmentId === minis ? "Minis" : "M3",
                threadId: "remote-t1",
                notice: null,
              },
            );
          },
        },
      });
    const sweep = yield* makeSweep;
    for (let i = 0; i < sweeps; i++) {
      yield* sweep();
      yield* TestClock.adjust("1 minute");
    }
    const held = yield* handoff.holds(thread.id, thread.latestRunId);
    const shown = yield* handoff.candidates(thread.id).pipe(Effect.option);
    return { requests, dispatched, held, shown: Option.getOrNull(shown) };
  }).pipe(
    Effect.provide(Layer.effect(MachineLimitHandoff, make).pipe(Layer.provideMerge(deps))),
    Effect.provideService(ProviderFallbackEnv, {}),
  );
}

describe("limit handoff in the fallback sweep", () => {
  itEffect.effect("hands a turn stopped on the limit to the first eligible machine", () =>
    Effect.gen(function* () {
      const result = yield* run({ machines: [machine(minis, "Minis"), machine(m3, "M3")] }, 3);
      expect(result.requests).toHaveLength(1);
      expect(result.requests[0]).toMatchObject({
        threadId: limited.id,
        destinationEnvironmentId: minis,
        modelSelection: { instanceId: claudeId, model: "opus" },
        reason: "usage-limit",
        resume: true,
        idempotencyKey: "limit-handoff:t1:r1",
        sourceSummary: "Claude limit reached on M4",
      });
      // Nothing continues here, now or on later sweeps.
      expect(result.dispatched).toEqual([]);
      expect(result.held).toBe(true);
    }),
  );

  itEffect.effect("skips a machine signed in to the same account and says why", () =>
    Effect.gen(function* () {
      const result = yield* run({
        machines: [
          machine(minis, "Minis", {}, { accountFingerprint: sourcePool }),
          machine(m3, "M3", { status: "unreachable", providers: undefined }),
        ],
      });
      expect(result.requests).toEqual([]);
      // No machine qualifies, so the same-machine fallback model continues it.
      expect(result.dispatched).toHaveLength(1);
      expect(result.dispatched[0]).toMatchObject({
        type: "message.dispatch",
        modelSelection: { instanceId: codexId, model: "gpt-6" },
      });
      expect(result.held).toBe(false);
      expect(result.shown?.candidates.map((row) => row.text)).toEqual([
        "Minis: same Claude account as M4",
        "M3: offline",
      ]);
      expect(result.shown?.order).toBe("other-machine-first");
    }),
  );

  itEffect.effect("names a missing project grant", () =>
    Effect.gen(function* () {
      const result = yield* run({
        localSpent: true,
        machines: [machine(minis, "Minis", { project: { match: "none" } })],
      });
      expect(result.requests).toEqual([]);
      expect(result.dispatched).toEqual([]);
      expect(result.shown?.candidates[0]?.text).toBe("Minis: no work grant for EasyChamp");
      expect(result.shown?.waiting).toContain("Minis: no work grant for EasyChamp");
    }),
  );

  itEffect.effect("uses the same-machine model first when the order says so", () =>
    Effect.gen(function* () {
      const result = yield* run({
        settings: { providerLimitTargetOrder: "same-machine-first" },
        machines: [machine(minis, "Minis")],
      });
      expect(result.requests).toEqual([]);
      expect(result.dispatched[0]).toMatchObject({
        modelSelection: { instanceId: codexId, model: "gpt-6" },
      });
    }),
  );

  itEffect.effect("tries the next machine after a refusal and keeps the thread whole", () =>
    Effect.gen(function* () {
      const result = yield* run({
        localSpent: true,
        machines: [machine(minis, "Minis"), machine(m3, "M3")],
        answers: {
          [minis]: {
            type: "refused",
            code: "secrets_missing",
            message: "secrets missing: STRIPE_KEY",
            retryable: false,
          },
          [m3]: {
            type: "refused",
            code: "files_missing",
            message: "files missing: .env.local",
            retryable: false,
          },
        },
      });
      expect(result.requests.map((request) => request.destinationEnvironmentId)).toEqual([
        minis,
        m3,
      ]);
      expect(result.dispatched).toEqual([]);
      expect(result.held).toBe(false);
      expect(result.shown?.candidates.map((row) => [row.reason, row.text])).toEqual([
        ["refused", "Minis: secrets missing: STRIPE_KEY"],
        ["refused", "M3: files missing: .env.local"],
      ]);
    }),
  );

  itEffect.effect("never continues here while a move is in doubt, and asks the same machine", () =>
    Effect.gen(function* () {
      const result = yield* run(
        {
          machines: [machine(minis, "Minis"), machine(m3, "M3")],
          answers: { [minis]: "die" },
        },
        3,
      );
      expect(result.requests.map((request) => request.destinationEnvironmentId)).toEqual([
        minis,
        minis,
        minis,
      ]);
      expect(new Set(result.requests.map((request) => request.idempotencyKey)).size).toBe(1);
      expect(result.dispatched).toEqual([]);
      expect(result.held).toBe(true);
      expect(result.shown?.waiting).toBe(
        "Minis hasn't confirmed the handoff yet; the thread stays here until it answers.",
      );
    }),
  );

  itEffect.effect("never moves a thread the user stopped", () =>
    Effect.gen(function* () {
      const result = yield* run(
        {
          thread: { status: "interrupted", lastErrorClass: null },
          machines: [machine(minis, "Minis")],
        },
        2,
      );
      expect(result.requests).toEqual([]);
      expect(result.dispatched).toEqual([]);
    }),
  );

  itEffect.effect("changes nothing until a handoff port is bound", () =>
    Effect.gen(function* () {
      const result = yield* run({ unbound: true, machines: [machine(minis, "Minis")] });
      expect(result.requests).toEqual([]);
      expect(result.dispatched[0]).toMatchObject({
        modelSelection: { instanceId: codexId, model: "gpt-6" },
      });
      expect(result.shown?.available).toBe(false);
      expect(result.shown?.candidates[0]?.text).toBe(
        "Minis: the paired machines aren't loaded yet",
      );
    }),
  );
});

describe("limitHandoffTrigger", () => {
  const rule = {
    providerLimitAction: "switch" as const,
    providerLimitMachineTargets: [target(minis, "Minis")],
    providerLimitTargetOrder: "other-machine-first" as const,
  };
  const base = {
    thread: limited,
    rule,
    nowMs: stoppedAt + 60_000,
    stopped: true,
    atThreshold: false,
    localStep: null,
    windowKey: "five_hour",
  };

  it("resumes a turn stopped on the limit, keyed by its run", () => {
    expect(limitHandoffTrigger(base)).toEqual({
      reason: "usage-limit",
      resume: true,
      key: "limit-handoff:t1:r1",
    });
  });

  it("needs targets, the switch action and no running or pending turn", () => {
    expect(
      limitHandoffTrigger({ ...base, rule: { ...rule, providerLimitMachineTargets: [] } }),
    ).toBeNull();
    expect(
      limitHandoffTrigger({ ...base, rule: { ...rule, providerLimitAction: "wait" } }),
    ).toBeNull();
    expect(
      limitHandoffTrigger({ ...base, thread: { ...limited, activeRunId: RunId.make("r2") } }),
    ).toBeNull();
    expect(
      limitHandoffTrigger({ ...base, thread: { ...limited, settledOverride: "settled" } }),
    ).toBeNull();
  });

  it("leaves redeeming and credits to the local step", () => {
    expect(limitHandoffTrigger({ ...base, localStep: "redeem" })).toBeNull();
    expect(limitHandoffTrigger({ ...base, localStep: "switch" })).not.toBeNull();
    expect(
      limitHandoffTrigger({
        ...base,
        localStep: "switch",
        rule: { ...rule, providerLimitTargetOrder: "same-machine-first" },
      }),
    ).toBeNull();
  });

  it("moves an idle thread at the threshold once per window, without resuming", () => {
    const idle = { ...limited, status: "completed" as const, lastErrorClass: null };
    const premove = { ...base, thread: idle, stopped: false, atThreshold: true };
    expect(limitHandoffTrigger(premove)).toEqual({
      reason: "threshold",
      resume: false,
      key: "limit-premove:t1:claudeAgent:five_hour",
    });
    expect(
      limitHandoffTrigger({ ...premove, nowMs: stoppedAt + LIMIT_PREMOVE_RECENT_MS + 1 }),
    ).toBeNull();
    expect(limitHandoffTrigger({ ...premove, atThreshold: false })).toBeNull();
  });
});
