/**
 * `design.previewWorkbook` and `design.previewDocument`: host `.xlsx` and
 * `.docx` files read into canonical preview structures and stored nowhere.
 * Follows the same `readableHostFile` path guard and size bounds as `DeckPreview`.
 */
import {
  DesignError,
  type DesignPreviewDocumentInput,
  type DesignPreviewWorkbookInput,
} from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { readableHostFile } from "../../assets/AssetAccess.ts";
import { readDocxDocument } from "./docxImport.ts";
import { DEFAULT_OOXML_LIMITS, OoxmlPreviewError } from "./ooxmlZip.ts";
import { readXlsxWorkbook } from "./xlsxImport.ts";

const notFound = () =>
  new DesignError({ code: "not_found", detail: "The file is not on this machine any more." });

const formatLimitMb = (bytes: number) => `${Math.round(bytes / (1024 * 1024))} MB`;

/** Reads a verified host file through a single open handle with a hard byte ceiling. */
const readBoundedHostFile = (filePath: string, maxBytes: number, label: string) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const handle = yield* fileSystem.open(filePath, { flag: "r" }).pipe(Effect.mapError(notFound));
      const info = yield* handle.stat.pipe(Effect.mapError(notFound));
      if (info.type !== "File") {
        return yield* notFound();
      }
      if (Number(info.size) > maxBytes) {
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
        const remainingPlusOne = maxBytes - total + 1;
        const target = remainingPlusOne < buf.byteLength ? buf.subarray(0, remainingPlusOne) : buf;
        const bytesRead = Number(yield* handle.read(target).pipe(Effect.mapError(notFound)));
        if (bytesRead <= 0) break;
        total += bytesRead;
        if (total > maxBytes) {
          return yield* new DesignError({
            code: "too_large",
            detail: `The ${label} is larger than ${formatLimitMb(maxBytes)}, the preview limit.`,
          });
        }
        chunks.push(target.slice(0, bytesRead));
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
    return yield* Effect.tryPromise({
      try: () => readXlsxWorkbook(bytes, title),
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
