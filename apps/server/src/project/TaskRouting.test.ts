import { assert, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  DEFAULT_TASK_ROUTING_SETTINGS,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";

import { projectFixture } from "./ProjectWorkspace.testkit.ts";
import type * as ServerSettings from "../serverSettings.ts";
import { routeWorkerTask } from "./TaskRouting.ts";

const projectId = ProjectId.make("project:paid-preference");
const claudeMax = ProviderInstanceId.make("claudeAgent");
const claudeApi = ProviderInstanceId.make("claude-api");

const instance = (
  instanceId: ProviderInstanceId,
  auth: ServerProvider["auth"],
  over: Partial<ServerProvider> = {},
): ServerProvider => ({
  instanceId,
  driver: ProviderDriverKind.make("claudeAgent"),
  enabled: true,
  installed: true,
  version: "test",
  status: "ready",
  auth,
  checkedAt: "2026-10-25T00:00:00.000Z",
  models: [
    { slug: "claude-opus-5-5", name: "Claude Opus 5.5", isCustom: false, capabilities: null },
  ],
  slashCommands: [],
  skills: [],
  ...over,
});

const providers = [
  instance(claudeMax, { status: "authenticated", type: "max" }),
  instance(claudeApi, { status: "authenticated", type: "apiKey", apiKeyBilling: true }),
];

/** Settings with empty lanes and one learned rule naming `instanceId`; Auto off unless asked. */
const settingsPreferring = (
  instanceId: ProviderInstanceId,
  over: {
    readonly recordedBy?: "person" | "coordinator";
    readonly auto?: boolean;
  } = {},
) =>
  Option.some({
    getSettings: Effect.succeed({
      ...DEFAULT_SERVER_SETTINGS,
      projectSettingsOverrides: {
        [projectId]: {
          learnedModelPreferences: [
            {
              id: "pref-coordinator",
              keywords: [],
              lane: "routine" as const,
              action: {
                kind: "prefer" as const,
                model: { instanceId, model: "claude-opus-5-5" },
              },
              ...(over.recordedBy === undefined ? {} : { recordedBy: over.recordedBy }),
              createdAt: "2026-10-25T00:00:00.000Z",
            },
          ],
          ...(over.auto
            ? {
                taskRouting: { ...DEFAULT_TASK_ROUTING_SETTINGS, mode: "auto" as const },
                providerLimitSwitchAtPercent: 95,
              }
            : {}),
        },
      },
    }),
  } as unknown as ServerSettings.ServerSettingsService["Service"]);

const route = (
  instanceId: ProviderInstanceId,
  over: Parameters<typeof settingsPreferring>[1] = {},
  routeProviders: ReadonlyArray<ServerProvider> = providers,
) =>
  routeWorkerTask({
    project: projectFixture(projectId),
    baseline: { instanceId: claudeMax, model: "claude-opus-5-5" },
    providers: routeProviders,
    task: { title: "Fix typo", text: "Fix the typo in README" },
    laneHint: "routine",
    settings: settingsPreferring(instanceId, over),
  });

it.effect("keeps a worker off API credits that only a learned preference names", () =>
  Effect.gen(function* () {
    // Refused for billing, the rule counts as absent: Auto is off and the
    // lanes are empty, so the worker keeps its own model.
    assert.isNull(yield* route(claudeApi));
    assert.isNull(yield* route(claudeApi, { recordedBy: "coordinator" }));
  }),
);

it.effect("follows the person's own Prefer rule onto a per-token model", () =>
  Effect.gen(function* () {
    const decision = yield* route(claudeApi, { recordedBy: "person" });
    assert.isTrue(decision?.moved);
    assert.strictEqual(decision?.selection.instanceId, claudeApi);
    assert.strictEqual(decision?.modelBilling, "api");
  }),
);

it.effect("lets Auto decide past a refused rule instead of failing the launch", () =>
  Effect.gen(function* () {
    // The baseline subscription is past the 95% switch threshold. Before,
    // the refused rule alone set the lanes, found no model and threw
    // model_unavailable without asking Auto.
    const busyMax = instance(
      claudeMax,
      { status: "authenticated", type: "max" },
      {
        usageLimits: {
          checkedAt: "2026-10-25T00:00:00.000Z",
          windows: [
            {
              id: "five_hour",
              kind: "session",
              label: "Session",
              usedPercent: 96,
              resetsAt: "2099-10-25T05:00:00.000Z",
            },
          ],
        },
      },
    );
    yield* TestClock.setTime(Date.parse("2026-10-25T01:00:00.000Z"));
    const decision = yield* route(claudeApi, { auto: true }, [busyMax, providers[1]!]);
    assert.isNotNull(decision);
    // Auto's own decision (no lane), never the refused per-token model.
    assert.isUndefined(decision!.lane);
    assert.notStrictEqual(decision!.selection.instanceId, claudeApi);
    assert.strictEqual(decision!.modelBilling, "subscription");
  }),
);

it.effect("still follows a learned preference for a subscription", () =>
  Effect.gen(function* () {
    const decision = yield* route(claudeMax);
    assert.strictEqual(decision?.selection.instanceId, claudeMax);
    assert.strictEqual(decision?.modelBilling, "subscription");
  }),
);

const sonnet = {
  slug: "claude-sonnet-5-5",
  name: "Claude Sonnet 5.5",
  isCustom: false,
  capabilities: null,
};
const laneProviders = [
  instance(
    claudeMax,
    { status: "authenticated", type: "max" },
    {
      models: [
        { slug: "claude-opus-5-5", name: "Claude Opus 5.5", isCustom: false, capabilities: null },
        sonnet,
      ],
    },
  ),
];
const settingsWithLanesAndJev = Option.some({
  getSettings: Effect.succeed({
    ...DEFAULT_SERVER_SETTINGS,
    decisionModel: { provider: "typesafe" as const, model: "", apiKey: "ts-key" },
    projectSettingsOverrides: {
      [projectId]: {
        modelLanes: {
          complex: [{ instanceId: claudeMax, model: "claude-opus-5-5" }],
          routine: [{ instanceId: claudeMax, model: "claude-sonnet-5-5" }],
        },
      },
    },
  }),
} as unknown as ServerSettings.ServerSettingsService["Service"]);

const jevAnswering = (lane: "complex" | "routine", probability: number) => {
  const calls: Array<{ readonly authorization: string | null; readonly body: unknown }> = [];
  const send = (async (_url: string, options?: RequestInit) => {
    calls.push({
      authorization: new Headers(options?.headers).get("authorization"),
      body: JSON.parse(String(options?.body)),
    });
    return Response.json({
      model: "jev-latest",
      answers: {
        lane: {
          type: "choice",
          choice: lane,
          confidence: probability,
          probabilities: {
            [lane]: probability,
            [lane === "complex" ? "routine" : "complex"]: 1 - probability,
          },
        },
        taskClass: {
          type: "choice",
          choice: "general",
          confidence: 0.9,
          probabilities: { general: 0.9 },
        },
      },
    });
  }) as typeof fetch;
  return { send, calls };
};

const routeWithJev = (send: typeof fetch, laneHint?: "complex" | "routine") =>
  routeWorkerTask({
    project: projectFixture(projectId),
    baseline: { instanceId: claudeMax, model: "claude-sonnet-5-5" },
    providers: laneProviders,
    task: { title: "Changelog", text: "Update the changelog for 1.0.80" },
    laneHint,
    settings: settingsWithLanesAndJev,
    decisionFetch: send,
  });

it.effect("asks the decision model for the lane the rules would guess", () =>
  Effect.gen(function* () {
    const jev = jevAnswering("complex", 0.88);
    const decision = yield* routeWithJev(jev.send);
    assert.strictEqual(decision?.lane, "complex");
    assert.strictEqual(decision?.selection.model, "claude-opus-5-5");
    assert.include(decision?.reason ?? "", "the decision model judged it (88%)");
    assert.strictEqual(jev.calls.length, 1);
    assert.strictEqual(jev.calls[0]?.authorization, "Bearer ts-key");
    assert.deepInclude(jev.calls[0]?.body as object, { model: "jev-latest" });
  }),
);

it.effect("keeps the rules' lane when the decision model is unsure or fails", () =>
  Effect.gen(function* () {
    const unsure = yield* routeWithJev(jevAnswering("complex", 0.6).send);
    assert.strictEqual(unsure?.lane, "routine");
    const down = yield* routeWithJev((async () => {
      throw new Error("offline");
    }) as typeof fetch);
    assert.strictEqual(down?.lane, "routine");
  }),
);

it.effect("never asks the decision model when the coordinator named the lane", () =>
  Effect.gen(function* () {
    const jev = jevAnswering("routine", 0.99);
    const decision = yield* routeWithJev(jev.send, "complex");
    assert.strictEqual(decision?.lane, "complex");
    assert.strictEqual(jev.calls.length, 0);
  }),
);

const codexSub = ProviderInstanceId.make("codex");
const trackProviders = [
  instance(claudeMax, { status: "authenticated", type: "max" }),
  instance(
    codexSub,
    { status: "authenticated", type: "chatgpt" },
    {
      driver: ProviderDriverKind.make("codex"),
      models: [{ slug: "gpt-6.1-sol", name: "GPT-6.1 Sol", isCustom: false, capabilities: null }],
    },
  ),
];
const settingsWithMode = (mode: "tracks" | "model") =>
  Option.some({
    getSettings: Effect.succeed({
      ...DEFAULT_SERVER_SETTINGS,
      projectSettingsOverrides: { [projectId]: { threadModelMode: mode } },
    }),
  } as unknown as ServerSettings.ServerSettingsService["Service"]);
const routeFromSol = (mode: "tracks" | "model") =>
  routeWorkerTask({
    project: projectFixture(projectId),
    baseline: { instanceId: codexSub, model: "gpt-6.1-sol" },
    providers: trackProviders,
    task: { title: "Fix typo", text: "Fix the typo in README" },
    laneHint: "routine",
    settings: settingsWithMode(mode),
  });

it.effect("starts a Tracks project's worker on the first available Daily entry", () =>
  Effect.gen(function* () {
    // Nobody saved a track: the built-in Daily order (Opus 5.5 first) decides.
    const decision = yield* routeFromSol("tracks");
    assert.isTrue(decision?.moved);
    assert.strictEqual(decision?.selection.instanceId, claudeMax);
    assert.strictEqual(decision?.selection.model, "claude-opus-5-5");
  }),
);

it.effect("leaves a One model project's worker alone while no track is saved", () =>
  Effect.gen(function* () {
    assert.isNull(yield* routeFromSol("model"));
  }),
);

const copilotAgent = ProviderInstanceId.make("copilot");
const opusModel = {
  slug: "claude-opus-5.5",
  name: "Claude Opus 5.5",
  isCustom: false,
  capabilities: null,
};
const copilotWithOpus = instance(copilotAgent, { status: "authenticated" }, {
  driver: ProviderDriverKind.make("acpRegistry"),
  iconUrl: "https://cdn.agentclientprotocol.com/registry/v1/latest/github-copilot-cli.svg",
  models: [opusModel],
} as Partial<ServerProvider>);
const signedOut = (provider: ServerProvider): ServerProvider => ({
  ...provider,
  auth: { status: "unauthenticated" },
});

it.effect("runs a Daily model on its next account when the first one cannot take it", () =>
  Effect.gen(function* () {
    const decision = yield* routeWorkerTask({
      project: projectFixture(projectId),
      baseline: { instanceId: codexSub, model: "gpt-6.1-sol" },
      providers: [signedOut(trackProviders[0]!), trackProviders[1]!, copilotWithOpus],
      task: { title: "Fix typo", text: "Fix the typo in README" },
      laneHint: "routine",
      settings: settingsWithMode("tracks"),
    });
    // Opus stays the Daily pick: Copilot runs it while Claude is signed out.
    assert.strictEqual(decision?.selection.instanceId, copilotAgent);
    assert.strictEqual(decision?.selection.model, "claude-opus-5.5");
  }),
);

it.effect("starts hard work in a Tracks project on the Complex track", () =>
  Effect.gen(function* () {
    const fable = {
      slug: "claude-fable-5-2",
      name: "Claude Fable 5.2",
      isCustom: false,
      capabilities: null,
    };
    const decision = yield* routeWorkerTask({
      project: projectFixture(projectId),
      baseline: { instanceId: codexSub, model: "gpt-6.1-sol" },
      providers: [
        instance(
          claudeMax,
          { status: "authenticated", type: "max" },
          {
            models: [...trackProviders[0]!.models, fable],
          },
        ),
        trackProviders[1]!,
      ],
      task: { title: "Design the sync protocol", text: "Design the sync protocol" },
      laneHint: "complex",
      settings: settingsWithMode("tracks"),
    });
    assert.strictEqual(decision?.lane, "complex");
    assert.strictEqual(decision?.selection.model, "claude-fable-5-2");
  }),
);

it.effect("refuses a Tracks worker a per-token model nobody named for it", () =>
  Effect.gen(function* () {
    // Every plan account is signed out; the parent thread runs on an API key.
    const failure = yield* routeWorkerTask({
      project: projectFixture(projectId),
      baseline: { instanceId: claudeApi, model: "claude-opus-5-5" },
      providers: [
        signedOut(trackProviders[0]!),
        signedOut(trackProviders[1]!),
        instance(claudeApi, { status: "authenticated", type: "apiKey", apiKeyBilling: true }),
      ],
      task: { title: "Fix typo", text: "Fix the typo in README" },
      laneHint: "routine",
      settings: settingsWithMode("tracks"),
    }).pipe(Effect.flip);
    assert.strictEqual(failure.code, "model_unavailable");
    assert.include(failure.message, "billed per use");
  }),
);

it.effect("keeps a per-token model for a One model project's worker", () =>
  Effect.gen(function* () {
    const decision = yield* routeWorkerTask({
      project: projectFixture(projectId),
      baseline: { instanceId: claudeApi, model: "claude-opus-5-5" },
      providers,
      task: { title: "Fix typo", text: "Fix the typo in README" },
      laneHint: "routine",
      settings: settingsWithMode("model"),
    });
    assert.isNull(decision);
  }),
);
