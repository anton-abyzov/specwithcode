/**
 * The limit handoff's note on the source thread (0968 T-05, AC-06): 0967 links
 * the source to its continuation, then the adapter adds why it moved. Runs on
 * the real orchestrator so the link, the archive rule and the projection are
 * the ones the web reads.
 */
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

import { fixtureProjectDatabase } from "../project/ProjectWorkspace.testkit.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import { recordMoveNote } from "./LimitHandoffAdapter.ts";
import * as Orchestrator from "./Orchestrator.ts";
import type { ProviderAdapterV2Shape } from "./ProviderAdapter.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

const projectId = ProjectId.make("project:limit-handoff-note");
const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.1-codex" };
const minis = EnvironmentId.make("env-minis");
const onMinis = ThreadId.make("thread:on-minis");
const note = "Hit 95% of Claude on M4 · continued on Minis with Claude Opus 5.5";

const adapter = {
  instanceId: modelSelection.instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("Runs here never reach a provider"),
} as ProviderAdapterV2Shape;

const layerTest = ProviderReplayHarness.layerWithRegistry(
  { name: "limit-handoff-note" },
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

/** What 0967's `fenceSource` records on the source. */
const handoffLink = {
  threadId: onMinis,
  projectId,
  title: "Ship the release",
  movedAt: "2026-10-20T14:00:00.000Z",
  kind: "handoff" as const,
  environmentId: minis,
  machineLabel: "Minis",
};

let fences = 0;
const fence = (threadId: ThreadId, link: typeof handoffLink | Record<string, unknown>) =>
  Effect.gen(function* () {
    fences += 1;
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "thread.project-move.record",
      commandId: CommandId.make(`handoff-source:${threadId}:${fences}`),
      threadId,
      side: "source",
      link: link as typeof handoffLink,
    });
  });

it.effect("adds the note to a handed-off source, which stays readable and unarchived", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const threadId = ThreadId.make("thread:limit-note");
    yield* createThread(threadId);
    yield* fence(threadId, handoffLink);
    yield* recordMoveNote({ threadId, continuation: onMinis, note });
    const projection = yield* orchestrator.getThreadProjection(threadId);
    assert.deepStrictEqual(projection.thread.movedTo, { ...handoffLink, note });
    assert.equal(projection.thread.archivedAt, null);

    // Asking again, or 0967 repeating its link without a note, changes nothing.
    yield* recordMoveNote({ threadId, continuation: onMinis, note });
    yield* fence(threadId, handoffLink);
    const again = yield* orchestrator.getThreadProjection(threadId);
    assert.deepStrictEqual(again.thread.movedTo, { ...handoffLink, note });
  }).pipe(Effect.provide(layerTest)),
);

it.effect("a note never re-links a source: another continuation is still refused", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const threadId = ThreadId.make("thread:limit-note-other");
    yield* createThread(threadId);
    yield* fence(threadId, handoffLink);
    const other = yield* Effect.exit(
      fence(threadId, { ...handoffLink, threadId: ThreadId.make("thread:on-m3"), note }),
    );
    assert.isTrue(Exit.isFailure(other));
    // The note is only for the continuation the source links to.
    yield* recordMoveNote({ threadId, continuation: ThreadId.make("thread:on-m3"), note });
    const projection = yield* orchestrator.getThreadProjection(threadId);
    assert.deepStrictEqual(projection.thread.movedTo, handoffLink);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("leaves a thread that never moved, or moved to a project, without a note", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const idle = ThreadId.make("thread:limit-note-idle");
    yield* createThread(idle);
    yield* recordMoveNote({ threadId: idle, continuation: onMinis, note });
    assert.isUndefined((yield* orchestrator.getThreadProjection(idle)).thread.movedTo ?? undefined);

    const moved = ThreadId.make("thread:limit-note-project");
    yield* createThread(moved);
    const projectLink = { ...handoffLink, kind: "project" as const };
    yield* fence(moved, projectLink);
    yield* recordMoveNote({ threadId: moved, continuation: onMinis, note });
    const projection = yield* orchestrator.getThreadProjection(moved);
    assert.deepStrictEqual(projection.thread.movedTo, projectLink);
    assert.notEqual(projection.thread.archivedAt, null);
  }).pipe(Effect.provide(layerTest)),
);
