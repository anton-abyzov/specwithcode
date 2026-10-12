import { expect, it } from "@effect/vitest";
import {
  DEFAULT_PROJECT_WORKSPACE_SETTINGS,
  ProviderInstanceId,
  ThreadId,
} from "@specweave-studio/contracts";
import { projectDelegationTarget, needsExplicitWorkerTarget } from "./ProjectDelegation.ts";
it("uses the saved worker default only for coordinator requests without an explicit target", () => {
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
  expect(projectDelegationTarget(project, ThreadId.make("worker"), undefined)).toBeUndefined();
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
  // Non-coordinator callers inherit their own model as before.
  expect(
    projectDelegationTarget(project, ThreadId.make("worker"), undefined, hostDefault),
  ).toBeUndefined();
});
