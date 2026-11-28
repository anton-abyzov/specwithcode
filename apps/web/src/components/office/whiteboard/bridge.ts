/**
 * The whiteboard editor runs in its own same-origin frame (`whiteboard.html`),
 * so every key pressed while drawing stays inside it: the app's shortcuts never
 * see Excalidraw's keys, and none of the app's window listeners can take
 * Excalidraw's. The host view hands the frame this object through a property
 * on the iframe element; the frame answers with its API.
 */

export type WhiteboardTheme = "light" | "dark";

export interface WhiteboardFrameApi {
  /** Replaces the scene, as after Reload latest. */
  readonly load: (text: string) => void;
  readonly setTheme: (theme: WhiteboardTheme) => void;
  readonly setViewOnly: (viewOnly: boolean) => void;
  /** The scene as Excalidraw saves it (`serializeAsJSON`, "local"). */
  readonly serialize: () => string;
  readonly exportPng: () => Promise<Blob>;
  readonly exportSvg: () => Promise<string>;
  readonly focus: () => void;
  /** Focuses the editor and hands it a key pressed outside it (undo, redo, select all). */
  readonly key: (key: WhiteboardKey) => void;
}

/** A key press, as `KeyboardEventInit` carries it across the frame. */
export interface WhiteboardKey {
  readonly key: string;
  readonly code: string;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
}

/**
 * The editor keys that still reach the drawing when focus sits outside its
 * frame, such as on the view's own toolbar: Cmd/Ctrl+Z, Shift+Z, Y and A.
 * Without this they would run the app's own shortcut (Cmd+Z undoes the last
 * thread action) or select the page's text.
 */
export function isWhiteboardEditorKey(event: WhiteboardKey): boolean {
  if (!(event.metaKey || event.ctrlKey) || event.altKey) return false;
  const key = event.key.toLowerCase();
  if (key === "z" || key === "a") return true;
  return key === "y" && !event.shiftKey;
}

export interface WhiteboardFrameHost {
  readonly text: string;
  readonly theme: WhiteboardTheme;
  readonly viewOnly: boolean;
  readonly onReady: (api: WhiteboardFrameApi) => void;
  /** A person changed the drawing; the host reads it with serialize() when it saves. */
  readonly onEdit: () => void;
  readonly onError: (message: string) => void;
}

export const WHITEBOARD_HOST_PROPERTY = "__specwithcodeWhiteboardHost";

export type WhiteboardFrameElement = HTMLIFrameElement & {
  [WHITEBOARD_HOST_PROPERTY]?: WhiteboardFrameHost;
};

/** Where the frame page is served: beside the app's own index.html. */
export function whiteboardFrameUrl(base: string = import.meta.env.BASE_URL ?? "/"): string {
  return `${base.replace(/\/+$/, "")}/whiteboard.html`;
}
