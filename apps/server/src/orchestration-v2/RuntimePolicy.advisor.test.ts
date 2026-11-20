import { assert, it } from "@effect/vitest";
import {
  type ModelSelection,
  type OrchestrationV2AppThread,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  ThreadId,
} from "@specweave-studio/contracts";
import { ADVISOR_GUIDANCE } from "@specweave-studio/shared/advisor";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import type { ProviderInstance } from "../provider/ProviderDriver.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as RuntimePolicy from "./RuntimePolicy.ts";
import * as ServerSettings from "../serverSettings.ts";

const projectId = ProjectId.make("project:advisor-policy");
const claudeId = ProviderInstanceId.make("claudeAgent");
const codexId = ProviderInstanceId.make("codex");
const opus = { instanceId: claudeId, model: "claude-opus-5-5" } satisfies ModelSelection;
const fable = { instanceId: claudeId, model: "claude-fable-5-2" } satisfies ModelSelection;
const sol = { instanceId: codexId, model: "gpt-6.1-sol" } satisfies ModelSelection;

function provider(id: ProviderInstanceId, slugs: ReadonlyArray<string>): ServerProvider {
  return {
    instanceId: id,
    driver: ProviderDriverKind.make(id),
    enabled: true,
    installed: true,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-11-16T08:00:00.000Z",
    version: null,
    models: slugs.map((slug) => ({ slug, name: slug, isCustom: false, capabilities: null })),
    slashCommands: [],
    skills: [],
  };
}

function makeThread(input: {
  readonly now: DateTime.Utc;
  readonly modelSelection: ModelSelection;
  readonly advisorMode?: "on" | "off" | null;
  readonly purpose?: "advisor";
}): OrchestrationV2AppThread {
  const threadId = ThreadId.make("thread:advisor-policy");
  return {
    createdBy: "user",
    creationSource: "web",
    id: threadId,
    projectId,
    title: "Advisor policy",
    providerInstanceId: input.modelSelection.instanceId,
    modelSelection: input.modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: "/worktree",
    activeProviderThreadId: null,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
    forkedFrom: null,
    createdAt: input.now,
    updatedAt: input.now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
    ...(input.advisorMode === undefined ? {} : { advisorMode: input.advisorMode }),
    ...(input.purpose === undefined ? {} : { purpose: input.purpose }),
  };
}

const readOnly = { type: "readOnly", access: { type: "fullAccess" }, networkAccess: false };

const layerTest = RuntimePolicy.layerFromProjectStore.pipe(
  Layer.provideMerge(ServerSettings.layerTest({})),
  Layer.provide(
    Layer.succeed(ProviderInstanceRegistry.ProviderInstanceRegistry, {
      getInstance: (instanceId) =>
        Effect.succeed({
          driverKind: ProviderDriverKind.make(instanceId),
          snapshot: { getSnapshot: Effect.succeed({} as ServerProvider) },
        } as ProviderInstance),
      listInstances: Effect.succeed([]),
      listUnavailable: Effect.succeed([]),
      streamChanges: Stream.empty,
      subscribeChanges: Effect.never,
    }),
  ),
  Layer.provide(
    Layer.mock(ProviderRegistry.ProviderRegistry)({
      getProviders: Effect.succeed([
        provider(claudeId, ["claude-fable-5-2", "claude-opus-5-5"]),
        provider(codexId, ["gpt-6.1-sol"]),
      ]),
    }),
  ),
  Layer.provide(
    Layer.mock(ProjectStore.ProjectStoreV2)({ get: () => Effect.succeed(Option.none()) }),
  ),
);

it.layer(layerTest)("RuntimePolicyV2 advisor", (it) => {
  const setAdvisor = (advisor: Record<string, unknown>, project?: Record<string, unknown>) =>
    Effect.gen(function* () {
      const settings = yield* ServerSettings.ServerSettingsService;
      yield* settings.updateSettings({
        advisor,
        projectSettingsOverrides:
          project === undefined ? {} : { [projectId]: { advisor: project } },
      });
    });

  it.effect("passes nothing while the advisor is off and the thread made no choice", () =>
    Effect.gen(function* () {
      const policy = yield* RuntimePolicy.RuntimePolicyV2;
      const now = yield* DateTime.now;
      yield* setAdvisor({ enabled: false });
      const resolved = yield* policy.resolve({
        thread: makeThread({ now, modelSelection: opus }),
        modelSelection: opus,
      });
      assert.isUndefined(resolved.claudeAdvisor);
      assert.isUndefined(resolved.advisorGuidance);
      assert.isUndefined(resolved.sandboxPolicy);
    }),
  );

  it.effect("names Claude's own advisor for a Claude thread advised by Fable 5.2", () =>
    Effect.gen(function* () {
      const policy = yield* RuntimePolicy.RuntimePolicyV2;
      const now = yield* DateTime.now;
      yield* setAdvisor({ enabled: true, builtInContextLimit: 150_000 });
      const resolved = yield* policy.resolve({
        thread: makeThread({ now, modelSelection: opus }),
        modelSelection: opus,
      });
      assert.deepEqual(resolved.claudeAdvisor, {
        kind: "model",
        model: "claude-fable-5-2",
        contextLimit: 150_000,
      });
      assert.equal(resolved.advisorGuidance, ADVISOR_GUIDANCE);
      // Adapters place it, and only for a thread with the studio-code tools.
      assert.notInclude(resolved.agentInstructions ?? "", ADVISOR_GUIDANCE);
    }),
  );

  it.effect("a project override turns it on for that project only", () =>
    Effect.gen(function* () {
      const policy = yield* RuntimePolicy.RuntimePolicyV2;
      const now = yield* DateTime.now;
      yield* setAdvisor({ enabled: false }, { enabled: true });
      const resolved = yield* policy.resolve({
        thread: makeThread({ now, modelSelection: opus }),
        modelSelection: opus,
      });
      assert.equal(resolved.claudeAdvisor?.kind, "model");
      assert.equal(resolved.advisorGuidance, ADVISOR_GUIDANCE);
    }),
  );

  it.effect("a Fable thread is advised by Fable through Claude's own advisor", () =>
    Effect.gen(function* () {
      const policy = yield* RuntimePolicy.RuntimePolicyV2;
      const now = yield* DateTime.now;
      yield* setAdvisor({ enabled: true, builtInContextLimit: 150_000 });
      const onFable = yield* policy.resolve({
        thread: makeThread({ now, modelSelection: fable }),
        modelSelection: fable,
      });
      assert.deepEqual(onFable.claudeAdvisor, {
        kind: "model",
        model: "claude-fable-5-2",
        contextLimit: 150_000,
      });
      assert.equal(onFable.advisorGuidance, ADVISOR_GUIDANCE);
    }),
  );

  it.effect("switches Claude's advisor off when the thread uses the studio-code tool", () =>
    Effect.gen(function* () {
      const policy = yield* RuntimePolicy.RuntimePolicyV2;
      const now = yield* DateTime.now;
      yield* setAdvisor({ enabled: true, claudeBuiltIn: false });
      const builtInOff = yield* policy.resolve({
        thread: makeThread({ now, modelSelection: opus }),
        modelSelection: opus,
      });
      assert.deepEqual(builtInOff.claudeAdvisor, { kind: "disable" });
    }),
  );

  it.effect("switches it off for a thread that chose off, and gives no guidance", () =>
    Effect.gen(function* () {
      const policy = yield* RuntimePolicy.RuntimePolicyV2;
      const now = yield* DateTime.now;
      yield* setAdvisor({ enabled: true });
      const resolved = yield* policy.resolve({
        thread: makeThread({ now, modelSelection: opus, advisorMode: "off" }),
        modelSelection: opus,
      });
      assert.deepEqual(resolved.claudeAdvisor, { kind: "disable" });
      assert.isUndefined(resolved.advisorGuidance);
    }),
  );

  it.effect("a thread that chose on consults though the setting is off", () =>
    Effect.gen(function* () {
      const policy = yield* RuntimePolicy.RuntimePolicyV2;
      const now = yield* DateTime.now;
      yield* setAdvisor({ enabled: false });
      const resolved = yield* policy.resolve({
        thread: makeThread({ now, modelSelection: sol, advisorMode: "on" }),
        modelSelection: sol,
      });
      // Not a Claude session: nothing about Claude's advisor, only the guidance.
      assert.isUndefined(resolved.claudeAdvisor);
      assert.equal(resolved.advisorGuidance, ADVISOR_GUIDANCE);
    }),
  );

  it.effect("runs an advisor child read-only, with no advisor of its own", () =>
    Effect.gen(function* () {
      const policy = yield* RuntimePolicy.RuntimePolicyV2;
      const now = yield* DateTime.now;
      yield* setAdvisor({ enabled: true });
      const claudeChild = yield* policy.resolve({
        thread: makeThread({ now, modelSelection: fable, purpose: "advisor" }),
        modelSelection: fable,
      });
      assert.deepEqual(claudeChild.sandboxPolicy, readOnly);
      assert.equal(claudeChild.approvalPolicy, "never");
      assert.deepEqual(claudeChild.claudeAdvisor, { kind: "disable" });
      assert.isUndefined(claudeChild.advisorGuidance);
      const codexChild = yield* policy.resolve({
        thread: makeThread({ now, modelSelection: sol, purpose: "advisor" }),
        modelSelection: sol,
      });
      assert.deepEqual(codexChild.sandboxPolicy, readOnly);
      assert.isUndefined(codexChild.advisorGuidance);
      // Off in settings changes nothing for a child: Claude's own setting must not reach it.
      yield* setAdvisor({ enabled: false });
      const offChild = yield* policy.resolve({
        thread: makeThread({ now, modelSelection: fable, purpose: "advisor" }),
        modelSelection: fable,
      });
      assert.deepEqual(offChild.claudeAdvisor, { kind: "disable" });
    }),
  );
});
