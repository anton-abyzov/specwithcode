// Synthetic data only: no server, account, provider or store.
import type { ThreadIncrementProgress, ThreadPullRequestLink } from "@specweave-studio/contracts";
import { summarizeTodoPlanPayload } from "@specweave-studio/shared/planProgress";
import { FolderOpenIcon } from "lucide-react";
import { createRoot } from "react-dom/client";

import { ThreadPlanCard } from "../../src/components/chat/ThreadPlanCard";
import { ThreadPullRequestPills } from "../../src/components/chat/ThreadPullRequestPills";
import { TimelineSystemDivider } from "../../src/components/chat/TimelineSystemDivider";
import { PlanProgressChip } from "../../src/components/studio/PlanProgressChip";
import {
  compactThreadPlan,
  deriveThreadPlanView,
  displayFolder,
} from "../../src/studio/threadPlanProgress";
import { applyThemePalette } from "../../src/themePalette";
import "../../src/components/studio/shell/shell.css";
import "./fixture.css";

const dark = new URLSearchParams(location.search).get("theme") === "dark";
document.documentElement.classList.toggle("dark", dark);
applyThemePalette("studio-chat", dark ? "dark" : "light");

const increment: ThreadIncrementProgress = {
  threadId: "thread-1" as never,
  incrementId: "0930-studio-plan-progress",
  binding: "claim",
  boundTaskId: "T-03",
  title: "Studio plan and progress card",
  status: "active",
  incrementPath: "/Users/dev/Projects/specweave/.specweave/increments/0930-studio-plan-progress",
  specPath: "/Users/dev/Projects/specweave/.specweave/increments/0930-studio-plan-progress/spec.md",
  readable: true,
  tasks: [
    {
      id: "T-01",
      title: "Shell plan progress contract",
      status: "done",
      criteria: ["AC-01"],
      note: null,
    },
    {
      id: "T-02",
      title: "Increment progress reader and RPC",
      status: "done",
      criteria: ["AC-02"],
      note: null,
    },
    {
      id: "T-03",
      title: "Plan card in the thread",
      status: "claimed",
      criteria: ["AC-01", "AC-03"],
      note: null,
    },
    {
      id: "T-04",
      title: "Compact 3/5 in lists and Overview",
      status: "planned",
      criteria: ["AC-04"],
      note: null,
    },
    {
      id: "T-05",
      title: "Live manual acceptance",
      status: "blocked",
      criteria: ["AC-04"],
      note: "Needs a person",
    },
  ],
  criteria: [
    { id: "AC-01", text: "A thread shows done, current and next", met: false },
    { id: "AC-02", text: "Increment state comes from ledger.jsonl", met: true },
    { id: "AC-03", text: "The card links the increment and its spec", met: false },
    { id: "AC-04", text: "Lists show compact progress", met: false },
  ],
  verify: { ok: true, ranAt: "2026-10-15T10:00:00Z" },
};

const todoSteps = [
  { step: "X thread, vSkill post, LinkedIn post live", status: "completed" },
  { step: "Show HN live with first comment", status: "completed" },
  { step: "dev.to article live", status: "completed" },
  { step: "Both sites imported into Bing, sitemaps submitted", status: "inProgress" },
  { step: "awesome-claude-code form needs a human", status: "pending" },
];

const pr = (number: number, branch: string, state: "open" | "merged", day: number) =>
  ({
    host: "github.com",
    repository: "anton-abyzov/specweave",
    number,
    url: `https://github.com/anton-abyzov/specweave/pull/${number}`,
    source: "agent",
    linkedAt: `2026-10-${String(day).padStart(2, "0")}T10:00:00Z`,
    snapshot: {
      state,
      title: branch,
      headBranch: branch,
      baseBranch: "develop",
      isDraft: false,
      updatedAt: null,
      syncedAt: "2026-10-15T10:00:00Z",
    },
    stack: null,
  }) as unknown as ThreadPullRequestLink;

const pullRequests = [
  pr(1961, "seo/specweave-3-metadata", "merged", 14),
  pr(70, "seo/canonicals-and-skills-hub", "merged", 13),
  pr(1958, "seo/guide-pages", "merged", 12),
  pr(1962, "feat/studio-plan-progress", "open", 15),
  pr(1950, "docs/bing-import", "merged", 10),
];

const incrementView = deriveThreadPlanView({ increment, todoSteps })!;
const todoView = deriveThreadPlanView({ increment: null, todoSteps })!;
const rows = [
  { title: "Studio plan and progress card", plan: compactThreadPlan(increment, null) },
  {
    title: "SEO and promotion strategy",
    plan: compactThreadPlan(
      null,
      summarizeTodoPlanPayload({
        kind: "todo_list",
        steps: todoSteps.map((step) => ({
          text: step.step,
          status: step.status === "inProgress" ? "running" : step.status,
        })),
      }),
    ),
  },
];

function Fixture() {
  return (
    <main className="mx-auto min-h-screen max-w-3xl space-y-8 p-6">
      <section data-testid="increment-card" className="space-y-1.5">
        <h2 className="text-sm font-semibold text-muted-foreground">
          Thread bound to an increment
        </h2>
        <ThreadPlanCard
          plan={incrementView}
          onOpenPath={() => undefined}
          onLinkIncrement={() => undefined}
          onUnlinkIncrement={() => undefined}
          defaultExpanded
        />
        <ThreadPullRequestPills pullRequests={pullRequests} onOpen={() => undefined} />
        <TimelineSystemDivider
          label="Working in folder"
          detail={displayFolder("/Users/dev/Projects/github/specweave-umb")}
          icon={FolderOpenIcon}
          actionLabel="Open folder"
          onAction={() => undefined}
        />
      </section>
      <section data-testid="todo-card" className="space-y-1.5">
        <h2 className="text-sm font-semibold text-muted-foreground">Agent todo list, collapsed</h2>
        <ThreadPlanCard plan={todoView} onOpenPath={null} onLinkIncrement={() => undefined} />
      </section>
      <section data-testid="rows" className="space-y-2">
        <h2 className="text-sm font-semibold text-muted-foreground">Thread list rows</h2>
        {rows.map((row) => (
          <div key={row.title} className="sws-thread-text rounded-lg border p-3">
            <strong>{row.title}</strong>
            <span className="sws-thread-meta">
              <span>Working</span>
              <span>Opus 5.5</span>
              {row.plan ? <PlanProgressChip plan={row.plan} /> : null}
            </span>
          </div>
        ))}
      </section>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<Fixture />);
