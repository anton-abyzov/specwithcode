import type { DesignSummary } from "@specweave-studio/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  availableCreationKinds,
  editedAgo,
  filterDesigns,
  galleryFilterFromSearch,
  gallerySearchFor,
  newDesignPresetFromSearch,
  parseDesignGallerySearch,
  withoutNewDesignSearch,
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

describe("filterDesigns", () => {
  it("lists every owner newest first on All", () => {
    const shown = filterDesigns(designs, { tab: "all", projectId: null, query: "" });
    expect(shown.map((design) => design.ref.designId)).toEqual(["d2", "d1", "d3"]);
  });

  it("splits Playground and Projects and filters one project", () => {
    expect(
      filterDesigns(designs, { tab: "playground", projectId: null, query: "" }).map(
        (design) => design.ref.designId,
      ),
    ).toEqual(["d2"]);
    expect(
      filterDesigns(designs, { tab: "projects", projectId: null, query: "" }).map(
        (design) => design.ref.designId,
      ),
    ).toEqual(["d1", "d3"]);
    expect(
      filterDesigns(designs, { tab: "projects", projectId: "api" as never, query: "" }).map(
        (design) => design.ref.designId,
      ),
    ).toEqual(["d3"]);
  });

  it("searches titles and owner labels", () => {
    expect(
      filterDesigns(designs, { tab: "all", projectId: null, query: "web" }).map(
        (design) => design.ref.designId,
      ),
    ).toEqual(["d1"]);
    expect(filterDesigns(designs, { tab: "all", projectId: null, query: "nothing" })).toEqual([]);
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

  it("?project= implies the Projects tab", () => {
    expect(galleryFilterFromSearch({ project: "api" as never }, projects)).toEqual({
      tab: "projects",
      projectId: "api",
    });
    expect(galleryFilterFromSearch({ tab: "all", project: "api" as never }, projects).tab).toBe(
      "projects",
    );
  });

  it("an unknown project falls back to all projects", () => {
    expect(galleryFilterFromSearch({ project: "gone" as never }, projects)).toEqual({
      tab: "projects",
      projectId: null,
    });
  });

  it("defaults to All and round-trips a filter", () => {
    expect(galleryFilterFromSearch({}, projects)).toEqual({ tab: "all", projectId: null });
    expect(gallerySearchFor({ tab: "all", projectId: null })).toEqual({});
    expect(gallerySearchFor({ tab: "playground", projectId: null })).toEqual({ tab: "playground" });
    expect(gallerySearchFor({ tab: "projects", projectId: null })).toEqual({ tab: "projects" });
    expect(gallerySearchFor({ tab: "projects", projectId: "web" as never })).toEqual({
      project: "web",
    });
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
