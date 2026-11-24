// @effect-diagnostics nodeBuiltinImport:off - Exclusive creates, no-follow checks and atomic renames need node:fs.
/**
 * `design.documentOpen`, `design.documentSave` and `design.documentBuild`:
 * the Word editor's reads and writes of host `.docx` files.
 *
 * Reads go through the preview's guarded, bounded host read. A write only
 * ever names a `.docx`; the path as given and where it really leads pass the
 * sensitive-path guard for writing, the file itself is never a link, and a
 * replace is compare-and-set on the bytes' sha256 under a per-file lock,
 * written beside the target and renamed over it.
 */
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import {
  DesignError,
  DOCUMENT_LIMITS,
  OfficeDocument,
  type DesignDocumentBuildInput,
  type DesignDocumentOpenInput,
  type DesignDocumentSaveInput,
} from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { readableHostFile } from "../../assets/AssetAccess.ts";
import * as WorkspaceSensitivePaths from "../../workspace/WorkspaceSensitivePaths.ts";
import { openDocxForEditing } from "./docxEdit.ts";
import { buildDocx, DocxWriteError } from "./docxExport.ts";
import { readBoundedHostFile } from "./OfficePreview.ts";
import { OoxmlPreviewError } from "./ooxmlZip.ts";

export const documentRevision = (bytes: Uint8Array): string =>
  NodeCrypto.createHash("sha256").update(bytes).digest("hex");

const notFound = () =>
  new DesignError({ code: "not_found", detail: "The file is not on this machine any more." });

const fromParseError = (fallback: string) => (error: unknown) =>
  error instanceof OoxmlPreviewError || error instanceof DocxWriteError
    ? new DesignError({ code: error.code, detail: error.message })
    : new DesignError({ code: "invalid", detail: fallback });

const checkPath = (path: string, verb: string) =>
  Effect.gen(function* () {
    if (!NodePath.isAbsolute(path)) {
      return yield* new DesignError({
        code: "invalid",
        detail: `${verb} a document needs the file's full path.`,
      });
    }
    if (NodePath.extname(path).toLowerCase() !== ".docx") {
      return yield* new DesignError({
        code: "invalid",
        detail: "Only Word documents saved as .docx open in the editor.",
      });
    }
    return NodePath.resolve(path);
  });

/** Reads a host .docx the person may read, bounded, as bytes. */
const readHostDocx = (path: string) =>
  Effect.gen(function* () {
    const file = yield* readableHostFile(path).pipe(Effect.orElseSucceed(() => null));
    if (file === null) return yield* notFound();
    return yield* readBoundedHostFile(file, DOCUMENT_LIMITS.fileBytes, "document");
  });

/** The model, checked again on the server: a client is untrusted. */
const validDocument = (document: unknown) =>
  Schema.decodeUnknownEffect(OfficeDocument)(document).pipe(
    Effect.mapError(
      () => new DesignError({ code: "invalid", detail: "The document is not valid." }),
    ),
  );

export const documentOpen = (input: DesignDocumentOpenInput) =>
  Effect.gen(function* () {
    const path = yield* checkPath(input.path, "Opening");
    const bytes = yield* readHostDocx(path);
    const opened = yield* Effect.tryPromise({
      try: () => openDocxForEditing(bytes),
      catch: fromParseError("The file could not be read as a Word document (.docx)."),
    });
    return {
      document: opened.document,
      revision: documentRevision(bytes),
      lossOnSave: opened.lossOnSave,
      keptNotShown: opened.keptNotShown,
    };
  }).pipe(Effect.withSpan("OfficeDocumentEdit.documentOpen"));

export const documentBuild = (input: DesignDocumentBuildInput) =>
  Effect.gen(function* () {
    const document = yield* validDocument(input.document);
    const base =
      input.basePath === undefined
        ? undefined
        : yield* readHostDocx(yield* checkPath(input.basePath, "Exporting"));
    const bytes = yield* Effect.tryPromise({
      try: () => buildDocx(document, { base }),
      catch: fromParseError("The document could not be written as .docx."),
    });
    return { base64: Buffer.from(bytes).toString("base64") };
  }).pipe(Effect.withSpan("OfficeDocumentEdit.documentBuild"));

const writesInFlight = new Map<string, Promise<void>>();

async function oneWriteAtATime<T>(key: string, run: () => Promise<T>): Promise<T> {
  const previous = writesInFlight.get(key) ?? Promise.resolve();
  const current = previous.then(run);
  const settled = current.then(
    () => undefined,
    () => undefined,
  );
  writesInFlight.set(key, settled);
  try {
    return await current;
  } finally {
    if (writesInFlight.get(key) === settled) writesInFlight.delete(key);
  }
}

class SaveRefused extends Error {
  readonly code: "conflict" | "invalid" | "not_found" | "forbidden";
  constructor(code: "conflict" | "invalid" | "not_found" | "forbidden", message: string) {
    super(message);
    this.code = code;
  }
}

async function writeAll(handle: NodeFSP.FileHandle, bytes: Uint8Array): Promise<void> {
  for (let offset = 0; offset < bytes.length; ) {
    const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset, offset);
    offset += bytesWritten;
  }
}

async function readCurrent(target: string): Promise<Uint8Array> {
  const handle = await NodeFSP.open(
    target,
    NodeFS.constants.O_RDONLY | (NodeFS.constants.O_NOFOLLOW ?? 0),
  );
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new SaveRefused("invalid", "The document is not a file.");
    if (stat.size > DOCUMENT_LIMITS.fileBytes) {
      throw new SaveRefused("invalid", "The file on disk is over the editor's size limit.");
    }
    return new Uint8Array(await handle.readFile());
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/** `design.documentSave`: a replace must name the revision the editor opened. */
export const documentSave = (input: DesignDocumentSaveInput) =>
  input.mode === "replace" && input.expectedRevision === undefined
    ? Effect.fail(
        new DesignError({
          code: "invalid",
          detail: "Saving over a document needs the revision it was opened at.",
        }),
      )
    : saveDocument(input);

/**
 * Writes a document. Without `expectedRevision` a replace overwrites what is
 * there, keeping its other parts: only `doc_write` asks for that, as sheet_write does.
 */
export const saveDocument = (input: DesignDocumentSaveInput) =>
  Effect.gen(function* () {
    const target = yield* checkPath(input.path, "Saving");
    const document = yield* validDocument(input.document);
    const guard = yield* WorkspaceSensitivePaths.sensitivePathGuardSnapshot;
    const realpath = yield* WorkspaceSensitivePaths.SensitivePathsRealpath;
    const forbidden = () =>
      new DesignError({
        code: "forbidden",
        detail: "This file is protected and cannot be written from the editor.",
      });
    if (guard.isDenied(target, "write")) return yield* forbidden();
    // Where the write really lands: the nearest folder that exists, resolved through any link.
    const resolved = yield* Effect.promise(async () => {
      const missing: string[] = [NodePath.basename(target)];
      let folder = NodePath.dirname(target);
      for (let depth = 0; depth < 64; depth += 1) {
        const real = await realpath(folder).catch(() => null);
        if (real !== null) return { path: NodePath.join(real, ...missing.reverse()), depth };
        const parent = NodePath.dirname(folder);
        if (parent === folder) return null;
        missing.push(NodePath.basename(folder));
        folder = parent;
      }
      return null;
    });
    if (resolved === null || (input.mode === "replace" && resolved.depth > 0)) {
      return yield* notFound();
    }
    const destination = resolved.path;
    if (
      guard.isDenied(destination, "write") ||
      (yield* Effect.promise(() => guard.matchesProtectedIdentity(destination, new Map(), "write")))
    ) {
      return yield* forbidden();
    }

    return yield* Effect.tryPromise({
      try: () =>
        oneWriteAtATime(destination.toLowerCase(), async () => {
          const existing = await NodeFSP.lstat(destination).catch(() => null);
          if (existing?.isSymbolicLink()) {
            throw new SaveRefused("forbidden", "The document is a link; open the file it points to.");
          }
          if (input.mode === "create") {
            if (existing !== null) {
              throw new SaveRefused("conflict", "A file with that name is already there.");
            }
            const bytes = await buildDocx(document, {
              title: NodePath.basename(target, NodePath.extname(target)),
            });
            await NodeFSP.mkdir(NodePath.dirname(destination), { recursive: true });
            const handle = await NodeFSP.open(
              destination,
              NodeFS.constants.O_WRONLY |
                NodeFS.constants.O_CREAT |
                NodeFS.constants.O_EXCL |
                (NodeFS.constants.O_NOFOLLOW ?? 0),
            );
            try {
              await writeAll(handle, bytes);
              await handle.sync();
            } finally {
              await handle.close();
            }
            return { path: target, revision: documentRevision(bytes) };
          }
          if (existing === null) throw new SaveRefused("not_found", "The file is not there any more.");
          if (!existing.isFile()) throw new SaveRefused("invalid", "The document is not a file.");
          const current = await readCurrent(destination);
          const currentRevision = documentRevision(current);
          if (input.expectedRevision !== undefined && input.expectedRevision !== currentRevision) {
            throw new SaveRefused(
              "conflict",
              "The document changed on disk since it was opened. Reload it or keep your version.",
            );
          }
          const bytes = await buildDocx(document, { base: current });
          const temporary = NodePath.join(
            NodePath.dirname(destination),
            `.~${NodePath.basename(destination)}.${NodeCrypto.randomUUID()}.tmp`,
          );
          const handle = await NodeFSP.open(
            temporary,
            NodeFS.constants.O_WRONLY |
              NodeFS.constants.O_CREAT |
              NodeFS.constants.O_EXCL |
              (NodeFS.constants.O_NOFOLLOW ?? 0),
            existing.mode & 0o777,
          );
          try {
            await writeAll(handle, bytes);
            await handle.sync();
          } catch (error) {
            await handle.close().catch(() => undefined);
            await NodeFSP.unlink(temporary).catch(() => undefined);
            throw error;
          }
          await handle.close();
          await NodeFSP.rename(temporary, destination).catch(async (error: unknown) => {
            await NodeFSP.unlink(temporary).catch(() => undefined);
            throw error;
          });
          return { path: target, revision: documentRevision(bytes) };
        }),
      catch: (error) =>
        error instanceof SaveRefused
          ? new DesignError({ code: error.code, detail: error.message })
          : error instanceof DocxWriteError || error instanceof OoxmlPreviewError
            ? new DesignError({ code: error.code, detail: error.message })
            : new DesignError({
                code: "operation_failed",
                detail: `The document could not be saved: ${
                  error instanceof Error ? error.message : String(error)
                }`,
              }),
    });
  }).pipe(Effect.withSpan("OfficeDocumentEdit.documentSave"));
