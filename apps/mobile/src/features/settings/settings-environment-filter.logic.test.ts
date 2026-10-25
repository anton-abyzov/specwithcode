import { EnvironmentId, ProjectId } from "@specweave-studio/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  settingsTargetsForProject,
  settingsProjectChoices,
} from "./settings-environment-filter.logic";

const laptop = { environmentId: EnvironmentId.make("laptop") };
const server = { environmentId: EnvironmentId.make("server") };
const group = { members: [{ project: server }] };

describe("settingsTargetsForProject", () => {
  it("keeps an explicitly empty environment selection empty", () => {
    expect(settingsTargetsForProject([], null)).toEqual([]);
    expect(settingsTargetsForProject([], group)).toEqual([]);
  });
  it("does not fall back outside the selected project or a missing group", () => {
    expect(settingsTargetsForProject([laptop], group)).toEqual([]);
    expect(settingsTargetsForProject([laptop, server], undefined)).toEqual([]);
  });
  it("keeps selected environments in order and narrows to project members", () => {
    expect(settingsTargetsForProject([laptop, server], null)).toEqual([laptop, server]);
    expect(settingsTargetsForProject([laptop, server], group)).toEqual([server]);
  });
});

describe("mobile settings project choices", () => {
  const make = (key: string, settings = {}, root = `/work/${key}`) => ({
    key,
    members: [
      {
        project: {
          environmentId: laptop.environmentId,
          id: ProjectId.make(key),
          workspaceRoot: root,
          workspaceSettings: settings,
        },
      },
    ],
  });
  const groups = [
    make("active"),
    make("old", { archived: true }),
    make("auto", { origin: "automated" }),
    make("scratch", {}, "/scratch"),
    make("inferred", {}, "/work/fixtures/demo"),
    make("personal", { kind: "personal" }),
  ];
  const machines = new Set([laptop.environmentId]);
  it("offers active personal/code scopes with no archived, automated, or scratch alternatives", () => {
    expect(
      settingsProjectChoices(groups, machines, () => "/scratch", null).choices.map((g) => g.key),
    ).toEqual(["active", "personal"]);
  });
  it("retains each selected excluded scope as unavailable and handles removed scopes", () => {
    for (const key of ["old", "auto", "scratch", "inferred"]) {
      const result = settingsProjectChoices(groups, machines, () => "/scratch", key);
      expect(result.choices.map((g) => g.key)).toContain(key);
      expect(result.unavailable.has(key)).toBe(true);
    }
    expect(
      settingsProjectChoices(groups, machines, () => "/scratch", "removed").choices.map(
        (g) => g.key,
      ),
    ).toEqual(["active", "personal"]);
  });
  it("keeps an excluded selected machine scope rather than silently widening settings", () => {
    const result = settingsProjectChoices(groups, new Set(), () => "/scratch", "active");
    expect(result.choices.map((g) => g.key)).toEqual(["active"]);
    expect(result.unavailable.has("active")).toBe(true);
  });
});
