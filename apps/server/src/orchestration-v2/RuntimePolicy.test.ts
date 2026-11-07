import { assert, it } from "@effect/vitest";
import {
  LIVE_DATABASE_INSTRUCTIONS,
  type ModelSelection,
  type OrchestrationV2AppThread,
  ProjectId,
  ProviderInstanceId,
  type RuntimeMode,
  type ServerProvider,
  ThreadId,
} from "@specweave-studio/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import type { ProviderInstance } from "../provider/ProviderDriver.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as RuntimePolicy from "./RuntimePolicy.ts";
import * as ServerSettings from "../serverSettings.ts";
import { TeamRules, teamRulesOf } from "../teamRules/TeamRules.ts";
import {
  parseTeamRulesText,
  TEAM_RULES_NONE,
  type TeamRulesState,
} from "@specweave-studio/shared/teamRules";

const projectId = ProjectId.make("project:runtime-policy");
const providerInstanceId = ProviderInstanceId.make("codex");
const modelSelection = {
  instanceId: providerInstanceId,
  model: "gpt-5.5",
} satisfies ModelSelection;

function makeThread(input: {
  readonly now: DateTime.Utc;
  readonly worktreePath: string | null;
  readonly runtimeMode?: RuntimeMode;
}): OrchestrationV2AppThread {
  const threadId = ThreadId.make("thread:runtime-policy");
  return {
    createdBy: "user",
    creationSource: "web",
    id: threadId,
    projectId,
    title: "Runtime policy",
    providerInstanceId,
    modelSelection,
    runtimeMode: input.runtimeMode ?? "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: input.worktreePath,
    activeProviderThreadId: null,
    lineage: {
      parentThreadId: null,
      relationshipToParent: null,
      rootThreadId: threadId,
    },
    forkedFrom: null,
    createdAt: input.now,
    updatedAt: input.now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  };
}

// Grok's instance offers no Auto-accept edits; the Codex instance advertises no
// restriction.
const grokInstanceId = ProviderInstanceId.make("grok");
const supportedRuntimeModesByInstance = new Map<ProviderInstanceId, ReadonlyArray<RuntimeMode>>([
  [grokInstanceId, ["approval-required", "auto", "full-access"]],
]);
const providerInstanceFor = (instanceId: ProviderInstanceId) =>
  ({
    snapshot: {
      getSnapshot: Effect.succeed({
        supportedRuntimeModes: supportedRuntimeModesByInstance.get(instanceId),
      } as ServerProvider),
    },
  }) as ProviderInstance;

const layerTest = RuntimePolicy.layerFromProjectStore.pipe(
  Layer.provideMerge(
    ServerSettings.layerTest({
      agentInstructions: "Environment rule",
      claudeWorkflowMode: "on-request",
      projectSettingsOverrides: {
        [projectId]: { agentInstructions: "Project rule", claudeWorkflowMode: "disabled" },
      },
    }),
  ),
  Layer.provide(
    Layer.succeed(ProviderInstanceRegistry.ProviderInstanceRegistry, {
      getInstance: (instanceId) => Effect.succeed(providerInstanceFor(instanceId)),
      listInstances: Effect.succeed([]),
      listUnavailable: Effect.succeed([]),
      streamChanges: Stream.empty,
      subscribeChanges: Effect.never,
    }),
  ),
  Layer.provide(
    Layer.mock(ProjectStore.ProjectStoreV2)({
      get: () =>
        Effect.succeed(
          Option.some({
            projectId,
            title: "Project",
            workspaceRoot: "/project-root",
            defaultModelSelection: null,
            defaultThreadEnvMode: null,
            autoPull: false,
            faviconPath: null,
            projectIcon: null,
            scripts: [],
            createdAt: "2026-06-21T00:00:00.000Z",
            updatedAt: "2026-06-21T00:00:00.000Z",
            deletedAt: null,
          }),
        ),
    }),
  ),
);

it.layer(layerTest)("RuntimePolicyV2", (it) => {
  it.effect("refuses a turn outside the Team rules instead of lowering it", () =>
    Effect.gen(function* () {
      const policy = yield* RuntimePolicy.RuntimePolicyV2;
      const now = yield* DateTime.now;
      const rules = (body: Record<string, unknown>) => {
        const parsed = parseTeamRulesText(JSON.stringify({ version: 1, owner: "Acme", ...body }));
        if (!parsed.ok) throw new Error(parsed.issues.join());
        return teamRulesOf({
          status: "active",
          rules: parsed.rules,
          fingerprint: "3a9f",
          warnings: [],
        });
      };
      const thread = makeThread({ now, worktreePath: "/w", runtimeMode: "full-access" });
      const resolve = (state: Parameters<typeof Effect.provideService>[2]) =>
        policy
          .resolve({ thread, modelSelection })
          .pipe(Effect.provideService(TeamRules, state as never));

      const above = yield* resolve(rules({ agents: { ceiling: "auto" } })).pipe(Effect.flip);
      assert.include(String(above.cause), "Acme's rules allow up to Auto");
      const model = yield* resolve(rules({ ai: { models: ["claude-*"] } })).pipe(Effect.flip);
      assert.include(String(model.cause), "gpt-5.5");
      const held = yield* resolve(teamRulesOf({ status: "hold", issues: ["broken"] })).pipe(
        Effect.flip,
      );
      assert.include(String(held.cause), "paused");

      const allowed = yield* resolve(
        rules({ agents: { ceiling: "full-access" }, ai: { models: ["gpt-*"] } }),
      );
      assert.equal(allowed.runtimeMode, "full-access");
    }),
  );

  it.effect("judges a turn by its own folder, so one repository's rules stay there", () =>
    Effect.gen(function* () {
      const policy = yield* RuntimePolicy.RuntimePolicyV2;
      const now = yield* DateTime.now;
      const by = { source: "repository", owner: "Payments" } as const;
      const limited: TeamRulesState = {
        status: "active",
        fingerprint: "machine",
        warnings: [],
        rules: { version: 1, owner: "Payments", agents: { ceiling: "approval-required" } },
        sources: [by],
        setBy: { ceiling: by },
      };
      const rules = teamRulesOf(TEAM_RULES_NONE, {
        "/limited": limited,
        "/paused": {
          status: "hold",
          issues: ["bad"],
          owner: "Payments",
          holdScope: "repository",
        },
      });
      const resolve = (worktreePath: string) =>
        policy
          .resolve({
            thread: makeThread({ now, worktreePath, runtimeMode: "full-access" }),
            modelSelection,
          })
          .pipe(Effect.provideService(TeamRules, rules));

      const refused = yield* resolve("/limited").pipe(Effect.flip);
      assert.include(String(refused.cause), "Payments's repository rules allow up to Supervised");
      const paused = yield* resolve("/paused").pipe(Effect.flip);
      assert.include(String(paused.cause), "paused in this repository");
      assert.equal((yield* resolve("/elsewhere")).runtimeMode, "full-access");
    }),
  );

  it.effect("refreshes shared instructions and policy on each resumed turn", () =>
    Effect.gen(function* () {
      const policy = yield* RuntimePolicy.RuntimePolicyV2;
      const settings = yield* ServerSettings.ServerSettingsService;
      const now = yield* DateTime.now;
      const thread = makeThread({ now, worktreePath: "/resumed-worktree" });
      yield* settings.updateSettings({
        agentInstructions: "Updated environment rule",
        projectSettingsOverrides: {
          [projectId]: {
            agentInstructions: "Updated project rule",
            claudeWorkflowMode: "automatic",
          },
        },
      });
      const resolved = yield* policy.resolve({ thread, modelSelection });
      assert.match(
        resolved.agentInstructions ?? "",
        /Updated environment rule[\s\S]*Updated project rule/,
      );
      assert.equal(resolved.claudeWorkflowMode, "automatic");
      yield* settings.updateSettings({
        agentInstructions: "Environment rule",
        projectSettingsOverrides: {
          [projectId]: { agentInstructions: "Project rule", claudeWorkflowMode: "disabled" },
        },
      });
    }),
  );
  it.effect("uses the project root for local-checkout threads", () =>
    Effect.gen(function* () {
      const policy = yield* RuntimePolicy.RuntimePolicyV2;
      const now = yield* DateTime.now;
      const resolved = yield* policy.resolve({
        thread: makeThread({ now, worktreePath: null }),
        modelSelection,
      });
      assert.equal(resolved.cwd, "/project-root");
      assert.isTrue(resolved.manualWorktreesBlocked);
      assert.equal(
        resolved.agentInstructions,
        `## Environment instructions\nEnvironment rule\n\n## Project instructions\nProject rule\n\n${LIVE_DATABASE_INSTRUCTIONS}`,
      );
      assert.equal(resolved.claudeWorkflowMode, "disabled");
      assert.equal(resolved.responseStyle, "concise");
    }),
  );

  it.effect("lets a local-checkout thread add worktrees while Use worktrees is on", () =>
    Effect.gen(function* () {
      const policy = yield* RuntimePolicy.RuntimePolicyV2;
      const settings = yield* ServerSettings.ServerSettingsService;
      const now = yield* DateTime.now;
      const thread = makeThread({ now, worktreePath: null });
      const projectRule = {
        agentInstructions: "Project rule",
        claudeWorkflowMode: "disabled",
      } as const;
      yield* settings.updateSettings({
        projectSettingsOverrides: {
          [projectId]: { ...projectRule, defaultThreadEnvMode: "worktree" },
        },
      });
      const resolved = yield* policy.resolve({ thread, modelSelection });
      assert.equal(resolved.cwd, "/project-root");
      assert.isFalse(resolved.manualWorktreesBlocked);
      yield* settings.updateSettings({
        projectSettingsOverrides: {
          [projectId]: { ...projectRule, defaultThreadEnvMode: "local" },
        },
      });
      assert.isTrue((yield* policy.resolve({ thread, modelSelection })).manualWorktreesBlocked);
      yield* settings.updateSettings({ projectSettingsOverrides: { [projectId]: projectRule } });
    }),
  );

  it.effect("resolves the response style with a project override over the global choice", () =>
    Effect.gen(function* () {
      const policy = yield* RuntimePolicy.RuntimePolicyV2;
      const settings = yield* ServerSettings.ServerSettingsService;
      const now = yield* DateTime.now;
      const thread = makeThread({ now, worktreePath: null });
      yield* settings.updateSettings({ responseStyle: "detailed" });
      assert.equal((yield* policy.resolve({ thread, modelSelection })).responseStyle, "detailed");
      yield* settings.updateSettings({
        projectSettingsOverrides: {
          [projectId]: {
            agentInstructions: "Project rule",
            claudeWorkflowMode: "disabled",
            responseStyle: "concise",
          },
        },
      });
      assert.equal((yield* policy.resolve({ thread, modelSelection })).responseStyle, "concise");
      yield* settings.updateSettings({
        responseStyle: "concise",
        projectSettingsOverrides: {
          [projectId]: { agentInstructions: "Project rule", claudeWorkflowMode: "disabled" },
        },
      });
    }),
  );

  it.effect("carries the SpecWithCode Browser preference, on by default", () =>
    Effect.gen(function* () {
      const policy = yield* RuntimePolicy.RuntimePolicyV2;
      const settings = yield* ServerSettings.ServerSettingsService;
      const now = yield* DateTime.now;
      const thread = makeThread({ now, worktreePath: null });
      assert.isTrue((yield* policy.resolve({ thread, modelSelection })).preferSpecWithCodeBrowser);
      yield* settings.updateSettings({ preferSpecWithCodeBrowser: false });
      assert.isFalse((yield* policy.resolve({ thread, modelSelection })).preferSpecWithCodeBrowser);
      yield* settings.updateSettings({ preferSpecWithCodeBrowser: true });
    }),
  );

  it.effect("prefers a provisioned worktree over the project root", () =>
    Effect.gen(function* () {
      const policy = yield* RuntimePolicy.RuntimePolicyV2;
      const now = yield* DateTime.now;
      const resolved = yield* policy.resolve({
        thread: makeThread({ now, worktreePath: "/project-worktree" }),
        modelSelection,
      });
      assert.equal(resolved.cwd, "/project-worktree");
      assert.isFalse(resolved.manualWorktreesBlocked);
      assert.match(resolved.agentInstructions ?? "", /Environment rule[\s\S]*Project rule/);
    }),
  );

  it.effect("runs a mode the provider does not offer in Supervised", () =>
    Effect.gen(function* () {
      const policy = yield* RuntimePolicy.RuntimePolicyV2;
      const now = yield* DateTime.now;
      const modeFor = (instanceId: ProviderInstanceId, runtimeMode: RuntimeMode) =>
        policy
          .resolve({
            thread: makeThread({ now, worktreePath: null, runtimeMode }),
            modelSelection: { instanceId, model: "test-model" },
          })
          .pipe(Effect.map((resolved) => resolved.runtimeMode));

      assert.equal(yield* modeFor(grokInstanceId, "auto-accept-edits"), "approval-required");
      assert.equal(yield* modeFor(grokInstanceId, "auto"), "auto");
      assert.equal(yield* modeFor(grokInstanceId, "full-access"), "full-access");
      // A provider that advertises no restriction runs every mode as stored.
      assert.equal(yield* modeFor(providerInstanceId, "auto-accept-edits"), "auto-accept-edits");
    }),
  );
});
