/*
 * Synthetic data only: the project top bar from Anton's November 19 screenshot, with the
 * real TimelineDetailMenu between the workers button and project settings.
 * `?theme=dark` the theme, `?style=detailed|mixed` the reply style.
 */
import { createRoot } from "react-dom/client";
import {
  BotIcon,
  EllipsisVerticalIcon,
  FolderIcon,
  PaletteIcon,
  PanelRightIcon,
  SettingsIcon,
} from "lucide-react";
import type { EnvironmentId, ProjectId } from "@specweave-studio/contracts";
import { TimelineDetailMenu } from "../../src/components/chat/TimelineDetailMenu";
import { TooltipProvider } from "../../src/components/ui/tooltip";
import "../../src/components/studio/shell/shell.css";
import "./fixture.css";

const params = new URLSearchParams(location.search);
document.documentElement.classList.toggle("dark", params.get("theme") === "dark");
const project = { environmentId: "env" as EnvironmentId, projectId: "project" as ProjectId };

function Bar() {
  return (
    <div data-bar className="sws-project">
      <div className="project-topbar sws-topbar" style={{ display: "flex", flex: 1 }}>
        <div className="sws-project-id">
          <FolderIcon aria-hidden className="size-5" />
          <strong>specweave</strong>
        </div>
        <div
          className="project-header-actions sws-top-actions"
          style={{ display: "flex", alignItems: "center", gap: 4, marginLeft: "auto" }}
        >
          <button type="button" className="project-control sws-top-button sws-overview-toggle">
            <PaletteIcon aria-hidden />
            <span>Designs</span>
            <span className="sws-count">1</span>
          </button>
          <button type="button" className="project-control sws-top-button sws-overview-toggle">
            <PanelRightIcon aria-hidden />
            <span>Overview</span>
          </button>
          <button type="button" className="sws-icon-button" style={{ width: "auto", gap: 4 }}>
            <BotIcon aria-hidden />
            <span className="text-xs">9</span>
          </button>
          <TimelineDetailMenu appearance="project" threadKey="env:coordinator" project={project} />
          <button type="button" className="sws-icon-button" aria-label="Project settings">
            <SettingsIcon aria-hidden />
          </button>
          <button type="button" className="sws-icon-button" aria-label="More">
            <EllipsisVerticalIcon aria-hidden />
          </button>
        </div>
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <TooltipProvider>
    <Bar />
  </TooltipProvider>,
);
requestAnimationFrame(() => document.body.setAttribute("data-fixture-ready", ""));
