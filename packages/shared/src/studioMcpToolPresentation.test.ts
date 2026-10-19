import { describe, expect, it } from "vite-plus/test";

import {
  STUDIO_MCP_TOOL_NAMES,
  resolveStudioMcpToolPresentation,
} from "./studioMcpToolPresentation.ts";

describe("resolveStudioMcpToolPresentation", () => {
  it("recognizes every SpecWithCode tool across provider prefixes and completion suffixes", () => {
    for (const tool of STUDIO_MCP_TOOL_NAMES) {
      const presentation = resolveStudioMcpToolPresentation(tool);
      for (const prefix of [
        "mcp__studio-code__",
        "mcp__studio_code__",
        "mcp__studio__",
        "mcp__studiocode__",
        "Studio-code.",
        "studio_code/",
        "studio:",
        "studiocode:",
        "mcp_studio-code_",
        "Studio Code ",
        "SpecWeave Studio ",
        "studio-code · ",
      ]) {
        expect(resolveStudioMcpToolPresentation(`${prefix}${tool} completed`), tool).toEqual(
          presentation,
        );
      }
      expect(resolveStudioMcpToolPresentation(`mcp__another-server__${tool}`), tool).toBeNull();
    }
  });
  it("pretty prints Claude and Cursor SpecWithCode MCP tool names", () => {
    expect(resolveStudioMcpToolPresentation("mcp__studio-code__studio_thread_read")).toEqual({
      displayName: "Read a SpecWithCode thread",
      logo: "studio-code",
    });
  });

  it("pretty prints Codex SpecWithCode MCP tool names", () => {
    expect(resolveStudioMcpToolPresentation("studio-code.create_threads")).toEqual({
      displayName: "Create SpecWithCode threads",
      logo: "studio-code",
    });
  });

  it("pretty prints thread metadata updates", () => {
    expect(resolveStudioMcpToolPresentation("mcp__studio-code__studio_thread_update")).toEqual({
      displayName: "Update SpecWithCode thread metadata",
      logo: "studio-code",
    });
  });

  it("pretty prints bare SpecWithCode MCP toolkit names", () => {
    expect(resolveStudioMcpToolPresentation("list_scheduled_tasks")).toEqual({
      displayName: "List scheduled tasks",
      logo: "studio-code",
    });
  });

  it("pretty prints worktree SpecWithCode MCP tool names", () => {
    expect(resolveStudioMcpToolPresentation("mcp__studio-code__studio_worktree_handoff")).toEqual({
      displayName: "Hand off thread to a git worktree",
      logo: "studio-code",
    });
    expect(resolveStudioMcpToolPresentation("studio-code.studio_worktree_status")).toEqual({
      displayName: "Get thread worktree status",
      logo: "studio-code",
    });
  });

  it("pretty prints preview SpecWithCode MCP tool names", () => {
    expect(resolveStudioMcpToolPresentation("Studio-code.preview_open")).toEqual({
      displayName: "Open a page in the preview browser",
      logo: "studio-code",
    });
    expect(resolveStudioMcpToolPresentation("mcp__studio-code__preview_status")).toEqual({
      displayName: "Get preview browser status",
      logo: "studio-code",
    });
  });

  it("pretty prints the Chrome extension tools", () => {
    expect(resolveStudioMcpToolPresentation("studio-code.chrome_open")).toEqual({
      displayName: "Open a tab in Chrome",
      logo: "studio-code",
    });
    expect(resolveStudioMcpToolPresentation("mcp__studio-code__chrome_snapshot")).toEqual({
      displayName: "Read a Chrome tab",
      logo: "studio-code",
    });
  });

  it("matches the separator variants ACP registry agents emit", () => {
    for (const name of [
      "mcp_studio-code_delegate_task",
      "studio_code:delegate_task",
      "studio/delegate_task",
      "studiocode/delegate_task",
      "studio-code delegate_task",
      "Studio Code delegate_task",
      "SpecWeave Studio delegate_task",
      "studio-code__delegate_task",
    ]) {
      expect(resolveStudioMcpToolPresentation(name)?.displayName).toBe("Delegate a child task");
    }
  });

  it("matches OpenCode 2's per-thread server names, whose thread ids hold underscores", () => {
    expect(
      resolveStudioMcpToolPresentation("studio-code-thread_opencode2-adapter_delegate_task")
        ?.displayName,
    ).toBe("Delegate a child task");
    expect(
      resolveStudioMcpToolPresentation("studio-code-thread_opencode2-adapter_not_a_tool"),
    ).toBeNull();
  });

  it("keeps unknown MCP tools on the generic renderer path", () => {
    expect(resolveStudioMcpToolPresentation("mcp__github__search_issues")).toBeNull();
    expect(resolveStudioMcpToolPresentation("studio-code.not_a_real_tool")).toBeNull();
  });
});
