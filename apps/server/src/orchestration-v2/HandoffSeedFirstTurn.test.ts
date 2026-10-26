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

import { HandoffTurnGate } from "../handoff/HandoffTurnGate.ts";
import { fixtureProjectDatabase } from "../project/ProjectWorkspace.testkit.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as Orchestrator from "./Orchestrator.ts";
import type { ProviderAdapterV2Shape } from "./ProviderAdapter.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

const instanceId = ProviderInstanceId.make("codex");
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("No provider process needed to record the turn"),
} as ProviderAdapterV2Shape;
const projectId = ProjectId.make("project:handoff-seed");
const threadId = ThreadId.make("thread:handoff-seed");
const layerDatabase = fixtureProjectDatabase([projectId]);
const SEED = "Context from the handoff (the user's message follows):\n\nNext: Run the build";

// An idle continuation (0967 AC-07): the receiver kept the note and transcript
// for the thread's first turn.
const layerGate = Layer.succeed(HandoffTurnGate, {
  check: () => Effect.succeed(null),
  pendingSeed: (id) => Effect.succeed(id === threadId ? SEED : null),
});

const layerTest = Layer.mergeAll(
  layerDatabase,
  ProviderReplayHarness.layerWithRegistry(
    { name: "handoff-seed" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: layerDatabase, runEffectWorker: false },
  ),
).pipe(Layer.provideMerge(layerGate));

const send = (ordinal: number, dispatchMode: "start_immediately" | "queue_after_active") =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(`message:handoff-seed:${ordinal}`),
      threadId,
      messageId: MessageId.make(`message:handoff-seed:${ordinal}`),
      createdBy: "user",
      creationSource: "web",
      text: `Task ${ordinal}`,
      attachments: [],
      dispatchMode: { type: dispatchMode },
    });
  });

it.effect(
  "carries an idle continuation's handoff seed into its first turn only",
  () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("create-handoff-seed"),
        threadId,
        projectId,
        title: "Continued here",
        modelSelection: { instanceId, model: "gpt-5.1-codex" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "system",
        creationSource: "server",
      });
      yield* send(0, "start_immediately");
      yield* send(1, "queue_after_active");
      const projection = yield* orchestrator.getThreadProjection(threadId);
      const texts = projection.messages
        .filter((message) => message.role === "user")
        .map((message) => message.text);
      assert.deepEqual(texts, [`${SEED}\n\n---\n\nTask 0`, "Task 1"]);
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  30_000,
);
