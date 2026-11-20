// @effect-diagnostics nodeBuiltinImport:off - a real state folder per machine.
/**
 * A routine bound to a worker that was handed off rests on the machine it left
 * (1390 AC-45), with the scheduler built over the handoff gate the server gives
 * it, not a test stub: the handoff file says the thread continued on another
 * machine, and nothing fires here.
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
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import {
  EMPTY_HANDOFF_DOCUMENT,
  emptyThreadRecord,
  HandoffDocument,
} from "../handoff/handoffState.ts";
import * as HandoffTurnGate from "../handoff/HandoffTurnGate.ts";
import * as RuntimeLayer from "../orchestration-v2/runtimeLayer.ts";
import { fleet, type Machine } from "./ScheduledTaskRunner.testkit.ts";

const NOON = "2026-11-03T12:00:00.000Z";
const DUE = "2026-11-03T11:59:00.000Z";
const WORKER = "worker-thread";
const encodeDocument = Schema.encodeSync(HandoffDocument);

const temporary: Array<string> = [];
afterEach(() => {
  for (const path of temporary.splice(0)) NodeFS.rmSync(path, { recursive: true, force: true });
});

/** A state folder whose handoff file says `alpha`'s worker continued on `beta`. */
const stateFolder = (environmentId: EnvironmentId) => {
  const stateDir = NodeFS.realpathSync(
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "swc-routine-gate-")),
  );
  temporary.push(stateDir);
  const document =
    environmentId === EnvironmentId.make("env-alpha")
      ? {
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
        }
      : EMPTY_HANDOFF_DOCUMENT;
  NodeFS.writeFileSync(
    NodePath.join(stateDir, "handoff-mode.json"),
    JSON.stringify(encodeDocument(document)),
  );
  return Layer.mergeAll(
    Layer.succeed(ServerConfig.ServerConfig, { stateDir } as never),
    NodeServices.layer,
    NodeCrypto.layer,
  );
};

const platforms = new Map<
  string,
  Layer.Layer<Layer.Success<ReturnType<typeof stateFolder>> | ServerEnvironment.ServerEnvironment>
>();

/** The scheduler's handoff gate exactly as the server composes it. */
const serverGate = (
  environment: Layer.Layer<ServerEnvironment.ServerEnvironment>,
  environmentId: EnvironmentId,
) => {
  const platform = stateFolder(environmentId);
  const provided = Layer.merge(platform, environment);
  platforms.set(environmentId, provided);
  return RuntimeLayer.layerScheduledTaskHandoffGate.pipe(Layer.provide(provided));
};

it.effect("a worker's routine rests after the worker is handed off, with the server's gate", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse(NOON));
    const { machines, everyoneLooks, fires, network } = yield* fleet(["alpha", "beta"], {
      handoffGate: serverGate,
    });
    const [alpha, beta] = machines as [Machine, Machine];

    // Control: the gate itself reads the handoff file and names the machine.
    const direct = yield* Layer.build(
      Layer.fresh(HandoffTurnGate.layer.pipe(Layer.provide(platforms.get(alpha.environmentId)!))),
    );
    const gate = Context.get(direct, HandoffTurnGate.HandoffTurnGate);
    assert.equal(yield* gate.continuedOn!(ThreadId.make(WORKER)), "beta");

    yield* alpha.sql`INSERT INTO orchestration_v2_projection_threads ${alpha.sql.insert({ thread_id: WORKER, project_id: alpha.projectId, title: "Synthetic", default_provider: "codex", runtime_mode: "full-access", interaction_mode: "default", created_at: "2026-10-09T00:00:00Z", updated_at: "2026-10-09T00:00:00Z", deleted_at: null, payload_json: "{}" })}`;
    yield* alpha.seed({ threadId: WORKER });
    yield* alpha.makeDue(DUE);
    yield* alpha.runner.reconcile({ force: true });
    yield* beta.runner.reconcile({ force: true });
    yield* everyoneLooks;
    assert.equal(fires(), 0);
    assert.equal(alpha.state.sends, 0);
    assert.equal((yield* alpha.row)?.last_run_error, "Its thread was handed off to beta.");
    assert.isUndefined(yield* beta.row);
    assert.deepEqual(network.log, []);
  }).pipe(Effect.scoped),
);
