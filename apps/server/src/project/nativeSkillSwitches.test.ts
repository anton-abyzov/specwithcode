// @effect-diagnostics nodeBuiltinImport:off - paths in this platform's form.
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import {
  isNativeSkillOff,
  nativeSkillHarnessOf,
  nativeSkillSwitchFile,
  planNativeSkillSwitch,
  readNativeSkillSwitches,
} from "./nativeSkillSwitches.ts";

/** A POSIX path as this platform writes it, so the cases hold on Windows too. */
const P = (path: string) => NodePath.resolve(path);

const skill = { name: "deploy", path: P("/home/me/.agents/skills/deploy/SKILL.md") };

const plan = (
  harness: Parameters<typeof planNativeSkillSwitch>[0]["harness"],
  text: string | null,
  enabled: boolean,
  file = P("/home/me/config"),
) => planNativeSkillSwitch({ harness, file, text, skill, enabled });

describe("which agents keep a switch file", () => {
  it("maps drivers and ACP agents, and leaves the rest alone", () => {
    expect(nativeSkillHarnessOf("grok")).toBe("grok");
    expect(nativeSkillHarnessOf("opencode")).toBe("opencode");
    expect(nativeSkillHarnessOf("pi")).toBe("pi");
    expect(nativeSkillHarnessOf("acpRegistry", "gemini")).toBe("gemini");
    expect(nativeSkillHarnessOf("acpRegistry", "github-copilot-cli")).toBe("copilot");
    expect(nativeSkillHarnessOf("acpRegistry", "devin")).toBeUndefined();
    expect(nativeSkillHarnessOf("cursor")).toBeUndefined();
    expect(nativeSkillHarnessOf("claudeAgent")).toBeUndefined();
  });

  it("follows each agent's home variables", () => {
    expect(nativeSkillSwitchFile("grok", { GROK_HOME: P("/g") }, P("/home/me"))).toBe(
      P("/g/config.toml"),
    );
    expect(nativeSkillSwitchFile("gemini", {}, P("/home/me"))).toBe(
      P("/home/me/.gemini/settings.json"),
    );
    expect(nativeSkillSwitchFile("gemini", { GEMINI_CLI_HOME: P("/x") }, P("/home/me"))).toBe(
      P("/x/.gemini/settings.json"),
    );
    expect(nativeSkillSwitchFile("copilot", { COPILOT_HOME: P("/c") }, P("/home/me"))).toBe(
      P("/c/settings.json"),
    );
    expect(nativeSkillSwitchFile("pi", {}, P("/home/me"))).toBe(
      P("/home/me/.pi/agent/settings.json"),
    );
    expect(nativeSkillSwitchFile("opencode", { XDG_CONFIG_HOME: P("/cfg") }, P("/home/me"))).toBe(
      P("/cfg/opencode/opencode.json"),
    );
    expect(nativeSkillSwitchFile("pi", { PI_CODING_AGENT_DIR: "~/pi-agent" }, P("/home/me"))).toBe(
      P("/home/me/pi-agent/settings.json"),
    );
    expect(
      nativeSkillSwitchFile("opencode", {}, P("/home/me"), (file) => file.endsWith(".jsonc")),
    ).toBe(P("/home/me/.config/opencode/opencode.jsonc"));
  });
});

describe("Grok config.toml", () => {
  it("adds a [skills] table when there is none and keeps the rest", () => {
    const result = plan("grok", '# top\nmodel = "x"\n', false);
    expect(result).toMatchObject({
      status: "ok",
      changed: true,
      effectiveEnabled: false,
      nextText: '# top\nmodel = "x"\n\n[skills]\ndisabled = ["deploy"]\n',
    });
  });

  it("edits a multi-line disabled list in place, keeping its comment", () => {
    const text = '[skills]\ndisabled = [\n  "old",\n] # mine\n\n[plugins]\nenabled = []\n';
    expect(plan("grok", text, false)).toMatchObject({
      nextText: '[skills]\ndisabled = ["old", "deploy"] # mine\n\n[plugins]\nenabled = []\n',
    });
    const off = '[skills]\ndisabled = ["deploy", "old"]\n';
    expect(plan("grok", off, true)).toMatchObject({ nextText: '[skills]\ndisabled = ["old"]\n' });
    expect(plan("grok", off, false)).toMatchObject({ changed: false });
  });

  it("refuses a form it cannot edit in place", () => {
    expect(plan("grok", 'skills.paths = ["~/x"]\n', false)).toMatchObject({ status: "invalid" });
    expect(plan("grok", "not toml = = =\n", false)).toMatchObject({ status: "invalid" });
  });
});

describe("JSON settings files", () => {
  it("Gemini: matches names in any case and keeps comments", () => {
    const text = '{\n  // mine\n  "skills": { "disabled": ["Deploy"] }\n}\n';
    const read = readNativeSkillSwitches("gemini", text, P("/f"));
    expect(read.status === "ok" && isNativeSkillOff("gemini", read.state, skill)).toBe(true);
    const on = plan("gemini", text, true);
    expect(on).toMatchObject({ status: "ok", effectiveEnabled: true });
    expect(on.status === "ok" && on.nextText).toContain("// mine");
    expect(plan("gemini", null, false)).toMatchObject({
      nextText: '{\n  "skills": {\n    "disabled": [\n      "deploy"\n    ]\n  }\n}\n',
    });
  });

  it("Copilot: disabledSkills", () => {
    const off = plan("copilot", '{ "theme": "dark" }', false);
    expect(off.status === "ok" && JSON.parse(off.nextText)).toEqual({
      theme: "dark",
      disabledSkills: ["deploy"],
    });
  });

  it("OpenCode: a deny rule after any catch-all, removed again on enable", () => {
    const allow = plan("opencode", '{ "permission": { "skill": "allow" } }', false);
    expect(allow.status === "ok" && JSON.parse(allow.nextText)).toEqual({
      permission: { skill: { "*": "allow", deploy: "deny" } },
    });
    const denied = '{ "permission": { "skill": { "*": "allow", "deploy": "deny" } } }';
    const on = plan("opencode", denied, true);
    expect(on.status === "ok" && JSON.parse(on.nextText)).toEqual({
      permission: { skill: { "*": "allow" } },
    });
    const only = plan("opencode", '{ "permission": { "skill": { "deploy": "deny" } } }', true);
    expect(only.status === "ok" && JSON.parse(only.nextText)).toEqual({ permission: {} });
  });

  it("OpenCode: warns when the skill tool is off for every skill", () => {
    const result = plan("opencode", '{ "tools": { "skill": false } }', true);
    expect(result).toMatchObject({ status: "ok", effectiveEnabled: false });
    expect(result.status === "ok" && result.warnings[0]).toContain('"skill": false');
  });

  it("Pi: a -folder entry, matched against relative entries too", () => {
    const file = P("/home/me/.pi/agent/settings.json");
    const home = P("/home/me");
    const off = planNativeSkillSwitch({
      harness: "pi",
      file,
      text: "{}",
      skill,
      enabled: false,
      home,
    });
    expect(off.status === "ok" && JSON.parse(off.nextText)).toEqual({
      skills: [`-${P("/home/me/.agents/skills/deploy")}`],
    });
    const relative = '{ "skills": ["+skills/x", "-../../.agents/skills/deploy"] }';
    const on = planNativeSkillSwitch({
      harness: "pi",
      file,
      text: relative,
      skill,
      enabled: true,
      home,
    });
    expect(on.status === "ok" && JSON.parse(on.nextText)).toEqual({ skills: ["+skills/x"] });
  });

  it("OpenCode: rules are read in order, the last match winning", () => {
    const allowList = '{ "permission": { "skill": { "*": "deny", "demo": "allow" } } }';
    const read = readNativeSkillSwitches("opencode", allowList, P("/f"));
    const state = read.status === "ok" ? read.state : undefined;
    expect(state?.allOff).toBeUndefined();
    expect(isNativeSkillOff("opencode", state!, { name: "demo", path: P("/d") })).toBe(false);
    expect(isNativeSkillOff("opencode", state!, skill)).toBe(true);
    const reversed = readNativeSkillSwitches(
      "opencode",
      '{ "permission": { "skill": { "deploy": "deny", "*": "allow" } } }',
      P("/f"),
    );
    expect(reversed.status === "ok" && isNativeSkillOff("opencode", reversed.state, skill)).toBe(
      false,
    );
    // On under a deny-all adds an allow rule at the end; off again drops it.
    const on = plan("opencode", allowList, true);
    expect(on.status === "ok" && JSON.parse(on.nextText)).toEqual({
      permission: { skill: { "*": "deny", demo: "allow", deploy: "allow" } },
    });
    expect(on).toMatchObject({ effectiveEnabled: true, warnings: [] });
    const offAgain = plan("opencode", on.status === "ok" ? on.nextText : "", false);
    expect(offAgain.status === "ok" && JSON.parse(offAgain.nextText)).toEqual({
      permission: { skill: { "*": "deny", demo: "allow" } },
    });
    // A rule that loses to a later wildcard moves to the end.
    const shadowed = plan(
      "opencode",
      '{ "permission": { "skill": { "deploy": "deny", "*": "deny" } } }',
      true,
    );
    expect(shadowed.status === "ok" && JSON.parse(shadowed.nextText)).toEqual({
      permission: { skill: { "*": "deny", deploy: "allow" } },
    });
  });

  it("OpenCode: top-level permission keys that match the skill tool count too", () => {
    const denyAll = '{ "permission": { "*": "deny" } }';
    const read = readNativeSkillSwitches("opencode", denyAll, P("/f"));
    expect(read.status === "ok" && isNativeSkillOff("opencode", read.state, skill)).toBe(true);
    const on = plan("opencode", denyAll, true);
    expect(on.status === "ok" && JSON.parse(on.nextText)).toEqual({
      permission: { "*": "deny", skill: { deploy: "allow" } },
    });
    expect(on).toMatchObject({ effectiveEnabled: true });
    // A later catch-all still decides, and the preview says so.
    const later = plan(
      "opencode",
      '{ "permission": { "skill": { "deploy": "deny" }, "*": "deny" } }',
      true,
    );
    expect(later).toMatchObject({ status: "ok", effectiveEnabled: false });
    expect(later.status === "ok" && later.warnings.length).toBeGreaterThan(0);
  });

  it("Pi: switches every user copy of a skill, since Pi loads the first", () => {
    const file = P("/home/me/.pi/agent/settings.json");
    const off = planNativeSkillSwitch({
      harness: "pi",
      file,
      text: "{}",
      skill: {
        name: "deploy",
        path: P("/home/me/.pi/agent/skills/deploy/SKILL.md"),
        copies: [P("/home/me/.agents/skills/deploy/SKILL.md")],
      },
      enabled: false,
      home: P("/home/me"),
    });
    expect(off.status === "ok" && JSON.parse(off.nextText)).toEqual({
      skills: [
        `-${P("/home/me/.pi/agent/skills/deploy")}`,
        `-${P("/home/me/.agents/skills/deploy")}`,
      ],
    });
    expect(off).toMatchObject({ effectiveEnabled: false, warnings: [] });
  });

  it("Pi: switches only user skills, by folder or by a plain .md file", () => {
    const file = P("/home/me/.pi/agent/settings.json");
    const home = P("/home/me");
    const pi = (path: string, text = "{}", enabled = false) =>
      planNativeSkillSwitch({
        harness: "pi",
        file,
        text,
        skill: { name: "x", path },
        enabled,
        home,
      });
    const md = pi(P("/home/me/.pi/agent/skills/x.md"));
    expect(md.status === "ok" && JSON.parse(md.nextText)).toEqual({
      skills: [`-${P("/home/me/.pi/agent/skills/x.md")}`],
    });
    const read = readNativeSkillSwitches("pi", md.status === "ok" ? md.nextText : "", file, home);
    const state = read.status === "ok" ? read.state : undefined;
    expect(
      isNativeSkillOff("pi", state!, { name: "x", path: P("/home/me/.pi/agent/skills/x.md") }),
    ).toBe(true);
    expect(
      isNativeSkillOff("pi", state!, { name: "y", path: P("/home/me/.pi/agent/skills/y.md") }),
    ).toBe(false);
    expect(pi(P("/work/repo/.pi/skills/x/SKILL.md"))).toMatchObject({ status: "invalid" });
    expect(pi("pi:skill:x")).toMatchObject({ status: "invalid" });
    // A project skill named in the user file is not off: Pi ignores the entry for it.
    const project = readNativeSkillSwitches(
      "pi",
      JSON.stringify({ skills: [`-${P("/work/repo/.pi/skills/x")}`] }),
      file,
      home,
    );
    expect(
      project.status === "ok" &&
        isNativeSkillOff("pi", project.state, {
          name: "x",
          path: P("/work/repo/.pi/skills/x/SKILL.md"),
        }),
    ).toBe(false);
  });

  it("refuses a file that is not JSON or holds the list in another shape", () => {
    expect(plan("copilot", "{ nope", false)).toMatchObject({ status: "invalid" });
    expect(plan("gemini", '{ "skills": { "disabled": "deploy" } }', false)).toMatchObject({
      status: "invalid",
    });
  });
});
