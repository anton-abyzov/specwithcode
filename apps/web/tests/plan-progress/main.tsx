// Synthetic data only: no server, account, provider or store.
import type { ThreadIncrementProgress } from "@specweave-studio/contracts";
import { summarizeTodoPlanPayload } from "@specweave-studio/shared/planProgress";
import { FolderOpenIcon } from "lucide-react";
import { useState } from "react";
import { createRoot } from "react-dom/client";

import { ThreadPlanCard } from "../../src/components/chat/ThreadPlanCard";
import { TimelineSystemDivider } from "../../src/components/chat/TimelineSystemDivider";
import { PlanProgressChip } from "../../src/components/studio/PlanProgressChip";
import {
  Menu,
  MenuCheckboxItem,
  MenuGroup,
  MenuPopup,
  MenuTrigger,
} from "../../src/components/ui/menu";
import {
  UnplannedThreadChip,
  UnplannedThreadsFilter,
} from "../../src/components/studio/shell/UnplannedThreads";
import {
  compactThreadPlan,
  deriveThreadPlanView,
  displayFolder,
} from "../../src/studio/threadPlanProgress";
import { applyThemePalette } from "../../src/themePalette";
import { useUnplannedNoticeShown } from "../../src/studio/unplannedNotice";
import "../../src/components/studio/shell/shell.css";
import "./fixture.css";

// What each card action opened, for the verify script: ["viewer" | "editor", path].
const opened: Array<[string, string]> = [];
(window as unknown as { planOpened: typeof opened }).planOpened = opened;
const openInViewer = (path: string) => opened.push(["viewer", path]);
const openInEditor = (path: string) => opened.push(["editor", path]);

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

// Bound by the launch, before the worker has planned any task.
const emptyIncrement: ThreadIncrementProgress = {
  ...increment,
  threadId: "thread-2" as never,
  incrementId: "0996-connect-launches",
  binding: "manual",
  boundTaskId: null,
  title: "Connect launches to increments",
  status: "planned",
  incrementPath: "/Users/dev/Projects/specweave/.specweave/increments/0996-connect-launches",
  specPath: "/Users/dev/Projects/specweave/.specweave/increments/0996-connect-launches/spec.md",
  tasks: [],
  criteria: [],
  verify: null,
};

const incrementView = deriveThreadPlanView({ increment, todoSteps })!;
const todoView = deriveThreadPlanView({ increment: null, todoSteps })!;
const emptyView = deriveThreadPlanView({ increment: emptyIncrement, todoSteps: null })!;
const unplannedView = deriveThreadPlanView({ increment: null, todoSteps: null, unplanned: true })!;
const rows = [
  { title: "Studio plan and progress card", plan: compactThreadPlan(increment, null) },
  { title: "Connect launches to increments", plan: compactThreadPlan(emptyIncrement, null) },
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
  const [unplannedOnly, setUnplannedOnly] = useState(false);
  // The real per-project setting, saved in this page's localStorage.
  const [noticeShown, setNoticeShown] = useUnplannedNoticeShown("env-fixture", "project-fixture");
  return (
    <main className="mx-auto min-h-screen max-w-3xl space-y-8 p-6">
      <section data-testid="increment-card" className="space-y-1.5">
        <h2 className="text-sm font-semibold text-muted-foreground">
          Thread bound to an increment
        </h2>
        <ThreadPlanCard
          plan={incrementView}
          onOpenPath={openInEditor}
          onOpenDocument={openInViewer}
          onLinkIncrement={() => undefined}
          onUnlinkIncrement={() => undefined}
          defaultExpanded
        />
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
      <section data-testid="no-editor-card" className="space-y-1.5">
        <h2 className="text-sm font-semibold text-muted-foreground">
          Increment with no tasks yet, no editor installed
        </h2>
        <ThreadPlanCard
          plan={emptyView}
          onOpenPath={null}
          onOpenDocument={openInViewer}
          onLinkIncrement={() => undefined}
          onUnlinkIncrement={() => undefined}
          defaultExpanded
        />
      </section>
      <section data-testid="unplanned-card" className="space-y-1.5">
        <h2 className="text-sm font-semibold text-muted-foreground">
          Thread that changed code without an increment
        </h2>
        <ThreadPlanCard
          plan={unplannedView}
          onOpenPath={null}
          onOpenDocument={openInViewer}
          onLinkIncrement={() => undefined}
          onUnlinkIncrement={() => undefined}
          defaultExpanded
        />
      </section>
      <section data-testid="rows" className="space-y-2">
        <h2 className="text-sm font-semibold text-muted-foreground">Thread list rows</h2>
        <div className="sws-threads-head">
          <Menu>
            <MenuTrigger render={<button type="button" className="rounded border px-2 text-xs" />}>
              Sort threads
            </MenuTrigger>
            <MenuPopup align="start" side="bottom" className="min-w-52">
              <MenuGroup>
                <MenuCheckboxItem
                  variant="switch"
                  checked={noticeShown}
                  onCheckedChange={(checked) => setNoticeShown(checked)}
                  data-unplanned-notice-toggle
                >
                  Note threads without an increment
                </MenuCheckboxItem>
              </MenuGroup>
            </MenuPopup>
          </Menu>
          {noticeShown ? (
            <UnplannedThreadsFilter
              count={2}
              pressed={unplannedOnly}
              onToggle={() => setUnplannedOnly((on) => !on)}
              onHide={() => {
                setUnplannedOnly(false);
                setNoticeShown(false);
              }}
            />
          ) : null}
        </div>
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
        <div className="sws-thread-text rounded-lg border p-3">
          <strong>Hotfix the login redirect</strong>
          <span className="sws-thread-meta">
            <span>Idle</span>
            <span>GPT-5.4</span>
            {noticeShown ? <UnplannedThreadChip /> : null}
          </span>
        </div>
      </section>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<Fixture />);
