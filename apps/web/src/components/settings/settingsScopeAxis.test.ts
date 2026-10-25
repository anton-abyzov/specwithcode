import { EnvironmentId, ProjectId } from "@specweave-studio/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  environmentAxisValue,
  projectAxisValue,
  selectEnvironmentAxis,
  selectProjectAxis,
  settingsScopeEnvironmentLabel,
  settingsScopeProjectChoices,
} from "./settingsScopeAxis";

const first = {
  environmentId: EnvironmentId.make("first"),
  label: "Development",
  displayUrl: "https://first.example.com",
};
const second = {
  environmentId: EnvironmentId.make("second"),
  label: "Development",
  displayUrl: "https://second.example.com",
};

describe("settings scope environment labels", () => {
  it("distinguishes same-name environments by address", () => {
    const environments = [first, second];
    expect(
      environments.map((environment) => settingsScopeEnvironmentLabel(environment, environments)),
    ).toEqual([
      "Development · https://first.example.com",
      "Development · https://second.example.com",
    ]);
  });

  it("falls back to environment IDs when duplicate names have no display URL", () => {
    const environments = [first, second].map((environment) => ({
      ...environment,
      displayUrl: null,
    }));
    expect(
      environments.map((environment) => settingsScopeEnvironmentLabel(environment, environments)),
    ).toEqual(["Development · first", "Development · second"]);
  });

  it("keeps unique names compact and removes disambiguation after a rename", () => {
    expect(settingsScopeEnvironmentLabel(first, [first])).toBe("Development");
    expect(settingsScopeEnvironmentLabel(first, [first, { ...second, label: "Production" }])).toBe(
      "Development",
    );
  });
});

describe("settings scope axes", () => {
  it("maps each axis to its search key and back", () => {
    expect(projectAxisValue({})).toBe("all");
    expect(projectAxisValue({ project: "app" })).toBe("app");
    expect(selectProjectAxis({ machine: "second" }, "app")).toEqual({
      project: "app",
      machine: "second",
    });
    expect(selectProjectAxis({ machine: "second", project: "app" }, "all")).toEqual({
      machine: "second",
    });
    expect(selectEnvironmentAxis({ project: "app" }, "first")).toEqual({
      project: "app",
      machine: "first",
    });
    expect(selectEnvironmentAxis({ project: "app", machine: "first" }, "all")).toEqual({
      project: "app",
    });
  });

  it("drops a checkout narrowing from older links when either axis changes", () => {
    const checkout = { project: "app", checkout: "app@first", machine: "first" };
    expect(selectEnvironmentAxis(checkout, "second")).toEqual({
      project: "app",
      machine: "second",
    });
    expect(selectProjectAxis(checkout, "app")).toEqual({ project: "app", machine: "first" });
  });
});

describe("environmentAxisValue", () => {
  it("shows the checkout's environment for a legacy checkout link", () => {
    expect(environmentAxisValue({ project: "p", checkout: "c" }, "laptop")).toBe("laptop");
    expect(environmentAxisValue({ project: "p" }, null)).toBe("all");
    expect(environmentAxisValue({ machine: "desk" }, "laptop")).toBe("desk");
  });
});

describe("settings scope project choices", () => {
  const environmentId = EnvironmentId.make("first");
  const group = (projectKey: string, workspaceRoot: string, archived = false) => ({
    projectKey,
    memberProjects: [
      {
        environmentId,
        id: ProjectId.make(projectKey),
        workspaceRoot,
        workspaceSettings: { archived },
      },
    ],
  });
  const groups = [
    group("live", "/work/live"),
    group("old", "/work/old", true),
    group("scratch", "/home/.studio/no-project"),
    group("check", "/tmp/acceptance-run"),
  ];
  const scratchRootFor = () => "/home/.studio/no-project";
  const keys = (choices: { choices: ReadonlyArray<{ projectKey: string }> }) =>
    choices.choices.map((g) => g.projectKey);

  it("leaves out archived and automated projects and the no-project folder", () => {
    const result = settingsScopeProjectChoices(groups, scratchRootFor, undefined);
    expect(keys(result)).toEqual(["live"]);
    expect(result.unavailable).toBeNull();
    expect(settingsScopeProjectChoices(groups, scratchRootFor, "live").unavailable).toBeNull();
  });

  it("shows an archived or automated current scope apart, never as a choice", () => {
    const archived = settingsScopeProjectChoices(groups, scratchRootFor, "old");
    expect(keys(archived)).toEqual(["live"]);
    expect(archived.unavailable).toMatchObject({
      project: { projectKey: "old" },
      reason: "archived",
    });
    const automated = settingsScopeProjectChoices(groups, scratchRootFor, "check");
    expect(keys(automated)).toEqual(["live"]);
    expect(automated.unavailable?.reason).toBe("automated");
  });
});
