import { parentFolderOf } from "../components/studio/folderBrowser.logic";

/** The path of a dropped file or folder on this device; only the desktop app can tell. */
export function resolveDroppedFolderPath(
  folder: File,
  getPathForFile: ((file: File) => string) | undefined,
): string | null {
  const path = getPathForFile?.(folder);
  return typeof path === "string" && path.length > 0 ? path : null;
}

/**
 * Why a folder cannot be dropped here, or null when it can. A dropped path
 * belongs to the device in front of the person, so it means nothing to
 * another machine, and a browser never reveals it.
 */
export function folderDropRefusal(input: {
  readonly inDesktopApp: boolean;
  readonly targetIsThisDevice: boolean;
  readonly machineLabel: string | null;
}): string | null {
  if (!input.inDesktopApp) {
    return "A browser cannot read a dropped folder's path. Type or paste the path instead.";
  }
  if (!input.targetIsThisDevice) {
    return `The dropped folder is on this device, not on ${input.machineLabel ?? "the selected machine"}. Type or paste a path on that machine instead.`;
  }
  return null;
}

/**
 * The folder a drop stands for: the first dropped folder, or the folder that
 * holds the first dropped file.
 */
export function droppedFolder(input: {
  readonly files: readonly File[];
  /** Whether the file at `index` is a folder; null when the browser does not say. */
  readonly isDirectory: (index: number) => boolean | null;
  readonly getPathForFile: ((file: File) => string) | undefined;
}): { readonly path: string; readonly fromFile: boolean } | null {
  const paths = input.files.map((file) => resolveDroppedFolderPath(file, input.getPathForFile));
  const folder = paths.findIndex(
    (path, index) => path !== null && input.isDirectory(index) !== false,
  );
  if (folder >= 0) return { path: paths[folder]!, fromFile: false };
  const file = paths.find((path) => path !== null);
  const parent = file ? parentFolderOf(file) : null;
  return parent === null ? null : { path: parent, fromFile: true };
}
