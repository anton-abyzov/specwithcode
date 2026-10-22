/**
 * Pure rules for the Design gallery: which designs a tab shows, search, the
 * `/design` URL filter, the edited-ago label and which "Make something new"
 * kinds this build offers.
 */
import {
  ProjectId,
  type DesignOwnerInput,
  type DesignSummary,
  type DesignSystemId,
} from "@specweave-studio/contracts";

import { DESIGN_FEATURES } from "../designFeatures";

export const GALLERY_TABS = ["all", "playground", "projects"] as const;
export type GalleryTab = (typeof GALLERY_TABS)[number];
export const GALLERY_TAB_LABELS: Record<GalleryTab, string> = {
  all: "All",
  playground: "Playground",
  projects: "Projects",
};

export type GalleryView = "grid" | "list";

export interface GalleryFilter {
  readonly tab: GalleryTab;
  /** Projects tab only: one project, or every project when null. */
  readonly projectId: ProjectId | null;
  readonly query: string;
}

/**
 * `/design` search params. `tab` and `project` are the gallery filter; `new`,
 * `system` and `owner` ask the page to open New design once, preselected.
 * The editor route `/design/$designKey` inherits them and ignores them.
 */
export interface DesignGallerySearch {
  readonly tab?: GalleryTab;
  readonly project?: ProjectId;
  readonly new?: "design";
  readonly system?: DesignSystemId;
  /** `playground`, or a ProjectId. */
  readonly owner?: string;
}

const text = (value: unknown, limit: number): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 &&
    trimmed.length <= limit &&
    ![...trimmed].some((char) => char.charCodeAt(0) < 0x20 || char.charCodeAt(0) === 0x7f)
    ? trimmed
    : null;
};

/** Drops anything malformed, so a hand-edited URL never breaks the page. */
export function parseDesignGallerySearch(raw: Record<string, unknown>): DesignGallerySearch {
  const tab = GALLERY_TABS.find((value) => value === raw.tab);
  const project = text(raw.project, 512);
  const system = text(raw.system, 80);
  const owner = text(raw.owner, 512);
  return {
    ...(tab ? { tab } : {}),
    ...(project ? { project: ProjectId.make(project) } : {}),
    ...(raw.new === "design" ? { new: "design" as const } : {}),
    ...(system && /^[A-Za-z0-9_-]+$/.test(system) ? { system: system as DesignSystemId } : {}),
    ...(owner ? { owner } : {}),
  };
}

/** `?project=` implies the Projects tab; a project this window does not know shows every project. */
export function galleryFilterFromSearch(
  search: DesignGallerySearch,
  projects: readonly { readonly id: ProjectId }[],
): { readonly tab: GalleryTab; readonly projectId: ProjectId | null } {
  if (search.project !== undefined) {
    const known = projects.some((project) => project.id === search.project);
    return { tab: "projects", projectId: known ? search.project : null };
  }
  return { tab: search.tab ?? "all", projectId: null };
}

/** The search params for a filter; All with no project is the bare `/design`. */
export function gallerySearchFor(filter: {
  readonly tab: GalleryTab;
  readonly projectId: ProjectId | null;
}): DesignGallerySearch {
  if (filter.tab === "projects" && filter.projectId !== null) return { project: filter.projectId };
  return filter.tab === "all" ? {} : { tab: filter.tab };
}

/**
 * The owner and system `?new=design` preselects, or null without that param.
 * An owner this window does not know falls back to the Playground.
 */
export function newDesignPresetFromSearch(
  search: DesignGallerySearch,
  projects: readonly { readonly id: ProjectId }[],
): { readonly owner: DesignOwnerInput; readonly systemId: DesignSystemId | null } | null {
  if (search.new !== "design") return null;
  const project = projects.find((candidate) => candidate.id === search.owner);
  return {
    owner: project ? { kind: "project", projectId: project.id } : { kind: "playground" },
    systemId: search.system ?? null,
  };
}

/** The search without the one-shot New design params. */
export function withoutNewDesignSearch(search: DesignGallerySearch): DesignGallerySearch {
  const { new: _new, system: _system, owner: _owner, ...rest } = search;
  return rest;
}

export function ownerInputOf(summary: DesignSummary): DesignOwnerInput {
  const owner = summary.ref.owner;
  return owner.kind === "playground"
    ? { kind: "playground" }
    : { kind: "project", projectId: owner.projectId };
}

/** A stable key for one design across owners. */
export function summaryKey(summary: DesignSummary): string {
  const owner = summary.ref.owner;
  return owner.kind === "playground"
    ? `pg:${summary.ref.designId}`
    : `p:${owner.projectId}:${summary.ref.designId}`;
}

export function filterDesigns(
  designs: readonly DesignSummary[],
  filter: GalleryFilter,
): DesignSummary[] {
  const needle = filter.query.trim().toLowerCase();
  return designs
    .filter((summary) => {
      const owner = summary.ref.owner;
      if (filter.tab === "playground" && owner.kind !== "playground") return false;
      if (filter.tab === "projects") {
        if (owner.kind !== "project") return false;
        if (filter.projectId !== null && owner.projectId !== filter.projectId) return false;
      }
      if (needle === "") return true;
      return (
        summary.title.toLowerCase().includes(needle) ||
        summary.ownerLabel.toLowerCase().includes(needle)
      );
    })
    .toSorted((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** "Edited just now", "Edited 4 min ago", "Edited 3 h ago", "Edited 2 days ago", then the date. */
export function editedAgo(updatedAt: string, now: number): string {
  const at = Date.parse(updatedAt);
  if (!Number.isFinite(at)) return "Edited";
  const elapsed = Math.max(0, now - at);
  if (elapsed < MINUTE) return "Edited just now";
  if (elapsed < HOUR) return `Edited ${Math.floor(elapsed / MINUTE)} min ago`;
  if (elapsed < DAY) return `Edited ${Math.floor(elapsed / HOUR)} h ago`;
  const days = Math.floor(elapsed / DAY);
  if (days < 7) return days === 1 ? "Edited yesterday" : `Edited ${days} days ago`;
  const date = new Date(at);
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return `Edited ${date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  })}`;
}

export type CreationKind = "design" | "design-from-code" | "slides" | "design-system";

export const CREATION_LABELS: Record<CreationKind, string> = {
  design: "Design",
  "design-from-code": "Design from code",
  slides: "Slides",
  "design-system": "Design system",
};

export const CREATION_DESCRIPTIONS: Record<CreationKind, string> = {
  design: "A blank canvas in the Playground or a project",
  "design-from-code": "An agent designs against a project's code",
  slides: "A 16:9 deck in a design system's colors and fonts",
  "design-system": "Tokens and components read from code",
};

/** Only kinds that work end to end in this build; the slides and systems lanes flip their flags. */
export function availableCreationKinds(
  features: { readonly slides: boolean; readonly designSystems: boolean } = DESIGN_FEATURES,
): CreationKind[] {
  return [
    ...(features.slides ? (["slides"] as const) : []),
    "design",
    "design-from-code",
    ...(features.designSystems ? (["design-system"] as const) : []),
  ];
}

export function kindLabel(kind: DesignSummary["kind"]): string {
  return kind === "slides" ? "Slides" : "Design";
}
