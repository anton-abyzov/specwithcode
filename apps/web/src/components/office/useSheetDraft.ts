import {
  type SheetDocument,
  parseSheetDocument,
  serializeSheetDocument,
  sheetContentRevision,
  validateSheetDocument,
} from "@specweave-studio/shared/officeSheet";
import { useEffect, useMemo, useRef, useState } from "react";

import { useTx } from "../../i18n";

/** An edit shown before the file on disk carries it. */
export interface SheetDraft {
  /** The revision of the file the draft was made over, or the one a forced save replaced. */
  readonly seenRevision: string;
  /** The revision the next write is checked against. */
  readonly baseRevision: string;
  /** The revision the file has once the newest edit is written. */
  readonly savedRevision: string;
  readonly document: SheetDocument;
  /**
   * Revisions this view sent; one of them landing is not a conflict. The list
   * lasts as long as the draft, so it holds one entry per edit made while a
   * write was out.
   */
  readonly own: ReadonlyArray<string>;
  /** The newest write that went through, kept until the file shows it. */
  readonly committed?: { readonly document: SheetDocument; readonly revision: string };
}

export type SheetSaveHandler = (
  contents: string,
  expectedRevision?: string,
) => Promise<boolean | "conflict">;

/**
 * The sheet on screen: the file, or an edit over it that is on its way to disk.
 * Saves run one at a time, each checked against the revision the one ahead of
 * it wrote; a change on disk from elsewhere shows as a conflict, never as a
 * silent overwrite.
 */
export function useSheetDraft(props: {
  readonly text: string;
  readonly onSave?: SheetSaveHandler | undefined;
  readonly onReload?: (() => void | Promise<void>) | undefined;
  /** Message shown when a write fails. */
  readonly failureMessage?: string | undefined;
}) {
  const tx = useTx();
  const parsed = useMemo(() => parseSheetDocument(props.text), [props.text]);
  const incomingRevision = useMemo(() => sheetContentRevision(props.text), [props.text]);
  const [draft, setDraft] = useState<SheetDraft>();
  const [serverConflict, setServerConflict] = useState(false);
  // Saves run one at a time. `base` is the revision the next write is checked
  // against, and `blocked` drops the queued writes behind one that failed.
  const saveQueue = useRef({
    tail: Promise.resolve(true),
    pending: 0,
    base: "",
    blocked: false,
  });
  // The file on disk differs from everything this view has seen or written.
  const textConflict =
    draft !== undefined &&
    incomingRevision !== draft.seenRevision &&
    incomingRevision !== draft.baseRevision &&
    incomingRevision !== draft.savedRevision &&
    !draft.own.includes(incomingRevision);
  const hasExternalConflict = draft !== undefined && (serverConflict || textConflict);
  const document = parsed.ok ? (draft !== undefined ? draft.document : parsed.document) : null;
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  // The newest edit was written, is the file on disk, and nothing is still on
  // its way: the draft has done its job. A newest edit that was refused stays,
  // also when it happens to read like the file.
  const isOwnSaveLanding =
    draft !== undefined &&
    incomingRevision === draft.savedRevision &&
    draft.baseRevision === draft.savedRevision &&
    !serverConflict &&
    !saving;

  // Without a way to save, a draft is only a view of the file: it follows the file.
  const viewOnlyDraftIsStale = props.onSave === undefined && textConflict;
  useEffect(() => {
    if (isOwnSaveLanding || viewOnlyDraftIsStale) {
      setDraft(undefined);
      setServerConflict(false);
    }
  }, [isOwnSaveLanding, viewOnlyDraftIsStale]);

  const save = (next: SheetDocument, options?: { readonly force?: boolean }): Promise<boolean> => {
    const onSave = props.onSave;
    if (!onSave) return Promise.resolve(false);
    // Block ordinary layout/chart saves while an unresolved external conflict is active
    // so a stale draft can never be saved against a newer incoming revision.
    if (hasExternalConflict && !options?.force) {
      setSaveError(tx("Resolve the conflict before saving more changes."));
      return Promise.resolve(false);
    }
    const checked = validateSheetDocument(next);
    if (!checked.ok) {
      setSaveError(checked.error);
      return Promise.resolve(false);
    }
    const serialized = serializeSheetDocument(checked.document);
    const nextSavedRevision = sheetContentRevision(serialized);
    const queue = saveQueue.current;
    const idle = queue.pending === 0;
    if (idle) {
      queue.base = draft?.baseRevision ?? incomingRevision;
      queue.blocked = false;
    }
    if (options?.force) {
      // "Keep my edits" never joins a queue, and never sends an unfenced
      // overwrite: it waits until a newer revision has arrived in props.text.
      if (!idle) return Promise.resolve(false);
      if (incomingRevision === queue.base) {
        setSaveError(tx("Waiting for the latest revision before overwriting."));
        void props.onReload?.();
        return Promise.resolve(false);
      }
    }
    const force = options?.force === true;
    const baseRevision = queue.base;
    queue.pending += 1;
    setSaving(true);
    setSaveError(null);
    const overwritten = incomingRevision;
    // The edit shows at once, also while an earlier save is still on its way.
    // What the draft has seen only moves once a write has gone through.
    setDraft((current) => ({
      ...current,
      seenRevision: current?.seenRevision ?? incomingRevision,
      baseRevision: current?.baseRevision ?? baseRevision,
      savedRevision: nextSavedRevision,
      document: checked.document,
      own: [...(current?.own ?? []), nextSavedRevision],
    }));
    const run = async (): Promise<boolean> => {
      try {
        // A write ahead of this one failed, so this one would be checked against the wrong revision.
        if (queue.blocked) return false;
        let outcome: Awaited<ReturnType<typeof onSave>>;
        try {
          outcome = await onSave(serialized, force ? overwritten : queue.base);
        } catch {
          outcome = false;
        }
        if (outcome === "conflict") {
          queue.blocked = true;
          setServerConflict(true);
          void props.onReload?.();
          return false;
        }
        if (!outcome) {
          // A forced save that fails keeps the edits and the conflict banner, so
          // the person can try again or reload. An ordinary one with a newer
          // write queued behind it changes nothing: that write carries the same
          // edit and is checked against the same revision. The last one falls
          // back to what did reach the disk.
          if (!force && queue.pending === 1) {
            setDraft((current) =>
              current?.committed
                ? {
                    ...current,
                    document: current.committed.document,
                    savedRevision: current.committed.revision,
                  }
                : undefined,
            );
          }
          setSaveError(props.failureMessage ?? tx("The chart could not be saved."));
          return false;
        }
        queue.base = nextSavedRevision;
        // Keep a newer queued edit on screen; only what it builds on moves forward.
        setDraft((current) =>
          current
            ? {
                ...current,
                baseRevision: nextSavedRevision,
                committed: { document: checked.document, revision: nextSavedRevision },
                ...(force ? { seenRevision: overwritten } : {}),
              }
            : current,
        );
        setServerConflict(false);
        setSaveError(null);
        return true;
      } finally {
        queue.pending -= 1;
        if (queue.pending === 0) setSaving(false);
      }
    };
    // The first save starts in the same turn; later ones wait for the one ahead.
    const result = idle ? run() : queue.tail.then(run, run);
    queue.tail = result;
    return result;
  };

  /** A view-only change (no way to save): shown, never written. */
  const showOnly = (next: SheetDocument): void => {
    setDraft({
      seenRevision: draft?.seenRevision ?? incomingRevision,
      baseRevision: draft?.baseRevision ?? incomingRevision,
      savedRevision: sheetContentRevision(serializeSheetDocument(next)),
      document: next,
      own: [],
    });
  };

  const discard = (): void => {
    setDraft(undefined);
    setServerConflict(false);
    setSaveError(null);
  };

  return {
    parsed,
    document,
    draft,
    incomingRevision,
    hasExternalConflict,
    saving,
    saveError,
    setSaveError,
    save,
    showOnly,
    discard,
  };
}
