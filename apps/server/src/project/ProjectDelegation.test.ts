import { describe, expect, it } from "@effect/vitest";
import {
  DEFAULT_PROJECT_WORKSPACE_SETTINGS,
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  ProviderInstanceId,
  type ServerProvider,
  ThreadId,
} from "@specweave-studio/contracts";
import {
  projectDelegationTarget,
  needsExplicitWorkerTarget,
  newWorkerModel,
  quotaBoostWorkerModel,
  projectLimitRule,
  projectUsesTracks,
  replacesProjectModelOverride,
  projectWorkerModel,
  workerModelUnderGrant,
} from "./ProjectDelegation.ts";
it("uses the project's worker model for any caller without an explicit target", () => {
  const coordinator = ThreadId.make("coordinator");
  const model = {
    instanceId: ProviderInstanceId.make("claude"),
    model: "opus",
    options: [{ id: "effort", value: "high" }],
  };
  const project = {
    workspaceSettings: { ...DEFAULT_PROJECT_WORKSPACE_SETTINGS, coordinatorThreadId: coordinator },
    defaultModelSelection: model,
  };
  expect(projectDelegationTarget(project, coordinator, undefined)).toEqual({
    providerInstanceId: model.instanceId,
    model: "opus",
    options: model.options,
  });
  const explicit = { providerInstanceId: ProviderInstanceId.make("codex"), model: "gpt-5" };
  expect(projectDelegationTarget(project, coordinator, explicit)).toBe(explicit);
  // A worker's own worker takes the project model, not the worker's (possibly fallback) model.
  expect(projectDelegationTarget(project, ThreadId.make("worker"), undefined)).toEqual({
    providerInstanceId: model.instanceId,
    model: "opus",
    options: model.options,
  });
  expect(projectDelegationTarget(project, ThreadId.make("worker"), explicit)).toBe(explicit);
  expect(
    projectDelegationTarget({ ...project, defaultModelSelection: null }, coordinator, undefined),
  ).toBeUndefined();
});

it("requires an explicit worker target when a retained coordinator has no worker default", () => {
  const coordinator = ThreadId.make("coordinator");
  const project = {
    workspaceSettings: { ...DEFAULT_PROJECT_WORKSPACE_SETTINGS, coordinatorThreadId: coordinator },
    defaultModelSelection: null,
  };
  expect(needsExplicitWorkerTarget(project, coordinator, undefined)).toBe(true);
  expect(needsExplicitWorkerTarget(project, coordinator, { model: "explicit-model" })).toBe(false);
  expect(needsExplicitWorkerTarget(project, ThreadId.make("worker"), undefined)).toBe(false);
});

it("starts a coordinator's worker on the host default when the project saved no worker model", () => {
  const coordinator = ThreadId.make("coordinator");
  const hostDefault = {
    instanceId: ProviderInstanceId.make("claudeAgent"),
    model: "claude-opus-5-5",
  };
  const project = {
    workspaceSettings: { ...DEFAULT_PROJECT_WORKSPACE_SETTINGS, coordinatorThreadId: coordinator },
    defaultModelSelection: null,
  };
  expect(needsExplicitWorkerTarget(project, coordinator, undefined, hostDefault)).toBe(false);
  expect(projectDelegationTarget(project, coordinator, undefined, hostDefault)).toEqual({
    providerInstanceId: hostDefault.instanceId,
    model: "claude-opus-5-5",
  });
  // A saved worker model still wins, and a named model is passed through untouched.
  const saved = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6.1-sol" };
  expect(
    projectDelegationTarget(
      { ...project, defaultModelSelection: saved },
      coordinator,
      undefined,
      hostDefault,
    ),
  ).toEqual({ providerInstanceId: saved.instanceId, model: saved.model });
  const named = { model: "explicit-model" };
  expect(projectDelegationTarget(project, coordinator, named, hostDefault)).toBe(named);
  // Without a project model, non-coordinator callers inherit their own model as before.
  expect(
    projectDelegationTarget(project, ThreadId.make("worker"), undefined, hostDefault),
  ).toBeUndefined();
});

it("reads the project's worker model from its override before the saved field, never the machine default", () => {
  const id = ProjectId.make("aide");
  const saved = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6.1-sol" };
  const override = { instanceId: ProviderInstanceId.make("claudeAgent"), model: "claude-opus-5-5" };
  const machine = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.5" };
  const settings = { ...DEFAULT_SERVER_SETTINGS, defaultModelSelection: machine };
  expect(
    projectWorkerModel(
      { ...settings, projectSettingsOverrides: { [id]: { defaultModelSelection: override } } },
      { id, defaultModelSelection: saved },
    ),
  ).toEqual(override);
  expect(projectWorkerModel(settings, { id, defaultModelSelection: saved })).toEqual(saved);
  expect(projectWorkerModel(settings, { id, defaultModelSelection: null })).toBeNull();
});

it("keeps a non-coordinator under a grant without the project model's sign-in on its own model", () => {
  const model = { instanceId: ProviderInstanceId.make("claude-main"), model: "claude-opus-5-5" };
  const codexOnly = { kind: "listed" as const, instanceIds: [ProviderInstanceId.make("codex-1")] };
  expect(workerModelUnderGrant(model, false, codexOnly)).toBeNull();
  expect(workerModelUnderGrant(model, false, { kind: "all" })).toEqual(model);
  expect(workerModelUnderGrant(model, false, undefined)).toEqual(model);
  // The coordinator's own rule is unchanged: its launch is checked against the grant later.
  expect(workerModelUnderGrant(model, true, codexOnly)).toEqual(model);
});

it("reads the Project settings dialog's model on an install that folded its project fields", () => {
  const id = ProjectId.make("aide");
  const dialog = { instanceId: ProviderInstanceId.make("claudeAgent"), model: "claude-opus-5-5" };
  const override = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6.1-sol" };
  const folded = { ...DEFAULT_SERVER_SETTINGS, projectSettingsFolded: true };
  expect(projectWorkerModel(folded, { id, defaultModelSelection: dialog })).toEqual(dialog);
  expect(
    projectWorkerModel(
      { ...folded, projectSettingsOverrides: { [id]: { defaultModelSelection: override } } },
      { id, defaultModelSelection: dialog },
    ),
  ).toEqual(override);
  expect(projectWorkerModel(folded, { id, defaultModelSelection: null })).toBeNull();
});

it("gives a limit stop the same home model as a launch, after the settings fold too", () => {
  const id = ProjectId.make("project-limit-home");
  const dialog = { instanceId: ProviderInstanceId.make("claudeAgent"), model: "claude-opus-5-5" };
  const machine = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6.1-sol" };
  const folded = {
    ...DEFAULT_SERVER_SETTINGS,
    projectSettingsFolded: true,
    defaultModelSelection: machine,
  };
  const project = { id, defaultModelSelection: dialog };
  expect(projectLimitRule(folded, project).defaultModelSelection).toEqual(dialog);
  expect(
    projectLimitRule(folded, { id, defaultModelSelection: null }).defaultModelSelection,
  ).toEqual(machine);
});

it("removes an older override only when the dialog saves a different model", () => {
  const projectId = ProjectId.make("project-override");
  const opus = { instanceId: ProviderInstanceId.make("claudeAgent"), model: "claude-opus-5-5" };
  const sol = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6.1-sol" };
  const settings = {
    ...DEFAULT_SERVER_SETTINGS,
    projectSettingsOverrides: { [projectId]: { defaultModelSelection: sol } },
  };
  const base = { settings, projectId, previous: opus };
  expect(replacesProjectModelOverride({ ...base, next: sol })).toBe(true);
  expect(replacesProjectModelOverride({ ...base, next: null })).toBe(true);
  // The whole form sent again with the same model, an untouched field, a seeded default.
  expect(replacesProjectModelOverride({ ...base, next: { ...opus } })).toBe(false);
  expect(replacesProjectModelOverride({ ...base, next: undefined })).toBe(false);
  expect(replacesProjectModelOverride({ ...base, next: sol, onlyIfUnset: true })).toBe(false);
  expect(
    replacesProjectModelOverride({ ...base, settings: DEFAULT_SERVER_SETTINGS, next: sol }),
  ).toBe(false);
});

it("names no single project model on Tracks, so the track for the task decides", () => {
  const id = ProjectId.make("aide");
  const saved = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6.1-sol" };
  const project = { id, defaultModelSelection: saved };
  const onTracks = {
    ...DEFAULT_SERVER_SETTINGS,
    projectSettingsOverrides: { [id]: { threadModelMode: "tracks" as const } },
  };
  expect(projectUsesTracks(onTracks, project)).toBe(true);
  expect(projectWorkerModel(onTracks, project)).toBeNull();
  // A project that existed before tracks has no mode saved and keeps its model.
  expect(projectUsesTracks(DEFAULT_SERVER_SETTINGS, project)).toBe(false);
  expect(projectWorkerModel(DEFAULT_SERVER_SETTINGS, project)).toEqual(saved);
});

describe("quota boost", () => {
  const id = ProjectId.make("aide");
  const now = Date.parse("2026-11-15T12:00:00.000Z");
  const codex = ProviderInstanceId.make("codex");
  const saved = { instanceId: ProviderInstanceId.make("claudeAgent"), model: "claude-opus-5-5" };
  const project = { id, defaultModelSelection: saved };
  const boost = (over: Record<string, unknown> = {}) => ({
    accountKey: "codex:pro",
    instanceId: codex,
    model: "gpt-6.1-sol",
    projectIds: [] as string[],
    label: "Codex Pro",
    until: now + 3_600_000,
    startedAt: now - 60_000,
    ...over,
  });
  const withBoost = (value: ReturnType<typeof boost> | null, extra: object = {}) =>
    ({
      ...DEFAULT_SERVER_SETTINGS,
      quotaBoosts: { "codex:pro": value },
      ...extra,
    }) as typeof DEFAULT_SERVER_SETTINGS;
  const codexProvider = (slugs: ReadonlyArray<string>, enabled = true) =>
    ({
      instanceId: codex,
      enabled,
      models: slugs.map((slug) => ({ slug, name: slug, isCustom: false, capabilities: null })),
    }) as unknown as ServerProvider;
  const listed = [codexProvider(["gpt-6.1-sol"])];
  const sol = { instanceId: codex, model: "gpt-6.1-sol" };

  it("starts a new worker on the boosted model, over the project model and over Tracks", () => {
    expect(newWorkerModel(withBoost(boost()), project, listed, now)).toEqual(sol);
    const onTracks = withBoost(boost(), {
      projectSettingsOverrides: { [id]: { threadModelMode: "tracks" } },
    });
    expect(newWorkerModel(onTracks, project, listed, now)).toEqual(sol);
  });

  it("ends by itself, and covers only the projects it names", () => {
    expect(newWorkerModel(withBoost(boost({ until: now - 1 })), project, listed, now)).toEqual(
      saved,
    );
    expect(newWorkerModel(withBoost(null), project, listed, now)).toEqual(saved);
    expect(
      newWorkerModel(withBoost(boost({ projectIds: ["other"] })), project, listed, now),
    ).toEqual(saved);
  });

  it("refuses a model the account no longer lists, or a provider that is off", () => {
    const settings = withBoost(boost());
    expect(quotaBoostWorkerModel(settings, project, [codexProvider(["gpt-6-astra"])], now)).toBe(
      null,
    );
    expect(quotaBoostWorkerModel(settings, project, [], now)).toBeNull();
    expect(
      quotaBoostWorkerModel(settings, project, [codexProvider(["gpt-6.1-sol"], false)], now),
    ).toBeNull();
    expect(newWorkerModel(settings, project, [codexProvider(["gpt-6-astra"])], now)).toEqual(saved);
  });

  it("leaves open threads and the limit rule on the project's own model", () => {
    const settings = withBoost(boost());
    expect(projectWorkerModel(settings, project)).toEqual(saved);
    expect(projectLimitRule(settings, project).defaultModelSelection).toEqual(saved);
  });
});
