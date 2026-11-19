/* Synthetic data only (1427 AC-09): a window served by M5 ("this-mac") that shows linux-mini's
   coordinator. One page holds the sidebar header, the project header's tag, the machine menu,
   a reply with its label and source chip, the user's message label, a relayed note and a
   thread chip, all from the real components and phrases. `?theme=dark`, `?lang=`. */
import { createRoot } from "react-dom/client";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import type { EnvironmentThreadShell } from "@specweave-studio/client-runtime/state/shell";
import { SidebarWindowMachine } from "../../src/components/sidebar/SidebarWindowMachine";
import { CoordinatorMachineTag } from "../../src/components/studio/CoordinatorMachineTag";
import { CoordinatorReplySources } from "../../src/components/studio/CoordinatorReplySources";
import { OrchestratorSwitcher } from "../../src/components/studio/OrchestratorSwitcher";
import { ThreadLinkChipButton } from "../../src/components/ThreadLinkChip";
import { TooltipProvider } from "../../src/components/ui/tooltip";
import { isLocale, setLocalePreference, useTx } from "../../src/i18n";
import { ConversationMachineContext, senderWithMachine } from "../../src/studio/conversationMachine";
import { coordinatorExecutionLabel } from "../../src/studio/machineLabels";
import type { OrchestratorCopy } from "../../src/studio/projectCoordinatorMachine";
import { applyThemePalette } from "../../src/themePalette";
import "./fixture.css";

const params = new URLSearchParams(location.search);
const dark = params.get("theme") === "dark";
document.documentElement.classList.toggle("dark", dark);
applyThemePalette("studio-chat", dark ? "dark" : "light");
const lang = params.get("lang");
if (lang && isLocale(lang)) setLocalePreference(lang);

const WINDOW = "this-mac";
const SHOWN = "linux-mini";
const copy = (environmentId: string, machine: string): OrchestratorCopy => ({
  key: `${environmentId}:atlas`,
  machine,
  folder: "~/Projects/atlas",
  role: "coordinator",
  main: environmentId === SHOWN,
  rowRole: "linked",
  label: null as never,
  canStart: true,
});
const COPIES = [copy(SHOWN, "linux-mini"), copy(WINDOW, "M5")];
const RUNS = [{ id: "run-1", modelSelection: { instanceId: "claudeAgent", model: "claude-opus-5-5" } }];
/** A worker of linux-mini's coordinator that runs on M5. */
const worker = {
  environmentId: WINDOW,
  id: "thread-ps5",
  projectId: "atlas",
  title: "PS5 OBS",
  latestRun: { status: "running" },
  runtime: null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  hasActionableProposedPlan: false,
  archivedAt: null,
} as unknown as EnvironmentThreadShell;

function Page() {
  const tx = useTx();
  const say = (words: { text: string; values?: Readonly<Record<string, string>> }) =>
    tx(words.text, words.values);
  return (
    <div className="fixture-page">
      <div className="fixture-row" data-fixture="sidebar-header">
        <span className="text-sm font-medium">SpecWithCode</span>
        <SidebarWindowMachine />
      </div>
      <div className="sws-topbar fixture-row" data-fixture="project-header">
        <div className="sws-project-id">
          <h1>Atlas</h1>
          <CoordinatorMachineTag shownEnvironmentId={SHOWN} windowEnvironmentId={WINDOW} />
        </div>
      </div>
      <div className="fixture-row" data-fixture="switcher">
        <OrchestratorSwitcher
          label="linux-mini"
          projectTitle="Atlas"
          connected
          statusDetail=""
          current={`${SHOWN}:atlas`}
          copies={COPIES}
          unknown={[]}
          savedMachineMissing={false}
          onView={() => {}}
          onAllowWorkers={null}
          windowEnvironmentId={WINDOW}
        />
      </div>
      <ConversationMachineContext value={SHOWN}>
        <div className="project-conversation" data-fixture="conversation">
          <article className="project-message project-message-user">
            <h3>You</h3>
            <p className="project-muted" data-request-execution="">
              {say(coordinatorExecutionLabel({ role: "user", createdBy: "user", runId: "run-1" }, RUNS, "linux-mini"))}
            </p>
            <p>Why is Codex signed out on M5?</p>
          </article>
          <article className="project-message project-message-assistant">
            <h3>Coordinator</h3>
            <CoordinatorReplySources
              sources={[
                { kind: "thread", threadId: "thread-ps5", environmentId: WINDOW, title: "PS5 OBS" } as never,
                { kind: "thread", threadId: "thread-local", environmentId: SHOWN, title: "Codex token_expired on M5" } as never,
              ]}
              onOpenThread={() => {}}
            />
            <p className="project-muted" data-request-execution="">
              {say(coordinatorExecutionLabel({ role: "assistant", runId: "run-1" }, RUNS, "linux-mini"))}
            </p>
            <p>
              On M5: sign in to Codex again, then continue{" "}
              <ThreadLinkChipButton thread={worker} label="PS5 OBS" onOpen={() => {}} />.
            </p>
          </article>
          <article className="project-message project-message-relay">
            <p className="project-muted" data-relayed-from="">
              {`Message from ${senderWithMachine(worker, SHOWN)}`}
            </p>
          </article>
        </div>
      </ConversationMachineContext>
    </div>
  );
}

const router = createRouter({
  routeTree: createRootRoute({ component: Page }),
  history: createMemoryHistory({ initialEntries: ["/"] }),
});

createRoot(document.getElementById("root")!).render(
  <TooltipProvider>
    <RouterProvider router={router} />
  </TooltipProvider>,
);
