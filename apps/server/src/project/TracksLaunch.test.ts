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
