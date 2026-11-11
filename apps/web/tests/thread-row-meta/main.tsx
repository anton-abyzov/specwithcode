/*
 * Synthetic data only: the production Threads pane with rows like the October 23
 * report (a Codex thread on a usage-limit fallback for Opus 5.5, plan, PR and machine
 * chips). `?theme=dark` the theme; the runner sets the pane width with the viewport.
 * `?set=imported` shows a new install's first project instead: its imported Claude Code and
 * Codex sessions, resolved, and the one thread the coordinator started; `?set=imported-before`
 * shows the same sessions as a version before the import fix stored them.
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
import { ArrowLeftIcon, CheckIcon, ChevronRightIcon, EllipsisIcon, RouteIcon } from "lucide-react";
import { ThreadModelBadge, useProviderEntries } from "../../src/components/studio/shell/ModelBadge";
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
const astra = { instanceId: codex, model: "gpt-6-astra" } as ModelSelection;
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
    approval?: boolean;
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
    hasPendingApprovals: options.approval ?? false,
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
  // The October 25 installed report: Codex GPT-6-Astra standing in for Opus 5.5, with a PR.
  thread("diskaudit", "Complete project work and disk audit", {
    model: astra,
    preferred: opus,
    kind: "fallback",
    pullRequest: pr(187, "open"),
    minutes: 20,
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
  // The October 24 report: a fallback beside a plan and a PR, and one within a provider.
  thread("setup", "Project setup and handoff review", {
    model: gpt,
    preferred: opus,
    kind: "fallback",
    pullRequest: pr(644, "open"),
    minutes: 200,
  }),
  thread("orchestrators", "0969 Two orchestrators", {
    model: astra,
    preferred: gpt,
    kind: "fallback",
    pullRequest: pr(523, "merged"),
    minutes: 220,
  }),
  // A fallback with nothing after it on the line: no plan and no PR yet.
  thread("fresh", "Draft the release notes", {
    model: gpt,
    preferred: opus,
    kind: "fallback",
    input: true,
    minutes: 12,
  }),
  // The longest status word beside a fallback.
  thread("approval", "Approve the migration run", {
    model: gpt,
    preferred: opus,
    kind: "fallback",
    approval: true,
    minutes: 14,
  }),
];

// A new install's first project. "Before" is what the import stored until it took the
// first typed line as the title and the last message as the age.
const importedSet = params.get("set");
const sol = { instanceId: codex, model: "gpt-5.5" } as ModelSelection;
function imported(
  id: string,
  model: ModelSelection,
  title: string,
  rawTitle: string,
  minutes: number,
): EnvironmentThreadShell {
  const before = importedSet === "imported-before";
  return {
    ...thread(id, before ? rawTitle : title, { model, minutes: before ? 28 : minutes }),
    createdBy: "system",
    historyOrigin: "v1_import",
    settledOverride: "settled",
  } as EnvironmentThreadShell;
}
const DAY = 1440;
const importedThreads = [
  thread("inventory", "In-progress tasks inventory", { model: opus, minutes: 28 }),
  imported(
    "workouts",
    opus,
    "Plan this week of workouts",
    '<wake reason="mention" current-time="2026-11-10T14:02:11Z">',
    200,
  ),
  imported("readme", sol, "Initialize Git and add a README.", "<environment_context>", 27 * 60),
  imported(
    "login",
    opus,
    "/sw-do fix the login page",
    "<command-message>sw-do</command-message>",
    2 * DAY + 90,
  ),
  imported(
    "prices",
    sol,
    "Compare the three pricing tables",
    "# AGENTS.md instructions for /srv/app",
    4 * DAY + 90,
  ),
  imported(
    "invoice",
    opus,
    "Why does the invoice total round down?",
    "<system-reminder>",
    16 * DAY + 90,
  ),
];
const shownThreads = importedSet?.startsWith("imported") ? importedThreads : threads;

function Harness() {
  const findRef = useRef<HTMLInputElement | null>(null);
  const [query, setQuery] = useState("");
  const [findOpen, setFindOpen] = useState(false);
  const entries = useProviderEntries(host);
  useEffect(() => {
    document.body.dataset.fixtureReady = "true";
  }, []);
  return (
    <main className="project-thread-pane sws-threads" data-fixture-pane>
      <ThreadsPane
        environmentId={host}
        threads={shownThreads}
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
      {/* The opened thread's header as ProjectThreadHeader lays it out: the chips share
          the row with the title and the header's buttons, and give way before them. */}
      <div className="sws-pane-head sws-thread-head" data-header-fixture>
        <button type="button" className="sws-thread-crumb" aria-label="Back to project threads">
          <ArrowLeftIcon aria-hidden className="sws-thread-crumb-back" />
          <span aria-hidden className="sws-thread-crumb-label">
            Threads
          </span>
        </button>
        <ChevronRightIcon aria-hidden className="sws-thread-crumb-sep" />
        <div className="sws-thread-head-text">
          <h2>{threads[0]!.title}</h2>
          <span className="sws-thread-head-chips">
            <ThreadModelBadge
              thread={threads[0]!}
              entries={entries}
              variant="chip"
              focusable
              header
            />
            {/* RoutingDecisionChip's trigger as it renders for a lane decision. */}
            <button
              type="button"
              className="sws-chip sws-routing-chip"
              aria-label="Routing decision: Complex, Claude Code · Opus 5.5"
              data-header-routing
            >
              <RouteIcon aria-hidden />
              Lanes · Complex
            </button>
            <button type="button" className="sws-chip" data-state="open" data-header-pr>
              <span className="sr-only">Pull request </span>#283
            </button>
          </span>
        </div>
        <button type="button" className="sws-icon-button" aria-label="Artifacts">
          <EllipsisIcon aria-hidden />
        </button>
        <button type="button" className="sws-icon-button sws-thread-resolve">
          <CheckIcon aria-hidden />
          <span className="sws-thread-resolve-label">Resolve</span>
        </button>
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
