// @effect-diagnostics nodeBuiltinImport:off - Exclusive creates, no-follow checks and handle writes need node:fs.
/**
 * `design.documentOpen`, `design.documentSave` and `design.documentBuild`:
 * the Word editor's reads and writes of host `.docx` files.
 *
 * Reads go through the preview's guarded, bounded host read. A write only
 * ever names a `.docx`; the path as given and where it really leads pass the
 * sensitive-path guard for writing, the file itself is never a link, and a
 * replace is compare-and-set on the bytes' sha256 under a lock by path and
 * by the file itself, written through the checked handle, with a private
 * backup of the original until the write lands.
 */
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
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

/** Whether a file still has the size and times it had, so its bytes are the ones read. */
const unchangedSince = (before: NodeFS.BigIntStats, after: NodeFS.BigIntStats) =>
  before.dev === after.dev &&
  before.ino === after.ino &&
  before.size === after.size &&
  before.mtimeNs === after.mtimeNs &&
  before.ctimeNs === after.ctimeNs;

async function readAll(handle: NodeFSP.FileHandle, size: number): Promise<Uint8Array> {
  const bytes = new Uint8Array(size);
  for (let offset = 0; offset < size; ) {
    const { bytesRead } = await handle.read(bytes, offset, size - offset, offset);
    if (bytesRead === 0) throw new SaveRefused("conflict", "The document changed on disk while it was read.");
    offset += bytesRead;
  }
  return bytes;
}

/**
 * Replaces a checked file's bytes through its open handle, under the file's own
 * lock: reads the base and revision from the handle, refuses a change by another
 * program, and keeps a private copy of the original until the new bytes land.
 */
async function replaceThrough(
  handle: NodeFSP.FileHandle,
  destination: string,
  expectedRevision: string | undefined,
  document: OfficeDocument,
  target: string,
): Promise<{ path: string; revision: string }> {
  // Stat again under the lock: a save through another name may have just landed.
  const opened = await handle.stat({ bigint: true });
  if (opened.size > BigInt(DOCUMENT_LIMITS.fileBytes)) {
    throw new SaveRefused("invalid", "The file on disk is over the editor's size limit.");
  }
  const current = await readAll(handle, Number(opened.size));
  const currentRevision = documentRevision(current);
  if (expectedRevision !== undefined && expectedRevision !== currentRevision) {
    throw new SaveRefused(
      "conflict",
      "The document changed on disk since it was opened. Reload it or keep your version.",
    );
  }
  const bytes = await buildDocx(document, { base: current });
  // Word or another program may have saved while this one was built: in place
  // (the file's size or times moved) or by renaming a new file over the name.
  const changedWhileSaving = () =>
    new SaveRefused(
      "conflict",
      "The document changed on disk while it was being saved. Reload it or keep your version.",
    );
  // A copy of the original in a private folder of its own, so a write that fails and
  // cannot be undone still loses nothing. No copy, no write.
  const backupFolder = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "specwithcode-docx-backup-"));
  const backup = NodePath.join(backupFolder, NodePath.basename(destination));
  const dropBackup = () => NodeFSP.rm(backupFolder, { recursive: true, force: true }).catch(() => undefined);
  try {
    await NodeFSP.writeFile(backup, current, { mode: 0o600, flag: "wx" });
  } catch (error) {
    await dropBackup();
    throw error;
  }
  // The last look before the write, after everything slow (building, the backup).
  const [now, before] = await Promise.all([
    handle.stat({ bigint: true }),
    NodeFSP.lstat(destination, { bigint: true }).catch(() => null),
  ]).catch(async (error: unknown) => {
    await dropBackup();
    throw error;
  });
  if (!unchangedSince(opened, now) || before === null || before.ino !== opened.ino || before.dev !== opened.dev) {
    await dropBackup();
    throw changedWhileSaving();
  }
  try {
    await handle.truncate(0);
    await writeAll(handle, bytes);
    await handle.sync();
  } catch (error) {
    // Put the file back as it was rather than leave it half written.
    const restored = await handle
      .truncate(0)
      .then(() => writeAll(handle, current))
      .then(() => handle.sync())
      .then(
        () => true,
        () => false,
      );
    if (!restored) {
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}. Putting the file back failed too; the original is kept at ${backup}`,
      );
    }
    await dropBackup();
    throw error;
  }
  await dropBackup();
  // A new file renamed over the name meanwhile holds the other program's save; this
  // one went to the file it replaced.
  const there = await NodeFSP.lstat(destination, { bigint: true }).catch(() => null);
  if (there === null || there.ino !== opened.ino || there.dev !== opened.dev) throw changedWhileSaving();
  return { path: target, revision: documentRevision(bytes) };
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

    const folder = NodePath.dirname(destination);
    /**
     * The file just opened is still in the checked folder: no folder on the way
     * was swapped for a link between the check and the open. Node has no openat,
     * so the open handle's identity is compared with the checked path instead.
     */
    const stillInCheckedFolder = async (handle: NodeFSP.FileHandle, path: string): Promise<boolean> => {
      const real = await realpath(folder).catch(() => null);
      if (real !== folder) return false;
      const [opened, there] = await Promise.all([
        handle.stat({ bigint: true }),
        NodeFSP.lstat(path, { bigint: true }).catch(() => null),
      ]);
      return there !== null && there.isFile() && there.ino === opened.ino && there.dev === opened.dev;
    };
    const moved = () =>
      new SaveRefused("forbidden", "A folder on the way to the document changed while saving.");

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
            await NodeFSP.mkdir(folder, { recursive: true });
            const handle = await NodeFSP.open(
              destination,
              NodeFS.constants.O_WRONLY |
                NodeFS.constants.O_CREAT |
                NodeFS.constants.O_EXCL |
                (NodeFS.constants.O_NOFOLLOW ?? 0),
            );
            try {
              if (!(await stillInCheckedFolder(handle, destination))) {
                // Nothing is written. The path no longer names the file just made, so
                // nothing is removed by path either: that could remove another file.
                await handle.close().catch(() => undefined);
                throw moved();
              }
              await writeAll(handle, bytes);
              await handle.sync();
            } finally {
              await handle.close();
            }
            return { path: target, revision: documentRevision(bytes) };
          }
          if (existing === null) throw new SaveRefused("not_found", "The file is not there any more.");
          if (!existing.isFile()) throw new SaveRefused("invalid", "The document is not a file.");
          // The save writes through this one handle, so its bytes land only in the file
          // judged here: no path is looked up again between the check and the write.
          // Non-blocking so a FIFO cannot hang the open; no-follow, since the path names
          // no link. Windows lacks both.
          const handle = await NodeFSP.open(
            destination,
            NodeFS.constants.O_RDWR |
              (NodeFS.constants.O_NONBLOCK ?? 0) |
              (NodeFS.constants.O_NOFOLLOW ?? 0),
          );
          try {
            const opened = await handle.stat({ bigint: true });
            if (!opened.isFile()) throw new SaveRefused("invalid", "The document is not a file.");
            // The protected-file check judges the open file itself, not whatever the path names now.
            const identities: WorkspaceSensitivePaths.IdentityStatCache = new Map([
              [WorkspaceSensitivePaths.identityStatCacheKey(destination), Promise.resolve(opened)],
            ]);
            if (await guard.matchesProtectedIdentity(destination, identities, "write")) {
              throw new SaveRefused("forbidden", "This file is protected and cannot be written from the editor.");
            }
            if (!(await stillInCheckedFolder(handle, destination))) throw moved();
            // Another name for the same file (a hard link) is the same document: one write at a time.
            return await oneWriteAtATime(`file:${opened.dev}:${opened.ino}`, () =>
              replaceThrough(handle, destination, input.expectedRevision, document, target),
            );
          } finally {
            await handle.close().catch(() => undefined);
          }
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
