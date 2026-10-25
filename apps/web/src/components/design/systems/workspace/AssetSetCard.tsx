/**
 * One asset set as a table: Name, a preview thumbnail, Type, and a row
 * menu. Dropping files on the card uploads them into the set. Images are
 * read once per row and shown through `<img>` from a blob URL.
 */
import {
  ArrowRightLeftIcon,
  DownloadIcon,
  EllipsisIcon,
  FileIcon,
  PencilIcon,
  Trash2Icon,
  TypeIcon,
  UploadIcon,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type DragEvent, type ReactNode } from "react";

import { cn } from "~/lib/utils";

import { Button } from "../../../ui/button";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "../../../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../../ui/tooltip";
import type { AssetEntry, AssetSet } from "./assetsModel";
import { extensionOf, typeLabel, type BrowserFile } from "./filesModel";
import { imageMimeType } from "./previewPlan";
import { ACCEPT_ATTRIBUTE, FONT_EXTENSIONS } from "./storedPaths";
import { readBytes, type SystemFilesApi } from "./systemFilesApi";

/** Rows a set shows before "Show all N files". */
export const SET_PREVIEW_ROWS = 8;
/** Larger images keep an icon instead of a thumbnail, so a set never reads megabytes to draw. */
const THUMBNAIL_MAX_BYTES = 2 * 1024 * 1024;

export const hasFiles = (event: DragEvent) => [...event.dataTransfer.types].includes("Files");

function AssetThumb({ file, read }: { file: BrowserFile; read: SystemFilesApi["read"] }) {
  const mimeType = imageMimeType(file.path);
  const wanted = mimeType !== null && file.bytes <= THUMBNAIL_MAX_BYTES;
  const [url, setUrl] = useState<string | null>(null);
  const path = file.path;
  const updatedAt = file.updatedAt ?? "";
  const bytes = file.bytes;
  // A new read when the file changes on disk.
  const request = useMemo(
    () => (wanted && mimeType !== null ? { path, mimeType, updatedAt, bytes } : null),
    [bytes, mimeType, path, updatedAt, wanted],
  );
  useEffect(() => {
    if (request === null) return;
    const { path, mimeType } = request;
    let live = true;
    let created: string | null = null;
    void read({ origin: "stored", path }).then((outcome) => {
      if (!live || !outcome.ok) return;
      created = URL.createObjectURL(new Blob([readBytes(outcome.value)], { type: mimeType }));
      setUrl(created);
    });
    return () => {
      live = false;
      if (created !== null) URL.revokeObjectURL(created);
    };
  }, [read, request]);
  const Icon = FONT_EXTENSIONS.has(extensionOf(file.path)) ? TypeIcon : FileIcon;
  return (
    <span className="flex size-10 items-center justify-center overflow-hidden rounded-md border border-border/60 bg-muted/40">
      {url !== null ? (
        <img src={url} alt="" className="max-h-full max-w-full object-contain" />
      ) : (
        <Icon aria-hidden className="size-4 text-muted-foreground" />
      )}
    </span>
  );
}

export interface AssetRowActions {
  readonly onDownload: (entry: AssetEntry) => void;
  readonly onRename: (entry: AssetEntry) => void;
  readonly onMove: (entry: AssetEntry, toSet: string) => void;
  readonly onRemove: (entry: AssetEntry) => void;
}

function RowMenu({
  entry,
  setName,
  otherSets,
  canEdit,
  actions,
}: {
  entry: AssetEntry;
  setName: string;
  otherSets: readonly string[];
  canEdit: boolean;
  actions: AssetRowActions;
}) {
  return (
    <Menu>
      <MenuTrigger
        render={
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={`Actions for ${entry.name}`}
            data-testid="asset-row-menu"
          />
        }
      >
        <EllipsisIcon aria-hidden />
      </MenuTrigger>
      <MenuPopup align="end" className="min-w-44">
        <MenuItem onClick={() => actions.onDownload(entry)}>
          <DownloadIcon aria-hidden />
          Download
        </MenuItem>
        {canEdit ? (
          <>
            <MenuItem onClick={() => actions.onRename(entry)}>
              <PencilIcon aria-hidden />
              Rename…
            </MenuItem>
            {otherSets.length > 0 ? (
              <MenuSub>
                <MenuSubTrigger>
                  <ArrowRightLeftIcon aria-hidden />
                  Move to
                </MenuSubTrigger>
                <MenuSubPopup>
                  {otherSets.map((set) => (
                    <MenuItem key={set} onClick={() => actions.onMove(entry, set)}>
                      {set}
                    </MenuItem>
                  ))}
                </MenuSubPopup>
              </MenuSub>
            ) : null}
            <MenuSeparator />
            <MenuItem variant="destructive" onClick={() => actions.onRemove(entry)}>
              <Trash2Icon aria-hidden />
              Remove from {setName}
            </MenuItem>
          </>
        ) : null}
      </MenuPopup>
    </Menu>
  );
}

function IconAction({
  label,
  tooltip,
  onClick,
  destructive,
  children,
}: {
  label: string;
  tooltip: string;
  onClick: () => void;
  destructive?: boolean;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant={destructive ? "ghost-destructive" : "ghost"}
            size="icon-xs"
            aria-label={label}
            onClick={onClick}
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipPopup>{tooltip}</TooltipPopup>
    </Tooltip>
  );
}

export function AssetSetCard({
  set,
  allSets,
  canEdit,
  busy,
  read,
  actions,
  onUpload,
  onDeleteSet,
}: {
  set: AssetSet;
  allSets: readonly string[];
  canEdit: boolean;
  busy: boolean;
  read: SystemFilesApi["read"];
  actions: AssetRowActions;
  onUpload: (files: File[]) => void;
  onDeleteSet: () => void;
}) {
  const [showAll, setShowAll] = useState(false);
  const [dropping, setDropping] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const rows = showAll ? set.files : set.files.slice(0, SET_PREVIEW_ROWS);
  const otherSets = allSets.filter((name) => name !== set.name);
  const count = set.files.length;
  const droppable = canEdit && !busy;

  return (
    <section
      className={cn(
        "overflow-hidden rounded-lg border border-border/70 bg-card transition-shadow",
        dropping && "ring-2 ring-ring",
      )}
      data-testid="asset-set"
      data-set={set.name}
      aria-label={`${set.name} set`}
      onDragOver={(event) => {
        if (!droppable || !hasFiles(event)) return;
        event.preventDefault();
        event.stopPropagation();
        setDropping(true);
      }}
      onDragLeave={(event) => {
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
        setDropping(false);
      }}
      onDrop={(event) => {
        if (!droppable) return;
        event.preventDefault();
        event.stopPropagation();
        setDropping(false);
        const files = [...event.dataTransfer.files];
        if (files.length > 0) onUpload(files);
      }}
    >
      <header className="flex min-h-10 items-center gap-2 border-b border-border/60 bg-muted/30 px-3 py-1.5">
        <h3 className="min-w-0 truncate text-sm font-medium text-foreground">{set.name}</h3>
        <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
          {count} {count === 1 ? "file" : "files"}
        </span>
        {canEdit ? (
          <div className="ml-auto flex items-center gap-0.5">
            <IconAction
              label={`Upload file to ${set.name}`}
              tooltip="Upload file"
              onClick={() => input.current?.click()}
            >
              <UploadIcon aria-hidden />
            </IconAction>
            <IconAction
              label={`Delete the ${set.name} set`}
              tooltip="Delete set"
              destructive
              onClick={onDeleteSet}
            >
              <Trash2Icon aria-hidden />
            </IconAction>
            <input
              ref={input}
              type="file"
              multiple
              accept={ACCEPT_ATTRIBUTE}
              className="sr-only"
              tabIndex={-1}
              aria-hidden
              data-testid="asset-set-input"
              onChange={(event) => {
                const files = [...(event.target.files ?? [])];
                event.target.value = "";
                if (files.length > 0) onUpload(files);
              }}
            />
          </div>
        ) : null}
      </header>
      <table className="w-full table-fixed text-sm">
        <thead>
          <tr className="text-left text-xs text-muted-foreground">
            <th className="px-3 py-1.5 font-normal">Name</th>
            <th className="w-16 px-2 py-1.5 font-normal">Preview</th>
            <th className="hidden w-32 px-2 py-1.5 font-normal sm:table-cell">Type</th>
            <th className="w-10 px-2 py-1.5">
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border/50 border-t border-border/50">
          {rows.map((entry) => (
            <tr key={entry.file.path} data-testid="asset-row" data-path={entry.file.path}>
              <td className="px-3 py-1.5">
                <div className="truncate text-foreground">{entry.name}</div>
                <div className="truncate text-xs text-muted-foreground sm:hidden">
                  {typeLabel(entry.file.path, entry.file.bytes)}
                </div>
              </td>
              <td className="px-2 py-1.5">
                <AssetThumb file={entry.file} read={read} />
              </td>
              <td
                className="hidden truncate px-2 py-1.5 text-xs text-muted-foreground tabular-nums sm:table-cell"
                data-testid="asset-type"
              >
                {typeLabel(entry.file.path, entry.file.bytes)}
              </td>
              <td className="px-2 py-1.5 text-right">
                <RowMenu
                  entry={entry}
                  setName={set.name}
                  otherSets={otherSets}
                  canEdit={canEdit}
                  actions={actions}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {count > SET_PREVIEW_ROWS ? (
        <div className="border-t border-border/50 px-3 py-1.5">
          <Button variant="ghost" size="xs" onClick={() => setShowAll((value) => !value)}>
            {showAll ? "Show fewer" : `Show all ${count} files`}
          </Button>
        </div>
      ) : null}
    </section>
  );
}
