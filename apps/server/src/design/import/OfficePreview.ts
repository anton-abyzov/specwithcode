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

export const previewWorkbook = (input: DesignPreviewWorkbookInput) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const fileSystem = yield* FileSystem.FileSystem;
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
    const info = yield* fileSystem.stat(file).pipe(Effect.mapError(notFound));
    if (Number(info.size) > DEFAULT_OOXML_LIMITS.fileBytes) {
      return yield* new DesignError({
        code: "too_large",
        detail: `The workbook is larger than ${formatLimitMb(DEFAULT_OOXML_LIMITS.fileBytes)}, the preview limit.`,
      });
    }
    const bytes = yield* fileSystem.readFile(file).pipe(Effect.mapError(notFound));
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
    const fileSystem = yield* FileSystem.FileSystem;
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
    const info = yield* fileSystem.stat(file).pipe(Effect.mapError(notFound));
    if (Number(info.size) > DEFAULT_OOXML_LIMITS.fileBytes) {
      return yield* new DesignError({
        code: "too_large",
        detail: `The document is larger than ${formatLimitMb(DEFAULT_OOXML_LIMITS.fileBytes)}, the preview limit.`,
      });
    }
    const bytes = yield* fileSystem.readFile(file).pipe(Effect.mapError(notFound));
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
