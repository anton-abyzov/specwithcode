import { describe, expect, it } from "vite-plus/test";
import { resolveTimelineToolPresentation } from "./MessagesTimeline.logic";

describe("resolveTimelineToolPresentation", () => {
  it("pretty prints Claude and Cursor SpecWithCode MCP tool names", () => {
    expect(resolveTimelineToolPresentation("mcp__studio-code__studio_thread_read")).toEqual({
      displayName: "Read a SpecWithCode thread",
      logo: "studio-code",
    });
  });

  it("pretty prints Codex SpecWithCode MCP tool names", () => {
    expect(resolveTimelineToolPresentation("studio-code.create_threads")).toEqual({
      displayName: "Create SpecWithCode threads",
      logo: "studio-code",
    });
  });

  it("pretty prints bare SpecWithCode MCP toolkit names", () => {
    expect(resolveTimelineToolPresentation("list_scheduled_tasks")).toEqual({
      displayName: "List scheduled tasks",
      logo: "studio-code",
    });
  });

  it("keeps unknown MCP tools on the generic renderer path", () => {
    expect(resolveTimelineToolPresentation("mcp__github__search_issues")).toBeNull();
    // Native toolkit registers studio_project_list; this branding prefix is not an alias.
    expect(resolveTimelineToolPresentation("Studio-code.specweave-studio_project_list")).toBeNull();
  });
});
