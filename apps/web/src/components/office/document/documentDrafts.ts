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
}

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

export function unsavedDraftRevision(key: string): string | undefined {
  return draftOf(key)?.revision;
}

export function keepUnsavedDraft(key: string, content: JSONContent): void {
  const revision = revisions.get(key) ?? drafts.get(key)?.revision;
  const draft: Draft = revision === undefined ? { content } : { content, revision };
  drafts.set(key, draft);
  persist(key, draft);
}

/**
 * Records the revision the open file has now; a draft kept from here on is
 * marked with it. A draft already kept keeps the revision it was made on.
 */
export function noteDraftRevision(key: string, revision: string): void {
  revisions.set(key, revision);
}

/** Gives a draft up, only when it is still the one passed (if one is passed). */
export function dropUnsavedDraft(key: string, content?: JSONContent): void {
  if (content !== undefined && drafts.get(key)?.content !== content) return;
  drafts.delete(key);
  memoryOnly.delete(key);
  try {
    storage()?.removeItem(storageKey(key));
  } catch {
    // Storage off: nothing was kept there.
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
