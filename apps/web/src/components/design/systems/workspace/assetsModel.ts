/**
 * Asset sets: each folder directly under `assets/` is a set, and loose
 * files in `assets/` itself make the "Other" set. A set has no record of
 * its own; it exists while it holds files.
 */
import { isHiddenPath, type BrowserFile } from "./filesModel";

export const ASSETS_FOLDER = "assets";
export const OTHER_SET = "Other";

export interface AssetSet {
  /** Display name: the folder name, or "Other". */
  readonly name: string;
  /** Where its files are stored: `assets/<Set>`, or `assets` for Other. */
  readonly folder: string;
  readonly loose: boolean;
  readonly files: readonly AssetEntry[];
}

export interface AssetEntry {
  readonly file: BrowserFile;
  /** The path inside the set (`mark.svg`, `print/mark.pdf`). */
  readonly name: string;
}

const byName = (left: { name: string }, right: { name: string }) =>
  left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: "base" });

export function assetSets(files: readonly BrowserFile[]): AssetSet[] {
  const sets = new Map<string, AssetEntry[]>();
  const loose: AssetEntry[] = [];
  for (const file of files) {
    if (file.origin !== "stored" || isHiddenPath(file.path)) continue;
    if (!file.path.startsWith(`${ASSETS_FOLDER}/`)) continue;
    const rest = file.path.slice(ASSETS_FOLDER.length + 1);
    const slash = rest.indexOf("/");
    if (slash === -1) {
      loose.push({ file, name: rest });
      continue;
    }
    const set = rest.slice(0, slash);
    const entries = sets.get(set) ?? [];
    entries.push({ file, name: rest.slice(slash + 1) });
    sets.set(set, entries);
  }
  const named = [...sets.entries()]
    .map(([name, entries]) => ({
      name,
      folder: `${ASSETS_FOLDER}/${name}`,
      loose: false,
      files: entries.toSorted(byName),
    }))
    .toSorted(byName);
  return loose.length === 0
    ? named
    : [
        ...named,
        { name: OTHER_SET, folder: ASSETS_FOLDER, loose: true, files: loose.toSorted(byName) },
      ];
}

/** Where a file uploaded to a set goes; `Other` puts it loose in `assets/`. */
export function setFolder(setName: string): string {
  return setName === OTHER_SET ? ASSETS_FOLDER : `${ASSETS_FOLDER}/${setName}`;
}

/** "Stored with this design system: 13 files · 849 KB of 1024 MB used". */
export function storageLine(count: number, used: string, limit: string): string {
  return `Stored with this design system: ${count} ${count === 1 ? "file" : "files"} · ${used} of ${limit} used`;
}
