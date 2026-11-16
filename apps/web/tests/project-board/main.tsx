// The real Board tab of the project panel over fictional increments.
// `?theme=dark` picks the theme; the window width decides columns, the split
// beside the increment view or the view in place of the list; `?setup=1` is a
// project that has not turned SpecWeave on; `?increment=<folder>` opens a
// card's view, kept in the page history the way the app keeps it, so browser
// back closes it. `?server=old` and `?removed=<folder>` are in mocks.tsx.
import { useEffect, useState } from "react";
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
// No palette override: the captures show the app's default theme. The clock is
// fixed in index.html, before any module reads it.

const incrementInUrl = () => new URLSearchParams(location.search).get("increment") || null;

/** The open increment as the page's navigation state: open pushes, walking and closing replace. */
function useIncrementInUrl() {
  const [incrementId, setIncrementId] = useState(incrementInUrl);
  useEffect(() => {
    const onPop = () => setIncrementId(incrementInUrl());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  const open = (next: string | null, options?: { readonly replace?: boolean }) => {
    const search = new URLSearchParams(location.search);
    if (next === null) search.delete("increment");
    else search.set("increment", next);
    const url = `${location.pathname}${search.size > 0 ? `?${search}` : ""}`;
    if (options?.replace) history.replaceState(null, "", url);
    else history.pushState(null, "", url);
    setIncrementId(next);
  };
  return { incrementId, open };
}

function Page() {
  const [tab, setTab] = useState<ProjectPaneTab>("board");
  const [expanded, setExpanded] = useState(window.innerWidth > 900);
  const route = useIncrementInUrl();
  return (
    <div className="sws-project">
      <aside className="project-thread-pane sws-threads fixture-pane" data-tab={tab}>
        <BoardPane
          environmentId={"desk" as EnvironmentId}
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
          openIncrement={route.incrementId}
          onOpenIncrement={route.open}
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
