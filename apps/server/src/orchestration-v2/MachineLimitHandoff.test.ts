import { TeamRules, teamRulesOf } from "../teamRules/TeamRules.ts";
import {
  DEFAULT_PROJECT_WORKSPACE_SETTINGS,
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  HandoffModeError,
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
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import { describe, expect, it } from "vite-plus/test";
import { PERSONAL_ASSISTANT_PRIVATE_MESSAGE } from "@specweave-studio/shared/personalAssistant";

import type { PeerCheckEvidence } from "../handoff/handoffPlan.ts";
import { HANDOFF_CAPABILITIES, HANDOFF_PROTOCOL_VERSION } from "../handoff/handoffWire.ts";

import {
  HandoffTurnGate,
  PAUSED_OFFLINE_REFUSAL,
  turnRefusal,
} from "../handoff/HandoffTurnGate.ts";
import * as PreviousRelease from "../handoff/handoffReviewLock.previousRelease.test.fixture.ts";
import {
  EMPTY_HANDOFF_DOCUMENT,
  emptyThreadRecord,
  type HandoffDocument,
} from "../handoff/handoffState.ts";
import * as Instances from "../provider/ProviderInstanceRegistry.ts";
import * as Providers from "../provider/ProviderRegistry.ts";
import * as Projects from "../project/ProjectService.ts";
import { provider } from "../studio/fixtures.ts";
import { accountFingerprint, accountPoolKey } from "../usage/providerUsageSummary.ts";
import { makeLimitHandoffPort } from "./LimitHandoffAdapter.ts";
import {
  LIMIT_PREMOVE_RECENT_MS,
  type LimitHandoffCheckInput,
  type LimitHandoffOutcome,
  type LimitHandoffPortShape,
  type LimitHandoffRequest,
  limitHandoffTrigger,
  limitResumable,
  make,
  MachineLimitHandoff,
  type MachineLimitHandoffShape,
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
const m4 = EnvironmentId.make("env-m4");
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

const trackEvidence = (patch: Partial<PeerCheckEvidence> = {}): PeerCheckEvidence => ({
  modelSelection: { instanceId: claudeId, model: "opus" },
  providerName: "Claude",
  kind: "different-account",
  line: "Different Claude account · 70% left",
  percentLeft: 70,
  automatic: true,
  accountFingerprint: otherPool,
  usedPercent: 30,
  resetsAt,
  observedAt: DateTime.formatIso(DateTime.makeUnsafe(stoppedAt)),
  ...patch,
});

/** What a machine answers a track check with, as the peer client hands it over. */
const trackAnswer = (
  machineLabel: string,
  evidence: PeerCheckEvidence | null,
  capabilities: ReadonlyArray<string> = HANDOFF_CAPABILITIES,
) => ({
  kind: "answered" as const,
  response: {
    machineLabel,
    protocolVersion: HANDOFF_PROTOCOL_VERSION,
    appVersion: "1.0.390",
    capabilities: [...capabilities],
    results: [
      {
        sourceThreadId: limited.id,
        failures:
          evidence === null || evidence.automatic
            ? []
            : [{ check: "provider" as const, message: `${machineLabel}: ${evidence.line}` }],
        evidence,
      },
    ],
  },
});

const noRoom = trackEvidence({ automatic: false, line: "Claude limit reached", usedPercent: 100 });

/** A project on tracks whose Daily track is Opus on Claude, then GPT-6 on Codex. */
const onTracks: Partial<ServerSettings> = {
  threadModelMode: "tracks",
  modelLanes: {
    routine: [
      { instanceId: claudeId, model: "opus" },
      { instanceId: codexId, model: "gpt-6" },
    ],
    complex: [],
  },
};
const daily = { routing: { lane: "routine" } };

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
  /** The thread's project is this machine's personal assistant. */
  readonly personal?: boolean;
  /** The handoff state on disk, read by the turn gate (none: every turn starts). */
  readonly handoffDocument?: HandoffDocument;
  /** Replaces the scripted port, e.g. with the real adapter over a fake 0967. */
  readonly port?: LimitHandoffPortShape;
  /** Runs against the service before the sweeps. */
  readonly before?: (handoff: MachineLimitHandoffShape) => Effect.Effect<void>;
  /** A person's Stop shows from this read of the thread's Stop requests on. */
  readonly stopFromRead?: number;
  /** What each machine answers a track check with; a missing entry has no room. */
  readonly checks?: Record<string, TrackAnswer>;
  /** The thread's "Hand off automatically" is Off. */
  readonly optedOut?: boolean;
}

type TrackAnswer = NonNullable<LimitHandoffPortShape["check"]> extends (
  ...args: never[]
) => Effect.Effect<infer A>
  ? A
  : never;

function run(scenario: Scenario, sweeps = 1) {
  const requests: LimitHandoffRequest[] = [];
  const checks: Array<{ readonly environmentId: EnvironmentId; readonly input: LimitHandoffCheckInput }> =
    [];
  const dispatched: OrchestrationV2ServerCommand[] = [];
  let stopReads = 0;
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
      getById: () =>
        Effect.succeed(
          Option.some(
            scenario.personal
              ? {
                  ...project,
                  title: "Example Household",
                  workspaceRoot: "/fixtures/example-household",
                  workspaceSettings: { ...DEFAULT_PROJECT_WORKSPACE_SETTINGS, kind: "personal" },
                }
              : project,
          ),
        ),
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
      getThreadRecords: (threadId, _fields, filter) =>
        filter?.turnItemTypes?.includes("run_interrupt_request")
          ? Effect.sync(() => {
              stopReads += 1;
              const stopped = stopReads >= (scenario.stopFromRead ?? Infinity);
              return {
                thread,
                turnItems: stopped
                  ? [{ type: "run_interrupt_request", runId: thread.latestRunId, message: "Stop" }]
                  : [],
              } as never;
            })
          : Effect.fail(new ProjectionStore.ProjectionStoreThreadNotFoundError({ threadId })),
    }),
    Layer.mock(ThreadManagement.ThreadManagementService)({
      dispatch: (command) =>
        Effect.sync(() => (dispatched.push(command), { sequence: 1, storedEvents: [] })),
    }),
  );
  const list: OrchestratorMcpMachineListResult = {
    local: { id: "local", label: "M4", environmentId: m4 },
    machines: scenario.machines,
    projectWorkerMachine: null,
  };
  return Effect.gen(function* () {
    yield* TestClock.setTime(stoppedAt + 30_000);
    const handoff = yield* MachineLimitHandoff;
    if (!scenario.unbound)
      yield* handoff.bind({
        listMachines: () => Effect.succeed(list),
        port: scenario.port ?? {
          available: true,
          optedOut: () => Effect.succeed(scenario.optedOut === true),
          check: (environmentId, input) => {
            checks.push({ environmentId, input });
            return Effect.succeed(
              scenario.checks?.[environmentId] ??
                trackAnswer(environmentId === minis ? "Minis" : "M3", noRoom),
            );
          },
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
    if (scenario.before) yield* scenario.before(handoff);
    const sweep = yield* makeSweep;
    for (let i = 0; i < sweeps; i++) {
      yield* sweep();
      yield* TestClock.adjust("1 minute");
    }
    const held = yield* handoff.holds(thread.id, thread.latestRunId);
    const shown = yield* handoff.candidates(thread.id).pipe(Effect.option);
    return { requests, checks, dispatched, held, shown: Option.getOrNull(shown) };
  }).pipe(
    Effect.provide(
      Layer.effect(MachineLimitHandoff, make).pipe(
        Layer.provideMerge(deps),
        Layer.provide(
          Layer.succeed(HandoffTurnGate, {
            check: (threadId) =>
              Effect.succeed(
                scenario.handoffDocument === undefined
                  ? null
                  : turnRefusal(scenario.handoffDocument, threadId, m4),
              ),
          }),
        ),
      ),
    ),
    Effect.provideService(ProviderFallbackEnv, {}),
  );
}

// Built out here: a test body is an Effect generator.
const previousCandidate = Schema.decodeUnknownSync(PreviousRelease.LimitHandoffCandidate);

describe("limit handoff in the fallback sweep", () => {
  // A review by Claude of work an OpenAI model wrote, stopped on Claude's limit here (1390 AC-40).
  const reviewRouting = {
    taskClass: "review",
    confidence: "high",
    moved: false,
    tier: null,
    selection: limited.modelSelection,
    baseline: { instanceId: codexId, model: "gpt-6" },
    escalation: null,
    billing: "unknown",
    reason: "Review by Claude; it stays on Claude models.",
    signals: [],
    reviewFamily: "claude",
    decidedAt: "2026-10-09T11:00:00.000Z",
  };
  const review = { title: "Review the fix", routing: reviewRouting };
  const codexRow = {
    providerInstanceId: codexId,
    driverKind: ProviderDriverKind.make("codex"),
    models: ["gpt-6"],
    available: true,
    usage: {
      accountFingerprint: otherPool,
      usedPercent: 10,
      resetsAt,
      signedIn: true,
      observedAt: DateTime.formatIso(DateTime.makeUnsafe(stoppedAt)),
    },
  };
  /** A machine that keeps a reviewer lock, with these sign-ins. */
  const keepsLock = (
    environmentId: EnvironmentId,
    label: string,
    holds: "claude" | "codex" | "both",
  ) => {
    const base = machine(environmentId, label, { handoffReviewLock: true });
    return {
      ...base,
      providers:
        holds === "claude"
          ? base.providers
          : holds === "codex"
            ? [codexRow]
            : [codexRow, ...(base.providers ?? [])],
    } as OrchestratorMcpMachine;
  };

  itEffect.effect(
    "a review stays when the other machine holds only the author's family: Review stays here",
    () =>
      Effect.gen(function* () {
        const result = yield* run(
          {
            settings: { providerLimitMachineTargets: [target(minis, "Minis")] },
            machines: [keepsLock(minis, "Minis", "codex")],
            thread: review,
            localSpent: true,
          },
          3,
        );
        expect(result.requests).toHaveLength(0);
        expect(result.held).toBe(false);
        expect(result.shown?.candidates).toEqual([
          expect.objectContaining({
            environmentId: minis,
            eligible: false,
            reason: "refused",
            review: "no_reviewer",
            text: "Review stays here: no permitted reviewer on Minis",
          }),
        ]);
        // The row says it once; the wait text does not wrap it in another sentence.
        expect(result.shown?.waiting).toBe("Review stays here: no permitted reviewer on Minis.");
      }),
  );

  itEffect.effect("a review moves to a machine with a permitted reviewer, on that reviewer", () =>
    Effect.gen(function* () {
      const result = yield* run(
        {
          machines: [keepsLock(minis, "Minis", "codex"), keepsLock(m3, "M3", "claude")],
          thread: review,
          localSpent: true,
        },
        3,
      );
      expect(result.requests).toHaveLength(1);
      expect(result.requests[0]).toMatchObject({
        threadId: limited.id,
        destinationEnvironmentId: m3,
        modelSelection: { instanceId: claudeId, model: "opus" },
        resume: true,
      });
      expect(result.held).toBe(true);
    }),
  );

  itEffect.effect(
    "a review asks the other machine for a permitted model, not the saved one of the author's family",
    () =>
      Effect.gen(function* () {
        const saved: ProviderLimitMachineTarget = {
          environmentId: m3,
          label: "M3",
          modelSelection: { instanceId: codexId, model: "gpt-6" },
          modelLabel: "GPT-6",
        };
        const scenario = {
          settings: { providerLimitMachineTargets: [saved] },
          machines: [keepsLock(m3, "M3", "both")],
          localSpent: true,
        };
        // Any other thread goes to the saved model.
        const ordinary = yield* run(scenario, 1);
        expect(ordinary.requests[0]?.modelSelection).toEqual({
          instanceId: codexId,
          model: "gpt-6",
        });
        const result = yield* run({ ...scenario, thread: review }, 1);
        expect(result.requests).toHaveLength(1);
        expect(result.requests[0]?.modelSelection).toEqual({ instanceId: claudeId, model: "opus" });
        expect(result.requests[0]?.modelLabel).toBeUndefined();
      }),
  );

  itEffect.effect(
    "an older Adversarial review thread with no routing is locked to its own model's family",
    () =>
      Effect.gen(function* () {
        const older = { title: "Adversarial review: Fix the build" };
        const stays = yield* run(
          {
            settings: { providerLimitMachineTargets: [target(minis, "Minis")] },
            machines: [keepsLock(minis, "Minis", "codex")],
            thread: older,
            localSpent: true,
          },
          2,
        );
        expect(stays.requests).toHaveLength(0);
        expect(stays.shown?.candidates[0]).toMatchObject({ review: "no_reviewer" });
        const moves = yield* run(
          { machines: [keepsLock(m3, "M3", "claude")], thread: older, localSpent: true },
          2,
        );
        expect(moves.requests.map((request) => request.destinationEnvironmentId)).toEqual([m3]);
      }),
  );

  itEffect.effect(
    "a machine on the previous release is never a target for a review: it would drop the lock",
    () =>
      Effect.gen(function* () {
        expect(PreviousRelease.PREVIOUS_RELEASE).toBe("v1.0.386");
        // That release's descriptor names no reviewer lock, so its row carries none.
        expect(PreviousRelease.peerRules(PreviousRelease.descriptor(minis, "Minis"))).toEqual({
          carried: true,
        });
        const older = [machine(minis, "Minis"), machine(m3, "M3")];
        const result = yield* run({ machines: older, thread: review, localSpent: true }, 3);
        expect(result.requests).toHaveLength(0);
        expect(result.held).toBe(false);
        expect(result.shown?.candidates.map((candidate) => candidate.text)).toEqual([
          "Review stays here: update SpecWithCode on Minis",
          "Review stays here: update SpecWithCode on M3",
        ]);
        for (const candidate of result.shown?.candidates ?? []) {
          expect(candidate).toMatchObject({
            eligible: false,
            reason: "update_needed",
            review: "update_needed",
          });
          // A window on that release still reads the row.
          expect(previousCandidate(JSON.parse(JSON.stringify(candidate)))).toMatchObject({
            reason: "update_needed",
            eligible: false,
          });
        }
        // The same machines still take a thread that is no review.
        const ordinary = yield* run({ machines: older, localSpent: true }, 1);
        expect(ordinary.requests).toHaveLength(1);
        // And that release, sending, never offered a marked review to any machine.
        expect(PreviousRelease.limitTargets({ routing: reviewRouting }, [minis, m3])).toEqual([]);
      }),
  );

  itEffect.effect("a machine that was not read keeps its own verdict and takes no review", () =>
    Effect.gen(function* () {
      const result = yield* run(
        {
          settings: { providerLimitMachineTargets: [target(minis, "Minis")] },
          machines: [{ ...keepsLock(minis, "Minis", "claude"), status: "unreachable" }],
          thread: review,
          localSpent: true,
        },
        2,
      );
      expect(result.requests).toHaveLength(0);
      expect(result.shown?.candidates[0]).toMatchObject({ reason: "offline", eligible: false });
      expect(result.shown?.candidates[0]?.review).toBeUndefined();
    }),
  );

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

  itEffect.effect("a person's Stop after a refused move holds the next machine", () =>
    Effect.gen(function* () {
      const refused = {
        type: "refused" as const,
        code: "secrets_missing",
        message: "secrets missing: STRIPE_KEY",
        retryable: false,
      };
      // Read 1 is the sweep's check, read 2 admits Minis, read 3 would admit M3.
      const result = yield* run(
        {
          localSpent: true,
          machines: [machine(minis, "Minis"), machine(m3, "M3")],
          answers: { [minis]: refused },
          stopFromRead: 3,
        },
        2,
      );
      expect(result.requests.map((request) => request.destinationEnvironmentId)).toEqual([minis]);
      expect(result.dispatched).toEqual([]);
      expect(result.held).toBe(false);
    }),
  );

  itEffect.effect("a person's Stop during the fleet probe moves nothing", () =>
    Effect.gen(function* () {
      const result = yield* run(
        { localSpent: true, machines: [machine(minis, "Minis")], stopFromRead: 2 },
        2,
      );
      expect(result.requests).toEqual([]);
      expect(result.dispatched).toEqual([]);
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

  itEffect.effect("never hands off to a model the user excluded from fallback", () =>
    Effect.gen(function* () {
      const result = yield* run(
        {
          settings: { providerLimitExcludedModels: [{ model: "opus" }] },
          machines: [machine(minis, "Minis"), machine(m3, "M3")],
        },
        2,
      );
      expect(result.requests).toEqual([]);
      expect(result.shown?.candidates.map((row) => [row.eligible, row.reason])).toEqual([
        [false, "unavailable"],
        [false, "unavailable"],
      ]);
      // It continues here on the same-machine fallback model instead.
      expect(result.dispatched[0]).toMatchObject({
        type: "message.dispatch",
        modelSelection: { instanceId: codexId, model: "gpt-6" },
      });
    }),
  );

  itEffect.effect("never hands a personal assistant's thread to another machine", () =>
    Effect.gen(function* () {
      const result = yield* run(
        { personal: true, machines: [machine(minis, "Minis"), machine(m3, "M3")] },
        2,
      );
      expect(result.requests).toEqual([]);
      expect(result.held).toBe(false);
      expect(result.shown?.candidates.map((row) => [row.eligible, row.reason, row.text])).toEqual([
        [false, "refused", `Minis: ${PERSONAL_ASSISTANT_PRIVATE_MESSAGE}`],
        [false, "refused", `M3: ${PERSONAL_ASSISTANT_PRIVATE_MESSAGE}`],
      ]);
      // It continues here on the same-machine fallback model instead.
      expect(result.dispatched[0]).toMatchObject({
        type: "message.dispatch",
        modelSelection: { instanceId: codexId, model: "gpt-6" },
      });
      const spent = yield* run({
        personal: true,
        localSpent: true,
        machines: [machine(minis, "Minis")],
      });
      expect(spent.requests).toEqual([]);
      expect(spent.dispatched).toEqual([]);
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
      expect(result.shown?.waiting).toBe(
        "This SpecWithCode version can't hand threads to another machine yet.",
      );
    }),
  );

  itEffect.effect("names a refusal worth retrying in the wait text, then runs the local step", () =>
    Effect.gen(function* () {
      const result = yield* run({
        machines: [machine(minis, "Minis"), machine(m3, "M3")],
        answers: {
          [minis]: {
            type: "refused",
            code: "unreachable",
            message: "Minis did not answer.",
            retryable: true,
          },
          [m3]: {
            type: "refused",
            code: "invalid",
            message: "M3: no .env.local; M3: Claude not signed in",
            retryable: false,
          },
        },
      });
      expect(result.requests.map((request) => request.destinationEnvironmentId)).toEqual([
        minis,
        m3,
      ]);
      // Nothing moved anywhere, so the same-machine fallback continues it.
      expect(result.dispatched).toHaveLength(1);
      expect(result.dispatched[0]).toMatchObject({
        modelSelection: { instanceId: codexId, model: "gpt-6" },
      });
      expect(result.shown?.waiting).toBe(
        "No other machine has room: Minis did not answer.; M3: no .env.local; M3: Claude not signed in.",
      );
    }),
  );

  itEffect.effect("a failed preflight keeps the thread here with 0967's exact reasons", () =>
    Effect.gen(function* () {
      const message = "Minis: no .env.local; Minis: Claude not signed in";
      const notes: unknown[] = [];
      const result = yield* run(
        {
          settings: { providerLimitMachineTargets: [target(minis, "Minis")] },
          machines: [machine(minis, "Minis")],
          handoffDocument: EMPTY_HANDOFF_DOCUMENT,
          port: makeLimitHandoffPort({
            environmentId: m4,
            document: Effect.succeed(EMPTY_HANDOFF_DOCUMENT),
            handOff: () => Effect.fail(new HandoffModeError({ code: "invalid", message })),
            recordNote: (input) => Effect.sync(() => void notes.push(input)),
          }),
        },
        2,
      );
      // Shown once, as given, not "Minis: Minis: no .env.local".
      expect(result.shown?.candidates.map((row) => [row.reason, row.text])).toEqual([
        ["refused", message],
      ]);
      expect(result.shown?.waiting).toBe(`No other machine has room: ${message}.`);
      // Nothing is held: the same-machine fallback continues it here, once.
      expect(result.held).toBe(false);
      expect(result.dispatched).toHaveLength(1);
      expect(result.dispatched[0]).toMatchObject({
        type: "message.dispatch",
        modelSelection: { instanceId: codexId, model: "gpt-6" },
      });
      expect(notes).toEqual([]);
    }),
  );

  itEffect.effect("asks with the target's model label, for the thread's notice", () =>
    Effect.gen(function* () {
      const result = yield* run({
        settings: {
          providerLimitMachineTargets: [
            { ...target(minis, "Minis"), modelLabel: "Claude Opus 5.5" },
          ],
        },
        machines: [machine(minis, "Minis")],
      });
      expect(result.requests[0]).toMatchObject({
        sourceSummary: "Claude limit reached on M4",
        modelLabel: "Claude Opus 5.5",
      });
    }),
  );

  itEffect.effect("an in-doubt answer holds the thread and asks the same machine again", () =>
    Effect.gen(function* () {
      const result = yield* run(
        {
          machines: [machine(minis, "Minis"), machine(m3, "M3")],
          answers: { [minis]: { type: "in-doubt", message: "Minis did not answer." } },
        },
        2,
      );
      expect(result.requests.map((request) => request.destinationEnvironmentId)).toEqual([
        minis,
        minis,
      ]);
      expect(result.dispatched).toEqual([]);
      expect(result.held).toBe(true);
      expect(result.shown?.waiting).toBe(
        "Minis hasn't confirmed the handoff yet; the thread stays here until it answers.",
      );
    }),
  );

  itEffect.effect("a move slower than the wait is never interrupted, only stopped waiting on", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const calls: LimitHandoffRequest[] = [];
      let interrupted = false;
      let finished = false;
      const moved: LimitHandoffOutcome = {
        type: "moved",
        machineLabel: "Minis",
        threadId: "remote-t1",
        notice: null,
      };
      const result = yield* run(
        {
          machines: [machine(minis, "Minis"), machine(m3, "M3")],
          port: {
            available: true,
            handOff: (request) => {
              calls.push(request);
              // The first call is 0967 mid-takeover past the 10-minute wait; the repeat
              // returns its first result, as 0967's per-thread idempotency does.
              if (calls.length > 1) return Effect.succeed(moved);
              return Deferred.succeed(started, undefined).pipe(
                Effect.andThen(Effect.sleep("11 minutes")),
                Effect.tap(() => Effect.sync(() => (finished = true))),
                Effect.as(moved),
                Effect.onInterrupt(() => Effect.sync(() => (interrupted = true))),
              );
            },
          },
          before: () =>
            Deferred.await(started).pipe(
              Effect.andThen(TestClock.adjust("11 minutes")),
              Effect.forkChild,
              Effect.asVoid,
            ),
        },
        2,
      );
      expect(interrupted).toBe(false);
      expect(finished).toBe(true);
      expect(calls.map((request) => request.destinationEnvironmentId)).toEqual([minis, minis]);
      expect(result.dispatched).toEqual([]);
      expect(result.held).toBe(true);
    }),
  );

  itEffect.effect("after a restart, a thread still handing off never continues here", () =>
    Effect.gen(function* () {
      // Restarted: nothing in memory, only the handoff state on disk.
      const document: HandoffDocument = {
        ...EMPTY_HANDOFF_DOCUMENT,
        threads: {
          [limited.id]: {
            ...emptyThreadRecord(project.id),
            lease: {
              holderEnvironmentId: m4,
              holderLabel: "M4",
              holderThreadId: limited.id,
              epoch: 2,
              renewedAt: "2026-10-20T13:54:00.000Z",
              state: "handing-off",
            },
          },
        },
      };
      const asked: unknown[] = [];
      const result = yield* run(
        {
          machines: [machine(minis, "Minis"), machine(m3, "M3")],
          handoffDocument: document,
          port: makeLimitHandoffPort({
            environmentId: m4,
            document: Effect.succeed(document),
            handOff: (input) =>
              Effect.sync(() => asked.push(input)).pipe(Effect.andThen(Effect.die("x"))),
          }),
        },
        3,
      );
      expect(asked).toEqual([]);
      expect(result.dispatched).toEqual([]);
      expect(result.shown?.waiting).toBe(
        "This thread is being handed off; it starts no turn until the handoff finishes.",
      );
    }),
  );

  itEffect.effect("a machine that woke paused shows why, not a wait on the target", () =>
    Effect.gen(function* () {
      const document: HandoffDocument = {
        ...EMPTY_HANDOFF_DOCUMENT,
        config: { ...EMPTY_HANDOFF_DOCUMENT.config, defaultMode: "on" },
        pausedSince: "2026-10-20T13:50:00.000Z",
        threads: {
          [limited.id]: {
            ...emptyThreadRecord(project.id),
            lease: {
              holderEnvironmentId: m4,
              holderLabel: "M4",
              holderThreadId: limited.id,
              epoch: 2,
              renewedAt: "2026-10-20T13:54:00.000Z",
              state: "active",
            },
            replicas: [
              {
                environmentId: minis,
                machineLabel: "Minis",
                state: "current",
                sequence: 1,
                detail: null,
                updatedAt: "2026-10-20T13:54:00.000Z",
              },
            ],
          },
        },
      };
      const asked: unknown[] = [];
      const result = yield* run(
        {
          machines: [machine(minis, "Minis"), machine(m3, "M3")],
          handoffDocument: document,
          port: makeLimitHandoffPort({
            environmentId: m4,
            document: Effect.succeed(document),
            handOff: (input) =>
              Effect.sync(() => asked.push(input)).pipe(Effect.andThen(Effect.die("x"))),
          }),
        },
        2,
      );
      expect(asked).toEqual([]);
      expect(result.dispatched).toEqual([]);
      expect(result.shown?.waiting).toBe(PAUSED_OFFLINE_REFUSAL);
    }),
  );

  itEffect.effect("offers no machine under reach.machines none; the local step still runs", () =>
    Effect.gen(function* () {
      const result = yield* run({
        settings: { providerLimitMachineTargets: [target(minis, "Minis")] },
        machines: [machine(minis, "Minis")],
      }).pipe(
        Effect.provideService(
          TeamRules,
          teamRulesOf({
            status: "active",
            rules: { version: 1, owner: "Acme", reach: { machines: "none" } },
            fingerprint: "3a9f",
            warnings: [],
          }),
        ),
      );
      expect(result.requests).toEqual([]);
    }),
  );

  itEffect.effect("skips a machine the rules refuse, naming it, and takes the next", () =>
    Effect.gen(function* () {
      const result = yield* run({
        settings: { providerLimitMachineTargets: [target(minis, "Minis"), target(m3, "M3")] },
        machines: [
          machine(minis, "Minis", {
            teamRulesRefused: "Acme allow only machines with the same rules.",
          }),
          machine(m3, "M3"),
        ],
      });
      expect(result.requests.map((request) => request.destinationEnvironmentId)).toEqual([m3]);
    }),
  );

  itEffect.effect("a thread continued elsewhere gets no local step, with or without targets", () =>
    Effect.gen(function* () {
      const document: HandoffDocument = {
        ...EMPTY_HANDOFF_DOCUMENT,
        threads: {
          [limited.id]: {
            ...emptyThreadRecord(project.id),
            continuedOn: {
              environmentId: minis,
              machineLabel: "Minis",
              threadId: ThreadId.make("remote-t1"),
              at: "2026-10-20T13:55:00.000Z",
            },
          },
        },
      };
      for (const targets of [[target(minis, "Minis")], []]) {
        const result = yield* run(
          {
            settings: { providerLimitMachineTargets: targets },
            machines: [machine(minis, "Minis")],
            handoffDocument: document,
            port: makeLimitHandoffPort({
              environmentId: m4,
              document: Effect.succeed(document),
              handOff: () => Effect.die("never asked"),
            }),
          },
          2,
        );
        expect(result.dispatched).toEqual([]);
        expect(result.requests).toEqual([]);
      }
    }),
  );

  itEffect.effect("never hands off a stopped, completed or cancelled turn for resume", () =>
    Effect.gen(function* () {
      for (const status of ["interrupted", "completed", "cancelled", "failed"] as const) {
        const answers: Array<"handled" | "skipped"> = [];
        const result = yield* run({
          localSpent: true,
          machines: [machine(minis, "Minis")],
          // The sweep's own trigger never fires for these; ask directly.
          thread: { status, lastErrorClass: status === "failed" ? "provider_error" : null },
          before: (handoff) =>
            Effect.gen(function* () {
              const shell = { ...limited, status, lastErrorClass: null };
              answers.push(
                yield* handoff.consider({
                  thread: shell as never,
                  rule: {
                    ...DEFAULT_SERVER_SETTINGS,
                    providerLimitAction: "switch",
                    providerLimitMachineTargets: [target(minis, "Minis")],
                  },
                  trigger: { reason: "usage-limit", resume: true, key: "limit-handoff:t1:r1" },
                  providers: [],
                  projectTitle: "EasyChamp",
                  nowMs: stoppedAt,
                  admit: Effect.succeed(true),
                }),
              );
            }),
        });
        expect(answers).toEqual(["skipped"]);
        // A completed idle thread may still move at the threshold, never resumed.
        expect(result.requests.filter((request) => request.resume)).toEqual([]);
        expect(result.dispatched.filter((command) => command.type === "message.dispatch")).toEqual(
          [],
        );
      }
    }),
  );
});

describe("the automatic start when a thread's track is out here (1390 T-13)", () => {
  for (const order of ["other-machine-first", "same-machine-first"] as const) {
    itEffect.effect(
      `a track with room on this machine asks no machine, under ${order} (AC-37)`,
      () =>
        Effect.gen(function* () {
          const result = yield* run({
            settings: { ...onTracks, providerLimitTargetOrder: order },
            thread: daily,
            machines: [machine(minis, "Minis"), machine(m3, "M3")],
          });
          // The next model of the Daily track runs here; nothing was asked of Minis or M3.
          expect(result.checks).toEqual([]);
          expect(result.requests).toEqual([]);
          expect(result.dispatched[0]).toMatchObject({
            modelSelection: { instanceId: codexId, model: "gpt-6" },
          });
        }),
    );

    itEffect.effect(`a track out on this machine hands off, under ${order} (AC-37)`, () =>
      Effect.gen(function* () {
        const result = yield* run({
          settings: { ...onTracks, providerLimitTargetOrder: order },
          thread: daily,
          localSpent: true,
          machines: [machine(minis, "Minis"), machine(m3, "M3")],
          checks: { [minis]: trackAnswer("Minis", trackEvidence()) },
        });
        expect(result.requests).toHaveLength(1);
        expect(result.dispatched).toEqual([]);
      }),
    );
  }

  itEffect.effect(
    "asks the machine for the thread's own track and moves onto the sign-in it confirmed (AC-38)",
    () =>
      Effect.gen(function* () {
        const confirmed = { instanceId: codexId, model: "gpt-6" };
        const result = yield* run(
          {
            settings: {
              ...onTracks,
              providerLimitSwitchAtPercent: 95,
              // Two saved targets on Minis: the machine is still asked once.
              providerLimitMachineTargets: [
                target(minis, "Minis"),
                { ...target(minis, "Minis"), modelSelection: confirmed },
                target(m3, "M3"),
              ],
              // An unknown reading never qualifies a track move, whatever this says.
              providerLimitUnknownUsageEligible: true,
            },
            thread: daily,
            localSpent: true,
            machines: [machine(minis, "Minis"), machine(m3, "M3")],
            checks: {
              [minis]: trackAnswer("Minis", trackEvidence({ modelSelection: confirmed })),
            },
          },
          3,
        );
        expect(result.checks).toHaveLength(1);
        expect(result.checks[0]).toMatchObject({
          environmentId: minis,
          input: { start: "automatic", thresholdPercent: 95 },
        });
        const asked = result.checks[0]!.input.threads[0]!;
        expect(asked).toMatchObject({
          sourceThreadId: limited.id,
          track: "daily",
          driverKind: "claudeAgent",
        });
        // Every pool the track ran out on here, on both providers.
        expect([...asked.accountFingerprints].sort()).toEqual(
          [sourcePool, accountFingerprint(accountPoolKey(codex(stoppedAt, 100))!)].sort(),
        );
        expect(result.requests).toHaveLength(1);
        expect(result.requests[0]).toMatchObject({
          destinationEnvironmentId: minis,
          modelSelection: confirmed,
          reason: "usage-limit",
          resume: true,
          idempotencyKey: "limit-handoff:t1:r1",
          sourceSummary: "Daily track out of tokens on M4",
          track: "daily",
        });
        expect(result.held).toBe(true);
        expect(result.shown?.track).toMatchObject({
          threadId: limited.id,
          track: "daily",
          trackOut: true,
          reason: "Daily track out of tokens on M4",
          everyMachineOut: false,
          target: {
            environmentId: minis,
            machineLabel: "Minis",
            modelSelection: confirmed,
            disposition: "resume",
          },
        });
      }),
  );

  itEffect.effect(
    "a machine on the same depleted pool or with stale usage adds nothing; the next is asked (AC-38)",
    () =>
      Effect.gen(function* () {
        const result = yield* run({
          settings: { ...onTracks, providerLimitUnknownUsageEligible: true },
          thread: daily,
          localSpent: true,
          machines: [machine(minis, "Minis"), machine(m3, "M3")],
          checks: {
            [minis]: trackAnswer(
              "Minis",
              trackEvidence({
                kind: "usage-unknown",
                automatic: false,
                line: "Usage unknown",
                usedPercent: null,
              }),
            ),
            [m3]: trackAnswer("M3", trackEvidence()),
          },
        });
        expect(result.checks.map((check) => check.environmentId)).toEqual([minis, m3]);
        expect(result.requests.map((request) => request.destinationEnvironmentId)).toEqual([m3]);
      }),
  );

  const everyOut = (minisReset: string | null, m3Reset: string | null): Scenario => ({
    settings: onTracks,
    thread: daily,
    localSpent: true,
    machines: [machine(minis, "Minis"), machine(m3, "M3")],
    checks: {
      [minis]: trackAnswer("Minis", { ...noRoom, resetsAt: minisReset }),
      [m3]: trackAnswer("M3", { ...noRoom, resetsAt: m3Reset }),
    },
  });

  itEffect.effect(
    "no machine has the track: no move, no other track, the earliest reset, asked once (AC-39)",
    () =>
      Effect.gen(function* () {
        const early = DateTime.formatIso(DateTime.makeUnsafe(stoppedAt + 100_000));
        // Sweeps at +30 s and +90 s: the reset at +100 s has not come.
        const result = yield* run(everyOut(resetsAt, early), 2);
        expect(result.requests).toEqual([]);
        expect(result.dispatched).toEqual([]);
        expect(result.held).toBe(false);
        expect(result.checks.map((check) => check.environmentId)).toEqual([minis, m3]);
        expect(result.shown?.track).toMatchObject({
          track: "daily",
          trackOut: true,
          target: null,
          everyMachineOut: true,
          earliestReset: { machineLabel: "M3", at: early },
          recheckAt: early,
        });
        expect(result.shown?.waiting).toBe("Daily track is out on every machine.");
        // The third sweep, at +150 s, is past that reset: the machines are asked again, once.
        const later = yield* run(everyOut(resetsAt, early), 3);
        expect(later.checks.map((check) => check.environmentId)).toEqual([minis, m3, minis, m3]);
        expect(later.requests).toEqual([]);
      }),
  );

  itEffect.effect("with no reset time anywhere it says so, and does not ask each sweep (AC-39)", () =>
    Effect.gen(function* () {
      const result = yield* run(
        {
          ...everyOut(null, null),
          // This machine's own windows name no reset either.
          thread: { ...daily, usageLimitResetAt: null },
        },
        3,
      );
      expect(result.checks).toHaveLength(2);
      expect(result.requests).toEqual([]);
      expect(result.shown?.track).toMatchObject({ everyMachineOut: true, target: null });
    }),
  );

  itEffect.effect(
    "a machine from before the track start is never sent a thread: Needs update (EC2-04)",
    () =>
      Effect.gen(function* () {
        const result = yield* run({
          settings: { ...onTracks, providerLimitMachineTargets: [target(minis, "Minis")] },
          thread: daily,
          localSpent: true,
          machines: [machine(minis, "Minis")],
          checks: {
            // It plans hand offs and says it has room, and names no track start.
            [minis]: trackAnswer("Minis", trackEvidence(), ["handoff.v2", "handoff.plan"]),
          },
        });
        expect(result.requests).toEqual([]);
        expect(result.shown?.track?.machines).toMatchObject([
          { environmentId: minis, state: "needs-update" },
        ]);
        expect(result.shown?.track?.everyMachineOut).toBe(false);
      }),
  );

  itEffect.effect("a thread with Hand off automatically off is asked of no machine (AC-25)", () =>
    Effect.gen(function* () {
      const result = yield* run(
        {
          settings: onTracks,
          thread: daily,
          localSpent: true,
          optedOut: true,
          machines: [machine(minis, "Minis"), machine(m3, "M3")],
          checks: { [minis]: trackAnswer("Minis", trackEvidence()) },
        },
        2,
      );
      expect(result.checks).toEqual([]);
      expect(result.requests).toEqual([]);
    }),
  );

  itEffect.effect("a thread whose track is not known starts nothing by itself", () =>
    Effect.gen(function* () {
      // No routing decision, and Opus is on both tracks.
      const result = yield* run({
        settings: {
          ...onTracks,
          modelLanes: { ...onTracks.modelLanes!, complex: [{ instanceId: claudeId, model: "opus" }] },
        },
        localSpent: true,
        machines: [machine(minis, "Minis")],
        checks: { [minis]: trackAnswer("Minis", trackEvidence()) },
      });
      expect(result.checks).toEqual([]);
      expect(result.requests).toEqual([]);
    }),
  );

  itEffect.effect("a project without tracks keeps its saved order and asks no track check", () =>
    Effect.gen(function* () {
      const result = yield* run({ machines: [machine(minis, "Minis"), machine(m3, "M3")] });
      expect(result.checks).toEqual([]);
      expect(result.requests).toHaveLength(1);
      expect(result.requests[0]).toMatchObject({
        destinationEnvironmentId: minis,
        sourceSummary: "Claude limit reached on M4",
      });
      expect(result.requests[0]?.track).toBeUndefined();
      expect(result.shown?.track ?? null).toBeNull();
    }),
  );
});

describe("limitResumable", () => {
  it("allows a running turn or one stopped on the usage limit only", () => {
    expect(limitResumable(limited)).toBe(true);
    expect(limitResumable({ ...limited, activeRunId: RunId.make("r2") })).toBe(true);
    for (const status of ["interrupted", "completed", "cancelled"] as const)
      expect(limitResumable({ ...limited, status, lastErrorClass: null })).toBe(false);
    expect(limitResumable({ ...limited, lastErrorClass: "provider_error" as never })).toBe(false);
  });
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
