import { assert, it } from "@effect/vitest";
import {
  DEFAULT_PROJECT_WORKSPACE_SETTINGS,
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
import * as SqlClient from "effect/sql/SqlClient";

import type { ProviderInstance } from "../provider/ProviderDriver.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
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
      // No worktree guard; its git refuses commits in the project folder's clones instead.
      assert.equal(resolved.manualWorktreesBlocked, "/project-root");
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

// Ultracode by default: a Claude instance whose sign-in and usage each case
// sets, a project whose kind each case sets, and a real routine table.
const claudeInstanceId = ProviderInstanceId.make("claudeAgent");
const claudeSelection = {
  instanceId: claudeInstanceId,
  model: "claude-opus-5-5",
} satisfies ModelSelection;
const coordinatorThreadId = ThreadId.make(`project-coordinator:${projectId}`);
let claudeSnapshot: ServerProvider | undefined;
let projectKind: "code" | "personal" = "code";

function claudeProvider(input: {
  readonly apiKeyBilling?: boolean;
  readonly windows?: ReadonlyArray<{
    readonly kind: "session" | "weekly" | "monthly";
    readonly usedPercent: number;
  }>;
}): ServerProvider {
  return {
    driver: "claudeAgent",
    auth: {
      status: "authenticated",
      ...(input.apiKeyBilling === undefined ? {} : { apiKeyBilling: input.apiKeyBilling }),
    },
    ...(input.windows === undefined
      ? {}
      : {
          usageLimits: {
            windows: input.windows.map((window, index) => ({
              id: `window-${index}`,
              label: window.kind,
              ...window,
            })),
          },
        }),
  } as unknown as ServerProvider;
}

function claudeThread(input: {
  readonly now: DateTime.Utc;
  readonly id?: string;
  readonly parentThreadId?: string;
}): OrchestrationV2AppThread {
  const base = makeThread({ now: input.now, worktreePath: null });
  const id = ThreadId.make(input.id ?? "thread:ultracode");
  return {
    ...base,
    id,
    providerInstanceId: claudeInstanceId,
    modelSelection: claudeSelection,
    lineage:
      input.parentThreadId === undefined
        ? { parentThreadId: null, relationshipToParent: null, rootThreadId: id }
        : {
            parentThreadId: ThreadId.make(input.parentThreadId),
            relationshipToParent: "subagent",
            rootThreadId: ThreadId.make(input.parentThreadId),
          },
  };
}

const layerUltracode = RuntimePolicy.layerFromProjectStore.pipe(
  Layer.provideMerge(ServerSettings.layerTest({ claudeWorkflowMode: "on-request" })),
  Layer.provideMerge(SqlitePersistence.layerMemory),
  Layer.provide(
    Layer.succeed(ProviderInstanceRegistry.ProviderInstanceRegistry, {
      getInstance: (instanceId) =>
        Effect.succeed(
          instanceId !== claudeInstanceId
            ? providerInstanceFor(instanceId)
            : claudeSnapshot === undefined
              ? undefined
              : ({
                  driverKind: "claudeAgent",
                  snapshot: { getSnapshot: Effect.sync(() => claudeSnapshot!) },
                } as unknown as ProviderInstance),
        ),
      listInstances: Effect.succeed([]),
      listUnavailable: Effect.succeed([]),
      streamChanges: Stream.empty,
      subscribeChanges: Effect.never,
    }),
  ),
  Layer.provide(
    Layer.mock(ProjectStore.ProjectStoreV2)({
      get: () =>
        Effect.sync(() =>
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
            workspaceSettings: { ...DEFAULT_PROJECT_WORKSPACE_SETTINGS, kind: projectKind },
            createdAt: "2026-06-21T00:00:00.000Z",
            updatedAt: "2026-06-21T00:00:00.000Z",
            deletedAt: null,
          }),
        ),
    }),
  ),
);

it.layer(layerUltracode)("RuntimePolicyV2 Ultracode default", (it) => {
  const resolveDefault = (thread: OrchestrationV2AppThread, modelSelection = claudeSelection) =>
    Effect.gen(function* () {
      const policy = yield* RuntimePolicy.RuntimePolicyV2;
      return (yield* policy.resolve({ thread, modelSelection })).claudeUltracodeDefault;
    });
  const withSettings = <A, E, R>(
    patch: Parameters<ServerSettings.ServerSettingsService["Service"]["updateSettings"]>[0],
    effect: Effect.Effect<A, E, R>,
  ) =>
    Effect.gen(function* () {
      const settings = yield* ServerSettings.ServerSettingsService;
      yield* settings.updateSettings(patch);
      return yield* effect.pipe(
        Effect.ensuring(
          settings
            .updateSettings({
              claudeWorkflowMode: "on-request",
              claudeUltracodeDefault: "threads",
              projectSettingsOverrides: { [projectId]: null },
            })
            .pipe(Effect.orDie),
        ),
      );
    });
  const kinds = (now: DateTime.Utc) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`DELETE FROM scheduled_tasks`;
      yield* sql`INSERT INTO scheduled_tasks (task_id,title,prompt,enabled,schedule_json,project_id,thread_id,workspace_strategy_json,model_selection_json,runtime_mode,interaction_mode,created_by,creation_source,created_at,updated_at,last_run_status,run_count)
        VALUES ('routine','Nightly','Nightly',1,'{}',${projectId},'thread:routine','{}','{}','full-access','default','user','web','1970-01-01','1970-01-01','never',0)`;
      return {
        thread: yield* resolveDefault(claudeThread({ now })),
        worker: yield* resolveDefault(
          claudeThread({ now, id: "thread:worker", parentThreadId: coordinatorThreadId }),
        ),
        coordinator: yield* resolveDefault(claudeThread({ now, id: coordinatorThreadId })),
        routine: yield* resolveDefault(claudeThread({ now, id: "thread:routine" })),
        nested: yield* resolveDefault(
          claudeThread({ now, id: "thread:nested", parentThreadId: "thread:worker" }),
        ),
      };
    });

  it.effect("turns the default on for a project thread on a subscription", () =>
    Effect.gen(function* () {
      claudeSnapshot = claudeProvider({});
      const now = yield* DateTime.now;
      assert.equal(yield* resolveDefault(claudeThread({ now })), "on");
    }),
  );

  it.effect("keeps coordinators, routines and nested subagents off under Threads", () =>
    Effect.gen(function* () {
      claudeSnapshot = claudeProvider({});
      const now = yield* DateTime.now;
      assert.deepEqual(yield* kinds(now), {
        thread: "on",
        worker: "on",
        coordinator: "off",
        routine: "off",
        nested: "off",
      });
    }),
  );

  it.effect("turns every chat on under All chats", () =>
    Effect.gen(function* () {
      claudeSnapshot = claudeProvider({});
      const now = yield* DateTime.now;
      assert.deepEqual(yield* withSettings({ claudeUltracodeDefault: "all" }, kinds(now)), {
        thread: "on",
        worker: "on",
        coordinator: "on",
        routine: "on",
        nested: "on",
      });
    }),
  );

  it.effect("keeps every chat in a personal assistant project off under Threads", () =>
    Effect.gen(function* () {
      claudeSnapshot = claudeProvider({});
      projectKind = "personal";
      const now = yield* DateTime.now;
      const state = yield* resolveDefault(claudeThread({ now })).pipe(
        Effect.ensuring(Effect.sync(() => (projectKind = "code"))),
      );
      assert.equal(state, "off");
    }),
  );

  it.effect("honours Off and Disabled, also as a project override", () =>
    Effect.gen(function* () {
      claudeSnapshot = claudeProvider({});
      const now = yield* DateTime.now;
      const thread = claudeThread({ now });
      assert.equal(
        yield* withSettings({ claudeUltracodeDefault: "off" }, resolveDefault(thread)),
        "off",
      );
      assert.equal(
        yield* withSettings(
          { projectSettingsOverrides: { [projectId]: { claudeUltracodeDefault: "off" } } },
          resolveDefault(thread),
        ),
        "off",
      );
      assert.equal(
        yield* withSettings(
          {
            claudeUltracodeDefault: "off",
            projectSettingsOverrides: { [projectId]: { claudeUltracodeDefault: "threads" } },
          },
          resolveDefault(thread),
        ),
        "on",
      );
      assert.equal(
        yield* withSettings(
          { projectSettingsOverrides: { [projectId]: { claudeWorkflowMode: "disabled" } } },
          resolveDefault(thread),
        ),
        "off",
      );
    }),
  );

  it.effect("keeps a stored Automatic mode on for every unset chat", () =>
    Effect.gen(function* () {
      claudeSnapshot = claudeProvider({});
      const now = yield* DateTime.now;
      assert.deepEqual(
        yield* withSettings(
          { claudeWorkflowMode: "automatic", claudeUltracodeDefault: "off" },
          kinds(now),
        ),
        { thread: "on", worker: "on", coordinator: "on", routine: "on", nested: "on" },
      );
    }),
  );

  it.effect("keeps an API-key instance off", () =>
    Effect.gen(function* () {
      claudeSnapshot = claudeProvider({ apiKeyBilling: true });
      const now = yield* DateTime.now;
      assert.equal(yield* resolveDefault(claudeThread({ now })), "off");
    }),
  );

  it.effect("pauses at 80 percent of a session or weekly limit, not on unknown usage", () =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const thread = claudeThread({ now });
      const stateAt = (windows: Parameters<typeof claudeProvider>[0]["windows"]) => {
        claudeSnapshot = claudeProvider(windows === undefined ? {} : { windows });
        return resolveDefault(thread);
      };
      assert.equal(yield* stateAt([{ kind: "session", usedPercent: 80 }]), "paused");
      assert.equal(yield* stateAt([{ kind: "weekly", usedPercent: 93 }]), "paused");
      assert.equal(yield* stateAt([{ kind: "session", usedPercent: 79 }]), "on");
      assert.equal(yield* stateAt([{ kind: "monthly", usedPercent: 99 }]), "on");
      assert.equal(yield* stateAt([]), "on");
      assert.equal(yield* stateAt(undefined), "on");
    }),
  );

  it.effect("reads a missing instance as a subscription with unknown usage", () =>
    Effect.gen(function* () {
      claudeSnapshot = undefined;
      const now = yield* DateTime.now;
      // The registry has no instance; the id still names the Claude driver.
      const state = yield* resolveDefault(claudeThread({ now }));
      assert.equal(state, "on");
    }),
  );

  it.effect("leaves other providers' policies without the field", () =>
    Effect.gen(function* () {
      claudeSnapshot = claudeProvider({});
      const now = yield* DateTime.now;
      assert.isUndefined(yield* resolveDefault(claudeThread({ now }), modelSelection));
    }),
  );

  it.effect("treats a chat as a routine's when the routine lookup fails", () =>
    Effect.gen(function* () {
      claudeSnapshot = claudeProvider({});
      const now = yield* DateTime.now;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`ALTER TABLE scheduled_tasks RENAME TO scheduled_tasks_moved`;
      const state = yield* resolveDefault(claudeThread({ now })).pipe(
        Effect.ensuring(
          sql`ALTER TABLE scheduled_tasks_moved RENAME TO scheduled_tasks`.pipe(Effect.orDie),
        ),
      );
      assert.equal(state, "off");
      assert.equal(yield* resolveDefault(claudeThread({ now })), "on");
    }),
  );
});
