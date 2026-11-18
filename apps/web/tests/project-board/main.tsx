// The real Board tab of the project panel over fictional increments.
// `?theme=dark` picks the theme; the window width decides columns, the split
// beside the increment view or the view in place of the list; `?setup=1` is a
// project that has not turned SpecWeave on (`?setup=unfinished` has plans
// written before setup, `?setup=failed` a setup that failed, `?setup=node`
// one that found no Node.js, and `&git=none` a folder without Git);
// `?increment=<folder>` opens a
// card's view, kept in the page history the way the app keeps it, so browser
// back closes it. `?server=old` and `?removed=<folder>` are in mocks.tsx.
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type { EnvironmentId, ProjectId } from "@specweave-studio/contracts";
import { BoardPane } from "../../src/components/studio/shell/BoardPane";
import { BoardSetupView } from "../../src/components/studio/shell/BoardSetup";
import type { SpecweaveShownState } from "../../src/components/studio/specweaveSetup.logic";
import { TooltipProvider } from "../../src/components/ui/tooltip";
import type { ProjectPaneTab } from "../../src/studio/projectPaneModel";
import { FIXTURE_MACHINE_LABELS, FIXTURE_THREADS } from "./mocks";
import "./fixture.css";

const params = new URLSearchParams(location.search);
const dark = params.get("theme") === "dark";
document.documentElement.classList.toggle("dark", dark);
// No palette override: the captures show the app's default theme. The clock is
// fixed in index.html, before any module reads it.

const setup = params.get("setup");
/** The Board tab's setup as the app shows it for each `?setup=` variant. */
function FixtureSetup() {
  const [shown, setShown] = useState<SpecweaveShownState>(
    setup === "failed"
      ? { state: "failed", detail: "SpecWeave could not be set up: this folder is inside another repository." }
      : setup === "node"
        ? { state: "node_missing", detail: "Node.js was not found." }
        : { state: "asking" },
  );
  return (
    <BoardSetupView
      kind={setup === "unfinished" ? "unfinished" : "off"}
      unfinished={{
        count: 4,
        titles: ["Export reports as CSV", "Search filters", "Onboarding tour"],
      }}
      gitRepository={params.get("git") !== "none"}
      shown={shown}
      offerNotNow={params.get("declined") !== "1"}
      onSetUp={() => {
        document.body.dataset.setUp = params.get("git") === "none" ? "with-git" : "plain";
        setShown({ state: "setting_up" });
      }}
      onNotNow={() => {
        document.body.dataset.notNow = "1";
      }}
      onInstallNode={() => {
        document.body.dataset.installNode = "1";
      }}
    />
  );
}

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
          // The tab as the app renders it while SpecWeave is off or unfinished.
          setup={<FixtureSetup />}
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
