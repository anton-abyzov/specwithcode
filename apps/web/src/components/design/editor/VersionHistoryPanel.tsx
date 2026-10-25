/**
 * Version history: named versions and recent autosaves, newest first, with
 * "Save version" (named) and "Restore". Restore asks first, because it
 * replaces what the canvas shows; the replaced content stays in the history.
 */
import type { DesignHistoryEntry } from "@specweave-studio/contracts";
import { BookmarkIcon, XIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../../ui/alert-dialog";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import { Spinner } from "../../ui/spinner";
import type { DesignVersions } from "./backend";

/** Autosaves shown under the named versions; the server keeps the last 100. */
export const AUTOSAVES_SHOWN = 30;

export interface HistoryRow {
  readonly key: string;
  readonly revision: number;
  readonly kind: "version" | "revision";
  readonly title: string;
  readonly when: string;
  readonly by: string;
  /** The design as it is now: nothing to restore. */
  readonly current: boolean;
}

const when = (iso: string) => {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "";
  const day = at.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
  const time = at.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  return `${day} at ${time}`;
};

const actorLabel = (actor: DesignHistoryEntry["actor"]) =>
  actor.kind === "agent" ? "an agent" : "you";

/**
 * Named versions and autosaves, newest first. An autosave is listed once
 * even when a version names the same revision.
 */
export function historyRows(
  entries: readonly DesignHistoryEntry[],
  currentRevision: number,
): readonly HistoryRow[] {
  const named = new Set(
    entries.filter((entry) => entry.kind === "version").map((entry) => entry.revision),
  );
  const sorted = [...entries].sort(
    (left, right) =>
      right.revision - left.revision ||
      (left.kind === right.kind ? 0 : left.kind === "version" ? -1 : 1) ||
      right.savedAt.localeCompare(left.savedAt),
  );
  let autosaves = 0;
  const rows: HistoryRow[] = [];
  for (const entry of sorted) {
    if (entry.kind === "revision") {
      if (named.has(entry.revision)) continue;
      autosaves += 1;
      if (autosaves > AUTOSAVES_SHOWN) continue;
    }
    rows.push({
      key: `${entry.kind}:${entry.revision}:${entry.name ?? ""}`,
      revision: entry.revision,
      kind: entry.kind,
      title: entry.kind === "version" ? (entry.name ?? "Named version") : "Autosave",
      when: when(entry.savedAt),
      by: actorLabel(entry.actor),
      current: entry.revision === currentRevision,
    });
  }
  return rows;
}

const failure = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

export function VersionHistoryPanel({
  versions,
  revision,
  readOnly,
  onRestore,
  onClose,
}: {
  versions: DesignVersions;
  /** The open document's revision; the list reloads when it changes. */
  revision: number;
  readOnly: boolean;
  /** Saves pending edits, then restores `revision` over the current design. */
  onRestore: (revision: number) => Promise<void>;
  onClose: () => void;
}) {
  const [entries, setEntries] = useState<readonly DesignHistoryEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [restoring, setRestoring] = useState<HistoryRow | null>(null);

  const load = useCallback(() => {
    versions.list().then(
      (next) => {
        setEntries(next);
        setError(null);
      },
      (cause: unknown) => setError(failure(cause)),
    );
  }, [versions]);
  useEffect(load, [load, revision]);

  const save = async () => {
    const trimmed = name.trim();
    if (trimmed === "") return;
    setBusy(true);
    try {
      setEntries(await versions.save(trimmed));
      setNaming(false);
      setName("");
      setError(null);
    } catch (cause) {
      setError(failure(cause));
    } finally {
      setBusy(false);
    }
  };

  const restore = async (row: HistoryRow) => {
    setBusy(true);
    try {
      await onRestore(row.revision);
      setRestoring(null);
      setError(null);
      load();
    } catch (cause) {
      setError(failure(cause));
      setRestoring(null);
    } finally {
      setBusy(false);
    }
  };

  const rows = entries === null ? null : historyRows(entries, revision);
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="design-version-history">
      <div className="flex h-10 shrink-0 items-center justify-between gap-2 border-b border-border/70 px-3">
        <h2 className="text-sm font-medium">Version history</h2>
        <Button variant="ghost" size="icon-xs" aria-label="Close version history" onClick={onClose}>
          <XIcon />
        </Button>
      </div>
      {!readOnly ? (
        <div className="flex flex-col gap-2 border-b border-border/70 px-3 py-2">
          {naming ? (
            <form
              className="flex flex-col gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                void save();
              }}
            >
              <Input
                autoFocus
                size="sm"
                aria-label="Version name"
                placeholder="Name this version"
                maxLength={180}
                value={name}
                onChange={(event) => setName(event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key === "Escape") setNaming(false);
                }}
              />
              <div className="flex justify-end gap-1.5">
                <Button
                  type="button"
                  size="xs"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => setNaming(false)}
                >
                  Cancel
                </Button>
                <Button type="submit" size="xs" disabled={busy || name.trim() === ""}>
                  Save version
                </Button>
              </div>
            </form>
          ) : (
            <Button size="xs" variant="outline" onClick={() => setNaming(true)}>
              <BookmarkIcon />
              Save version
            </Button>
          )}
        </div>
      ) : null}
      {error !== null ? (
        <p role="alert" className="px-3 py-2 text-destructive-foreground text-xs">
          {error}
        </p>
      ) : null}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {rows === null ? (
          error === null ? (
            <div className="flex justify-center py-6" aria-busy="true">
              <Spinner />
            </div>
          ) : null
        ) : rows.length === 0 ? (
          <p className="px-3 py-4 text-muted-foreground text-xs">
            No saved versions yet. Autosaves appear here as you edit.
          </p>
        ) : (
          <ul className="flex flex-col py-1">
            {rows.map((row) => (
              <li
                key={row.key}
                className="group flex items-center gap-2 px-3 py-1.5"
                data-testid="design-version-row"
                data-kind={row.kind}
              >
                <div className="flex min-w-0 flex-1 flex-col">
                  <span
                    className={
                      row.kind === "version"
                        ? "truncate text-sm font-medium"
                        : "truncate text-sm text-muted-foreground"
                    }
                    title={row.title}
                  >
                    {row.title}
                  </span>
                  <span className="truncate text-muted-foreground text-xs">
                    {row.current ? "Current · " : ""}
                    {row.when}
                    {row.when === "" ? "" : ", "}
                    by {row.by}
                  </span>
                </div>
                {!readOnly && !row.current ? (
                  <Button
                    size="xs"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => setRestoring(row)}
                  >
                    Restore
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>
      <AlertDialog
        open={restoring !== null}
        onOpenChange={(open) => !busy && !open && setRestoring(null)}
      >
        <AlertDialogPopup data-testid="design-restore-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>
              Restore {restoring?.kind === "version" ? `“${restoring.title}”` : "this autosave"}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              The design is replaced by the version from {restoring?.when || "that time"}. What it
              shows now stays in Version history, so you can restore it again.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" disabled={busy} />}>
              Cancel
            </AlertDialogClose>
            <Button
              disabled={busy}
              onClick={() => restoring !== null && void restore(restoring)}
              data-testid="design-restore-confirm"
            >
              Restore
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </div>
  );
}
