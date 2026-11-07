// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - A one-shot CLI that seeds files.
// Adds one agent-started worker thread to a state directory the load benchmark seeder
// made, so the project page opens it in its right panel (a person's chat opens full
// page). Used by apps/web/tests/project-settings-shortcut/verify.mjs.
// Usage: node apps/server/integration/projectSettingsShortcutSeed.ts <base-dir>
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ThreadId } from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlitePersistence from "../src/persistence/Sqlite.ts";
import * as OrchestrationEventStore from "../src/persistence/OrchestrationEventStore.ts";
import * as EventStore from "../src/orchestration-v2/EventStore.ts";
import * as EventSink from "../src/orchestration-v2/EventSink.ts";
import * as ProjectionStore from "../src/orchestration-v2/ProjectionStore.ts";
import { loadBenchProjectId, threadCreated, turnEvents } from "./fixtures/loadBenchFixture.ts";

const [baseDir] = process.argv.slice(2);
if (!baseDir) {
  console.error("Usage: projectSettingsShortcutSeed.ts <base-dir>");
  process.exit(2);
}
const dbPath = NodePath.join(NodePath.resolve(baseDir), "userdata", "statev2.sqlite");
const threadId = ThreadId.make("settings-shortcut-worker");
const seconds = 200 * 60;
const created = threadCreated({
  threadId,
  projectId: loadBenchProjectId(1),
  title: "Shortcut worker",
  seconds,
  settled: false,
});
const turns = [0, 1].map((turn) =>
  turnEvents({
    threadId,
    turn,
    seconds: seconds + (turn + 1) * 60,
    items: 6,
    smallOutputBytes: 400,
    largeOutputEvery: 0,
    largeOutputBytes: 0,
  }),
);

const program = Effect.gen(function* () {
  const sink = yield* EventSink.EventSinkV2;
  if (created.type !== "thread.created") throw new Error("threadCreated made another event");
  yield* sink.write({
    events: [{ ...created, payload: { ...created.payload, createdBy: "agent" } }],
  });
  for (const turn of turns) yield* sink.write({ events: turn });
});

const layer = EventSink.layer.pipe(
  Layer.provideMerge(EventStore.layerFromOrchestrationEventStore),
  Layer.provideMerge(ProjectionStore.layer),
  Layer.provideMerge(OrchestrationEventStore.layer),
  Layer.provideMerge(SqlitePersistence.layerFromPath(dbPath)),
  Layer.provideMerge(NodeServices.layer),
);

await Effect.runPromise(program.pipe(Effect.provide(layer), Effect.scoped));
console.log(
  JSON.stringify({ threadId, title: "Shortcut worker", lastAnswer: "Finished load bench turn 2." }),
);
