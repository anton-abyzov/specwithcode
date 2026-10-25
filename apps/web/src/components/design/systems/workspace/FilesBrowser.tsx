import type { DesignOwnerInput, DesignSystem, EnvironmentId } from "@specweave-studio/contracts";
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  BracesIcon,
  ChevronRightIcon,
  DownloadIcon,
  FileCode2Icon,
  FileIcon,
  FileTextIcon,
  FolderGit2Icon,
  FolderIcon,
  FolderOpenIcon,
  ImageIcon,
  PencilIcon,
  RefreshCwIcon,
  Trash2Icon,
  TypeIcon,
  XIcon,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { cn } from "~/lib/utils";

import { Button } from "../../../ui/button";
import { ConfirmDeleteDialog, RenameDialog } from "./fileDialogs";
import { FilePreviewBody, useFileContent } from "./FilePreview";
import {
  browserFile,
  extensionOf,
  fileCaption,
  fileGroup,
  fileKey,
  fileName,
  folderCaption,
  folderOf,
  formatSize,
  groupTopLevel,
  kindLabel,
  shownIn,
  whereLabel,
  type BrowserFile,
  type FileGroup,
  type FolderNode,
  type TreeNode,
} from "./filesModel";
import { generatedFiles } from "./generatedFiles";
import { previewPlan } from "./previewPlan";
import { fileNameProblem } from "./storedPaths";
import {
  downloadBlob,
  downloadType,
  readBytes,
  useSystemFilesApi,
  type SystemFilesApi,
} from "./systemFilesApi";

export interface FilesBrowserProps {
  readonly environmentId: EnvironmentId;
  readonly owner: DesignOwnerInput;
  readonly system: DesignSystem;
  /** The person may change stored files. */
  readonly canEdit: boolean;
  /** Closes Files and shows a section of the page (`colors`, `family-zIndex`…). */
  readonly onGoToSection: (sectionId: string) => void;
  readonly onClose: () => void;
}

/** The system's files over the page, with a preview of the one clicked. */
export function FilesBrowser(props: FilesBrowserProps) {
  const api = useSystemFilesApi({
    environmentId: props.environmentId,
    owner: props.owner,
    systemId: props.system.id,
  });
  return <FilesBrowserView {...props} api={api} />;
}

const GROUP_ICONS: Record<FileGroup, LucideIcon> = {
  Folders: FolderIcon,
  Pages: FileCode2Icon,
  Components: FileCode2Icon,
  Stylesheets: FileCode2Icon,
  Scripts: FileCode2Icon,
  Images: ImageIcon,
  Fonts: TypeIcon,
  Documents: FileTextIcon,
  Data: BracesIcon,
  Sources: FolderGit2Icon,
  Other: FileIcon,
};

/** The icon's group: a source shows the icon of its own type. */
const iconGroup = (file: BrowserFile): FileGroup =>
  fileGroup(file.origin === "source" ? { path: file.path, origin: "stored" } : file);

const ROW_CLASS =
  "group/row flex w-full min-w-0 items-center gap-2.5 rounded-md py-1.5 pr-2 text-left outline-none transition-colors hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring";

const indent = (depth: number) => ({ paddingLeft: `${0.5 + depth * 1.125}rem` });

function FileRow({
  node,
  depth,
  selected,
  onSelect,
}: {
  node: Extract<TreeNode, { kind: "file" }>;
  depth: number;
  selected: boolean;
  onSelect: () => void;
}) {
  const Icon = GROUP_ICONS[iconGroup(node.file)];
  return (
    <li>
      <button
        type="button"
        className={cn(ROW_CLASS, selected && "bg-accent hover:bg-accent")}
        style={indent(depth)}
        aria-current={selected ? "true" : undefined}
        data-testid="files-row"
        data-path={node.file.path}
        data-origin={node.file.origin}
        onClick={onSelect}
      >
        <Icon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        <span className="flex min-w-0 flex-1 flex-col">
          <span
            className={cn(
              "truncate text-sm text-foreground",
              node.file.origin === "source" && "font-mono text-xs",
            )}
          >
            {node.name}
          </span>
          <span className="truncate text-xs text-muted-foreground">{fileCaption(node.file)}</span>
        </span>
        <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
          {formatSize(node.file.bytes)}
        </span>
      </button>
    </li>
  );
}

function TreeRows({
  nodes,
  depth,
  expanded,
  selectedKey,
  onToggle,
  onSelect,
}: {
  nodes: readonly TreeNode[];
  depth: number;
  expanded: ReadonlySet<string>;
  selectedKey: string | null;
  onToggle: (folder: FolderNode) => void;
  onSelect: (file: BrowserFile) => void;
}) {
  return nodes.map((node) =>
    node.kind === "file" ? (
      <FileRow
        key={fileKey(node.file)}
        node={node}
        depth={depth}
        selected={selectedKey === fileKey(node.file)}
        onSelect={() => onSelect(node.file)}
      />
    ) : (
      <FolderRows
        key={`folder:${node.path}`}
        folder={node}
        depth={depth}
        expanded={expanded}
        selectedKey={selectedKey}
        onToggle={onToggle}
        onSelect={onSelect}
      />
    ),
  );
}

function FolderRows({
  folder,
  depth,
  expanded,
  selectedKey,
  onToggle,
  onSelect,
}: {
  folder: FolderNode;
  depth: number;
  expanded: ReadonlySet<string>;
  selectedKey: string | null;
  onToggle: (folder: FolderNode) => void;
  onSelect: (file: BrowserFile) => void;
}) {
  const open = expanded.has(folder.path);
  const Icon = open ? FolderOpenIcon : FolderIcon;
  return (
    <li>
      <button
        type="button"
        className={ROW_CLASS}
        style={indent(depth)}
        aria-expanded={open}
        data-testid="files-folder"
        data-path={folder.path}
        onClick={() => onToggle(folder)}
      >
        <ChevronRightIcon
          aria-hidden
          className={cn(
            "-ml-1 size-3.5 shrink-0 text-muted-foreground transition-transform",
            open && "rotate-90",
          )}
        />
        <Icon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-sm text-foreground">{folder.name}</span>
          <span className="truncate text-xs text-muted-foreground">{folderCaption(folder)}</span>
        </span>
      </button>
      {open ? (
        folder.children.length === 0 ? (
          <p className="py-1.5 text-xs text-muted-foreground" style={indent(depth + 1.5)}>
            This folder is empty
          </p>
        ) : (
          <ul>
            <TreeRows
              nodes={folder.children}
              depth={depth + 1}
              expanded={expanded}
              selectedKey={selectedKey}
              onToggle={onToggle}
              onSelect={onSelect}
            />
          </ul>
        )
      ) : null}
    </li>
  );
}

function ListState({ children, action }: { children: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-start gap-2 px-4 py-3">
      <p className="text-sm text-muted-foreground" role="status">
        {children}
      </p>
      {action}
    </div>
  );
}

type DialogTarget =
  | { readonly kind: "rename"; readonly file: BrowserFile }
  | { readonly kind: "delete"; readonly file: BrowserFile };

function PreviewPane({
  file,
  api,
  environmentId,
  canEdit,
  onBack,
  onGoToSection,
  onRename,
  onDelete,
}: {
  file: BrowserFile;
  api: SystemFilesApi;
  environmentId: EnvironmentId;
  canEdit: boolean;
  onBack: () => void;
  onGoToSection: (sectionId: string) => void;
  onRename: () => void;
  onDelete: () => void;
}) {
  const plan = useMemo(() => previewPlan(file), [file]);
  const { content, retry } = useFileContent(file, plan, api.read);
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const name = fileName(file.path);
  const section = shownIn(file);
  const where = whereLabel(file);
  const extension = extensionOf(file.path).toUpperCase() || "FILE";
  const readable = file.unavailable === undefined;

  const download = async () => {
    setDownloadError(null);
    const type = downloadType(file.mimeType);
    if (content.status === "ready") return downloadBlob(new Blob([content.bytes], { type }), name);
    if (file.origin === "generated")
      return downloadBlob(new Blob([file.text ?? ""], { type }), name);
    setDownloading(true);
    const outcome = await api.read({ origin: file.origin, path: file.path });
    setDownloading(false);
    if (!outcome.ok) return setDownloadError(outcome.message);
    downloadBlob(new Blob([readBytes(outcome.value)], { type }), name);
  };

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-testid="files-preview">
      <div className="border-b border-border/60 px-2 py-1.5 @2xl/files:hidden">
        <Button variant="ghost" size="sm" onClick={onBack}>
          <ArrowLeftIcon aria-hidden />
          All files
        </Button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col overflow-auto bg-muted/30">
        <FilePreviewBody
          file={file}
          plan={plan}
          content={content}
          environmentId={environmentId}
          onRetry={retry}
        />
      </div>
      <footer className="flex flex-col gap-2.5 border-t border-border/60 bg-background px-4 py-3">
        <div className="flex items-start gap-3">
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <p className="break-all text-sm font-medium text-foreground" data-testid="files-name">
              {name}
            </p>
            {file.origin === "source" || folderOf(file.path) !== "" ? (
              <p className="break-all font-mono text-2xs text-muted-foreground">{file.path}</p>
            ) : null}
            <p className="text-xs text-muted-foreground" data-testid="files-where">
              {where === null ? kindLabel(file.path) : `${kindLabel(file.path)} · ${where}`}
            </p>
            <p className="text-xs text-muted-foreground tabular-nums" data-testid="files-size">
              {formatSize(file.bytes)} · {extension}
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            disabled={!readable || downloading}
            onClick={() => void download()}
          >
            <DownloadIcon aria-hidden />
            {downloading ? "Downloading…" : "Download"}
          </Button>
        </div>
        {downloadError ? (
          <p role="alert" className="text-xs text-destructive-foreground">
            {downloadError}
          </p>
        ) : null}
        {section !== null || (canEdit && file.origin === "stored") ? (
          <div className="flex flex-wrap items-center gap-2">
            {section !== null ? (
              <Button variant="outline" size="xs" onClick={() => onGoToSection(section.id)}>
                Go to {section.label}
                <ArrowRightIcon aria-hidden />
              </Button>
            ) : null}
            {canEdit && file.origin === "stored" ? (
              <>
                <Button variant="ghost" size="xs" onClick={onRename}>
                  <PencilIcon aria-hidden />
                  Rename
                </Button>
                <Button variant="ghost-destructive" size="xs" onClick={onDelete}>
                  <Trash2Icon aria-hidden />
                  Delete
                </Button>
              </>
            ) : null}
          </div>
        ) : null}
      </footer>
    </div>
  );
}

export function FilesBrowserView({
  environmentId,
  system,
  canEdit,
  onGoToSection,
  onClose,
  api,
}: FilesBrowserProps & { readonly api: SystemFilesApi }) {
  const generated = useMemo(() => generatedFiles(system), [system]);
  const listing = api.listing;
  const listed = useMemo(() => (listing.data?.files ?? []).map(browserFile), [listing.data]);
  const files = useMemo(() => [...listed, ...generated], [generated, listed]);
  const groups = useMemo(() => groupTopLevel(files), [files]);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [dialog, setDialog] = useState<DialogTarget | null>(null);
  const layer = useRef<HTMLElement>(null);
  const selected = files.find((file) => fileKey(file) === selectedKey) ?? null;
  const count = listed.length + generated.length;

  // Esc closes Files, unless a dialog of its own is open and takes it.
  const dialogOpen = dialog !== null;
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || dialogOpen) return;
      onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [dialogOpen, onClose]);

  useEffect(() => {
    layer.current?.focus({ preventScroll: true });
  }, []);

  const toggle = (folder: FolderNode) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(folder.path)) next.delete(folder.path);
      else next.add(folder.path);
      return next;
    });

  const storedPaths = new Set(
    listed.filter((file) => file.origin === "stored").map((file) => file.path),
  );
  const nothingStored = listing.data !== null && listed.length === 0;

  let list: ReactNode;
  if (listing.data === null && listing.error === null) list = <ListState>Listing files…</ListState>;
  else if (listing.data === null)
    list = (
      <ListState
        action={
          <Button variant="outline" size="sm" onClick={listing.refresh}>
            <RefreshCwIcon aria-hidden />
            Try again
          </Button>
        }
      >
        Couldn't list the files.
      </ListState>
    );
  else
    list = (
      <>
        {nothingStored ? (
          <div className="px-4 pt-3 pb-1" data-testid="files-empty">
            <p className="text-sm text-foreground">This design system has no stored files yet</p>
            <p className="text-xs text-muted-foreground">
              {canEdit
                ? "Upload logos and images in Assets, or write the README in Overview. The token files below are built from the tokens."
                : "The token files below are built from the tokens."}
            </p>
          </div>
        ) : null}
        {groups.map(({ group, entries }) => (
          <section key={group} className="flex flex-col gap-0.5 px-2 pt-3" data-group={group}>
            <h3 className="px-2 pb-1 text-xs font-medium text-muted-foreground">{group}</h3>
            <ul className="flex flex-col">
              <TreeRows
                nodes={entries}
                depth={0}
                expanded={expanded}
                selectedKey={selectedKey}
                onToggle={toggle}
                onSelect={(file) => setSelectedKey(fileKey(file))}
              />
            </ul>
          </section>
        ))}
      </>
    );

  return (
    <section
      ref={layer}
      tabIndex={-1}
      aria-label="Files"
      data-testid="files-browser"
      className="@container/files absolute inset-0 z-20 flex min-h-0 flex-col bg-background outline-none"
    >
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border/60 px-4">
        <h2 className="text-base font-medium text-foreground">Files</h2>
        {listing.data !== null ? (
          <span className="text-xs text-muted-foreground tabular-nums">
            {count} {count === 1 ? "file" : "files"}
          </span>
        ) : null}
        <Button
          variant="ghost"
          size="icon-sm"
          className="ml-auto"
          aria-label="Close the file browser"
          title="Close (Esc)"
          onClick={onClose}
        >
          <XIcon aria-hidden />
        </Button>
      </header>
      <div className="flex min-h-0 flex-1">
        <nav
          aria-label="System files"
          className={cn(
            "min-h-0 w-full shrink-0 flex-col overflow-y-auto pb-4 @2xl/files:flex @2xl/files:w-80 @2xl/files:border-r @2xl/files:border-border/60 @4xl/files:w-96",
            selected === null ? "flex" : "hidden",
          )}
        >
          {list}
        </nav>
        {selected === null ? (
          <div className="hidden min-w-0 flex-1 items-center justify-center p-6 text-center text-sm text-muted-foreground @2xl/files:flex">
            Choose a file to preview it.
          </div>
        ) : (
          <PreviewPane
            key={fileKey(selected)}
            file={selected}
            api={api}
            environmentId={environmentId}
            canEdit={canEdit}
            onBack={() => setSelectedKey(null)}
            onGoToSection={onGoToSection}
            onRename={() => setDialog({ kind: "rename", file: selected })}
            onDelete={() => setDialog({ kind: "delete", file: selected })}
          />
        )}
      </div>
      {dialog?.kind === "rename" ? (
        <RenameDialog
          title={`Rename ${fileName(dialog.file.path)}`}
          label="File name"
          initial={fileName(dialog.file.path)}
          description="Links to the old name stop working."
          problem={(value) => {
            const invalid = fileNameProblem(value);
            if (invalid !== null) return invalid;
            const folder = folderOf(dialog.file.path);
            const to = folder === "" ? value : `${folder}/${value}`;
            return storedPaths.has(to) ? `There is already a file named ${value} here.` : null;
          }}
          onRename={async (value) => {
            const folder = folderOf(dialog.file.path);
            const to = folder === "" ? value : `${folder}/${value}`;
            const outcome = await api.move(dialog.file.path, to);
            if (!outcome.ok) return outcome.message;
            setSelectedKey(fileKey({ origin: "stored", path: outcome.value.path }));
            listing.refresh();
            return null;
          }}
          onClose={() => setDialog(null)}
        />
      ) : dialog?.kind === "delete" ? (
        <ConfirmDeleteDialog
          title={`Delete ${fileName(dialog.file.path)}?`}
          description={
            dialog.file.path.startsWith("assets/")
              ? "The files are deleted from assets/. Anything linking to them will break."
              : "The file is deleted from this design system. Anything linking to it will break."
          }
          onConfirm={async () => {
            const outcome = await api.remove(dialog.file.path);
            if (!outcome.ok) return outcome.message;
            setSelectedKey(null);
            listing.refresh();
            return null;
          }}
          onClose={() => setDialog(null)}
        />
      ) : null}
    </section>
  );
}
