// Synthetic data only: no server, account, provider or store.
import type { EnvironmentThreadShell } from "@specweave-studio/client-runtime/state/shell";
import { reportBlocker } from "@specweave-studio/shared/reportDocument";
import type { ThreadPullRequestLink } from "@specweave-studio/contracts";
import type { CSSProperties } from "react";
import { createRoot } from "react-dom/client";

import { ThreadBlockerNote } from "../../src/components/chat/ThreadBlockerNote";
import { ThreadErrorBanner } from "../../src/components/chat/ThreadErrorBanner";
import { ThreadMetaRow } from "../../src/components/chat/ThreadMetaRow";
import { ThreadPlanCard } from "../../src/components/chat/ThreadPlanCard";
import { ThreadProgressDock } from "../../src/components/chat/ThreadProgressDock";
import { useElementHeight } from "../../src/hooks/useElementHeight";
import type { ThreadPlanView } from "../../src/studio/threadPlanProgress";
import { projectThreadGroup, threadBlocker } from "../../src/studio/projectWorkspaceModel";
import { threadStatusWord } from "../../src/studio/shellModel";
import { applyThemePalette } from "../../src/themePalette";
import "../../src/components/studio/shell/shell.css";
import "./fixture.css";

const dark = new URLSearchParams(location.search).get("theme") === "dark";
document.documentElement.classList.toggle("dark", dark);
applyThemePalette("studio-chat", dark ? "dark" : "light");

// The report that showed Blocked with "Blockers: none." on the Full-window viewer overlay thread.
const reports = [
  {
    id: "none-with-notes",
    title: "Full-window viewer overlay",
    text: "**Checks:** `tsc` is clean, and 1,355 unit tests pass.\n\n**Blockers:** none. The Files/diff right panel and the subagent peek still open inside the pane; neither is a pop-up, so I left them. I also patched `useHandoffSourceChanges`, which crashed the headless test page on main.",
  },
  {
    id: "question",
    title: "Release 1.0.35",
    text: "**Outcome:** built.\n\n**Blockers:** Ship 1.0.35 today, or wait for the SQLite fix? I recommend waiting.",
  },
  {
    id: "no-access",
    title: "Staging deploy",
    text: "**Outcome:** deploy is ready.\n\n**Blockers:** No access to the staging token; can you grant it?",
  },
];

function shell(title: string, reportedBlocker: string | null): EnvironmentThreadShell {
  return {
    id: title,
    environmentId: "host-1",
    projectId: "project-1",
    title,
    runtime: null,
    latestRun: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    pendingBackgroundTasks: [],
    archivedAt: null,
    deletedAt: null,
    settledOverride: null,
    lineage: { relationshipToParent: null },
    pullRequests: [],
    createdAt: "2026-10-16T00:00:00Z",
    updatedAt: "2026-10-16T00:00:00Z",
    modelSelection: { instanceId: "claudeAgent", model: "claude-opus-5-5" },
    reportedBlocker,
  } as unknown as EnvironmentThreadShell;
}

// The thread view floats its banners in a lane over the scrolled timeline:
// the same components and dock as ChatView, over rows of transcript text.
const longBlocker =
  "The specweave-studio repo has two stashes I left alone. One is on perf/session-aging-doctor (2 lines in pnpm-lock.yaml). The other, on fix/coordinator-turns-port, changes CoordinatorConversation.tsx and shell.css by 267 lines added and 135 removed. Do you want that second stash pushed to a branch for review, or dropped?";
const plan: ThreadPlanView = {
  source: "todo",
  increment: null,
  completed: 2,
  total: 4,
  current: "Remove the merged worktrees",
  next: "Write the cleanup table",
  steps: [
    { key: "1", id: null, text: "List merged branches", state: "done", note: null },
    { key: "2", id: null, text: "Check each worktree is clean", state: "done", note: null },
    { key: "3", id: null, text: "Remove the merged worktrees", state: "current", note: null },
    { key: "4", id: null, text: "Write the cleanup table", state: "open", note: null },
  ],
};
const pullRequests = [
  {
    host: "github.com",
    repository: "anton-abyzov/specwithcode",
    number: 268,
    url: "https://github.com/anton-abyzov/specwithcode/pull/268",
    linkedAt: "2026-10-16T00:00:00Z",
    snapshot: null,
  },
] as unknown as ReadonlyArray<ThreadPullRequestLink>;
function OverlayLane() {
  const [laneRef, laneHeight] = useElementHeight<HTMLDivElement>();
  return (
    <section
      data-case="overlay-lane"
      className="relative h-[28rem] overflow-hidden rounded-lg border"
    >
      {/* Mirrors MessagesTimeline: a measured inset row, and scroll padding below the lane. */}
      <div
        data-overlay-scroller
        className="h-full overflow-y-auto scroll-pt-[calc(var(--timeline-banner-inset,0px)+0.75rem)] bg-background px-4"
        style={{ "--timeline-banner-inset": `${laneHeight}px` } as CSSProperties}
      >
        <div aria-hidden data-timeline-banner-inset style={{ height: laneHeight }} />
        <div className="h-3" />
        {Array.from({ length: 60 }, (_, index) => (
          <p key={index} data-transcript-row={index} className="py-1 text-sm">
            {index === 0
              ? "Show full message"
              : `merged branches and write the table once they finish (${index} of 60)`}
          </p>
        ))}
      </div>
      <div
        ref={laneRef}
        data-banner-lane
        className="chat-banner-lane pointer-events-none absolute inset-x-0 top-0 z-20 flex flex-col"
      >
        <ThreadErrorBanner error="Codex stopped: the provider closed the stream." />
        <ThreadProgressDock>
          <ThreadMetaRow
            origin={null}
            folder={{ label: "cleanup-merged", path: "/Users/dev/worktrees/cleanup-merged" }}
            run={{ startedAt: "2026-10-16T00:00:00Z", completedAt: "2026-10-16T00:28:00Z" }}
            pullRequests={pullRequests}
            onOpenPullRequest={() => undefined}
          />
          <ThreadPlanCard plan={plan} onOpenPath={null} />
          <ThreadBlockerNote blocker={longBlocker} />
        </ThreadProgressDock>
      </div>
    </section>
  );
}

function Fixture() {
  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-6 p-6">
      {reports.map((report) => {
        const thread = shell(report.title, reportBlocker(report.text));
        const blocker = threadBlocker(thread);
        return (
          <section
            key={report.id}
            data-case={report.id}
            data-group={projectThreadGroup(thread)}
            data-status={threadStatusWord(thread) ?? ""}
            className="flex flex-col gap-1.5"
          >
            <div className="sws-thread-text rounded-lg border p-3">
              <strong>{report.title}</strong>
              <span className="sws-thread-meta">
                <span data-row-status>{threadStatusWord(thread) ?? "Idle"}</span>
                <span>Opus 5.5</span>
              </span>
            </div>
            {blocker !== null ? <ThreadBlockerNote blocker={blocker} /> : null}
            <pre className="whitespace-pre-wrap rounded-lg border p-3 text-xs text-muted-foreground">
              {report.text}
            </pre>
          </section>
        );
      })}
      <OverlayLane />
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<Fixture />);
