import { describe, expect, it } from "vite-plus/test";
import { memoryArchivePath, memoryFileRows, memoryGroupCounts, memoryLabel } from "./ProjectMemory";

const file = (name: string, updatedAt = "2026-10-10T00:00:00Z", revision = 1) => ({
  name,
  revision,
  updatedAt,
  byteLength: 10,
});

describe("project memory names", () => {
  it("turns stored filenames into readable titles and groups", () => {
    expect(memoryLabel("MEMORY.md")).toEqual({ group: "index", title: "Memory index" });
    expect(memoryLabel("MEMORY.claude-project.md")).toEqual({
      group: "index",
      title: "Imported index",
      owner: "claude-project",
    });
    expect(memoryLabel("agent-memory.sw-sw-closer.reference_build_and_deploy_traps.md")).toEqual({
      group: "agents",
      title: "Build and deploy traps",
      owner: "sw:closer",
    });
    expect(memoryLabel("agent-memory.sw-sw-pm.MEMORY.md")).toEqual({
      group: "agents",
      title: "Memory index",
      owner: "sw:pm",
    });
    expect(memoryLabel("skill-memory.docs-writer.md")).toEqual({
      group: "skills",
      title: "Docs writer",
    });
    expect(memoryLabel("project_0997_staff_own_dues_merged_2026_10_27.md")).toEqual({
      group: "projects",
      title: "0997 staff own dues merged",
      date: "2026-10-27",
    });
    expect(memoryLabel("feedback_social_timing.md").group).toBe("feedback");
    expect(memoryLabel("project_.md")).toEqual({ group: "projects", title: "project_" });
    expect(memoryLabel("ai-assistant-state.md")).toEqual({
      group: "other",
      title: "Ai assistant state",
    });
  });

  it("filters by group and title, orders by recent update, and keeps MEMORY.md first", () => {
    const files = [
      file("MEMORY.md", "2026-10-01T00:00:00Z"),
      file("project_alpha.md", "2026-10-05T00:00:00Z"),
      file("project_beta.md", "2026-10-20T00:00:00Z"),
      file("reference_traps.md", "2026-10-28T00:00:00Z"),
    ];
    expect(memoryFileRows(files, "", { sort: "recent" }).map((f) => f.name)).toEqual([
      "MEMORY.md",
      "reference_traps.md",
      "project_beta.md",
      "project_alpha.md",
    ]);
    expect(memoryFileRows(files, "", { group: "projects" }).map((f) => f.name)).toEqual([
      "project_alpha.md",
      "project_beta.md",
    ]);
    expect(memoryFileRows(files, "Traps").map((f) => f.name)).toEqual(["reference_traps.md"]);
    expect(memoryGroupCounts(files)).toEqual([
      ["index", 1],
      ["projects", 2],
      ["references", 1],
    ]);
    expect(memoryArchivePath("project_alpha.md")).toBe("projects/project_alpha.md");
  });
});
