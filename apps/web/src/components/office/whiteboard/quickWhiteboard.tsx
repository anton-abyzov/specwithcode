/**
 * The quick way to whiteboards, from anywhere in the app. The `whiteboard.new`
 * shortcut (Cmd+Option+W on a Mac, Ctrl+Alt+W elsewhere) opens the palette's
 * Whiteboards picker: "New whiteboard" first, then the project's boards, newest
 * first, found by name or folder. The palette's root search finds boards by
 * name too.
 *
 * Both go to the project page with a one-shot request: `?new=whiteboard` makes
 * an empty `.excalidraw` file in the project's artifacts folder and opens it,
 * `?open=<path>` opens a board. The page drops the request from the URL, so a
 * reload or Back never makes a second board or opens one again.
 */
import {
  AuthFilesystemWriteScope,
  type EnvironmentId,
  type ProjectId,
  type ProjectLibrarySnapshot,
} from "@specweave-studio/contracts";
import { isWhiteboardPath } from "@specweave-studio/shared/officeWhiteboard";
import { useAtomValue } from "@effect/atom-react";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { type ReactNode, useEffect, useMemo, useRef } from "react";

import { openCommandPalette } from "../../../commandPaletteBus";
import { resolveShortcutCommand } from "../../../keybindings";
import { isTerminalFocused } from "../../../lib/terminalFocus";
import { useEnvironmentQuery } from "../../../state/query";
import { primaryServerKeybindingsAtom } from "../../../state/server";
import { useEnvironmentScopeAccess } from "../../../state/session";
import type { ProjectArtifact } from "../../../studio/projectArtifacts";
import { parseProjectWorkspaceSearch } from "../../../studio/projectPaneThreads";
import { projectWorkspace } from "../../../studio/projectWorkspace";
import { useArtifactOpener } from "../../studio/shell/ProjectArtifactShelf";
import { toastManager } from "../../ui/toast";
import { useCreateWhiteboard } from "./newWhiteboard";

/** Words that find "New whiteboard" in the palette. */
export const NEW_WHITEBOARD_TERMS = [
  "whiteboard",
  "excalidraw",
  "diagram",
  "draw",
  "drawing",
  "sketch",
  "board",
  "canvas",
] as const;

/** Words that also list "New whiteboard in <project>" for every project; "board" is the SpecWeave Board's. */
const OTHER_PROJECT_TERMS = ["whiteboard", "excalidraw", "diagram", "sketch", "draw"] as const;

/** Whether a palette query asks for a whiteboard, so each project's own entry is offered. */
export function asksForWhiteboard(query: string): boolean {
  return query
    .trim()
    .toLowerCase()
    .replace(/^>\s*/, "")
    .split(/\s+/)
    .some(
      (word) =>
        word.length >= 3 &&
        OTHER_PROJECT_TERMS.some((term) => term.startsWith(word) || word.startsWith(term)),
    );
}

/** The navigation that makes and opens a new whiteboard in a project. */
export function newWhiteboardDestination(projectKey: string) {
  return {
    to: "/projects/$projectKey",
    params: { projectKey },
    search: (previous: Record<string, unknown>) => ({ ...previous, new: "whiteboard" as const }),
  } as const;
}

/** The navigation that opens one of a project's whiteboards. */
export function openWhiteboardDestination(projectKey: string, path: string) {
  return {
    to: "/projects/$projectKey",
    params: { projectKey },
    search: (previous: Record<string, unknown>) => {
      const { new: _new, ...rest } = previous;
      return { ...rest, open: path };
    },
  } as const;
}

/** A whiteboard file the project lists, for the picker and the palette's search. */
export interface WhiteboardEntry {
  /** Project-relative, with `/` separators. */
  readonly path: string;
  readonly name: string;
  /** The folder it sits in below `.specweave/artifacts/`, or its folder elsewhere; null at the top. */
  readonly folder: string | null;
  readonly modifiedAt: number;
}

const ARTIFACTS_FOLDER = ".specweave/artifacts/";

/** The project's whiteboards in a Library snapshot, newest first. Older servers list none. */
export function whiteboardsInLibrary(
  library: ProjectLibrarySnapshot | null | undefined,
): ReadonlyArray<WhiteboardEntry> {
  const entries: WhiteboardEntry[] = [];
  for (const output of library?.outputs ?? []) {
    if (!isWhiteboardPath(output.path)) continue;
    const slash = output.path.lastIndexOf("/");
    const directory = slash < 0 ? "" : output.path.slice(0, slash + 1);
    const folder = directory.startsWith(ARTIFACTS_FOLDER)
      ? directory.slice(ARTIFACTS_FOLDER.length, -1)
      : directory.slice(0, -1);
    const modifiedAt = Date.parse(output.modifiedAt);
    entries.push({
      path: output.path,
      name: output.path.slice(slash + 1),
      folder: folder === "" ? null : folder,
      modifiedAt: Number.isNaN(modifiedAt) ? 0 : modifiedAt,
    });
  }
  return entries.toSorted((a, b) => b.modifiedAt - a.modifiedAt);
}

const NO_WHITEBOARDS: ReadonlyArray<WhiteboardEntry> = [];

/** The whiteboards of one project on one machine, from the same snapshot its page reads. */
export function useProjectWhiteboards(
  target: { readonly environmentId: EnvironmentId; readonly projectId: ProjectId } | null,
): ReadonlyArray<WhiteboardEntry> {
  const query = useEnvironmentQuery(
    target === null
      ? null
      : projectWorkspace.library({
          environmentId: target.environmentId,
          input: { projectId: target.projectId },
        }),
  );
  const library = query.data ?? null;
  return useMemo(
    () => (library === null ? NO_WHITEBOARDS : whiteboardsInLibrary(library)),
    [library],
  );
}

/** Words a board is found by: its name in words, its folder, and what it is. */
export function whiteboardSearchTerms(entry: WhiteboardEntry): string[] {
  const stem = entry.name.replace(/\.excalidraw$/i, "");
  return [
    stem,
    stem.replace(/[-_.]+/g, " "),
    ...(entry.folder === null ? [] : [entry.folder, entry.folder.replace(/[/_-]+/g, " ")]),
    "whiteboard",
    "excalidraw",
    "board",
    "open",
  ];
}

/** Listens for the `whiteboard.new` shortcut anywhere in the app: it opens the Whiteboards picker. */
export function useWhiteboardShortcut(): void {
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const command = resolveShortcutCommand(event, keybindings, {
        context: { terminalFocus: isTerminalFocused() },
      });
      if (command !== "whiteboard.new") return;
      event.preventDefault();
      event.stopPropagation();
      // A held key repeats; one press makes one board.
      if (event.repeat) return;
      openCommandPalette({ open: "whiteboards" });
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [keybindings]);
}

/**
 * Takes a project page's one-shot whiteboard request once. `?new=whiteboard`
 * waits until this window's write access is known, makes the board and opens
 * it; without write access it says why and makes nothing. `?open=<path>` waits
 * for the project's artifacts and opens that board, with Previous and Next
 * stepping through the project's other boards. Returns the editor overlay.
 */
export function useWhiteboardDeepLink(input: {
  readonly environmentId: EnvironmentId;
  readonly workspaceRoot: string;
  readonly artifacts: ReadonlyArray<ProjectArtifact>;
  readonly loaded: boolean;
  /** Rereads the project's artifacts, so a new board is listed at once. */
  readonly onCreated?: () => void;
}): ReactNode {
  const { environmentId, workspaceRoot, artifacts, loaded } = input;
  const request = useSearch({
    strict: false,
    select: (search) => {
      const parsed = parseProjectWorkspaceSearch(search as Record<string, unknown>);
      return parsed.new === "whiteboard" ? "new" : (parsed.open ?? null);
    },
  });
  const navigate = useNavigate();
  const access = useEnvironmentScopeAccess(environmentId, AuthFilesystemWriteScope);
  const whiteboards = useCreateWhiteboard(environmentId, workspaceRoot);
  const opener = useArtifactOpener(environmentId, workspaceRoot);
  const taken = useRef<string | null>(null);
  const createdRef = useRef(input.onCreated);
  createdRef.current = input.onCreated;
  const { create } = whiteboards;
  const { open, openPath } = opener;
  useEffect(() => {
    if (request === null) {
      taken.current = null;
      return;
    }
    if (taken.current === request) return;
    if (request === "new" ? access === "unknown" : !loaded) return;
    taken.current = request;
    void navigate({
      to: ".",
      search: ({ new: _new, open: _open, ...rest }: Record<string, unknown>) => rest,
      replace: true,
    } as never);
    if (request !== "new") {
      const boards = artifacts.filter(
        (artifact) => artifact.kind === "whiteboard" && artifact.root === null,
      );
      const board = boards.find((artifact) => artifact.path === request);
      if (board) open(board, boards);
      else openPath(request, request.split("/").pop() ?? request);
      return;
    }
    if (access !== "granted") {
      toastManager.add({
        type: "error",
        title: "Could not create whiteboard",
        description:
          access === "signed-out"
            ? "This browser is signed out of this machine. Reload the page to sign in again."
            : "This window may not change files on this machine.",
      });
      return;
    }
    void create().then((path) => {
      if (path === null) return;
      openPath(path, path.split("/").pop() ?? path);
      createdRef.current?.();
    });
  }, [access, artifacts, create, loaded, navigate, open, openPath, request]);
  return opener.viewer;
}
