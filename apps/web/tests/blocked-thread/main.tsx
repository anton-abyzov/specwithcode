// Synthetic data only: no server, account, provider or store.
import type { EnvironmentThreadShell } from "@specweave-studio/client-runtime/state/shell";
import { reportBlocker } from "@specweave-studio/shared/reportDocument";
import { createRoot } from "react-dom/client";

import { ThreadBlockerNote } from "../../src/components/chat/ThreadBlockerNote";
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
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<Fixture />);
