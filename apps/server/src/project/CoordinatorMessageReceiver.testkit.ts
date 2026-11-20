/** The receiver test harness: M5 receives; fakes for every service a delivery reads. */
import {
  COORDINATOR_MESSAGE_CAPABILITY,
  type CoordinatorMessageBody,
  EnvironmentId,
  type Project,
  ProjectId,
  ThreadId,
} from "@specweave-studio/contracts";
import { expect } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import { type TeamRulesState } from "@specweave-studio/shared/teamRules";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as TestClock from "effect/testing/TestClock";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as RemoteWorkers from "../fleet/RemoteWorkers.ts";
import * as WorkGrants from "../fleet/WorkGrants.ts";
import type { EffectiveWorkGrant } from "../fleet/workGrantPolicy.ts";
import type { CoordinatorMessageDeliverRequest } from "../handoff/coordinatorMessageWire.ts";
import type { HandoffRefusal, ReceiverCaller } from "../handoff/HandoffReceiver.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as CoordinatorMessageReceiver from "./CoordinatorMessageReceiver.ts";
import * as CoordinatorMessageStore from "./CoordinatorMessageStore.ts";
import * as TeamRules from "../teamRules/TeamRules.ts";
import * as ProjectService from "./ProjectService.ts";

// M5 receives; linux-mini and build-host are the other members; studio-host is outside the project.
export const M5 = EnvironmentId.make("env-m5");
export const LINUX = EnvironmentId.make("env-linux-mini");
export const BUILD_HOST = EnvironmentId.make("env-build-host");
export const OUTSIDER = EnvironmentId.make("env-studio-host");
export const PROJECT = ProjectId.make("project-m5");
export const OTHER_PROJECT = ProjectId.make("project-m5-other");
export const PERSONAL = ProjectId.make("project-assistant");
export const COORDINATOR = ThreadId.make("project-coordinator:project-m5");
export const WORKER = ThreadId.make("thread-worker-m5");
export const OTHER_WORKER = ThreadId.make("thread-worker-other-project");
export const LOGICAL = "logical-release-notes";

export const labels = new Map<string, string>([
  [M5, "M5"],
  [LINUX, "linux-mini"],
  [BUILD_HOST, "build-host"],
  [OUTSIDER, "studio-host"],
]);

export const memberOf = (environmentId: EnvironmentId, projectId: string, generation = 1) => ({
  environmentId,
  projectId: ProjectId.make(projectId),
  coordinatorThreadId: ThreadId.make(`project-coordinator:${projectId}`),
  linkId: `link-${projectId}-${generation}`,
  generation,
});
export const members = [
  memberOf(M5, PROJECT),
  memberOf(LINUX, "project-linux"),
  memberOf(BUILD_HOST, "project-build-host"),
];

export const projectOf = (
  id: ProjectId,
  settings: {
    readonly paused?: boolean;
    readonly kind?: "personal";
    readonly members?: ReadonlyArray<ReturnType<typeof memberOf>>;
    readonly logicalId?: string;
  } = {},
): Project =>
  ({
    id,
    title: "Release notes",
    deletedAt: null,
    workspaceSettings: {
      ...(settings.paused === undefined ? {} : { paused: settings.paused }),
      ...(settings.kind === undefined ? {} : { kind: settings.kind }),
      logicalProject: {
        id: settings.logicalId ?? LOGICAL,
        title: "Release notes",
        coordinatorId: "coordinator",
        members:
          settings.members ??
          (id === PERSONAL ? [memberOf(M5, PERSONAL), members[1]!, members[2]!] : members),
      },
    },
  }) as unknown as Project;

export type Policy = WorkGrants.WorkGrantPolicyRecord;
export const policyFor = (
  environmentId: EnvironmentId,
  overrides: Partial<Policy> = {},
): Policy => ({
  coordinatorEnvironmentId: environmentId,
  projects: { kind: "linked" },
  accounts: { kind: "all" },
  owner: "self",
  legacy: false,
  runtimeCap: null,
  createdAt: "1970-01-01T00:00:00.000Z",
  updatedAt: "1970-01-01T00:00:00.000Z",
  revokedAt: null,
  interruptAt: null,
  interruptedAt: null,
  ...overrides,
});

/** What the route hands the receiver: the grant the credential resolved to. */
export const grantFor = (
  environmentId: EnvironmentId,
  options: { readonly revoked?: boolean; readonly accounts?: EffectiveWorkGrant["accounts"] } = {},
): EffectiveWorkGrant => ({
  coordinatorEnvironmentId: environmentId,
  projects: { kind: "linked" },
  accounts: options.accounts ?? { kind: "all" },
  owner: "self",
  hopLimit: 1,
  revoked: options.revoked ?? false,
  routines: false,
});

export const callerFrom = (
  environmentId: EnvironmentId,
  grant: EffectiveWorkGrant | null = grantFor(environmentId),
): ReceiverCaller => ({ sourceEnvironmentId: environmentId, grant });

export const body = (overrides: Partial<CoordinatorMessageBody> = {}): CoordinatorMessageBody => ({
  kind: "problem",
  subject: "Codex sign-in expired on M5",
  text: "A worker on M5 stopped with token_expired. A sign-in on M5 fixes it.",
  refs: [
    {
      kind: "thread",
      environmentId: M5,
      threadId: WORKER,
      title: "Release notes",
      statusAtSend: "failed",
    },
    { kind: "report", environmentId: LINUX, path: "reports/codex-token-expired.md", bytes: 6210 },
  ],
  ...overrides,
});

export let sequence = 0;
export const request = (
  overrides: Partial<CoordinatorMessageBody> = {},
  extra: Partial<CoordinatorMessageDeliverRequest> = {},
): CoordinatorMessageDeliverRequest => {
  sequence += 1;
  return {
    capabilities: [COORDINATOR_MESSAGE_CAPABILITY],
    logicalProjectId: LOGICAL,
    projectId: PROJECT,
    messageId: `message-${sequence.toString().padStart(4, "0")}`,
    clientRequestId: `client-${sequence}`,
    message: body(overrides),
    ...extra,
  };
};

export interface Harness {
  readonly projects: Map<string, Project>;
  /** Live sessions by id: the peer each acts for and its scopes. */
  readonly sessions: Map<
    string,
    {
      readonly peer: EnvironmentId;
      readonly scopes: ReadonlyArray<string>;
      readonly expiresAt?: number;
    }
  >;
  /** Runs on M5's coordinator thread by id, as its projection shows them. */
  readonly runs: Map<string, string>;
  /** Commands the receiver dispatched to the orchestrator itself; a message needs none. */
  readonly dispatched: Array<{ readonly type: string; readonly runId?: string }>;
  /**
   * What a send does: starts a turn, is refused because the thread cannot
   * start one now (nothing recorded), or fails after it may have started one.
   */
  send: "started" | "refused" | "unknown";
  /** This machine's team rules. */
  teamRules: TeamRulesState;
  /** Runs while a send is in flight, after the receiver read the store. */
  duringSend: Effect.Effect<unknown> | undefined;
  /** Runs once when the receiver looks at the coordinator thread, after its first checks. */
  duringLookup: Effect.Effect<unknown> | undefined;
  /** What the auth service says about the admitting device: stands, removed, or cannot tell. */
  device: "stands" | "removed" | "unreadable";
  /** Every device binding the receiver asked the auth service about. */
  readonly deviceChecks: Array<unknown>;
  readonly policies: Map<string, Policy>;
  /** Thread id to the project it belongs to on M5. */
  readonly shells: Map<string, ProjectId>;
  readonly sends: Array<ThreadManagementService.ThreadManagementSendInput>;
  /** Every thread-management call the receiver made, by name. */
  readonly threadCalls: Array<string>;
  /** Every work-grant call the receiver made, by name. */
  readonly grantCalls: Array<string>;
  /** Whether M5's coordinator is in a turn. */
  busy: boolean;
}

/** Records every call; anything but the calls a delivery needs dies. */
export const recording = <T extends object>(allowed: Partial<T>, calls: Array<string>): T =>
  new Proxy({} as T, {
    get: (_target, property) => {
      if (typeof property !== "string" || property === "then") return undefined;
      calls.push(property);
      const value = (allowed as Record<string, unknown>)[property];
      return value !== undefined
        ? value
        : () => Effect.die(`The receiver called ${property}, which a message never does.`);
    },
  });

export const setup = (initial: CoordinatorMessageStore.CoordinatorMessageRecord[] = []) => {
  const harness: Harness = {
    projects: new Map([
      [PROJECT, projectOf(PROJECT)],
      [OTHER_PROJECT, projectOf(OTHER_PROJECT, { logicalId: "logical-other" })],
      [PERSONAL, projectOf(PERSONAL, { kind: "personal" })],
    ]),
    policies: new Map([
      [LINUX, policyFor(LINUX)],
      [BUILD_HOST, policyFor(BUILD_HOST)],
      [OUTSIDER, policyFor(OUTSIDER)],
    ]),
    shells: new Map([
      [COORDINATOR, PROJECT],
      [WORKER, PROJECT],
      [OTHER_WORKER, OTHER_PROJECT],
    ]),
    sessions: new Map(
      [LINUX, BUILD_HOST, OUTSIDER].map((peer) => [
        `session-${peer}`,
        { peer, scopes: ["orchestration:read", "orchestration:operate"] },
      ]),
    ),
    runs: new Map(),
    dispatched: [],
    send: "started",
    teamRules: { status: "none" },
    duringSend: undefined,
    duringLookup: undefined,
    device: "stands",
    deviceChecks: [],
    sends: [],
    threadCalls: [],
    grantCalls: [],
    busy: false,
  };
  const threads = recording<ThreadManagementService.ThreadManagementService["Service"]>(
    {
      getThreadShell: ((threadId: ThreadId) => {
        const projectId = harness.shells.get(threadId);
        return Effect.succeed(
          projectId === undefined
            ? null
            : { id: threadId, projectId, deletedAt: null, archivedAt: null },
        );
      }) as never,
      getThreadProjection: ((threadId: ThreadId) =>
        Effect.gen(function* () {
          if (harness.duringLookup !== undefined && threadId === COORDINATOR) {
            const during = harness.duringLookup;
            harness.duringLookup = undefined;
            yield* during;
          }
        }).pipe(
          Effect.as({
            thread: { id: threadId },
            runs:
              threadId !== COORDINATOR
                ? []
                : [
                    ...(harness.busy ? [{ id: "run-busy", status: "running" }] : []),
                    ...[...harness.runs].map(([id, status]) => ({ id, status })),
                  ],
          }),
        )) as never,
      sendToThread: ((input: ThreadManagementService.ThreadManagementSendInput) =>
        Effect.gen(function* () {
          harness.sends.push(input);
          if (harness.duringSend !== undefined) {
            const during = harness.duringSend;
            harness.duringSend = undefined;
            yield* during;
          }
          if (harness.send === "refused")
            return yield* Effect.fail({ _tag: "OrchestratorDispatchError", cause: "Would queue." });
          if (harness.send === "unknown")
            return yield* Effect.fail({ _tag: "ThreadManagementDurableRunProjectionError" });
          return { delivery: "started", run: { id: `run-${harness.sends.length}` } };
        })) as never,
    },
    harness.threadCalls,
  );
  const grants = recording<WorkGrants.WorkGrantsShape>(
    {
      enabled: true,
      // Only the read that never creates or settles a policy.
      peekPolicy: ((environmentId: EnvironmentId) =>
        Effect.sync(() => harness.policies.get(environmentId))) as never,
      managers: Effect.succeed(new Set<string>()) as never,
    },
    harness.grantCalls,
  );
  const layer = CoordinatorMessageReceiver.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        CoordinatorMessageStore.layerMemory(initial),
        Layer.succeed(ProjectService.ProjectService, {
          getById: (id: ProjectId) =>
            Effect.succeed(Option.fromNullishOr(harness.projects.get(id))),
        } as unknown as ProjectService.ProjectService["Service"]),
        Layer.succeed(ServerEnvironment.ServerEnvironment, {
          getEnvironmentId: Effect.succeed(M5),
          getDescriptor: Effect.succeed({ environmentId: M5, label: "M5" }),
        } as unknown as ServerEnvironment.ServerEnvironment["Service"]),
        Layer.succeed(ThreadManagementService.ThreadManagementService, threads),
        Layer.succeed(WorkGrants.WorkGrants, grants),
        Layer.succeed(EnvironmentAuth.EnvironmentAuth, {
          listSessions: () =>
            Effect.sync(() =>
              [...harness.sessions].map(([sessionId, session]) => ({
                sessionId,
                principal: { kind: "coordinator", environmentId: session.peer },
                scopes: session.scopes,
                expiresAt: DateTime.makeUnsafe(session.expiresAt ?? 8.64e15),
              })),
            ),
          mcpClientDeviceStands: (device: unknown) =>
            Effect.suspend(() => {
              harness.deviceChecks.push(device);
              return harness.device === "unreadable"
                ? Effect.die("The device list cannot be read.")
                : Effect.succeed(harness.device === "stands");
            }),
        } as unknown as EnvironmentAuth.EnvironmentAuth["Service"]),
        Layer.succeed(Orchestrator.OrchestratorV2, {
          dispatch: (command: { readonly type: string; readonly runId?: string }) =>
            Effect.suspend(() => {
              harness.dispatched.push({
                type: command.type,
                ...(command.runId === undefined ? {} : { runId: command.runId }),
              });
              return Effect.succeed({});
            }),
        } as unknown as Orchestrator.OrchestratorV2["Service"]),
        Layer.succeed(TeamRules.TeamRules, {
          current: Effect.sync(() => harness.teamRules),
          forFolder: () => Effect.sync(() => harness.teamRules),
        }),
        Layer.succeed(RemoteWorkers.RemoteWorkers, {
          machineLabels: Effect.succeed(labels),
        } as unknown as RemoteWorkers.RemoteWorkersShape),
      ),
    ),
  );
  return { harness, layer };
};

export type Receiver = CoordinatorMessageReceiver.CoordinatorMessageReceiver["Service"];

export const deliver = (
  receiver: Receiver,
  caller: ReceiverCaller,
  input: CoordinatorMessageDeliverRequest,
  /** Whether the caller's credential holds the operate scope. */
  operate = true,
  /** The team rules the caller named on the request. */
  teamRulesFingerprint?: string,
  /** The device binding the caller's credential carried. */
  device: { readonly boundDevice?: { readonly key: string; readonly approval: string } } = {},
) =>
  receiver
    .deliver(caller, input, {
      operate,
      sessionId: `session-${caller.sourceEnvironmentId}`,
      ...(teamRulesFingerprint === undefined ? {} : { teamRulesFingerprint }),
      device,
    })
    .pipe(
      Effect.result,
      Effect.map((result) =>
        Result.isSuccess(result)
          ? { ok: true as const, value: result.success }
          : { ok: false as const, refusal: result.failure as HandoffRefusal },
      ),
    );

export const refusedWith = (
  receiver: Receiver,
  caller: ReceiverCaller,
  input: CoordinatorMessageDeliverRequest,
  operate = true,
) =>
  deliver(receiver, caller, input, operate).pipe(
    Effect.flatMap((answer) =>
      answer.ok ? Effect.die("The message was admitted.") : Effect.succeed(answer.refusal),
    ),
  );

export const settle = Effect.gen(function* () {
  yield* TestClock.adjust("46 seconds");
  return yield* (yield* CoordinatorMessageReceiver.CoordinatorMessageReceiver).flush;
});

export const records = Effect.flatMap(
  CoordinatorMessageStore.CoordinatorMessageStore,
  (store) => store.all,
);

export const run = <A, E>(
  test: (
    receiver: Receiver,
    harness: Harness,
  ) => Effect.Effect<
    A,
    E,
    | CoordinatorMessageReceiver.CoordinatorMessageReceiver
    | CoordinatorMessageStore.CoordinatorMessageStore
  >,
  initial?: CoordinatorMessageStore.CoordinatorMessageRecord[],
) => {
  const { harness, layer } = setup(initial);
  return Effect.gen(function* () {
    return yield* test(yield* CoordinatorMessageReceiver.CoordinatorMessageReceiver, harness);
  }).pipe(Effect.provide(layer));
};

/** Each refusal names both machines (AC-12). */
export const namesBoth = (refusal: HandoffRefusal, sender: string) => {
  expect(refusal.message).toContain("M5");
  expect(refusal.message).toContain(sender);
  expect(refusal.message).not.toMatch(/env-/);
};

/** A message this machine sent, as the outbox (T-06) records it. */
export const outgoing = (
  externalId: string,
  kind: CoordinatorMessageBody["kind"],
  overrides: Partial<CoordinatorMessageStore.CoordinatorMessageRecord> = {},
): CoordinatorMessageStore.CoordinatorMessageRecord => ({
  id: `row-${externalId}`,
  externalId,
  direction: "outgoing",
  peerEnvironmentId: LINUX,
  projectId: PROJECT,
  logicalProjectId: LOGICAL,
  clientRequestIds: [`client-${externalId}`],
  kind,
  subject: "Sent from M5",
  text: "M5 told linux-mini something.",
  refs: [],
  ...(kind === "reply" ? { replyTo: "message-from-linux" } : {}),
  dedupeKey: `${kind}:${externalId}`,
  count: 1,
  state: "delivered",
  receivedAt: 0,
  updatedAt: 0,
  ...overrides,
});
