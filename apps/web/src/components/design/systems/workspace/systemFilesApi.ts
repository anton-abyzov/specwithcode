/**
 * One design system's stored files over the `designSystem.files*` RPCs, as a
 * small interface the Files layer, Assets and the README share. Views take
 * the interface, so tests drive them with a fake.
 */
import { RegistryContext } from "@effect/atom-react";
import {
  executeAtomQuery,
  squashAtomCommandFailure,
} from "@specweave-studio/client-runtime/state/runtime";
import type {
  DesignOwnerInput,
  DesignSystemFile,
  DesignSystemFileReadResult,
  DesignSystemFilesResult,
  DesignSystemId,
  EnvironmentId,
} from "@specweave-studio/contracts";
import { useCallback, useContext, useMemo } from "react";

import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { design } from "~/studio/design";

import { fileName } from "./filesModel";
import { editFailureText } from "./useSystemEdits";

export type FileOutcome<A> =
  | { readonly ok: true; readonly value: A }
  | { readonly ok: false; readonly message: string };

export interface SystemFilesListing {
  readonly data: DesignSystemFilesResult | null;
  readonly error: string | null;
  readonly isPending: boolean;
  readonly refresh: () => void;
}

export interface SystemFilesApi {
  readonly listing: SystemFilesListing;
  /** Reads a stored file or a recorded source, always fresh. */
  readonly read: (file: {
    readonly origin: DesignSystemFile["origin"];
    readonly path: string;
  }) => Promise<FileOutcome<DesignSystemFileReadResult>>;
  /** Writes or replaces a stored file from base64 bytes. */
  readonly put: (path: string, base64: string) => Promise<FileOutcome<DesignSystemFile>>;
  readonly remove: (path: string) => Promise<FileOutcome<null>>;
  readonly move: (from: string, to: string) => Promise<FileOutcome<DesignSystemFile>>;
}

export interface SystemAddress {
  readonly environmentId: EnvironmentId;
  readonly owner: DesignOwnerInput;
  readonly systemId: DesignSystemId;
}

/** `{ owner, systemId }` in one key order, so every part of the page shares one query. */
function useAddressInput(owner: DesignOwnerInput, systemId: DesignSystemId) {
  const projectId = owner.kind === "project" ? owner.projectId : null;
  return useMemo(
    () => ({
      owner:
        projectId === null
          ? ({ kind: "playground" } as const)
          : ({ kind: "project", projectId } as const),
      systemId,
    }),
    [projectId, systemId],
  );
}

/** The system's name, from the same query the page reads; empty until it loads. */
export function useSystemName({ environmentId, owner, systemId }: SystemAddress): string {
  const input = useAddressInput(owner, systemId);
  const system = useEnvironmentQuery(design.systemGet({ environmentId, input }));
  return system.data?.system.name ?? "";
}

export function useSystemFilesApi({ environmentId, owner, systemId }: SystemAddress) {
  const registry = useContext(RegistryContext);
  const input = useAddressInput(owner, systemId);
  const query = useEnvironmentQuery(design.systemFiles({ environmentId, input }));
  const putFile = useAtomCommand(design.systemFilePut, { reportFailure: false });
  const deleteFile = useAtomCommand(design.systemFileDelete, { reportFailure: false });
  const moveFile = useAtomCommand(design.systemFileMove, { reportFailure: false });
  const refresh = query.refresh;

  const read = useCallback<SystemFilesApi["read"]>(
    async (file) => {
      const result = await executeAtomQuery(
        registry,
        design.systemFileRead({
          environmentId,
          input: { ...input, origin: file.origin, path: file.path },
        }),
        { refresh: true, reportFailure: false },
      );
      return result._tag === "Success"
        ? { ok: true, value: result.value }
        : {
            ok: false,
            message: editFailureText(
              squashAtomCommandFailure(result),
              `${fileName(file.path)} could not be read.`,
            ),
          };
    },
    [environmentId, input, registry],
  );

  const put = useCallback<SystemFilesApi["put"]>(
    async (path, data) => {
      const result = await putFile({ environmentId, input: { ...input, path, data } });
      return result._tag === "Success"
        ? { ok: true, value: result.value.file }
        : {
            ok: false,
            message: editFailureText(
              squashAtomCommandFailure(result),
              `${fileName(path)} was not saved.`,
            ),
          };
    },
    [environmentId, input, putFile],
  );

  const remove = useCallback<SystemFilesApi["remove"]>(
    async (path) => {
      const result = await deleteFile({ environmentId, input: { ...input, path } });
      return result._tag === "Success"
        ? { ok: true, value: null }
        : {
            ok: false,
            message: editFailureText(
              squashAtomCommandFailure(result),
              `${fileName(path)} was not deleted.`,
            ),
          };
    },
    [deleteFile, environmentId, input],
  );

  const move = useCallback<SystemFilesApi["move"]>(
    async (from, to) => {
      const result = await moveFile({ environmentId, input: { ...input, from, to } });
      return result._tag === "Success"
        ? { ok: true, value: result.value.file }
        : {
            ok: false,
            message: editFailureText(
              squashAtomCommandFailure(result),
              `${fileName(from)} was not moved.`,
            ),
          };
    },
    [environmentId, input, moveFile],
  );

  return useMemo<SystemFilesApi>(
    () => ({
      listing: {
        data: query.data,
        error: query.error ?? (query.failure === null ? null : "Couldn't list the files."),
        isPending: query.isPending,
        refresh,
      },
      read,
      put,
      remove,
      move,
    }),
    [move, put, query.data, query.error, query.failure, query.isPending, read, refresh, remove],
  );
}

// ---------------------------------------------------------------------------
// Bytes
// ---------------------------------------------------------------------------

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
}

export function base64ToBytes(data: string): Uint8Array<ArrayBuffer> {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export const textToBase64 = (text: string) => bytesToBase64(new TextEncoder().encode(text));

/** The bytes of a read, whichever encoding the server chose. */
export function readBytes(result: Pick<DesignSystemFileReadResult, "encoding" | "data">) {
  return result.encoding === "base64"
    ? base64ToBytes(result.data)
    : new TextEncoder().encode(result.data);
}

/** The text of a read; base64 bytes are decoded as UTF-8. */
export function readText(result: Pick<DesignSystemFileReadResult, "encoding" | "data">): string {
  return result.encoding === "utf8"
    ? result.data
    : new TextDecoder().decode(base64ToBytes(result.data));
}

export async function fileToBase64(file: Blob): Promise<string> {
  return bytesToBase64(new Uint8Array(await file.arrayBuffer()));
}

/** Saves bytes under a name through a temporary link, as design exports do. */
export function downloadBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.rel = "noopener";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

/** A download type that never renders as a page: text and images keep theirs, everything else is plain bytes. */
export function downloadType(mimeType: string): string {
  return /^(text\/(plain|css|markdown)|application\/json|image\/|font\/)/.test(mimeType)
    ? mimeType
    : "application/octet-stream";
}

export interface UploadReport {
  readonly saved: readonly DesignSystemFile[];
  readonly failed: readonly { readonly path: string; readonly message: string }[];
}

/** Uploads one file at a time, so memory holds one file's base64 at most. */
export async function uploadAll(
  api: Pick<SystemFilesApi, "put">,
  uploads: readonly { readonly file: Blob; readonly path: string }[],
  onProgress?: (done: number, total: number) => void,
): Promise<UploadReport> {
  const saved: DesignSystemFile[] = [];
  const failed: { path: string; message: string }[] = [];
  for (const [index, upload] of uploads.entries()) {
    onProgress?.(index, uploads.length);
    let data: string;
    try {
      data = await fileToBase64(upload.file);
    } catch {
      failed.push({ path: upload.path, message: `${fileName(upload.path)} could not be read.` });
      continue;
    }
    const outcome = await api.put(upload.path, data);
    if (outcome.ok) saved.push(outcome.value);
    else failed.push({ path: upload.path, message: outcome.message });
  }
  onProgress?.(uploads.length, uploads.length);
  return { saved, failed };
}

/** "Couldn't add logo.png: it is too large." for one failure; a count for several. */
export function uploadFailureText(report: UploadReport): string | null {
  const [first, ...rest] = report.failed;
  if (first === undefined) return null;
  if (rest.length === 0) return first.message;
  return `${report.failed.length} files were not added. ${first.message}`;
}
