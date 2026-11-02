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
import { parseTeamRulesText, type TeamRulesState } from "@specweave-studio/shared/teamRules";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { TeamRules, teamRulesOf } from "../teamRules/TeamRules.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import type { ProviderAdapterV2Shape } from "./ProviderAdapter.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

const projectId = ProjectId.make("project:team-rules");
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
    { name: "team-rules" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: layerDatabase, runEffectWorker: false },
  ),
);

const active = (body: Record<string, unknown>): TeamRulesState => {
  const parsed = parseTeamRulesText(JSON.stringify({ version: 1, owner: "Acme", ...body }));
  if (!parsed.ok) throw new Error(parsed.issues.join("\n"));
  return { status: "active", rules: parsed.rules, fingerprint: "3a9f", warnings: [] };
};
const under = (state: TeamRulesState) => Effect.provideService(TeamRules, teamRulesOf(state));

const ceiling = active({ agents: { ceiling: "auto-accept-edits" } });
const allowlist = active({ ai: { providers: ["codex"], models: ["gpt-5*"] } });
const hold: TeamRulesState = { status: "hold", issues: ["broken"], owner: "Acme" };

const create = (
  threadId: ThreadId,
  runtimeMode: "full-access" | "approval-required",
  model = "gpt-5",
) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    return yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`create:${threadId}`),
      threadId,
      projectId,
      title: "Thread",
      modelSelection: { instanceId, model },
      runtimeMode,
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
  });

const message = (threadId: ThreadId, id: string, model?: string) =>
  ({
    type: "message.dispatch",
    commandId: CommandId.make(`message:${id}`),
    messageId: MessageId.make(`message:${id}`),
    threadId,
    text: "Do the work",
    attachments: [],
    ...(model === undefined ? {} : { modelSelection: { instanceId, model } }),
    dispatchMode: { type: "start_immediately" },
    createdBy: "user",
    creationSource: "web",
  }) as const;

it.layer(layerTest)("Team rules at the orchestrator", (it) => {
  it.effect("refuses a person's new thread above the ceiling, then allows it without rules", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread:rules-create");
      const refused = yield* create(threadId, "full-access").pipe(under(ceiling), Effect.flip);
      assert.equal(refused._tag, "OrchestratorTeamRulesRefusedError");
      assert.include(refused.message, "Acme");
      assert.include(refused.message, "Auto-accept edits");
      // Nothing recorded: the same command goes through once the rules allow it.
      yield* create(threadId, "full-access");
    }),
  );

  it.effect("binds a person's mode change, and still lets the thread be lowered", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const threadId = ThreadId.make("thread:rules-mode");
      yield* create(threadId, "approval-required");
      const raise = {
        type: "thread.runtime-mode.set",
        commandId: CommandId.make("rules-raise"),
        threadId,
        runtimeMode: "full-access",
      } as const;
      const refused = yield* orchestrator.dispatch(raise).pipe(under(ceiling), Effect.flip);
      assert.equal(refused._tag, "OrchestratorTeamRulesRefusedError");
      yield* orchestrator
        .dispatch({
          ...raise,
          commandId: CommandId.make("rules-within"),
          runtimeMode: "auto-accept-edits",
        })
        .pipe(under(ceiling));
    }),
  );

  it.effect("refuses a message on a thread saved above a new ceiling, but not a rename", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const threadId = ThreadId.make("thread:rules-stale");
      yield* create(threadId, "full-access");
      const refused = yield* orchestrator
        .dispatch(message(threadId, "stale"))
        .pipe(under(ceiling), Effect.flip);
      assert.equal(refused._tag, "OrchestratorTeamRulesRefusedError");
      yield* orchestrator
        .dispatch({
          type: "thread.metadata.update",
          commandId: CommandId.make("rules-rename"),
          threadId,
          title: "Renamed",
        })
        .pipe(under(ceiling));
    }),
  );

  it.effect("checks the final model, however it was named", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const refusedCreate = yield* create(
        ThreadId.make("thread:rules-model-new"),
        "approval-required",
        "o3",
      ).pipe(under(allowlist), Effect.flip);
      assert.equal(refusedCreate._tag, "OrchestratorTeamRulesRefusedError");

      const threadId = ThreadId.make("thread:rules-model");
      yield* create(threadId, "approval-required");
      for (const command of [
        message(threadId, "named", "o3"),
        {
          type: "thread.model-selection.set",
          commandId: CommandId.make("rules-model-set"),
          threadId,
          modelSelection: { instanceId, model: "o3" },
        } as const,
      ]) {
        const refused = yield* orchestrator.dispatch(command).pipe(under(allowlist), Effect.flip);
        assert.equal(refused._tag, "OrchestratorTeamRulesRefusedError");
        assert.include(refused.message, "o3");
      }
    }),
  );

  it.effect("safe hold refuses work but leaves the thread reachable", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const threadId = ThreadId.make("thread:rules-hold");
      yield* create(threadId, "approval-required").pipe(under(hold));
      const refused = yield* orchestrator
        .dispatch(message(threadId, "held"))
        .pipe(under(hold), Effect.flip);
      assert.equal(refused._tag, "OrchestratorTeamRulesRefusedError");
      assert.include(refused.message, "rules check");
      yield* orchestrator
        .dispatch({
          type: "thread.metadata.update",
          commandId: CommandId.make("rules-hold-rename"),
          threadId,
          title: "Still reachable",
        })
        .pipe(under(hold));
      assert.equal((yield* projections.getThreadShell(threadId))?.title, "Still reachable");
    }),
  );
});
