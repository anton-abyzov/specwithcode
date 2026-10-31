import * as fixtureData from "./mockData";
export { project, TUTORIALS_ID } from "./mockData";
const {
  recovery,
  recoveryFailureId,
  fresh,
  failedTurn,
  minutesAgo,
  legacy,
  starters,
  project,
  settings,
  memory,
  totals,
  scaledTotals,
  TUTORIALS_ID,
  activity,
  savedReports,
  reportSnapshot,
  shell,
  subagentsFixture,
  fixtureSubagents,
  fallbackFixture,
  fallbackProjection,
  mentionFixture,
  mentionProjection,
  baseThreadProjection,
  applySubagentScenario,
} = fixtureData;
import { INTERNAL_RECEIPTS } from "../agent-messages/internalReceipts";
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
import { routineTasks } from "./routines-fixture";
import { ENOSPC_REPORT, MERGE_RECEIPT } from "../agent-messages/payloads";
import {
  knowledgeLoadedAt,
  knowledgeReindex,
  knowledgeSearchResult,
  knowledgeServerConfig,
  knowledgeStatus,
} from "./knowledge-fixture";
let shells = recovery
  ? [
      shell("coord", "Project coordinator", {
        latestRun: { runId: recoveryFailureId, status: "failed" },
        runtime: {
          lastError:
            recovery === "full-access"
              ? "The previous provider session ended before answering. Retry the message."
              : "This provider cannot enforce additional project folder access. Choose a Codex, Claude or Muse Code coordinator for this project.",
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
    // Lives here, runs on the Minis after a handoff.
    shell("moved-worker", "Run the importer benchmark on Linux", {
      createdBy: "agent",
      runtime: { status: "running" },
      source: {
        ownerMachineId: "host",
        executionMachineId: "minis",
        executionMachineLabel: "Anton's Minis",
        executionState: "running",
      },
    }),
    // Its execution machine stopped answering.
    shell("unknown-worker", "Rebuild the search index", {
      createdBy: "agent",
      runtime: { status: "running" },
      source: {
        ownerMachineId: "host",
        executionMachineId: "minis",
        executionMachineLabel: "Anton's Minis",
        executionState: "unknown",
        executionLastSeenAt: "2026-10-20T21:14:00Z",
      },
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
shells = applySubagentScenario(shells);
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
// `?switch`: a second project, so the check can leave Atlas for it and come back.
const beaconProject = {
  ...project,
  id: "project-beacon",
  title: "Beacon",
  workspaceRoot: "/scratch/beacon",
};
const switchFixture = new URLSearchParams(window.location.search).has("switch");
export const useSettingsProjectGroups = () => [
  {
    projectKey: "atlas",
    memberProjects: memberProjects.map((member) => ({
      ...member,
      environmentLabel: machineLabels[member.environmentId],
    })),
  },
  ...(switchFixture
    ? [
        {
          projectKey: "beacon",
          memberProjects: [{ ...beaconProject, environmentLabel: machineLabels.host }],
        },
      ]
    : []),
];
const allProjects = switchFixture ? [...memberProjects, beaconProject] : memberProjects;
export const useProjects = () => allProjects;
export const useProject = (ref) =>
  ref === null
    ? null
    : (allProjects.find(
        (project) => project.environmentId === ref.environmentId && project.id === ref.projectId,
      ) ?? null);
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
if (fallbackFixture) {
  project.workspaceSettings = {
    ...settings,
    coordinatorModelSelection: { instanceId: "claudeAgent", model: "claude-opus-5-5" },
  };
  // `?fallback=gemini`: the October 22 live case. Claude reads as having room, but the
  // host keeps the coordinator on Gemini CLI; the composer must still name Gemini.
  const fallbackModel =
    new URLSearchParams(window.location.search).get("fallback") === "gemini"
      ? { instanceId: "acpRegistry_gemini", model: "default" }
      : { instanceId: "codex", model: "gpt-6.1-sol" };
  shells = shells.map((s) => (s.id === "coord" ? { ...s, modelSelection: fallbackModel } : s));
}
if (mentionFixture)
  shells = [
    shell("coord", "Project coordinator"),
    shell("thread:delegated-task:command%3Amcp%3Arelease-chrome", "Release Chrome extension", {
      createdBy: "agent",
    }),
    shell("docs", "Docs", { createdBy: "agent" }),
  ];
/* `?stream`: a long coordinator conversation that the check grows while a
   reader is scrolled up. `window.__streamPush` adds a message and
   `window.__streamUpdate` rewrites one, the way streamed text arrives. */
const streamFixture = new URLSearchParams(window.location.search).has("stream");
// `?switch` makes it longer than the coordinator's mounted window, with older history on the host.
let streamMessages = Array.from({ length: switchFixture ? 80 : 24 }, (_, index) => ({
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
let attentionCoordinatorProjection = null;
const fixtureThreadProjection = (ref) => {
  if (ref?.threadId === "coord" && attentionCoordinatorProjection)
    return attentionCoordinatorProjection;
  // The fixture mode never changes on a page, so the hook order is stable.
  if (streamFixture) return useSyncExternalStore(subscribeStream, () => streamProjection);
  if (fallbackFixture) return { projection: fallbackProjection };
  if (mentionFixture) return { projection: mentionProjection };
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
// The projections here predate runtime requests in a thread's projection: none are pending.
const withRequests = new WeakMap();
export const useThreadProjection = (ref) => {
  const result = fixtureThreadProjection(ref);
  const projection = result?.projection;
  if (!projection || projection.runtimeRequests) return result;
  if (!withRequests.has(projection))
    withRequests.set(projection, { runtimeRequests: [], ...projection });
  return { ...result, projection: withRequests.get(projection) };
};
export const useThreadHistory = () => ({ hasMoreHistory: switchFixture, loading: false });
export const useThreadStatus = () => "live";
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
  ...(knowledgeServerConfig ? { serverConfig: knowledgeServerConfig } : {}),
});
export const useEnvironmentScope = () => true;
// The fixture host's shell is always live.
export const useEnvironmentShellLive = (environmentId) => environmentId !== null;
// Threads never move between projects in this fixture.
export const waitForThreadMoveOutcome = async () => null;
export const useEnvironmentScopeAccess = () => "granted";
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
              name: q.name ?? "MEMORY.md",
              content:
                q.name && q.name !== "MEMORY.md"
                  ? `# ${q.name}\n\nRecorded during the project review.\n\n- Keep one file per subject.\n- Update it instead of adding a dated copy.`
                  : "Use independent providers per thread. Decisions stay in this project.",
              revision: 3,
              byteLength: 128,
            }
          : q?.kind === "usage"
            ? {
                totals,
                readAt: new Date().toISOString(),
                coverage: {
                  threads: 6,
                  threadsWithUsage: 5,
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
                    { provider: "claude", model: "claude-opus-5-5[1m]", totals: scaledTotals(2.2) },
                    { provider: "codex", model: "gpt-5.5", totals: scaledTotals(0.7) },
                    { provider: "copilot", model: null, totals: scaledTotals(0.1) },
                  ],
                  daily: Array.from({ length: 20 }, (_, back) => {
                    const date = new Date(Date.now() - (back + 1) * 86_400_000);
                    const day = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
                    return {
                      day,
                      provider: "claude",
                      model: "claude-opus-5-5",
                      totalTokens: back % 3 === 0 ? 0 : 3000 + back * 300,
                    };
                  }).filter((row) => row.totalTokens > 0),
                },
                // The same model under two spellings, an ACP Grok agent and a run that
                // never reported its model: the tab must merge, name and fold them.
                threads: shells.map((s, i) => {
                  const share = i === 0 ? 0.08 : i === 5 ? 0 : 0.23;
                  const rows: [string, string, string | null, number][] =
                    i === 0
                      ? [["claudeAgent", "claude", "claude-opus-5.5", 0.08]]
                      : i === 5
                        ? []
                        : i === 1
                          ? [
                              ["claudeAgent", "claude", "claude-opus-5-5", 0.15],
                              ["acpRegistry", "acp-grok-cli", "grok-code-fast-1", 0.05],
                              ["codex", "codex", null, 0.03],
                            ]
                          : [["codex", "codex", "gpt-5.5", 0.23]];
                  return {
                    threadId: s.id,
                    title: s.title,
                    role: i === 0 ? "coordinator" : "worker",
                    share: i === 5 ? null : share,
                    totals: scaledTotals(share),
                    archived: !!s.archivedAt,
                    models: rows.map(([provider, providerInstanceId, model, part]) => ({
                      provider,
                      providerInstanceId,
                      model,
                      totals: scaledTotals(part),
                    })),
                  };
                }),
                daily: Array.from({ length: 24 }, (_, back) => {
                  const date = new Date(Date.now() - back * 86_400_000);
                  const day = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
                  const wave = Math.round(
                    4000 + 3500 * Math.sin(back / 2.5) + (back % 7 === 0 ? 6000 : 0),
                  );
                  return [
                    {
                      day,
                      role: "coordinator",
                      provider: "claudeAgent",
                      providerInstanceId: "claude",
                      model: "claude-opus-5.5",
                      totalTokens: Math.round(wave * 0.3),
                    },
                    {
                      day,
                      role: "worker",
                      provider: "codex",
                      providerInstanceId: "codex",
                      model: "gpt-5.5",
                      totalTokens: Math.max(0, wave),
                    },
                  ];
                }).flat(),
              }
            : q?.kind === "routines"
              ? { tasks: routineTasks() }
              : q?.kind === "threadIncrementProgress"
                ? { threads: [] }
                : q?.kind === "starters"
                  ? starters
                  : q?.kind === "threadReports"
                    ? reportSnapshot()
                    : q?.kind === "read" || q?.kind === undefined
                      ? {
                          // `?switch`: Beacon has a coordinator of its own.
                          settings:
                            q?.projectId === beaconProject.id
                              ? { ...settings, coordinatorThreadId: "beacon-coord" }
                              : settings,
                          memory: fresh !== null ? { files: [], totalBytes: 0 } : memory,
                          // Real VCS status atoms land here too: an empty working tree.
                          workingTree: { files: [] },
                          // And the real design list: a project with no designs.
                          designs: [],
                          problems: [],
                        }
                      : q?.kind === "knowledge"
                        ? knowledgeStatus()
                        : undefined,
  dataUpdatedAt: knowledgeLoadedAt,
  error: null,
  refresh: () => {},
  isPending: false,
});
window.__projectCalls = [];
export const useAtomCommand = (command) => async (args) => {
  window.__projectCalls.push({ command, args });
  if (command === "knowledgeSearch")
    return { _tag: "Success", value: knowledgeSearchResult(args.input.query) };
  if (command === knowledgeReindex) return { _tag: "Success", value: knowledgeStatus("indexing") };
  if (command === "memoryFetch")
    return {
      _tag: "Success",
      value: { name: args.input.name, content: `# ${args.input.name}\n`, revision: 1 },
    };
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
  if (command === "worktreesRead") {
    const root = "/Users/me/.specwithcode/worktrees/atlas";
    const worktree = (name, status, sizeBytes, localCommits, detail = null) => ({
      path: `${root}/${name}`,
      branch: name,
      threadCount: 1,
      sizeBytes,
      localCommits,
      status,
      detail,
    });
    return {
      _tag: "Success",
      value: {
        projectId: args.input.projectId,
        worktrees: [
          worktree("budget-totals", "removable", 6_200_000_000, 2),
          worktree("landing-review", "removable", 5_800_000_000, 0),
          worktree(
            "release-notes",
            "local_changes",
            1_100_000_000,
            0,
            "It has uncommitted, untracked or ignored files. Removing it deletes them.",
          ),
          worktree(
            "shared-docs",
            "in_use",
            900_000_000,
            0,
            'The thread "Docs refresh" uses it and is not being deleted, so it is kept.',
          ),
        ],
      },
    };
  }
  if (command === "threadsDelete")
    return {
      _tag: "Success",
      value: { projectId: args.input.projectId, deletedThreadIds: ["thread-a", "thread-b"] },
    };
  if (command === "worktreesRemove")
    return {
      _tag: "Success",
      value: { projectId: args.input.projectId, removed: args.input.paths, kept: [] },
    };
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
  read: (args) => ({ kind: "read", projectId: args?.input?.projectId }),
  starterSuggestions: () => ({ kind: "starters" }),
  threadReports: () => ({ kind: "threadReports" }),
  threadIncrementProgress: () => ({ kind: "threadIncrementProgress" }),
  threadReportSave: "threadReportSave",
  memoryRead: (args) => ({ kind: "memory", name: args?.input?.name }),
  usage: () => ({ kind: "usage" }),
  send: "send",
  memoryWrite: "memoryWrite",
  memoryDelete: "memoryDelete",
  memoryFetch: "memoryFetch",
  knowledge: () => ({ kind: "knowledge" }),
  knowledgeSearch: "knowledgeSearch",
  knowledgeReindex,
});
export const projectEnvironment = withFallback({
  update: "update",
  delete: "delete",
  folderCheck: "folderCheck",
  changeFolder: "changeFolder",
  worktreesRead: "worktreesRead",
  worktreesRemove: "worktreesRemove",
  threadsDelete: "threadsDelete",
});
// Voice settings and file menus read the host's config; the fixture's host has none loaded.
const noServerConfig = Atom.make(null);
export const primaryServerConfigAtom = noServerConfig;
export const serverEnvironment = withFallback({
  scheduledTasksLive: () => ({ kind: "routines" }),
  configValueAtom: () => noServerConfig,
  updateSettings: "updateSettings",
  setScheduledTaskEnabled: "routineToggle",
  runScheduledTaskNow: "routineRun",
  upsertScheduledTask: "routineSave",
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
export const useNavigate = () => (target) => {
  window.__attentionNavigation = target;
};
export const useParams = () => ({});
// Resolves `$param` segments like the router, so a check can read where a link goes.
export const Link = ({ children, to, params, search, className, ...rest }) => {
  const path = String(to).replace(/\$(\w+)/g, (_, key) =>
    encodeURIComponent(String(params?.[key] ?? `$${key}`)),
  );
  const data = Object.fromEntries(Object.entries(rest).filter(([key]) => key.startsWith("data-")));
  return (
    <a
      href={search ? `${path}?${new URLSearchParams(search)}` : path}
      className={className}
      {...data}
    >
      {children}
    </a>
  );
};
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

export const refreshArchivedThreadsForEnvironment = (environmentId: string) => {
  (window as unknown as { __projectCalls: unknown[] }).__projectCalls.push({
    command: "refreshArchived",
    args: environmentId,
  });
};
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
          // Only the live-case fixture adds Gemini; other checks count these providers.
          ...(new URLSearchParams(window.location.search).get("fallback") === "gemini"
            ? [
                fixtureProvider("acpRegistry", {
                  instanceId: "acpRegistry_gemini",
                  displayName: "Gemini CLI",
                  models: [{ slug: "default", name: "Default", isCustom: false }],
                }),
              ]
            : []),
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
export const useLocation = (options?: { select?: (location: object) => unknown }) => {
  const location = { pathname: "/", search: {}, hash: "", href: "/" };
  return options?.select ? options.select(location) : location;
};
export const useRouter = () => ({
  navigate: () => {},
  state: { location: { pathname: "/", search: {}, hash: "" } },
});
// No search parameters; a selector (such as the pane deep link's) reads the empty set.
export const useSearch = (options?: { select?: (search: object) => unknown }) =>
  options?.select ? options.select({}) : {};
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
export const awaitEnvironmentScope = async () => true;
export const readPreparedConnection = () => (recovery ? { httpBaseUrl: location.origin } : null);
export const usePreparedConnection = () => Option.none();
export const useAllEnvironmentShellsBootstrapped = () => true;
// Every fixture host is reachable.
const NO_UNREACHABLE_ENVIRONMENTS: ReadonlySet<string> = new Set();
export const useUnreachableEnvironmentIds = () => NO_UNREACHABLE_ENVIRONMENTS;
export const useEnvironments = () => ({
  isReady: true,
  environments: new URLSearchParams(location.search).has("attention")
    ? [{ environmentId: "host", label: "Fixture host", connection: { phase: "connected" } }]
    : [],
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
export const readEnvironmentSupportsProjectMove = () => false;
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

// Live transport observations for the isolated fixture, never the installed app.
export const attentionShellAtom = Atom.make({
  snapshot: Option.some({ projects: [project] }),
  status: "live",
  error: Option.none(),
});
export const environmentShell = {
  stateValueAtom: () => attentionShellAtom,
  stateAtom: () => attentionShellAtom,
};
export const allEnvironmentProjectSnapshotsReadyAtom = Atom.make(true);
export const allEnvironmentShellsBootstrappedAtom = Atom.make(true);
export const attentionFixtureProject = {
  ...project,
  workspaceSettings: { coordinatorThreadId: "coord" },
};
export function setAttentionScenario(scenario: string) {
  const active = { runtime: { status: "running" } };
  const child = (id, parent, extra = {}) =>
    shell(id, id, {
      lineage: { parentThreadId: parent, relationshipToParent: "subagent", rootThreadId: parent },
      ...extra,
    });
  shells = [
    shell("coord", "Project coordinator"),
    ...[1, 2, 3, 4, 5].map((n) => shell(`worker-${n}`, `Worker ${n}`, n < 4 ? active : {})),
    child("child-4", "worker-4", active),
    child("child-5", "worker-5", active),
  ];
  attentionCoordinatorProjection = null;
  if (scenario === "coordinator-worker") {
    const now = DateTime.makeUnsafe("2026-10-27T12:00:00Z");
    attentionCoordinatorProjection = {
      projection: {
        ...baseThreadProjection().projection,
        updatedAt: now,
        thread: { id: "coord" },
        runtimeRequests: [
          {
            id: `${"update-reopen:".repeat(10)}ask-user:relay`,
            kind: "user_input",
            status: "pending",
            responseCapability: { type: "message" },
            createdAt: now,
          },
        ],
        turnItems: [
          {
            id: "old-question-card",
            type: "user_input_request",
            threadId: "coord",
            requestId: `${"update-reopen:".repeat(10)}ask-user:relay`,
            responseMode: "message",
            status: "waiting",
            runId: "old-run",
            ordinal: 1,
            questions: [
              {
                id: "q1",
                header: "Owner relay",
                question: "Can you relay the existing owner request?",
                options: [
                  {
                    label: "Relay through existing coordinator",
                    description: "Keep the current owner",
                  },
                ],
                allowCustomAnswer: true,
              },
            ],
          },
        ],
      },
    };
    shells[0] = { ...shells[0], hasPendingUserInput: true };
    shells[1] = { ...shells[1], runtime: null, hasPendingUserInput: true };
  }
  if (scenario === "coordinator") shells[0] = { ...shells[0], hasPendingUserInput: true };
  if (scenario === "disk-answer")
    shells = [
      shell("coord", "Project coordinator"),
      shell("worker-1", "Complete project work and disk audit", {
        hasPendingUserInput: true,
        source: {
          creationSource: "mcp",
          pendingRuntimeRequest: { id: "0748-recipient", kind: "user_input", createdAt: null },
        },
      }),
      child("old-review", "worker-1", {
        title: "Review 0734 and 0850 closure",
        reportedBlocker: "For 0734 AC-US6-04, do you waive it?",
        source: { creationSource: "mcp", pendingRuntimeRequest: null },
      }),
    ];
  if (scenario === "children")
    shells = shells.map((s) =>
      s.id.startsWith("child-")
        ? { ...s, lineage: { ...s.lineage, parentThreadId: "worker-4" }, hasPendingUserInput: true }
        : s,
    );
  if (scenario === "signin")
    shells[1] = {
      ...shells[1],
      source: {
        pendingRuntimeRequest: {
          id: "auth-1",
          kind: "auth_refresh",
          createdAt: DateTime.makeUnsafe(Date.now()),
        },
      },
    };
  if (scenario === "held") shells[4] = { ...shells[4], heldQueuedCount: 2 };
  if (scenario === "operational")
    shells = shells.map((s) => ({
      ...s,
      runtime: { status: "failed", lastErrorClass: "usage_limit" },
      reportedBlocker: "Waiting for CI",
    }));
  // October 26 screenshot: finished Claude Code subagents ending their reports
  // with Blockers, and a Muse check that failed on a provider limitation.
  if (scenario === "review-routing") {
    const native = (id, parent, title, extra = {}) =>
      child(id, parent, {
        title,
        source: {
          creationSource: "provider",
          pendingRuntimeRequest: null,
          nativeSubagentStatus: "completed",
          nativeSubagentCompletedAt: DateTime.makeUnsafe("2026-10-27T00:00:00Z"),
        },
        ...extra,
      });
    shells = [
      shell("coord", "Project coordinator"),
      shell("worker-1", "Usage-aware model picker", active),
      shell("worker-2", "Schedule Mac and mobile release"),
      shell("worker-3", "Release 1.0.35", {
        reportedBlocker: "Ship 1.0.35 today, or wait for the SQLite fix?",
      }),
      shell("worker-4", "1041 design create, reuse and pickers"),
      shell("worker-5", "Muse approval check (Accept) - 0922", {
        runtime: { status: "failed", lastErrorClass: "provider_error" },
      }),
      shell("wait-ci", "Rethink SpecWeave skills and DDD · 1093", {
        reportedWait: "Waiting for CI",
      }),
      shell("wait-review", "Independent review", {
        reportedBlocker: "Waiting for a fresh review of #899",
      }),
      shell("wait-merge", "Release dependency", { reportedWait: "Waiting for PR merge" }),
      shell("wait-child", "Parent awaiting worker", {
        runtime: { status: "waiting" },
        source: {
          activeWork: { waitThreadId: "child", label: "Review" },
          pendingRuntimeRequest: null,
        },
      }),
      native("child-1", "worker-1", "Close increment 1054", {
        runtime: { status: "waiting" },
        reportedBlocker: "You can close 1054 one of two ways.",
      }),
      native("child-2", "worker-2", "Code check for DB recovery path", {
        hasPendingApprovals: true,
        source: {
          creationSource: "provider",
          pendingRuntimeRequest: {
            id: "approval-1",
            kind: "command",
            createdAt: DateTime.makeUnsafe(Date.now()),
          },
        },
      }),
      native("child-4", "worker-4", "Fresh-context close review 1041", {
        reportedBlocker: "Close 1041 now, or wait for installed acceptance?",
      }),
      // October 27: a worker's delegate_task review from October 21.
      shell("worker-6", "Complete project work and disk audit"),
      child("child-6", "worker-6", {
        title: "Review 0734 and 0850 closure",
        source: { creationSource: "mcp", pendingRuntimeRequest: null },
        reportedBlocker: "Both increments should be blocked. Close them, or fix first?",
      }),
    ];
  }
  if (scenario === "resolved-child") shells[4] = { ...shells[4], settledOverride: "settled" };
  if (scenario === "resolved")
    shells[0] = { ...shells[0], hasPendingUserInput: true, settledOverride: "settled" };
  if (scenario === "archive")
    shells[0] = { ...shells[0], hasPendingUserInput: true, archivedAt: new Date().toISOString() };
  if (scenario === "delete")
    shells[0] = { ...shells[0], hasPendingUserInput: true, deletedAt: new Date().toISOString() };
  if (scenario === "pagination")
    shells.push(
      ...[6, 7, 8, 9, 10, 11].map((n) =>
        shell(`worker-${n}`, `Worker ${n}`, { hasPendingUserInput: true }),
      ),
    );
  shellListeners.forEach((notify) => notify());
}
if (new URLSearchParams(location.search).has("attention")) setAttentionScenario("baseline");
export const environmentSnapshotAtom = () => Atom.make(Option.none());
export const shellEnvironment = fixtureAnything("shellEnvironment");

export const attentionRemoteAtom = Atom.make({ workers: [], complete: true });
export const projectRemoteAttentionAtom = () => attentionRemoteAtom;

Object.assign(window, { internalReceiptTexts: INTERNAL_RECEIPTS });

// Test-only shell updates model acknowledged host events without issuing commands.
export function updateAttentionThread(id: string, changes: Record<string, unknown>) {
  shells = shells.map((thread) => (thread.id === id ? { ...thread, ...changes } : thread));
  shellListeners.forEach((notify) => notify());
}
// Connect discovery: this fixture reaches no relay.
export const useRelayEnvironmentDiscovery = () => ({
  environments: new Map(),
  refreshing: false,
  offline: false,
  error: { _tag: "None" },
});
