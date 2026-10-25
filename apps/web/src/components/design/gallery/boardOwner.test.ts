import type { ProjectId } from "@specweave-studio/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  creationOffReason,
  designSystemsHref,
  missingFolderOf,
  missingFolderProjects,
  problemIsAbout,
  problemKey,
  problemsInScope,
  withMissingFolders,
  withoutMissingFolders,
} from "./boardOwner";

const project = (id: string, extra: { unavailable?: string } = {}) => ({
  id: id as ProjectId,
  title: id,
  ...extra,
});

describe("designSystemsHref", () => {
  it("names the board's project so new systems default to it", () => {
    expect(designSystemsHref(project("plain app"))).toBe(
      "/settings/design-systems?project=plain%20app",
    );
  });

  it("names no project for the gallery or a project that takes no new work", () => {
    expect(designSystemsHref(null)).toBe("/settings/design-systems");
    expect(designSystemsHref(project("old", { unavailable: "Archived project" }))).toBe(
      "/settings/design-systems",
    );
  });
});

describe("missing folders", () => {
  const problems = [
    { ownerLabel: "Gone app", detail: "The folder /Users/me/gone is missing." },
    { ownerLabel: "Old app", detail: "The folder is missing." },
    { ownerLabel: "Web app", detail: "d1: The file is not valid JSON." },
  ];
  const projects: {
    id: ProjectId;
    title: string;
    workspaceRoot?: string;
    unavailable?: string;
  }[] = [
    { id: "gone" as ProjectId, title: "Gone app" },
    { id: "old" as ProjectId, title: "Old app", workspaceRoot: "/Users/me/old" },
    { id: "web" as ProjectId, title: "Web app" },
  ];

  it("reads the folder a problem names", () => {
    expect(missingFolderOf("The folder /a b/c is missing.")).toBe("/a b/c");
    expect(missingFolderOf("The folder is missing.")).toBe("");
    expect(missingFolderOf("d1: The file is not valid JSON.")).toBeNull();
  });

  it("finds each project whose folder is gone, with its path", () => {
    expect([...missingFolderProjects(problems, projects)]).toEqual([
      ["gone", "/Users/me/gone"],
      ["old", "/Users/me/old"],
    ]);
    expect(withoutMissingFolders(projects, problems).map((p) => p.id)).toEqual(["web"]);
    expect(
      withMissingFolders(projects, new Set(["gone" as ProjectId])).map((p) => p.unavailable),
    ).toEqual(["Folder missing", undefined, undefined]);
  });

  it("keeps a project board to its own problems", () => {
    expect(
      problemsInScope(problems, { kind: "project", projectId: "web" as ProjectId }, "Web app"),
    ).toEqual([problems[2]]);
    expect(problemsInScope(problems, { kind: "all" }, "All")).toHaveLength(3);
    expect(
      problemsInScope(
        [...problems, { ownerLabel: "Playground", detail: "x" }],
        { kind: "playground" },
        "Playground",
      ),
    ).toEqual([{ ownerLabel: "Playground", detail: "x" }]);
  });

  it("says why a board makes nothing new", () => {
    expect(creationOffReason(project("web"))).toBeNull();
    expect(
      creationOffReason(project("Old", { unavailable: "Archived project, not available here" })),
    ).toBe("Old is archived, so new designs are off. Restore it to add designs here.");
    expect(
      creationOffReason(project("Bot", { unavailable: "Automated project, not available here" })),
    ).toBe("Bot is an automated project, so new designs are off here.");
    expect(
      creationOffReason({
        ...project("Gone"),
        unavailable: "Folder missing",
        missingFolder: "/Users/me/gone",
      }),
    ).toBe("Gone: its folder /Users/me/gone is missing. New designs are off until it is back.");
  });
});

describe("problems with an exact owner", () => {
  const app = { id: "p-app" as ProjectId, title: "app" };
  const clone = { id: "p-clone" as ProjectId, title: "app" };
  const gone = {
    ownerLabel: "app",
    detail: "The folder /work/app-clone is missing.",
    owner: { kind: "project" as const, projectId: clone.id },
  };

  it("marks only the project the server names when titles repeat", () => {
    expect([...missingFolderProjects([gone], [app, clone]).keys()]).toEqual([clone.id]);
    expect(problemsInScope([gone], { kind: "project", projectId: app.id }, "app")).toEqual([]);
    expect(problemsInScope([gone], { kind: "project", projectId: clone.id }, "app")).toEqual([
      gone,
    ]);
  });

  it("keys problems by project id, so same-titled clones never collide", () => {
    const twin = { ...gone, owner: { kind: "project" as const, projectId: app.id } };
    expect(problemKey(gone)).not.toBe(problemKey(twin));
  });

  it("falls back to the title for servers that send only the label", () => {
    const { owner: _owner, ...legacy } = gone;
    expect(problemIsAbout(legacy, app)).toBe(true);
    expect(problemsInScope([legacy], { kind: "playground" }, "Playground")).toEqual([]);
  });
});
