import {
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProjectSkillPresence,
  type ProjectSkillsAction,
} from "@specweave-studio/contracts";
import type { StudioFleetMachine } from "@specweave-studio/contracts/studioFleet";
import { describe, expect, it } from "vite-plus/test";

import {
  agentLiveness,
  fleetPushMachines,
  fleetPushTargets,
  inverseSkillAction,
  isNewerVersion,
  pluginSwitchFor,
  skillActionErrorText,
  skillActionOverridden,
  skillAppliedText,
  skillPluginOf,
  skillPreviewLines,
  skillSwitchFor,
  skillUpdateTarget,
} from "./ProjectSkillActions.logic";

function presence(
  driver: string,
  path: string,
  extra: Partial<ProjectSkillPresence> = {},
): ProjectSkillPresence {
  return {
    instanceId: ProviderInstanceId.make(driver),
    driver: ProviderDriverKind.make(driver),
    label: driver,
    path,
    scope: "user",
    enabled: true,
    ...extra,
  };
}

describe("per-agent switches", () => {
  it("switches Claude project skills in the local file and user skills for the user", () => {
    const project = skillSwitchFor(
      presence("claudeAgent", "/work/app/.claude/skills/deploy/SKILL.md", { scope: "project" }),
    );
    expect(project).toEqual({
      available: true,
      action: {
        kind: "toggle-skill",
        provider: "claudeAgent",
        instanceId: "claudeAgent",
        enabled: false,
        scope: "local",
      },
    });
    const off = skillSwitchFor(
      presence("claudeAgent", "/home/me/.claude/skills/deploy/SKILL.md", { enabled: false }),
    );
    expect(off.available && off.action).toMatchObject({ enabled: true, scope: "user" });
    const codex = skillSwitchFor(presence("codex", "/work/app/.agents/skills/deploy/SKILL.md"));
    expect(codex.available && codex.action).toMatchObject({ enabled: false, scope: "user" });
  });

  it("gives Grok and agents without a writer a disabled switch with a reason", () => {
    expect(skillSwitchFor(presence("grok", "/home/me/.grok/skills/x/SKILL.md"))).toEqual({
      available: false,
      reason: "Grok has no per-skill toggle",
    });
    expect(skillSwitchFor(presence("cursor", "/work/app/.cursor/skills/x/SKILL.md"))).toEqual({
      available: false,
      reason: "cursor has no skill switch here yet",
    });
  });

  it("uses the whole-plugin control for Claude plugin skills", () => {
    const plugin = presence(
      "claudeAgent",
      "/home/me/.claude/plugins/cache/mkt/sw/1/skills/do/SKILL.md",
      { scope: "plugin", enabled: false, name: "sw:do" },
    );
    expect(skillSwitchFor(plugin)).toEqual({
      available: false,
      reason: "Claude plugin skills use the whole-plugin control",
    });
    expect(pluginSwitchFor(plugin, true)).toMatchObject({
      kind: "toggle-plugin",
      enabled: true,
      pluginId: "sw@mkt",
    });
  });

  it("says when each agent sees a change", () => {
    expect(agentLiveness("claudeAgent")).toBe("next-session");
    expect(agentLiveness("codex")).toBe("now");
    expect(agentLiveness("grok")).toBe("reload");
    expect(agentLiveness("cursor")).toBeNull();
  });

  it("reads the plugin id from where each agent installed it", () => {
    expect(
      skillPluginOf(
        presence(
          "claudeAgent",
          "/home/me/.claude/plugins/cache/specweave/sw/1.0.0/skills/do/SKILL.md",
          {
            name: "sw:do",
          },
        ),
      ),
    ).toEqual({ pluginId: "sw@specweave", name: "sw" });
    // The listed name must agree with the cache folder.
    expect(
      skillPluginOf(
        presence(
          "claudeAgent",
          "/home/me/.claude/plugins/cache/specweave/sw/1.0.0/skills/do/SKILL.md",
          {
            name: "other:do",
          },
        ),
      ),
    ).toBeNull();
    expect(
      skillPluginOf(
        presence(
          "codex",
          "/home/me/.codex/plugins/cache/openai-bundled/browser/2/skills/use/SKILL.md",
        ),
      ),
    ).toEqual({ pluginId: "browser@openai-bundled", name: "browser" });
    expect(
      skillPluginOf(
        presence(
          "grok",
          "/home/me/.grok/installed-plugins/chrome-devtools-2df60288/skills/x/SKILL.md",
        ),
      ),
    ).toEqual({ pluginId: "chrome-devtools", name: "chrome-devtools" });
    expect(
      skillPluginOf(presence("claudeAgent", "/work/app/.claude/skills/x/SKILL.md")),
    ).toBeNull();
    expect(
      skillPluginOf(presence("codex", "/home/me/.codex/plugins/cache/-x/-y/1/skills/z/SKILL.md")),
    ).toBeNull();
  });

  it("turns a whole plugin off for the user", () => {
    expect(
      pluginSwitchFor(
        presence(
          "claudeAgent",
          "/home/me/.claude/plugins/cache/specweave/sw/1.0.0/skills/do/SKILL.md",
        ),
        false,
      ),
    ).toEqual({
      kind: "toggle-plugin",
      provider: "claudeAgent",
      instanceId: "claudeAgent",
      pluginId: "sw@specweave",
      enabled: false,
      scope: "user",
    });
    expect(
      pluginSwitchFor(presence("claudeAgent", "/work/app/.claude/skills/x/SKILL.md"), false),
    ).toBeNull();
  });
});

describe("inverseSkillAction", () => {
  const toggle: ProjectSkillsAction = {
    kind: "toggle-skill",
    provider: ProviderDriverKind.make("claudeAgent"),
    instanceId: ProviderInstanceId.make("claudeAgent"),
    enabled: false,
    scope: "local",
  };

  it("flips switches back", () => {
    expect(inverseSkillAction(toggle, null)).toEqual({ ...toggle, enabled: true });
    const plugin: ProjectSkillsAction = {
      kind: "toggle-plugin",
      provider: ProviderDriverKind.make("grok"),
      instanceId: ProviderInstanceId.make("grok"),
      pluginId: "sw",
      enabled: false,
      scope: "user",
    };
    expect(inverseSkillAction(plugin, null)).toEqual({ ...plugin, enabled: true });
  });

  it("puts the pin back as it was", () => {
    expect(
      inverseSkillAction(
        { kind: "pin", version: "1.3.0" },
        { installedVersion: "1.2.0", pinnedVersion: null },
      ),
    ).toEqual({ kind: "unpin" });
    expect(
      inverseSkillAction(
        { kind: "pin", version: "1.3.0" },
        { installedVersion: "1.2.0", pinnedVersion: "1.2.0" },
      ),
    ).toEqual({ kind: "pin", version: "1.2.0" });
    expect(
      inverseSkillAction({ kind: "unpin" }, { installedVersion: "1.2.0", pinnedVersion: "1.2.0" }),
    ).toEqual({ kind: "pin", version: "1.2.0" });
    expect(
      inverseSkillAction({ kind: "unpin" }, { installedVersion: "1.2.0", pinnedVersion: null }),
    ).toBeNull();
  });

  it("reinstalls the version an install or update replaced", () => {
    // Not pinned before, so the reinstall drops the pin vskill's install sets.
    const before = { installedVersion: "1.2.0", pinnedVersion: null };
    expect(inverseSkillAction({ kind: "install-version", version: "1.3.0" }, before)).toEqual({
      kind: "install-version",
      version: "1.2.0",
      pin: false,
    });
    expect(inverseSkillAction({ kind: "update-latest" }, before)).toEqual({
      kind: "install-version",
      version: "1.2.0",
      pin: false,
    });
    expect(
      inverseSkillAction(
        { kind: "install-version", version: "1.3.0" },
        { installedVersion: "1.2.0", pinnedVersion: "1.2.0" },
      ),
    ).toEqual({ kind: "install-version", version: "1.2.0" });
    expect(
      inverseSkillAction(
        { kind: "update-latest" },
        { installedVersion: null, pinnedVersion: null },
      ),
    ).toBeNull();
    expect(
      inverseSkillAction(
        { kind: "update-latest" },
        { installedVersion: "main", pinnedVersion: null },
      ),
    ).toBeNull();
  });
});

describe("preview and result text", () => {
  it("names the command or the files, and when it takes effect", () => {
    expect(
      skillPreviewLines({
        argv: ["vskill", "install", "acme/tools/deploy@1.3.0", "-y"],
        files: ["/work/app/vskill.lock"],
        summary: "Install acme/tools/deploy@1.3.0 and pin it.",
        liveness: "next-session",
        expected: { lockSha: "x" },
      }),
    ).toEqual({
      summary: "Install acme/tools/deploy@1.3.0 and pin it.",
      detail: "Runs vskill install acme/tools/deploy@1.3.0 -y",
      when: "Takes effect: Next session",
      warnings: [],
    });
    expect(
      skillPreviewLines({
        files: ["/work/app/.claude/settings.local.json"],
        summary: "Turn off deploy.",
        liveness: "now",
        warnings: ["/work/app/.claude/settings.local.json is not gitignored"],
        expected: {},
      }),
    ).toMatchObject({
      detail: "Edits /work/app/.claude/settings.local.json",
      when: "Takes effect: Live",
      warnings: ["/work/app/.claude/settings.local.json is not gitignored"],
    });
    // The summary already names the file, so there is no second line repeating it.
    expect(
      skillPreviewLines({
        files: ["/home/me/.claude/settings.json"],
        summary: 'set skillOverrides["deploy"] to "off" in /home/me/.claude/settings.json',
        liveness: "next-session",
        expected: {},
      }).detail,
    ).toBe("");
  });

  it("calls a switch overridden when the agent reports the other state", () => {
    const off = {
      kind: "toggle-skill",
      provider: "codex",
      instanceId: "codex",
      enabled: false,
      scope: "user",
    } as const as Parameters<typeof skillActionOverridden>[0];
    const result = (effectiveEnabled?: boolean) => ({
      applied: true as const,
      summary: "x",
      liveness: "now" as const,
      ...(effectiveEnabled === undefined ? {} : { effectiveEnabled }),
    });
    expect(skillActionOverridden(off, result(true))).toBe(true);
    expect(skillActionOverridden(off, result(false))).toBe(false);
    expect(skillActionOverridden(off, result())).toBe(false);
    expect(skillActionOverridden({ kind: "unpin" }, result(true))).toBe(false);
  });

  it("reports what the lock or agent says after the change", () => {
    expect(
      skillAppliedText({
        applied: true,
        summary: "Installed acme/tools/deploy@1.3.0.",
        liveness: "next-session",
        installedVersion: "1.3.0",
        pinnedVersion: "1.3.0",
      }),
    ).toEqual({
      title: "Installed acme/tools/deploy@1.3.0.",
      description: "Installed 1.3.0, pinned at 1.3.0, takes effect: next session",
    });
    expect(
      skillAppliedText({
        applied: true,
        summary: "Turned off deploy for Codex.",
        liveness: "now",
        effectiveEnabled: false,
      }).description,
    ).toBe("The agent no longer loads it, takes effect: live");
  });

  it("uses the server's own words for refusals, with the CLI's last lines", () => {
    expect(skillActionErrorText({ message: "The file changed since the preview." })).toBe(
      "The file changed since the preview.",
    );
    expect(
      skillActionErrorText({ message: "The command failed.", stderrTail: "a\nb\nnetwork down" }),
    ).toBe("The command failed. b network down");
    expect(skillActionErrorText(null)).toBe("The machine did not confirm the change.");
  });
});

describe("fleet push targets", () => {
  const machine = (id: string, environmentId: string, status: StudioFleetMachine["status"]) =>
    ({
      id,
      label: id.toUpperCase(),
      environmentId: EnvironmentId.make(environmentId),
      url: `https://${id}`,
      status,
      pairingConfigured: true,
    }) satisfies StudioFleetMachine;
  const machines = fleetPushMachines(
    [
      machine("m4", "env-m4", "reachable"),
      machine("m3", "env-m3", "reachable"),
      machine("m1", "env-m1", "unreachable"),
      machine("m2", "env-m2", "reachable"),
    ],
    EnvironmentId.make("env-m4"),
    [
      { environmentId: EnvironmentId.make("env-m3"), id: ProjectId.make("p-m3") },
      { environmentId: EnvironmentId.make("env-m1"), id: ProjectId.make("p-m1") },
    ],
  );

  it("lists the other machines with this project's id on each", () => {
    expect(machines.map((entry) => [entry.machineId, entry.reachable, entry.projectId])).toEqual([
      ["m3", true, "p-m3"],
      ["m1", false, "p-m1"],
      ["m2", true, null],
    ]);
  });

  it("sends only checked, reachable machines; a project push needs the project there", () => {
    const checked = new Set(["m3", "m1", "m2"]);
    expect(fleetPushTargets(machines, checked, "user").targets).toEqual([
      { machineId: "m3", scope: "user" },
      { machineId: "m2", scope: "user" },
    ]);
    const project = fleetPushTargets(machines, checked, "project");
    expect(project.targets).toEqual([{ machineId: "m3", scope: "project", projectId: "p-m3" }]);
    expect(project.missing.map((entry) => entry.machineId)).toEqual(["m2"]);
  });
});

describe("update target", () => {
  it("offers only a higher version number than the installed one", () => {
    expect(isNewerVersion("1.10.0", "1.9.3")).toBe(true);
    expect(isNewerVersion("1.0.13", "1.1.0")).toBe(false);
    expect(isNewerVersion("1.1.0", "1.1.0")).toBe(false);
    expect(isNewerVersion("latest", "1.1.0")).toBe(false);
    expect(skillUpdateTarget("1.2.0", "1.3.0")).toBe("1.3.0");
    // The registry's newest upload is lower than the lock: no "update" to a downgrade.
    expect(skillUpdateTarget("1.1.0", "1.0.13")).toBeNull();
    expect(skillUpdateTarget(null, "1.3.0")).toBeNull();
  });
});
