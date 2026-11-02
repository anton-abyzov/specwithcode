import { fixtureProjectDatabase } from "../project/ProjectWorkspace.testkit.ts";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import type { ProviderAdapterV2Shape } from "./ProviderAdapter.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

const projectId = ProjectId.make("project:team-rules-carried");
const instanceId = ProviderInstanceId.make("codex");
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("No provider process needed for refused commands"),
} as ProviderAdapterV2Shape;
const layerDatabase = fixtureProjectDatabase([projectId]);
const layerTest = Layer.mergeAll(
  layerDatabase,
  ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
  ProviderReplayHarness.layerWithRegistry(
    { name: "team-rules-carried" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: layerDatabase, runEffectWorker: false },
  ),
);

const origin = {
  kind: "fleet_machine",
  label: "SpecWithCode",
  carried: {
    ceiling: "auto-accept-edits",
    owner: "Acme",
    from: EnvironmentId.make("env-sender"),
  },
} as const;

const create = (threadId: ThreadId, runtimeMode: "full-access" | "approval-required") =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    return yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`create:${threadId}`),
      threadId,
      projectId,
      title: "Thread",
      modelSelection: { instanceId, model: "gpt-5" },
      runtimeMode,
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "agent",
      creationSource: "mcp",
      origin,
    });
  });

// No rules file in any of these: the ceiling came with the work.
it.layer(layerTest)("A carried ceiling at the orchestrator", (it) => {
  it.effect("refuses a new thread above it", () =>
    Effect.gen(function* () {
      const refused = yield* create(ThreadId.make("thread:carried-new"), "full-access").pipe(
        Effect.flip,
      );
      assert.equal(refused._tag, "OrchestratorTeamRulesRefusedError");
      assert.include(refused.message, "Acme");
    }),
  );

  it.effect("keeps the origin, and refuses raising the thread above it", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread:carried-raise");
      yield* create(threadId, "approval-required");
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const shell = yield* store.getThreadShell(threadId);
      assert.equal(shell?.origin?.carried?.ceiling, "auto-accept-edits");

      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const raise = (runtimeMode: "full-access" | "auto-accept-edits", id: string) => ({
        type: "thread.runtime-mode.set" as const,
        commandId: CommandId.make(`raise:${id}`),
        threadId,
        runtimeMode,
        createdBy: "agent" as const,
        creationSource: "mcp" as const,
      });
      const refused = yield* orchestrator.dispatch(raise("full-access", "1")).pipe(Effect.flip);
      assert.equal(refused._tag, "OrchestratorTeamRulesRefusedError");
      yield* orchestrator.dispatch(raise("auto-accept-edits", "2"));
    }),
  );

  it.effect("takes a message inside it", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread:carried-above");
      yield* create(threadId, "approval-required");
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const accepted = yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("message:carried-ok"),
        messageId: MessageId.make("message:carried-ok"),
        threadId,
        text: "Do the work",
        attachments: [],
        dispatchMode: { type: "start_immediately" },
        createdBy: "agent",
        creationSource: "mcp",
      });
      assert.ok(accepted);
    }),
  );
});
