/*
 * Synthetic data only: the production Threads pane with rows like the October 23
 * report (a Codex thread on a usage-limit fallback for Opus 5.5, plan, PR and machine
 * chips). `?theme=dark` the theme; the runner sets the pane width with the viewport.
 */
import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import {
  EnvironmentId,
  ProviderInstanceId,
  type ModelSelection,
} from "@specweave-studio/contracts";
import type { EnvironmentThreadShell } from "@specweave-studio/client-runtime/state/shell";
import { ThreadModelBadge } from "../../src/components/studio/shell/ModelBadge";
import { ThreadsPane } from "../../src/components/studio/shell/ThreadsPane";
import { TooltipProvider } from "../../src/components/ui/tooltip";
import "./fixture.css";

const params = new URLSearchParams(location.search);
const dark = params.get("theme") === "dark";
// The default "system" theme, as most people run it; the runner sets prefers-color-scheme too.
document.documentElement.classList.toggle("dark", dark);

const host = EnvironmentId.make("env-m4");
const codex = ProviderInstanceId.make("codex");
const claude = ProviderInstanceId.make("claudeAgent");
const gpt = { instanceId: codex, model: "gpt-6.1-sol" } as ModelSelection;
const opus = { instanceId: claude, model: "claude-opus-5-5" } as ModelSelection;
// Devin runs the same model under its own slug: a fallback that must not read "Sol for Sol".
const devinSol = { instanceId: "acpRegistry_devin", model: "gpt-6-1-sol-medium" } as ModelSelection;

const now = Date.now();
const ago = (minutes: number) => new Date(now - minutes * 60_000).toISOString();
const pr = (number: number, state: "open" | "merged") => ({
  host: "github.com",
  repository: "example/app",
  number,
  url: `https://github.com/example/app/pull/${number}`,
  source: "agent",
  linkedAt: ago(30),
  snapshot: { state, isDraft: false, title: "Fixture" },
  stack: null,
});
function thread(
  id: string,
  title: string,
  options: {
    model: ModelSelection;
    preferred?: ModelSelection;
    kind?: "fallback" | "running";
    input?: boolean;
    pullRequest?: ReturnType<typeof pr>;
    minutes: number;
  },
): EnvironmentThreadShell {
  return {
    id,
    environmentId: host,
    projectId: "project",
    title,
    createdBy: "agent",
    runtime: null,
    hasPendingApprovals: false,
    hasPendingUserInput: options.input ?? false,
    hasActionableProposedPlan: false,
    settledOverride: null,
    lineage: { relationshipToParent: null },
    pullRequests: options.pullRequest ? [options.pullRequest] : [],
    archivedAt: null,
    deletedAt: null,
    updatedAt: ago(options.minutes),
    createdAt: ago(options.minutes + 60),
    modelSelection: options.preferred ?? options.model,
    modelIdentity: {
      current: options.model,
      preferred: options.preferred ?? null,
      kind: options.kind ?? null,
    },
  } as unknown as EnvironmentThreadShell;
}
const threads = [
  thread("matchcam", "MatchCam fixes and phone update", {
    model: gpt,
    preferred: opus,
    kind: "fallback",
    input: true,
    pullRequest: pr(283, "open"),
    minutes: 10,
  }),
  thread("twin", "EasyChamp coordinator on Devin", {
    model: devinSol,
    preferred: gpt,
    kind: "fallback",
    minutes: 12,
  }),
  thread("business", "Business, facilities and marketing prep", {
    model: gpt,
    input: true,
    pullRequest: pr(280, "open"),
    minutes: 10,
  }),
  thread("season", "Season shirt numbers with game override", {
    model: opus,
    pullRequest: pr(477, "merged"),
    minutes: 59,
  }),
  thread("audit", "Complete EasyChamp handoff audit", {
    model: gpt,
    preferred: opus,
    kind: "running",
    pullRequest: pr(279, "open"),
    minutes: 60,
  }),
  thread("positions", "Edit player positions from profiles", {
    model: opus,
    pullRequest: pr(354, "merged"),
    minutes: 180,
  }),
];

function Harness() {
  const findRef = useRef<HTMLInputElement | null>(null);
  const [query, setQuery] = useState("");
  const [findOpen, setFindOpen] = useState(false);
  useEffect(() => {
    document.body.dataset.fixtureReady = "true";
  }, []);
  return (
    <main className="project-thread-pane sws-threads" data-fixture-pane>
      <ThreadsPane
        environmentId={host}
        threads={threads}
        canChange
        findRef={findRef}
        query={query}
        onQueryChange={setQuery}
        findOpen={findOpen}
        onFindOpenChange={setFindOpen}
        onOpen={() => {}}
        onToggleResolved={() => {}}
        machineLabels={
          new Map([
            [host, "MacBook M4MAX"],
            ["env-mini", "Mac mini"],
          ])
        }
        bar={{
          tab: "threads",
          onTabChange: () => {},
          counts: { threads: { value: 2, label: "2 waiting", tone: "waiting" } },
          onNewThread: () => {},
          onOpenPlan: () => {},
          onOpenUsage: () => {},
          expanded: false,
          onToggleExpanded: () => {},
          onClose: () => {},
        }}
      />
      <div
        className="sws-thread-head-chips"
        data-header-fixture
        style={{ flex: "none", width: "100%", minHeight: 30 }}
      >
        <ThreadModelBadge thread={threads[0]!} entries={new Map()} variant="chip" focusable />
      </div>
    </main>
  );
}

const router = createRouter({
  history: createMemoryHistory(),
  routeTree: createRootRoute({
    component: () => (
      <TooltipProvider>
        <Harness />
      </TooltipProvider>
    ),
  }),
});
createRoot(document.getElementById("root")!).render(<RouterProvider router={router} />);
