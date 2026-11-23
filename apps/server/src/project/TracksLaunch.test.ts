import { assert, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type * as ServerSettings from "../serverSettings.ts";
import { routeUnnamedLaunch } from "./TracksLaunch.ts";

const projectId = ProjectId.make("project:tracks-launch");
const claude = ProviderInstanceId.make("claudeAgent");
const codex = ProviderInstanceId.make("codex");

const source = (
  instanceId: ProviderInstanceId,
  driver: string,
  type: string,
  slug: string,
  over: Partial<ServerProvider> = {},
): ServerProvider => ({
  instanceId,
  driver: ProviderDriverKind.make(driver),
  enabled: true,
  installed: true,
  version: "test",
  status: "ready",
  auth: { status: "authenticated", type },
  checkedAt: "2026-11-14T00:00:00.000Z",
  models: [{ slug, name: slug, isCustom: false, capabilities: null }],
  slashCommands: [],
  skills: [],
  ...over,
});
const providers = [
  source(claude, "claudeAgent", "max", "claude-opus-5-5"),
  source(codex, "codex", "chatgpt", "gpt-6.1-sol"),
];
const settings = (mode: "tracks" | "model") =>
  Option.some({
    getSettings: Effect.succeed({
      ...DEFAULT_SERVER_SETTINGS,
      projectSettingsOverrides: { [projectId]: { threadModelMode: mode } },
    }),
  } as unknown as ServerSettings.ServerSettingsService["Service"]);
// What the composer showed: the project's old single model.
const shown = { instanceId: codex, model: "gpt-6.1-sol" };
const launch = (
  mode: "tracks" | "model",
  list: ReadonlyArray<ServerProvider> = providers,
  known = true,
) =>
  routeUnnamedLaunch({
    project: known ? { projectId } : undefined,
    providers: list,
    modelSelection: shown,
    title: "New thread",
    text: "Fix the typo in README",
    settings: settings(mode),
  });

it.effect("starts a thread nobody picked a model for on the project's Daily track", () =>
  Effect.gen(function* () {
    const result = yield* launch("tracks");
    assert.strictEqual(result.modelSelection.instanceId, claude);
    assert.strictEqual(result.modelSelection.model, "claude-opus-5-5");
    assert.strictEqual(result.routing?.lane, "routine");
  }),
);

it.effect("keeps the shown model in a One model project and for an unknown project", () =>
  Effect.gen(function* () {
    assert.deepEqual(yield* launch("model"), {
      modelSelection: shown,
      routing: null,
      refused: null,
    });
    assert.deepEqual(yield* launch("tracks", providers, false), {
      modelSelection: shown,
      routing: null,
      refused: null,
    });
  }),
);

it.effect("keeps the shown model when it is the first Daily entry that can run", () =>
  Effect.gen(function* () {
    const signedOut = { ...providers[0]!, auth: { status: "unauthenticated" as const } };
    const result = yield* launch("tracks", [signedOut, providers[1]!]);
    assert.deepEqual(result.modelSelection, shown);
    assert.isFalse(result.routing?.moved);
  }),
);

it.effect("never loses a launch when nothing on the tracks can run", () =>
  Effect.gen(function* () {
    const out = providers.map((entry) => ({
      ...entry,
      auth: { status: "unauthenticated" as const },
    }));
    assert.deepEqual((yield* launch("tracks", out)).modelSelection, shown);
  }),
);

it.effect("refuses a start on a per-token model when nothing on the tracks can run", () =>
  Effect.gen(function* () {
    const apiKey = source(
      ProviderInstanceId.make("claude-api"),
      "claudeAgent",
      "apiKey",
      "claude-opus-5-5",
      { auth: { status: "authenticated", type: "apiKey", apiKeyBilling: true } },
    );
    const result = yield* routeUnnamedLaunch({
      project: { projectId },
      providers: [apiKey],
      modelSelection: { instanceId: apiKey.instanceId, model: "claude-opus-5-5" },
      title: "New thread",
      text: "Fix the typo in README",
      settings: settings("tracks"),
    });
    assert.include(result.refused ?? "", "billed per use");
    // A One model project named that model itself: it starts as before.
    const named = yield* routeUnnamedLaunch({
      project: { projectId },
      providers: [apiKey],
      modelSelection: { instanceId: apiKey.instanceId, model: "claude-opus-5-5" },
      title: "New thread",
      text: "Fix the typo in README",
      settings: settings("model"),
    });
    assert.isNull(named.refused);
  }),
);

// A Daily track topped by Opus with the row's Ultracode on, on a source that offers it.
const ultracode = { id: "ultracode", value: true };
const withSwitch = (entry: ServerProvider): ServerProvider => ({
  ...entry,
  models: entry.models.map((model) => ({
    ...model,
    capabilities: {
      optionDescriptors: [{ id: "ultracode", label: "Ultracode", type: "boolean" as const }],
    },
  })),
});
const ultracodeSources = [withSwitch(providers[0]!), providers[1]!];
const ultracodeSettings = Option.some({
  getSettings: Effect.succeed({
    ...DEFAULT_SERVER_SETTINGS,
    projectSettingsOverrides: {
      [projectId]: {
        threadModelMode: "tracks" as const,
        modelLanes: {
          routine: [{ instanceId: claude, model: "claude-opus-5-5", options: [ultracode] }],
        },
      },
    },
  }),
} as unknown as ServerSettings.ServerSettingsService["Service"]);
const ultracodeLaunch = (
  modelSelection: Parameters<typeof routeUnnamedLaunch>[0]["modelSelection"],
  over: Partial<Parameters<typeof routeUnnamedLaunch>[0]> = {},
) =>
  routeUnnamedLaunch({
    project: { projectId },
    providers: ultracodeSources,
    modelSelection,
    title: "New thread",
    text: "Fix the typo in README",
    settings: ultracodeSettings,
    ...over,
  });
const isOn = (selection: { readonly options?: ReadonlyArray<{ id: string; value: unknown }> }) =>
  selection.options?.find((option) => option.id === "ultracode")?.value;

it.effect("starts a thread the track moves with the row's Ultracode", () =>
  Effect.gen(function* () {
    const result = yield* ultracodeLaunch(shown);
    assert.strictEqual(result.modelSelection.model, "claude-opus-5-5");
    assert.isTrue(result.routing?.moved);
    assert.strictEqual(isOn(result.modelSelection), true);
  }),
);

it.effect("gives the row's Ultracode to a launch already on the track's model", () =>
  Effect.gen(function* () {
    const opus = {
      instanceId: claude,
      model: "claude-opus-5-5",
      options: [{ id: "thinking", value: true }],
    };
    const result = yield* ultracodeLaunch(opus);
    assert.isFalse(result.routing?.moved);
    assert.deepEqual(result.modelSelection.options, [{ id: "thinking", value: true }, ultracode]);
    // The launch turned it off itself: the row does not turn it back on.
    const off = { ...opus, options: [{ id: "ultracode", value: false }] };
    assert.deepEqual((yield* ultracodeLaunch(off)).modelSelection, off);
  }),
);

it.effect("never gives the row's Ultracode to a model that does not offer it", () =>
  Effect.gen(function* () {
    const opus = { instanceId: claude, model: "claude-opus-5-5" };
    const result = yield* ultracodeLaunch(opus, { providers });
    assert.isFalse(result.routing?.moved);
    assert.deepEqual(result.modelSelection, opus);
  }),
);

it.effect("drops a Daily row's Ultracode from an unpicked draft routed to a row without it", () =>
  Effect.gen(function* () {
    // The draft was seeded from Daily (Ultracode on); the task is hard and Complex
    // is topped by the same model with the switch off.
    const seeded = { instanceId: claude, model: "claude-opus-5-5", options: [ultracode] };
    const lanes = Option.some({
      getSettings: Effect.succeed({
        ...DEFAULT_SERVER_SETTINGS,
        projectSettingsOverrides: {
          [projectId]: {
            threadModelMode: "tracks" as const,
            modelLanes: {
              routine: [seeded],
              complex: [{ instanceId: claude, model: "claude-opus-5-5" }],
            },
          },
        },
      }),
    } as unknown as ServerSettings.ServerSettingsService["Service"]);
    const hard = { settings: lanes, laneHint: "complex" as const, seededFromTrack: true };
    assert.isUndefined(isOn((yield* ultracodeLaunch(seeded, hard)).modelSelection));
    // Routed to Daily, the row's switch goes back on.
    const daily = { ...hard, laneHint: "routine" as const };
    assert.strictEqual(isOn((yield* ultracodeLaunch(seeded, daily)).modelSelection), true);
    // A worker that carries it by its own choice keeps it.
    const own = { settings: lanes, laneHint: "complex" as const };
    assert.strictEqual(isOn((yield* ultracodeLaunch(seeded, own)).modelSelection), true);
  }),
);

it.effect("starts a moved thread without the row's Ultracode where its model lists none", () =>
  Effect.gen(function* () {
    const result = yield* ultracodeLaunch(shown, { providers });
    assert.isTrue(result.routing?.moved);
    assert.strictEqual(result.modelSelection.model, "claude-opus-5-5");
    assert.isUndefined(isOn(result.modelSelection));
  }),
);

it.effect("keeps a routine's own thread off the row's Ultracode", () =>
  Effect.gen(function* () {
    const moved = yield* ultracodeLaunch(shown, { rowUltracode: false });
    assert.strictEqual(moved.modelSelection.model, "claude-opus-5-5");
    assert.isUndefined(isOn(moved.modelSelection));
    assert.isUndefined(isOn(moved.routing!.selection));
    const opus = { instanceId: claude, model: "claude-opus-5-5" };
    assert.deepEqual((yield* ultracodeLaunch(opus, { rowUltracode: false })).modelSelection, opus);
  }),
);
