import { fixtureProjectDatabase } from "../project/ProjectWorkspace.testkit.ts";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import type { ProviderAdapterV2Shape } from "./ProviderAdapter.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

// 1075: the usage pre-switch records the model it moved an idle thread off,
// on the thread itself, so the way back finds it after a restart.
const instanceId = ProviderInstanceId.make("codex");
const home = { instanceId, model: "gpt-6.1-sol" };
const fallback = { instanceId, model: "gpt-6-astra" };
const other = { instanceId, model: "gpt-6" };
const resetAt = "2026-10-26T15:00:00.000Z";
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("No provider process needed for selection moves"),
} as ProviderAdapterV2Shape;
const projectId = ProjectId.make("project:preswitch-origin");
const layerDatabase = fixtureProjectDatabase([projectId]);
const layerTest = Layer.mergeAll(
  layerDatabase,
  ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
  ProviderReplayHarness.layerWithRegistry(
    { name: "preswitch-origin" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: layerDatabase, runEffectWorker: false },
  ),
);

const setup = (name: string) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const threadId = ThreadId.make(`thread:${name}`);
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`create-${name}`),
      threadId,
      projectId,
      title: name,
      modelSelection: home,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    const move = (
      commandId: string,
      modelSelection: typeof home,
      type: "thread.model-selection.set" | "provider.switch" = "thread.model-selection.set",
    ) =>
      orchestrator.dispatch({
        type,
        commandId: CommandId.make(commandId),
        threadId,
        modelSelection,
      });
    const preswitchId = CommandId.make(`limit-preswitch:${threadId}:${instanceId}:${resetAt}`);
    return {
      threadId,
      move,
      preswitchId,
      origin: projections.getThread(threadId).pipe(Effect.map((t) => t.limitPreswitchFrom)),
    };
  });

it.effect("records the pre-switch origin in the thread event, durably", () =>
  Effect.gen(function* () {
    const events = yield* EventSink.EventSinkV2;
    const { move, preswitchId, origin } = yield* setup("records");
    yield* move(preswitchId, fallback);
    const expected = { modelSelection: home, commandId: preswitchId, resetAt };
    assert.deepEqual(yield* origin, expected);
    // The thread event carries it, so a projection rebuilt after a restart keeps it.
    const stored = yield* events
      .readByCommandId({ commandId: CommandId.make(preswitchId) })
      .pipe(Stream.runCollect);
    const payloads = Array.from(stored).flatMap((entry) =>
      entry.event.type === "thread.model-selection-updated" ? [entry.event.payload] : [],
    );
    assert.deepEqual(payloads[0]?.limitPreswitchFrom, expected);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("keeps the first origin through a later pre-switch; the way back ends it", () =>
  Effect.gen(function* () {
    const { threadId, move, preswitchId, origin } = yield* setup("chained");
    yield* move(preswitchId, fallback);
    yield* move(`limit-preswitch:${threadId}:${instanceId}:open`, other);
    assert.deepEqual((yield* origin)?.modelSelection, home);
    assert.equal((yield* origin)?.commandId, preswitchId);
    yield* move(`limit-preswitch-return:${threadId}:${instanceId}:${resetAt}`, home);
    assert.isNull(yield* origin);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("a pick after the pre-switch clears the origin, even a pick of the fallback", () =>
  Effect.gen(function* () {
    const { move, preswitchId, origin } = yield* setup("picked");
    yield* move(preswitchId, fallback);
    yield* move("person-pick", other);
    assert.isNull(yield* origin);
    // Picking the fallback's model again is still the person's pick.
    yield* move("person-pick-back", fallback);
    assert.isNull(yield* origin);
  }).pipe(Effect.provide(layerTest)),
);

it.effect.each(["thread.model-selection.set", "provider.switch"] as const)(
  "%s directly choosing the current fallback cancels its pre-switch return",
  (type) =>
    Effect.gen(function* () {
      const { move, preswitchId, origin } = yield* setup(`reselected-${type}`);
      yield* move(preswitchId, fallback);
      assert.isNotNull(yield* origin);
      yield* move(`explicit-reselection-${type}`, fallback, type);
      assert.isNull(yield* origin);
    }).pipe(Effect.provide(layerTest)),
);

it.effect.each(["defer_start", "start_immediately"] as const)(
  "an ordinary same-model send (%s) keeps its pre-switch origin",
  (type) =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const { threadId, move, preswitchId, origin } = yield* setup(`ordinary-${type}`);
      yield* move(preswitchId, fallback);
      const before = yield* origin;
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make(`ordinary-${type}`),
        threadId,
        messageId: MessageId.make(`ordinary-${type}`),
        text: "Continue the existing task.",
        attachments: [],
        modelSelection: fallback,
        dispatchMode: { type },
        createdBy: "user",
        creationSource: "web",
      });
      assert.deepEqual(yield* origin, before);
    }).pipe(Effect.provide(layerTest)),
);

it.effect("a selection change with no pre-switch writes no origin", () =>
  Effect.gen(function* () {
    const { move, origin } = yield* setup("plain");
    yield* move("plain-pick", fallback);
    assert.isUndefined(yield* origin);
  }).pipe(Effect.provide(layerTest)),
);
