import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  threadExecutionSummary,
} from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

import { fixtureProjectDatabase } from "../project/ProjectWorkspace.testkit.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import type { ProviderAdapterV2Shape } from "../orchestration-v2/ProviderAdapter.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";

const projectId = ProjectId.make("project:handoff-orchestrator");
const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.1-codex" };
const here = EnvironmentId.make("env-m4");
const minis = EnvironmentId.make("env-minis");

const adapter = {
  instanceId: modelSelection.instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("Runs here never reach a provider"),
} as ProviderAdapterV2Shape;

const layerTest = ProviderReplayHarness.layerWithRegistry(
  { name: "handoff-orchestrator" },
  ProviderAdapterRegistry.layerFromAdapters([adapter]),
  { databaseLayer: fixtureProjectDatabase([projectId]), runEffectWorker: false },
);

const createThread = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`create:${threadId}`),
      threadId,
      projectId,
      title: "Ship the release",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
  });

const record = (threadId: ThreadId, epoch: number) => ({
  type: "thread.execution.record" as const,
  commandId: CommandId.make(`execution:${threadId}:${epoch}`),
  threadId,
  execution: {
    ownerMachineId: here,
    ownerMachineLabel: "M4",
    executionMachineId: minis,
    executionMachineLabel: "Minis",
    epoch,
    history: [
      {
        machine: minis,
        machineLabel: "Minis",
        from: "2026-10-20T14:00:00.000Z",
        to: null,
        reason: "machine-handoff" as const,
        epoch,
      },
    ],
  },
});

it.effect("records where a thread runs and refuses a stale epoch", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const threadId = ThreadId.make("thread:execution-record");
    yield* createThread(threadId);
    yield* orchestrator.dispatch(record(threadId, 3));
    const shell = yield* orchestrator.getThreadShell(threadId);
    assert.equal(shell?.ownerMachineId, here);
    assert.equal(shell?.executionMachineId, minis);
    assert.equal(shell?.executionState, "running");
    // The same record again is a no-op, not an error.
    yield* orchestrator.dispatch({ ...record(threadId, 3), commandId: CommandId.make("again") });
    const stale = yield* Effect.exit(
      orchestrator.dispatch({ ...record(threadId, 2), commandId: CommandId.make("stale") }),
    );
    assert.isTrue(Exit.isFailure(stale));
    const projection = yield* orchestrator.getThreadProjection(threadId);
    assert.equal(projection.thread.execution?.epoch, 3);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("a handoff fences the source without archiving it and refuses new turns", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const threadId = ThreadId.make("thread:handoff-source");
    yield* createThread(threadId);
    yield* orchestrator.dispatch({
      type: "thread.project-move.record",
      commandId: CommandId.make("handoff-source"),
      threadId,
      side: "source",
      link: {
        threadId: ThreadId.make("thread:on-minis"),
        projectId,
        title: "Ship the release",
        movedAt: "2026-10-20T14:00:00.000Z",
        kind: "handoff",
        environmentId: minis,
        machineLabel: "Minis",
      },
    });
    const projection = yield* orchestrator.getThreadProjection(threadId);
    assert.equal(projection.thread.archivedAt, null);
    assert.equal(projection.thread.movedTo?.kind, "handoff");
    assert.equal(threadExecutionSummary(projection.thread).executionState, "fenced");

    const refused = yield* Effect.exit(
      orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("after-fence"),
        threadId,
        messageId: MessageId.make("message:after-fence"),
        text: "keep going",
        attachments: [],
        dispatchMode: { type: "start_immediately" },
        createdBy: "user",
        creationSource: "web",
      }),
    );
    assert.isTrue(Exit.isFailure(refused));
    assert.include(String(refused), "continues on Minis");
  }).pipe(Effect.provide(layerTest)),
);
