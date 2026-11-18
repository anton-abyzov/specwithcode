/*
 * Synthetic machines only: the production Threads pane, signed-out banner and
 * account button for a window whose SpecWithCode Connect sign-in has ended
 * (1417). "Office Mac" is reached only through Connect and needs the sign-in;
 * "Build box" is one this machine's server reaches and this window is still
 * retrying; "Mac mini" is connected by a paired route.
 *
 * `?account=signed-in` is the startup race: Clerk says signed in while the
 * relay client is still being handed the session, so the gated projection has
 * no sign-in mark. `?account=ending` is signed in with 100 minutes left
 * (AC-11); `?account=rejected` is signed in while the relay refuses the
 * sign-in (AC-13). `?theme=dark` the theme.
 */
import { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { ProviderInstanceId, type ModelSelection } from "@specweave-studio/contracts";
import type { EnvironmentThreadShell } from "@specweave-studio/client-runtime/state/shell";
import type { MachineReachState } from "@specweave-studio/client-runtime/connection";
import { AccountMenuView } from "../../src/components/account/AccountMenu";
import { ThreadsPane } from "../../src/components/studio/shell/ThreadsPane";
import { Sidebar, SidebarMenu, SidebarProvider } from "../../src/components/ui/sidebar";
import { TooltipProvider } from "../../src/components/ui/tooltip";
import type { HostDownNote } from "../../src/lib/machineStatus";
import {
  FleetReachableContext,
  HostDownNoteContext,
  MachineReachContext,
  UnreachableHostsContext,
} from "../../src/studio/unreachableHosts";
import "./fixture.css";

const params = new URLSearchParams(location.search);
document.documentElement.classList.toggle("dark", params.get("theme") === "dark");
const accountState = params.get("account") ?? "signed-out";
const signedOut = accountState === "signed-out";

const opus = {
  instanceId: ProviderInstanceId.make("claudeAgent"),
  model: "claude-opus-5-5",
} as ModelSelection;
const now = Date.now();
const ago = (minutes: number) => new Date(now - minutes * 60_000).toISOString();
const thread = (
  id: string,
  environmentId: string,
  title: string,
  minutes: number,
): EnvironmentThreadShell =>
  ({
    id,
    environmentId,
    projectId: "project",
    title,
    createdBy: "agent",
    runtime: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    settledOverride: null,
    lineage: { relationshipToParent: null },
    pullRequests: [],
    archivedAt: null,
    deletedAt: null,
    updatedAt: ago(minutes),
    createdAt: ago(minutes + 60),
    modelSelection: opus,
    modelIdentity: { current: opus, preferred: null, kind: null },
  }) as unknown as EnvironmentThreadShell;

const threads = [
  thread("office-1", "env-office", "Read the device approval state", 120),
  thread("office-2", "env-office", "List devices with short IDs", 300),
  thread("office-3", "env-office", "Check the first project gets its plan", 360),
  thread("build-1", "env-build", "Nightly build notes", 1440),
  thread("laptop-1", "env-laptop", "Tidy the release notes", 15),
  thread("mini-1", "env-mini", "Resize the thumbnails", 45),
];

const unreachable: ReadonlySet<string> = new Set(["env-office", "env-build"]);
const reach: ReadonlyMap<string, MachineReachState> = new Map([
  ["env-office", "stopped"],
  ["env-build", "not-answering"],
]);
// What UnreachableHostsProvider builds from the gated projection.
const notes: ReadonlyMap<string, HostDownNote> = new Map(
  signedOut
    ? [
        ["env-office", "needs-sign-in"],
        ["env-build", "reachable-from-machine"],
      ]
    : [["env-build", "reachable-from-machine"]],
);
const fleetReachable: ReadonlySet<string> = new Set(["env-office", "env-mini", "env-build"]);
const noop = () => {};

function Harness() {
  const findRef = useRef<HTMLInputElement | null>(null);
  const [query, setQuery] = useState("");
  const [findOpen, setFindOpen] = useState(false);
  return (
    <UnreachableHostsContext.Provider value={unreachable}>
      <MachineReachContext.Provider value={reach}>
        <FleetReachableContext.Provider value={fleetReachable}>
          <HostDownNoteContext.Provider value={notes}>
            <div className="fixture">
              <main className="project-thread-pane sws-threads" data-fixture-pane>
                <ThreadsPane
                  environmentId={"env-laptop" as never}
                  threads={threads}
                  canChange
                  findRef={findRef}
                  query={query}
                  onQueryChange={setQuery}
                  findOpen={findOpen}
                  onFindOpenChange={setFindOpen}
                  onOpen={noop}
                  onToggleResolved={noop}
                  machineLabels={
                    new Map([
                      ["env-laptop", "Laptop"],
                      ["env-office", "Office Mac"],
                      ["env-mini", "Mac mini"],
                      ["env-build", "Build box"],
                    ])
                  }
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
              <SidebarProvider>
                <Sidebar>
                  <div className="mt-auto p-2" data-fixture-account>
                    <SidebarMenu className="flex-row items-center">
                      <AccountMenuView
                        compact={false}
                        machine="Laptop"
                        connect={{
                          account: signedOut
                            ? { status: "signedOut", linked: true, cutsOff: true }
                            : {
                                status: "signedIn",
                                name: "Ada Lovelace",
                                email: "ada@example.com",
                                ...(accountState === "ending" ? { sessionEndsIn: "1h 40m" } : {}),
                              },
                          onSignIn: noop,
                          onManage: noop,
                          onSignOut: noop,
                        }}
                        usageShortcut="⌘U"
                        pullRequestsSupported
                        onNavigate={noop}
                        onOpenPullRequests={noop}
                        onAddDevice={noop}
                      />
                    </SidebarMenu>
                  </div>
                </Sidebar>
              </SidebarProvider>
            </div>
          </HostDownNoteContext.Provider>
        </FleetReachableContext.Provider>
      </MachineReachContext.Provider>
    </UnreachableHostsContext.Provider>
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
document.body.dataset.fixtureReady = "true";
createRoot(document.getElementById("root")!).render(<RouterProvider router={router} />);
