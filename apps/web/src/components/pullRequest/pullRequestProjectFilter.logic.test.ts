import { EnvironmentId, ProjectId } from "@specweave-studio/contracts";
import { describe, expect, it } from "vite-plus/test";

import { findScopedProject } from "./pullRequestList.logic";
import {
  pullRequestFilterProjects,
  pullRequestScopeFilterProjects,
} from "./pullRequestProjectFilter.logic";

const cups = EnvironmentId.make("env-cups");
const nucbox = EnvironmentId.make("env-nucbox");
const labels = new Map([
  [cups, "cups"],
  [nucbox, "nucbox-1"],
]);

function project(
  id: string,
  environmentId = nucbox,
  canonicalKey: string | null = "github.com/anton-abyzov/specwithcode",
) {
  return {
    id: ProjectId.make(id),
    environmentId,
    title: "studio",
    workspaceRoot: `/work/${id}`,
    repositoryIdentity: canonicalKey === null ? null : { canonicalKey },
    faviconPath: `${id}/favicon.png`,
  };
}

describe("pull request project filter choices", () => {
  it("keeps distinct checkouts on each server even when their remotes match", () => {
    const projects = [
      project("main"),
      project("worktree-1"),
      project("worktree-2"),
      project("main", cups),
    ];
    const choices = pullRequestFilterProjects(projects, labels);
    expect(choices.map(({ environmentId, id }) => [environmentId, id])).toEqual([
      [cups, "main"],
      [nucbox, "main"],
      [nucbox, "worktree-1"],
      [nucbox, "worktree-2"],
    ]);
    expect(choices.map(({ title }) => title)).toEqual([
      "studio · cups",
      "studio · nucbox-1 · /work/main",
      "studio · nucbox-1 · /work/worktree-1",
      "studio · nucbox-1 · /work/worktree-2",
    ]);
    expect(choices.find((p) => p.id === "worktree-1")?.faviconPath).toBe("worktree-1/favicon.png");
  });

  it("keeps a saved selection without hiding its sibling checkout", () => {
    const projects = [project("main"), project("worktree"), project("worktree", cups)];
    const selected = findScopedProject(projects, nucbox, "worktree");
    const choices = pullRequestFilterProjects(projects, labels, selected);
    expect(findScopedProject(choices, nucbox, "worktree")).toBeDefined();
    expect(findScopedProject(choices, nucbox, "main")).toBeDefined();
    expect(findScopedProject(choices, cups, "worktree")).toBeDefined();
  });

  it("does not use repository casing to merge identities", () => {
    const projects = [
      project("main"),
      project("worktree", nucbox, "GitHub.com/Anton-Abyzov/Specwithcode"),
    ];
    expect(pullRequestFilterProjects(projects, labels).map((p) => p.id)).toEqual([
      "main",
      "worktree",
    ]);
  });

  it("deduplicates only repeated environment/project identities and preserves input titles", () => {
    const main = project("main");
    expect(pullRequestFilterProjects([main, main], labels)).toEqual([main]);
    expect(main.title).toBe("studio");
  });

  it("distinguishes same-named repositories on one server by checkout path", () => {
    const projects = [project("upstream"), project("fork", nucbox, "github.com/acme/studio")];

    const choices = pullRequestFilterProjects(projects, labels);

    expect(choices.map((choice) => choice.title)).toEqual([
      "studio · nucbox-1 · /work/fork",
      "studio · nucbox-1 · /work/upstream",
    ]);
  });

  it("keeps repositories on different hosts separate", () => {
    const choices = pullRequestFilterProjects(
      [
        project("github"),
        project("enterprise", nucbox, "git.example.com/anton-abyzov/specwithcode"),
      ],
      labels,
    );

    expect(choices.map((choice) => choice.id)).toEqual(["enterprise", "github"]);
  });

  it("does not merge projects whose repository identity is unknown", () => {
    const choices = pullRequestFilterProjects(
      [project("first", nucbox, null), project("second", nucbox, null)],
      labels,
    );

    expect(choices.map((choice) => choice.title)).toEqual([
      "studio · nucbox-1 · /work/first",
      "studio · nucbox-1 · /work/second",
    ]);
  });

  it("distinguishes servers with the same display name and checkout path", () => {
    const first = project("main");
    const second = project("main", cups);
    const repeatedLabels = new Map([
      [cups, "nucbox-1"],
      [nucbox, "nucbox-1"],
    ]);

    const choices = pullRequestFilterProjects([first, second], repeatedLabels);

    expect(choices.map((choice) => choice.title)).toEqual([
      "studio · nucbox-1 · /work/main · env-cups",
      "studio · nucbox-1 · /work/main · env-nucbox",
    ]);
  });

  it("uses the environment id when its label is unavailable", () => {
    const choices = pullRequestFilterProjects(
      [project("main"), project("remote", cups)],
      new Map(),
    );

    expect(choices.map((choice) => choice.title)).toEqual([
      "studio · env-cups",
      "studio · env-nucbox",
    ]);
  });

  it("can distinguish unresolved project records that also share a checkout path", () => {
    const first = project("first", nucbox, null);
    const second = { ...project("second", nucbox, null), workspaceRoot: first.workspaceRoot };

    const choices = pullRequestFilterProjects([first, second], labels);

    expect(choices.map((choice) => choice.title)).toEqual([
      "studio · nucbox-1 · /work/first · env-nucbox · first",
      "studio · nucbox-1 · /work/first · env-nucbox · second",
    ]);
  });

  it("leaves unrelated names unchanged and orders them alphabetically", () => {
    const app = { ...project("app"), title: "Zebra" };
    const tools = { ...project("tools", nucbox, "github.com/acme/tools"), title: "Alpha" };

    expect(pullRequestFilterProjects([app, tools], labels)).toEqual([tools, app]);
    expect(pullRequestFilterProjects([], labels)).toEqual([]);
  });
});

describe("pull request project scope choices", () => {
  const scoped = (id: string, workspaceRoot: string, workspaceSettings: object = {}) => ({
    ...project(id, nucbox, `github.com/acme/${id}`),
    title: id,
    workspaceRoot,
    workspaceSettings,
  });
  const projects = [
    scoped("app", "/work/app"),
    scoped("old", "/work/old", { archived: true }),
    scoped("check", "/work/check", { origin: "automated" }),
    scoped("scratch", "/home/.studio/scratch"),
    scoped("inferred", "/work/acceptance/proof"),
    scoped("temporary", "/work/session", { temporarySessionId: "check" }),
    scoped("personal", "/work/assistant", { kind: "personal" }),
  ];
  const scratchRootFor = () => "/home/.studio/scratch";

  it("offers only the person's own projects", () => {
    const result = pullRequestScopeFilterProjects(projects, scratchRootFor, labels, undefined);
    expect(result.projects.map((entry) => entry.id)).toEqual(["app"]);
    expect(result.unavailable).toBeNull();
  });

  it("labels the selected inactive checkout alongside a same-named active alternative", () => {
    const active = project("main", nucbox);
    const selected = { ...project("old", cups), workspaceSettings: { archived: true } };
    const result = pullRequestScopeFilterProjects(
      [active, selected],
      scratchRootFor,
      labels,
      selected,
    );
    expect(result.projects.map(({ title }) => title)).toEqual([
      "studio · nucbox-1",
      "studio · cups",
    ]);
    expect(result.unavailable).toEqual({ project: result.projects[1], reason: "archived" });
    expect(result.unavailable?.project.id).toBe("old");
    expect(result.unavailable?.project.environmentId).toBe(cups);
    expect(selected.title).toBe("studio");
  });

  it("keeps an archived or automated scope as the last row, marked as not a choice", () => {
    for (const [id, reason] of [
      ["old", "archived"],
      ["check", "automated"],
      ["scratch", "scratch"],
      ["inferred", "automated"],
      ["temporary", "automated"],
      ["personal", "not-code"],
    ] as const) {
      const current = projects.find((entry) => entry.id === id)!;
      const result = pullRequestScopeFilterProjects(projects, scratchRootFor, labels, current);
      expect(result.projects.map((entry) => entry.id)).toEqual(["app", id]);
      expect(result.unavailable).toEqual({ project: current, reason });
    }
    expect(
      pullRequestScopeFilterProjects(projects, scratchRootFor, labels, projects[0]).unavailable,
    ).toBeNull();
  });
});
