// @effect-diagnostics nodeBuiltinImport:off - a real state folder per machine.
/**
 * A routine bound to a worker that was handed off never runs on the machine it
 * left (1390 AC-45), whatever starts it, with the scheduler built over the
 * handoff gate the server gives it, not a test stub. A handoff file that does
 * not read makes it wait, and it runs once the file reads again.
 */
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { afterEach, assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProjectId,
  type ScheduledTask,
  ThreadId,
} from "@specweave-studio/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../config.ts";
import type * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as HandoffModeStore from "../handoff/HandoffModeStore.ts";
import {
  EMPTY_HANDOFF_DOCUMENT,
  emptyThreadRecord,
  HandoffDocument,
  type HandoffThreadRecord,
} from "../handoff/handoffState.ts";
import * as HandoffTurnGate from "../handoff/HandoffTurnGate.ts";
import * as RuntimeLayer from "../orchestration-v2/runtimeLayer.ts";
import { fleet, type Machine, type SchedulerLayer } from "./ScheduledTaskRunner.testkit.ts";
import { threadHandedOffNote } from "./ScheduledTaskRunnerRecords.ts";

const NOON = "2026-11-03T12:00:00.000Z";
const DUE = "2026-11-03T11:59:00.000Z";
const WORKER = "worker-thread";
const ALPHA = EnvironmentId.make("env-alpha");
const encodeDocument = Schema.encodeSync(HandoffDocument);

/** `alpha`'s worker continued on `beta`. */
const MOVED = JSON.stringify(
  encodeDocument({
    ...EMPTY_HANDOFF_DOCUMENT,
    threads: {
      [WORKER]: {
        ...emptyThreadRecord(ProjectId.make("project-alpha")),
        continuedOn: {
          environmentId: EnvironmentId.make("env-beta"),
          machineLabel: "beta",
          threadId: ThreadId.make("continued-thread"),
          at: "2026-11-03T11:58:00.000Z",
        },
      },
    },
  }),
);
const NOT_MOVED = JSON.stringify(encodeDocument(EMPTY_HANDOFF_DOCUMENT));
/** `alpha` sent the takeover for its worker and has no answer yet. */
const LEASE = {
  holderEnvironmentId: ALPHA,
  holderLabel: "alpha",
  holderThreadId: ThreadId.make(WORKER),
  epoch: 1,
  renewedAt: "2026-11-03T11:58:00.000Z",
} as const;
const HANDING_OFF = JSON.stringify(
  encodeDocument({
    ...EMPTY_HANDOFF_DOCUMENT,
    threads: {
      [WORKER]: {
        ...emptyThreadRecord(ProjectId.make("project-alpha")),
        lease: { ...LEASE, state: "handing-off" },
      },
    },
  }),
);

const temporary: Array<string> = [];
afterEach(() => {
  for (const path of temporary.splice(0)) NodeFS.rmSync(path, { recursive: true, force: true });
});

const platformOf = (
  stateDir: string,
  environment: Layer.Layer<ServerEnvironment.ServerEnvironment>,
) =>
  Layer.mergeAll(
    Layer.succeed(ServerConfig.ServerConfig, { stateDir } as never),
    NodeServices.layer,
    NodeCrypto.layer,
    environment,
  );

/**
 * Each machine's scheduler composed exactly as the server composes it, on a
 * state folder of its own; `alpha`'s handoff file holds `alphaFile`. `rewrite`
 * changes that file, `update` changes alpha's record through the store its
 * scheduler reads, and `platform` builds alpha's gate by hand.
 */
const serverGates = (alphaFile: string) => {
  const folders = new Map<
    string,
    { readonly file: string; readonly platform: ReturnType<typeof platformOf> }
  >();
  const stores = new Map<string, HandoffModeStore.HandoffModeStore["Service"]>();
  const scheduler = <Services>(
    services: Layer.Layer<Services>,
    environment: Layer.Layer<ServerEnvironment.ServerEnvironment>,
    environmentId: EnvironmentId,
  ) => {
    const stateDir = NodeFS.realpathSync(
      NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "swc-routine-gate-")),
    );
    temporary.push(stateDir);
    const file = NodePath.join(stateDir, "handoff-mode.json");
    NodeFS.writeFileSync(file, environmentId === ALPHA ? alphaFile : NOT_MOVED);
    const platform = platformOf(stateDir, environment);
    folders.set(environmentId, { file, platform });
    // The server's own composition: delete its handoff gate and these tests fail.
    // The store the gate reads, the one instance this build makes of it.
    const store = Layer.effectDiscard(
      Effect.gen(function* () {
        stores.set(environmentId, yield* HandoffModeStore.HandoffModeStore);
      }),
    ).pipe(Layer.provide(HandoffModeStore.layer));
    return Layer.merge(RuntimeLayer.scheduledTaskLayerOver(services), store).pipe(
      Layer.provide(platform),
    ) as unknown as SchedulerLayer;
  };
  return {
    scheduler,
    rewrite: (text: string) => NodeFS.writeFileSync(folders.get(ALPHA)!.file, text),
    platform: () => folders.get(ALPHA)!.platform,
    update: (change: (record: HandoffThreadRecord | undefined) => HandoffThreadRecord) =>
      stores
        .get(ALPHA)!
        .update((document) => [
          undefined,
          {
            ...document,
            threads: { ...document.threads, [WORKER]: change(document.threads[WORKER]) },
          },
        ])
        .pipe(Effect.orDie),
  };
};

const addWorker = (machine: Machine) =>
  machine.sql`INSERT INTO orchestration_v2_projection_threads ${machine.sql.insert({ thread_id: WORKER, project_id: machine.projectId, title: "Synthetic", default_provider: "codex", runtime_mode: "full-access", interaction_mode: "default", created_at: "2026-10-09T00:00:00Z", updated_at: "2026-10-09T00:00:00Z", deleted_at: null, payload_json: "{}" })}`;

const settle = (machine: Machine) => machine.runner.reconcile({ force: true });

/** One delivery to the routine's local URL, and the reason it was refused, once it settles. */
const deliver = (machine: Machine, task: ScheduledTask) =>
  Effect.gen(function* () {
    const answer = yield* machine.service.triggerWebhook({
      hookId: task.id,
      token: task.webhook!.path.split("/").at(-1) ?? "",
      method: "POST",
      path: `/api/hooks/${task.id}`,
      query: "",
      headers: { "content-type": "application/json" },
      body: new TextEncoder().encode("{}"),
      bodyText: "{}",
    });
    // The URL stays local and answers; the delivery is logged and then refused.
    assert.equal(answer._tag, "accepted");
    const deliveryId = answer._tag === "accepted" ? answer.deliveryId : "";
    const read = machine.service
      .listWebhookDeliveries({ id: task.id })
      .pipe(Effect.map(({ deliveries }) => deliveries.find((entry) => entry.id === deliveryId)));
    let delivery = yield* read;
    for (let turn = 0; turn < 1000 && delivery?.outcome === "accepted"; turn++) {
      yield* Effect.yieldNow;
      delivery = yield* read;
    }
    return delivery?.error ?? null;
  });

it.effect("a worker's routine rests after the worker is handed off, with the server's gate", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse(NOON));
    const gates = serverGates(MOVED);
    const { machines, everyoneLooks, fires, network } = yield* fleet(["alpha", "beta"], {
      scheduler: gates.scheduler,
    });
    const [alpha, beta] = machines as [Machine, Machine];

    // Control: the gate itself reads the handoff file and names the machine.
    const direct = yield* Layer.build(
      Layer.fresh(HandoffTurnGate.layer.pipe(Layer.provide(gates.platform()))),
    );
    const gate = Context.get(direct, HandoffTurnGate.HandoffTurnGate);
    assert.include(JSON.stringify(yield* gate.continuedOn!(ThreadId.make(WORKER))), "beta");

    yield* addWorker(alpha);
    yield* alpha.seed({ threadId: WORKER, check: { command: "true" } });
    yield* alpha.makeDue(DUE);
    yield* settle(alpha);
    yield* settle(beta);
    yield* everyoneLooks;
    assert.equal(fires(), 0);
    assert.equal(alpha.state.checks, 0);
    assert.equal((yield* alpha.row)?.last_run_error, "Its thread was handed off to beta.");
    assert.isUndefined(yield* beta.row);
    assert.deepEqual(network.log, []);
  }).pipe(Effect.scoped),
);

it.effect("a webhook delivery after the handoff runs nothing, not even its check", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse(NOON));
    const gates = serverGates(MOVED);
    const { machines } = yield* fleet(["alpha"], { scheduler: gates.scheduler });
    const [alpha] = machines as [Machine];
    yield* addWorker(alpha);
    const task = yield* alpha.seed({
      threadId: WORKER,
      schedule: { type: "webhook" },
      check: { command: "true" },
    });
    assert.isDefined(task.webhook);
    const refused = yield* deliver(alpha, task);
    assert.equal(alpha.state.checks, 0);
    assert.equal(alpha.fires(), 0);
    assert.equal(refused, threadHandedOffNote("beta"));
  }).pipe(Effect.scoped),
);

it.effect(
  "a handoff file that does not read makes the routine wait, and it runs once it reads",
  () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse(NOON));
      const gates = serverGates("{ not json");
      const { machines } = yield* fleet(["alpha"], { scheduler: gates.scheduler });
      const [alpha] = machines as [Machine];
      yield* addWorker(alpha);
      yield* alpha.seed({ threadId: WORKER, check: { command: "true" } });
      yield* alpha.makeDue(DUE);
      yield* settle(alpha);
      yield* alpha.due;
      assert.equal(alpha.fires(), 0);
      assert.equal(alpha.state.checks, 0);
      // Still due: the next pass looks again.
      assert.equal((yield* alpha.row)?.next_run_at, DUE);
      yield* alpha.due;
      assert.equal(alpha.fires(), 0);

      gates.rewrite(NOT_MOVED);
      yield* alpha.due;
      assert.equal(alpha.state.checks, 1);
      assert.equal(alpha.fires(), 1);
    }).pipe(Effect.scoped),
);

it.effect("a webhook delivery while the takeover's answer is lost runs nothing, then rests", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse(NOON));
    const gates = serverGates(HANDING_OFF);
    const { machines } = yield* fleet(["alpha"], { scheduler: gates.scheduler });
    const [alpha] = machines as [Machine];
    yield* addWorker(alpha);
    const task = yield* alpha.seed({
      threadId: WORKER,
      schedule: { type: "webhook" },
      check: { command: "true" },
    });
    // The other machine may run the worker now: nothing starts here, not even the check.
    const waited = yield* deliver(alpha, task);
    assert.equal(alpha.state.checks, 0);
    assert.equal(alpha.fires(), 0);
    assert.isNotNull(waited);
    assert.include(waited!, "Waiting");
    // The answer arrives: the worker continued on beta, and the routine rests.
    yield* gates.update((record) => ({
      ...record!,
      lease: { ...LEASE, state: "fenced" },
      continuedOn: {
        environmentId: EnvironmentId.make("env-beta"),
        machineLabel: "beta",
        threadId: ThreadId.make("continued-thread"),
        at: "2026-11-03T11:59:30.000Z",
      },
    }));
    assert.equal(yield* deliver(alpha, task), threadHandedOffNote("beta"));
    assert.equal(alpha.state.checks, 0);
    assert.equal(alpha.fires(), 0);
  }).pipe(Effect.scoped),
);

it.effect("a due slot waits while its worker is handed off, and runs once if it was not", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse(NOON));
    const gates = serverGates(HANDING_OFF);
    const { machines } = yield* fleet(["alpha"], { scheduler: gates.scheduler });
    const [alpha] = machines as [Machine];
    yield* addWorker(alpha);
    yield* alpha.seed({ threadId: WORKER, check: { command: "true" } });
    yield* alpha.makeDue(DUE);
    yield* settle(alpha);
    yield* alpha.due;
    assert.equal(alpha.state.checks, 0);
    assert.equal(alpha.fires(), 0);
    assert.equal((yield* alpha.row)?.next_run_at, DUE);
    // The handoff was cancelled: this machine holds the worker again.
    yield* gates.update((record) => ({ ...record!, lease: { ...LEASE, state: "active" } }));
    yield* alpha.due;
    yield* alpha.due;
    assert.equal(alpha.state.checks, 1);
    assert.equal(alpha.fires(), 1);
  }).pipe(Effect.scoped),
);

/**
 * One due run of a worker's routine. With `at`, the takeover is sent while the
 * run waits on its project lookup number `at`: after the run passed its gate.
 */
const dueRun = (at: number | null) =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse(NOON));
    const gates = serverGates(NOT_MOVED);
    const { machines } = yield* fleet(["alpha"], { scheduler: gates.scheduler });
    const [alpha] = machines as [Machine];
    yield* addWorker(alpha);
    yield* alpha.seed({ threadId: WORKER, check: { command: "true" } });
    yield* alpha.makeDue(DUE);
    yield* settle(alpha);
    const before = alpha.state.projectLookups;
    if (at !== null)
      alpha.state.duringProjectLookup = {
        at: before + at,
        run: gates.update((record) => ({
          ...(record ?? emptyThreadRecord(ProjectId.make("project-alpha"))),
          lease: { ...LEASE, state: "handing-off" },
        })),
      };
    yield* alpha.due;
    return { alpha, gates, before };
  });

it.effect("a handoff that starts during a due run's project lookup starts no check", () =>
  Effect.gen(function* () {
    // Without a handoff: the lookups the run makes before its check starts.
    const plain = yield* dueRun(null).pipe(
      Effect.map(({ alpha, before }) => ({
        checks: alpha.state.checks,
        lookups: (alpha.state.lookupsAtCheck ?? 0) - before,
      })),
      Effect.scoped,
    );
    assert.equal(plain.checks, 1);
    assert.isAtLeast(plain.lookups, 1);
    for (let at = 1; at <= plain.lookups; at++) {
      yield* Effect.gen(function* () {
        const { alpha, gates } = yield* dueRun(at);
        assert.isNull(alpha.state.duringProjectLookup, `lookup ${at} ran`);
        assert.equal(alpha.state.checks, 0, `fence during lookup ${at}`);
        assert.equal(alpha.fires(), 0);
        // Still due: the next pass looks again, and waits while the handoff has no answer.
        const row = yield* alpha.row;
        assert.isAtMost(Date.parse(row!.next_run_at!), Date.parse(NOON));
        assert.equal(row?.run_count, 0);
        yield* alpha.due;
        assert.equal(alpha.state.checks, 0);
        // The handoff was cancelled: the slot runs once.
        yield* gates.update((record) => ({ ...record!, lease: { ...LEASE, state: "active" } }));
        yield* alpha.due;
        yield* alpha.due;
        assert.equal(alpha.state.checks, 1);
        assert.equal(alpha.fires(), 1);
      }).pipe(Effect.scoped);
    }
  }),
);
