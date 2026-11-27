import { assert, describe, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  ProviderInstanceId,
  type ServerProvider,
  type ServerSettings as ServerSettingsValue,
} from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import { provider } from "../studio/fixtures.ts";
import { withProjectTrackRowUltracode } from "./ProjectDelegation.ts";
import { namedLaunchOnTrackRow } from "./TrackRowUltracode.ts";

const projectId = ProjectId.make("project:track-row");
const project = { id: projectId, defaultModelSelection: null };
const claude = ProviderInstanceId.make("claudeAgent");
const OPUS = "claude-opus-5-5";
const on = { id: "ultracode", value: true };
const off = { id: "ultracode", value: false };
const medium = { id: "effort", value: "medium" };

const claudeProvider: ServerProvider = {
  ...provider(claude, "claudeAgent"),
  models: [
    {
      slug: OPUS,
      name: "Claude Opus 5.5",
      isCustom: false,
      capabilities: {
        optionDescriptors: [
          {
            id: "effort",
            label: "Effort",
            type: "select",
            options: [{ id: "medium", label: "Medium", isDefault: true }],
          },
          { id: "ultracode", label: "Ultracode", type: "boolean" },
        ],
      },
    },
  ],
};
const providers = [claudeProvider];

const settingsWith = (
  mode: "tracks" | "model",
  row: ReadonlyArray<{ readonly id: string; readonly value: string | boolean }>,
): ServerSettingsValue => ({
  ...DEFAULT_SERVER_SETTINGS,
  projectSettingsFolded: true,
  projectSettingsOverrides: {
    [projectId]: {
      threadModelMode: mode,
      modelLanes: { routine: [{ instanceId: claude, model: OPUS, options: [...row] }], complex: [] },
    },
  },
});

describe("a named launch on a Tracks row (1506)", () => {
  const named = { instanceId: claude, model: OPUS, options: [medium] };

  it("takes the row's Ultracode only on a Tracks project whose row has it on", () => {
    assert.deepEqual(
      withProjectTrackRowUltracode(settingsWith("tracks", [medium, on]), project, named, providers)
        .options,
      [medium, on],
    );
    // One model for the project, or the row off: as named.
    assert.strictEqual(
      withProjectTrackRowUltracode(settingsWith("model", [medium, on]), project, named, providers),
      named,
    );
    assert.strictEqual(
      withProjectTrackRowUltracode(settingsWith("tracks", [medium]), project, named, providers),
      named,
    );
    // The caller's own off wins.
    const own = { ...named, options: [medium, off] };
    assert.strictEqual(
      withProjectTrackRowUltracode(settingsWith("tracks", [medium, on]), project, own, providers),
      own,
    );
  });

  const launch = (taskClass?: "review") =>
    namedLaunchOnTrackRow({ project, selection: named, taskClass }).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.mock(ServerSettings.ServerSettingsService)({
            getSettings: Effect.succeed(settingsWith("tracks", [medium, on])),
          }),
          Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed(providers) }),
        ),
      ),
    );

  it.effect("reads this machine's settings and providers for studio_thread_launch", () =>
    Effect.gen(function* () {
      assert.deepEqual((yield* launch())?.options, [medium, on]);
      // A review launch takes only its model and effort (1441).
      assert.strictEqual(yield* launch("review"), named);
      // Nothing named: nothing to add.
      assert.isUndefined(yield* namedLaunchOnTrackRow({ project, selection: undefined }));
    }),
  );
});
