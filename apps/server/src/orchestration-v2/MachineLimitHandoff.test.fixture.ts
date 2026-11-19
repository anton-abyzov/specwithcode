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
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";

import type { PeerCheckEvidence } from "../handoff/handoffPlan.ts";
import { HANDOFF_CAPABILITIES, HANDOFF_PROTOCOL_VERSION } from "../handoff/handoffWire.ts";

import { HandoffTurnGate, turnRefusal } from "../handoff/HandoffTurnGate.ts";
import { type HandoffDocument } from "../handoff/handoffState.ts";
import * as Instances from "../provider/ProviderInstanceRegistry.ts";
import * as Providers from "../provider/ProviderRegistry.ts";
import * as Projects from "../project/ProjectService.ts";
import { provider } from "../studio/fixtures.ts";
import { accountFingerprint, accountPoolKey } from "../usage/providerUsageSummary.ts";
import {
  type LimitHandoffCheckInput,
  type LimitHandoffOutcome,
  type LimitHandoffPortShape,
  type LimitHandoffRequest,
  make,
  MachineLimitHandoff,
  type MachineLimitHandoffShape,
} from "./MachineLimitHandoff.ts";
import { makeSweep, ProviderFallbackEnv } from "./ProviderFallbackWorker.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { fallbackPolicyTestLayer } from "./providerFallbackPolicyTestHelpers.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

export const stoppedAt = Date.parse("2026-10-20T13:54:00.000Z");
export const resetsAt = "2026-10-20T18:00:00.000Z";
export const claudeId = ProviderInstanceId.make("claudeAgent");
export const codexId = ProviderInstanceId.make("codex");
export const minis = EnvironmentId.make("env-minis");
export const m4 = EnvironmentId.make("env-m4");
export const m3 = EnvironmentId.make("env-m3");
export const project = {
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

export function withUsage(
  base: ServerProvider,
  usedPercent: number,
  slug: string,
  resets: string = resetsAt,
): ServerProvider {
  return {
    ...base,
    models: [{ slug, name: slug, isCustom: false, isDefault: true, capabilities: null }],
    usageLimits: {
      ...base.usageLimits!,
      windows: [
        { id: "five_hour", kind: "session", label: "Session", usedPercent, resetsAt: resets },
      ],
    },
  };
}

export const claudeSpent = (at: number, resets?: string) =>
  withUsage(provider(claudeId, "claudeAgent", at), 100, "opus", resets);
export const codex = (at: number, used: number, resets?: string) =>
  withUsage(provider(codexId, "codex", at), used, "gpt-6", resets);
export const sourcePool = accountFingerprint(accountPoolKey(claudeSpent(stoppedAt))!);
export const otherPool = `sha256:${"b".repeat(64)}`;

export const limited = {
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

export const target = (
  environmentId: EnvironmentId,
  label: string,
): ProviderLimitMachineTarget => ({
  environmentId,
  label,
  modelSelection: { instanceId: claudeId, model: "opus" },
});

export function machine(
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

export const trackEvidence = (patch: Partial<PeerCheckEvidence> = {}): PeerCheckEvidence => ({
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
export const trackAnswer = (
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

export const noRoom = trackEvidence({
  automatic: false,
  line: "Claude limit reached",
  usedPercent: 100,
});

/** A project on tracks whose Daily track is Opus on Claude, then GPT-6 on Codex. */
export const onTracks: Partial<ServerSettings> = {
  threadModelMode: "tracks",
  modelLanes: {
    routine: [
      { instanceId: claudeId, model: "opus" },
      { instanceId: codexId, model: "gpt-6" },
    ],
    complex: [],
  },
};
export const daily = { routing: { lane: "routine" } };

export interface Scenario {
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
  /** When this machine's sign-ins reset, when not the day's 18:00. */
  readonly localResetsAt?: string;
  /** A second thread in the same project, swept after the first. */
  readonly second?: Record<string, unknown>;
  /** Runs while a machine answers a track check: what changes between the check and the send. */
  readonly duringCheck?: (world: World) => Effect.Effect<void>;
  /** Runs after each sweep but the last, in place of the minute the clock moves by itself. */
  readonly between?: (world: World) => Effect.Effect<void>;
}

/** What a test changes while the sweep runs. */
export interface World {
  /** This machine's other sign-in has room again. */
  localReset: boolean;
  /** The thread's "Hand off automatically" is Off. */
  optedOut: boolean;
  /** The second thread, as the projection reads it now. */
  second: Record<string, unknown> | null;
  update: (patch: Partial<ServerSettings>) => Effect.Effect<void>;
}

export type TrackAnswer =
  NonNullable<LimitHandoffPortShape["check"]> extends (...args: never[]) => Effect.Effect<infer A>
    ? A
    : never;

export function run(scenario: Scenario, sweeps = 1) {
  const requests: LimitHandoffRequest[] = [];
  const checks: Array<{
    readonly environmentId: EnvironmentId;
    readonly input: LimitHandoffCheckInput;
  }> = [];
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
  const world: World = {
    localReset: false,
    optedOut: scenario.optedOut === true,
    second: scenario.second === undefined ? null : { ...thread, ...scenario.second },
    update: () => Effect.void,
  };
  const threads = () => (world.second === null ? [thread] : [thread, world.second]);
  const providers = () => [
    claudeSpent(stoppedAt, scenario.localResetsAt),
    codex(stoppedAt, scenario.localSpent && !world.localReset ? 100 : 20, scenario.localResetsAt),
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
      getShellSnapshot: () => Effect.sync(() => ({ threads: threads() }) as never),
      getThreadShell: (threadId) =>
        Effect.sync(() => (threads().find((entry) => entry.id === threadId) ?? thread) as never),
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
    const saved = yield* ServerSettingsService;
    world.update = (patch) =>
      saved.updateSettings(patch as never).pipe(Effect.orDie, Effect.asVoid);
    if (!scenario.unbound)
      yield* handoff.bind({
        listMachines: () => Effect.succeed(list),
        port: scenario.port ?? {
          available: true,
          optedOut: () => Effect.sync(() => world.optedOut),
          check: (environmentId, input) => {
            checks.push({ environmentId, input });
            const scripted =
              scenario.checks?.[environmentId] ??
              trackAnswer(environmentId === minis ? "Minis" : "M3", noRoom);
            // Each thread asks for itself; the scripted answer names the one it asked about.
            const asked = input.threads[0]?.sourceThreadId;
            const answer =
              scripted.kind !== "answered" || asked === undefined
                ? scripted
                : {
                    ...scripted,
                    response: {
                      ...scripted.response,
                      results: scripted.response.results.map((result) => ({
                        ...result,
                        sourceThreadId: asked,
                      })),
                    },
                  };
            return (scenario.duringCheck?.(world) ?? Effect.void).pipe(Effect.as(answer));
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
      yield* i < sweeps - 1 && scenario.between !== undefined
        ? scenario.between(world)
        : TestClock.adjust("1 minute");
    }
    const held = yield* handoff.holds(thread.id, thread.latestRunId);
    const shown = yield* handoff.candidates(thread.id).pipe(Effect.option);
    return { requests, checks, dispatched, held, shown: Option.getOrNull(shown), world };
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
