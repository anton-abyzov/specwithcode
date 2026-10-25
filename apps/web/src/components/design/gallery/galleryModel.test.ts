import type { DesignSummary } from "@specweave-studio/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  availableCreationKinds,
  editedAgo,
  filterDesigns,
  gallerySearchFor,
  groupByOwner,
  newDesignPresetFromSearch,
  ownerChips,
  parseDesignGallerySearch,
  resolveScope,
  scopeLabel,
  searchForScope,
  showsSections,
  withoutNewDesignSearch,
  type GalleryScope,
} from "./galleryModel";

const NOW = Date.parse("2026-10-20T15:00:00Z");
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();

function summary(
  id: string,
  title: string,
  owner: DesignSummary["ref"]["owner"],
  minutes: number,
  ownerLabel = owner.kind === "playground" ? "Playground" : String(owner.projectId),
): DesignSummary {
  return {
    ref: { owner, designId: id, path: `.specweave/design/${id}/design.json` },
    kind: "design",
    title,
    revision: 1,
    updatedAt: ago(minutes),
    pageCount: 1,
    designSystem: null,
    ownerLabel,
  } as DesignSummary;
}

const pg = { kind: "playground", environmentId: "host" } as never;
const web = { kind: "project", environmentId: "host", projectId: "web" } as never;
const api = { kind: "project", environmentId: "host", projectId: "api" } as never;
const designs = [
  summary("d1", "Pricing page", web, 30, "Web app"),
  summary("d2", "Moodboard", pg, 2),
  summary("d3", "Status emails", api, 600, "API"),
];

const ALL: GalleryScope = { kind: "all" };
const ids = (list: readonly DesignSummary[]) => list.map((design) => design.ref.designId);

describe("filterDesigns", () => {
  it("lists every owner newest first on All", () => {
    expect(ids(filterDesigns(designs, { scope: ALL, query: "" }))).toEqual(["d2", "d1", "d3"]);
  });

  it("scopes to the Playground, every project, or one project", () => {
    expect(ids(filterDesigns(designs, { scope: { kind: "playground" }, query: "" }))).toEqual([
      "d2",
    ]);
    expect(ids(filterDesigns(designs, { scope: { kind: "projects" }, query: "" }))).toEqual([
      "d1",
      "d3",
    ]);
    expect(
      ids(
        filterDesigns(designs, {
          scope: { kind: "project", projectId: "api" as never },
          query: "",
        }),
      ),
    ).toEqual(["d3"]);
  });

  it("searches titles and owner labels inside the scope", () => {
    expect(ids(filterDesigns(designs, { scope: ALL, query: "web" }))).toEqual(["d1"]);
    expect(filterDesigns(designs, { scope: ALL, query: "nothing" })).toEqual([]);
    expect(
      filterDesigns(designs, {
        scope: { kind: "project", projectId: "api" as never },
        query: "pricing",
      }),
    ).toEqual([]);
  });
});

describe("owner chips and sections", () => {
  const projects = [
    { id: "web", title: "Web app" },
    { id: "api", title: "API" },
  ] as never as { id: never; title: string }[];
  const more = [...designs, summary("d4", "Errors", api, 1, "API")];

  it("counts the Playground and orders projects by their latest edit", () => {
    const chips = ownerChips(more, projects);
    expect(chips.playground).toBe(1);
    expect(chips.projects.map((chip) => [chip.label, chip.count])).toEqual([
      ["API", 2],
      ["Web app", 1],
    ]);
  });

  it("leaves out projects with no designs", () => {
    const chips = ownerChips([designs[1]!], projects);
    expect(chips.projects).toEqual([]);
  });

  it("groups by project, newest project first, Playground last", () => {
    const sections = groupByOwner(more, projects);
    expect(sections.map((section) => section.label)).toEqual(["API", "Web app", "Playground"]);
    expect(ids(sections[0]!.designs)).toEqual(["d4", "d3"]);
  });

  it("shows sections only on All with two or more owners, unless Recent is chosen", () => {
    expect(showsSections(ALL, "project", 2)).toBe(true);
    expect(showsSections(ALL, "project", 1)).toBe(false);
    expect(showsSections(ALL, "recent", 3)).toBe(false);
    expect(showsSections({ kind: "playground" }, "project", 3)).toBe(false);
  });

  it("names the scope from the window's projects, then the server's label", () => {
    expect(scopeLabel({ kind: "project", projectId: "web" as never }, projects)).toBe("Web app");
    expect(scopeLabel({ kind: "project", projectId: "gone" as never }, projects, designs)).toBe(
      "Project",
    );
    expect(scopeLabel({ kind: "playground" }, projects)).toBe("Playground");
  });
});

describe("editedAgo", () => {
  it("reads like a person says it", () => {
    expect(editedAgo(ago(0.2), NOW)).toBe("Edited just now");
    expect(editedAgo(ago(4), NOW)).toBe("Edited 4 min ago");
    expect(editedAgo(ago(180), NOW)).toBe("Edited 3 h ago");
    expect(editedAgo(ago(60 * 30), NOW)).toBe("Edited yesterday");
    expect(editedAgo(ago(60 * 24 * 3), NOW)).toBe("Edited 3 days ago");
    expect(editedAgo("not a date", NOW)).toBe("Edited");
  });
});

describe("availableCreationKinds", () => {
  it("offers only kinds that work in this build", () => {
    expect(availableCreationKinds()).toEqual([
      "slides",
      "design",
      "design-from-code",
      "design-system",
    ]);
    expect(availableCreationKinds({ slides: false, designSystems: false })).toEqual([
      "design",
      "design-from-code",
    ]);
    expect(availableCreationKinds({ slides: true, designSystems: true })).toEqual([
      "slides",
      "design",
      "design-from-code",
      "design-system",
    ]);
  });
});

describe("the /design URL filter", () => {
  const projects = [{ id: "web" }, { id: "api" }] as never as { id: never }[];

  it("keeps known params and drops malformed ones", () => {
    expect(
      parseDesignGallerySearch({
        tab: "playground",
        project: " web ",
        new: "design",
        system: "weave",
        owner: "playground",
      }),
    ).toEqual({
      tab: "playground",
      project: "web",
      new: "design",
      system: "weave",
      owner: "playground",
    });
    expect(
      parseDesignGallerySearch({
        tab: "nope",
        project: 3,
        new: "slides",
        system: "../x",
        owner: "",
      }),
    ).toEqual({});
  });

  it("keeps a grouping choice", () => {
    expect(parseDesignGallerySearch({ group: "recent" })).toEqual({ group: "recent" });
    expect(parseDesignGallerySearch({ group: "owner" })).toEqual({});
  });

  it("?project= names one project on any tab, so old links still work", () => {
    const easy = { kind: "project", projectId: "api" };
    expect(resolveScope({ project: "api" as never })).toEqual(easy);
    expect(resolveScope({ tab: "projects", project: "api" as never })).toEqual(easy);
    expect(resolveScope({ tab: "playground", project: "api" as never })).toEqual(easy);
    expect(resolveScope({ tab: "all", project: "api" as never })).toEqual(easy);
  });

  it("?tab= alone keeps its meaning", () => {
    expect(resolveScope({})).toEqual({ kind: "all" });
    expect(resolveScope({ tab: "playground" })).toEqual({ kind: "playground" });
    expect(resolveScope({ tab: "projects" })).toEqual({ kind: "projects" });
  });

  it("round-trips a scope and keeps the grouping", () => {
    for (const scope of [
      { kind: "all" },
      { kind: "playground" },
      { kind: "projects" },
      { kind: "project", projectId: "web" },
    ] as GalleryScope[])
      expect(resolveScope(searchForScope(scope))).toEqual(scope);
    expect(searchForScope({ kind: "all" })).toEqual({});
    expect(searchForScope({ kind: "all" }, "recent")).toEqual({ group: "recent" });
    expect(gallerySearchFor({ tab: "projects", projectId: "web" as never })).toEqual({
      project: "web",
    });
    expect(gallerySearchFor({ tab: "projects", projectId: null })).toEqual({ tab: "projects" });
  });

  it("?new=design preselects a known owner and the system, once", () => {
    const search = { new: "design", owner: "api", system: "weave", tab: "projects" } as const;
    expect(newDesignPresetFromSearch(search as never, projects)).toEqual({
      owner: { kind: "project", projectId: "api" },
      systemId: "weave",
    });
    expect(newDesignPresetFromSearch({ new: "design", owner: "gone" }, projects)).toEqual({
      owner: { kind: "playground" },
      systemId: null,
    });
    expect(newDesignPresetFromSearch({ owner: "api" }, projects)).toBeNull();
    expect(withoutNewDesignSearch(search as never)).toEqual({ tab: "projects" });
  });
});
