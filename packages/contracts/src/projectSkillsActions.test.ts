import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  AuthEnvironmentMaintainScope,
  AuthFilesystemWriteScope,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthTerminalOperateScope,
} from "./auth.ts";
import { clientRpcRequiredScopes } from "./clientRpcPermissions.ts";
import {
  ProjectSkillsActionError,
  ProjectSkillsActionInput,
  ProjectSkillsFleetPushInput,
  ProjectSkillsStudioLinkInput,
} from "./projectSkills.ts";
import { WS_METHODS } from "./rpc.ts";

const decodeAction = Schema.decodeUnknownSync(ProjectSkillsActionInput);
const decodePush = Schema.decodeUnknownSync(ProjectSkillsFleetPushInput);
const decodeStudioLink = Schema.decodeUnknownSync(ProjectSkillsStudioLinkInput);

describe("skills control center contracts", () => {
  it("takes names that can never read as a flag", () => {
    const base = { projectId: "project", preview: true, action: { kind: "unpin" } };
    expect(decodeAction({ ...base, skill: "anthropic-skills:docx" }).skill).toBe(
      "anthropic-skills:docx",
    );
    for (const skill of ["-rf", "--global", "", "a b", "x;rm", "$(id)", "x".repeat(201)])
      expect(() => decodeAction({ ...base, skill })).toThrow();
  });

  it("takes only exact X.Y.Z versions and known action kinds", () => {
    const base = { projectId: "project", skill: "sw-do", preview: false };
    expect(decodeAction({ ...base, action: { kind: "pin", version: "1.2.3" } }).action).toEqual({
      kind: "pin",
      version: "1.2.3",
    });
    for (const version of ["latest", "^1.2.3", "1.2", "1.2.3-beta", "--force"])
      expect(() =>
        decodeAction({ ...base, action: { kind: "install-version", version } }),
      ).toThrow();
    expect(() => decodeAction({ ...base, action: { kind: "disable" } })).toThrow();
    expect(() =>
      decodeAction({
        ...base,
        action: {
          kind: "toggle-plugin",
          provider: "claudeAgent",
          instanceId: "claudeAgent",
          pluginId: "-a",
          enabled: false,
          scope: "user",
        },
      }),
    ).toThrow();
  });

  it("preserves the exact version confirmed by the preview", () => {
    const base = {
      projectId: "project",
      skill: "sw-do",
      preview: false,
      action: { kind: "update-latest" },
    };
    expect(
      decodeAction({ ...base, expected: { lockSha: "hash", targetVersion: "1.2.3" } }).expected,
    ).toEqual({ lockSha: "hash", targetVersion: "1.2.3" });
    expect(() => decodeAction({ ...base, expected: { targetVersion: "latest" } })).toThrow();
  });

  it("opens Studio's agent-folder groups such as .claude, but no path in the plugin", () => {
    const base = { projectId: "project", source: "project", skill: "sw-do" };
    expect(decodeStudioLink({ ...base, plugin: ".claude" }).plugin).toBe(".claude");
    expect(decodeStudioLink({ ...base, plugin: "sw" }).plugin).toBe("sw");
    for (const plugin of ["", ".", "..", "../x", "a/b", "-x", "..claude", " x"])
      expect(() => decodeStudioLink({ ...base, plugin })).toThrow();
  });

  it("pushes to 1-32 machines, a project target naming its project", () => {
    const base = {
      projectId: "project",
      skillId: "anton-abyzov/vskill/sw-do",
      version: "1.2.3",
      pin: true,
    };
    expect(
      decodePush({ ...base, targets: [{ machineId: "m3", scope: "user" }] }).targets,
    ).toHaveLength(1);
    expect(() => decodePush({ ...base, targets: [] })).toThrow();
    expect(() =>
      decodePush({ ...base, targets: [{ machineId: "m3", scope: "project" }] }),
    ).toThrow();
    expect(() =>
      decodePush({
        ...base,
        skillId: "github:owner/repo",
        targets: [{ machineId: "m3", scope: "user" }],
      }),
    ).toThrow();
  });

  it("widens skillsAction to terminal operate for everything but a settings-file skill switch", () => {
    for (const provider of ["claudeAgent", "grok", "opencode", "pi", "acpRegistry"])
      expect(
        clientRpcRequiredScopes(WS_METHODS.projectsSkillsAction, {
          action: { kind: "toggle-skill", provider },
        }),
      ).toEqual([AuthFilesystemWriteScope]);
    expect(
      clientRpcRequiredScopes(WS_METHODS.projectsSkillsAction, {
        action: { kind: "toggle-skill", provider: "codex" },
      }),
    ).toEqual([AuthFilesystemWriteScope, AuthTerminalOperateScope]);
    expect(
      clientRpcRequiredScopes(WS_METHODS.projectsSkillsAction, {
        action: { kind: "toggle-plugin", provider: "grok" },
      }),
    ).toEqual([AuthFilesystemWriteScope, AuthTerminalOperateScope]);
    expect(clientRpcRequiredScopes(WS_METHODS.projectsSkillsAction, undefined)).toEqual([
      AuthFilesystemWriteScope,
      AuthTerminalOperateScope,
    ]);
    expect(clientRpcRequiredScopes(WS_METHODS.projectsSkillsVersions, {})).toEqual([
      AuthOrchestrationReadScope,
    ]);
    expect(clientRpcRequiredScopes(WS_METHODS.projectsSkillsFleetPush, {})).toEqual([
      AuthEnvironmentMaintainScope,
    ]);
    expect(clientRpcRequiredScopes(WS_METHODS.projectsSkillsStudioLink, {})).toEqual([
      AuthOrchestrationOperateScope,
    ]);
  });

  it("names each refusal in plain words, a detail winning over the generic one", () => {
    expect(
      new ProjectSkillsActionError({ projectId: "p" as never, reason: "stale" }).message,
    ).toMatch(/changed since the preview/);
    expect(
      new ProjectSkillsActionError({
        projectId: "p" as never,
        reason: "cli_failed",
        detail: "vskill exited 2",
      }).message,
    ).toBe("vskill exited 2");
  });
});
