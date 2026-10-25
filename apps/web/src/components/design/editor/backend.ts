import type {
  DesignAddress,
  DesignDocument,
  DesignExportInput,
  DesignExportResult,
  DesignHistoryEntry,
  DesignSystem,
  DesignSystemSummary,
  DesignThreadBinding,
  EnvironmentId,
  ProjectId,
  ThreadId,
} from "@specweave-studio/contracts";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { ProjectFaviconProject } from "../../ProjectFavicon";
import type { CopyOptions, CopyOutcome } from "../systems/DesignSystemPicker";
import type { OwnerProject } from "../systems/reviewModel";
import { DesignSession, type DesignCloseOutcome, type DesignTransport } from "./designSession";

/**
 * What the editor needs from the app. The route builds it from the `design`
 * atoms and thread commands; the headless fixture builds it in memory. Keeping
 * this narrow is what lets the same editor run in both.
 */
export interface DesignImage {
  readonly name: string;
  readonly mimeType: string;
  readonly dataUrl: string;
  readonly sizeBytes: number;
}

export interface DesignMessage {
  readonly text: string;
  readonly images: readonly DesignImage[];
}

export interface DesignExportRequest {
  readonly pageId: string;
  readonly frameId?: string;
  /** `svg` only when the server advertises it (`DesignEditorBackend.svgExport`). */
  readonly format: DesignExportInput["format"];
  readonly scale?: 1 | 2;
  /** Design-system mode to render in; the editor passes the canvas mode. */
  readonly mode?: string;
}

export interface DesignCodingThread {
  readonly binding: DesignThreadBinding;
  readonly title: string;
}

export interface DesignMachine {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  /** Linked here, so its threads can be opened from this app. */
  readonly linked: boolean;
}

/** The project that owns a design, for links back to it. */
export interface DesignOwnerProject {
  readonly projectId: ProjectId;
  readonly label: string;
  /** The `/projects/$projectKey` workspace, when this window has the project. */
  readonly projectKey: string | null;
  /** The project record its sidebar icon is drawn from. */
  readonly icon: ProjectFaviconProject | null;
}

export interface DesignShareInfo {
  readonly ownerLabel: string;
  /** Null for a Playground design. */
  readonly ownerProject?: DesignOwnerProject | null;
  readonly thisMachine: string;
  /** The owner's other paired devices (phones, browsers). */
  readonly devices: readonly string[];
  /** Linked machines that can reach this design. */
  readonly machines: readonly string[];
  /** Absolute app URL of this design. */
  readonly link: string;
}

/** What the header's design-system picker offers. */
export interface DesignSystemChoices {
  /** Every system the design's machine can read; null while loading. */
  readonly systems: readonly DesignSystemSummary[] | null;
  readonly projects: readonly OwnerProject[];
  /** Copies another owner's system into the design's owner; designs never reference across owners. */
  readonly copy: (system: DesignSystemSummary, options?: CopyOptions) => Promise<CopyOutcome>;
}

/** Version history through `design.history`, `design.saveVersion` and `design.restore`. */
export interface DesignVersions {
  /** Named versions and kept autosaves, as the server lists them. */
  readonly list: () => Promise<readonly DesignHistoryEntry[]>;
  /** Names the saved head; returns the history after the save. */
  readonly save: (name: string) => Promise<readonly DesignHistoryEntry[]>;
  /** Puts `revision`'s content back as a new revision on top of `expectedRevision`. */
  readonly restore: (revision: number, expectedRevision: number) => Promise<DesignDocument>;
}

export interface DesignEditorBackend {
  readonly environmentId: EnvironmentId;
  readonly address: DesignAddress;
  readonly transport: DesignTransport;
  readonly exportFile: (request: DesignExportRequest) => Promise<DesignExportResult>;
  /** Uploads image bytes (base64) and returns the asset file name. */
  readonly assetPut: (mimeType: string, base64: string) => Promise<string>;
  readonly sendToThread: (thread: DesignThreadBinding, message: DesignMessage) => Promise<void>;
  /** A new thread id, so the design can be bound before its thread starts. */
  readonly newThreadId: () => ThreadId;
  /**
   * Starts the design's agent thread on this machine as `threadId`, optionally
   * with a first message. With `selfBind` the brief asks the agent to bind the
   * thread to the design itself, because this window was not allowed to.
   */
  readonly startThread: (
    first: DesignMessage | null,
    options: { readonly threadId: ThreadId; readonly selfBind: boolean },
  ) => Promise<DesignThreadBinding>;
  /** Coding threads of the design's project that can receive "Implement this frame". */
  readonly codingThreads: readonly DesignCodingThread[];
  /**
   * Starts a new coding thread in the design's project with the frame as its
   * first message. Without a ready provider the thread is created with no turn
   * and the message waits in its composer: then `waiting` is true.
   */
  readonly startCodingThread:
    | ((
        message: DesignMessage,
        title: string,
      ) => Promise<DesignThreadBinding & { readonly waiting?: boolean }>)
    | null;
  readonly openThread: (thread: DesignThreadBinding) => void;
  readonly machine: (environmentId: EnvironmentId) => DesignMachine | null;
  readonly share: DesignShareInfo;
  readonly designSystems: DesignSystemChoices;
  /**
   * The owner on this machine, or a member (a paired device, a linked machine,
   * a session without access rights), as the server reports it.
   */
  readonly audience: "owner" | "member";
  /**
   * Opens "Connect to a project" for a Playground design; `current` reads the
   * saved document when Move is pressed. Absent where the design cannot move:
   * a project design, an older server, or a window that is not the owner's.
   */
  readonly connectToProject?: ((current: () => DesignDocument) => void) | null;
  /** Version history; absent where the window has no history access. */
  readonly versions?: DesignVersions | null;
  /** False when no provider on the design's machine can start a turn; absent when unknown. */
  readonly providerReady?: boolean;
  /**
   * Whether a thread has messages or runs, from its shell; undefined while the
   * shell is not loaded. Absent backends never claim a thread has not started.
   */
  readonly threadStarted?: (thread: DesignThreadBinding) => boolean | undefined;
  /** The server threads replies (`designCommentReplies`); absent on older servers, which hide Reply. */
  readonly commentReplies?: boolean;
  /** The server writes SVG (`designSvgExport`); absent on older servers, which keep PNG, HTML and PDF. */
  readonly svgExport?: boolean;
}

export interface DesignEditorData {
  readonly initial: DesignDocument;
  /** Latest document from `design.watch`; null until the stream delivers. */
  readonly live: DesignDocument | null;
  readonly system: DesignSystem | null;
  readonly assetUrl: (asset: string) => string;
}

/**
 * The open design's session. It outlives the component: on unmount it
 * finishes the save in flight and saves what is left, and `onUnsaved` reports
 * a final conflict or error so the edits are not lost silently. Mount and
 * unmount are symmetric (open/close), so React StrictMode's extra cycle
 * leaves autosave running.
 */
export type DesignUnsavedOutcome = Extract<DesignCloseOutcome, { kind: "conflict" | "error" }>;

/**
 * Sessions that closed with edits the server has not taken (a conflict or an
 * error). Opening the same design again adopts the session, so the edits and
 * the conflict banner come back instead of being lost.
 */
const unsavedSessions = new Map<string, DesignSession>();

export function useDesignSession(
  sessionKey: string,
  initial: DesignDocument,
  transport: DesignTransport,
  live: DesignDocument | null,
  onUnsaved?: (outcome: DesignUnsavedOutcome) => void,
) {
  const [session] = useState(() => {
    const kept = unsavedSessions.get(sessionKey);
    unsavedSessions.delete(sessionKey);
    return kept ?? new DesignSession(initial, transport);
  });
  const onUnsavedRef = useRef(onUnsaved);
  useEffect(() => {
    onUnsavedRef.current = onUnsaved;
  }, [onUnsaved]);
  useEffect(() => {
    session.open();
    unsavedSessions.delete(sessionKey);
    return () => {
      void session.close().then((outcome) => {
        if (outcome.kind !== "conflict" && outcome.kind !== "error") return;
        unsavedSessions.set(sessionKey, session);
        onUnsavedRef.current?.(outcome);
      });
    };
  }, [session, sessionKey]);
  useEffect(() => {
    if (live !== null) session.receive(live);
  }, [live, session]);
  const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot);
  useEffect(() => {
    if (snapshot.saveState === "saved") return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      void session.flush();
      event.preventDefault();
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [session, snapshot.saveState]);
  return { session, snapshot };
}

export function base64ToBlob(data: string, mimeType: string): Blob {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mimeType });
}

export function downloadExport(result: DesignExportResult) {
  const url = URL.createObjectURL(base64ToBlob(result.data, result.mimeType));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = result.fileName;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

export function exportAsImage(result: DesignExportResult, name: string): DesignImage {
  return {
    name,
    mimeType: result.mimeType,
    dataUrl: `data:${result.mimeType};base64,${result.data}`,
    sizeBytes: Math.floor((result.data.length * 3) / 4),
  };
}

/** The PNG cropped to `rect` (in export pixels at scale 1), as a thread attachment. */
export async function cropExportImage(
  result: DesignExportResult,
  rect: { x: number; y: number; width: number; height: number },
  name: string,
): Promise<DesignImage> {
  const bitmap = await createImageBitmap(base64ToBlob(result.data, result.mimeType));
  const scale = result.width > 0 ? bitmap.width / result.width : 1;
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(rect.width * scale));
  canvas.height = Math.max(1, Math.round(rect.height * scale));
  const context = canvas.getContext("2d");
  if (context === null) return exportAsImage(result, name);
  context.drawImage(
    bitmap,
    rect.x * scale,
    rect.y * scale,
    rect.width * scale,
    rect.height * scale,
    0,
    0,
    canvas.width,
    canvas.height,
  );
  bitmap.close();
  const dataUrl = canvas.toDataURL("image/png");
  const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
  return { name, mimeType: "image/png", dataUrl, sizeBytes: Math.floor((base64.length * 3) / 4) };
}

export function readFileBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const value = String(reader.result);
      resolve(value.slice(value.indexOf(",") + 1));
    };
    reader.onerror = () => reject(reader.error ?? new Error("The file could not be read."));
    reader.readAsDataURL(file);
  });
}

export function imageSize(file: File): Promise<{ width: number; height: number }> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      resolve({ width: image.naturalWidth || 400, height: image.naturalHeight || 300 });
      URL.revokeObjectURL(url);
    };
    image.onerror = () => {
      resolve({ width: 400, height: 300 });
      URL.revokeObjectURL(url);
    };
    image.src = url;
  });
}
