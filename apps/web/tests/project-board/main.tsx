// The real Board tab of the project panel over 700 fictional increments.
// `?theme=dark` picks the theme; the window width decides columns or a stacked list;
// `?setup=1` is a project that has not turned SpecWeave on.
import { useState } from "react";
import { createRoot } from "react-dom/client";
import type { EnvironmentId, ProjectId } from "@specweave-studio/contracts";
import { BoardPane } from "../../src/components/studio/shell/BoardPane";
import { TooltipProvider } from "../../src/components/ui/tooltip";
import type { ProjectPaneTab } from "../../src/studio/projectPaneModel";
import { FIXTURE_MACHINE_LABELS, FIXTURE_THREADS } from "./mocks";
import "./fixture.css";

const params = new URLSearchParams(location.search);
const dark = params.get("theme") === "dark";
document.documentElement.classList.toggle("dark", dark);
// No palette override: the captures show the app's default theme.
const NOW = Date.parse("2026-11-14T18:00:00Z");
Date.now = () => NOW;

function Page() {
  const [tab, setTab] = useState<ProjectPaneTab>("board");
  const [expanded, setExpanded] = useState(window.innerWidth > 900);
  return (
    <div className="sws-project">
      <aside className="project-thread-pane sws-threads fixture-pane" data-tab={tab}>
        <BoardPane
          environmentId={"studio" as EnvironmentId}
          projectId={"atlas" as ProjectId}
          workspaceRoot="/work/atlas"
          bar={{
            tab,
            onTabChange: setTab,
            counts: {
              threads: { value: 2, label: "need you", tone: "waiting" },
              prs: { value: 4, label: "open" },
            },
            onNewThread: () => undefined,
            expanded,
            onToggleExpanded: () => setExpanded((value) => !value),
            onClose: () => undefined,
          }}
          specweave={!params.has("setup")}
          // The settings row as the app renders it while SpecWeave is off.
          setup={
            <div className="project-setting-row">
              <div>
                <h3>SpecWeave</h3>
                <p className="project-muted">
                  Off. SpecWithCode's own plan and memory are used, and nothing is added to your
                  repository.
                </p>
              </div>
              <button type="button" className="project-control">
                Set up SpecWeave
              </button>
            </div>
          }
          threads={FIXTURE_THREADS}
          machineLabels={FIXTURE_MACHINE_LABELS}
          onOpenThread={(thread) => {
            document.body.dataset.openedThread = thread.title;
          }}
          onAsk={(prompt) => {
            document.body.dataset.asked = prompt;
          }}
        />
      </aside>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <TooltipProvider>
    <Page />
  </TooltipProvider>,
);
