/**
 * What an artifact card previews and how finished previews are kept: which
 * files get a page, the lines a text page shows, and a memory cache bounded
 * by bytes. Nothing here reads a file or touches the disk.
 */
import type { ProjectArtifact } from "./projectArtifacts";

export type ArtifactPreviewFormat = "image" | "html" | "markdown" | "text";

export interface ArtifactPreviewLine {
  readonly text: string;
  readonly heading?: 1 | 2 | 3 | undefined;
}

/**
 * A finished preview. `original` is an image that could not be scaled, shown
 * from a live URL because its URLs expire; `none` remembers that a file has
 * nothing to show.
 */
export type ArtifactPreview =
  | {
      readonly type: "image";
      readonly src: string;
      /** The colour the picture leans to, for the card behind it. */
      readonly tint?: string | undefined;
      /** A document's own heading. */
      readonly title?: string | undefined;
    }
  | { readonly type: "original" }
  | {
      readonly type: "lines";
      readonly mono: boolean;
      readonly lines: ReadonlyArray<ArtifactPreviewLine>;
    }
  | { readonly type: "none" };

/** Documents small enough to read for a page on their card. */
const TEXT_MAX_BYTES = 512 * 1024;
/** Images are read whole to scale them, so the largest screenshots stay a plain card. */
export const IMAGE_MAX_BYTES = 24 * 1024 * 1024;
const PREVIEW_CHARS = 1600;
const PREVIEW_LINES = 14;

function isRelative(path: string): boolean {
  return !path.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(path);
}

export function artifactPreviewFormat(artifact: ProjectArtifact): ArtifactPreviewFormat | null {
  if (artifact.path === null || artifact.missing) return null;
  const size = artifact.byteLength ?? 0;
  if (artifact.kind === "image") return size > IMAGE_MAX_BYTES ? null : "image";
  // Files only the thread's own worktree has are read where they open, not here.
  if (!isRelative(artifact.path) || size > TEXT_MAX_BYTES) return null;
  if (artifact.kind === "data" || artifact.kind === "code") return "text";
  if (artifact.kind !== "document" && artifact.kind !== "page") return null;
  if (/\.(md|markdown|mdx)$/i.test(artifact.path)) return "markdown";
  if (/\.html?$/i.test(artifact.path)) return "html";
  if (/\.(txt|log|text)$/i.test(artifact.path)) return "text";
  return null;
}

/** The first lines of a markdown file as a small page: its heading, then text. */
export function markdownPreviewLines(text: string): ReadonlyArray<ArtifactPreviewLine> {
  return text
    .slice(0, PREVIEW_CHARS)
    .replace(/^---\n[\s\S]*?\n---\n/, "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !/^(```|<!--|\|?\s*-{3,})/.test(line))
    .slice(0, PREVIEW_LINES)
    .map((line) => {
      const heading = /^(#{1,6})\s+(.*)$/.exec(line);
      const plain = (heading ? heading[2]! : line)
        .replace(/^[-*+]\s+|^\d+\.\s+|^>\s*/, "")
        .replace(/[*_`]|\[([^\]]*)\]\([^)]*\)/g, (_match, label?: string) => label ?? "");
      return heading
        ? { text: plain, heading: Math.min(heading[1]!.length, 3) as 1 | 2 | 3 }
        : { text: plain };
    });
}

/** The first lines of anything else, as they are. */
export function plainPreviewLines(text: string): ReadonlyArray<ArtifactPreviewLine> {
  return text
    .slice(0, PREVIEW_CHARS)
    .split("\n")
    .map((line) => line.trimEnd().slice(0, 120))
    .filter((line) => line.trim() !== "")
    .slice(0, PREVIEW_LINES)
    .map((line) => ({ text: line }));
}

/** The number of document tints in `panes.css`. */
const DOCUMENT_TINTS = 5;

/** A document's card keeps its own tint, so a row of white pages still reads apart. */
export function artifactTintIndex(id: string): number {
  let hash = 0;
  for (let index = 0; index < id.length; index += 1) {
    hash = (hash * 31 + id.charCodeAt(index)) | 0;
  }
  return Math.abs(hash) % DOCUMENT_TINTS;
}

/** A changed file has a new date or size, so it gets a new preview. */
export function artifactPreviewKey(artifact: ProjectArtifact, scope: string): string {
  return [scope, artifact.root ?? "", artifact.path, artifact.updatedAt, artifact.byteLength].join(
    "\u0000",
  );
}

function previewBytes(preview: ArtifactPreview): number {
  if (preview.type === "image") {
    return preview.src.length + (preview.title?.length ?? 0) + (preview.tint?.length ?? 0);
  }
  if (preview.type !== "lines") return 16;
  return preview.lines.reduce((sum, line) => sum + line.text.length + 16, 32);
}

/** Least recently used previews go first once the entries pass `maxBytes`. */
export class ArtifactPreviewCache {
  private readonly entries = new Map<string, ArtifactPreview>();
  private readonly listeners = new Map<string, Set<() => void>>();
  private bytes = 0;

  constructor(private readonly maxBytes: number) {}

  peek(key: string): ArtifactPreview | undefined {
    return this.entries.get(key);
  }

  /** Marks a preview as just used. */
  touch(key: string): void {
    const preview = this.entries.get(key);
    if (preview === undefined) return;
    this.entries.delete(key);
    this.entries.set(key, preview);
  }

  set(key: string, preview: ArtifactPreview): void {
    const previous = this.entries.get(key);
    if (previous !== undefined) {
      this.bytes -= previewBytes(previous);
      this.entries.delete(key);
    }
    this.entries.set(key, preview);
    this.bytes += previewBytes(preview);
    for (const [oldest, entry] of this.entries) {
      if (this.bytes <= this.maxBytes || oldest === key) break;
      this.entries.delete(oldest);
      this.bytes -= previewBytes(entry);
    }
    for (const listener of this.listeners.get(key) ?? []) listener();
  }

  subscribe(key: string, listener: () => void): () => void {
    const set = this.listeners.get(key) ?? new Set();
    set.add(listener);
    this.listeners.set(key, set);
    return () => {
      set.delete(listener);
      if (set.size === 0) this.listeners.delete(key);
    };
  }

  clear(): void {
    this.entries.clear();
    this.bytes = 0;
  }

  stats(): { readonly entries: number; readonly bytes: number } {
    return { entries: this.entries.size, bytes: this.bytes };
  }
}

/** Far more than a screen of cards; whatever falls out is drawn again on the way back. */
export const artifactPreviewCache = new ArtifactPreviewCache(8 * 1024 * 1024);

/** At most `limit` previews build at once; the newest request goes first. */
export class ArtifactPreviewSlots {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  /** Calls `granted` when a slot is free; the returned function gives it back or cancels. */
  acquire(granted: () => void): () => void {
    let held = false;
    let released = false;
    const start = () => {
      held = true;
      this.active += 1;
      granted();
    };
    if (this.active < this.limit) start();
    else this.waiting.push(start);
    return () => {
      if (released) return;
      released = true;
      if (!held) {
        const index = this.waiting.indexOf(start);
        if (index !== -1) this.waiting.splice(index, 1);
        return;
      }
      this.active -= 1;
      this.waiting.pop()?.();
    };
  }
}

export const artifactPreviewSlots = new ArtifactPreviewSlots(3);
