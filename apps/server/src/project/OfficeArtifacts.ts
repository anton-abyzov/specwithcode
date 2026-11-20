// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off -- Artifact files and cross-process lockfiles use node:fs directly.
/**
 * Office artifacts on disk. A sheet is one JSON file in the project's
 * `.specweave/artifacts/` folder. The server builds every path from a checked
 * name, so a caller never supplies one, and a file is only read or written by
 * a path from the project's real root that holds no link.
 */
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  OFFICE_ARTIFACTS_DIR,
  SHEET_ARTIFACT_SUFFIX,
  SHEET_LIMITS,
  SHEET_NAME_PATTERN,
  type SheetDocument,
  mergeSheetInput,
  parseSheetDocument,
  serializeSheetDocument,
  sheetContentRevision,
  sheetSlug,
  validateSheetDocument,
} from "@specweave-studio/shared/officeSheet";

import { ProjectLibraryProblem } from "./ProjectLibrary.ts";
import { openInside } from "./ThreadReports.ts";

export interface SavedSheet {
  readonly name: string;
  readonly relativePath: string;
  readonly absolutePath: string;
  readonly document: SheetDocument;
  readonly revision: string;
  readonly created: boolean;
}

function invalid(message: string): ProjectLibraryProblem {
  return new ProjectLibraryProblem("invalid", message);
}

function checkedName(name: string): string {
  const trimmed = name.trim().toLowerCase();
  const stem = trimmed.endsWith(SHEET_ARTIFACT_SUFFIX)
    ? trimmed.slice(0, -SHEET_ARTIFACT_SUFFIX.length)
    : trimmed;
  if (!SHEET_NAME_PATTERN.test(stem)) {
    throw invalid(
      "A sheet name is lower-case letters, digits and dashes, up to 60 characters, such as q3-budget.",
    );
  }
  return stem;
}

function relativePathOf(name: string): string {
  return `${OFFICE_ARTIFACTS_DIR}/${name}${SHEET_ARTIFACT_SUFFIX}`;
}

/** A folder of the project that is a real directory, with no link in its path. */
async function plainDirectory(realRoot: string, relative: string): Promise<boolean> {
  let current = realRoot;
  for (const part of relative.split("/")) {
    current = NodePath.join(current, part);
    const stat = await NodeFSP.lstat(current).catch(() => null);
    if (stat === null || !stat.isDirectory() || stat.isSymbolicLink()) return false;
  }
  return true;
}

async function artifactsRoot(workspaceRoot: string, create: boolean): Promise<string> {
  const realRoot = await NodeFSP.realpath(NodePath.resolve(workspaceRoot));
  if (!(await plainDirectory(realRoot, ".specweave"))) {
    throw new ProjectLibraryProblem(
      "not_specweave",
      "This project has no .specweave folder. Run specweave init in it to save sheets.",
    );
  }
  if (create) {
    await NodeFSP.mkdir(NodePath.join(realRoot, ...OFFICE_ARTIFACTS_DIR.split("/")), {
      recursive: true,
    }).catch(() => undefined);
  }
  if (!(await plainDirectory(realRoot, OFFICE_ARTIFACTS_DIR))) {
    throw invalid(
      create
        ? `${OFFICE_ARTIFACTS_DIR} leads outside the project.`
        : "This project has no saved sheets yet.",
    );
  }
  return realRoot;
}

async function readFrom(
  realRoot: string,
  name: string,
): Promise<{ readonly document: SheetDocument; readonly revision: string } | null> {
  const relativePath = relativePathOf(name);
  const exists = await NodeFSP.lstat(NodePath.join(realRoot, ...relativePath.split("/"))).catch(
    () => null,
  );
  if (exists === null) return null;
  const reader = await openInside(realRoot, relativePath, NodeFS.constants.O_RDONLY);
  try {
    const stat = await reader.stat();
    if (stat.size > SHEET_LIMITS.bytes) {
      throw invalid(`${relativePath} is over the ${SHEET_LIMITS.bytes / (1024 * 1024)} MB limit.`);
    }
    const raw = await reader.readFile("utf8");
    const parsed = parseSheetDocument(raw);
    if (!parsed.ok) throw invalid(`${relativePath} is not a valid sheet: ${parsed.error}`);
    return { document: parsed.document, revision: sheetContentRevision(raw) };
  } finally {
    await reader.close().catch(() => undefined);
  }
}

export async function readSheetArtifact(workspaceRoot: string, name: string): Promise<SavedSheet> {
  const stem = checkedName(name);
  const realRoot = await artifactsRoot(workspaceRoot, false);
  const loaded = await readFrom(realRoot, stem);
  if (loaded === null) {
    throw invalid(`No sheet named ${stem} in this project.`);
  }
  const relativePath = relativePathOf(stem);
  return {
    name: stem,
    relativePath,
    absolutePath: NodePath.join(NodePath.resolve(workspaceRoot), ...relativePath.split("/")),
    document: loaded.document,
    revision: loaded.revision,
    created: false,
  };
}

const writesInFlight = new Map<string, Promise<void>>();
const LOCK_TIMEOUT_MS = 4_000;

function canonicalStemIfExact(rawStem: string): string | null {
  try {
    const normalized = checkedName(rawStem);
    return normalized === rawStem ? normalized : null;
  } catch {
    return null;
  }
}

async function resolveSheetLockIdentity(targetAbsolutePath: string): Promise<string> {
  const parentDir = NodePath.dirname(targetAbsolutePath);
  await NodeFSP.mkdir(parentDir, { recursive: true });
  const realParent = await NodeFSP.realpath(parentDir);
  // Lowercase the lock identity (never the file path itself) so case aliases on
  // case-insensitive filesystems share one lock without rewriting distinct names
  // on case-sensitive volumes.
  return NodePath.join(realParent, NodePath.basename(targetAbsolutePath)).toLowerCase();
}

function isSqliteLockBusyError(error: unknown): boolean {
  const err = error as { readonly errcode?: number; readonly code?: string; readonly message?: string } | null;
  if (err?.errcode === 5 || err?.errcode === 6) return true;
  const msg = (err?.message ?? "").toLowerCase();
  return msg.includes("database is locked") || msg.includes("database is busy");
}

/**
 * Acquire a crash-released kernel file lock (SQLite `BEGIN EXCLUSIVE`, backed
 * by POSIX `fcntl` / Windows `LockFileEx`) in `os.tmpdir()` so dead processes
 * release locks immediately without stale-file unlink races or workspace clutter.
 */
async function withKernelSheetLock<T>(
  lockIdentity: string,
  label: string,
  run: () => Promise<T>,
): Promise<T> {
  const lockDir = NodePath.join(NodeOS.tmpdir(), "specwithcode-sheet-locks");
  await NodeFSP.mkdir(lockDir, { recursive: true });
  const lockHash = NodeCrypto.createHash("sha256").update(lockIdentity).digest("hex").slice(0, 32);
  const lockDbPath = NodePath.join(lockDir, `${lockHash}.sqlite`);
  const deadline = Date.now() + LOCK_TIMEOUT_MS;

  let db: DatabaseSync | null = null;
  while (true) {
    const candidate = new DatabaseSync(lockDbPath);
    try {
      candidate.exec("PRAGMA busy_timeout = 100; BEGIN EXCLUSIVE;");
      db = candidate;
      break;
    } catch (error: unknown) {
      try {
        candidate.close();
      } catch {
        // ignore close failure on busy lock
      }
      if (!isSqliteLockBusyError(error)) {
        throw error;
      }
      if (Date.now() >= deadline) {
        throw invalid(`Sheet ${label} is currently being written by another process. Try again.`);
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  try {
    return await run();
  } finally {
    try {
      db.exec("COMMIT;");
    } catch {
      try {
        db.exec("ROLLBACK;");
      } catch {
        // ignore
      }
    }
    try {
      db.close();
    } catch {
      // ignore
    }
  }
}

async function oneWriteAtATime<T>(lock: string, run: () => Promise<T>): Promise<T> {
  const previous = writesInFlight.get(lock) ?? Promise.resolve();
  const current = previous.then(run);
  const settled = current.then(
    () => undefined,
    () => undefined,
  );
  writesInFlight.set(lock, settled);
  try {
    return await current;
  } finally {
    if (writesInFlight.get(lock) === settled) writesInFlight.delete(lock);
  }
}

/**
 * Save a sheet under a name, replacing the file of that name or, with merge,
 * laying the input over it. The input is untrusted and validated here.
 */
export async function writeSheetArtifact(
  workspaceRoot: string,
  input: unknown,
  options: {
    readonly name?: string | undefined;
    readonly merge?: boolean | undefined;
    readonly expectedRevision?: string | undefined;
  } = {},
): Promise<SavedSheet> {
  const titled =
    typeof input === "object" && input !== null && "title" in input
      ? (input as { title: unknown }).title
      : undefined;
  const stem =
    options.name !== undefined
      ? checkedName(options.name)
      : typeof titled === "string" && titled.trim().length > 0
        ? sheetSlug(titled)
        : null;
  if (stem === null) throw invalid("A sheet needs a title, or the name of the sheet to update.");
  const realRoot = await artifactsRoot(workspaceRoot, true);
  const relativePath = relativePathOf(stem);
  const target = NodePath.join(realRoot, ...relativePath.split("/"));
  const lockIdentity = await resolveSheetLockIdentity(target);
  return oneWriteAtATime(lockIdentity, () =>
    withKernelSheetLock(lockIdentity, stem, async () => {
      const before = await readFrom(realRoot, stem).catch((error: unknown) => {
        // A broken file of that name is replaced by a plain write, never merged into.
        if (options.merge === true || options.expectedRevision !== undefined) throw error;
        return null;
      });
      if (options.expectedRevision !== undefined) {
        if (before === null) {
          throw invalid(
            `Conflict: expected revision ${options.expectedRevision}, but sheet ${stem} does not exist yet.`,
          );
        }
        if (before.revision !== options.expectedRevision) {
          throw invalid(
            `Conflict: sheet ${stem} changed on disk (expected ${options.expectedRevision}, current ${before.revision}). Re-read the sheet and retry.`,
          );
        }
      }
      if (options.merge === true && before === null) {
        throw invalid(`No sheet named ${stem} to update.`);
      }
      const validated = validateSheetDocument(
        options.merge === true && before !== null ? mergeSheetInput(before.document, input) : input,
      );
      if (!validated.ok) throw invalid(validated.error);
      const text = serializeSheetDocument(validated.document);
      if (Buffer.byteLength(text, "utf8") > SHEET_LIMITS.bytes) {
        throw invalid(`The sheet is over the ${SHEET_LIMITS.bytes / (1024 * 1024)} MB limit.`);
      }
      const existing = await NodeFSP.lstat(target).catch(() => null);
      if (existing !== null && !existing.isFile()) {
        throw invalid(`${relativePath} leads outside the project.`);
      }
      // Written beside the target and renamed over it, so a reader never sees half a file.
      const temporary = `${OFFICE_ARTIFACTS_DIR}/.${stem}.${NodeCrypto.randomUUID()}.tmp`;
      const temporaryPath = NodePath.join(realRoot, ...temporary.split("/"));
      const writer = await openInside(
        realRoot,
        temporary,
        NodeFS.constants.O_CREAT | NodeFS.constants.O_EXCL | NodeFS.constants.O_WRONLY,
      );
      try {
        await writer.writeFile(text, "utf8");
        await writer.sync();
      } catch (error) {
        await writer.close().catch(() => undefined);
        await NodeFSP.unlink(temporaryPath).catch(() => undefined);
        throw error;
      }
      await writer.close();
      try {
        await NodeFSP.rename(temporaryPath, target);
      } catch (error) {
        await NodeFSP.unlink(temporaryPath).catch(() => undefined);
        throw error;
      }
      return {
        name: stem,
        relativePath,
        absolutePath: NodePath.join(NodePath.resolve(workspaceRoot), ...relativePath.split("/")),
        document: validated.document,
        revision: sheetContentRevision(text),
        created: existing === null,
      };
    }),
  );
}

/**
 * Locked compare-and-set write for any `.sheet.json` file in a workspace
 * (including viewer saves through WorkspaceFileSystem). When `checkedAbsolutePath`
 * is provided by `WorkspaceFileSystem`, writes to that exact authorized path
 * instead of re-splitting `relativePath`.
 */
export async function writeSheetFileCompareAndSet(
  workspaceRoot: string,
  relativePath: string,
  contents: string,
  expectedRevision?: string,
  checkedAbsolutePath?: string,
): Promise<void> {
  const realRoot = await NodeFSP.realpath(workspaceRoot);
  const normalizedRel = relativePath.replace(/\\/g, "/").replace(/^\/+/, "");
  const target =
    checkedAbsolutePath !== undefined
      ? checkedAbsolutePath
      : NodePath.resolve(realRoot, ...normalizedRel.split("/"));

  if (checkedAbsolutePath === undefined) {
    const relCheck = NodePath.relative(realRoot, target);
    if (relCheck.startsWith("..") || NodePath.isAbsolute(relCheck)) {
      throw invalid(`${normalizedRel} leads outside the project.`);
    }
  }

  // Only route through `writeSheetArtifact` when the exact resolved target path
  // matches a canonical `.specweave/artifacts/<stem>.sheet.json` file.
  const artifactsDir = NodePath.join(realRoot, ...OFFICE_ARTIFACTS_DIR.split("/"));
  if (
    NodePath.dirname(target) === artifactsDir &&
    NodePath.basename(target).endsWith(SHEET_ARTIFACT_SUFFIX)
  ) {
    const rawStem = NodePath.basename(target).slice(0, -SHEET_ARTIFACT_SUFFIX.length);
    const canonicalStem = canonicalStemIfExact(rawStem);
    if (canonicalStem !== null) {
      let parsedJson: unknown;
      try {
        parsedJson = JSON.parse(contents);
      } catch {
        throw invalid("Sheet contents are not valid JSON.");
      }
      await writeSheetArtifact(workspaceRoot, parsedJson, {
        name: canonicalStem,
        ...(expectedRevision !== undefined ? { expectedRevision } : {}),
      });
      return;
    }
  }

  // Non-canonical or non-artifacts `.sheet.json` file: serialize with the same
  // case-folded kernel lock identity and enforce expectedRevision.
  const lockIdentity = await resolveSheetLockIdentity(target);
  await oneWriteAtATime(lockIdentity, () =>
    withKernelSheetLock(lockIdentity, normalizedRel, async () => {
      if (expectedRevision !== undefined) {
        const currentContents = await NodeFSP.readFile(target, "utf8").catch(() => null);
        if (currentContents === null) {
          throw invalid(
            `Conflict: expected revision ${expectedRevision}, but ${normalizedRel} does not exist.`,
          );
        }
        const currentRevision = sheetContentRevision(currentContents);
        if (currentRevision !== expectedRevision) {
          throw invalid(
            `Conflict: ${normalizedRel} changed on disk (expected ${expectedRevision}, current ${currentRevision}).`,
          );
        }
      }
      const tempPath = `${target}.${NodeCrypto.randomUUID()}.tmp`;
      const handle = await NodeFSP.open(
        tempPath,
        NodeFS.constants.O_CREAT | NodeFS.constants.O_EXCL | NodeFS.constants.O_WRONLY,
      );
      try {
        await handle.writeFile(contents, "utf8");
        await handle.sync();
      } catch (error) {
        await handle.close().catch(() => undefined);
        await NodeFSP.unlink(tempPath).catch(() => undefined);
        throw error;
      }
      await handle.close();
      await NodeFSP.rename(tempPath, target).catch(async (error) => {
        await NodeFSP.unlink(tempPath).catch(() => undefined);
        throw error;
      });
    }),
  );
}
