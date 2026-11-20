// @effect-diagnostics nodeBuiltinImport:off -- Artifact files are opened by link-free paths with node:fs.
/**
 * Office artifacts on disk. A sheet is one JSON file in the project's
 * `.specweave/artifacts/` folder. The server builds every path from a checked
 * name, so a caller never supplies one, and a file is only read or written by
 * a path from the project's real root that holds no link.
 */
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

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
const LOCK_STALE_MS = 30_000;
const LOCK_TIMEOUT_MS = 4_000;

async function withCrossProcessLock<T>(
  realRoot: string,
  stem: string,
  run: () => Promise<T>,
): Promise<T> {
  const lockRelative = `${OFFICE_ARTIFACTS_DIR}/.${stem}.lock`;
  const lockPath = NodePath.join(realRoot, ...lockRelative.split("/"));
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  let acquired = false;
  while (!acquired) {
    try {
      const handle = await openInside(
        realRoot,
        lockRelative,
        NodeFS.constants.O_CREAT | NodeFS.constants.O_EXCL | NodeFS.constants.O_WRONLY,
      );
      try {
        await handle.writeFile(`${process.pid}:${Date.now()}\n`, "utf8");
      } finally {
        await handle.close().catch(() => undefined);
      }
      acquired = true;
    } catch (error: unknown) {
      const code = (error as NodeJS.ErrnoException | null)?.code;
      if (code !== "EEXIST") throw error;
      const stat = await NodeFSP.lstat(lockPath).catch(() => null);
      if (stat !== null && stat.isFile() && Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
        await NodeFSP.unlink(lockPath).catch(() => undefined);
        continue;
      }
      if (Date.now() >= deadline) {
        throw invalid(`Sheet ${stem} is currently being written by another process. Try again.`);
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  try {
    return await run();
  } finally {
    await NodeFSP.unlink(lockPath).catch(() => undefined);
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
  return oneWriteAtATime(`${realRoot}\0${stem}`, () =>
    withCrossProcessLock(realRoot, stem, async () => {
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
      const target = NodePath.join(realRoot, ...relativePath.split("/"));
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
