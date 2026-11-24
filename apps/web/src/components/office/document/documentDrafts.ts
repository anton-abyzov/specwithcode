import type { JSONContent } from "@tiptap/core";

/**
 * Edits that were not on disk when their editor closed, by draft key. They are
 * kept in this window's storage too, so a refresh or a quit loses nothing; a
 * draft the storage refused (too large, storage off) asks before the window closes.
 */
interface Draft {
  readonly content: JSONContent;
  /** The file revision the edits were made on, so their save still checks against it. */
  readonly revision?: string;
  /** Which keeping this is: a window gives up only a draft it kept or restored itself. */
  readonly id: string;
}

let kept = 0;
const newDraftId = () => `${Math.random().toString(36).slice(2)}-${++kept}`;
/** Drafts this window kept or brought back: the only ones it may give up. */
const ownIds = new Set<string>();

const PREFIX = "specwithcode:document-draft:v1:";
const drafts = new Map<string, Draft>();
const revisions = new Map<string, string>();
/** Drafts only this page holds, which a closing window would lose. */
const memoryOnly = new Set<string>();

function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

const storageKey = (key: string) => PREFIX + encodeURIComponent(key);

function stored(key: string): Draft | undefined {
  try {
    const raw = storage()?.getItem(storageKey(key));
    if (raw == null) return undefined;
    const value = JSON.parse(raw) as Partial<Draft> | null;
    if (value === null || typeof value !== "object" || typeof value.content !== "object") return undefined;
    return {
      content: value.content as JSONContent,
      ...(typeof value.revision === "string" ? { revision: value.revision } : {}),
      id: typeof value.id === "string" ? value.id : "",
    };
  } catch {
    return undefined;
  }
}

function persist(key: string, draft: Draft): void {
  try {
    const target = storage();
    if (target === null) throw new Error("no storage");
    target.setItem(storageKey(key), JSON.stringify(draft));
    memoryOnly.delete(key);
  } catch {
    memoryOnly.add(key);
  }
}

function draftOf(key: string): Draft | undefined {
  const held = drafts.get(key);
  if (held !== undefined) return held;
  const found = stored(key);
  if (found !== undefined) drafts.set(key, found);
  return found;
}

export function hasUnsavedDraft(key: string): boolean {
  return draftOf(key) !== undefined;
}

export function unsavedDraft(key: string): JSONContent | undefined {
  return draftOf(key)?.content;
}

/** The draft kept under the key, which this window now holds as its own. */
export function restoreUnsavedDraft(key: string): JSONContent | undefined {
  const draft = draftOf(key);
  if (draft !== undefined) ownIds.add(draft.id);
  return draft?.content;
}

export function unsavedDraftRevision(key: string): string | undefined {
  return draftOf(key)?.revision;
}

/** Keeps edits under the key, replacing any draft there; returns this draft's id. */
export function keepUnsavedDraft(key: string, content: JSONContent): string {
  const revision = revisions.get(key) ?? drafts.get(key)?.revision;
  const id = newDraftId();
  const draft: Draft = revision === undefined ? { content, id } : { content, revision, id };
  ownIds.add(id);
  drafts.set(key, draft);
  persist(key, draft);
  return id;
}

/**
 * Records the revision the open file has now; a draft kept from here on is
 * marked with it. A draft already kept keeps the revision it was made on.
 */
export function noteDraftRevision(key: string, revision: string): void {
  revisions.set(key, revision);
}

/**
 * Gives up the draft under the key if this window kept or brought it back (or
 * only the one with `id`). A draft another window kept since, even with the same
 * text, stays.
 */
export function dropUnsavedDraft(key: string, id?: string): void {
  const mine = (candidate: unknown): candidate is string =>
    typeof candidate === "string" && ownIds.has(candidate) && (id === undefined || candidate === id);
  const held = drafts.get(key);
  if (held !== undefined && mine(held.id)) {
    drafts.delete(key);
    memoryOnly.delete(key);
  }
  try {
    const raw = storage()?.getItem(storageKey(key));
    if (raw != null && mine((JSON.parse(raw) as { id?: unknown } | null)?.id)) {
      storage()?.removeItem(storageKey(key));
    }
  } catch {
    // Storage off or unreadable: only this window's copy is given up.
  }
}

/** Whether a draft would be lost if this window closed now. */
export function hasDraftOnlyInMemory(): boolean {
  return memoryOnly.size > 0;
}

if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
  window.addEventListener("beforeunload", (event) => {
    if (memoryOnly.size > 0) event.preventDefault();
  });
}
