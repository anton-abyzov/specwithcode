/**
 * The project panel's top bar, as in the Claude desktop app: Threads, Designs,
 * Library, PRs and Routines tabs, a + button that asks the coordinator for a thread,
 * then the tab's own tools, expand and close. Plan and Usage open existing views, so
 * they live in the project header's More menu, not here.
 * The panel runs the full window height, so this bar shares the title row with
 * the coordinator's top bar and drags the window like it.
 */
import {
  CalendarClockIcon,
  FolderOpenIcon,
  Maximize2Icon,
  MessagesSquareIcon,
  Minimize2Icon,
  PaletteIcon,
  PlusIcon,
  XIcon,
  type LucideIcon,
} from "lucide-react";
import { useRef, type KeyboardEvent, type ReactNode } from "react";

import { isElectron } from "../../../env";
import { cn } from "../../../lib/utils";

import {
  PROJECT_PANE_TAB_LABELS,
  PROJECT_PANE_TABS,
  type ProjectPaneTab,
} from "../../../studio/projectPaneModel";
import { paneWords } from "../../../studio/assistantTerms";
import { PullRequestGlyph } from "../../pullRequest/pullRequestIcons";
import { Tip } from "./Tip";

const TAB_ICONS: Record<ProjectPaneTab, LucideIcon> = {
  threads: MessagesSquareIcon,
  designs: PaletteIcon,
  library: FolderOpenIcon,
  prs: PullRequestGlyph.pullRequest,
  scheduled: CalendarClockIcon,
};

/** What every tab's bar shares; each pane adds its own tools. */
export interface ProjectPaneBarProps {
  tab: ProjectPaneTab;
  onTabChange: (tab: ProjectPaneTab) => void;
  /** Badges: threads waiting on the person, open pull requests, enabled routines. */
  counts: Partial<Record<ProjectPaneTab, { value: number; label: string; tone?: "waiting" }>>;
  /** Points the person at the coordinator, which starts threads. */
  onNewThread: () => void;
  expanded: boolean;
  onToggleExpanded: () => void;
  onClose: () => void;
  /** The personal assistant says topics where a project says threads. */
  personal?: boolean;
}

export function ProjectPaneBar({ tools, ...props }: ProjectPaneBarProps & { tools?: ReactNode }) {
  const tabRefs = useRef(new Map<ProjectPaneTab, HTMLButtonElement>());
  const say = paneWords(props.personal);
  // Arrow keys move between tabs, as a tablist does; Tab leaves the list.
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).getAttribute("role") !== "tab") return;
    const step =
      event.key === "ArrowRight"
        ? 1
        : event.key === "ArrowLeft"
          ? -1
          : event.key === "Home"
            ? 0
            : null;
    if (step === null && event.key !== "End") return;
    event.preventDefault();
    const index = PROJECT_PANE_TABS.indexOf(props.tab);
    const next =
      event.key === "Home"
        ? PROJECT_PANE_TABS[0]
        : event.key === "End"
          ? PROJECT_PANE_TABS[PROJECT_PANE_TABS.length - 1]!
          : PROJECT_PANE_TABS[
              (index + (step ?? 0) + PROJECT_PANE_TABS.length) % PROJECT_PANE_TABS.length
            ]!;
    props.onTabChange(next);
    tabRefs.current.get(next)?.focus();
  };
  return (
    <div className={cn("sws-pane-head sws-threads-bar sws-pane-bar", isElectron && "drag-region")}>
      <div
        className="sws-pane-tabs"
        role="tablist"
        aria-label={props.personal ? "Aide panel" : "Project panel"}
        onKeyDown={onKeyDown}
      >
        {PROJECT_PANE_TABS.map((tab) => {
          const Icon = TAB_ICONS[tab];
          const selected = props.tab === tab;
          const count = props.counts[tab];
          return (
            <button
              key={tab}
              ref={(node) => {
                if (node) tabRefs.current.set(tab, node);
                else tabRefs.current.delete(tab);
              }}
              type="button"
              role="tab"
              id={`sws-pane-tab-${tab}`}
              aria-selected={selected}
              aria-controls={`sws-pane-${tab}`}
              tabIndex={selected ? 0 : -1}
              className="sws-pane-tab"
              data-tab={tab}
              onClick={() => props.onTabChange(tab)}
            >
              <Icon aria-hidden />
              <span className="sws-pane-tab-label">{say(PROJECT_PANE_TAB_LABELS[tab])}</span>
              {count && count.value > 0 ? (
                <span
                  className={`sws-count${count.tone === "waiting" ? " sws-count-waiting" : ""}`}
                >
                  {count.value}
                  <span className="sr-only"> {say(count.label)}</span>
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
      <Tip label={say("Ask the coordinator for a thread")}>
        <button
          type="button"
          className="sws-icon-button"
          aria-label={say("Ask the coordinator for a thread")}
          onClick={props.onNewThread}
        >
          <PlusIcon aria-hidden />
        </button>
      </Tip>
      <div className="sws-threads-tools">
        {tools}
        <Tip label={props.expanded ? "Restore panel" : "Expand panel"}>
          <button
            type="button"
            className="sws-icon-button"
            aria-label={props.expanded ? "Restore panel" : "Expand panel"}
            aria-pressed={props.expanded}
            onClick={props.onToggleExpanded}
          >
            {props.expanded ? <Minimize2Icon aria-hidden /> : <Maximize2Icon aria-hidden />}
          </button>
        </Tip>
        <Tip label="Hide overview">
          <button
            type="button"
            className="sws-icon-button"
            aria-label="Hide overview"
            onClick={props.onClose}
          >
            <XIcon aria-hidden />
          </button>
        </Tip>
      </div>
    </div>
  );
}
