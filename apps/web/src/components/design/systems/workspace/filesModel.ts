/**
 * Pure rules for a design system's Files layer: what kind each file is,
 * where the page shows it, how sizes read, and the folder tree the list
 * draws. Stored files sit in the system's `files/` folder (README.md,
 * docs/, fonts/, assets/<Set>/); sources are the repository files the
 * system was read from; generated files are built in the app from tokens.
 */
import type { DesignSystemFile } from "@specweave-studio/contracts";

export type BrowserFileOrigin = "stored" | "source" | "generated";

/** One row of the Files list. Generated files carry their text; the others are read on demand. */
export interface BrowserFile {
  readonly path: string;
  readonly origin: BrowserFileOrigin;
  readonly bytes: number;
  readonly mimeType: string;
  readonly updatedAt?: string | undefined;
  /** Sources only: why the file cannot be read now. */
  readonly unavailable?: string | undefined;
  /** Generated files only. */
  readonly text?: string | undefined;
}

export function browserFile(file: DesignSystemFile): BrowserFile {
  return {
    path: file.path,
    origin: file.origin,
    bytes: file.bytes,
    mimeType: file.mimeType,
    ...(file.updatedAt === undefined ? {} : { updatedAt: file.updatedAt }),
    ...(file.unavailable === undefined ? {} : { unavailable: file.unavailable }),
  };
}

// ---------------------------------------------------------------------------
// Names, extensions and sizes
// ---------------------------------------------------------------------------

export function fileName(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? path : path.slice(slash + 1);
}

export function folderOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? "" : path.slice(0, slash);
}

/** Lowercase extension without the dot; empty when the name has none. */
export function extensionOf(path: string): string {
  const name = fileName(path);
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot + 1).toLowerCase();
}

/** "12 B", "91 KB" (rounded), "3.4 MB" (one decimal; "1024 MB" when whole). */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1).replace(/\.0$/, "")} MB`;
}

/** "JPG · 91 KB"; "File · 2 KB" for a name without an extension. */
export function typeLabel(path: string, bytes: number): string {
  const extension = extensionOf(path);
  return `${extension === "" ? "File" : extension.toUpperCase()} · ${formatSize(bytes)}`;
}

/** Dot files and anything inside a dot folder never show. */
export function isHiddenPath(path: string): boolean {
  return path.split("/").some((segment) => segment.startsWith("."));
}

// ---------------------------------------------------------------------------
// Kinds and groups
// ---------------------------------------------------------------------------

export const FILE_GROUPS = [
  "Folders",
  "Pages",
  "Components",
  "Stylesheets",
  "Scripts",
  "Images",
  "Fonts",
  "Documents",
  "Data",
  "Sources",
  "Other",
] as const;
export type FileGroup = (typeof FILE_GROUPS)[number];

type FileClass = Exclude<FileGroup, "Folders" | "Sources">;

const EXTENSION_CLASSES: Record<string, FileClass> = {
  html: "Pages",
  htm: "Pages",
  jsx: "Components",
  tsx: "Components",
  css: "Stylesheets",
  scss: "Stylesheets",
  less: "Stylesheets",
  js: "Scripts",
  mjs: "Scripts",
  cjs: "Scripts",
  ts: "Scripts",
  png: "Images",
  jpg: "Images",
  jpeg: "Images",
  gif: "Images",
  svg: "Images",
  webp: "Images",
  ico: "Images",
  bmp: "Images",
  avif: "Images",
  woff: "Fonts",
  woff2: "Fonts",
  ttf: "Fonts",
  otf: "Fonts",
  md: "Documents",
  markdown: "Documents",
  txt: "Documents",
  pdf: "Documents",
  json: "Data",
  yaml: "Data",
  yml: "Data",
  toml: "Data",
};

const CLASS_KINDS: Record<FileClass, string> = {
  Pages: "HTML page",
  Components: "Component",
  Stylesheets: "Stylesheet",
  Scripts: "Script",
  Images: "Image",
  Fonts: "Font",
  Documents: "Document",
  Data: "Data file",
  Other: "File",
};

function fileClass(path: string): FileClass {
  return EXTENSION_CLASSES[extensionOf(path)] ?? "Other";
}

/** The heading a file lists under; sources keep their own group whatever their type. */
export function fileGroup(file: Pick<BrowserFile, "path" | "origin">): FileGroup {
  return file.origin === "source" ? "Sources" : fileClass(file.path);
}

/** "Image", "Stylesheet", "Font"…; "PDF document" and "Markdown" where the extension says more. */
export function kindLabel(path: string): string {
  const extension = extensionOf(path);
  if (extension === "pdf") return "PDF document";
  if (extension === "md" || extension === "markdown") return "Markdown";
  return CLASS_KINDS[fileClass(path)];
}

// ---------------------------------------------------------------------------
// Where the page shows a file
// ---------------------------------------------------------------------------

export interface PageSection {
  /** The page's section id, passed to `onGoToSection`. */
  readonly id: string;
  readonly label: string;
}

export const PAGE_SECTIONS = {
  overview: { id: "readme", label: "Overview" },
  typography: { id: "type", label: "Typography" },
  assets: { id: "assets", label: "Assets" },
} as const satisfies Record<string, PageSection>;

/** The section that shows a stored file, or null when no section does. */
export function shownIn(file: Pick<BrowserFile, "path" | "origin">): PageSection | null {
  if (file.origin !== "stored") return null;
  const path = file.path;
  const markdown = /\.(md|markdown)$/i.test(path);
  if (path === "README.md" || (markdown && path.startsWith("docs/"))) return PAGE_SECTIONS.overview;
  if (path.startsWith("fonts/")) return PAGE_SECTIONS.typography;
  if (path.startsWith("assets/")) return PAGE_SECTIONS.assets;
  return null;
}

/** "Shown in Overview", "Generated from this design system", "Read from the repository", or null. */
export function whereLabel(file: Pick<BrowserFile, "path" | "origin">): string | null {
  if (file.origin === "generated") return "Generated from this design system";
  if (file.origin === "source") return "Read from the repository";
  const section = shownIn(file);
  return section === null ? null : `Shown in ${section.label}`;
}

/** The caption under a file's name: "Image · Shown in Assets", or just the kind. */
export function fileCaption(file: Pick<BrowserFile, "path" | "origin">): string {
  const where = whereLabel(file);
  return where === null ? kindLabel(file.path) : `${kindLabel(file.path)} · ${where}`;
}

// ---------------------------------------------------------------------------
// Tree
// ---------------------------------------------------------------------------

export interface FolderNode {
  readonly kind: "folder";
  readonly name: string;
  readonly path: string;
  readonly children: readonly TreeNode[];
  /** Files anywhere inside, nested folders included. */
  readonly fileCount: number;
}

export interface FileNode {
  readonly kind: "file";
  readonly name: string;
  readonly file: BrowserFile;
}

export type TreeNode = FolderNode | FileNode;

interface MutableFolder {
  readonly name: string;
  readonly path: string;
  readonly folders: Map<string, MutableFolder>;
  readonly files: BrowserFile[];
}

const newFolder = (name: string, path: string): MutableFolder => ({
  name,
  path,
  folders: new Map(),
  files: [],
});

const byName = (left: { name: string }, right: { name: string }) =>
  left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: "base" });

function freeze(folder: MutableFolder): FolderNode {
  const folders = [...folder.folders.values()].map(freeze).toSorted(byName);
  const files: FileNode[] = folder.files
    .map((file) => ({ kind: "file" as const, name: fileName(file.path), file }))
    .toSorted(byName);
  return {
    kind: "folder",
    name: folder.name,
    path: folder.path,
    children: [...folders, ...files],
    fileCount: files.length + folders.reduce((sum, child) => sum + child.fileCount, 0),
  };
}

/**
 * Stored and generated files as a folder tree; dot paths are left out.
 * Sources are not part of the tree: they list under Sources by full path.
 */
export function buildTree(files: readonly BrowserFile[]): FolderNode {
  const root = newFolder("", "");
  for (const file of files) {
    if (file.origin === "source" || isHiddenPath(file.path)) continue;
    const segments = file.path.split("/").filter((segment) => segment !== "");
    if (segments.length === 0) continue;
    let folder = root;
    for (const segment of segments.slice(0, -1)) {
      const path = folder.path === "" ? segment : `${folder.path}/${segment}`;
      let next = folder.folders.get(segment);
      if (next === undefined) {
        next = newFolder(segment, path);
        folder.folders.set(segment, next);
      }
      folder = next;
    }
    folder.files.push(file);
  }
  return freeze(root);
}

/** "Folder · 3 files". */
export function folderCaption(folder: Pick<FolderNode, "fileCount">): string {
  return `Folder · ${folder.fileCount} ${folder.fileCount === 1 ? "file" : "files"}`;
}

export interface FileGroupEntries {
  readonly group: FileGroup;
  readonly entries: readonly TreeNode[];
}

/**
 * The list's top level: root folders under Folders, root files under their
 * kind, sources under Sources; only non-empty groups, in the fixed order.
 */
export function groupTopLevel(files: readonly BrowserFile[]): FileGroupEntries[] {
  const root = buildTree(files);
  const buckets = new Map<FileGroup, TreeNode[]>();
  const add = (group: FileGroup, node: TreeNode) => {
    const bucket = buckets.get(group) ?? [];
    bucket.push(node);
    buckets.set(group, bucket);
  };
  for (const node of root.children) {
    add(node.kind === "folder" ? "Folders" : fileGroup(node.file), node);
  }
  const sources = files
    .filter((file) => file.origin === "source" && !isHiddenPath(file.path))
    .map((file) => ({ kind: "file" as const, name: file.path, file }))
    .toSorted(byName);
  for (const source of sources) add("Sources", source);
  return FILE_GROUPS.flatMap((group) => {
    const entries = buckets.get(group);
    return entries === undefined ? [] : [{ group, entries }];
  });
}

/** Every visible file, for counts. */
export function visibleFiles(files: readonly BrowserFile[]): BrowserFile[] {
  return files.filter((file) => !isHiddenPath(file.path));
}

export const fileKey = (file: Pick<BrowserFile, "origin" | "path">) =>
  `${file.origin}:${file.path}`;
