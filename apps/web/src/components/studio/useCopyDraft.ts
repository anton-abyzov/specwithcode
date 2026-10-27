import { useEffect, useState, type RefObject } from "react";
import type { EnvironmentId, FolderCopyMode } from "@specweave-studio/contracts";
import {
  archivePendingCopy,
  folderCopyDraftKey,
  folderCopyLastKey,
  folderCopyStorageKey,
  readCopyDraft,
  readLastCopy,
  readoptLastCopy,
  readPendingCopy,
  writeCopyDraft,
  type CopyDraft,
  type LastCopy,
  type PendingCopy,
} from "./handoffFolderCopyPending";
import type { CopyMachine } from "./HandoffCopySetup";

/** The setup form as the component holds it; a typed folder belongs to one machine. */
interface CopyForm {
  readonly machine: EnvironmentId | null;
  readonly folderDraft: {
    readonly machine: EnvironmentId;
    readonly value: string;
    readonly copyRoot?: string;
  } | null;
  readonly mode: FolderCopyMode;
  readonly chooseFirst: boolean;
}

/**
 * What the folder copy keeps outside a running copy: the setup form while no copy has
 * started, and the last finished copy-only copy, so a reopen starts a new copy while View
 * and Undo stay one click away. On mount it opens the pointer, or fills the form.
 */
export function useCopyDraft({
  project,
  machines,
  canMove,
  form,
  latestPending,
  setForm,
  onResume,
}: {
  readonly project: { readonly environmentId: string; readonly id: string };
  readonly machines: ReadonlyArray<CopyMachine>;
  readonly canMove: boolean;
  readonly form: CopyForm;
  readonly latestPending: RefObject<PendingCopy | null>;
  readonly setForm: {
    readonly machine: (id: EnvironmentId) => void;
    readonly folder: (value: string, environmentId: EnvironmentId, copyRoot?: string) => void;
    readonly mode: (mode: FolderCopyMode) => void;
    readonly chooseFirst: (chooseFirst: boolean) => void;
  };
  readonly onResume: (saved: PendingCopy) => void;
}) {
  const pendingKey = folderCopyStorageKey(project.environmentId, project.id);
  const lastKey = folderCopyLastKey(project.environmentId, project.id);
  const draftKey = folderCopyDraftKey(project.environmentId, project.id);
  const [lastCopy, setLastCopy] = useState<LastCopy | null>(null);

  /** Puts a draft, or the last copy's choices, back in the setup form. */
  const fill = (draft: CopyDraft) => {
    const known = machines.find((entry) => entry.id === draft.machine && !entry.unavailable);
    if (known) {
      setForm.machine(known.id);
      if (draft.folder) setForm.folder(draft.folder, known.id, draft.copyRoot);
    }
    if (draft.mode === "copy-only" || canMove) setForm.mode(draft.mode);
    setForm.chooseFirst(draft.chooseFirst);
  };

  useEffect(() => {
    const saved = readPendingCopy(pendingKey);
    // A finished copy whose Done was seen becomes the last copy; the dialog starts a new one.
    const archived =
      saved?.doneSeen === true &&
      archivePendingCopy({
        pendingKey,
        lastKey,
        pointer: saved,
        finishedAt: new Date().toISOString(),
      }) !== null;
    if (saved && !archived) {
      onResume(saved);
      return;
    }
    const last = readLastCopy(lastKey);
    setLastCopy(last);
    const draft =
      readCopyDraft(draftKey) ??
      (last && {
        machine: last.environmentId,
        folder: last.targetFolder,
        ...(last.copyRoot ? { copyRoot: last.copyRoot } : {}),
        mode: last.mode,
        chooseFirst: last.auto !== true,
      });
    if (draft) fill(draft);
  }, [pendingKey]);

  /** Remembers the setup form while no copy has started, so closing on Where loses nothing. */
  const keepDraft = (change: {
    readonly machine?: EnvironmentId;
    readonly folder?: string;
    readonly mode?: FolderCopyMode;
    readonly chooseFirst?: boolean;
  }) => {
    if (latestPending.current) return;
    const { machine, folderDraft } = form;
    // A folder only counts once typed; a new machine starts from its own suggestion.
    const kept = !change.machine && folderDraft?.machine === machine ? folderDraft : null;
    const copyRoot = change.folder === undefined ? kept?.copyRoot : undefined;
    writeCopyDraft(draftKey, {
      machine: change.machine ?? machine,
      folder: change.folder ?? kept?.value ?? "",
      ...(copyRoot ? { copyRoot } : {}),
      mode: change.mode ?? form.mode,
      chooseFirst: change.chooseFirst ?? form.chooseFirst,
    });
  };

  return {
    lastCopy: lastCopy && {
      targetFolder: lastCopy.targetFolder,
      label:
        machines.find((entry) => entry.id === lastCopy.environmentId)?.label ?? "the other machine",
    },
    keepDraft,
    /** Keeps a cancelled copy's choices as the draft, so closing on Where loses nothing. */
    keepDraftOf: (saved: PendingCopy) =>
      writeCopyDraft(draftKey, {
        machine: saved.environmentId,
        folder: saved.targetFolder,
        ...(saved.copyRoot ? { copyRoot: saved.copyRoot } : {}),
        mode: saved.mode,
        chooseFirst: saved.auto !== true,
      }),
    /** A copy started: its pointer holds the choices from here. */
    dropDraft: () => writeCopyDraft(draftKey, null),
    /** Makes the last copy the open one again, landing on its Done with Undo. */
    viewLastCopy: () => {
      const saved = readoptLastCopy({ pendingKey, lastKey });
      setLastCopy(null);
      if (saved) onResume(saved);
    },
    /** Keeps a finished copy-only copy as the last copy before a new copy clears it. */
    archive: (pointer: PendingCopy) =>
      setLastCopy(
        archivePendingCopy({ pendingKey, lastKey, pointer, finishedAt: new Date().toISOString() }),
      ),
  };
}
