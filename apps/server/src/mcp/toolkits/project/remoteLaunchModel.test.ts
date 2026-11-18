import { assert, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  type ModelSelection,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { projectFixture } from "../../../project/ProjectWorkspace.testkit.ts";
import * as ProviderRegistry from "../../../provider/ProviderRegistry.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import { remotePickedModel } from "./remoteLaunchModel.ts";

const projectId = ProjectId.make("project:remote-model");
const claude = ProviderInstanceId.make("claudeAgent");
const effortLevels = {
  id: "effort",
  label: "Reasoning",
  type: "select",
  options: ["low", "medium", "high"].map((level) => ({ id: level, label: level })),
};
const model = (slug: string) => ({
  slug,
  name: slug,
  isCustom: false,
  capabilities: { optionDescriptors: [effortLevels] },
});
const providers: ReadonlyArray<ServerProvider> = [
  {
    instanceId: claude,
    driver: ProviderDriverKind.make("claudeAgent"),
    enabled: true,
    installed: true,
    version: "test",
    status: "ready",
    auth: { status: "authenticated", type: "max" },
    checkedAt: "2026-11-18T00:00:00.000Z",
    models: [model("claude-opus-5-5"), model("claude-fable-5-2"), model("claude-sonnet-5-5")],
    slashCommands: [],
    skills: [],
  } as unknown as ServerProvider,
];
const select = (slug: string, effort?: string): ModelSelection =>
  ({
    instanceId: claude,
    model: slug,
    ...(effort === undefined ? {} : { options: [{ id: "effort", value: effort }] }),
  }) as ModelSelection;
const opus = select("claude-opus-5-5");
const fable = select("claude-fable-5-2", "medium");
const sonnet = select("claude-sonnet-5-5");

const lanes = {
  complex: [select("claude-fable-5-2", "high")],
  routine: [select("claude-sonnet-5-5")],
};

/** The pick with this machine's settings; `overrides` are the project's own. */
const pick = (
  input: {
    readonly projectModel?: ModelSelection | null;
    readonly caller?: ModelSelection;
    readonly isCoordinator?: boolean;
    readonly taskLane?: "complex" | "routine";
    readonly taskClass?: "code" | "research";
    readonly scratch?: boolean;
    readonly grant?: Parameters<typeof remotePickedModel>[0]["grantAccounts"];
  },
  overrides: Record<string, unknown> | null = {},
  listed: ReadonlyArray<ServerProvider> = providers,
) =>
  remotePickedModel({
    project: input.scratch
      ? undefined
      : projectFixture(projectId, { defaultModelSelection: input.projectModel ?? null }),
    callerModel: input.caller,
    isCoordinator: input.isCoordinator ?? false,
    title: "Check the build",
    message: "Read the build log and report.",
    taskClass: input.taskClass,
    taskLane: input.taskLane,
    grantAccounts: input.grant,
  }).pipe(
    Effect.provide(
      overrides === null
        ? Layer.empty
        : Layer.mergeAll(
            Layer.mock(ServerSettings.ServerSettingsService)({
              getSettings: Effect.succeed({
                ...DEFAULT_SERVER_SETTINGS,
                projectSettingsOverrides: { [projectId]: overrides },
              } as never),
            }),
            Layer.mock(ProviderRegistry.ProviderRegistry)({
              getProviders: Effect.succeed(listed),
            }),
          ),
    ),
  );

it.effect("starts on the project's own model, not the model of the thread that asked", () =>
  Effect.gen(function* () {
    assert.deepStrictEqual(yield* pick({ projectModel: fable, caller: opus }), fable);
    // The project's own model is a pin: a lane hint does not move it.
    assert.deepStrictEqual(
      yield* pick(
        { projectModel: fable, caller: opus, taskLane: "routine" },
        { modelLanes: lanes },
      ),
      fable,
    );
  }),
);

it.effect("follows the project's tracks with the caller's lane hint", () =>
  Effect.gen(function* () {
    const tracks = { threadModelMode: "tracks", modelLanes: lanes };
    // On tracks the saved model is not a pin; the caller's Opus is only the baseline.
    const complex = yield* pick({ projectModel: fable, caller: opus, taskLane: "complex" }, tracks);
    assert.strictEqual(complex?.model, "claude-fable-5-2");
    const routine = yield* pick({ projectModel: fable, caller: opus, taskLane: "routine" }, tracks);
    assert.strictEqual(routine?.model, "claude-sonnet-5-5");
    // The routed model runs at the effort the baseline ran at, as a launch here does.
    const low = yield* pick(
      { caller: select("claude-opus-5-5", "low"), taskLane: "complex" },
      tracks,
    );
    assert.strictEqual(low?.model, "claude-fable-5-2");
    assert.deepStrictEqual(
      low?.options?.find((option) => option.id === "effort"),
      { id: "effort", value: "low" },
    );
  }),
);

it.effect("uses the lanes for a hint when the project names no model", () =>
  Effect.gen(function* () {
    const withLanes = { modelLanes: lanes };
    // No hint and no tracks: a thread's worker keeps inheriting its own model.
    assert.deepStrictEqual(yield* pick({ caller: opus }, withLanes), opus);
    assert.strictEqual(
      (yield* pick({ caller: opus, taskLane: "routine" }, withLanes))?.model,
      "claude-sonnet-5-5",
    );
    assert.strictEqual(
      (yield* pick({ caller: opus, taskLane: "complex" }, withLanes))?.model,
      "claude-fable-5-2",
    );
  }),
);

it.effect("keeps the baseline when this machine's routing refuses", () =>
  Effect.gen(function* () {
    // The lane's only model runs on a sign-in this machine does not have, and
    // neither does the caller's: here that refuses a launch, there it may run.
    const elsewhere = ProviderInstanceId.make("codex");
    const caller = { instanceId: elsewhere, model: "gpt-6-astra" } as ModelSelection;
    const picked = yield* pick(
      { caller, taskLane: "complex" },
      {
        threadModelMode: "tracks",
        modelLanes: { complex: [{ instanceId: elsewhere, model: "gpt-6-astra" }], routine: [] },
      },
      [],
    );
    assert.deepStrictEqual(picked, caller);
  }),
);

it.effect("leaves a per-use baseline to the other machine when its tracks refuse here", () =>
  Effect.gen(function* () {
    // Here the only sign-in bills per use, so no track model may start unasked.
    const keyed = [{ ...providers[0]!, auth: { status: "authenticated", type: "apiKey" } }];
    const astra = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6-astra" };
    const tracks = { threadModelMode: "tracks", modelLanes: { complex: [astra], routine: [] } };
    assert.isUndefined(yield* pick({ caller: opus, taskLane: "complex" }, tracks, keyed as never));
    // The same refusal with the caller on a plan keeps the caller's model.
    assert.deepStrictEqual(yield* pick({ caller: opus, taskLane: "complex" }, tracks), opus);
    // Off tracks nothing refuses, and the caller's own model is inherited as before.
    assert.deepStrictEqual(yield* pick({ caller: opus }, {}, keyed as never), opus);
  }),
);

it.effect("follows the caller's work grant as a launch here does", () =>
  Effect.gen(function* () {
    const withLanes = { modelLanes: lanes };
    const elsewhere = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6-astra" };
    const caller = elsewhere as ModelSelection;
    const listed = (...instanceIds: ReadonlyArray<ProviderInstanceId>) =>
      ({ kind: "listed", instanceIds }) as never;
    // The grant excludes the project model's sign-in: the worker keeps its own model.
    assert.deepStrictEqual(
      yield* pick({ projectModel: fable, caller, grant: listed(elsewhere.instanceId) }),
      caller,
    );
    assert.deepStrictEqual(
      yield* pick({ projectModel: fable, caller, grant: listed(claude) }),
      fable,
    );
    // A grant that lists accounts is never routed, lane hint or not.
    assert.deepStrictEqual(
      yield* pick({ caller: opus, taskLane: "routine", grant: listed(claude) }, withLanes),
      opus,
    );
    const open = { kind: "all" } as never;
    assert.strictEqual(
      (yield* pick({ caller: opus, taskLane: "routine", grant: open }, withLanes))?.model,
      "claude-sonnet-5-5",
    );
  }),
);

it.effect("routes on a task class alone, and gives a coordinator this host's default", () =>
  Effect.gen(function* () {
    // A task class with no lane hint still reaches the lanes.
    const classed = yield* pick({ caller: opus, taskClass: "research" }, { modelLanes: lanes });
    assert.include(["claude-fable-5-2", "claude-sonnet-5-5"], classed?.model);
    // A coordinator whose project names no model starts on the host's worker default.
    const hostDefault = yield* pick({ isCoordinator: true });
    assert.strictEqual(hostDefault?.instanceId, claude);
    assert.isString(hostDefault?.model);
  }),
);

it.effect("inherits as before without settings, for a coordinator and for a scratch thread", () =>
  Effect.gen(function* () {
    assert.deepStrictEqual(yield* pick({ projectModel: fable, caller: opus }, null), opus);
    assert.deepStrictEqual(
      yield* pick({ projectModel: sonnet, caller: opus, isCoordinator: true }, null),
      sonnet,
    );
    assert.isUndefined(yield* pick({ caller: opus, isCoordinator: true }, null));
    assert.deepStrictEqual(yield* pick({ caller: opus, scratch: true }), opus);
    assert.isUndefined(yield* pick({ scratch: true }));
  }),
);
