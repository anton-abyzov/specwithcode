// @effect-diagnostics nodeBuiltinImport:off - SHA-256 revisions come from node:crypto; realpath gives the lock key.
/**
 * `design.saveWorkbook` and `design.importWorkbook`. A save writes a Sheet back
 * over an existing host .xlsx: the same path guard and no-follow read as the
 * preview, a revision check against the bytes on disk, then a temp file and a
 * rename so a failed write never leaves half a workbook. An import reads
 * uploaded .xlsx bytes as a Sheet and stores nothing.
 */
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import {
  DESIGN_WORKBOOK_MAX_BYTES,
  DesignError,
  type DesignImportWorkbookInput,
  type DesignSaveWorkbookInput,
} from "@specweave-studio/contracts";
import { parseSheetDocument } from "@specweave-studio/shared/officeSheet";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as Semaphore from "effect/Semaphore";

import { readableHostFile } from "../../assets/AssetAccess.ts";
import { writeFileStringAtomically } from "../../atomicWrite.ts";
import { readBoundedHostFile } from "./OfficePreview.ts";
import { OoxmlPreviewError } from "./ooxmlZip.ts";
import { writeXlsxWorkbook } from "./xlsxExport.ts";
import { readXlsxWorkbook } from "./xlsxImport.ts";

/** The revision a workbook save checks: SHA-256 of the file's bytes. */
export function workbookRevision(bytes: Uint8Array): string {
  return NodeCrypto.createHash("sha256").update(bytes).digest("hex");
}

/**
 * One save at a time per workbook in this server, from the revision check to
 * the rename, so two editors that read the same revision cannot both win.
 * Keyed by the file's real path, so two spellings of one file share a lock;
 * a lock nobody holds is dropped.
 */
const saveLocks = new Map<string, { readonly lock: Semaphore.Semaphore; users: number }>();
const withSaveLock = <A, E, R>(key: string, effect: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      let entry = saveLocks.get(key);
      if (!entry) {
        entry = { lock: Semaphore.makeUnsafe(1), users: 0 };
        saveLocks.set(key, entry);
      }
      entry.users += 1;
      return entry;
    }),
    (entry) => entry.lock.withPermits(1)(effect),
    (entry) =>
      Effect.sync(() => {
        entry.users -= 1;
        if (entry.users === 0) saveLocks.delete(key);
      }),
  );

/**
 * The lock key for a file: its real path, which resolves links and, on macOS and
 * Windows, the on-disk case. Unlike the inode it stays the same when a save
 * replaces the file. Falls back to the path when the file cannot be resolved.
 */
const fileIdentity = (file: string) => Effect.promise(() => NodeFSP.realpath(file).catch(() => file));

const notFound = () =>
  new DesignError({ code: "not_found", detail: "The file is not on this machine any more." });

const LOCK_CODES = new Set(["EBUSY", "EPERM", "EACCES", "ETXTBSY"]);

function errorCode(error: unknown): string | undefined {
  const reason = (error as { reason?: { cause?: unknown } } | undefined)?.reason;
  const cause = (reason?.cause ?? error) as NodeJS.ErrnoException | undefined;
  return typeof cause?.code === "string" ? cause.code : undefined;
}

export const saveWorkbook = (input: DesignSaveWorkbookInput) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    if (!path.isAbsolute(input.path) || path.extname(input.path).toLowerCase() !== ".xlsx") {
      return yield* new DesignError({
        code: "invalid",
        detail: "Only an Excel workbook saved as .xlsx, by its full path, can be saved here.",
      });
    }
    const parsed = parseSheetDocument(input.sheetJson);
    if (!parsed.ok) return yield* new DesignError({ code: "invalid", detail: parsed.error });
    const bytes = writeXlsxWorkbook(parsed.document);
    if (bytes.byteLength > DESIGN_WORKBOOK_MAX_BYTES) {
      return yield* new DesignError({
        code: "too_large",
        detail: "The workbook would be larger than 25 MB, the save limit.",
      });
    }
    // Only an existing, readable, unprotected workbook is written over.
    const file = yield* readableHostFile(input.path).pipe(Effect.orElseSucceed(() => null));
    if (file === null) return yield* notFound();
    const identity = yield* fileIdentity(file);
    yield* withSaveLock(
      identity,
      Effect.gen(function* () {
        const current = yield* readBoundedHostFile(file, DESIGN_WORKBOOK_MAX_BYTES, "workbook");
        if (workbookRevision(current) !== input.expectedRevision) {
          return yield* new DesignError({
            code: "conflict",
            detail: "The workbook changed on disk since it was opened. Reload it before saving.",
          });
        }
        yield* writeFileStringAtomically({ filePath: file, contents: bytes }).pipe(
          Effect.mapError((error) =>
            LOCK_CODES.has(errorCode(error) ?? "")
              ? new DesignError({
                  code: "operation_failed",
                  detail:
                    "The workbook is open or locked in another app, such as Excel. Close it there and save again.",
                })
              : new DesignError({ code: "operation_failed", detail: "The workbook could not be written." }),
          ),
        );
      }),
    );
    return { revision: workbookRevision(bytes) };
  }).pipe(Effect.withSpan("WorkbookSave.saveWorkbook"));

export const importWorkbook = (input: DesignImportWorkbookInput) =>
  Effect.gen(function* () {
    const bytes = Buffer.from(input.data, "base64");
    if (bytes.byteLength === 0) {
      return yield* new DesignError({ code: "invalid", detail: "The upload is empty." });
    }
    if (bytes.byteLength > DESIGN_WORKBOOK_MAX_BYTES) {
      return yield* new DesignError({
        code: "too_large",
        detail: "The workbook is larger than 25 MB, the import limit.",
      });
    }
    const title = input.title.replace(/\.xlsx$/i, "").trim() || "Workbook";
    return yield* Effect.tryPromise({
      try: () => readXlsxWorkbook(new Uint8Array(bytes), title),
      catch: (error) =>
        error instanceof OoxmlPreviewError
          ? new DesignError({ code: error.code, detail: error.message })
          : new DesignError({
              code: "invalid",
              detail: "The file could not be read as an Excel workbook (.xlsx).",
            }),
    });
  }).pipe(Effect.withSpan("WorkbookSave.importWorkbook"));
