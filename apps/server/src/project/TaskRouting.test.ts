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
