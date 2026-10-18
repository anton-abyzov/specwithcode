import { normalizeSearchText } from "~/lib/utils";
import {
  searchSettingsGrouped,
  type GroupedSettingsSearchResult,
} from "../settings/settingsSearchModel";

export type ProjectSettingsTab = "general" | "memory" | "environment" | "usage" | "routines";

export const PROJECT_SETTINGS_TAB_LABELS: Readonly<Record<ProjectSettingsTab, string>> = {
  general: "General",
  memory: "Memory",
  environment: "Environment",
  usage: "Usage",
  routines: "Routines",
};

export const PROJECT_SETTINGS_TABS: readonly ProjectSettingsTab[] = [
  "general",
  "memory",
  "environment",
  "usage",
  "routines",
];

export function isProjectSettingsTab(value: string): value is ProjectSettingsTab {
  return Object.hasOwn(PROJECT_SETTINGS_TAB_LABELS, value);
}

export interface ProjectSettingsSearchRow {
  readonly id: string;
  readonly title: string;
  readonly tab: ProjectSettingsTab;
  /** Heading, label or legend text the row starts with in the dialog. */
  readonly anchors: readonly string[];
  readonly searchTerms?: readonly string[];
}

/** Rows of the Project settings dialog, in the order each tab renders them. */
export const PROJECT_SETTINGS_SEARCH_ROWS: readonly ProjectSettingsSearchRow[] = [
  {
    id: "project-name",
    title: "Name and icon",
    tab: "general",
    anchors: ["Name and icon"],
    searchTerms: ["rename title favicon emoji"],
  },
  {
    id: "project-goal",
    title: "Goal",
    tab: "general",
    anchors: ["Goal"],
    searchTerms: ["outcome objective"],
  },
  {
    id: "project-coordinator-model",
    title: "Coordinator model and effort",
    tab: "general",
    anchors: ["Coordinator model and effort"],
    searchTerms: ["provider reasoning thinking"],
  },
  {
    id: "project-worker-model",
    title: "Recommended model for threads",
    tab: "general",
    anchors: ["Recommended model for threads"],
    searchTerms: ["default worker subagent provider reasoning"],
  },
  {
    id: "project-recommended-model-providers",
    title: "Also served by",
    tab: "general",
    anchors: ["Also served by"],
    searchTerms: ["provider order copilot same model fallback"],
  },
  {
    id: "project-worker-machine",
    title: "Worker machine",
    tab: "general",
    anchors: ["Worker machine"],
    searchTerms: ["host remote fleet"],
  },
  {
    id: "project-auto-resume",
    title: "Automatic usage-limit recovery",
    tab: "general",
    anchors: ["Automatically arm recovery"],
    searchTerms: ["resume quota limit stop"],
  },
  {
    id: "project-usage-limits",
    title: "Usage limits",
    tab: "general",
    anchors: ["Usage limits"],
    searchTerms: ["fallback provider runs out quota"],
  },
  {
    id: "project-overrides",
    title: "Overrides",
    tab: "general",
    anchors: ["Overrides"],
    searchTerms: ["inherited defaults"],
  },
  {
    id: "project-folder",
    title: "Project folder",
    tab: "general",
    anchors: ["Project folder"],
    searchTerms: ["move path workspace root"],
  },
  {
    id: "project-pause",
    title: "Pause or resume",
    tab: "general",
    anchors: ["Pause new work", "Resume project"],
    searchTerms: ["stop admission"],
  },
  {
    id: "project-archive",
    title: "Archive project",
    tab: "general",
    anchors: ["Archive project", "Unarchive project"],
    searchTerms: ["hide unarchive"],
  },
  {
    id: "project-delete",
    title: "Delete project",
    tab: "general",
    anchors: ["Danger zone"],
    searchTerms: ["remove danger zone"],
  },
  {
    id: "project-instructions",
    title: "Project instructions",
    tab: "memory",
    anchors: ["Project instructions"],
    searchTerms: ["prompt standing context agents.md claude.md"],
  },
  {
    id: "project-memory",
    title: "Project memory",
    tab: "memory",
    anchors: ["Project memory"],
    searchTerms: ["memory.md notes files"],
  },
  {
    id: "project-additional-folders",
    title: "Approved additional folders",
    tab: "environment",
    anchors: ["Approved additional folders"],
    searchTerms: ["directories paths"],
  },
  {
    id: "project-repositories",
    title: "Repositories",
    tab: "environment",
    anchors: ["Repositories"],
    searchTerms: ["git clone checkout github"],
  },
  {
    id: "project-connections",
    title: "Connections",
    tab: "environment",
    anchors: ["SpecWithCode-managed connections"],
    searchTerms: ["mcp server command tools integrations"],
  },
  {
    id: "project-allowed-tools",
    title: "Allowed tools",
    tab: "environment",
    anchors: ["Allowed tools for this project"],
    searchTerms: ["mcp permissions grant"],
  },
  {
    id: "project-subscription-limits",
    title: "Subscription limits",
    tab: "usage",
    anchors: ["Subscription limits"],
    searchTerms: ["quota plan window"],
  },
  {
    id: "project-usage",
    title: "Project usage",
    tab: "usage",
    anchors: ["Project usage"],
    searchTerms: ["tokens cost spend threads"],
  },
  {
    id: "project-routines",
    title: "Project routines",
    tab: "routines",
    anchors: ["Project routines"],
    searchTerms: ["scheduled tasks cron recurring schedule"],
  },
];

const TAB_SEARCH_TERMS: Readonly<Record<ProjectSettingsTab, readonly string[]>> = {
  general: ["settings name goal model"],
  memory: ["instructions notes"],
  environment: ["folders repositories connections"],
  usage: ["limits tokens"],
  routines: ["scheduled tasks"],
};

export type ProjectSettingsSearchResult = GroupedSettingsSearchResult<
  ProjectSettingsTab,
  ProjectSettingsSearchRow
>;

export function searchProjectSettings(
  query: string,
  tabs: readonly ProjectSettingsTab[],
): ProjectSettingsSearchResult[] {
  return searchSettingsGrouped(
    query,
    tabs.map((tab) => ({
      section: tab,
      label: PROJECT_SETTINGS_TAB_LABELS[tab],
      searchTerms: TAB_SEARCH_TERMS[tab],
    })),
    PROJECT_SETTINGS_SEARCH_ROWS.filter((row) => tabs.includes(row.tab)),
    (row) => row.tab,
  );
}

/** The block a row's heading, label or legend belongs to inside `root`. */
export function findProjectSettingsAnchor(
  root: ParentNode,
  row: Pick<ProjectSettingsSearchRow, "anchors">,
): HTMLElement | null {
  const anchors = row.anchors.map(normalizeSearchText);
  for (const element of root.querySelectorAll<HTMLElement>("h2, h3, label, legend")) {
    if (element.closest("[hidden]")) continue;
    const text = normalizeSearchText(element.textContent ?? "");
    if (!anchors.some((anchor) => text.startsWith(anchor))) continue;
    if (element.tagName === "LABEL") return element;
    return (
      element.closest<HTMLElement>("fieldset, .project-setting-row, [data-settings-section]") ??
      element.parentElement ??
      element
    );
  }
  return null;
}
