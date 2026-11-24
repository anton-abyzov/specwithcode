/**
 * Whiteboards are plain `.excalidraw` files: the JSON excalidraw.com saves.
 * The app reads them as data only. Nothing in a file is executed, a link on an
 * element is never followed, and an image is shown only when the file itself
 * carries it as a `data:image/...` URL.
 */
import { OFFICE_ARTIFACTS_DIR, sheetContentRevision, sheetSlug } from "./officeSheet/model.ts";

export const WHITEBOARD_SUFFIX = ".excalidraw";
export const WHITEBOARD_DIR = OFFICE_ARTIFACTS_DIR;
export const WHITEBOARD_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,59}$/;
export const WHITEBOARD_LIMITS = {
  /** Images make whiteboards large; one file holds at most this many bytes. */
  bytes: 16 * 1024 * 1024,
  elements: 20_000,
} as const;

/** True for a path the whiteboard editor opens. */
export function isWhiteboardPath(path: string): boolean {
  return path.toLowerCase().endsWith(WHITEBOARD_SUFFIX);
}

/** A file name stem from a title, as sheets make theirs. */
export function whiteboardSlug(title: string): string {
  const slug = sheetSlug(title);
  return slug === "sheet" ? "whiteboard" : slug;
}

/** The same revision token sheets use, so one compare-and-set path serves both. */
export function whiteboardRevision(raw: string): string {
  return sheetContentRevision(raw);
}

const SAFE_IMAGE_DATA_URL = /^data:image\/(?:png|jpeg|jpg|gif|webp|bmp|x-icon|avif);base64,[A-Za-z0-9+/=\s]*$/;
const SVG_DATA_URL = /^data:image\/svg\+xml(?:;[^,]*)?,/;

/**
 * A file entry's image is shown only when it is a data URL of a raster image,
 * or an SVG data URL (Excalidraw draws an SVG image through an <img>, where
 * scripts never run).
 */
export function isSafeWhiteboardImage(dataURL: unknown): boolean {
  return (
    typeof dataURL === "string" &&
    (SAFE_IMAGE_DATA_URL.test(dataURL) || SVG_DATA_URL.test(dataURL))
  );
}

export interface WhiteboardFile {
  /** Every top-level field of the file, kept as read so a save keeps the ones the app does not use. */
  readonly raw: Record<string, unknown>;
  readonly elements: ReadonlyArray<Record<string, unknown>>;
  readonly appState: Record<string, unknown>;
  /** Images the editor may show. */
  readonly files: Record<string, Record<string, unknown>>;
  /** Entries left out because they are not data URLs of images; a save keeps them. */
  readonly heldFiles: Record<string, unknown>;
}

export type WhiteboardParse =
  | { readonly ok: true; readonly file: WhiteboardFile }
  | { readonly ok: false; readonly error: string };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** An empty whiteboard, as excalidraw.com saves one. */
export function emptyWhiteboardText(options: { readonly source?: string } = {}): string {
  return `${JSON.stringify(
    {
      type: "excalidraw",
      version: 2,
      source: options.source ?? "https://excalidraw.com",
      elements: [],
      appState: { gridSize: 20, gridStep: 5, gridModeEnabled: false, viewBackgroundColor: "#ffffff" },
      files: {},
    },
    null,
    2,
  )}\n`;
}

/** Reads a `.excalidraw` file. An empty file reads as an empty whiteboard. */
export function parseWhiteboard(text: string): WhiteboardParse {
  const trimmed = text.replace(/^﻿+/, "").trim();
  if (trimmed.length === 0) {
    return parseWhiteboard(emptyWhiteboardText());
  }
  let data: unknown;
  try {
    data = JSON.parse(trimmed);
  } catch {
    return { ok: false, error: "This file is not valid JSON." };
  }
  if (!isRecord(data)) return { ok: false, error: "This file is not an Excalidraw drawing." };
  if (data.type !== undefined && data.type !== "excalidraw") {
    return {
      ok: false,
      error:
        data.type === "excalidrawlib"
          ? "This is an Excalidraw library, not a drawing."
          : "This file is not an Excalidraw drawing.",
    };
  }
  const elements = data.elements === undefined ? [] : data.elements;
  if (!Array.isArray(elements)) return { ok: false, error: "The drawing's elements are not a list." };
  if (elements.length > WHITEBOARD_LIMITS.elements) {
    return {
      ok: false,
      error: `The drawing has more than ${WHITEBOARD_LIMITS.elements.toLocaleString("en-US")} elements.`,
    };
  }
  const files: Record<string, Record<string, unknown>> = {};
  const heldFiles: Record<string, unknown> = {};
  if (isRecord(data.files)) {
    for (const [id, entry] of Object.entries(data.files)) {
      if (isRecord(entry) && isSafeWhiteboardImage(entry.dataURL)) files[id] = entry;
      else heldFiles[id] = entry;
    }
  }
  return {
    ok: true,
    file: {
      raw: data,
      elements: elements.filter(isRecord),
      appState: isRecord(data.appState) ? data.appState : {},
      files,
      heldFiles,
    },
  };
}

/**
 * The text to save: Excalidraw's own serialized JSON, with the top-level
 * fields and image entries the editor did not load put back, so a file from
 * excalidraw.com or another tool keeps everything it had.
 */
export function mergeWhiteboardSave(serialized: string, previous: WhiteboardFile | null): string {
  if (previous === null) return serialized;
  const extraKeys = Object.keys(previous.raw).filter(
    (key) => !["type", "version", "source", "elements", "appState", "files"].includes(key),
  );
  if (extraKeys.length === 0 && Object.keys(previous.heldFiles).length === 0) return serialized;
  const saved = JSON.parse(serialized) as Record<string, unknown>;
  for (const key of extraKeys) if (!(key in saved)) saved[key] = previous.raw[key];
  saved.files = { ...previous.heldFiles, ...(isRecord(saved.files) ? saved.files : {}) };
  return JSON.stringify(saved, null, 2);
}

export interface WhiteboardSummaryElement {
  readonly id: string;
  readonly type: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly label?: string;
  readonly text?: string;
  readonly from?: string;
  readonly to?: string;
}

/** Each live element with its label (bound text) and arrow ends, for an agent to read. */
export function summarizeWhiteboard(file: WhiteboardFile): WhiteboardSummaryElement[] {
  const live = file.elements.filter((element) => element.isDeleted !== true);
  const labels = new Map<string, string>();
  for (const element of live) {
    if (element.type === "text" && typeof element.containerId === "string") {
      labels.set(element.containerId, String(element.text ?? element.originalText ?? ""));
    }
  }
  const out: WhiteboardSummaryElement[] = [];
  for (const element of live) {
    if (typeof element.id !== "string" || typeof element.type !== "string") continue;
    if (element.type === "text" && typeof element.containerId === "string") continue;
    const number = (value: unknown) =>
      typeof value === "number" && Number.isFinite(value) ? Math.round(value * 100) / 100 : 0;
    const binding = (value: unknown) =>
      isRecord(value) && typeof value.elementId === "string" ? value.elementId : undefined;
    const label = labels.get(element.id);
    const from = binding(element.startBinding);
    const to = binding(element.endBinding);
    out.push({
      id: element.id,
      type: element.type,
      x: number(element.x),
      y: number(element.y),
      width: number(element.width),
      height: number(element.height),
      ...(label !== undefined ? { label } : {}),
      ...(element.type === "text" ? { text: String(element.text ?? "") } : {}),
      ...(from !== undefined ? { from } : {}),
      ...(to !== undefined ? { to } : {}),
    });
  }
  return out;
}
