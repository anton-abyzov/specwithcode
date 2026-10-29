import {
  buildStarterSuggestions,
  UNREAD_STARTER_SIGNALS,
} from "@specweave-studio/shared/projectStarterSuggestions";
import { DateTime } from "effect";
import { DEFAULT_SERVER_SETTINGS } from "@specweave-studio/contracts";
import { reportKey } from "@specweave-studio/shared/threadReport";
import { ENOSPC_REPORT, MERGE_RECEIPT } from "../agent-messages/payloads";
import { INTERNAL_RECEIPTS } from "../agent-messages/internalReceipts";

// `?fresh` is a project nobody has worked in yet; `?fresh=empty` is one whose folder is empty too.
export const recovery = new URLSearchParams(window.location.search).get("recovery");
export const recoveryFailureId =
  new URLSearchParams(window.location.search).get("recovery-failure") ?? "run-failed";
export const fresh = new URLSearchParams(window.location.search).get("fresh");
// `?fresh&failed` adds a coordinator turn the host could not start (a reached usage limit).
export const failedTurn = new URLSearchParams(window.location.search).has("failed");
/* `?turns`: a conversation across two days, for the turn layout (separators,
   "Worked for", the answer's actions). Times are relative so "Today" holds. */
export const turns = new URLSearchParams(window.location.search).has("turns");
export const minutesAgo = (minutes, seconds = 0) =>
  new Date(Date.now() - minutes * 60_000 + seconds * 1_000).toISOString();
export const turnMessages = [
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
export const followups = new URLSearchParams(window.location.search).has("followups");
export const followUpWrapper = (worker, id) =>
  `User follow-up from selected worker ${worker}, message ${id}. Review that thread and decide whether to reuse it or route elsewhere.\n\n`;
// Real projections carry DateTime values; the routed-message notes format them.
export const followUpMessages = [
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
export const legacy = new URLSearchParams(window.location.search).get("legacy");
export const starters = {
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
export const settings = {
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
export const memory = {
  files: [
    { name: "MEMORY.md", revision: 3, updatedAt: "2026-10-09T00:00:00Z", byteLength: 128 },
    ...[
      "agent-memory.sw-sw-closer.reference_build_and_deploy_traps.md",
      "agent-memory.sw-sw-pm.MEMORY.md",
      "ai-assistant-state.md",
      "decision_provider_per_thread.md",
      "feedback_report_timing.md",
      "project_0997_staff_own_dues_merged_2026_10_27.md",
      "project_connect_fraud_watch_2026_10_28.md",
      "reference_florida_elite_actions_corrected_2026_10_28.md",
      "skill-memory.docs-writer.md",
    ].map((name, i) => ({
      name,
      revision: 1 + (i % 3),
      updatedAt: `2026-10-${String(10 + i * 2).padStart(2, "0")}T12:00:00Z`,
      byteLength: 900 + i * 410,
    })),
  ],
  totalBytes: 21_000,
};
export const totals = {
  inputTokens: 40000,
  outputTokens: 10000,
  totalTokens: 50000,
  cachedInputTokens: 30000,
  cacheCreationTokens: null,
  reasoningTokens: null,
  equivalentCostUsd: 0.26,
};
export const scaledTotals = (share) => ({
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
export const activity = new URLSearchParams(window.location.search).has("activity");
/** `?report`: a worker reports back with a long review, and the coordinator relays it. */
export const reportFixture = new URLSearchParams(window.location.search).has("report");
export const REPORT_TEXT = [
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
export const answerFixture = new URLSearchParams(window.location.search).has("answer");
export const ANSWER_TEXT = [
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
export const RELAY_TEXT = [
  "The review worker finished cycle 2 of 0973. Here is what it found:",
  "",
  ...Array.from(
    { length: 90 },
    (_, i) => `- Point ${i + 1} from the review, restated for the decision`,
  ),
  "",
  "Nothing blocks closing 0973. Say the word and I'll close it.",
].join("\n");
export const savedReports = [];
export const reportSnapshot = () => ({
  workspaceRoot: "/scratch/atlas",
  specweave: true,
  increment: {
    id: "0973-budget-vs-actuals",
    path: ".specweave/increments/0973-budget-vs-actuals",
  },
  folder: ".specweave/increments/0973-budget-vs-actuals/reports",
  reports: savedReports,
});
export const reportAgo = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString();
export const reportProjection = {
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
export const payloadFixture = new URLSearchParams(window.location.search).has("payload");
export const PAYLOAD_DENSE = `Need exactEXISTINGbackend/canonical ownerbinding, no newworker. Userrequests research/updateALLseason5v5/8v8subtypes+3persistentfamiliesMonLeague5v5/TueLeague8v8/ThuCup5v5; categoryowner ${TUTORIALS_ID} has schema/catalogue readonlyauditsactive. Winter/Fallsuccessor explicitly505ONLY, excludes10canonical1009rows andallnewsubtype/family work. Original0952read-onlydisposition explicitlydoesNOTownhistoryAPI files; do NOTassignthembyassumption.1009threadposition745 canonicalacceptance came frommessage:mcp:0f3c9a1e-5b7d-4c2a-9e81-2d6f4b0a7c55:thread-send:plan-ack-2 but senderisnotverifiedthreadID. Asked1009to identify/forwardexistingcanonicalowner. Please bindexactexistingthreadRef androuteauditfindings for supportedAPI DRYRUNONLY afterschemaresults, preserve10rows exclusivity/awards/title/deductions, no505expansion/readprojection/DBwrites/newincrement/cap10/stabilitynextslotbypass. Allreleaseholdsunchanged. We must settleowneridentity before anydata preparation/write claim.`;
export const PAYLOAD_LAUNCH = `1040 repository registration now exists at revision20. Latest instruction requires asking you before a new top-level writer. Approve one studio_thread_launch for existing increment1040, native Codex gpt-6-astra, workspaceStrategy {type:'worktree',repository:'7d1e2c40-5b8a-4f3e-9a61-0c2b8e4d9f17',baseRef:'main',branch:'fix/1040-project-attention-counts',startFromOrigin:true}, reportBack:true? Current thread cannot rebind. This writer would own remaining implementation/tests/review/PR; I retain coordination, no duplicate edits. Plan /scratch/atlas/.specweave/increments/1040-fix-project-badges/spec.md; audit /scratch/atlas/evidence/project-attention-1040/audit.md. Preserve1036 notification repair,1037 navigation,1039 review,1011 hold, and [Record the tutorials](studio://thread/${encodeURIComponent(TUTORIALS_ID)}) merge/release/installed ownership. All browser automation headless true with file evidence. No launch yet.`;
export const PAYLOAD_JSON = [
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
export const PAYLOAD_BLOCKED = `Publishing is held: the update feed signature check failed with "error: signature mismatch for latest-mac.yml (expected key 3F2A, got 9C1B)". I did not retry or re-sign. **Blockers:** approve re-signing with the release key, or keep the hold until the key owner checks it (recommended). Evidence: /scratch/atlas/evidence/feed-signature/receipt.json; the failing run, the key fingerprints and both manifests are in that folder, and nothing else in the release changed.`;
export const PAYLOAD_SHORT =
  "Done. The PR is green; evidence in [the report](/scratch/atlas/evidence/report.md).";
export const payloadProjection = {
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
/**
 * `?agent-messages`: the coordinator in the October 25, 2026 screenshot, flooded by one
 * worker's raw receipt (1068). The texts are shared with the thread page fixture.
 */
export const agentMessagesFixture =
  new URLSearchParams(window.location.search).has("agent-messages") ||
  new URLSearchParams(window.location.search).has("internal-receipts");
export const internalReceiptsFixture = new URLSearchParams(window.location.search).has(
  "internal-receipts",
);
export const internalReceiptsProjection = {
  messages: INTERNAL_RECEIPTS.flatMap((text, index) => [
    {
      id: `internal-${index}`,
      role: "user",
      createdBy: "agent",
      senderThreadId: "skills",
      text,
      createdAt: reportAgo(10 - index),
      attachments: [],
      streaming: false,
      runId: `internal-run-${index}`,
    },
    {
      id: `empty-${index}`,
      role: "assistant",
      createdBy: "agent",
      text: " ",
      createdAt: reportAgo(10 - index),
      updatedAt: reportAgo(10 - index),
      attachments: [],
      streaming: false,
      runId: `internal-run-${index}`,
    },
  ]).concat([
    {
      id: "attention",
      role: "user",
      createdBy: "agent",
      senderThreadId: "skills",
      text: "Authentication failed. Please sign in to continue.",
      createdAt: reportAgo(1),
      attachments: [],
      streaming: false,
      runId: "attention-run",
    },
  ]),
  runs: INTERNAL_RECEIPTS.map((_, index) => ({
    id: `internal-run-${index}`,
    status: "completed",
    ordinal: index + 1,
    providerInstanceId: "codex",
    modelSelection: { instanceId: "codex", model: "gpt-5.5" },
  })),
  turnItems: [],
};
export const agentMessagesProjection = {
  messages: [
    {
      id: "a1",
      role: "user",
      createdBy: "user",
      text: "Check the qualification flow and tell me what is left.",
      createdAt: reportAgo(20),
      attachments: [],
    },
    {
      id: "a2",
      role: "user",
      createdBy: "agent",
      senderThreadId: "skills",
      text: ENOSPC_REPORT,
      createdAt: reportAgo(16),
      attachments: [],
    },
    {
      id: "a3",
      role: "assistant",
      text: "One screenshot failed on a full disk; the rest passed. The runtime cleanup needs its owner.",
      createdAt: reportAgo(15),
      attachments: [],
    },
    {
      id: "a4",
      role: "user",
      createdBy: "agent",
      senderThreadId: "build",
      text: MERGE_RECEIPT,
      createdAt: reportAgo(6),
      attachments: [],
    },
    {
      id: "a5",
      role: "assistant",
      text: "Both pull requests are merged; nothing is deployed.",
      createdAt: reportAgo(5),
      attachments: [],
    },
  ],
  runs: [],
  turnItems: [],
};
Object.assign(window, { agentMessageTexts: { enospc: ENOSPC_REPORT, merge: MERGE_RECEIPT } });
Object.assign(window, {
  payloadFixtureTexts: {
    dense: PAYLOAD_DENSE,
    launch: PAYLOAD_LAUNCH,
    json: PAYLOAD_JSON,
    blocked: PAYLOAD_BLOCKED,
    short: PAYLOAD_SHORT,
  },
});

export const shell = (id, title, extra = {}) => ({
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

export const subagentsFixture = new URLSearchParams(window.location.search).has("subagents");
export const subagentOf = (parentThreadId) => ({
  relationshipToParent: "subagent",
  parentThreadId,
  rootThreadId: "coord",
});
export const fixtureSubagents = subagentsFixture
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
export const activityItem = (id, runId, ordinal, type, fields = {}) => ({
  id,
  runId,
  ordinal,
  type,
  status: "completed",
  ...fields,
});
export const activityProjection = {
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
export const fallbackFixture = new URLSearchParams(window.location.search).has("fallback");
export const fallbackRequest =
  'Start a thread titled "Pick up the handoff" and report what is left.';
export const fallbackProjection = {
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

// `?mention`: the coordinator named a worker by its plain title, without a link.
export const mentionFixture = new URLSearchParams(window.location.search).has("mention");
export const mentionProjection = {
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

export const baseThreadProjection = () => ({
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
      : agentMessagesFixture
        ? internalReceiptsFixture
          ? internalReceiptsProjection
          : agentMessagesProjection
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

export function applySubagentScenario(current) {
  let shells = current;
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
  if (subagentsFixture && new URLSearchParams(location.search).has("popup-history")) {
    shells.push(
      ...Array.from({ length: 14 }, (_, i) =>
        shell(`old-review-${i}`, `Historical review ${i + 1}`, {
          lineage: subagentOf("warn"),
          source: {
            creationSource: "provider",
            nativeSubagentStatus: "completed",
            pendingRuntimeRequest: null,
          },
          latestRun: { status: "completed", completedAt: "2026-10-20T12:00:00Z" },
        }),
      ),
    );
    shells.push(
      shell("unrelated-child", "Unrelated thread child", {
        lineage: subagentOf("polish"),
        runtime: { status: "running" },
      }),
    );
  }

  return shells;
}
