// Synthetic data only: no server, account, provider or store.
import type { ThreadIncrementProgress } from "@specweave-studio/contracts";
import { createRoot } from "react-dom/client";

import { LinkIncrementDialog } from "../../src/components/chat/LinkIncrementDialog";
import { ThreadPlanCard } from "../../src/components/chat/ThreadPlanCard";
import { ProjectFolderChange } from "../../src/components/studio/ProjectFolderChange";
import { deriveThreadPlanView } from "../../src/studio/threadPlanProgress";
import { applyThemePalette } from "../../src/themePalette";
import "../../src/components/studio/shell/shell.css";
import "./fixture.css";

const params = new URLSearchParams(location.search);
const dark = params.get("theme") === "dark";
document.documentElement.classList.toggle("dark", dark);
applyThemePalette("studio-chat", dark ? "dark" : "light");

const UMB = "/Users/dev/Projects/acme-umb";
const increment: ThreadIncrementProgress = {
  threadId: "thread-1" as never,
  incrementId: "0962-ac-traceability",
  binding: "claim",
  boundTaskId: "T-03",
  title: "Task and story to AC traceability",
  status: "active",
  incrementPath: `${UMB}/.specweave/increments/0962-ac-traceability`,
  specPath: `${UMB}/.specweave/increments/0962-ac-traceability/spec.md`,
  readable: true,
  tasks: [
    {
      id: "T-01",
      title: "Per-AC verify output",
      status: "done",
      criteria: ["AC-01", "AC-02"],
      note: null,
      doneAt: "2026-10-20T18:00:00Z",
    },
    {
      id: "T-02",
      title: "Criterion states in the reader",
      status: "done",
      criteria: ["AC-02", "AC-03"],
      note: null,
      doneAt: "2026-10-20T21:00:00Z",
    },
    {
      id: "T-03",
      title: "Traceability on the plan card",
      status: "claimed",
      criteria: ["AC-04"],
      note: null,
    },
    {
      id: "T-04",
      title: "Legacy tasks.md import",
      status: "done",
      criteria: ["AC-05"],
      note: null,
    },
    {
      id: "T-05",
      title: "Remote-only roots",
      status: "skipped",
      criteria: ["AC-07"],
      note: "Machine-flow owner",
    },
  ],
  criteria: [
    {
      id: "AC-01",
      text: "verify reports each criterion with its tasks",
      met: true,
      state: "verified",
      tasks: ["T-01"],
      story: "US-001",
    },
    {
      id: "AC-02",
      text: "Many tasks may prove one criterion",
      met: true,
      state: "evidenced",
      tasks: ["T-01", "T-02"],
      story: "US-001",
    },
    {
      id: "AC-03",
      text: "A tick in spec.md alone is not proof",
      met: true,
      state: "evidenced",
      tasks: ["T-02"],
      story: "US-001",
    },
    {
      id: "AC-04",
      text: "The card shows which tasks cover each criterion",
      met: false,
      state: "open",
      tasks: ["T-03"],
      story: "US-002",
    },
    {
      id: "AC-05",
      text: "Legacy [x] tasks still count, as declared",
      met: true,
      state: "declared",
      tasks: ["T-04"],
      story: "US-002",
    },
    {
      id: "AC-06",
      text: "Criteria no task cites are listed",
      met: false,
      state: "uncovered",
      tasks: [],
      story: "US-002",
    },
    {
      id: "AC-07",
      text: "Remote-only roots read as unknown",
      met: true,
      state: "skipped",
      tasks: ["T-05"],
      story: "US-003",
    },
  ],
  verify: { ok: true, ranAt: "2026-10-20T19:00:00Z" },
};

const base = {
  projectId: "p1",
  unchanged: false,
  targetExists: true,
  sameRepository: true,
  conflictingProject: null,
  activeThreads: [],
  threadCount: 12,
  reboundWorktreeCount: 0,
  keptInPlaceCount: 0,
  specweaveWorkspace: false,
};
const checks: Record<string, unknown> = {
  umbrella: {
    ...base,
    currentRoot: `${UMB}/repositories/acme/api`,
    targetRoot: UMB,
    currentRepository: "github.com/acme/api",
    targetRepository: null,
    sameRepository: false,
    keptInPlaceCount: 12,
    specweaveWorkspace: true,
    layout: {
      kind: "umbrella",
      rootIsRepository: false,
      repositories: ["repositories/acme/api", "repositories/acme/web", "repositories/acme/infra"],
      repositoryCount: 3,
      truncated: false,
    },
    planning: {
      currentRoot: UMB,
      currentIncrements: 964,
      targetRoot: UMB,
      targetIncrements: 964,
      brokenLinks: [],
      changes: false,
    },
  },
  nested: {
    ...base,
    currentRoot: "/Users/dev/Projects/platform",
    targetRoot: "/Users/dev/Projects/platform-v2",
    currentRepository: null,
    targetRepository: null,
    layout: {
      kind: "nested",
      rootIsRepository: false,
      repositories: ["billing-service", "frontend", "tools/cli", "wt/feature"],
      repositoryCount: 4,
      truncated: false,
    },
  },
  outside: {
    ...base,
    currentRoot: `${UMB}/repositories/acme/api`,
    targetRoot: "/Users/dev/Projects/api-fresh-clone",
    currentRepository: "github.com/acme/api",
    targetRepository: "github.com/acme/api",
    layout: {
      kind: "single",
      rootIsRepository: true,
      repositories: [],
      repositoryCount: 0,
      truncated: false,
    },
    planning: {
      currentRoot: UMB,
      currentIncrements: 964,
      targetRoot: null,
      targetIncrements: 0,
      brokenLinks: ["0961-umbrella-root", "0962-ac-traceability"],
      changes: true,
    },
  },
};

const view = params.get("view") ?? "card";
(window as any).fixture = { check: checks[view.replace("folder-", "")] };
const plan = deriveThreadPlanView({ increment, todoSteps: [] })!;

function Fixture() {
  if (view === "card")
    return (
      <main className="mx-auto max-w-2xl p-6" data-testid="card">
        <ThreadPlanCard
          plan={plan}
          onOpenPath={() => undefined}
          onLinkIncrement={() => undefined}
          defaultExpanded
        />
      </main>
    );
  if (view === "picker")
    return (
      <LinkIncrementDialog
        threadRef={{ environmentId: "e1", threadId: "thread-1" } as never}
        projectId={"p1" as never}
        onClose={() => undefined}
      />
    );
  const current = (checks[view.replace("folder-", "")] as { currentRoot: string }).currentRoot;
  return (
    <main className="project-settings-dialog mx-auto max-w-2xl p-6" data-testid="folder">
      <ProjectFolderChange
        project={{ id: "p1", environmentId: "e1", workspaceRoot: current, title: "acme" } as never}
        disabled={false}
        onChanged={() => undefined}
      />
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<Fixture />);
