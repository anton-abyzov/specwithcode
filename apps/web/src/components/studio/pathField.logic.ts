import { isWindowsAbsolutePath } from "@specweave-studio/shared/path";
import { parentFolderOf, sameFolder, type KnownProject } from "./folderBrowser.logic";

/** How paths behave on the machine whose folders are being chosen. */
export interface PathMachine {
  /** Drive and UNC paths, either separator. */
  readonly windows: boolean;
  /** Folder names match whatever their case (macOS and Windows). */
  readonly ignoresCase: boolean;
}

const lastSeparator = (path: string, windows: boolean) =>
  windows ? Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) : path.lastIndexOf("/");

/** The part of a typed path after its last separator: the folder name being typed. */
export const typedLeaf = (path: string, windows: boolean) =>
  path.slice(lastSeparator(path, windows) + 1);

/** The typed path up to and including its last separator. */
export const typedDirectory = (path: string, windows: boolean) =>
  path.slice(0, lastSeparator(path, windows) + 1);

/**
 * What people copy when they copy a folder: a quoted path from a terminal or
 * from "Copy as path", a file link, a path with escaped spaces, a trailing
 * line break. Returns the plain path for the machine.
 */
export function cleanPastedPath(text: string, machine: Pick<PathMachine, "windows">): string {
  let path = (text.split(/\r?\n/).find((line) => line.trim().length > 0) ?? "").trim();
  const quoted = /^(["'])(.*)\1$/.exec(path);
  if (quoted) path = quoted[2]!;
  if (/^file:\/\//i.test(path)) {
    try {
      const url = new URL(path);
      const decoded = decodeURIComponent(url.pathname);
      const drive = /^\/([A-Za-z]:)(\/.*)?$/.exec(decoded);
      if (drive) path = `${drive[1]}${(drive[2] ?? "/").replaceAll("/", "\\")}`;
      else if (url.host && url.host !== "localhost")
        path = `\\\\${url.host}${decoded.replaceAll("/", "\\")}`;
      else path = decoded;
    } catch {
      // Not a link after all; keep what was pasted.
    }
  } else if (!machine.windows) {
    // A shell escapes spaces and brackets with a backslash; on Windows a backslash is a separator.
    path = path.replace(/\\([ ()'"&[\]{}!$])/g, "$1");
  }
  return path;
}

/** Why this path cannot be a folder on the machine, or null when it can be asked for. */
export function pathKindProblem(
  path: string,
  machine: Pick<PathMachine, "windows">,
  machineLabel: string | null,
): string | null {
  const trimmed = path.trim();
  const where = machineLabel ?? "This machine";
  if (!machine.windows && isWindowsAbsolutePath(trimmed)) {
    return `${where} is not a Windows machine, so it has no ${trimmed.slice(0, 3)} path. Type a path that starts with / or ~/.`;
  }
  if (machine.windows && /^\/(?!\/)/.test(trimmed)) {
    return `${where} is a Windows machine. Type a path that starts with a drive, like C:\\Projects, or with ~/.`;
  }
  return null;
}

/**
 * Completes the folder name being typed from the folders in its directory,
 * the way a browser's address bar does: the added part comes back as a
 * selection, so the next key replaces it and one Backspace removes it.
 * Only completes text that grew at its end; a name with no match is left alone.
 */
export function completeTypedPath(input: {
  readonly typed: string;
  /** What the person had typed before this change, without any completion. */
  readonly previous: string;
  readonly names: readonly string[];
  readonly machine: PathMachine;
}): { readonly value: string; readonly selectionStart: number } | null {
  const { typed, previous, machine } = input;
  if (typed.length <= previous.length || !typed.startsWith(previous)) return null;
  const leaf = typedLeaf(typed, machine.windows);
  if (leaf.length === 0) return null;
  const wanted = machine.ignoresCase ? leaf.toLowerCase() : leaf;
  const match = input.names.find((name) => {
    if (name.length <= leaf.length) return false;
    // A hidden folder is completed only once its dot was typed.
    return (machine.ignoresCase ? name.toLowerCase() : name).startsWith(wanted);
  });
  if (match === undefined) return null;
  // Keep the person's own letters; add only the rest of the name.
  return { value: typed + match.slice(leaf.length), selectionStart: typed.length };
}

export type AddFolderKey =
  | { readonly kind: "submit" }
  /** Put the row's folder into the bar; the list keeps showing its siblings. */
  | { readonly kind: "highlight"; readonly index: number }
  /** Open the folder: the bar ends with a separator and the list shows inside it. */
  | { readonly kind: "open"; readonly path: string }
  | { readonly kind: "parent"; readonly path: string };

/**
 * What a key does in the address bar. Enter always confirms the folder the bar
 * shows; arrows move through the list and write the folder into the bar; Tab
 * or Right at the end opens it; Left at the start of a highlighted name, or
 * Backspace on a separator, goes up one folder. The pointer plays no part.
 */
export function addFolderKey(input: {
  readonly key: string;
  readonly modified: boolean;
  /** The bar's text and caret. */
  readonly value: string;
  readonly selectionStart: number;
  readonly selectionEnd: number;
  /** The row whose folder the arrows put into the bar, if any. */
  readonly highlighted: number | null;
  readonly rows: ReadonlyArray<{ readonly fullPath: string }>;
  /** The folder the bar names when Tab is pressed: a highlighted, completed or exactly typed folder. */
  readonly openable: string | null;
  readonly machine: Pick<PathMachine, "windows">;
}): AddFolderKey | null {
  const { key, value, highlighted, rows } = input;
  if (key === "Enter") return { kind: "submit" };
  if (input.modified) return null;
  const atEnd = input.selectionEnd === value.length;
  if (key === "ArrowDown" || key === "ArrowUp") {
    if (rows.length === 0) return null;
    const step = key === "ArrowDown" ? 1 : -1;
    const next =
      highlighted === null
        ? step > 0
          ? 0
          : rows.length - 1
        : Math.min(Math.max(highlighted + step, 0), rows.length - 1);
    return { kind: "highlight", index: next };
  }
  if ((key === "Tab" || (key === "ArrowRight" && atEnd)) && input.openable !== null) {
    // Right inside a completion only accepts it, as in any text field.
    if (key === "ArrowRight" && input.selectionStart !== input.selectionEnd) return null;
    return { kind: "open", path: input.openable };
  }
  const separatorBeforeCaret =
    input.selectionStart === input.selectionEnd &&
    atEnd &&
    (input.machine.windows ? /[\\/]$/ : /\/$/).test(value);
  if (
    (key === "Backspace" && separatorBeforeCaret) ||
    (key === "ArrowLeft" && highlighted !== null)
  ) {
    if (highlighted !== null) {
      const row = rows[highlighted];
      const directory = row === undefined ? null : parentFolderOf(row.fullPath);
      if (directory === null) return null;
      return { kind: "parent", path: parentFolderOf(directory) ?? directory };
    }
    // Backspace at "~/", a root or a network share has nowhere to go; let it edit the text.
    const top = /^~[\\/]?$/.test(value) || /^[\\/]{2}[^\\/]+[\\/][^\\/]+[\\/]?$/.test(value);
    const parent = top ? null : parentFolderOf(value);
    return parent === null ? null : { kind: "parent", path: parent };
  }
  return null;
}

export const RECENT_FOLDERS_LIMIT = 5;

/** `added` goes first; the same folder is never listed twice. */
export function withRecentFolder(
  stored: readonly string[],
  added: string,
  limit = RECENT_FOLDERS_LIMIT,
): string[] {
  const path = added.trim();
  if (path.length === 0) return [...stored];
  return [path, ...stored.filter((entry) => !sameFolder(entry, path))].slice(0, limit);
}

export interface FolderChoiceState {
  /** What Enter and the primary button do. */
  readonly action: "add" | "create" | "open" | "none";
  /** The primary button's words. */
  readonly label: string;
  /** One line under the bar that says what the folder is. */
  readonly status: string;
  readonly tone: "plain" | "problem";
}

const nameOf = (path: string) =>
  path
    .replace(/[\\/]+$/, "")
    .split(/[\\/]/)
    .pop() || path;

/**
 * What the folder in the bar is, and what confirming it does. `folder` is the
 * listing of that folder when the machine has answered for it.
 */
export function folderChoiceState(input: {
  /** The folder the bar names, resolved; empty while nothing usable is typed. */
  readonly path: string;
  readonly machineLabel: string | null;
  readonly problem: string | null;
  readonly pending: boolean;
  /** exists: it was listed, or its parent lists it. missing: its parent, or the machine, says it is not there. */
  readonly found: "exists" | "missing" | "unreadable" | "unknown";
  readonly git: boolean;
  /** Folders inside it, when it was listed. */
  readonly childCount: number | null;
  readonly projects: readonly KnownProject[];
  readonly allowed: boolean;
  readonly notAllowedReason: string | null;
  readonly error: string | null;
}): FolderChoiceState {
  const on = input.machineLabel ? ` on ${input.machineLabel}` : "";
  const name = nameOf(input.path);
  if (input.path.trim().length === 0) {
    return {
      action: "none",
      label: "Add project",
      status: "Type or paste a folder path, or pick a folder below.",
      tone: "plain",
    };
  }
  if (input.problem !== null) {
    return { action: "none", label: "Add project", status: input.problem, tone: "problem" };
  }
  if (!input.allowed) {
    return {
      action: "none",
      label: "Add project",
      status: input.notAllowedReason ?? "This connection cannot add projects.",
      tone: "problem",
    };
  }
  const project = input.projects.find((entry) => sameFolder(entry.workspaceRoot, input.path));
  if (project !== undefined) {
    return {
      action: "open",
      label: "Open project",
      status: `${name} is already the project ${project.title}${on}. Enter opens it.`,
      tone: "plain",
    };
  }
  if (input.found === "unreadable") {
    return {
      action: "none",
      label: "Add project",
      status: `${input.machineLabel ?? "This machine"} does not allow reading ${input.path}. Choose another folder.`,
      tone: "problem",
    };
  }
  if (input.error !== null) {
    // The folders could not be listed, which says nothing about the folder itself:
    // the machine checks it again when it is added.
    const reason = /[.!?…]$/.test(input.error.trim())
      ? input.error.trim()
      : `${input.error.trim()}.`;
    return {
      action: "add",
      label: `Add ${name}`,
      status: `${reason} Enter still adds ${name}${on}.`,
      tone: "plain",
    };
  }
  if (input.pending || input.found === "unknown") {
    return {
      action: "add",
      label: `Add ${name}`,
      status: `Checking ${name}${on}…`,
      tone: "plain",
    };
  }
  if (input.found === "missing") {
    return {
      action: "create",
      label: "Create and add",
      status: `${name} is not there yet${on}. It is created and added as a project.`,
      tone: "plain",
    };
  }
  const detail = input.git
    ? `${name} is a Git repository${on}. It becomes the project.`
    : input.childCount === 0
      ? `No folders inside. ${name} itself becomes the project${on}.`
      : `${name} becomes the project${on}.`;
  return { action: "add", label: `Add ${name}`, status: detail, tone: "plain" };
}
