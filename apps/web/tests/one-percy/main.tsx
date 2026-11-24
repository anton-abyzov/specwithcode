// One Percy per Connect account (1448) over fixture data. Query:
//   ?view=sidebar|settings|dialog|chats   see mocks.tsx for each scenario
//   ?theme=light|dark
import { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { EnvironmentId, ProjectId, ThreadId } from "@specweave-studio/contracts";
import type { EnvironmentThreadShell } from "@specweave-studio/client-runtime/state/shell";
import type { MachineReachState } from "@specweave-studio/client-runtime/connection";
import { PercySharedSetting } from "../../src/components/settings/PercySharedSetting";
import {
  SettingsPageContainer,
  SettingsSection,
} from "../../src/components/settings/settingsLayout";
import { LinkedAssistantOfflineSeats } from "../../src/components/studio/LinkedAssistantOfflineSeats";
import StudioSidebar from "../../src/components/studio/shell/StudioSidebar";
import { ThreadsPane } from "../../src/components/studio/shell/ThreadsPane";
import { SidebarProvider } from "../../src/components/ui/sidebar";
import { TooltipProvider } from "../../src/components/ui/tooltip";
import { MachineReachContext, UnreachableHostsContext } from "../../src/studio/unreachableHosts";
import { applyThemePalette } from "../../src/themePalette";
import { view } from "./mocks";
import "./fixture.css";

const params = new URLSearchParams(location.search);
const dark = params.get("theme") === "dark";
document.documentElement.classList.toggle("dark", dark);
// The built-in palette sets light colours inline; dark mode uses the stylesheet's dark tokens.
if (!dark) applyThemePalette("studio-chat", "light");

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
const thread = (
  id: string,
  environmentId: string,
  title: string,
  minutes: number,
): EnvironmentThreadShell =>
  ({
    id,
    environmentId,
    projectId: `percy-${environmentId}`,
    title,
    createdBy: "user",
    runtime: null,
    latestRun: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    pendingBackgroundTasks: [],
    settledOverride: null,
    lineage: { relationshipToParent: null },
    pullRequests: [],
    archivedAt: null,
    deletedAt: null,
    updatedAt: minutesAgo(minutes),
    createdAt: minutesAgo(minutes + 30),
    modelSelection: { instanceId: "claudeAgent", model: "claude-opus-5-5" },
    modelIdentity: { current: null, preferred: null, kind: null },
  }) as unknown as EnvironmentThreadShell;

// The joined seats' chats, newest first; Tower's are not reachable.
const threads = [
  thread("tax", "studio", "Estimated tax for Q4", 2),
  thread("brief", "laptop", "Morning briefing", 180),
  thread("flights", "desktop", "Flights to Lisbon", 60 * 26),
  thread("garden", "laptop", "Plant list for the spring beds", 60 * 50),
];
const scopes = ["studio", "laptop", "desktop", "tower"].map((environmentId) => ({
  environmentId: environmentId as EnvironmentId,
  projectId: `percy-${environmentId}` as ProjectId,
  coordinatorThreadId: null as ThreadId | null,
}));
// As ProjectWorkspaceSurface builds it for a linked Percy: every seat, then the open checkout.
const machineLabels = new Map<string, string>([
  ...scopes.map((scope) => [scope.environmentId, scope.environmentId] as const),
  ["studio", "Studio"],
]);
const unreachable: ReadonlySet<string> = new Set(["tower"]);
const reach: ReadonlyMap<string, MachineReachState> = new Map([["tower", "offline"]]);
const noop = () => {};

function Chats() {
  const findRef = useRef<HTMLInputElement | null>(null);
  const [query, setQuery] = useState("");
  const [findOpen, setFindOpen] = useState(false);
  return (
    <UnreachableHostsContext.Provider value={unreachable}>
      <MachineReachContext.Provider value={reach}>
        <main className="project-thread-pane sws-threads min-h-screen" data-fixture-pane>
          <ThreadsPane
            environmentId={"studio" as EnvironmentId}
            projectId="percy-studio"
            threadsLoaded
            threads={threads}
            personal
            canChange
            findRef={findRef}
            query={query}
            onQueryChange={setQuery}
            findOpen={findOpen}
            onFindOpenChange={setFindOpen}
            onOpen={noop}
            onToggleResolved={noop}
            machineLabels={machineLabels}
            renderNotice={() => <LinkedAssistantOfflineSeats scopes={scopes} />}
            bar={{
              tab: "threads",
              onTabChange: noop,
              counts: {},
              onNewThread: noop,
              onOpenPlan: noop,
              onOpenUsage: noop,
              expanded: false,
              onToggleExpanded: noop,
              onClose: noop,
            }}
          />
        </main>
      </MachineReachContext.Provider>
    </UnreachableHostsContext.Provider>
  );
}

function Settings() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <SettingsPageContainer>
        <SettingsSection id="personal-assistant" title="Assistant">
          <PercySharedSetting />
        </SettingsSection>
      </SettingsPageContainer>
    </div>
  );
}

function Sidebar() {
  return (
    <SidebarProvider>
      <aside className="h-screen w-full overflow-auto border-r border-border bg-sidebar text-sidebar-foreground sm:w-[320px]">
        <StudioSidebar />
      </aside>
    </SidebarProvider>
  );
}

const View = view === "chats" ? Chats : view === "sidebar" ? Sidebar : Settings;
createRoot(document.getElementById("root")!).render(
  <TooltipProvider>
    <div data-fixture-check>
      <View />
    </div>
  </TooltipProvider>,
);
document.body.dataset.fixtureReady = "true";
