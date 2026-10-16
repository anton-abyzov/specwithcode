// @effect-diagnostics nodeBuiltinImport:off -- Checks a path synchronously inside the native drag IPC handler.
import * as NodeFs from "node:fs";
import * as NodePath from "node:path";

import * as Electron from "electron";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as DesktopIpc from "../DesktopIpc.ts";
import { START_FILE_DRAG_CHANNEL } from "../channels.ts";

const FileDragInput = Schema.Struct({
  path: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096)),
});

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"]);
// macOS refuses a drag without an image; a neutral 16x16 tile stands in for
// files that have no picture of their own.
const FALLBACK_ICON_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAGUlEQVR4nGPo6p/xnxLMMGrAqAGjBgwXAwAh67Af9Im5ywAAAABJRU5ErkJggg==";

/** Whether `path` names a regular file the user may drag out of the app. */
export function isDraggableFilePath(
  path: string,
  stat: (path: string) => { isFile(): boolean } | undefined = (target) =>
    NodeFs.statSync(target, { throwIfNoEntry: false }),
): boolean {
  if (!NodePath.isAbsolute(path) || path.includes("\0")) return false;
  try {
    return stat(path)?.isFile() === true;
  } catch {
    return false;
  }
}

function dragIcon(path: string): Electron.NativeImage {
  if (IMAGE_EXTENSIONS.has(NodePath.extname(path).toLowerCase())) {
    const image = Electron.nativeImage.createFromPath(path);
    if (!image.isEmpty()) return image.resize({ width: 64 });
  }
  return Electron.nativeImage.createFromDataURL(FALLBACK_ICON_DATA_URL);
}

/**
 * Starts a native drag of a file named in chat, so it drops into a browser's
 * upload field, Finder or another app as the file itself.
 */
export const startFileDrag = DesktopIpc.makeIpcMethod({
  channel: START_FILE_DRAG_CHANNEL,
  payload: FileDragInput,
  result: Schema.Boolean,
  handler: ({ path }, event) =>
    Effect.sync(() => {
      if (event === undefined || !isDraggableFilePath(path)) return false;
      const contents = Electron.webContents.fromId(event.sender.id);
      if (contents === undefined || contents.isDestroyed()) return false;
      contents.startDrag({ file: path, icon: dragIcon(path) });
      return true;
    }),
});
