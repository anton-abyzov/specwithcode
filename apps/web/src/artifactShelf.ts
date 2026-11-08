import { parseChangeRequestUrl } from "@specweave-studio/shared/changeRequestUrl";

import { nativeVersionLabel } from "./nativeArtifacts";
import type { ThreadArtifact, ThreadArtifactKind } from "./threadArtifacts";

/**
 * The artifacts list, organized so it stays usable at hundreds of entries:
 * pinned first, then one section per type with the newest few showing, and
 * what has gone quiet (files no longer on disk, anything not named for a
 * week) folded into Older. Raw logs fold into Logs: reachable, not counted. Pull requests are not artifacts and never list. Hiding an entry
 * only takes it off the list; nothing here touches a file.
 */

export type ShelfCategory = "files" | "reports" | "links";
export type ShelfSectionId = "pinned" | ShelfCategory | "logs" | "older" | "hidden" | "results";
export type ShelfAgedReason = "missing" | "stale";

/**
 * Where a file stands on the machine that owns the thread. `unreachable`
 * means that machine is offline or could not answer, never that the file is
 * gone; `remote-only` is a native artifact whose source left the disk while
 * its claude.ai link remains; `unknown` has not been checked.
 */
export type ShelfFileState = "present" | "missing" | "unreachable" | "remote-only" | "unknown";

/** What the host said about one path. */
export interface ShelfFileCheck {
  readonly state: "present" | "missing" | "unreachable" | "unknown";
  /** Said beside the state: "Mac mini is offline". */
  readonly reason?: string | undefined;
  /** A check is running; the state is the last one known. */
  readonly checking?: boolean | undefined;
}

/** The message, tool call or published page that named an entry. */
export interface ShelfSource {
  readonly label: string;
}

/** An entry carried over from the thread this one continued on another machine. */
export interface ShelfInherited {
  readonly machineLabel: string | null;
}

/** A folder for a narrow row: `head` may truncate, `tail` (the last folder) stays. */
export interface FolderHint {
  readonly head: string;
  readonly tail: string;
  /** The absolute folder. */
  readonly full: string;
}

export interface ShelfEntry {
  /** One per thing: two URLs for the same page share it. */
  readonly id: string;
  readonly artifact: ThreadArtifact;
  readonly category: ShelfCategory;
  readonly label: string;
  /** "Page", "Link", "Artifact": what the row is. */
  readonly kindLabel: string;
  /** The host for a link, the folder for a file. */
  readonly detail: string | null;
  /** The folder a file or a native artifact's source sits in. */
  readonly folder: FolderHint | null;
  /** The file path or URL, exactly as copied. */
  readonly fullPath: string | null;
  readonly mentionedAt: number | null;
  readonly source: ShelfSource | null;
  /** Null for links and published pages: they have no file to check. */
  readonly fileState: ShelfFileState | null;
  readonly stateReason: string | null;
  readonly checking: boolean;
  readonly inherited: ShelfInherited | null;
  readonly pinned: boolean;
  readonly hidden: boolean;
  /** Why it sits in Older, or null while it is current. */
  readonly aged: ShelfAgedReason | null;
  /** A raw log (`task-T-04.txt`, `build.log`): folded into Logs unless pinned. */
  readonly log: boolean;
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
  /** What the chip counts: every entry not hidden, and not a log. */
  readonly visibleCount: number;
  readonly totalCount: number;
}

export const SHELF_SECTION_LIMIT = 5;
/** Not named again for this long, an entry moves to Older. */
export const SHELF_STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;
/** Below this many entries the list is short enough to read, so there is no search field. */
export const SHELF_SEARCH_THRESHOLD = 8;

const CATEGORY_LABEL: Record<ShelfCategory, string> = {
  reports: "Reports",
  files: "Files",
  links: "Links",
};
const CATEGORY_ORDER: ReadonlyArray<ShelfCategory> = ["reports", "files", "links"];

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
  // By its link, as the reply's own mention of the URL is: one entry, and a
  // pin made on either survives new versions.
  if (artifact.kind === "native") {
    return artifact.native.url === null ? artifact.key : canonicalLinkKey(artifact.native.url);
  }
  if ("meta" in artifact) return `file:${artifact.meta.filePath.replace(/(?::\d+){1,2}$/, "")}`;
  return artifact.key;
}

/** Plain-text output nobody reads as a document: run logs, task evidence, files with no extension. */
const PLAIN_TEXT_LOG = /\.(?:txt|log|out|err)$/i;

/**
 * Whether a file is a raw log rather than something made to be read, such as
 * the `task-T-04.txt` evidence `specweave task done --run` writes. Logs stay
 * reachable (a thread folds them, the Library lists them) but are not shown
 * as deliverables.
 */
export function isPlainTextLog(path: string): boolean {
  const base = path.replace(/(?::\d+){1,2}$/, "").replace(/[\\/]+$/, "");
  const name = base.slice(Math.max(base.lastIndexOf("/"), base.lastIndexOf("\\")) + 1);
  if (name.length === 0 || name.startsWith(".")) return false;
  return PLAIN_TEXT_LOG.test(name) || !name.includes(".");
}

export function shelfCategory(artifact: ThreadArtifact): ShelfCategory {
  if (artifact.kind === "link") return "links";
  return artifact.kind === "html" || artifact.kind === "native" ? "reports" : "files";
}

/** What an artifact is, in the viewer header's and the list's words. */
export const ARTIFACT_KIND_LABEL: Record<ThreadArtifactKind, string> = {
  image: "Image",
  video: "Video",
  audio: "Audio",
  html: "Page",
  markdown: "Document",
  pdf: "PDF",
  code: "File",
  file: "File",
  link: "Link",
  native: "Artifact",
};

export function shelfKindLabel(artifact: ThreadArtifact): string {
  return ARTIFACT_KIND_LABEL[artifact.kind];
}

function lastSeparator(path: string): number {
  return Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
}

/** A home folder reads as `~`, as a terminal shows it. */
function homeShortened(folder: string): string {
  return folder.replace(/^\/(?:Users|home)\/[^/]+(?=\/|$)/, "~");
}

/**
 * The folder a file sits in, cut for a narrow row: inside `root` it reads
 * from the root's own name (`report-experience-1035/apps/web/`), and the last
 * folder is kept whole, so `increments/1041-fix-design` never loses its end.
 */
export function folderHint(filePath: string, root?: string | null): FolderHint | null {
  const cut = lastSeparator(filePath);
  if (cut <= 0) return null;
  const full = filePath.slice(0, cut);
  const separator = filePath[cut]!;
  const base = root ? root.replace(/[\\/]+$/, "") : null;
  let shown = homeShortened(full);
  if (base && (full === base || full.startsWith(`${base}${separator}`))) {
    const rootName = base.slice(lastSeparator(base) + 1) || base;
    shown = `${rootName}${full.slice(base.length)}`;
  }
  const split = lastSeparator(shown);
  if (split < 0) return { head: "", tail: shown, full };
  const tail = shown.slice(split + 1);
  if (tail.length === 0) return { head: "", tail: shown, full };
  return { head: shown.slice(0, split + 1), tail, full };
}

function entryDetail(artifact: ThreadArtifact): string | null {
  if (artifact.kind === "link") return artifact.host;
  if (artifact.kind === "native") {
    const folder = folderHint(artifact.native.localPath)?.tail;
    return [nativeVersionLabel(artifact.native), folder].filter(Boolean).join(" · ") || null;
  }
  if (!("meta" in artifact)) return null;
  // The folder it sits in, near end first: the rest of the path is in search.
  const folders = artifact.meta.filePath.split("/").slice(0, -1).filter(Boolean);
  return folders.length > 0 ? folders.slice(-2).join("/") : null;
}

/** The local file behind an entry, if it has one to check. */
export function shelfLocalPath(artifact: ThreadArtifact): string | null {
  if (artifact.kind === "native") return artifact.native.localPath;
  return "meta" in artifact ? artifact.meta.filePath : null;
}

function fullPathOf(artifact: ThreadArtifact): string | null {
  if (artifact.kind === "link") return artifact.url;
  return shelfLocalPath(artifact);
}

function fileStateOf(
  artifact: ThreadArtifact,
  check: ShelfFileCheck | undefined,
): ShelfFileState | null {
  const path = shelfLocalPath(artifact);
  if (path === null) return null;
  const state = check?.state ?? "unknown";
  // The page is still on claude.ai; only its source left the disk. Without a
  // link there is nothing left to open, so it is missing like any file.
  if (artifact.kind === "native" && artifact.native.url !== null && state === "missing") {
    return "remote-only";
  }
  return state;
}

export interface ShelfInput {
  /** Newest first, as `useThreadArtifacts` returns them. */
  readonly artifacts: ReadonlyArray<ThreadArtifact>;
  readonly mentionedAt: (artifact: ThreadArtifact) => number | null;
  /** What the host said about each local path; a path it has not answered for is unknown. */
  readonly fileChecks: ReadonlyMap<string, ShelfFileCheck>;
  readonly source?: ((artifact: ThreadArtifact) => ShelfSource | null) | undefined;
  readonly inherited?: ((artifact: ThreadArtifact) => ShelfInherited | null) | undefined;
  /** The thread's workspace: folders inside it read from its name. */
  readonly root?: string | null | undefined;
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
    // Pull requests are not artifacts: the thread header and the PRs tab carry them.
    if (id.startsWith("pr:")) continue;
    const category = shelfCategory(artifact);
    const mentionedAt = input.mentionedAt(artifact);
    const localPath = shelfLocalPath(artifact);
    const check = localPath === null ? undefined : input.fileChecks.get(localPath);
    const fileState = fileStateOf(artifact, check);
    // Only a file the host says is gone folds away: an offline machine or an
    // unanswered check leaves it where it is.
    const aged: ShelfAgedReason | null =
      fileState === "missing"
        ? "missing"
        : mentionedAt !== null && input.now - mentionedAt > SHELF_STALE_AFTER_MS
          ? "stale"
          : null;
    const label = artifact.name;
    entries.push({
      id,
      artifact,
      category,
      label,
      kindLabel: shelfKindLabel(artifact),
      detail: entryDetail(artifact),
      folder: localPath === null ? null : folderHint(localPath, input.root),
      fullPath: fullPathOf(artifact),
      mentionedAt,
      source: input.source?.(artifact) ?? null,
      fileState,
      stateReason: fileState === null ? null : (check?.reason ?? null),
      checking: check?.checking === true,
      inherited: input.inherited?.(artifact) ?? null,
      pinned: input.pinned.has(id),
      hidden: input.hidden.has(id),
      aged,
      log: artifact.kind !== "native" && localPath !== null && isPlainTextLog(localPath),
    });
  }
  return entries;
}

function searchText(entry: ShelfEntry): string {
  const { artifact } = entry;
  return [
    entry.label,
    artifact.name,
    entry.kindLabel,
    entry.detail ?? "",
    entry.fullPath ?? "",
    artifact.kind === "native" ? `${artifact.native.url ?? ""}\nclaude.ai artifact` : "",
    CATEGORY_LABEL[entry.category],
    shelfStateLabel(entry) ?? "",
    entry.source?.label ?? "",
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
  const visibleCount = entries.filter(
    (entry) => !entry.hidden && (entry.pinned || !entry.log),
  ).length;
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
  const unpinned = listed.filter((entry) => !entry.pinned && !entry.log);
  for (const category of CATEGORY_ORDER) {
    push(
      category,
      CATEGORY_LABEL[category],
      unpinned.filter((entry) => entry.category === category && entry.aged === null),
      false,
    );
  }
  push(
    "logs",
    "Logs",
    listed.filter((entry) => !entry.pinned && entry.log),
    true,
  );
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
  missing: "Missing",
  stale: "",
};

export const FILE_STATE_LABEL: Record<ShelfFileState, string> = {
  present: "",
  missing: "Missing",
  unreachable: "Unreachable",
  "remote-only": "Remote only",
  unknown: "Not checked",
};

/** The state a row names, or null when there is nothing to say. */
export function shelfStateLabel(entry: Pick<ShelfEntry, "fileState" | "checking">): string | null {
  if (entry.fileState === null || entry.fileState === "present") return null;
  if (entry.fileState === "unknown" && entry.checking) return "Checking";
  return FILE_STATE_LABEL[entry.fileState];
}

const SHELF_TIME = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const SHELF_DATE = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
const SHELF_DATE_WITH_YEAR = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  year: "numeric",
});

/** When a row's source was written: the time today, "Oct 24" this year, "Oct 24, 2025" before. */
export function formatShelfTime(at: number, now: number, locale?: string): string {
  const date = new Date(at);
  const today = new Date(now);
  const formats =
    locale === undefined
      ? { time: SHELF_TIME, date: SHELF_DATE, year: SHELF_DATE_WITH_YEAR }
      : {
          time: new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit" }),
          date: new Intl.DateTimeFormat(locale, { month: "short", day: "numeric" }),
          year: new Intl.DateTimeFormat(locale, {
            month: "short",
            day: "numeric",
            year: "numeric",
          }),
        };
  if (date.toDateString() === today.toDateString()) return formats.time.format(date);
  return (date.getFullYear() === today.getFullYear() ? formats.date : formats.year).format(date);
}
