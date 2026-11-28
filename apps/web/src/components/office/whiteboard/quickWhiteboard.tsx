/**
 * The quick way to a new whiteboard, from anywhere in the app: the
 * `whiteboard.new` shortcut (Cmd+Option+W on a Mac, Ctrl+Alt+W elsewhere) and
 * the command palette's "New whiteboard". Both go to the project page with
 * `?new=whiteboard`, which makes an empty `.excalidraw` file in the project's
 * artifacts folder and opens it in the editor, then drops the request from
 * the URL, so a reload or Back never makes a second board.
 *
 * Outside a project page the shortcut opens the palette on "New whiteboard",
 * which offers the project in context first and every other project after it.
 */
import { AuthFilesystemWriteScope, type EnvironmentId } from "@specweave-studio/contracts";
import { useAtomValue } from "@effect/atom-react";
import { useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { type ReactNode, useEffect, useRef } from "react";

import { openCommandPalette } from "../../../commandPaletteBus";
import { resolveShortcutCommand } from "../../../keybindings";
import { isTerminalFocused } from "../../../lib/terminalFocus";
import { primaryServerKeybindingsAtom } from "../../../state/server";
import { useEnvironmentScopeAccess } from "../../../state/session";
import { parseProjectWorkspaceSearch } from "../../../studio/projectPaneThreads";
import { useArtifactOpener } from "../../studio/shell/ProjectArtifactShelf";
import { toastManager } from "../../ui/toast";
import { useCreateWhiteboard } from "./newWhiteboard";

/** What the palette searches for when the shortcut has no project to use. */
export const NEW_WHITEBOARD_QUERY = "New whiteboard";

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

/** Listens for the `whiteboard.new` shortcut anywhere in the app. */
export function useNewWhiteboardShortcut(): void {
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const navigate = useNavigate();
  const projectKey = useParams({ strict: false, select: (params) => params.projectKey ?? null });
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
      if (projectKey === null) openCommandPalette({ query: NEW_WHITEBOARD_QUERY });
      else void navigate(newWhiteboardDestination(projectKey) as never);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [keybindings, navigate, projectKey]);
}

/**
 * Takes a project page's `?new=whiteboard` once: waits until this window's
 * write access is known, makes the board and opens it. Without write access
 * it says why and makes nothing. Returns the editor overlay to render.
 */
export function useNewWhiteboardDeepLink(
  environmentId: EnvironmentId,
  workspaceRoot: string,
  /** Rereads the project's artifacts, so the new board is listed at once. */
  onCreated?: () => void,
): ReactNode {
  const requested = useSearch({
    strict: false,
    select: (search) =>
      parseProjectWorkspaceSearch(search as Record<string, unknown>).new === "whiteboard",
  });
  const navigate = useNavigate();
  const access = useEnvironmentScopeAccess(environmentId, AuthFilesystemWriteScope);
  const whiteboards = useCreateWhiteboard(environmentId, workspaceRoot);
  const opener = useArtifactOpener(environmentId, workspaceRoot);
  const taken = useRef(false);
  const createdRef = useRef(onCreated);
  createdRef.current = onCreated;
  const { create } = whiteboards;
  const { openPath } = opener;
  useEffect(() => {
    if (!requested) {
      taken.current = false;
      return;
    }
    if (taken.current || access === "unknown") return;
    taken.current = true;
    void navigate({
      to: ".",
      search: ({ new: _new, ...rest }: Record<string, unknown>) => rest,
      replace: true,
    } as never);
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
  }, [access, create, navigate, openPath, requested]);
  return opener.viewer;
}
