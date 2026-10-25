import type { DesignSummary } from "@specweave-studio/contracts";
import { describe, expect, it } from "vite-plus/test";

import { pagesLabel } from "../studio/shell/ProjectDesignsPane";
import { projectDesignsView } from "./useProjectDesigns";

const owner = { kind: "project", environmentId: "host", projectId: "easychamp" } as never;
const summary = (id: string, updatedAt: string, threadId?: string): DesignSummary =>
  ({
    ref: { owner, designId: id, path: `.specweave/design/${id}/design.json` },
    kind: "design",
    title: id,
    revision: 1,
    updatedAt,
    pageCount: 1,
    designSystem: null,
    ownerLabel: "EasyChamp",
    ...(threadId ? { thread: { environmentId: "host", threadId } } : {}),
  }) as unknown as DesignSummary;

describe("projectDesignsView", () => {
  it("is empty before the list arrives", () => {
    const view = projectDesignsView(null);
    expect(view.designs).toEqual([]);
    expect(view.byThreadId.size).toBe(0);
  });
  it("sorts newest first and indexes bound threads by the newest design", () => {
    const view = projectDesignsView({
      designs: [
        summary("old", "2026-10-01T10:00:00Z", "t1"),
        summary("new", "2026-10-21T10:00:00Z", "t1"),
        summary("free", "2026-10-10T10:00:00Z"),
      ],
      problems: [],
    });
    expect(view.designs.map((design) => design.ref.designId)).toEqual(["new", "free", "old"]);
    expect(view.byThreadId.get("t1")?.ref.designId).toBe("new");
    expect(view.byThreadId.size).toBe(1);
  });
});

describe("pagesLabel", () => {
  it("counts pages, or slides for a deck", () => {
    expect(pagesLabel({ kind: "design", pageCount: 1 })).toBe("1 page");
    expect(pagesLabel({ kind: "design", pageCount: 3 })).toBe("3 pages");
    expect(pagesLabel({ kind: "slides", pageCount: 12 })).toBe("12 slides");
  });
});
