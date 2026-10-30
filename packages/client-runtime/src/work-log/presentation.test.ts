import { describe, expect, it } from "vite-plus/test";

import {
  CheckpointRef,
  NodeId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2Subagent,
  type OrchestrationV2TurnItem,
} from "@specweave-studio/contracts";
import * as DateTime from "effect/DateTime";
import { STUDIO_MCP_TOOL_NAMES } from "@specweave-studio/shared/studioMcpToolPresentation";

import type { ThreadCheckpointSummary } from "../state/threadCheckpoints.ts";
import {
  commandDetailRepeatsCommand,
  extractCommandOutputText,
  fileChangeItemPaths,
  filesChangedOutsideEditItems,
  matchDiffPath,
  repoRelativePath,
  subagentDiffTarget,
  turnDiffState,
  turnDiffStateMessage,
  workEntryFailureKind,
  resolveViewedImageAsset,
  resolveWorkEntryToolPresentation,
  summarizeToolGroup,
  toolGroupAction,
  toolGroupSummaryKind,
  toolItemForDisplay,
  type WorkLogPresentationEntry,
  type WorkLogToolLifecycleStatus,
  workEntryViewedImagePath,
  workEntryIndicatesToolFailure,
  workEntryDisplayIndicatesToolFailure,
  workEntryIndicatesToolSuccess,
  workEntryComputerUsePermission,
  workEntryReportsChromeDisconnected,
} from "./presentation.js";

function commandItem(
  fields: Partial<Extract<OrchestrationV2TurnItem, { type: "command_execution" }>> = {},
): OrchestrationV2TurnItem {
  return {
    id: TurnItemId.make("command"),
    threadId: ThreadId.make("thread"),
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 1,
    status: "completed",
    title: null,
    startedAt: null,
    completedAt: null,
    updatedAt: DateTime.makeUnsafe("2026-09-08T00:00:00.000Z"),
    type: "command_execution",
    input: 'rg "command not found"',
    exitCode: 0,
    ...fields,
  };
}

describe("workEntryIndicatesToolFailure", () => {
  const base = {
    id: "w1",
    createdAt: "2026-01-01T00:00:00.000Z",
    label: "Read",
  };

  it.each([
    [{ outputIndicatesFailure: true }, true],
    [{ exitCode: 2 }, true],
    [{ output: "sh: missing-command: command not found" }, true],
    [{ output: "Found 3 matches" }, false],
    [{ output: `${"x".repeat(32_768)} command not found` }, false],
    [{}, false],
  ] as const)(
    "preserves command failure state after removing displayed output: %j",
    (fields, failed) => {
      const structuredPayload = commandItem(fields);
      const entry: WorkLogPresentationEntry = {
        ...base,
        tone: "tool",
        itemType: "command_execution",
        toolLifecycleStatus: "completed",
        structuredPayload,
      };
      expect(workEntryDisplayIndicatesToolFailure(entry)).toBe(failed);
      expect(workEntryIndicatesToolSuccess(entry)).toBe(!failed);
      expect(JSON.stringify(toolItemForDisplay(structuredPayload))).not.toContain('"output":');
    },
  );

  it("is true for error tone", () => {
    expect(
      workEntryIndicatesToolFailure({
        ...base,
        tone: "error",
        detail: "nothing special",
      }),
    ).toBe(true);
  });

  it("is true when lifecycle says failed even if detail is empty", () => {
    expect(
      workEntryIndicatesToolFailure({
        ...base,
        tone: "tool",
        toolLifecycleStatus: "failed",
      }),
    ).toBe(true);
  });

  it("detects file-not-found style tool output with completed lifecycle", () => {
    expect(
      workEntryIndicatesToolFailure({
        ...base,
        tone: "tool",
        toolLifecycleStatus: "completed",
        detail: "File not found: C:\\foo\\nonexistent.ts",
      }),
    ).toBe(true);
  });

  it("detects glob no files and PowerShell command errors", () => {
    expect(
      workEntryIndicatesToolFailure({
        ...base,
        label: "Glob",
        tone: "tool",
        detail: "No files found",
      }),
    ).toBe(true);
    expect(
      workEntryIndicatesToolFailure({
        ...base,
        label: "Bash",
        tone: "tool",
        detail:
          "The term 'this_is_not_a_command' is not recognized as the name of a cmdlet, function, script file, or operable program.",
      }),
    ).toBe(true);
  });

  it("is false for successful completed tools", () => {
    expect(
      workEntryIndicatesToolFailure({
        ...base,
        tone: "tool",
        toolLifecycleStatus: "completed",
        detail: "Found 3 matching files",
      }),
    ).toBe(false);
  });

  it("does not treat error text in a command as rendered failure", () => {
    const entry = {
      ...base,
      label: "Ran command",
      tone: "tool",
      toolLifecycleStatus: "completed",
      command: 'rg "file not found"',
      detail: "Found 3 matches",
    } satisfies WorkLogPresentationEntry;

    expect(workEntryDisplayIndicatesToolFailure(entry)).toBe(false);
    // Older activities can store output in this field, so that path stays separate.
    expect(workEntryIndicatesToolFailure(entry)).toBe(true);
    expect(workEntryDisplayIndicatesToolFailure({ ...entry, detail: "File not found" })).toBe(true);
  });

  it("treats successful tool rows as success candidates", () => {
    expect(
      workEntryIndicatesToolSuccess({
        ...base,
        tone: "tool",
        toolLifecycleStatus: "completed",
        detail: "ok",
      }),
    ).toBe(true);
    expect(
      workEntryIndicatesToolSuccess({
        ...base,
        tone: "tool",
        toolLifecycleStatus: "inProgress",
        detail: "…",
      }),
    ).toBe(false);
    expect(workEntryIndicatesToolSuccess({ ...base, tone: "thinking", detail: "…" })).toBe(false);
    expect(
      workEntryIndicatesToolSuccess({ ...base, tone: "tool", toolLifecycleStatus: "stopped" }),
    ).toBe(false);
    expect(
      workEntryIndicatesToolSuccess({ ...base, tone: "tool", toolLifecycleStatus: "idle" }),
    ).toBe(false);
  });

  it("does not run heuristics on non-tool info rows", () => {
    expect(
      workEntryIndicatesToolFailure({
        ...base,
        label: "Context compacted",
        tone: "info",
        detail: "File not found in conversation",
      }),
    ).toBe(false);
  });
});

describe("summarizeToolGroup", () => {
  const entry = (
    id: string,
    overrides: Partial<WorkLogPresentationEntry>,
  ): WorkLogPresentationEntry => ({
    id,
    createdAt: "2026-09-01T00:00:00Z",
    label: "Tool call",
    tone: "tool",
    ...overrides,
  });

  it("excludes reasoning from mixed tool counts and icons", () => {
    const thought = entry("thought", {
      itemType: "reasoning",
      tone: "thinking",
      detail: "Check the source",
    });
    const command = entry("command", { itemType: "command_execution", command: "vp test run" });
    expect(summarizeToolGroup([thought, command, { ...thought, id: "thought-2" }])).toEqual({
      summary: "Ran 1 command",
      hasFailure: false,
      failedCount: 0,
      possibleFailureCount: 0,
      declinedCount: 0,
    });
    expect(toolGroupSummaryKind([thought, command])).toBe("command");
    expect(summarizeToolGroup([thought]).summary).toBe("Thought");
    expect(summarizeToolGroup([thought, { ...thought, id: "thought-2" }]).summary).toBe(
      "Thought (×2)",
    );
    expect(toolGroupSummaryKind([thought])).toBe("reasoning");
  });

  it("counts created threads alongside adjacent commands", () => {
    expect(
      summarizeToolGroup([
        entry("command", { itemType: "command_execution", command: "vp test run" }),
        entry("created", {
          itemType: "thread_created",

          label: "Created thread",
        }),
      ]).summary,
    ).toBe("Ran 1 command and created 1 thread");
  });

  it("deduplicates named sources ahead of ordinary actions", () => {
    const source = { key: "browser-use:chrome", name: "Chrome", kind: "integration" as const };
    expect(
      summarizeToolGroup([
        entry("open", { label: "Open page", toolSource: source }),
        entry("inspect", { label: "Inspect page", toolSource: source }),
        entry("command", {
          label: "Ran command",
          itemType: "command_execution",
          command: "git status",
        }),
      ]).summary,
    ).toBe("Used Chrome integration and ran 1 command");
  });

  it("omits the integration suffix for special browser and computer sources", () => {
    expect(
      summarizeToolGroup([
        entry("inspect", {
          label: "Inspect page",
          toolSource: { key: "browser-use", name: "Browser", kind: "browser" },
        }),
        entry("click", {
          label: "Click",
          toolSource: { key: "computer-use", name: "Computer Use", kind: "computer" },
        }),
      ]).summary,
    ).toBe("Used Browser and Computer Use");
  });
});

describe("resolveWorkEntryToolPresentation", () => {
  it("presents and summarizes every SpecWithCode tool using the same structured identity", () => {
    for (const tool of STUDIO_MCP_TOOL_NAMES) {
      const entry: WorkLogPresentationEntry = {
        id: tool,
        createdAt: "2026-09-19T00:00:00.000Z",
        tone: "tool",
        label: "Custom provider title",
        toolData: { server: "studio-code", tool },
        toolLifecycleStatus: "completed",
        itemType: "dynamic_tool",
        toolSource: { key: "studio-code", name: "SpecWithCode", kind: "integration" },
      };
      const presentation = resolveWorkEntryToolPresentation(entry);
      expect(presentation, tool).not.toBeNull();
      expect(presentation?.displayName, tool).not.toContain(tool);
      const summary = summarizeToolGroup([entry]);
      expect(summary.summary, tool).not.toMatch(/Used (?:1 tool|SpecWithCode integration)/);
      expect(summary.hasFailure, tool).toBe(false);
      const failed = { ...entry, toolLifecycleStatus: "failed" as const };
      expect(resolveWorkEntryToolPresentation(failed)?.displayName, tool).toMatch(/^Failed to /);
      expect(summarizeToolGroup([failed]).hasFailure, tool).toBe(true);
      expect(summarizeToolGroup([failed]).summary, tool).toMatch(
        /^(?:Tried to |Requested thread creation)/,
      );
    }
  });

  it.each([
    ["studio_project_list", "Listing projects", "Listed projects"],
    ["studio_project_clone", "Cloning a repository", "Cloned a repository"],
    ["studio_project_create", "Registering a project", "Registered a project"],
    ["studio_thread_launch", "Launching a project thread", "Launched a project thread"],
    ["studio_queue_edit", "Editing a queued message", "Edited a queued message"],
    ["studio_pending_request_respond", "Answering pending questions", "Answered pending questions"],
    ["studio_thread_configure", "Setting thread model", "Set thread model"],
    ["studio_thread_fork", "Forking this thread", "Requested a fork of this thread"],
    ["studio_thread_send_attachments", "Sending attachments", "Sent attachments"],
    ["run_scheduled_task_now", "Running a routine", "Requested a run of a routine"],
  ])("labels %s through its lifecycle", (tool, running, completed) => {
    expect(resolveWorkEntryToolPresentation({ label: `Studio-code.${tool}` })?.displayName).toBe(
      running,
    );
    expect(
      resolveWorkEntryToolPresentation({
        label: `Studio-code.${tool}`,
        toolLifecycleStatus: "completed",
      })?.displayName,
    ).toBe(completed);
  });

  it("summarizes project tools from MCP arguments and results without claiming failed effects", () => {
    const entry: WorkLogPresentationEntry = {
      id: "clone",
      createdAt: "2026-09-19T00:00:00.000Z",
      tone: "tool",
      label: "Custom title",
      itemType: "dynamic_tool",
      toolLifecycleStatus: "completed",
      toolData: {
        server: "studio-code",
        tool: "studio_project_clone",
        arguments: { url: "https://github.com/acme/repo" },
        result: { cwd: "/tmp/repo" },
      },
    };
    const list = { ...entry, toolData: { server: "studio-code", tool: "studio_project_list" } };
    expect(summarizeToolGroup([list, entry])).toMatchObject({
      summary: "Listed projects 1 time and cloned 1 repository",
      hasFailure: false,
    });
    const failed = {
      ...entry,
      toolData: { toolName: "Studio-code.studio_project_clone", rawOutput: { isError: true } },
    };
    expect(summarizeToolGroup([entry, failed])).toMatchObject({
      summary: "Cloned 1 repository",
      hasFailure: true,
      failedCount: 1,
    });
  });

  it("does not summarize a foreign structured identity as SpecWithCode work", () => {
    const entry: WorkLogPresentationEntry = {
      id: "foreign",
      createdAt: "2026-09-19T00:00:00.000Z",
      tone: "tool",
      label: "studio_project_clone",
      toolLifecycleStatus: "completed",
      toolData: { server: "another-server", tool: "studio_project_clone" },
    };
    expect(summarizeToolGroup([entry]).summary).toBe("Used 1 tool");
  });

  it("shows returned MCP errors as failures even in the live activity row", () => {
    const entry: WorkLogPresentationEntry = {
      id: "clone",
      createdAt: "2026-09-19T00:00:00.000Z",
      tone: "tool",
      label: "Studio-code.studio_project_clone",
      toolLifecycleStatus: "inProgress",
      itemType: "dynamic_tool",
      toolData: { output: { isError: true } },
    };
    expect(resolveWorkEntryToolPresentation(entry)?.displayName).toBe(
      "Failed to clone a repository",
    );
    expect(workEntryDisplayIndicatesToolFailure(entry)).toBe(true);
    expect(workEntryIndicatesToolSuccess(entry)).toBe(false);
    const childFailure = {
      ...entry,
      label: "Studio-code.task_status",
      toolLifecycleStatus: "completed" as const,
      toolData: { output: { taskId: "child", status: "failed", summary: "command not found" } },
    };
    expect(workEntryDisplayIndicatesToolFailure(childFailure)).toBe(false);
    expect(workEntryIndicatesToolSuccess(childFailure)).toBe(true);
  });
  it.each([
    "mcp__studio-code__preview_click",
    "mcp__studio_code__preview_click",
    "mcp__studio__preview_click",
    "Studio-code.preview_click",
    "studio-code · preview_click completed",
    "studio_code/preview_click",
    "preview_click",
  ])("recognizes browser tool names across providers: %s", (label) => {
    expect(resolveWorkEntryToolPresentation({ label })).toEqual({
      displayName: "Clicking in the preview browser",
      icon: "browser",
    });
  });

  it("labels device tools with the device icon", () => {
    expect(
      resolveWorkEntryToolPresentation({
        label: "mcp__studio-code__device_open",
        toolLifecycleStatus: "completed",
      }),
    ).toEqual({ displayName: "Opened a device in the Device panel", icon: "device" });
    expect(resolveWorkEntryToolPresentation({ label: "studio-code · device_screenshot" })).toEqual({
      displayName: "Taking a screenshot of the device",
      icon: "device",
    });
  });

  it("uses structured MCP identity when the provider supplies a custom title", () => {
    expect(
      resolveWorkEntryToolPresentation({
        label: "Tool call complete",
        toolTitle: "Inspect the current page",
        toolData: { server: "studio-code", tool: "preview_snapshot", result: { title: "Example" } },
      }),
    ).toEqual({ displayName: "Taking a snapshot of the preview page", icon: "browser" });
  });

  it.each([
    ["inProgress", "Clicking in the preview browser"],
    ["completed", "Clicked in the preview browser"],
    ["failed", "Failed to click in the preview browser"],
    ["declined", "Declined to click in the preview browser"],
    ["stopped", "Stopped clicking in the preview browser"],
    ["unknown", "Clicking in the preview browser"],
  ] as const)("describes the tool's own %s state", (toolLifecycleStatus, displayName) => {
    expect(
      resolveWorkEntryToolPresentation({
        label: "Studio-code.preview_click",
        toolLifecycleStatus: toolLifecycleStatus as WorkLogToolLifecycleStatus,
      }),
    ).toEqual({ displayName, icon: "browser" });
  });

  it("uses the summary's state only when the provider omitted a lifecycle status", () => {
    const entry = { label: "Studio-code.preview_click" };
    expect(resolveWorkEntryToolPresentation(entry, "inProgress")?.displayName).toBe(
      "Clicking in the preview browser",
    );
    expect(resolveWorkEntryToolPresentation(entry, "completed")?.displayName).toBe(
      "Clicked in the preview browser",
    );
    expect(
      resolveWorkEntryToolPresentation({ ...entry, toolLifecycleStatus: "completed" }, "inProgress")
        ?.displayName,
    ).toBe("Clicked in the preview browser");
    expect(
      resolveWorkEntryToolPresentation({ ...entry, toolLifecycleStatus: "failed" }, "completed")
        ?.displayName,
    ).toBe("Failed to click in the preview browser");
  });

  it.each([
    ["preview_type", "Typing in the preview browser", "Typed in the preview browser"],
    [
      "preview_set_appearance",
      "Setting preview browser appearance",
      "Set preview browser appearance",
    ],
    [
      "preview_snapshot",
      "Taking a snapshot of the preview page",
      "Took a snapshot of the preview page",
    ],
    [
      "preview_recording_stop",
      "Stopping recording the preview browser",
      "Stopped recording the preview browser",
    ],
    ["studio_thread_read", "Reading a SpecWithCode thread", "Read a SpecWithCode thread"],
    ["studio_thread_send", "Sending to a SpecWithCode thread", "Sent to a SpecWithCode thread"],
    [
      "studio_worktree_handoff",
      "Handing off thread to a git worktree",
      "Handed off thread to a git worktree",
    ],
  ])("preserves verb forms and the rest of %s's label", (tool, running, completed) => {
    const entry = { label: `studio-code.${tool}` };
    expect(
      resolveWorkEntryToolPresentation({ ...entry, toolLifecycleStatus: "inProgress" })
        ?.displayName,
    ).toBe(running);
    expect(
      resolveWorkEntryToolPresentation({ ...entry, toolLifecycleStatus: "completed" })?.displayName,
    ).toBe(completed);
  });

  it("keeps SpecWithCode branding for non-browser tools and falls back to the original tool label", () => {
    expect(
      resolveWorkEntryToolPresentation({
        label: "mcp__studio_code__task_status",
        toolTitle: "Check the child task",
      }),
    ).toEqual({ displayName: "Getting delegated task status", icon: "studio-code" });
  });

  it("does not brand unknown tools or another server's matching tool name", () => {
    for (const label of [
      "mcp__github__preview_click",
      "studio-code.unknown_tool",
      "studio-code.toString",
      "Search files",
    ]) {
      expect(resolveWorkEntryToolPresentation({ label })).toBeNull();
    }
    expect(
      resolveWorkEntryToolPresentation({
        label: "preview_click",
        toolData: { server: "another-server", tool: "preview_click" },
      }),
    ).toBeNull();
  });
});

describe("browser group summaries", () => {
  const summarizeGroupLabel = (entries: ReadonlyArray<WorkLogPresentationEntry>) =>
    summarizeToolGroup(entries).summary;
  const browserEntry: WorkLogPresentationEntry = {
    id: "browser",
    createdAt: "2026-09-01T00:00:00Z",
    label: "MCP tool call",
    toolData: { server: "studio-code", tool: "preview_click" },
    itemType: "dynamic_tool",
    toolLifecycleStatus: "completed",
    tone: "tool",
  };
  const commandEntry: WorkLogPresentationEntry = {
    id: "command",
    createdAt: "2026-09-01T00:00:00Z",
    label: "Ran command",
    command: "/bin/bash -lc 'vp test run'",
    itemType: "command_execution",
    toolLifecycleStatus: "completed",
    tone: "tool",
  };

  it.each([1, 18])("counts %s browser calls separately from generic tools", (count) => {
    const entries = Array.from({ length: count }, (_, index) => ({
      ...browserEntry,
      toolCallId: `browser-${index}`,
    }));
    expect(summarizeGroupLabel(entries)).toBe(
      `Used browser ${count} ${count === 1 ? "time" : "times"}`,
    );
    expect(toolGroupSummaryKind(entries)).toBe("browser");
  });

  it("combines command and browser counts in a single sentence", () => {
    const entries = [
      ...Array.from({ length: 4 }, () => commandEntry),
      ...Array.from({ length: 15 }, () => browserEntry),
    ];
    expect(summarizeGroupLabel(entries)).toBe("Ran 4 commands and used browser 15 times");
    expect(toolGroupSummaryKind(entries)).toBe("mixed");
  });

  it("preserves first-seen action ordering alongside non-browser tools", () => {
    expect(
      summarizeGroupLabel([
        browserEntry,
        commandEntry,
        {
          ...browserEntry,
          toolData: { server: "studio-code", tool: "task_status" },
        },
      ]),
    ).toBe("Used browser 1 time, ran 1 command, and performed 1 other action");
  });

  it("recognizes Claude browser identity without treating script metadata as a shell command", () => {
    expect(
      summarizeGroupLabel([
        {
          ...browserEntry,
          command: "node inspect-page.js",
          toolData: { toolName: "mcp__studio_code__preview_evaluate" },
        },
      ]),
    ).toBe("Used browser 1 time");
  });

  it("keeps foreign tools and web searches out of the browser count", () => {
    expect(
      summarizeGroupLabel([
        browserEntry,
        {
          ...browserEntry,
          label: "preview_click",
          toolData: { server: "another-server", tool: "preview_click" },
        },
        {
          id: "search",
          createdAt: "2026-09-01T00:00:00Z",
          label: "Search",
          tone: "tool",
          itemType: "web_search",
        },
      ]),
    ).toBe("Used browser 1 time, searched the web 1 time, and performed 1 other action");
  });

  it("keeps browser screenshots in the browser count while preserving their image path", () => {
    const entry = { ...browserEntry, viewedImagePath: "/workspace/page.png" };
    expect(summarizeGroupLabel([entry])).toBe("Used browser 1 time");
    expect(workEntryViewedImagePath(entry)).toBe("/workspace/page.png");
  });
});

describe("command work-log details", () => {
  it("extracts Claude result blocks and projected output", () => {
    expect(
      extractCommandOutputText({
        result: {
          content: [
            { type: "text", text: "first" },
            { type: "text", text: "second" },
          ],
        },
      }),
    ).toBe("first\nsecond");
    expect(extractCommandOutputText({ rawOutput: { content: "projected summary" } })).toBe(
      "projected summary",
    );
  });

  it("only removes a detail with the matching tool-name prefix", () => {
    expect(
      commandDetailRepeatsCommand({
        detail: "Bash: printf hello",
        command: "printf hello",
        rawCommand: null,
        toolName: "Bash",
        data: { toolName: "Bash", command: "printf hello" },
      }),
    ).toBe(true);
    expect(
      commandDetailRepeatsCommand({
        detail: "warning: printf hello",
        command: "printf hello",
        rawCommand: null,
        toolName: "Bash",
        data: { toolName: "Bash", command: "printf hello" },
      }),
    ).toBe(false);
  });

  it("treats an ingestion-truncated echo of a long command as a repeat", () => {
    const command = `git add -A && git commit -m "${"x".repeat(200)}"`;
    const truncated = `Bash: ${command}`.slice(0, 177) + "...";
    expect(
      commandDetailRepeatsCommand({
        detail: truncated,
        command,
        rawCommand: null,
        toolName: "Bash",
        data: { toolName: "Bash", command },
      }),
    ).toBe(true);
    expect(
      commandDetailRepeatsCommand({
        detail: "Bash: printf hello...",
        command: "printf goodbye",
        rawCommand: null,
        toolName: "Bash",
        data: { toolName: "Bash", command: "printf goodbye" },
      }),
    ).toBe(false);
  });

  it("treats ACP command echoes as synthetic even without a tool kind", () => {
    expect(
      commandDetailRepeatsCommand({
        detail: "pnpm test",
        command: "pnpm test",
        rawCommand: null,
        toolName: undefined,
        data: { toolCallId: "tool-1", command: "pnpm test" },
      }),
    ).toBe(true);
    expect(
      commandDetailRepeatsCommand({
        detail: "pnpm test",
        command: "pnpm test",
        rawCommand: null,
        toolName: undefined,
        data: { command: "pnpm test" },
      }),
    ).toBe(false);
  });
});

describe("workEntryViewedImagePath", () => {
  const entry = {
    id: "entry-1",
    createdAt: "2026-01-01T00:00:00Z",
    label: "Read",
    tone: "tool",
  } as const;

  it("returns a single image path from supported read entries", () => {
    expect(
      workEntryViewedImagePath({ ...entry, requestKind: "file-read", detail: " assets/a.png " }),
    ).toBe("assets/a.png");
    expect(
      workEntryViewedImagePath({
        ...entry,
        itemType: "dynamic_tool",
        toolTitle: "Read file",
        detail: "C:\\workspace\\a.webp",
      }),
    ).toBe("C:\\workspace\\a.webp");
    expect(
      workEntryViewedImagePath({
        ...entry,
        itemType: "dynamic_tool",
        detail: 'Read: {"file_path":"truncated..."}',
        viewedImagePath: " /workspace/reference image.webp ",
      }),
    ).toBe("/workspace/reference image.webp");
  });

  it("rejects non-image, multi-line, and non-read details", () => {
    expect(
      workEntryViewedImagePath({ ...entry, requestKind: "file-read", detail: "a.txt" }),
    ).toBeNull();
    expect(
      workEntryViewedImagePath({ ...entry, requestKind: "file-read", detail: "a.png\nb.png" }),
    ).toBeNull();
    expect(workEntryViewedImagePath({ ...entry, detail: "a.png" })).toBeNull();
  });
});

describe("toolGroupAction", () => {
  it("groups Codex commands by their typed actions, never by shell text", () => {
    const command = (id: string, commandActions: ReadonlyArray<{ type: string }>) =>
      toolGroupAction({
        id,
        createdAt: "2026-09-01T00:00:00Z",
        label: "Ran command",
        tone: "tool",
        itemType: "command_execution",
        command: "rg TODO apps/web",
        toolData: { type: "command_execution", input: "rg TODO apps/web", commandActions },
      });
    expect(command("search", [{ type: "search" }])).toBe("code-search");
    expect(command("list", [{ type: "listFiles" }])).toBe("code-search");
    expect(command("read", [{ type: "read" }])).toBe("read");
    expect(command("mixed", [{ type: "search" }, { type: "unknown" }])).toBe("command");
    expect(command("none", [])).toBe("command");
  });

  it("groups legacy Claude image reads with other reads", () => {
    expect(
      toolGroupAction({
        id: "legacy-read",
        createdAt: "2026-09-01T00:00:00Z",
        label: "Tool call",
        tone: "tool",
        itemType: "dynamic_tool",
        viewedImagePath: "/workspace/reference.png",
      }),
    ).toBe("read");
  });

  it("groups Claude Read and Grep from toolName, not file contents", () => {
    expect(
      toolGroupAction({
        id: "read",
        createdAt: "2026-09-01T00:00:00Z",
        label: "Read",
        tone: "tool",
        itemType: "dynamic_tool",
        toolTitle: "Read",
        toolData: { input: { file_path: "src/env.ts" } },
        structuredPayload: {
          type: "dynamic_tool",
          toolName: "Read",
          input: { file_path: "src/env.ts" },
        } as NonNullable<WorkLogPresentationEntry["structuredPayload"]>,
      }),
    ).toBe("read");
    expect(
      toolGroupAction({
        id: "grep",
        createdAt: "2026-09-01T00:00:00Z",
        label: "Grep",
        tone: "tool",
        itemType: "dynamic_tool",
        toolTitle: "Grep",
        toolData: { input: { pattern: "TODO", path: "apps/web" } },
        structuredPayload: {
          type: "dynamic_tool",
          toolName: "Grep",
          input: { pattern: "TODO", path: "apps/web" },
        } as NonNullable<WorkLogPresentationEntry["structuredPayload"]>,
      }),
    ).toBe("code-search");
  });
});

describe("resolveViewedImageAsset", () => {
  const threadId = ThreadId.make("thread-1");

  it("serves specweave-studio attachment paths in place like any other host path", () => {
    const path =
      "/Users/demo/.specweave-studio/dev/attachments/11111111-1111-4111-8111-111111111111.png";
    expect(resolveViewedImageAsset(path, { threadId, workspaceRoot: "/workspace" })).toEqual({
      resource: { _tag: "media-file", threadId, path },
      alt: "11111111-1111-4111-8111-111111111111.png",
      srcFragment: "",
    });
  });

  it("normalizes workspace image sources", () => {
    expect(
      resolveViewedImageAsset("screens/logo.svg?v=2#mark", {
        threadId,
        workspaceRoot: "/workspace",
      }),
    ).toEqual({
      resource: {
        _tag: "media-file",
        threadId,
        path: "/workspace/screens/logo.svg",
      },
      alt: "logo.svg",
      srcFragment: "#mark",
    });
    expect(resolveViewedImageAsset("https://example.com/logo.png", { threadId })).toBeNull();
  });
});

describe("pull request tool presentation", () => {
  it.each([
    "mcp__studio-code__link_pull_request",
    "mcp__studio_code__link_pull_request",
    "Studio-code · link_pull_request",
    "studio/link_pull_request",
    "link_pull_request",
  ])("recognizes the native linking tool: %s", (label) => {
    const entry: WorkLogPresentationEntry = {
      id: "link",
      createdAt: "2026-09-10T00:00:00.000Z",
      label,
      tone: "tool",
      toolLifecycleStatus: "completed",
    };
    expect(resolveWorkEntryToolPresentation(entry)).toMatchObject({
      displayName: "Linked a pull request",
      icon: "pull-request",
    });
    expect(toolGroupAction(entry)).toBe("link-pr");
  });

  it.each([
    ["inProgress", "Linking PR #42"],
    ["completed", "Linked PR #42"],
    ["failed", "Failed to link PR #42"],
    ["declined", "Declined to link PR #42"],
    ["stopped", "Stopped linking PR #42"],
  ] as const)("describes the target and %s status", (toolLifecycleStatus, displayName) => {
    expect(
      resolveWorkEntryToolPresentation({
        label: "MCP tool call",
        toolTitle: "Custom title",
        toolLifecycleStatus,
        toolData: {
          server: "studio-code",
          tool: "link_pull_request",
          arguments: { url: "https://github.com/acme/web/pull/42" },
        },
      })?.displayName,
    ).toBe(displayName);
  });

  it("recognizes unlink targets supplied as repository and number", () => {
    expect(
      resolveWorkEntryToolPresentation({
        label: "MCP tool call",
        toolLifecycleStatus: "completed",
        toolData: {
          toolName: "mcp__studio-code__unlink_pull_request",
          rawInput: { repository: "acme/web", number: 42 },
        },
      }),
    ).toMatchObject({ displayName: "Unlinked PR #42", icon: "pull-request", action: "unlink-pr" });
  });

  it("summarizes native PR work separately from ordinary tools and integration metadata", () => {
    const link: WorkLogPresentationEntry = {
      id: "link",
      createdAt: "2026-09-10T00:00:00.000Z",
      label: "Studio-code · link_pull_request",
      tone: "tool",
      itemType: "dynamic_tool",
      toolLifecycleStatus: "completed",
      toolSource: { key: "studio-code", name: "SpecWithCode", kind: "integration" },
    };
    const list: WorkLogPresentationEntry = {
      ...link,
      label: "Studio-code · list_thread_pull_requests",
    };
    expect(summarizeToolGroup([link, link, list]).summary).toBe(
      "Linked 2 pull requests and checked linked pull requests",
    );
    expect(
      summarizeToolGroup([{ ...link, label: "Studio-code · unlink_pull_request" }]).summary,
    ).toBe("Unlinked 1 pull request");
    expect(toolGroupSummaryKind([link, link, list])).toBe("pull-request");
    expect(summarizeToolGroup([list, list]).summary).toBe("Checked linked pull requests 2 times");
    expect(
      resolveWorkEntryToolPresentation({ label: "mcp__another-server__link_pull_request" }),
    ).toBeNull();
  });
});

describe("device group summaries", () => {
  const deviceEntry = (tool: string): WorkLogPresentationEntry => ({
    id: tool,
    createdAt: "2026-09-10T00:00:00.000Z",
    label: "MCP tool call",
    toolData: { server: "studio-code", tool },
    itemType: "dynamic_tool",
    toolLifecycleStatus: "completed",
    tone: "tool",
  });

  it.each(["device_list", "device_open", "device_screenshot", "device_close"])(
    "recognizes %s as device controls",
    (tool) => {
      const entry = deviceEntry(tool);
      expect(summarizeToolGroup([entry]).summary).toBe("Used device controls 1 time");
      expect(toolGroupSummaryKind([entry])).toBe("device");
    },
  );

  it("summarizes device calls alongside shell commands", () => {
    expect(
      summarizeToolGroup([
        {
          id: "command",
          createdAt: "2026-09-10T00:00:00.000Z",
          label: "Ran command",
          itemType: "command_execution",
          command: "pwd",
          tone: "tool",
        },
        deviceEntry("device_list"),
        deviceEntry("device_open"),
      ]).summary,
    ).toBe("Ran 1 command and used device controls 2 times");
  });

  it("recognizes Claude tool names and preserves screenshot previews", () => {
    const entry = {
      ...deviceEntry("device_screenshot"),
      toolData: { toolName: "mcp__studio_code__device_screenshot" },
      viewedImagePath: "/workspace/device.png",
    };
    expect(summarizeToolGroup([entry]).summary).toBe("Used device controls 1 time");
    expect(workEntryViewedImagePath(entry)).toBe("/workspace/device.png");
  });

  it("does not classify another server's tools as SpecWithCode device controls", () => {
    expect(
      summarizeToolGroup([
        {
          ...deviceEntry("device_open"),
          toolData: { server: "another-server", tool: "device_open" },
        },
      ]).summary,
    ).toBe("Used 1 tool");
  });
});

describe("workEntryReportsChromeDisconnected", () => {
  const message =
    "Browser extension is not connected. Please ensure the Claude browser extension is installed and running.";

  it("reads the row detail and the tool output", () => {
    expect(workEntryReportsChromeDisconnected({ detail: message })).toBe(true);
    expect(workEntryReportsChromeDisconnected({ toolData: { output: message } })).toBe(true);
    expect(
      workEntryReportsChromeDisconnected({
        toolData: { content: [{ type: "text", text: message }] },
      }),
    ).toBe(true);
  });

  it("reads the SpecWithCode Browser extension's message", () => {
    expect(
      workEntryReportsChromeDisconnected({
        toolData: {
          output:
            'No Chrome profile is connected. "m4-specwithcode" disconnected 3 min ago (2026-10-25T09:00:00.000Z): socket closed. Its extension reconnects on its own; try again in a minute.',
        },
      }),
    ).toBe(true);
  });

  it("ignores other failures", () => {
    expect(workEntryReportsChromeDisconnected({ detail: "Navigation timed out" })).toBe(false);
    expect(workEntryReportsChromeDisconnected({})).toBe(false);
  });
});

describe("workEntryComputerUsePermission", () => {
  it("reads which permission a computer-use failure is missing", () => {
    expect(
      workEntryComputerUsePermission({
        detail:
          "SpecWithCode needs Screen Recording to see the screen, and the user did not allow it within two minutes.",
      }),
    ).toBe("screen-recording");
    expect(
      workEntryComputerUsePermission({
        toolData: {
          content: [{ type: "text", text: "SpecWithCode needs Accessibility to click and type" }],
        },
      }),
    ).toBe("accessibility");
  });

  it("understands the wording of desktop builds before the permission card", () => {
    expect(
      workEntryComputerUsePermission({
        toolData: {
          output:
            "The user did not allow Screen Recording for SpecWithCode within two minutes, so it cannot see the screen.",
        },
      }),
    ).toBe("screen-recording");
  });

  it("ignores other failures", () => {
    expect(workEntryComputerUsePermission({ detail: "The desktop app is not open" })).toBe(
      undefined,
    );
    expect(workEntryComputerUsePermission({})).toBe(undefined);
  });
});

function fileChangeItem(
  fields: Partial<Extract<OrchestrationV2TurnItem, { type: "file_change" }>> = {},
): Extract<OrchestrationV2TurnItem, { type: "file_change" }> {
  return {
    id: TurnItemId.make("edit"),
    threadId: ThreadId.make("thread"),
    runId: RunId.make("run-1"),
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 1,
    status: "completed",
    title: null,
    startedAt: null,
    completedAt: null,
    updatedAt: DateTime.makeUnsafe("2026-10-24T00:00:00.000Z"),
    type: "file_change",
    fileName: "/repo/apps/web/src/App.tsx",
    ...fields,
  };
}

describe("repoRelativePath and matchDiffPath", () => {
  // The thread runs in a subfolder; checkpoint patch paths are relative to the repository.
  const roots = { repoRoot: "/repo", workspaceRoot: "/repo/apps/web" };

  it("relativizes against the stamped repository root, not the thread's subfolder", () => {
    expect(repoRelativePath("/repo/apps/web/src/App.tsx", roots)).toBe("apps/web/src/App.tsx");
    expect(repoRelativePath("src/App.tsx", roots)).toBe("apps/web/src/App.tsx");
    expect(repoRelativePath("./src/../src/App.tsx", roots)).toBe("apps/web/src/App.tsx");
    expect(repoRelativePath("../shared/index.ts", roots)).toBe("apps/shared/index.ts");
    expect(repoRelativePath("/repo/README.md", roots)).toBe("README.md");
    expect(
      matchDiffPath("/repo/apps/web/src/App.tsx", ["README.md", "apps/web/src/App.tsx"], roots),
    ).toEqual({ path: "apps/web/src/App.tsx", matchedBy: "exact" });
  });

  it("returns null for a path outside the root", () => {
    expect(repoRelativePath("/elsewhere/src/App.tsx", roots)).toBeNull();
    expect(repoRelativePath("/repo-other/src/App.tsx", roots)).toBeNull();
    expect(repoRelativePath("/repo", roots)).toBeNull();
    expect(repoRelativePath("../../../outside.ts", roots)).toBeNull();
    expect(repoRelativePath("/repo/src/App.tsx", {})).toBeNull();
    expect(matchDiffPath("/elsewhere/src/App.tsx", ["src/App.tsx"], roots)).toBeNull();
  });

  it("never reveals a namesake when the stamped path is not in the patch", () => {
    expect(
      matchDiffPath("/repo/apps/web/package.json", ["packages/core/package.json"], roots),
    ).toBeNull();
  });

  it("falls back to a unique suffix for old checkpoints and labels it", () => {
    const old = { workspaceRoot: "/repo/apps/web" };
    expect(repoRelativePath("/repo/apps/web/src/App.tsx", old)).toBe("src/App.tsx");
    expect(
      matchDiffPath("/repo/apps/web/src/App.tsx", ["README.md", "apps/web/src/App.tsx"], old),
    ).toEqual({ path: "apps/web/src/App.tsx", matchedBy: "file_name" });
    expect(matchDiffPath("src/App.tsx", ["apps/web/src/App.tsx"], { repoRoot: "/repo" })).toEqual({
      path: "apps/web/src/App.tsx",
      matchedBy: "file_name",
    });
  });

  it("returns null for an ambiguous suffix instead of picking one", () => {
    const old = { workspaceRoot: "/repo/apps/web" };
    expect(
      matchDiffPath(
        "/repo/apps/web/package.json",
        ["apps/web/package.json", "packages/core/package.json"],
        old,
      ),
    ).toBeNull();
    expect(
      matchDiffPath("index.ts", ["src/index.ts", "src/lib/index.ts"], { repoRoot: "/repo" }),
    ).toBeNull();
  });

  it("compares Windows paths without case and keeps the candidate's spelling", () => {
    const windows = { repoRoot: "C:\\Work\\Repo", workspaceRoot: "C:\\Work\\Repo\\apps\\web" };
    expect(repoRelativePath("c:/work/repo/apps/web/src/App.tsx", windows)).toBe(
      "apps/web/src/App.tsx",
    );
    expect(repoRelativePath("src\\App.tsx", windows)).toBe("apps/web/src/App.tsx");
    expect(repoRelativePath("D:\\Work\\Repo\\src\\App.tsx", windows)).toBeNull();
    expect(
      matchDiffPath("C:\\WORK\\REPO\\Apps\\Web\\src\\app.tsx", ["apps/web/src/App.tsx"], windows),
    ).toEqual({ path: "apps/web/src/App.tsx", matchedBy: "exact" });
    // POSIX paths keep their case.
    expect(matchDiffPath("/repo/apps/web/src/app.tsx", ["apps/web/src/App.tsx"], roots)).toBeNull();
  });
});

describe("filesChangedOutsideEditItems", () => {
  const roots = { repoRoot: "/repo", workspaceRoot: "/repo" };

  it("names every path an edit item carries", () => {
    expect(
      fileChangeItemPaths(
        fileChangeItem({
          fileName: "/repo/a.ts",
          changes: [
            { operation: "update", path: "/repo/a.ts" },
            { operation: "move", path: "/repo/c.ts", oldPath: "/repo/b.ts" },
          ],
        }),
      ),
    ).toEqual(["/repo/a.ts", "/repo/c.ts", "/repo/b.ts"]);
    expect(fileChangeItemPaths(commandItem())).toEqual([]);
  });

  it("lists a concurrent writer's file in a read-only turn as not reported", () => {
    // The turn only ran a command; another agent in the same checkout wrote the file.
    expect(
      filesChangedOutsideEditItems({
        files: ["src/written-by-another-agent.ts"],
        editItems: [commandItem({ input: "cat README.md" })],
        roots,
      }),
    ).toEqual({
      notReported: ["src/written-by-another-agent.ts"],
      bySubagent: [],
      unloadedSubagentTitles: [],
    });
  });

  it("subtracts only successful edits", () => {
    const result = filesChangedOutsideEditItems({
      files: ["edited.ts", "failed.ts", "declined.ts", "cancelled.ts", "shell.ts"],
      editItems: [
        fileChangeItem({ fileName: "/repo/edited.ts" }),
        fileChangeItem({ fileName: "/repo/failed.ts", status: "failed" }),
        fileChangeItem({ fileName: "/repo/declined.ts", status: "cancelled", declined: true }),
        fileChangeItem({ fileName: "/repo/cancelled.ts", status: "cancelled" }),
      ],
      roots,
    });
    expect(result.notReported).toEqual(["failed.ts", "declined.ts", "cancelled.ts", "shell.ts"]);
  });

  it("matches edits in a subfolder thread against repository-relative files", () => {
    expect(
      filesChangedOutsideEditItems({
        files: ["apps/web/src/App.tsx", "apps/web/package.json"],
        editItems: [fileChangeItem({ fileName: "src/App.tsx" })],
        roots: { repoRoot: "/repo", workspaceRoot: "/repo/apps/web" },
      }).notReported,
    ).toEqual(["apps/web/package.json"]);
  });

  it("lists a loaded subagent's files under it and names unloaded subagents", () => {
    const result = filesChangedOutsideEditItems({
      files: ["main.ts", "helper.ts", "unloaded.ts"],
      editItems: [fileChangeItem({ fileName: "/repo/main.ts" })],
      subagents: [
        {
          title: "Refactor helper",
          loaded: true,
          editItems: [fileChangeItem({ fileName: "/repo/helper.ts" })],
        },
        {
          title: "Failed helper",
          loaded: true,
          editItems: [fileChangeItem({ fileName: "/repo/unloaded.ts", status: "failed" })],
        },
        { title: "Docs pass", loaded: false, editItems: [] },
      ],
      roots,
    });
    expect(result).toEqual({
      notReported: ["unloaded.ts"],
      bySubagent: [{ title: "Refactor helper", files: ["helper.ts"] }],
      unloadedSubagentTitles: ["Docs pass"],
    });
  });
});

describe("tool group failure counts", () => {
  const entry = (
    id: string,
    overrides: Partial<WorkLogPresentationEntry>,
  ): WorkLogPresentationEntry => ({
    id,
    createdAt: "2026-10-24T00:00:00Z",
    label: "Ran command",
    tone: "tool",
    itemType: "command_execution",
    toolLifecycleStatus: "completed",
    ...overrides,
  });
  const command = (
    id: string,
    fields: Partial<Extract<OrchestrationV2TurnItem, { type: "command_execution" }>>,
    overrides: Partial<WorkLogPresentationEntry> = {},
  ) =>
    entry(id, {
      command: "git diff",
      structuredPayload: commandItem({ input: "git diff", ...fields }),
      ...overrides,
    });

  it.each([
    ["Claude failed status", command("a", { status: "failed" }, { toolLifecycleStatus: "failed" })],
    [
      "Claude is_error exit code",
      command("b", { status: "failed", exitCode: 1 }, { toolLifecycleStatus: "failed" }),
    ],
    ["Codex nonzero exit", command("c", { exitCode: 2 })],
    ["provider error", entry("d", { tone: "error", label: "Provider error" })],
    [
      "SpecWithCode tool error",
      entry("e", {
        itemType: "dynamic_tool",
        toolData: { toolName: "Studio-code.studio_project_clone", rawOutput: { isError: true } },
      }),
    ],
  ] as const)("counts %s as failed", (_label, failed) => {
    expect(workEntryFailureKind(failed)).toBe("failed");
    expect(summarizeToolGroup([failed])).toMatchObject({
      hasFailure: true,
      failedCount: 1,
      possibleFailureCount: 0,
      declinedCount: 0,
    });
  });

  it.each([
    // `git diff` with differences exits 1 as a plain Claude result: only the flag is set.
    [
      "flagged output without an exit code",
      command("a", { exitCode: undefined, outputIndicatesFailure: true }),
    ],
    [
      "heuristic detail",
      entry("b", { label: "Glob", itemType: "file_search", detail: "No files found" }),
    ],
    ["heuristic output", command("c", { exitCode: 0, output: "ls: no such file or directory" })],
  ] as const)("counts %s as a possible failure, never failed", (_label, possible) => {
    expect(workEntryFailureKind(possible)).toBe("possible");
    expect(summarizeToolGroup([possible])).toMatchObject({
      hasFailure: false,
      failedCount: 0,
      possibleFailureCount: 1,
    });
  });

  it.each([
    [
      "Codex declined flag",
      command(
        "a",
        { status: "cancelled", declined: true, exitCode: undefined },
        { toolLifecycleStatus: "stopped" },
      ),
    ],
    ["declined lifecycle", entry("b", { toolLifecycleStatus: "declined" })],
  ] as const)("counts %s as declined, not failed", (_label, declined) => {
    expect(workEntryFailureKind(declined)).toBe("declined");
    expect(summarizeToolGroup([declined])).toMatchObject({
      hasFailure: false,
      failedCount: 0,
      declinedCount: 1,
    });
  });

  it.each([
    [
      "Claude interrupted flag",
      command("a", { status: "interrupted", exitCode: 130 }, { toolLifecycleStatus: "stopped" }),
    ],
    [
      "Codex stop",
      command(
        "b",
        { status: "cancelled", exitCode: undefined },
        { toolLifecycleStatus: "stopped" },
      ),
    ],
  ] as const)("counts %s nowhere", (_label, stopped) => {
    expect(workEntryFailureKind(stopped)).toBe("stopped");
    expect(summarizeToolGroup([stopped])).toMatchObject({
      hasFailure: false,
      failedCount: 0,
      possibleFailureCount: 0,
      declinedCount: 0,
    });
  });

  it("counts every entry, not only the latest or the summarized ones", () => {
    const source = { key: "browser-use:chrome", name: "Chrome", kind: "integration" as const };
    const counts = summarizeToolGroup([
      command("failed", { exitCode: 1 }),
      command("possible", { exitCode: undefined, outputIndicatesFailure: true }),
      entry("declined", { toolLifecycleStatus: "declined" }),
      entry("sourced", {
        label: "Open page",
        itemType: "dynamic_tool",
        toolSource: source,
        toolLifecycleStatus: "failed",
      }),
      command("ok", { exitCode: 0 }),
    ]);
    expect(counts).toMatchObject({
      hasFailure: true,
      failedCount: 2,
      possibleFailureCount: 1,
      declinedCount: 1,
    });
    expect(workEntryFailureKind(command("ok", { exitCode: 0 }))).toBeNull();
  });
});

describe("subagentDiffTarget", () => {
  const childThreadId = ThreadId.make("child");
  const parentThreadId = ThreadId.make("parent");
  const subagent = (fields: Partial<OrchestrationV2Subagent> = {}): OrchestrationV2Subagent => ({
    id: NodeId.make("subagent"),
    threadId: parentThreadId,
    runId: RunId.make("launching-run"),
    parentNodeId: NodeId.make("root"),
    origin: "provider_native",
    createdBy: "agent",
    driver: ProviderDriverKind.make("claudeAgent"),
    providerInstanceId: ProviderInstanceId.make("claude"),
    providerThreadId: null,
    childThreadId,
    nativeTaskRef: null,
    prompt: "Rename the helper\nand update callers",
    title: "Rename helper",
    model: null,
    status: "completed",
    result: null,
    startedAt: null,
    completedAt: null,
    updatedAt: DateTime.makeUnsafe("2026-10-24T00:00:00.000Z"),
    ...fields,
  });

  it("routes a provider-native subagent's edits to the parent's launching run", () => {
    expect(
      subagentDiffTarget({
        childThreadId,
        parentThreadId,
        parentSubagents: [subagent({ childThreadId: ThreadId.make("other") }), subagent()],
      }),
    ).toEqual({
      parentThreadId,
      runId: RunId.make("launching-run"),
      title: "Rename helper",
      origin: "provider_native",
      running: false,
    });
    expect(
      subagentDiffTarget({
        childThreadId,
        parentThreadId,
        parentSubagents: [subagent({ title: null, status: "running" })],
      }),
    ).toMatchObject({ title: "Rename the helper", running: true });
  });

  it("reports app-owned delegates so their rows keep their own thread's diff", () => {
    expect(
      subagentDiffTarget({
        childThreadId,
        parentThreadId,
        parentSubagents: [subagent({ origin: "app_owned" })],
      })?.origin,
    ).toBe("app_owned");
  });

  it("has no run until the parent projection loads, and no target without a parent", () => {
    expect(subagentDiffTarget({ childThreadId, parentThreadId, parentSubagents: null })).toEqual({
      parentThreadId,
      runId: null,
      title: "Subagent",
      origin: "provider_native",
      running: false,
    });
    expect(
      subagentDiffTarget({ childThreadId, parentThreadId: null, parentSubagents: [subagent()] }),
    ).toBeNull();
    expect(subagentDiffTarget({ childThreadId, parentThreadId, parentSubagents: [] })).toBeNull();
  });
});

describe("turnDiffState", () => {
  const runId = RunId.make("run-2");
  const checkpoint = (fields: Partial<ThreadCheckpointSummary> = {}): ThreadCheckpointSummary => ({
    runId,
    checkpointTurnCount: 2,
    checkpointRef: CheckpointRef.make("refs/studio/checkpoints/2"),
    status: "ready",
    files: [],
    assistantMessageId: null,
    completedAt: "2026-10-24T00:00:00.000Z",
    ...fields,
  });
  const state = (status: string, checkpoints: ReadonlyArray<ThreadCheckpointSummary>) =>
    turnDiffState({ runId, runs: [{ id: runId, status }], checkpoints });

  it.each(["completed", "interrupted", "cancelled"])(
    "opens the ready diff of a %s run",
    (status) => {
      const available = state(status, [
        checkpoint({ runId: RunId.make("run-1"), checkpointTurnCount: 1 }),
        checkpoint(),
      ]);
      expect(available).toEqual({ kind: "available", turnCount: 2, fromBaseline: false });
      expect(turnDiffStateMessage(available)).toBeNull();
    },
  );

  it.each([
    ["running", [checkpoint()], "running", "Diff available when the turn ends"],
    ["starting", [], "running", "Diff available when the turn ends"],
    [
      "completed",
      [checkpoint({ status: "error" })],
      "snapshot_error",
      "No diff: this turn's snapshot failed",
    ],
    [
      "completed",
      [checkpoint({ status: "missing" })],
      "snapshot_missing",
      "No diff: this turn's snapshot is missing",
    ],
    [
      "completed",
      [checkpoint({ status: "stale" })],
      "snapshot_stale",
      "No diff: this turn's snapshot is out of date",
    ],
    [
      "completed",
      [checkpoint({ status: "missing", notGitRepository: true })],
      "not_git",
      "No diff: this folder is not a Git repository",
    ],
    [
      "failed",
      [checkpoint({ runId: RunId.make("run-1") })],
      "failed_no_snapshot",
      "No diff: this turn ended with an error before a snapshot was taken",
    ],
    [
      "completed",
      [checkpoint({ runId: RunId.make("run-1") })],
      "unknown",
      "No diff recorded for this turn",
    ],
  ] as const)("a %s run with %j is %s", (status, checkpoints, kind, message) => {
    const result = state(status, checkpoints);
    expect(result.kind).toBe(kind);
    expect(turnDiffStateMessage(result)).toBe(message);
  });

  it("never shows another run's diff for an unknown run", () => {
    expect(turnDiffState({ runId, runs: [], checkpoints: [checkpoint()] })).toEqual({
      kind: "unknown",
    });
  });
});
