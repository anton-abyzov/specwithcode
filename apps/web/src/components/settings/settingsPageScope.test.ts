import { describe, expect, it } from "vite-plus/test";
import {
  effectiveSettingsSearch,
  settingsPageScope,
  settingsPageScopeOptions,
  settingsSearchAfterScopeChange,
} from "./settingsPageScope";

const search = { project: "specweave", machine: "m4", checkout: "m4:p1" };

describe("settingsPageScope", () => {
  it("makes App and Agents pages global", () => {
    for (const page of [
      "general",
      "appearance",
      "keybindings",
      "snap-shot",
      "privacy",
      "archived",
      "agents",
      "scheduled-tasks",
      "mods",
    ]) {
      expect(settingsPageScope(`/settings/${page}`)).toBe("global");
      expect(effectiveSettingsSearch(`/settings/${page}`, search)).toEqual({});
    }
  });

  it("scopes providers to a machine and ignores the project", () => {
    expect(settingsPageScope("/settings/providers")).toBe("machine");
    expect(effectiveSettingsSearch("/settings/providers", search)).toEqual({ machine: "m4" });
  });

  it("keeps the project only on Project pages", () => {
    expect(effectiveSettingsSearch("/settings/projects", search)).toEqual(search);
  });

  it("remembers the project in the URL when a machine page changes machine", () => {
    expect(
      settingsSearchAfterScopeChange("/settings/providers", search, { machine: "stage" }),
    ).toEqual({ project: "specweave", machine: "stage" });
    expect(settingsSearchAfterScopeChange("/settings/projects", search, {})).toEqual({});
  });

  it("shows Skills for exactly one machine, in machine wording", () => {
    expect(settingsPageScope("/settings/skills")).toBe("project");
    expect(settingsPageScopeOptions("/settings/skills")).toEqual({
      singleMachine: true,
      wording: "set-up",
    });
    // The project and a picked machine both stay in the URL.
    expect(effectiveSettingsSearch("/settings/skills", search)).toEqual(search);
  });

  it("keeps All environments on every other page", () => {
    for (const page of ["projects", "source-control", "storage"]) {
      expect(settingsPageScopeOptions(`/settings/${page}`)).toEqual({
        singleMachine: false,
        wording: "applying",
      });
    }
    expect(settingsPageScopeOptions("/settings/providers")).toEqual({
      singleMachine: true,
      wording: "applying",
    });
  });
});
