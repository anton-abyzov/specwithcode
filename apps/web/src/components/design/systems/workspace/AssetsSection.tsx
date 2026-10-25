import type { DesignOwnerInput, DesignSystemId, EnvironmentId } from "@specweave-studio/contracts";
import { ImagePlusIcon, PlusIcon, RefreshCwIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { cn } from "~/lib/utils";

import { Button } from "../../../ui/button";
import { AssetSetCard, hasFiles, type AssetRowActions } from "./AssetSetCard";
import { assetSets, OTHER_SET, setFolder, storageLine, type AssetEntry } from "./assetsModel";
import { ConfirmDeleteDialog, RenameDialog } from "./fileDialogs";
import { browserFile, fileName, folderOf, formatSize } from "./filesModel";
import { NewSetDialog } from "./NewSetDialog";
import { fileNameProblem, planUploads, uniquePath, type StorageRoom } from "./storedPaths";
import {
  downloadBlob,
  downloadType,
  readBytes,
  uploadAll,
  uploadFailureText,
  useSystemFilesApi,
  type SystemFilesApi,
} from "./systemFilesApi";

export interface AssetsSectionProps {
  readonly environmentId: EnvironmentId;
  readonly owner: DesignOwnerInput;
  readonly systemId: DesignSystemId;
  readonly canEdit: boolean;
}

/** Asset sets (folders under `assets/`) with upload and download. */
export function AssetsSection(props: AssetsSectionProps) {
  const api = useSystemFilesApi(props);
  return <AssetsSectionView canEdit={props.canEdit} api={api} />;
}

export const REMOVE_ASSETS_TEXT =
  "The files are deleted from assets/. Anything linking to them will break.";

type AssetDialog =
  | { readonly kind: "new-set" }
  | { readonly kind: "rename"; readonly entry: AssetEntry }
  | {
      readonly kind: "remove";
      readonly title: string;
      readonly paths: readonly string[];
    };

export function AssetsSectionView({ canEdit, api }: { canEdit: boolean; api: SystemFilesApi }) {
  const listing = api.listing;
  const files = useMemo(() => (listing.data?.files ?? []).map(browserFile), [listing.data]);
  const stored = useMemo(() => files.filter((file) => file.origin === "stored"), [files]);
  const taken = useMemo(() => new Set(stored.map((file) => file.path)), [stored]);
  const sets = useMemo(() => assetSets(files), [files]);
  const setNames = sets.map((set) => set.name);
  const [progress, setProgress] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [dialog, setDialog] = useState<AssetDialog | null>(null);
  const [dropping, setDropping] = useState(false);
  const busy = progress !== null;

  const room: StorageRoom | null =
    listing.data === null
      ? null
      : {
          usedBytes: listing.data.usedBytes,
          limitBytes: listing.data.limitBytes,
          fileCount: stored.length,
          limitFiles: listing.data.limitFiles,
        };

  /** Resolves to an error message, or null when every file was stored. */
  const upload = async (picked: File[], setName: string): Promise<string | null> => {
    const plan = planUploads(picked, () => setFolder(setName), taken, room);
    if (!plan.ok) return plan.message;
    setProblem(null);
    const report = await uploadAll(api, plan.uploads, (done, total) =>
      setProgress(
        total === 1
          ? `Uploading ${fileName(plan.uploads[0]!.path)}…`
          : `Uploading ${Math.min(done + 1, total)} of ${total}…`,
      ),
    );
    setProgress(null);
    if (report.saved.length > 0) listing.refresh();
    return uploadFailureText(report);
  };
  const uploadHere = (picked: File[], setName: string) =>
    void upload(picked, setName).then(setProblem);

  const actions: AssetRowActions = {
    onDownload: (entry) => {
      void api.read({ origin: "stored", path: entry.file.path }).then((outcome) => {
        if (!outcome.ok) return setProblem(outcome.message);
        downloadBlob(
          new Blob([readBytes(outcome.value)], { type: downloadType(entry.file.mimeType) }),
          fileName(entry.file.path),
        );
      });
    },
    onRename: (entry) => setDialog({ kind: "rename", entry }),
    onMove: (entry, toSet) => {
      const target = uniquePath(`${setFolder(toSet)}/${fileName(entry.file.path)}`, taken);
      setProgress(`Moving ${fileName(entry.file.path)} to ${toSet}…`);
      void api.move(entry.file.path, target).then((outcome) => {
        setProgress(null);
        setProblem(outcome.ok ? null : outcome.message);
        if (outcome.ok) listing.refresh();
      });
    },
    onRemove: (entry) =>
      setDialog({
        kind: "remove",
        title: `Remove ${entry.name}?`,
        paths: [entry.file.path],
      }),
  };

  const removeAll = async (paths: readonly string[]): Promise<string | null> => {
    let failure: string | null = null;
    let removed = 0;
    for (const path of paths) {
      const outcome = await api.remove(path);
      if (outcome.ok) removed += 1;
      else failure ??= outcome.message;
    }
    if (removed > 0) listing.refresh();
    return failure;
  };

  let body;
  if (listing.data === null && listing.error === null)
    body = <p className="text-sm text-muted-foreground">Loading assets…</p>;
  else if (listing.data === null)
    body = (
      <div className="flex flex-col items-start gap-2">
        <p className="text-sm text-muted-foreground" role="alert">
          Couldn't list the assets.
        </p>
        <Button variant="outline" size="sm" onClick={listing.refresh}>
          <RefreshCwIcon aria-hidden />
          Try again
        </Button>
      </div>
    );
  else if (sets.length === 0)
    body = (
      <div
        className={cn(
          "flex flex-col items-center gap-2 rounded-lg border border-dashed border-border px-4 py-8 text-center",
          dropping && "border-ring bg-accent/40",
        )}
        data-testid="assets-empty"
        onDragOver={(event) => {
          if (!canEdit || busy || !hasFiles(event)) return;
          event.preventDefault();
          setDropping(true);
        }}
        onDragLeave={() => setDropping(false)}
        onDrop={(event) => {
          if (!canEdit || busy) return;
          event.preventDefault();
          setDropping(false);
          uploadHere([...event.dataTransfer.files], OTHER_SET);
        }}
      >
        <ImagePlusIcon aria-hidden className="size-5 text-muted-foreground" />
        <p className="text-sm text-foreground">No files yet.</p>
        <p className="max-w-sm text-xs text-muted-foreground">
          {canEdit
            ? "Start a set for logos, icons or photos with New set, or drop files here."
            : "Logos, icons and images added to this design system show here."}
        </p>
      </div>
    );
  else
    body = sets.map((set) => (
      <AssetSetCard
        key={set.folder}
        set={set}
        allSets={setNames}
        canEdit={canEdit}
        busy={busy}
        read={api.read}
        actions={actions}
        onUpload={(picked) => uploadHere(picked, set.name)}
        onDeleteSet={() =>
          setDialog({
            kind: "remove",
            title: `Delete the ${set.name} set?`,
            paths: set.files.map((entry) => entry.file.path),
          })
        }
      />
    ));

  return (
    <div className="flex min-w-0 flex-col gap-3" data-testid="assets-section">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          Logos, icons and images, one folder per set in assets/.
        </p>
        {canEdit ? (
          <Button
            variant="outline"
            size="sm"
            disabled={busy || listing.data === null}
            onClick={() => setDialog({ kind: "new-set" })}
          >
            <PlusIcon aria-hidden />
            New set
          </Button>
        ) : null}
      </div>
      {progress ? (
        <p className="text-xs text-muted-foreground" role="status" data-testid="assets-progress">
          {progress}
        </p>
      ) : null}
      {problem ? (
        <p
          className="text-sm text-destructive-foreground"
          role="alert"
          data-testid="assets-problem"
        >
          {problem}
        </p>
      ) : null}
      {body}
      {listing.data !== null ? (
        <p className="text-xs text-muted-foreground tabular-nums" data-testid="assets-storage">
          {storageLine(
            stored.length,
            formatSize(listing.data.usedBytes),
            formatSize(listing.data.limitBytes),
          )}
        </p>
      ) : null}
      {dialog?.kind === "new-set" ? (
        <NewSetDialog
          existing={setNames.filter((name) => name !== OTHER_SET)}
          onCreate={(name, picked) => upload(picked, name)}
          onClose={() => setDialog(null)}
        />
      ) : dialog?.kind === "rename" ? (
        <RenameDialog
          title={`Rename ${dialog.entry.name}`}
          label="File name"
          initial={fileName(dialog.entry.file.path)}
          description="Designs and pages that link to the old name stop finding it."
          problem={(value) => {
            const invalid = fileNameProblem(value);
            if (invalid !== null) return invalid;
            return taken.has(`${folderOf(dialog.entry.file.path)}/${value}`)
              ? `There is already a file named ${value} in this set.`
              : null;
          }}
          onRename={async (value) => {
            const outcome = await api.move(
              dialog.entry.file.path,
              `${folderOf(dialog.entry.file.path)}/${value}`,
            );
            if (!outcome.ok) return outcome.message;
            listing.refresh();
            return null;
          }}
          onClose={() => setDialog(null)}
        />
      ) : dialog?.kind === "remove" ? (
        <ConfirmDeleteDialog
          title={dialog.title}
          description={REMOVE_ASSETS_TEXT}
          confirmLabel="Remove"
          onConfirm={() => removeAll(dialog.paths)}
          onClose={() => setDialog(null)}
        />
      ) : null}
    </div>
  );
}
