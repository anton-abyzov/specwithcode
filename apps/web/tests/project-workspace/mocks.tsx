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
import {
  knowledgeLoadedAt,
  knowledgeReindex,
  knowledgeSearchResult,
  knowledgeServerConfig,
  knowledgeStatus,
} from "./knowledge-fixture";
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
/* `?followups`: messages typed in workers before they went straight to the worker.
   One the coordinator only passed back to its own worker, which the conversation
   leaves out with its reply, and one it moved to another worker, which shows. */
const followups = new URLSearchParams(window.location.search).has("followups");
const followUpWrapper = (worker, id) =>
  `User follow-up from selected worker ${worker}, message ${id}. Review that thread and decide whether to reuse it or route elsewhere.\n\n`;
// Real projections carry DateTime values; the routed-message notes format them.
const followUpMessages = [
  {
    id: "coordinator-send:project:same",
    role: "user",
    createdBy: "user",
    senderThreadId: "review",
    text: followUpWrapper("review", "coordinator-send:project:same") + "marquee promo?",
    createdAt: DateTime.makeUnsafe(minutesAgo(6)),
    attachments: [],
  },
  {
    id: "f2",
    role: "assistant",
    text: "I passed your marquee promo tile question to [Review the landing page](studio://thread/review), and it has started on it.",
    createdAt: DateTime.makeUnsafe(minutesAgo(6, 7)),
    updatedAt: DateTime.makeUnsafe(minutesAgo(6, 7)),
    attachments: [],
  },
  {
    id: "coordinator-send:project:moved",
    role: "user",
    createdBy: "user",
    senderThreadId: "review",
    text:
      followUpWrapper("review", "coordinator-send:project:moved") +
      "Also rebuild the project memory index.",
    createdAt: DateTime.makeUnsafe(minutesAgo(3)),
    attachments: [],
  },
  {
    id: "f4",
    role: "assistant",
    text: "Moved to [Build project memory](studio://thread/build).",
    createdAt: DateTime.makeUnsafe(minutesAgo(3, 5)),
    updatedAt: DateTime.makeUnsafe(minutesAgo(3, 5)),
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
/** `?report&answer`: the worker answers a plain question directly instead, which stays in the chat. */
const answerFixture = new URLSearchParams(window.location.search).has("answer");
const ANSWER_TEXT = [
  "Both machines are back and the UI no longer freezes. The cause was one expired relay token, not two separate faults.",
  "",
  "At midnight the relay rotated its signing key. M1 and M3 kept their old token, so every heartbeat after that was rejected and the host marked both machines offline. The Threads pane asks each machine for its list when it opens, and it waited on those two dead sockets with no timeout. That wait ran on the same task that draws the pane, which is why clicking anywhere in the window did nothing for about forty seconds before the error finally came back and the pane redrew with both machines missing.",
  "",
  "What I changed:",
  "",
  "- Reconnected M1 and M3 with fresh tokens. Both answer heartbeats again and show as online.",
  "- Gave the per-machine thread list a five second timeout, so a machine that stops answering is shown as unreachable instead of holding up the pane.",
  "- Moved that request off the drawing task, so a slow machine can no longer freeze the window.",
  "- Made the relay accept the previous key for ten minutes after a rotation, so machines that are mid-heartbeat during a rotation are not dropped.",
  "",
  "I checked it by rotating the key by hand with all three machines connected. None of them dropped, and the Threads pane stayed responsive the whole time. I also unplugged M3 from the network while the pane was open: it turned grey within five seconds and the rest of the list kept working, and plugging it back in brought it back without a restart.",
  "",
  "Nothing needs you right now. If a machine still shows as offline after the next rotation tonight, restarting its SpecWithCode service will pick up a fresh token, and I would like to hear about it because it would mean the grace window is too short for that machine's heartbeat interval. The fix ships in the next build; until you update, the old behavior can come back after a rotation, and reconnecting the machine from Settings clears it the same way it did today.",
].join("\n");
const RELAY_TEXT = [
  "The review worker finished cycle 2 of 0973. Here is what it found:",
  "",
  ...Array.from(
    { length: 90 },
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
      text: answerFixture ? ANSWER_TEXT : REPORT_TEXT,
      createdAt: reportAgo(2),
      attachments: [],
    },
    {
      id: "r6",
      role: "assistant",
      text: [
        "The review's evidence:",
        "",
        "- [Variance walkthrough](/scratch/atlas/evidence/variance-walkthrough.mp4)",
        "- [Budget chart](/scratch/atlas/evidence/budget-vs-actuals.png)",
        "- [Closing notes](/scratch/atlas/evidence/closing-notes.md)",
      ].join("\n"),
      createdAt: reportAgo(1.5),
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
/**
 * `?payload`: workers write to the coordinator in dense agent shorthand: words
 * run together, a routing ID, a tool's options object, bare paths. Synthetic
 * text in the shape of real messages; nothing here names a real machine.
 */
const payloadFixture = new URLSearchParams(window.location.search).has("payload");
const PAYLOAD_DENSE = `Need exactEXISTINGbackend/canonical ownerbinding, no newworker. Userrequests research/updateALLseason5v5/8v8subtypes+3persistentfamiliesMonLeague5v5/TueLeague8v8/ThuCup5v5; categoryowner ${TUTORIALS_ID} has schema/catalogue readonlyauditsactive. Winter/Fallsuccessor explicitly505ONLY, excludes10canonical1009rows andallnewsubtype/family work. Original0952read-onlydisposition explicitlydoesNOTownhistoryAPI files; do NOTassignthembyassumption.1009threadposition745 canonicalacceptance came frommessage:mcp:0f3c9a1e-5b7d-4c2a-9e81-2d6f4b0a7c55:thread-send:plan-ack-2 but senderisnotverifiedthreadID. Asked1009to identify/forwardexistingcanonicalowner. Please bindexactexistingthreadRef androuteauditfindings for supportedAPI DRYRUNONLY afterschemaresults, preserve10rows exclusivity/awards/title/deductions, no505expansion/readprojection/DBwrites/newincrement/cap10/stabilitynextslotbypass. Allreleaseholdsunchanged. We must settleowneridentity before anydata preparation/write claim.`;
const PAYLOAD_LAUNCH = `1040 repository registration now exists at revision20. Latest instruction requires asking you before a new top-level writer. Approve one studio_thread_launch for existing increment1040, native Codex gpt-6-astra, workspaceStrategy {type:'worktree',repository:'7d1e2c40-5b8a-4f3e-9a61-0c2b8e4d9f17',baseRef:'main',branch:'fix/1040-project-attention-counts',startFromOrigin:true}, reportBack:true? Current thread cannot rebind. This writer would own remaining implementation/tests/review/PR; I retain coordination, no duplicate edits. Plan /scratch/atlas/.specweave/increments/1040-fix-project-badges/spec.md; audit /scratch/atlas/evidence/project-attention-1040/audit.md. Preserve1036 notification repair,1037 navigation,1039 review,1011 hold, and [Record the tutorials](studio://thread/${encodeURIComponent(TUTORIALS_ID)}) merge/release/installed ownership. All browser automation headless true with file evidence. No launch yet.`;
const PAYLOAD_JSON = [
  "Release check finished; the summary the checker wrote:",
  "",
  '{"status":"pass","checks":12,"failed":0,"head":"a1b2c3d","evidence":"/scratch/atlas/evidence/release-check.json"}',
  "",
  "Gate rows as they printed:",
  "",
  "```text",
  "ok    lint         0.8s",
  "ok    unit        41.2s",
  "ok    headless    63.0s",
  "```",
  "",
  "Options object for the next run, as the tool takes it (not JSON): {mode:'async', retries:2}. Nothing else changed; the branch is ready for the release owner to pick up when the freeze lifts, and I am stopping here.",
].join("\n");
const PAYLOAD_BLOCKED = `Publishing is held: the update feed signature check failed with "error: signature mismatch for latest-mac.yml (expected key 3F2A, got 9C1B)". I did not retry or re-sign. **Blockers:** approve re-signing with the release key, or keep the hold until the key owner checks it (recommended). Evidence: /scratch/atlas/evidence/feed-signature/receipt.json; the failing run, the key fingerprints and both manifests are in that folder, and nothing else in the release changed.`;
const PAYLOAD_SHORT =
  "Done. The PR is green; evidence in [the report](/scratch/atlas/evidence/report.md).";
const payloadProjection = {
  messages: [
    {
      id: "p1",
      role: "user",
      createdBy: "user",
      text: "Who owns the subtype mapping, and is the 1040 writer ready?",
      createdAt: reportAgo(12),
      attachments: [],
    },
    {
      id: "p2",
      role: "user",
      createdBy: "agent",
      senderThreadId: "skills",
      text: PAYLOAD_DENSE,
      createdAt: reportAgo(11),
      attachments: [],
    },
    {
      id: "p3",
      role: "assistant",
      text: "Ownership is still unverified. I asked the [Consolidate the skills](studio://thread/skills) worker to name the existing owner; no new worker.",
      createdAt: reportAgo(10.5),
      attachments: [],
    },
    {
      id: "p4",
      role: "user",
      createdBy: "agent",
      senderThreadId: "build",
      text: PAYLOAD_LAUNCH,
      createdAt: reportAgo(9),
      attachments: [],
    },
    {
      id: "p5",
      role: "assistant",
      text: "The 1040 writer is waiting for your approval to launch.",
      createdAt: reportAgo(8.5),
      attachments: [],
    },
    {
      id: "p6",
      role: "user",
      createdBy: "agent",
      senderThreadId: "skills",
      text: PAYLOAD_JSON,
      createdAt: reportAgo(6),
      attachments: [],
    },
    {
      id: "p7",
      role: "user",
      createdBy: "agent",
      senderThreadId: "build",
      text: PAYLOAD_BLOCKED,
      createdAt: reportAgo(4),
      attachments: [],
    },
    {
      id: "p8",
      role: "user",
      createdBy: "agent",
      senderThreadId: "skills",
      text: PAYLOAD_SHORT,
      createdAt: reportAgo(2),
      attachments: [],
    },
    {
      id: "p9",
      role: "assistant",
      text: "Publishing is held on a signature mismatch; it needs your decision.",
      createdAt: reportAgo(1),
      attachments: [],
    },
  ],
  runs: [],
  turnItems: [],
};
Object.assign(window, {
  payloadFixtureTexts: {
    dense: PAYLOAD_DENSE,
    launch: PAYLOAD_LAUNCH,
    json: PAYLOAD_JSON,
    blocked: PAYLOAD_BLOCKED,
    short: PAYLOAD_SHORT,
  },
});
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
  // `?fallback=gemini`: the October 22 live case. Claude reads as having room, but the
  // host keeps the coordinator on Gemini CLI; the composer must still name Gemini.
  const fallbackModel =
    new URLSearchParams(window.location.search).get("fallback") === "gemini"
      ? { instanceId: "acpRegistry_gemini", model: "default" }
      : { instanceId: "codex", model: "gpt-6.1-sol" };
  shells = shells.map((s) => (s.id === "coord" ? { ...s, modelSelection: fallbackModel } : s));
}
// `?mention`: the coordinator named a worker by its plain title, without a link.
const mentionFixture = new URLSearchParams(window.location.search).has("mention");
const mentionProjection = {
  messages: [
    {
      id: "m1",
      role: "user",
      createdBy: "user",
      runId: "run-mention",
      text: "Ask the extension worker to publish the store listing.",
      createdAt: minutesAgo(3),
      attachments: [],
    },
    {
      id: "m2",
      role: "assistant",
      runId: "run-mention",
      text: "Sent to the Release Chrome extension worker.",
      createdAt: minutesAgo(2),
      attachments: [],
    },
    {
      id: "m3",
      role: "assistant",
      runId: "run-mention",
      text: "The docs are fine. Run `Release Chrome extension` only from its worker.",
      createdAt: minutesAgo(1),
      attachments: [],
    },
  ],
  runs: [{ id: "run-mention", status: "completed", ordinal: 1, requestedAt: minutesAgo(3) }],
  turnItems: [],
};
if (mentionFixture)
  shells = [
    shell("coord", "Project coordinator"),
    shell("thread:delegated-task:command%3Amcp%3Arelease-chrome", "Release Chrome extension", {
      createdBy: "agent",
    }),
    shell("docs", "Docs", { createdBy: "agent" }),
  ];
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
      : payloadFixture
        ? payloadProjection
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
                    : followups
                      ? followUpMessages
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
export const useThreadProjection = (ref) => {
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
export const useThreadHistory = () => ({ hasMoreHistory: switchFixture, loading: false });
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
  ...(knowledgeServerConfig ? { serverConfig: knowledgeServerConfig } : {}),
});
export const useEnvironmentScope = () => true;
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
  read: (args) => ({ kind: "read", projectId: args?.input?.projectId }),
  starterSuggestions: () => ({ kind: "starters" }),
  threadReports: () => ({ kind: "threadReports" }),
  threadIncrementProgress: () => ({ kind: "threadIncrementProgress" }),
  threadReportSave: "threadReportSave",
  memoryRead: () => ({ kind: "memory" }),
  usage: () => ({ kind: "usage" }),
  send: "send",
  memoryWrite: "memoryWrite",
  memoryDelete: "memoryDelete",
  knowledge: () => ({ kind: "knowledge" }),
  knowledgeSearch: "knowledgeSearch",
  knowledgeReindex,
});
export const projectEnvironment = withFallback({
  update: "update",
  delete: "delete",
  folderCheck: "folderCheck",
  changeFolder: "changeFolder",
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
export const environmentShell = { stateValueAtom: () => attentionShellAtom };
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
  if (scenario === "coordinator") shells[0] = { ...shells[0], hasPendingUserInput: true };
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
