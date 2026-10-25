// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - A one-shot CLI that seeds files.
// Seeds a fresh SpecWithCode state directory for the load benchmark, through the
// real event sink and projections, before the server under test starts on it.
// Usage: node apps/server/integration/loadBenchSeed.ts <base-dir> [default|small]
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  DEFAULT_PROJECT_WORKSPACE_SETTINGS,
  EventId,
} from "@specweave-studio/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlitePersistence from "../src/persistence/Sqlite.ts";
import * as OrchestrationEventStore from "../src/persistence/OrchestrationEventStore.ts";
import * as EventStore from "../src/orchestration-v2/EventStore.ts";
import * as EventSink from "../src/orchestration-v2/EventSink.ts";
import * as ProjectionStore from "../src/orchestration-v2/ProjectionStore.ts";
import {
  LOAD_BENCH_BIG_THREAD_ID,
  LOAD_BENCH_BIG_THREAD_TITLE,
  LOAD_BENCH_SCALES,
  loadBenchProjectId,
  loadBenchProjectTitle,
  loadBenchThreads,
} from "./fixtures/loadBenchFixture.ts";

const [baseDir, scaleName = "default"] = process.argv.slice(2);
const scale = LOAD_BENCH_SCALES[scaleName];
if (!baseDir || !scale) {
  console.error("Usage: loadBenchSeed.ts <base-dir> [default|small]");
  process.exit(2);
}
const dbPath = NodePath.join(NodePath.resolve(baseDir), "userdata", "statev2.sqlite");
if (NodeFS.existsSync(dbPath)) {
  console.error(`Refusing to seed an existing database: ${dbPath}`);
  process.exit(2);
}
const workspaces = NodePath.join(NodePath.resolve(baseDir), "workspaces");
// No provider runs during the benchmark: their probes and update checks would add noise.
const drivers = ["codex", "claudeAgent", "cursor", "grok", "pi", "opencode", "antigravity"];
NodeFS.mkdirSync(NodePath.dirname(dbPath), { recursive: true });
NodeFS.writeFileSync(
  NodePath.join(NodePath.dirname(dbPath), "settings.json"),
  JSON.stringify({
    providers: Object.fromEntries(drivers.map((driver) => [driver, { enabled: false }])),
    providerInstances: Object.fromEntries(
      drivers.map((driver) => [driver, { driver, enabled: false, config: {} }]),
    ),
  }),
);

const program = Effect.gen(function* () {
  const sink = yield* EventSink.EventSinkV2;
  const acceptedAt = DateTime.makeUnsafe("2026-06-01T00:00:00Z");
  const createdAt = DateTime.formatIso(acceptedAt);
  for (let index = 0; index < scale.projects; index++) {
    const projectId = loadBenchProjectId(index);
    const workspaceRoot = NodePath.join(workspaces, loadBenchProjectTitle(index));
    NodeFS.mkdirSync(workspaceRoot, { recursive: true });
    NodeFS.writeFileSync(NodePath.join(workspaceRoot, "README.md"), "Load bench workspace.\n");
    // Its own repository, so git discovery never climbs into the checkout running the bench.
    NodeChildProcess.execFileSync("git", ["init", "-q"], { cwd: workspaceRoot, stdio: "ignore" });
    const commandId = CommandId.make(`load-bench-create-${index}`);
    yield* sink.commitProjectCommand({
      commandId,
      projectId,
      commandType: "project.create",
      acceptedAt,
      event: {
        eventId: EventId.make(`load-bench-project-${index}`),
        aggregateKind: "project",
        aggregateId: projectId,
        occurredAt: createdAt,
        commandId,
        causationEventId: null,
        correlationId: commandId,
        metadata: {},
        type: "project.created",
        payload: {
          projectId,
          title: loadBenchProjectTitle(index),
          workspaceRoot,
          defaultModelSelection: null,
          faviconPath: null,
          projectIcon: null,
          scripts: [],
          workspaceSettings: { ...DEFAULT_PROJECT_WORKSPACE_SETTINGS, kind: "code" },
          createdAt,
          updatedAt: createdAt,
        },
      },
    });
  }
  let threads = 0;
  let events = 0;
  for (const plan of loadBenchThreads(scale)) {
    yield* sink.write({ events: [plan.created] });
    for (const turn of plan.turns) yield* sink.write({ events: turn });
    threads += 1;
    events += 1 + plan.turns.reduce((sum, turn) => sum + turn.length, 0);
  }
  return { threads, events };
});

const layer = EventSink.layer.pipe(
  Layer.provideMerge(EventStore.layerFromOrchestrationEventStore),
  Layer.provideMerge(ProjectionStore.layer),
  Layer.provideMerge(OrchestrationEventStore.layer),
  Layer.provideMerge(SqlitePersistence.layerFromPath(dbPath)),
  Layer.provideMerge(NodeServices.layer),
);

const started = performance.now();
const result = await Effect.runPromise(program.pipe(Effect.provide(layer), Effect.scoped));
console.log(
  JSON.stringify({
    scale: scale.name,
    dbPath,
    projects: scale.projects,
    ...result,
    bigThreadId: LOAD_BENCH_BIG_THREAD_ID,
    bigThreadTitle: LOAD_BENCH_BIG_THREAD_TITLE,
    bigThreadTurns: scale.bigThreadTurns,
    bigThreadItems: scale.bigThreadTurns * (scale.itemsPerTurn + 2),
    // The last answer in the big thread; the harness waits for it to render.
    lastAnswerMarker: `Finished load bench turn ${scale.bigThreadTurns}.`,
    seedMs: Math.round(performance.now() - started),
  }),
);
