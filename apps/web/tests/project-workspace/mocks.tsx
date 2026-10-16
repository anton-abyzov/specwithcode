import {
  SelectedThreadShell,
  resolveSelectedThreadShell,
} from "../../src/state/selectedThreadShell";
import { Option, DateTime } from "effect";
import { AsyncResult, Atom } from "effect/reactivity";
import React, { useState, useSyncExternalStore, useContext } from "react";

/* Exports of stubbed modules this fixture never exercises: a callable that
   returns itself for any call or property, so module wiring loads. */
function fixtureAnything(name: string): any {
  const target = function () {};
  const proxy: any = new Proxy(target, {
    get: (_t, key) =>
      key === Symbol.toPrimitive ? () => name : key === "then" ? undefined : proxy,
    apply: () => proxy,
    construct: () => proxy,
  });
  return proxy;
}
import { DEFAULT_SERVER_SETTINGS } from "@specweave-studio/contracts";
import {
  buildStarterSuggestions,
  UNREAD_STARTER_SIGNALS,
} from "@specweave-studio/shared/projectStarterSuggestions";
import {
  useProjectMessageRouting,
  routeProjectComposerSend,
} from "../../src/studio/projectMessageRouting";
import { scopeThreadRef } from "@specweave-studio/client-runtime/environment";
import { useHideRightPanelOnLeave } from "../../src/hooks/useHideRightPanelOnLeave";
import { selectThreadRightPanelState, useRightPanelStore } from "../../src/rightPanelStore";
import { parseStudioThreadHref } from "@specweave-studio/shared/studioThreadLinks";
import { StudioThreadLink } from "../../src/components/StudioThreadLink";
import { reportKey } from "@specweave-studio/shared/threadReport";
// `?fresh` is a project nobody has worked in yet; `?fresh=empty` is one whose folder is empty too.
const recovery = new URLSearchParams(window.location.search).get("recovery");
const recoveryFailureId =
  new URLSearchParams(window.location.search).get("recovery-failure") ?? "run-failed";
const fresh = new URLSearchParams(window.location.search).get("fresh");
// `?fresh&failed` adds a coordinator turn the host could not start (a reached usage limit).
const failedTurn = new URLSearchParams(window.location.search).has("failed");
/* `?turns`: a conversation across two days, for the turn layout (separators,
   "Worked for", the answer's actions). Times are relative so "Today" holds. */
const turns = new URLSearchParams(window.location.search).has("turns");
const minutesAgo = (minutes, seconds = 0) =>
  new Date(Date.now() - minutes * 60_000 + seconds * 1_000).toISOString();
const turnMessages = [
  {
    id: "t1",
    role: "user",
    createdBy: "user",
    text: "Summarize what changed in the landing page review.",
    createdAt: minutesAgo(26 * 60),
    attachments: [],
  },
  {
    id: "t2",
    role: "assistant",
    text: "The review asked for **three changes**: a shorter hero line, one primary button instead of two, and the pricing table moved above the FAQ.\n\n[Review the landing page](studio://thread/review) is waiting on your call about the hero line.",
    createdAt: minutesAgo(26 * 60, 9),
    updatedAt: minutesAgo(26 * 60, 41),
    attachments: [],
  },
  {
    id: "t3",
    role: "user",
    createdBy: "user",
    text: "What time is it?",
    createdAt: minutesAgo(1),
    attachments: [],
  },
  {
    id: "t4",
    role: "assistant",
    text: "It's **11:52 PM EDT** on Sunday, October 11, 2026.",
    createdAt: minutesAgo(1, 12),
    updatedAt: minutesAgo(1, 14),
    attachments: [],
  },
];
// `?legacy` is a project from before projects had settings: no settings row, no saved
// coordinator or worker model and no coordinator thread yet. `?legacy=loading` is the same
// project before the host has sent its providers, and `?legacy=checking` after it sent them
// but before Claude's first check.
const legacy = new URLSearchParams(window.location.search).get("legacy");
const starters = {
  hasWorkspace: fresh !== "empty",
  suggestions: buildStarterSuggestions({
    ...UNREAD_STARTER_SIGNALS,
    goal: "Ship a thoughtful workspace for independent teams.",
    hasWorkspace: fresh !== "empty",
    testCommand: "pnpm test",
    uncommittedFiles: 3,
    todoCount: 14,
    recentCommitSubjects: ["Add the importer skeleton"],
    openIncrements: [{ id: "0042-importer", title: "Importer for saved sessions" }],
  }),
};
export const project = {
  id: "project",
  environmentId: "host",
  title: "Atlas Studio",
  workspaceRoot: "/scratch/atlas",
  defaultModelSelection: legacy !== null ? null : { instanceId: "codex", model: "Codex worker" },
};
const settings = {
  revision: 7,
  kind: new URLSearchParams(window.location.search).has("personal") ? "personal" : "code",
  environment: {
    additionalFolders: ["/scratch/research"],
    repositories: [
      {
        id: "repo-one",
        url: "https://github.com/example/atlas.git",
        localPath: "/scratch/atlas/code",
      },
    ],
  },
  goal: "Ship a thoughtful workspace for independent teams.",
  instructions: "Keep decisions brief. Link to the supporting thread.",
  coordinatorThreadId: legacy !== null ? null : "coord",
  coordinatorModelSelection:
    recovery === "incompatible" || recovery === "full-access"
      ? { instanceId: "github-copilot-cli", model: "claude-opus-5.5" }
      : recovery
        ? { instanceId: "codex", model: "gpt-6" }
        : legacy !== null
          ? null
          : { instanceId: "claude", model: "Claude coordinator" },
  paused: false,
  archived: false,
  autoResume: true,
};
const memory = {
  files: [{ name: "MEMORY.md", revision: 3, updatedAt: "2026-10-09T00:00:00Z", byteLength: 128 }],
  totalBytes: 128,
};
const totals = {
  inputTokens: 40000,
  outputTokens: 10000,
  totalTokens: 50000,
  cachedInputTokens: 30000,
  cacheCreationTokens: null,
  reasoningTokens: null,
  equivalentCostUsd: 0.26,
};
const scaledTotals = (share) => ({
  ...totals,
  inputTokens: totals.inputTokens * share,
  outputTokens: totals.outputTokens * share,
  totalTokens: totals.totalTokens * share,
  cachedInputTokens: totals.cachedInputTokens * share,
  equivalentCostUsd: totals.equivalentCostUsd * share,
});
export const TUTORIALS_ID =
  "thread:delegated-task:command%3Amcp%3Afixture-0001%3Adelegate-task%3Arecord-tutorials";
// `?activity`: the coordinator's turns carry their runs and work items, for the timeline detail levels.
const activity = new URLSearchParams(window.location.search).has("activity");
/** `?report`: a worker reports back with a long review, and the coordinator relays it. */
const reportFixture = new URLSearchParams(window.location.search).has("report");
const REPORT_TEXT = [
  "# Review cycle 2 of 0973",
  "",
  "No critical or high findings remain. Two medium findings from cycle 1 are fixed and verified; one low finding is deferred with a note in the spec.",
  "",
  "## Findings",
  "",
  "| Severity | Finding | Status |",
  "| --- | --- | --- |",
  "| Medium | Budget totals ignored archived lines | Fixed |",
  "| Medium | Export dropped the currency column | Fixed |",
  "| Low | Variance chart labels overlap at 390px | Deferred |",
  "",
  "## Verification",
  "",
  ...Array.from(
    { length: 12 },
    (_, i) => `- Check ${i + 1}: budget-vs-actuals scenario ${i + 1} passes`,
  ),
  "",
  "## Next",
  "",
  "Close 0973 once the deferred label fix has its own task.",
].join("\n");
const RELAY_TEXT = [
  "The review worker finished cycle 2 of 0973. Here is what it found:",
  "",
  ...Array.from(
    { length: 30 },
    (_, i) => `- Point ${i + 1} from the review, restated for the decision`,
  ),
  "",
  "Nothing blocks closing 0973. Say the word and I'll close it.",
].join("\n");
const savedReports = [];
const reportSnapshot = () => ({
  workspaceRoot: "/scratch/atlas",
  specweave: true,
  increment: {
    id: "0973-budget-vs-actuals",
    path: ".specweave/increments/0973-budget-vs-actuals",
  },
  folder: ".specweave/increments/0973-budget-vs-actuals/reports",
  reports: savedReports,
});
const reportAgo = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString();
const reportProjection = {
  messages: [
    {
      id: "r1",
      role: "user",
      createdBy: "user",
      text: "Run review cycle 2 of 0973.",
      createdAt: reportAgo(9),
      attachments: [],
    },
    {
      id: "r2",
      role: "assistant",
      text: "Started [Consolidate the skills](studio://thread/skills) on review cycle 2.",
      createdAt: reportAgo(8.5),
      attachments: [],
    },
    {
      id: "r3",
      role: "user",
      createdBy: "system",
      text: "A worker reported back.",
      delegatedCompletion: { taskIds: ["node:delegated-task:review"] },
      createdAt: reportAgo(2),
      attachments: [],
    },
    {
      id: "r4",
      role: "user",
      createdBy: "agent",
      senderThreadId: "skills",
      text: REPORT_TEXT,
      createdAt: reportAgo(2),
      attachments: [],
    },
    {
      id: "r5",
      role: "assistant",
      text: RELAY_TEXT,
      createdAt: reportAgo(1),
      attachments: [],
    },
  ],
  runs: [],
  turnItems: [],
};
const shell = (id, title, extra = {}) => ({
  id,
  title,
  projectId: "project",
  environmentId: "host",
  runtime: null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  hasActionableProposedPlan: false,
  settledOverride: null,
  pullRequests: [],
  lineage: { relationshipToParent: null, parentThreadId: null, rootThreadId: id },
  archivedAt: null,
  deletedAt: null,
  updatedAt: "2026-10-09T00:00:00Z",
  modelSelection: { instanceId: "codex", model: "Native Codex worker" },
  // The Threads pane lists only threads an agent started.
  createdBy: "agent",
  ...extra,
});
let shells = recovery
  ? [
      shell("coord", "Project coordinator", {
        latestRun: { runId: recoveryFailureId, status: "failed" },
        runtime: {
          lastError:
            recovery === "full-access"
              ? "The previous provider session ended before answering. Retry the message."
              : "This provider cannot enforce additional project folder access. Choose a Codex or Claude coordinator for this project.",
        },
        modelSelection: settings.coordinatorModelSelection,
        runtimeMode: recovery === "full-access" ? "full-access" : "approval-required",
        interactionMode: "default",
      }),
    ]
  : legacy !== null
    ? []
    : fresh !== null
      ? [
          shell(
            "coord",
            "Project coordinator",
            failedTurn
              ? {
                  latestRun: { runId: recoveryFailureId, status: "failed" },
                  runtime: {
                    status: "failed",
                    lastError:
                      "Provider session failed to open: no remaining permitted usage this week.",
                  },
                }
              : {},
          ),
        ]
      : [
          shell("coord", "Project coordinator"),
          shell("review", "Review the landing page", {
            hasActionableProposedPlan: true,
            modelSelection: { instanceId: "claudeAgent", model: "claude-opus-5-5" },
          }),
          // Started by the coordinator's answer below, so that answer shows it as a card.
          // Under `?activity` it is started during the first turn, by the commentary that names it.
          shell("skills", "Consolidate the skills", {
            runtime: { status: "running" },
            createdAt: activity ? minutesAgo(5.95) : "2026-10-09T00:00:03Z",
          }),
          // A delegated worker's real ID shape: `%3A` is part of the stored ID.
          shell(TUTORIALS_ID, "Record the tutorials", { createdAt: "2026-10-09T00:00:03Z" }),
          // A Claude model reached through Copilot must not read as a native Claude Code thread.
          shell("build", "Build project memory", {
            runtime: { status: "running" },
            modelSelection: { instanceId: "github-copilot-cli", model: "claude-opus-5.5" },
          }),
          shell("idle", "Polish onboarding"),
          shell("resolved", "Fix history pagination", { settledOverride: "settled" }),
          shell("archived", "Initial exploration", { archivedAt: "2026-10-08T00:00:00Z" }),
        ];
const resolutionFixture = new URLSearchParams(window.location.search).has("resolution");
if (resolutionFixture)
  shells = [
    shell("coord", "Project coordinator"),
    shell("failed-worker", "Failed worker", {
      createdBy: "agent",
      runtime: { status: "failed", lastErrorClass: "provider_error" },
    }),
    shell("limited-worker", "Limited worker", {
      createdBy: "agent",
      runtime: { status: "failed", lastErrorClass: "usage_limit" },
    }),
  ];
// `?rows`: busy workers on two machines, for the Threads pane row layout at any width.
const rowsFixture = new URLSearchParams(window.location.search).has("rows");
if (rowsFixture)
  shells = [
    shell("coord", "Project coordinator"),
    shell("resolve-closes", "Resolve closes thread", {
      createdBy: "agent",
      runtime: { status: "running" },
      modelSelection: { instanceId: "claude", model: "claude-opus-5-5" },
    }),
    shell("hide-archived", "Hide archived projects in dropdowns and every project picker", {
      createdBy: "agent",
      runtime: { status: "running" },
      modelSelection: { instanceId: "claude", model: "claude-opus-5-5" },
    }),
    shell("remote-worker", "Profile the importer on the other machine", {
      createdBy: "agent",
      projectId: "project-m1",
      environmentId: "m1",
      runtime: { status: "running" },
    }),
    shell("failed-row", "Migrate saved sessions", {
      createdBy: "agent",
      runtime: {
        status: "failed",
        lastError: "Provider session failed to open: no remaining permitted usage this week.",
      },
    }),
    shell("idle-row", "Show harness on thread rows", {
      createdBy: "agent",
      modelSelection: { instanceId: "github-copilot-cli", model: "claude-opus-5.5" },
      pullRequests: [
        {
          host: "github.com",
          repository: "atlas/studio",
          number: 2041,
          url: "https://example.invalid/pr/2041",
          source: "agent",
          linkedAt: "2026-10-09T00:00:00Z",
          snapshot: {
            state: "open",
            title: "Rows",
            headBranch: "rows",
            baseBranch: "main",
            isDraft: false,
            updatedAt: null,
            syncedAt: "2026-10-09T00:00:00Z",
          },
          stack: null,
        },
      ],
    }),
  ];
// `?subagents`: a worker that started subagents of its own, the way the Claude Agent tool and a
// worker's delegate_task do. Only the worker is a thread; its subagents show inside it.
const subagentsFixture = new URLSearchParams(window.location.search).has("subagents");
const subagentOf = (parentThreadId) => ({
  relationshipToParent: "subagent",
  parentThreadId,
  rootThreadId: "coord",
});
if (subagentsFixture)
  shells = [
    shell("coord", "Project coordinator"),
    shell("warn", "Warn before restart", {
      lineage: subagentOf("coord"),
      modelSelection: { instanceId: "claudeAgent", model: "claude-opus-5-5" },
    }),
    shell("bulk", "Bulk thread slash command", {
      lineage: subagentOf("warn"),
      runtime: { status: "running" },
      modelSelection: { instanceId: "claudeAgent", model: "claude-opus-5-5" },
    }),
    shell("rea", "REA Claude desktop artifacts", {
      lineage: subagentOf("warn"),
      creationSource: "provider",
      modelSelection: { instanceId: "claudeAgent", model: "claude-sonnet-5-5" },
    }),
    shell("grep", "Grep the app bundle", {
      lineage: subagentOf("rea"),
      creationSource: "provider",
      runtime: { status: "running" },
      modelSelection: { instanceId: "claudeAgent", model: "claude-haiku-5-5" },
    }),
    shell("polish", "Polish onboarding"),
  ];
const fixtureSubagents = subagentsFixture
  ? [
      {
        id: "node:bulk",
        childThreadId: "bulk",
        title: "Bulk thread slash command",
        prompt: "Work only in the git worktree studio-bulk-threads-slash.",
        status: "running",
        origin: "app_owned",
        providerInstanceId: "claudeAgent",
        model: "claude-opus-5-5",
        result: null,
        startedAt: DateTime.makeUnsafe(Date.now() - 74_000),
        completedAt: null,
      },
      {
        id: "node:rea",
        childThreadId: "rea",
        title: "REA Claude desktop artifacts",
        prompt: "Research task (read-only): how Claude.app renders artifacts.",
        status: "completed",
        origin: "provider_native",
        providerInstanceId: "claudeAgent",
        model: "claude-sonnet-5-5",
        result: "Artifacts render in a sandboxed iframe fed by a postMessage bridge.",
        startedAt: DateTime.makeUnsafe(Date.now() - 600_000),
        completedAt: DateTime.makeUnsafe(Date.now() - 42_000),
      },
    ]
  : [];
const historyFixture = new URLSearchParams(window.location.search).has("history");
let historyShells = historyFixture
  ? [
      shell("legacy-history", "Completed investigation", {
        createdBy: "agent",
        archivedAt: "2026-10-08T00:00:00Z",
        settledOverride: "settled",
      }),
    ]
  : [];
const shellListeners = new Set<() => void>();
const subscribeShells = (listener: () => void) => {
  shellListeners.add(listener);
  return () => {
    shellListeners.delete(listener);
  };
};
function settleFixture(ref, settledOverride) {
  if (!resolutionFixture) return;
  shells = shells.map((s) => (s.id === ref.threadId ? { ...s, settledOverride } : s));
  shellListeners.forEach((notify) => notify());
  return { _tag: "Success", value: undefined };
}
// `?machines`: the project is also checked out on a second machine, so the coordinator machine is a choice.
const machineLabels = { host: "M4 Max", m1: "M1" };
const otherMachineProject = { ...project, id: "project-m1", environmentId: "m1" };
const memberProjects = rowsFixture
  ? [project, otherMachineProject]
  : new URLSearchParams(window.location.search).has("machines")
    ? [otherMachineProject, project]
    : [project];
export const useSettingsProjectGroups = () => [
  {
    projectKey: "atlas",
    memberProjects: memberProjects.map((member) => ({
      ...member,
      environmentLabel: machineLabels[member.environmentId],
    })),
  },
];
export const useProjects = () => memberProjects;
export const useThreadShells = () => useSyncExternalStore(subscribeShells, () => shells);
export const readThreadShells = () => shells;
// The project page reads its own project's shells, and a host's threads for its links.
export const useThreadShellsForProjectRefs = (
  refs: ReadonlyArray<{ environmentId: string; projectId: string }>,
) => {
  const all = useThreadShells();
  return React.useMemo(
    () =>
      all.filter((thread) =>
        refs.some(
          (ref) => ref.environmentId === thread.environmentId && ref.projectId === thread.projectId,
        ),
      ),
    [all, refs],
  );
};
export const useThreadLinkTargets = (environmentId: string | null) => {
  const all = useThreadShells();
  return React.useMemo(
    () => all.filter((thread) => thread.environmentId === environmentId),
    [all, environmentId],
  );
};
const activityItem = (id, runId, ordinal, type, fields = {}) => ({
  id,
  runId,
  ordinal,
  type,
  status: "completed",
  ...fields,
});
const activityProjection = {
  messages: [
    {
      id: "m1",
      role: "user",
      createdBy: "user",
      runId: "run-1",
      text: "Keep the project moving. Show me the work that needs a decision.",
      createdAt: minutesAgo(6),
      attachments: [],
    },
    {
      id: "m1-note",
      role: "assistant",
      runId: "run-1",
      text: "Checking the open threads first. Starting [Consolidate the skills](studio://thread/skills) now.",
      createdAt: minutesAgo(5.9),
      attachments: [
        {
          type: "file",
          id: "triage-notes",
          name: "triage-notes.md",
          mimeType: "text/markdown",
          sizeBytes: 812,
        },
      ],
    },
    {
      id: "m2",
      role: "assistant",
      runId: "run-1",
      text: `Started [Consolidate the skills](studio://thread/skills) and [Record the tutorials](studio://thread/${TUTORIALS_ID}). [Review the landing page](studio://thread/review) needs your decision before we continue.`,
      createdAt: minutesAgo(5),
      attachments: [],
    },
    {
      id: "m3",
      role: "user",
      createdBy: "user",
      runId: "run-2",
      text: "Add a changelog entry for the importer.",
      createdAt: minutesAgo(1),
      attachments: [],
    },
    {
      id: "m3-note",
      role: "assistant",
      runId: "run-2",
      text: "Reading the changelog before I hand this to a worker.",
      createdAt: minutesAgo(0.8),
      attachments: [],
    },
  ],
  runs: [
    { id: "run-1", status: "completed", ordinal: 1, requestedAt: minutesAgo(6) },
    { id: "run-2", status: "running", ordinal: 2, requestedAt: minutesAgo(1) },
  ],
  turnItems: [
    activityItem("i1", "run-1", 1, "reasoning", { text: "Two threads are idle and one waits." }),
    activityItem("i2", "run-1", 2, "dynamic_tool", {
      toolName: "mcp__studio__studio_thread_list",
      input: {},
    }),
    activityItem("i3", "run-1", 3, "command_execution", { input: "git status --short" }),
    activityItem("i4", "run-1", 4, "dynamic_tool", {
      toolName: "Read",
      input: { file_path: "/scratch/atlas/README.md" },
    }),
    activityItem("i5", "run-1", 5, "dynamic_tool", {
      toolName: "mcp__studio__delegate_task",
      input: { title: "Consolidate the skills" },
    }),
    activityItem("i6", "run-1", 6, "dynamic_tool", {
      toolName: "mcp__studio__delegate_task",
      input: { title: "Record the tutorials" },
    }),
    activityItem("i7", "run-2", 7, "command_execution", {
      input: "sed -n 1,40p CHANGELOG.md",
    }),
    activityItem("i8", "run-2", 8, "dynamic_tool", {
      toolName: "Read",
      input: { file_path: "/scratch/atlas/CHANGELOG.md" },
      status: "running",
    }),
  ],
};
// `?fallback`: the project runs on another machine, and the usage-limit rule moved
// its coordinator off the saved Claude model onto Codex and resent the request.
const fallbackFixture = new URLSearchParams(window.location.search).has("fallback");
const fallbackRequest = 'Start a thread titled "Pick up the handoff" and report what is left.';
const fallbackProjection = {
  messages: [
    {
      id: "f1",
      role: "user",
      createdBy: "user",
      runId: "run-claude",
      text: fallbackRequest,
      createdAt: minutesAgo(3),
      attachments: [],
    },
    {
      id: "limit-fallback:coord:run-claude",
      role: "user",
      createdBy: "user",
      runId: "run-codex",
      text: fallbackRequest,
      createdAt: minutesAgo(2.9),
      attachments: [],
    },
    {
      id: "f2",
      role: "assistant",
      runId: "run-codex",
      text: "Opened the handoff thread with instructions to resume increment 0029.",
      createdAt: minutesAgo(2),
      attachments: [],
    },
  ],
  runs: [
    {
      id: "run-claude",
      status: "failed",
      ordinal: 1,
      requestedAt: minutesAgo(3),
      modelSelection: { instanceId: "claudeAgent", model: "claude-opus-5-5" },
    },
    {
      id: "run-codex",
      status: "completed",
      ordinal: 2,
      requestedAt: minutesAgo(2.9),
      modelSelection: { instanceId: "codex", model: "gpt-6.1-sol" },
    },
  ],
  turnItems: [],
};
if (fallbackFixture) {
  project.workspaceSettings = {
    ...settings,
    coordinatorModelSelection: { instanceId: "claudeAgent", model: "claude-opus-5-5" },
  };
  shells = shells.map((s) =>
    s.id === "coord" ? { ...s, modelSelection: { instanceId: "codex", model: "gpt-6.1-sol" } } : s,
  );
}
const baseThreadProjection = () => ({
  projection: recovery
    ? {
        messages: [
          {
            id: "captured-message",
            role: "user",
            createdBy: "user",
            runId: recoveryFailureId,
            text: "Have you resolved this?",
            attachments: [
              {
                type: "image",
                id: "captured-shot",
                name: "restart.png",
                mimeType: "image/png",
                sizeBytes: 3,
              },
              {
                type: "file",
                id: "captured-notes",
                name: "notes.txt",
                mimeType: "text/plain",
                sizeBytes: 3,
              },
            ],
          },
        ],
        runs: [],
        turnItems: [],
      }
    : reportFixture
      ? reportProjection
      : activity
        ? activityProjection
        : {
            messages:
              fresh !== null
                ? failedTurn
                  ? [
                      {
                        id: "m-failed",
                        role: "user",
                        createdBy: "user",
                        runId: recoveryFailureId,
                        text: "Reply with OK",
                        attachments: [],
                      },
                    ]
                  : []
                : turns
                  ? turnMessages
                  : [
                      {
                        id: "m1",
                        role: "user",
                        createdBy: "user",
                        text: "Keep the project moving. Show me the work that needs a decision.",
                        createdAt: "2026-10-09T00:00:00Z",
                        attachments: [],
                      },
                      {
                        id: "m2",
                        role: "assistant",
                        text: `Started [Consolidate the skills](studio://thread/skills) and [Record the tutorials](studio://thread/${TUTORIALS_ID}). The memory work is running. [Review the landing page](studio://thread/review) needs your decision before we continue. The old [Draft the launch post](studio://thread/thread%3Adelegated-task%3Acommand%253Amcp%253Afixture-0002) worker is no longer here.\n\nOnboarding is ready for another pass; the pagination fix is resolved and retained for future follow-ups.`,
                        createdAt: "2026-10-09T00:00:04Z",
                        updatedAt: "2026-10-09T00:00:05Z",
                        attachments: [],
                      },
                    ],
          },
});
/* `?stream`: a long coordinator conversation that the check grows while a
   reader is scrolled up. `window.__streamPush` adds a message and
   `window.__streamUpdate` rewrites one, the way streamed text arrives. */
const streamFixture = new URLSearchParams(window.location.search).has("stream");
let streamMessages = Array.from({ length: 24 }, (_, index) => ({
  id: `s${index}`,
  role: index % 2 === 0 ? "user" : "assistant",
  createdBy: index % 2 === 0 ? "user" : "agent",
  creationSource: "web",
  text:
    index % 2 === 0
      ? `Question ${index / 2 + 1}: what is the state of worker ${index / 2 + 1}?`
      : `Answer ${(index + 1) / 2}. ${"The worker finished its part, opened a pull request and is waiting on review. ".repeat(4)}`,
  createdAt: new Date(Date.UTC(2026, 9, 16, 9, 0, index * 5)).toISOString(),
  updatedAt: new Date(Date.UTC(2026, 9, 16, 9, 0, index * 5)).toISOString(),
  streaming: false,
  attachments: [],
}));
const streamListeners = new Set<() => void>();
const subscribeStream = (listener: () => void) => {
  streamListeners.add(listener);
  return () => streamListeners.delete(listener);
};
let streamProjection = { projection: { messages: streamMessages, runs: [], turnItems: [] } };
const publishStream = () => {
  streamProjection = { projection: { messages: streamMessages, runs: [], turnItems: [] } };
  for (const listener of streamListeners) listener();
};
window.__streamPush = (message) => {
  const at = new Date().toISOString();
  streamMessages = [
    ...streamMessages,
    { createdAt: at, updatedAt: at, streaming: false, attachments: [], ...message },
  ];
  publishStream();
};
window.__streamUpdate = (id, text) => {
  const at = new Date().toISOString();
  streamMessages = streamMessages.map((m) => (m.id === id ? { ...m, text, updatedAt: at } : m));
  publishStream();
};
export const useThreadProjection = (ref) => {
  // The fixture mode never changes on a page, so the hook order is stable.
  if (streamFixture) return useSyncExternalStore(subscribeStream, () => streamProjection);
  if (fallbackFixture) return { projection: fallbackProjection };
  const base = baseThreadProjection();
  return subagentsFixture
    ? {
        ...base,
        projection: {
          ...base.projection,
          subagents: ref?.threadId === "warn" ? fixtureSubagents : [],
        },
      }
    : base;
};
export const useThreadHistory = () => ({ hasMoreHistory: false });
export const useThreadStatus = () => "ready";
export const useEnvironment = (environmentId) => ({
  label: memberProjects.length > 1 ? machineLabels[environmentId] : "Development Mac",
  connection: { phase: "connected" },
  ...(recovery
    ? {
        serverConfig: {
          settings: { ...DEFAULT_SERVER_SETTINGS, defaultRuntimeMode: "approval-required" },
          environment: {
            capabilities: {
              attachmentUploads: true,
              fileAttachments: { maxUploadBytes: 50 * 1024 * 1024 },
            },
          },
          providers: [
            fixtureProvider("codex", {
              models: [{ slug: "gpt-6", name: "GPT-6", isDefault: true }],
            }),
            fixtureProvider("claudeAgent", {
              models: [{ slug: "claude-opus-5-5", name: "Opus 5.5", isDefault: true }],
            }),
            fixtureProvider("acpRegistry", {
              instanceId: "github-copilot-cli",
              displayName: "Copilot",
              models: [{ slug: "claude-opus-5.5", name: "Opus 5.5", isDefault: true }],
            }),
          ],
        },
      }
    : legacy === null || legacy === "loading"
      ? {}
      : {
          serverConfig: {
            environment: { capabilities: {} },
            providers: [
              fixtureProvider("claudeAgent", {
                // Right after a restart the host sends its config before Claude's first check.
                ...(legacy === "checking"
                  ? {
                      installed: false,
                      version: null,
                      status: "warning",
                      auth: { status: "unknown" },
                      message: "Claude provider status has not been checked in this session yet.",
                    }
                  : {}),
                models: [
                  {
                    slug: "claude-sonnet-5-5",
                    name: "Sonnet 5.5",
                    isCustom: false,
                    isDefault: true,
                  },
                  { slug: "claude-opus-5-5", name: "Opus 5.5", isCustom: false },
                ],
              }),
            ],
          },
        }),
});
export const useEnvironmentScope = () => true;
export const useEnvironmentsWithScope = (environments) =>
  new Set(environments.map((environment) => environment.environmentId));
const connections = [];
export const useEnvironmentQuery = (q) => ({
  data:
    q?.kind === "environment"
      ? {
          revision: settings.revision,
          workspaceRoot: project.workspaceRoot,
          ...settings.environment,
          repositories: settings.environment.repositories.map((r) => ({ ...r, status: "missing" })),
        }
      : q?.kind === "connections"
        ? { connections }
        : q?.kind === "memory"
          ? {
              name: "MEMORY.md",
              content: "Use independent providers per thread. Decisions stay in this project.",
              revision: 3,
              byteLength: 128,
            }
          : q?.kind === "usage"
            ? {
                totals,
                coverage: {
                  threads: 6,
                  missingThreads: 1,
                  partialTurns: 1,
                  missingTurns: 2,
                  costUnknownTurns: 2,
                },
                models: [
                  {
                    providerInstanceId: "claude",
                    provider: "claudeAgent",
                    model: "Coordinator model",
                    modelAttribution: "run_selection",
                    totals: scaledTotals(0.08),
                  },
                  {
                    providerInstanceId: "codex",
                    provider: "codex",
                    model: "Worker model",
                    modelAttribution: "run_selection",
                    totals: scaledTotals(0.92),
                  },
                ],
                folderSessions: {
                  hostLabel: "Development Mac",
                  windowDays: 90,
                  roots: [project.workspaceRoot],
                  sessions: 14,
                  studioOwnedSessions: 2,
                  totals: scaledTotals(3),
                  providers: [
                    {
                      provider: "claude",
                      sessions: 9,
                      totals: scaledTotals(2.2),
                      lastActiveAt: new Date(Date.now() - 2 * 3_600_000).toISOString(),
                    },
                    {
                      provider: "codex",
                      sessions: 4,
                      totals: scaledTotals(0.7),
                      lastActiveAt: new Date(Date.now() - 26 * 3_600_000).toISOString(),
                    },
                    {
                      provider: "copilot",
                      sessions: 1,
                      totals: scaledTotals(0.1),
                      lastActiveAt: null,
                    },
                  ],
                  models: [
                    { provider: "claude", model: "claude-opus-5-5", totals: scaledTotals(2.2) },
                    { provider: "codex", model: "gpt-5.5", totals: scaledTotals(0.7) },
                  ],
                },
                threads: shells.map((s, i) => ({
                  threadId: s.id,
                  title: s.title,
                  role: i === 0 ? "coordinator" : "worker",
                  share: i === 0 ? 0.08 : i === 5 ? null : 0.23,
                  totals: scaledTotals(i === 0 ? 0.08 : i === 5 ? 0 : 0.23),
                  archived: !!s.archivedAt,
                })),
              }
            : q?.kind === "routines"
              ? {
                  tasks: [
                    {
                      id: "r1",
                      projectId: "project",
                      title: "Daily project review",
                      enabled: true,
                      threadId: "idle",
                      nextRunAt: "2026-10-10T13:00:00Z",
                    },
                    { id: "foreign", projectId: "other", title: "Foreign routine", enabled: true },
                  ],
                }
              : q?.kind === "threadIncrementProgress"
                ? { threads: [] }
                : q?.kind === "starters"
                  ? starters
                  : q?.kind === "threadReports"
                    ? reportSnapshot()
                    : q?.kind === "read" || q?.kind === undefined
                      ? {
                          settings,
                          memory: fresh !== null ? { files: [], totalBytes: 0 } : memory,
                          // Real VCS status atoms land here too: an empty working tree.
                          workingTree: { files: [] },
                        }
                      : undefined,
  refresh: () => {},
  isPending: false,
});
window.__projectCalls = [];
export const useAtomCommand = (command) => async (args) => {
  window.__projectCalls.push({ command, args });
  if (command === "threadReportSave") {
    const key = reportKey(args.input.threadId, args.input.text);
    if (!savedReports.some((report) => report.key === key)) {
      savedReports.push({
        key,
        path: `.specweave/increments/0973-budget-vs-actuals/reports/2026-10-12-review-cycle-2-of-0973-${key}.md`,
        savedAt: new Date().toISOString(),
      });
    }
    return { _tag: "Success", value: reportSnapshot() };
  }
  if (command === "folderCheck") {
    const target = args.input.workspaceRoot;
    return {
      _tag: "Success",
      value: {
        targetRoot: target,
        currentRoot: project.workspaceRoot,
        unchanged: target === project.workspaceRoot,
        targetExists: !target.includes("missing"),
        conflictingProject: target.includes("taken")
          ? { id: "p2", title: "SpecWeave umbrella", threadCount: 4, archived: true }
          : null,
        sameRepository: !target.includes("other"),
        currentRepository: "github.com/example/atlas",
        targetRepository: target.includes("other")
          ? "github.com/example/other"
          : "github.com/example/atlas",
        threadCount: 12,
        keptInPlaceCount: target.includes("other") ? 3 : 0,
        reboundWorktreeCount: 2,
        activeThreads: target.includes("busy") ? [{ id: "t1", title: "Fix budget totals" }] : [],
        specweaveWorkspace: true,
      },
    };
  }
  if (command === "update" && args.input.workspaceSettings) {
    Object.assign(settings, args.input.workspaceSettings, { revision: settings.revision + 1 });
  }
  if (command === "environmentPrepare")
    return {
      _tag: "Success",
      value: {
        revision: ++settings.revision,
        workspaceRoot: project.workspaceRoot,
        ...settings.environment,
        repositories: settings.environment.repositories.map((r) => ({ ...r, status: "ready" })),
      },
    };
  if (command === "connectionSave") {
    const value = {
      id: args.input.id,
      ...args.input.config,
      revision: (args.input.expectedRevision ?? 0) + 1,
      status: "configured",
      checkedAt: null,
      tools: [],
      allowedTools: args.input.allowedTools,
    };
    const index = connections.findIndex((c) => c.id === value.id);
    if (index < 0) connections.push(value);
    else connections[index] = value;
    return { _tag: "Success", value };
  }
  if (command === "connectionCheck" || command === "connectionRevoke") {
    const value = connections.find((c) => c.id === args.input.id);
    Object.assign(value, {
      revision: value.revision + 1,
      status: command === "connectionCheck" ? "ready" : "revoked",
      checkedAt: "2026-10-09T12:00:00Z",
      tools: [
        { name: "search_documents", description: "Search this host's documents", inputSchema: {} },
      ],
    });
    return { _tag: "Success", value };
  }
  return { _tag: "Success", value: { threadId: "coord", created: false } };
};
// Any atom or command the fixture does not model resolves to an inert query or command.
const withFallback = <T extends object>(known: T): T =>
  new Proxy(known, {
    get: (target, key) =>
      key in target || typeof key !== "string"
        ? (target as Record<PropertyKey, unknown>)[key]
        : Object.assign(() => ({ kind: key }), { toString: () => key }),
  }) as T;
export const projectWorkspace = withFallback({
  environmentRead: () => ({ kind: "environment" }),
  environmentPrepare: "environmentPrepare",
  connections: () => ({ kind: "connections" }),
  connectionSave: "connectionSave",
  connectionCheck: "connectionCheck",
  connectionRevoke: "connectionRevoke",
  read: () => ({ kind: "read" }),
  starterSuggestions: () => ({ kind: "starters" }),
  threadReports: () => ({ kind: "threadReports" }),
  threadIncrementProgress: () => ({ kind: "threadIncrementProgress" }),
  threadReportSave: "threadReportSave",
  memoryRead: () => ({ kind: "memory" }),
  usage: () => ({ kind: "usage" }),
  send: "send",
  memoryWrite: "memoryWrite",
  memoryDelete: "memoryDelete",
});
export const projectEnvironment = withFallback({
  update: "update",
  delete: "delete",
  folderCheck: "folderCheck",
  changeFolder: "changeFolder",
});
export const serverEnvironment = withFallback({
  scheduledTasksLive: () => ({ kind: "routines" }),
  setScheduledTaskEnabled: "routineToggle",
  runScheduledTaskNow: "routineRun",
});
export const threadEnvironment = withFallback({
  loadEarlierHistory: "history",
  updateMetadata: "update-metadata",
  interruptTurn: "interruptTurn",
});
export const useThreadActions = () => ({
  settleThread: (ref) => settleFixture(ref, "settled"),
  unsettleThread: (ref) => settleFixture(ref, "active"),
  unarchiveThread: (ref) => {
    const restored = historyShells.find((s) => s.id === ref.threadId);
    if (restored) {
      historyShells = historyShells.filter((s) => s.id !== ref.threadId);
      shells = [...shells, { ...restored, archivedAt: null }];
      shellListeners.forEach((notify) => notify());
    }
    return { _tag: "Success", value: undefined };
  },
});
export const isElectron = false;
export const useNavigate = () => () => {};
export const useParams = () => ({});
export const Link = ({ children, to, ...props }) => <a href={to}>{children}</a>;
export const WorkspacePageHeader = ({ children, className }) => (
  <header className={`flex items-center px-5 ${className}`}>{children}</header>
);
export const SidebarInset = ({ children, className }) => (
  <main className={`flex flex-col ${className}`}>{children}</main>
);
export const ProjectModels = ({ label, value }) => (
  <fieldset className="project-model-field">
    <legend>{label}</legend>
    <select defaultValue={value?.model ?? ""}>
      <option>{value?.model ?? "Choose an available model"}</option>
    </select>
  </fieldset>
);
/* The thread's right panel as the native ChatView decides it: the real panel store
   (saved per thread, restored on load) and the real leave hook, with a plain
   stand-in for the tabs. "Open a surface" is the launcher a panel with no tab shows. */
function ThreadRightPanelFixture({ environmentId, threadId }) {
  const threadRef = React.useMemo(
    () => scopeThreadRef(environmentId, threadId),
    [environmentId, threadId],
  );
  useHideRightPanelOnLeave(threadRef);
  const panel = useRightPanelStore((state) =>
    selectThreadRightPanelState(state.byThreadKey, threadRef),
  );
  const active = panel.surfaces.find((surface) => surface.id === panel.activeSurfaceId) ?? null;
  const toggleVisibility = useRightPanelStore((state) => state.toggleVisibility);
  const open = useRightPanelStore((state) => state.open);
  const openBrowser = useRightPanelStore((state) => state.openBrowser);
  const reconcileBrowserSurfaces = useRightPanelStore((state) => state.reconcileBrowserSurfaces);
  return (
    <>
      <div className="flex gap-2">
        <button onClick={() => toggleVisibility(threadRef)}>Toggle right panel</button>
        <button onClick={() => open(threadRef, "diff")}>Open changes</button>
        <button onClick={() => openBrowser(threadRef, "fixture-tab")}>Open browser</button>
        <button onClick={() => reconcileBrowserSurfaces(threadRef, [])}>End browser session</button>
      </div>
      {panel.isOpen ? (
        <aside aria-label="Thread right panel" data-tabs={panel.surfaces.length}>
          {active === null ? <span>Open a surface</span> : <span>Tab {active.kind}</span>}
        </aside>
      ) : null}
    </>
  );
}
export function NativeThreadFixture({ environmentId, threadId, transcriptOnly = false }) {
  const routing = useProjectMessageRouting();
  const selected = useContext(SelectedThreadShell);
  const live =
    useThreadShells().find((s) => s.environmentId === environmentId && s.id === threadId) ?? null;
  const readable = resolveSelectedThreadShell({ environmentId, threadId }, live, selected);
  const [prompt, setPrompt] = useState("");
  // A subagent's peek: its transcript only, with no composer.
  if (transcriptOnly) {
    const task = fixtureSubagents.find((agent) => agent.childThreadId === threadId);
    return (
      <div className="flex flex-col p-5 gap-4" data-transcript-only="true">
        <small>Native thread fixture · {threadId}</small>
        <div className="self-end max-w-[80%] rounded-2xl bg-message p-3 text-message-foreground">
          {task?.prompt ?? `Task for ${live?.title ?? threadId}`}
        </div>
        <p>Ran 12 commands and read 4 files.</p>
        {task?.result ? <p>{task.result}</p> : <p>Still working…</p>}
      </div>
    );
  }
  return (
    <div className="flex flex-col p-5 gap-4">
      <small>Native thread fixture · {threadId}</small>
      {historyFixture ? (
        <p data-history-readable={!!readable}>
          {readable
            ? "Saved investigation: the calculator result was verified."
            : "No active thread"}
        </p>
      ) : (
        <p>Thread history and provider controls remain independent.</p>
      )}
      <ThreadRightPanelFixture environmentId={environmentId} threadId={threadId} />
      <form
        className="mt-auto"
        onSubmit={(e) => {
          e.preventDefault();
          void routeProjectComposerSend(routing, {
            prompt,
            hasOtherContent: false,
            nativeInput: false,
            clear: () => setPrompt(""),
            reportError: alert,
          });
        }}
      >
        <textarea
          aria-label="Worker reply"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          className="border p-3 w-full"
        />
        <button>Send worker reply</button>
      </form>
    </div>
  );
}
// Chat markdown, minus everything but paragraphs, bold and thread links. Links resolve like the real
// renderer's: the page's own renderer first, else the standard thread chip.
const FIXTURE_INLINE =
  /(\[[^\]]+\]\((?:studio-context:\/\/v1\/thread\/|studio:\/\/thread\/)[^)\s]+\)|\*\*[^*]+\*\*)/;
export function MarkdownFixture({ text, renderContextReference, renderThreadLink, environmentId }) {
  // Paragraphs, thread links and **bold**: enough Markdown to judge the turn layout.
  return (
    <div className="chat-markdown">
      {text.split(/\n\n+/).map((paragraph, p) => (
        <p key={p} className="leading-7">
          {paragraph.split(FIXTURE_INLINE).map((part, index) => {
            const context = /^\[([^\]]+)\]\(studio-context:\/\/v1\/thread\/([^)]+)\)$/.exec(part);
            if (context)
              return (
                <span key={index}>
                  {renderContextReference({
                    kind: "thread",
                    contextId: decodeURIComponent(context[2]),
                    label: context[1],
                  })}
                </span>
              );
            const link = /^\[([^\]]+)\]\((studio:\/\/thread\/[^)]+)\)$/.exec(part);
            const candidates = link ? parseStudioThreadHref(link[2]) : null;
            if (candidates)
              return (
                <span key={index}>
                  {renderThreadLink?.({ candidates, label: link[1] }) ?? (
                    <StudioThreadLink
                      environmentId={environmentId ?? "host"}
                      candidates={candidates}
                      label={link[1]}
                    />
                  )}
                </span>
              );
            const bold = /^\*\*([^*]+)\*\*$/.exec(part);
            return bold ? <strong key={index}>{bold[1]}</strong> : part;
          })}
        </p>
      ))}
    </div>
  );
}

export const useArchivedThreadSnapshots = () => {
  const history = useSyncExternalStore(subscribeShells, () => historyShells);
  return {
    snapshots: history.length
      ? [
          {
            environmentId: "host",
            snapshot: {
              threads: history.map((s) => ({
                ...s,
                createdAt: DateTime.makeUnsafe(s.createdAt ?? s.updatedAt),
                updatedAt: DateTime.makeUnsafe(s.updatedAt),
                archivedAt: DateTime.makeUnsafe(s.archivedAt),
                deletedAt: null,
                settledAt: null,
                latestRunId: null,
                latestUserMessageAt: null,
                activeProviderThreadId: null,
                pendingRuntimeRequest: null,
                status: "idle",
              })),
            },
          },
        ]
      : [],
    error: null,
    isLoading: false,
    refresh: () => {},
  };
};

export const useAssetUrlState = () => ({ _tag: "Loading" });
export const useAssetUrlRefresh = () => async () => null;
export const AttachmentFilePreview = () => <p>Attachment preview fixture</p>;
export const ReadOnlySourcePreview = () => <p>Source preview fixture</p>;

/* Connected hosts for the per-machine limits: the project's device, a second
   Mac signed in to the same Claude account, and an offline laptop. */
const inHours = (hours) => new Date(Date.now() + hours * 3_600_000).toISOString();
const fixtureProvider = (driver, overrides = {}) => ({
  instanceId: driver,
  driver,
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: inHours(0),
  models: [],
  slashCommands: [],
  skills: [],
  ...overrides,
});
const windowsOf = (session, weekly) => ({
  checkedAt: new Date(Date.now() - 4 * 60_000).toISOString(),
  windows: [
    {
      id: "five_hour",
      kind: "session",
      label: "5-hour",
      usedPercent: session,
      resetsAt: inHours(2.4),
      windowDurationMins: 300,
    },
    {
      id: "seven_day",
      kind: "weekly",
      label: "Weekly",
      usedPercent: weekly,
      resetsAt: inHours(70),
      windowDurationMins: 10080,
    },
  ],
});
const fixtureHosts = new Map([
  [
    "host",
    {
      entry: { target: { label: "Development Mac" } },
      connection: { phase: "connected", error: null, traceId: null },
      serverConfig: {
        providers: [
          fixtureProvider("claudeAgent", {
            auth: { status: "authenticated", email: "dev@example.com", label: "Max 20x" },
            usageLimits: { ...windowsOf(42, 61), resetCredits: { availableCount: 1 } },
          }),
          fixtureProvider("codex", {
            auth: { status: "authenticated", email: "dev@example.com", label: "Pro" },
            usageLimits: windowsOf(12, 33),
          }),
          fixtureProvider("acpRegistry", {
            instanceId: "github-copilot-cli",
            displayName: "GitHub Copilot",
          }),
          fixtureProvider("grok", {
            auth: { status: "authenticated", label: "SuperGrok" },
            usageLimits: {
              checkedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
              windows: [],
              unavailable: {
                reason: "unsupported",
                message: "Grok does not report subscription windows.",
              },
            },
          }),
        ],
      },
    },
  ],
  [
    "studio-m3",
    {
      entry: { target: { label: "M3" } },
      connection: { phase: "connected", error: null, traceId: null },
      serverConfig: {
        providers: [
          fixtureProvider("claudeAgent", {
            auth: { status: "authenticated", email: "dev@example.com", label: "Max 20x" },
            usageLimits: windowsOf(42, 61),
          }),
          fixtureProvider("codex", {
            auth: { status: "authenticated", email: "second@example.com", label: "Plus" },
            usageLimits: windowsOf(88, 97),
          }),
        ],
      },
    },
  ],
  [
    "studio-m1",
    {
      entry: { target: { label: "M1" } },
      connection: { phase: "offline", error: null, traceId: null },
      serverConfig: null,
    },
  ],
]);
export const environmentPresentations = {
  presentationsAtom: Atom.make(fixtureHosts),
  presentationAtom: (id) => Atom.make(fixtureHosts.get(id) ?? null),
};
export const environmentSummaries = fixtureAnything("environmentSummaries");
export const useEnvironmentPresentation = fixtureAnything("useEnvironmentPresentation");
// Router pieces the shell reaches for; the fixture is one page with nowhere to go.
export const useLocation = () => ({ pathname: "/", search: {}, hash: "" });
export const useRouter = () => ({
  navigate: () => {},
  state: { location: { pathname: "/", search: {}, hash: "" } },
});
export const useSearch = () => ({});
export const useMatch = () => undefined;
export const useRouterState = () => ({ location: { pathname: "/", search: {}, hash: "" } });

// Shell, environment and session reads the workspace gained after this fixture was written.
const fixtureAtoms = new Map();
const fixtureAtom = (key, value) => {
  if (!fixtureAtoms.has(key)) fixtureAtoms.set(key, Atom.make(value));
  return fixtureAtoms.get(key);
};
export const primaryServerKeybindingsAtom = fixtureAtom("keybindings", []);
export const environmentServerConfigsAtom = fixtureAtom("serverConfigs", new Map());
export const environmentSession = {
  initialConfigValueAtom: (id) => fixtureAtom(`config:${id}`, null),
  preparedConnectionValueAtom: (id) => fixtureAtom(`connection:${id}`, Option.none()),
  sessionStateAtom: (id) => fixtureAtom(`session:${id}`, AsyncResult.initial()),
};
export const primaryServerSettingsAtom = fixtureAtom("serverSettings", DEFAULT_SERVER_SETTINGS);
export const readEnvironmentScope = () => true;
export const readPreparedConnection = () => (recovery ? { httpBaseUrl: location.origin } : null);
export const usePreparedConnection = () => Option.none();
export const useAllEnvironmentShellsBootstrapped = () => true;
export const useEnvironments = () => ({
  isReady: true,
  environments: [],
  presentationById: new Map(),
});
export const usePrimaryEnvironmentId = () => (fallbackFixture ? "this-mac" : "host");
export const usePrimaryEnvironment = () => ({ environmentId: "host" });
export const useServerConfigs = () => new Map();
export const environmentProjects = fixtureAnything("environmentProjects");
export const environmentThreadDetails = fixtureAnything("environmentThreadDetails");
export const environmentThreadShells = fixtureAnything("environmentThreadShells");
export const projectContentSearch = fixtureAnything("projectContentSearch");
export const readProjects = fixtureAnything("readProjects");
export const readThreadShell = fixtureAnything("readThreadShell");
export const useThreadShell = (ref) =>
  useThreadShells().find(
    (shell) => shell.environmentId === ref?.environmentId && shell.id === ref?.threadId,
  ) ?? null;
export const readEnvironmentSupportsAutoSettleOptOut = fixtureAnything(
  "readEnvironmentSupportsAutoSettleOptOut",
);
export const readEnvironmentSupportsPinning = fixtureAnything("readEnvironmentSupportsPinning");
export const readEnvironmentSupportsSettlement = fixtureAnything(
  "readEnvironmentSupportsSettlement",
);
export const readEnvironmentSupportsSnooze = fixtureAnything("readEnvironmentSupportsSnooze");
export const readEnvironmentSupportsTitleRegeneration = fixtureAnything(
  "readEnvironmentSupportsTitleRegeneration",
);

// Coordinator recovery uses production asset resolution and staging logic with host operations faked.
window.__recoveryUploads = [];
window.__recoveryAssets = [];
window.__recoveryReleases = [];
window.__recoveryPendingReads = [];
export const assetEnvironment = { createUrl: "recoveryAsset" };
export const useAtomQueryRunner = () => async (target) => {
  window.__recoveryAssets.push(target);
  if (recovery === "missing" && target.input.resource.attachmentId === "captured-notes")
    return { _tag: "Failure" };
  const result = {
    _tag: "Success",
    value: {
      relativeUrl: "data:application/octet-stream;base64,YWJj",
      expiresAt: Date.now() + 60000,
    },
  };
  return recovery === "pending-read"
    ? new Promise((resolve) => window.__recoveryPendingReads.push(() => resolve(result)))
    : result;
};
export const useAttachmentUploadStore = (select) => select({ uploadsByImageId: {} });
export const startAttachmentUpload = ({ environmentId, image }) => {
  window.__recoveryUploads.push({
    environmentId,
    id: image.id,
    type: image.type,
    name: image.name,
    sizeBytes: image.file.size,
  });
};
export const awaitAttachmentUploads = async () => {
  await new Promise((resolve) => setTimeout(resolve, 40));
};
export const getUploadedAttachments = ({ images }) =>
  recovery === "upload-failure"
    ? null
    : images.map((image, i) => ({
        type: image.type,
        id: `pending-restored-${i}`,
        name: image.name,
        mimeType: image.mimeType,
        sizeBytes: image.sizeBytes,
      }));
export const releaseDraftAttachment = (attachment) => window.__recoveryReleases.push(attachment.id);
export const projectFaviconUrlAtom = () => Atom.make(null);
export const EMPTY_SERVER_PROVIDERS = [];

export const useEnvironmentSettings = () => ({
  ...DEFAULT_SERVER_SETTINGS,
  providers: {
    ...DEFAULT_SERVER_SETTINGS.providers,
    codex: { ...DEFAULT_SERVER_SETTINGS.providers.codex, enabled: true },
    claudeAgent: { ...DEFAULT_SERVER_SETTINGS.providers.claudeAgent, enabled: true },
  },
  providerInstances: {
    codex: { driver: "codex", enabled: true, config: {} },
    claudeAgent: { driver: "claudeAgent", enabled: true, config: {} },
    "github-copilot-cli": {
      driver: "acpRegistry",
      enabled: true,
      config: { source: "registry", agentId: "github-copilot-cli" },
    },
  },
});

export const formatEnvironmentQueryError = () => "The environment request failed.";
