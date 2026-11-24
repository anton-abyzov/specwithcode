// @effect-diagnostics nodeBuiltinImport:off - Uses O_NOFOLLOW/O_NONBLOCK open and bigint fstat for TOCTOU-safe host reads.
/**
 * `design.previewWorkbook` and `design.previewDocument`: host `.xlsx` and
 * `.docx` files read into canonical preview structures and stored nowhere.
 * Follows the same `readableHostFile` path guard and size bounds as `DeckPreview`,
 * and binds the sensitive-path identity check directly to the opened handle.
 */
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import {
  DesignError,
  type DesignPreviewDocumentInput,
  type DesignPreviewWorkbookInput,
} from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";

import { readableHostFile } from "../../assets/AssetAccess.ts";
import { sensitivePathGuardSnapshot } from "../../workspace/WorkspaceSensitivePaths.ts";
import { readDocxDocument } from "./docxImport.ts";
import { DEFAULT_OOXML_LIMITS, OoxmlPreviewError } from "./ooxmlZip.ts";
import { readXlsxWorkbook } from "./xlsxImport.ts";

const notFound = () =>
  new DesignError({ code: "not_found", detail: "The file is not on this machine any more." });

const formatLimitMb = (bytes: number) => `${Math.round(bytes / (1024 * 1024))} MB`;

const HOST_READ_OPEN_FLAGS =
  NodeFS.constants.O_RDONLY |
  (NodeFS.constants.O_NONBLOCK ?? 0) |
  (NodeFS.constants.O_NOFOLLOW ?? 0);

/**
 * Reads a verified canonical host file through a single non-blocking, no-follow
 * handle, binding the opened object's `dev:ino` identity to the sensitive-path
 * guard before reading under a hard byte ceiling.
 */
export const readBoundedHostFile = (filePath: string, maxBytes: number, label: string) =>
  Effect.scoped(
    Effect.gen(function* () {
      const guard = yield* sensitivePathGuardSnapshot;
      const checkedStat = yield* Effect.tryPromise({
        try: () => NodeFSP.stat(filePath, { bigint: true }),
        catch: notFound,
      });
      if (!checkedStat.isFile()) {
        return yield* notFound();
      }
      const handle = yield* Effect.acquireRelease(
        Effect.tryPromise({
          try: () => NodeFSP.open(filePath, HOST_READ_OPEN_FLAGS),
          catch: notFound,
        }),
        (h) => Effect.promise(() => h.close().catch(() => undefined)),
      );
      const stat = yield* Effect.tryPromise({
        try: () => handle.stat({ bigint: true }),
        catch: notFound,
      });
      if (!stat.isFile() || stat.dev !== checkedStat.dev || stat.ino !== checkedStat.ino) {
        return yield* notFound();
      }
      if (yield* Effect.promise(() => guard.isProtectedFileIdentity(stat))) {
        return yield* notFound();
      }
      if (Number(stat.size) > maxBytes) {
        return yield* new DesignError({
          code: "too_large",
          detail: `The ${label} is larger than ${formatLimitMb(maxBytes)}, the preview limit.`,
        });
      }
      const chunks: Uint8Array[] = [];
      let total = 0;
      const buf = new Uint8Array(64 * 1024);
      while (true) {
        // Bound every read to the remaining allowance plus a 1-byte overflow probe.
        const toRead = Math.min(buf.byteLength, maxBytes - total + 1);
        const { bytesRead } = yield* Effect.tryPromise({
          try: () => handle.read(buf, 0, toRead, null),
          catch: notFound,
        });
        if (bytesRead <= 0) break;
        total += bytesRead;
        if (total > maxBytes) {
          return yield* new DesignError({
            code: "too_large",
            detail: `The ${label} is larger than ${formatLimitMb(maxBytes)}, the preview limit.`,
          });
        }
        chunks.push(buf.slice(0, bytesRead));
      }
      const out = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        out.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return out;
    }),
  );

export const previewWorkbook = (input: DesignPreviewWorkbookInput) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    if (!path.isAbsolute(input.path)) {
      return yield* new DesignError({
        code: "invalid",
        detail: "A workbook preview needs the file's full path.",
      });
    }
    if (path.extname(input.path).toLowerCase() !== ".xlsx") {
      return yield* new DesignError({
        code: "invalid",
        detail: "Only Excel workbooks saved as .xlsx have a preview here.",
      });
    }
    const file = yield* readableHostFile(input.path).pipe(Effect.orElseSucceed(() => null));
    if (file === null) return yield* notFound();
    const bytes = yield* readBoundedHostFile(file, DEFAULT_OOXML_LIMITS.fileBytes, "workbook");
    const title = path.basename(input.path, path.extname(input.path)) || "Workbook";
    // The revision lets the editor write the file back only over what it read.
    const revision = NodeCrypto.createHash("sha256").update(bytes).digest("hex");
    return yield* Effect.tryPromise({
      try: async () => ({ ...(await readXlsxWorkbook(bytes, title)), revision }),
      catch: (error) =>
        error instanceof OoxmlPreviewError
          ? new DesignError({ code: error.code, detail: error.message })
          : new DesignError({
              code: "invalid",
              detail: "The file could not be read as an Excel workbook (.xlsx).",
            }),
    });
  }).pipe(Effect.withSpan("OfficePreview.previewWorkbook"));

export const previewDocument = (input: DesignPreviewDocumentInput) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    if (!path.isAbsolute(input.path)) {
      return yield* new DesignError({
        code: "invalid",
        detail: "A document preview needs the file's full path.",
      });
    }
    if (path.extname(input.path).toLowerCase() !== ".docx") {
      return yield* new DesignError({
        code: "invalid",
        detail: "Only Word documents saved as .docx have a preview here.",
      });
    }
    const file = yield* readableHostFile(input.path).pipe(Effect.orElseSucceed(() => null));
    if (file === null) return yield* notFound();
    const bytes = yield* readBoundedHostFile(file, DEFAULT_OOXML_LIMITS.fileBytes, "document");
    return yield* Effect.tryPromise({
      try: () => readDocxDocument(bytes),
      catch: (error) =>
        error instanceof OoxmlPreviewError
          ? new DesignError({ code: error.code, detail: error.message })
          : new DesignError({
              code: "invalid",
              detail: "The file could not be read as a Word document (.docx).",
            }),
    });
  }).pipe(Effect.withSpan("OfficePreview.previewDocument"));
