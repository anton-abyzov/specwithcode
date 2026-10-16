import { parseChangeRequestUrl } from "@specweave-studio/shared/changeRequestUrl";

import type { ThreadArtifact } from "./threadArtifacts";

/**
 * The artifacts list, organized so it stays usable at hundreds of entries:
 * pinned first, then one section per type with the newest few showing, and
 * what has gone quiet (merged or closed pull requests, files no longer on
 * disk, anything not named for a week) folded into Older. Hiding an entry
 * only takes it off the list; nothing here touches a file.
 */

export type ShelfCategory = "files" | "reports" | "pullRequests" | "links";
export type ShelfSectionId = "pinned" | ShelfCategory | "older" | "hidden" | "results";
export type ShelfAgedReason = "merged" | "closed" | "missing" | "stale";

export interface ShelfPullRequest {
  readonly state: "open" | "closed" | "merged";
  readonly title: string | null;
}

export interface ShelfEntry {
  /** One per thing: two URLs for the same pull request share it. */
  readonly id: string;
  readonly artifact: ThreadArtifact;
  readonly category: ShelfCategory;
  readonly label: string;
  /** The host for a link, the folder for a file. */
  readonly detail: string | null;
  readonly mentionedAt: number | null;
  readonly pullRequest: ShelfPullRequest | null;
  readonly pinned: boolean;
  readonly hidden: boolean;
  /** Why it sits in Older, or null while it is current. */
  readonly aged: ShelfAgedReason | null;
}

export interface ShelfSection {
  readonly id: ShelfSectionId;
  readonly label: string;
  /** What the section shows now; `total` counts the rest. */
  readonly entries: ReadonlyArray<ShelfEntry>;
  readonly total: number;
  /** Folded sections show nothing until opened. */
  readonly collapsible: boolean;
}

export interface Shelf {
  readonly sections: ReadonlyArray<ShelfSection>;
  /** What the chip counts: every entry not hidden. */
  readonly visibleCount: number;
  readonly totalCount: number;
}

export const SHELF_SECTION_LIMIT = 5;
/** Not named again for this long, an entry moves to Older. */
export const SHELF_STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;
/** Below this many entries the list is short enough to read, so there is no search field. */
export const SHELF_SEARCH_THRESHOLD = 8;

const CATEGORY_LABEL: Record<ShelfCategory, string> = {
  pullRequests: "Pull requests",
  reports: "Reports",
  files: "Files",
  links: "Links",
};
const CATEGORY_ORDER: ReadonlyArray<ShelfCategory> = ["pullRequests", "reports", "files", "links"];

const TRACKING_PARAM = /^(?:utm_.+|ref|ref_src|fbclid|gclid|mc_cid|mc_eid)$/i;

/**
 * The identity of a link for deduplication: one pull request however it was
 * linked (`/files`, `#issuecomment-1`), and one page across `www.`, a
 * trailing slash, a fragment, tracking parameters and http or https.
 */
export function canonicalLinkKey(url: string): string {
  const change = parseChangeRequestUrl(url);
  if (change) return `pr:${change.host}/${change.repository}#${change.number}`;
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
    const params = [...parsed.searchParams]
      .filter(([name]) => !TRACKING_PARAM.test(name))
      .toSorted(([left], [right]) => left.localeCompare(right));
    const query = params.length > 0 ? `?${new URLSearchParams(params).toString()}` : "";
    const port = parsed.port ? `:${parsed.port}` : "";
    return `link:${host}${port}${parsed.pathname.replace(/\/+$/, "")}${query}`;
  } catch {
    return `link:${url}`;
  }
}

/** The key pins and hides are stored under; stable across renames of the same thing. */
export function shelfEntryId(artifact: ThreadArtifact): string {
  if (artifact.kind === "link") return canonicalLinkKey(artifact.url);
  if ("meta" in artifact) return `file:${artifact.meta.filePath.replace(/(?::\d+){1,2}$/, "")}`;
  return artifact.key;
}

export function shelfCategory(artifact: ThreadArtifact): ShelfCategory {
  if (artifact.kind === "link") {
    return parseChangeRequestUrl(artifact.url) ? "pullRequests" : "links";
  }
  return artifact.kind === "html" ? "reports" : "files";
}

/** A link named only by its path tail (`pull/230`) or its own URL says little. */
function hasGenericName(artifact: Extract<ThreadArtifact, { kind: "link" }>): boolean {
  const name = artifact.name.trim();
  return /^(?:pull|pulls|merge_requests)\/\d+$/.test(name) || /^https?:\/\//i.test(name);
}

function entryLabel(artifact: ThreadArtifact, pullRequest: ShelfPullRequest | null): string {
  if (artifact.kind !== "link") return artifact.name;
  const change = parseChangeRequestUrl(artifact.url);
  if (!change || !hasGenericName(artifact)) return artifact.name;
  if (pullRequest?.title) return pullRequest.title;
  return `${change.repository.split("/").at(-1)} #${change.number}`;
}

function entryDetail(artifact: ThreadArtifact, label: string): string | null {
  if (artifact.kind === "link") {
    const change = parseChangeRequestUrl(artifact.url);
    if (!change) return artifact.host;
    const short = `${change.repository.split("/").at(-1)} #${change.number}`;
    return label === short ? artifact.host : short;
  }
  if (!("meta" in artifact)) return null;
  // The folder it sits in, near end first: the rest of the path is in search.
  const folders = artifact.meta.filePath.split("/").slice(0, -1).filter(Boolean);
  return folders.length > 0 ? folders.slice(-2).join("/") : null;
}

export interface ShelfInput {
  /** Newest first, as `useThreadArtifacts` returns them. */
  readonly artifacts: ReadonlyArray<ThreadArtifact>;
  readonly mentionedAt: (artifact: ThreadArtifact) => number | null;
  /** State of the pull requests the thread tracks, by `canonicalLinkKey`. */
  readonly pullRequests: ReadonlyMap<string, ShelfPullRequest>;
  /** Absolute paths the host no longer has. */
  readonly missingPaths: ReadonlySet<string>;
  readonly pinned: ReadonlySet<string>;
  readonly hidden: ReadonlySet<string>;
  readonly now: number;
}

/** One entry per thing, newest mention first, with its age settled. */
export function shelfEntries(input: ShelfInput): ShelfEntry[] {
  const seen = new Set<string>();
  const entries: ShelfEntry[] = [];
  for (const artifact of input.artifacts) {
    const id = shelfEntryId(artifact);
    if (seen.has(id)) continue;
    seen.add(id);
    const category = shelfCategory(artifact);
    const pullRequest = category === "pullRequests" ? (input.pullRequests.get(id) ?? null) : null;
    const mentionedAt = input.mentionedAt(artifact);
    const missing = "meta" in artifact && input.missingPaths.has(artifact.meta.filePath);
    const aged: ShelfAgedReason | null = missing
      ? "missing"
      : pullRequest?.state === "merged"
        ? "merged"
        : pullRequest?.state === "closed"
          ? "closed"
          : // An open pull request stays current however long since it was named.
            pullRequest?.state !== "open" &&
              mentionedAt !== null &&
              input.now - mentionedAt > SHELF_STALE_AFTER_MS
            ? "stale"
            : null;
    const label = entryLabel(artifact, pullRequest);
    entries.push({
      id,
      artifact,
      category,
      label,
      detail: entryDetail(artifact, label),
      mentionedAt,
      pullRequest,
      pinned: input.pinned.has(id),
      hidden: input.hidden.has(id),
      aged,
    });
  }
  return entries;
}

function searchText(entry: ShelfEntry): string {
  const { artifact } = entry;
  const location =
    artifact.kind === "link" ? artifact.url : "meta" in artifact ? artifact.meta.filePath : "";
  return [
    entry.label,
    artifact.name,
    entry.detail ?? "",
    location,
    CATEGORY_LABEL[entry.category],
    entry.pullRequest?.state ?? "",
    entry.aged === "missing" ? "missing" : "",
  ]
    .join("\n")
    .toLowerCase();
}

/** Every word must appear; a label that starts with the query ranks first. */
export function searchShelf(
  entries: ReadonlyArray<ShelfEntry>,
  query: string,
): ReadonlyArray<ShelfEntry> {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return entries;
  const scored = entries.flatMap((entry, order) => {
    const text = searchText(entry);
    if (!words.every((word) => text.includes(word))) return [];
    const label = entry.label.toLowerCase();
    const first = words[0]!;
    const rank = label.startsWith(first) ? 0 : label.includes(first) ? 1 : 2;
    // Hidden entries are still found, after everything else.
    return [{ entry, score: rank + (entry.hidden ? 3 : 0), order }];
  });
  return scored
    .toSorted((left, right) => left.score - right.score || left.order - right.order)
    .map(({ entry }) => entry);
}

export interface OrganizeOptions {
  readonly query: string;
  /** Sections the user opened: folded ones show their entries, the rest show all. */
  readonly expanded: ReadonlySet<ShelfSectionId>;
}

/** The sections the list shows, in order; empty sections are left out. */
export function organizeShelf(entries: ReadonlyArray<ShelfEntry>, options: OrganizeOptions): Shelf {
  const visibleCount = entries.filter((entry) => !entry.hidden).length;
  const totalCount = entries.length;
  if (options.query.trim().length > 0) {
    const results = searchShelf(entries, options.query);
    return {
      sections: [
        {
          id: "results",
          label: "Results",
          entries: results,
          total: results.length,
          collapsible: false,
        },
      ],
      visibleCount,
      totalCount,
    };
  }
  const sections: ShelfSection[] = [];
  const push = (id: ShelfSectionId, label: string, all: ShelfEntry[], collapsible: boolean) => {
    if (all.length === 0) return;
    const open = options.expanded.has(id);
    const shown = collapsible
      ? open
        ? all
        : []
      : open || all.length <= SHELF_SECTION_LIMIT + 1
        ? all
        : all.slice(0, SHELF_SECTION_LIMIT);
    sections.push({ id, label, entries: shown, total: all.length, collapsible });
  };
  const listed = entries.filter((entry) => !entry.hidden);
  push(
    "pinned",
    "Pinned",
    listed.filter((entry) => entry.pinned),
    false,
  );
  const unpinned = listed.filter((entry) => !entry.pinned);
  for (const category of CATEGORY_ORDER) {
    push(
      category,
      CATEGORY_LABEL[category],
      unpinned.filter((entry) => entry.category === category && entry.aged === null),
      false,
    );
  }
  push(
    "older",
    "Older",
    unpinned.filter((entry) => entry.aged !== null),
    true,
  );
  push(
    "hidden",
    "Hidden",
    entries.filter((entry) => entry.hidden),
    true,
  );
  return { sections, visibleCount, totalCount };
}

export const AGED_LABEL: Record<ShelfAgedReason, string> = {
  merged: "Merged",
  closed: "Closed",
  missing: "Missing",
  stale: "",
};
