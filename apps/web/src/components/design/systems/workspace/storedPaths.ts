/**
 * Client checks for stored files that mirror the contract's limits, so a
 * person hears what is wrong before anything is sent: allowed extensions,
 * one file's size, the system's total size and file count, path length and
 * depth, and names a folder can hold.
 */
import {
  DESIGN_SYSTEM_FILE_EXTENSIONS,
  DESIGN_SYSTEM_FILE_MAX_BYTES,
  DESIGN_SYSTEM_FILE_PATH_MAX_DEPTH,
  DESIGN_SYSTEM_FILE_PATH_MAX_LENGTH,
} from "@specweave-studio/contracts";

import { extensionOf, fileName, folderOf, formatSize } from "./filesModel";

const ALLOWED = new Set<string>(DESIGN_SYSTEM_FILE_EXTENSIONS);
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,119}$/;
export const FONT_EXTENSIONS = new Set(["woff", "woff2", "ttf", "otf"]);

/** Uploads in one go, like the reference's bulk limit. */
export const MAX_FILES_AT_ONCE = 64;

export const ALLOWED_TYPES_SENTENCE =
  "images (PNG, JPG, GIF, WebP, SVG, ICO, AVIF), fonts (WOFF, WOFF2, TTF, OTF), PDF, Markdown, text, JSON, CSS or HTML";

/** The `accept` attribute for a file picker. */
export const ACCEPT_ATTRIBUTE = DESIGN_SYSTEM_FILE_EXTENSIONS.map(
  (extension) => `.${extension}`,
).join(",");

export const isAllowedExtension = (path: string) => ALLOWED.has(extensionOf(path));

/**
 * A picked file's name as a stored name: characters a folder cannot hold
 * become `-`, and it starts with a letter or digit. Null when nothing is left.
 */
export function storedName(name: string): string | null {
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const extension = dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
  const cleanStem = stem
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^A-Za-z0-9 ._-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[^A-Za-z0-9]+/, "")
    .replace(/[-. ]+$/, "")
    .slice(0, 110);
  if (cleanStem === "") return null;
  return extension === "" ? cleanStem : `${cleanStem}.${extension}`;
}

/**
 * The first free name in a folder: `logo.png`, then `logo 2.png`, `logo 3.png`…
 * Names differing only in case count as taken: a Mac disk keeps one of them.
 */
export function uniquePath(path: string, taken: ReadonlySet<string>): string {
  const lower = new Set([...taken].map((entry) => entry.toLowerCase()));
  const free = (candidate: string) => !lower.has(candidate.toLowerCase());
  if (free(path)) return path;
  const folder = folderOf(path);
  const name = fileName(path);
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const extension = dot > 0 ? name.slice(dot) : "";
  for (let count = 2; ; count += 1) {
    const candidate = `${folder === "" ? "" : `${folder}/`}${stem} ${count}${extension}`;
    if (free(candidate)) return candidate;
  }
}

/** Why a file name cannot be stored, or null. */
export function fileNameProblem(name: string): string | null {
  const trimmed = name.trim();
  if (trimmed === "") return "A file needs a name.";
  if (trimmed.includes("/") || trimmed.includes("\\")) return "A file name can't contain / or \\.";
  if (trimmed.startsWith(".")) return "A file name can't start with a dot.";
  if (!isAllowedExtension(trimmed))
    return `“${trimmed}” doesn't end in a type a design system keeps: ${ALLOWED_TYPES_SENTENCE}.`;
  if (!SEGMENT.test(trimmed))
    return "Use letters, digits, spaces, dots, dashes and underscores, starting with a letter or digit.";
  return null;
}

/** Why a set (folder) name cannot be used, or null. */
export function setNameProblem(name: string, existing: readonly string[]): string | null {
  const trimmed = name.trim();
  if (trimmed === "") return "A set needs a name.";
  if (trimmed.includes("/") || trimmed.includes("\\")) return "A set name can't contain / or \\.";
  if (trimmed.length > 60) return "Keep the set name under 60 characters.";
  if (trimmed.startsWith(".")) return "A set name can't start with a dot.";
  if (trimmed.toLowerCase() === "other") return "“Other” holds the loose files; pick another name.";
  if (!SEGMENT.test(trimmed))
    return "Use letters, digits, spaces, dots, dashes and underscores, starting with a letter or digit.";
  if (existing.some((set) => set.toLowerCase() === trimmed.toLowerCase()))
    return `There is already a ${trimmed} set.`;
  return null;
}

/** Why a full stored path cannot be written, or null. */
export function pathProblem(path: string): string | null {
  if (path.length > DESIGN_SYSTEM_FILE_PATH_MAX_LENGTH)
    return `${fileName(path)}: the path is longer than ${DESIGN_SYSTEM_FILE_PATH_MAX_LENGTH} characters.`;
  if (path.split("/").length > DESIGN_SYSTEM_FILE_PATH_MAX_DEPTH)
    return `${fileName(path)}: folders can only go ${DESIGN_SYSTEM_FILE_PATH_MAX_DEPTH - 1} deep.`;
  return null;
}

export interface PlannedUpload {
  readonly file: File;
  readonly path: string;
}

export interface StorageRoom {
  readonly usedBytes: number;
  readonly limitBytes: number;
  readonly fileCount: number;
  readonly limitFiles: number;
}

export type UploadPlan =
  | { readonly ok: true; readonly uploads: readonly PlannedUpload[] }
  | { readonly ok: false; readonly message: string };

/**
 * Where each picked file goes, after the same checks the server makes:
 * type, one file's size, the batch size, and room left in the system.
 * `folderFor` picks the folder per file (a set, or `fonts`).
 */
export function planUploads(
  files: readonly File[],
  folderFor: (file: File) => string,
  taken: ReadonlySet<string>,
  room: StorageRoom | null,
): UploadPlan {
  if (files.length === 0) return { ok: false, message: "Choose at least one file." };
  if (files.length > MAX_FILES_AT_ONCE)
    return {
      ok: false,
      message: `That is too many files at once (more than ${MAX_FILES_AT_ONCE}). Add them in smaller batches.`,
    };
  const wrongType = files.find((file) => !isAllowedExtension(file.name));
  if (wrongType)
    return {
      ok: false,
      message: `${wrongType.name} is not a type a design system keeps. Use ${ALLOWED_TYPES_SENTENCE}.`,
    };
  const tooLarge = files.find((file) => file.size > DESIGN_SYSTEM_FILE_MAX_BYTES);
  if (tooLarge)
    return {
      ok: false,
      message: `${tooLarge.name} is ${formatSize(tooLarge.size)}; one file can be at most ${formatSize(DESIGN_SYSTEM_FILE_MAX_BYTES)}.`,
    };
  if (room !== null) {
    const adding = files.reduce((sum, file) => sum + file.size, 0);
    const left = Math.max(0, room.limitBytes - room.usedBytes);
    if (adding > left)
      return {
        ok: false,
        message: `There isn't room: these files need ${formatSize(adding)} and ${formatSize(left)} is left.`,
      };
    if (room.fileCount + files.length > room.limitFiles)
      return {
        ok: false,
        message: `A design system keeps at most ${room.limitFiles.toLocaleString("en-US")} files; ${Math.max(0, room.limitFiles - room.fileCount).toLocaleString("en-US")} more fit.`,
      };
  }
  const used = new Set(taken);
  const uploads: PlannedUpload[] = [];
  for (const file of files) {
    const name = storedName(file.name);
    if (name === null)
      return { ok: false, message: `${file.name} needs a name with a letter or digit in it.` };
    const folder = folderFor(file);
    const path = uniquePath(folder === "" ? name : `${folder}/${name}`, used);
    const problem = pathProblem(path);
    if (problem !== null) return { ok: false, message: problem };
    used.add(path);
    uploads.push({ file, path });
  }
  return { ok: true, uploads };
}
