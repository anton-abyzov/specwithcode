import { describe, expect, it } from "vite-plus/test";

import {
  describeMissingCheckout,
  projectGroupTitleNeedsUpdate,
} from "./ProjectSettingsPanel.logic";

describe("projectGroupTitleNeedsUpdate", () => {
  it("updates divergent member titles even when the next title is the derived group label", () => {
    expect(
      projectGroupTitleNeedsUpdate(["local-title", "remote-title"], "Repository name", true),
    ).toBe(true);
  });

  it("skips an untouched blur when the derived label differs from member titles", () => {
    expect(projectGroupTitleNeedsUpdate(["repo-slug", "repo-slug"], "Repository Name", false)).toBe(
      false,
    );
  });

  it("skips an update when every member already has the next title", () => {
    expect(projectGroupTitleNeedsUpdate(["Shared name", "Shared name"], "Shared name", true)).toBe(
      false,
    );
  });
});

describe("describeMissingCheckout", () => {
  const environments = [
    { environmentId: "m4", label: "MacBook M4", connected: true },
    { environmentId: "m1", label: "MacBook M1", connected: true },
    { environmentId: "pro", label: "MacBook Pro", connected: true },
  ];
  const members = [
    { environmentId: "m4", environmentLabel: "MacBook M4", physicalProjectKey: "m4:p1" },
    { environmentId: "pro", environmentLabel: "MacBook Pro", physicalProjectKey: "pro:p2" },
  ];
  const base = {
    projectKey: "specweave",
    projectName: "specweave",
    members,
    checkoutKey: null,
    environments,
  };

  it("explains an environment without a checkout and offers where the project lives", () => {
    const result = describeMissingCheckout({ ...base, environmentId: "m1" });
    expect(result.title).toBe("specweave isn't checked out on MacBook M1");
    expect(result.choices.map((choice) => choice.label)).toEqual([
      "All environments",
      "Open on MacBook M4",
      "Open on MacBook Pro",
    ]);
    expect(result.choices[0]!.search).toEqual({ project: "specweave" });
    expect(result.choices[1]!.search).toEqual({ project: "specweave", machine: "m4" });
  });

  it("says an offline environment is offline instead of claiming there is no checkout", () => {
    const result = describeMissingCheckout({
      ...base,
      environmentId: "m1",
      environments: environments.map((entry) =>
        entry.environmentId === "m1" ? { ...entry, connected: false } : entry,
      ),
    });
    expect(result.title).toBe("MacBook M1 is offline");
  });

  it("names a stale checkout on an environment that still has the project", () => {
    const result = describeMissingCheckout({
      ...base,
      environmentId: "m4",
      checkoutKey: "m4:gone",
    });
    expect(result.title).toBe("That checkout of specweave is no longer listed");
  });

  it("skips the all-environments choice when only one machine has the project", () => {
    const result = describeMissingCheckout({
      ...base,
      members: [members[0]!],
      environmentId: "m1",
    });
    expect(result.choices.map((choice) => choice.label)).toEqual(["Open on MacBook M4"]);
  });
});
