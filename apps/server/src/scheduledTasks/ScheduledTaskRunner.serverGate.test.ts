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
import { EnvironmentId, ProjectId, ThreadId } from "@specweave-studio/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../config.ts";
import type * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import {
  EMPTY_HANDOFF_DOCUMENT,
  emptyThreadRecord,
  HandoffDocument,
} from "../handoff/handoffState.ts";
import * as HandoffTurnGate from "../handoff/HandoffTurnGate.ts";
import * as RuntimeLayer from "../orchestration-v2/runtimeLayer.ts";
import { fleet, type Machine } from "./ScheduledTaskRunner.testkit.ts";
import type { ScheduledTaskService } from "./ScheduledTaskService.ts";
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
 * Each machine's scheduler composed exactly as the server composes it, on a state folder of its own; `alpha`'s handoff file holds
 * `alphaFile`. `rewrite` changes that file, and `platform` builds alpha's gate
 * by hand.
 */
const serverGates = (alphaFile: string) => {
  const folders = new Map<
    string,
    { readonly file: string; readonly platform: ReturnType<typeof platformOf> }
  >();
  const scheduler = (
    services: Layer.Layer<unknown>,
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
    return RuntimeLayer.scheduledTaskLayerOver(services).pipe(
      Layer.provide(platform),
    ) as unknown as Layer.Layer<ScheduledTaskService, unknown, SqlClient.SqlClient>;
  };
  return {
    scheduler,
    rewrite: (text: string) => NodeFS.writeFileSync(folders.get(ALPHA)!.file, text),
    platform: () => folders.get(ALPHA)!.platform,
  };
};

const addWorker = (machine: Machine) =>
  machine.sql`INSERT INTO orchestration_v2_projection_threads ${machine.sql.insert({ thread_id: WORKER, project_id: machine.projectId, title: "Synthetic", default_provider: "codex", runtime_mode: "full-access", interaction_mode: "default", created_at: "2026-10-09T00:00:00Z", updated_at: "2026-10-09T00:00:00Z", deleted_at: null, payload_json: "{}" })}`;

const settle = (machine: Machine) => machine.runner.reconcile({ force: true });

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
    const body = new TextEncoder().encode("{}");
    const answer = yield* alpha.service.triggerWebhook({
      hookId: task.id,
      token: task.webhook!.path.split("/").at(-1) ?? "",
      method: "POST",
      path: `/api/hooks/${task.id}`,
      query: "",
      headers: { "content-type": "application/json" },
      body,
      bodyText: "{}",
    });
    // The URL stays local and answers; the delivery is logged and then refused.
    assert.equal(answer._tag, "accepted");
    let delivery = (yield* alpha.service.listWebhookDeliveries({ id: task.id })).deliveries[0];
    for (let turn = 0; turn < 1000 && delivery?.outcome === "accepted"; turn++) {
      yield* Effect.yieldNow;
      delivery = (yield* alpha.service.listWebhookDeliveries({ id: task.id })).deliveries[0];
    }
    assert.equal(alpha.state.checks, 0);
    assert.equal(alpha.fires(), 0);
    assert.equal(delivery?.error, threadHandedOffNote("beta"));
  }).pipe(Effect.scoped),
);

it.effect("a handoff file that does not read makes the routine wait, and it runs once it reads", () =>
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
