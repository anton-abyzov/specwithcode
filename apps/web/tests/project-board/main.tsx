// The real Board tab of the project panel over 700 fictional increments.
// `?theme=dark` picks the theme; the window width decides columns or a stacked list.
import { useState } from "react";
import { createRoot } from "react-dom/client";
import type { EnvironmentId, ProjectId } from "@specweave-studio/contracts";
import { BoardPane } from "../../src/components/studio/shell/BoardPane";
import { TooltipProvider } from "../../src/components/ui/tooltip";
import type { ProjectPaneTab } from "../../src/studio/projectPaneModel";
import { applyThemePalette } from "../../src/themePalette";
import "./fixture.css";

const params = new URLSearchParams(location.search);
const dark = params.get("theme") === "dark";
document.documentElement.classList.toggle("dark", dark);
applyThemePalette("studio-chat", dark ? "dark" : "light");
const NOW = Date.parse("2026-11-14T18:00:00Z");
Date.now = () => NOW;

function Page() {
  const [tab, setTab] = useState<ProjectPaneTab>("board");
  const [expanded, setExpanded] = useState(window.innerWidth > 900);
  return (
    <div className="sws-project">
      <aside className="project-thread-pane sws-threads fixture-pane" data-tab={tab}>
        <BoardPane
          environmentId={"m4" as EnvironmentId}
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
