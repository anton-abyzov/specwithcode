// @effect-diagnostics nodeBuiltinImport:off globalDate:off - Plain promises over a design system's stored files, like DesignStore.
/**
 * The files a design system keeps beside `system.json`: its README, docs,
 * fonts and asset sets, in `systems/<id>/files/` under the owner's design
 * root. A set of assets is a folder, so the folders are the source of truth.
 *
 * A path is relative to `files/`, `/` separated, at most
 * `DESIGN_SYSTEM_FILE_PATH_MAX_DEPTH` names deep. Each name starts with a
 * letter or digit and holds only letters, digits, spaces, `.`, `_`, `(`, `)`
 * and `-`, so `..`, dot files and absolute paths cannot be named; the file
 * ends in an allowed extension. Folders on the way are checked with lstat, so
 * a linked `files` folder or asset set is refused; files are opened with
 * O_NOFOLLOW, and a write lands through a temp file and a rename. Writers hold
 * the system's lock, so the size and count limits hold across uploads.
 *
 * Failures are `DesignStoreProblem` with a `DesignError` code.
 */
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import {
  DESIGN_SYSTEM_FILE_EXTENSIONS,
  DESIGN_SYSTEM_FILE_MAX_BYTES,
  DESIGN_SYSTEM_FILE_PATH_MAX_DEPTH,
  DESIGN_SYSTEM_FILE_PATH_MAX_LENGTH,
  DESIGN_SYSTEM_FILES_MAX_BYTES,
  DESIGN_SYSTEM_FILES_MAX_COUNT,
  type DesignSystemFile,
} from "@specweave-studio/contracts";

import * as Store from "../DesignStore.ts";

const SYSTEM_FILES_DIR = "files";

type Extension = (typeof DESIGN_SYSTEM_FILE_EXTENSIONS)[number];

const MIME_TYPES: Readonly<Record<Extension, string>> = {
  md: "text/markdown",
  txt: "text/plain",
  json: "application/json",
  css: "text/css",
  html: "text/html",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  ico: "image/x-icon",
  avif: "image/avif",
  pdf: "application/pdf",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
};
const TEXT_EXTENSIONS: ReadonlySet<string> = new Set(["md", "txt", "json", "css", "html", "svg"]);
const EXTENSIONS: ReadonlySet<string> = new Set(DESIGN_SYSTEM_FILE_EXTENSIONS);

const NAME = /^[A-Za-z0-9][A-Za-z0-9 ._()-]{0,119}$/;
/** Names agents and package tools read as instructions or code, never stored here. */
const RESERVED_NAMES: ReadonlySet<string> = new Set([
  "agents.md",
  "claude.md",
  "gemini.md",
  "node_modules",
]);
const SYSTEM_ID = /^[A-Za-z0-9_-]{1,80}$/;
// Windows has no O_NOFOLLOW, so there the open alone would follow a link.
const NO_FOLLOW = NodeFS.constants.O_NOFOLLOW as number | undefined;
const OPEN_FLAGS = NodeFS.constants.O_RDONLY | (NO_FOLLOW ?? 0);

const extensionOf = (path: string) => {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot + 1).toLowerCase();
};

/** The type a stored file is served as, from its extension. */
export const systemFileMimeType = (path: string): string =>
  MIME_TYPES[extensionOf(path) as Extension] ?? "application/octet-stream";

/** Text files are read as UTF-8; everything else is binary. */
export const isTextSystemFile = (path: string): boolean => TEXT_EXTENSIONS.has(extensionOf(path));

const invalid = (detail: string) => new Store.DesignStoreProblem("invalid", detail);

const isMissing = (error: unknown) =>
  (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";

const lstatOrNull = (path: string) =>
  NodeFSP.lstat(path).catch((error: unknown) => {
    if (isMissing(error)) return null;
    throw error;
  });

const nameProblem = (name: string): string | null => {
  if (name === "") return "A path cannot have an empty folder name.";
  if (name === "." || name === "..") return "A path cannot leave the design system's files.";
  if (!NAME.test(name) || /[. ]$/.test(name)) {
    return `"${name}" is not an allowed name. Use letters, digits, spaces, dots, dashes, underscores and brackets, starting with a letter or digit.`;
  }
  if (RESERVED_NAMES.has(name.toLowerCase())) return `"${name}" is a reserved name.`;
  return null;
};

/** Why `path` cannot name a stored file, or null when it can. */
function pathProblem(path: string): string | null {
  if (path.length === 0 || path.length > DESIGN_SYSTEM_FILE_PATH_MAX_LENGTH) {
    return `A path has 1 to ${DESIGN_SYSTEM_FILE_PATH_MAX_LENGTH} characters.`;
  }
  if (path.includes("\\") || path.includes("\0")) return "Separate folders with /.";
  if (path.startsWith("/"))
    return "Name a file inside the design system's files, not an absolute path.";
  const names = path.split("/");
  if (names.length > DESIGN_SYSTEM_FILE_PATH_MAX_DEPTH) {
    return `Files are kept at most ${DESIGN_SYSTEM_FILE_PATH_MAX_DEPTH} folders deep.`;
  }
  for (const name of names) {
    const problem = nameProblem(name);
    if (problem !== null) return problem;
  }
  if (!EXTENSIONS.has(extensionOf(path))) {
    return `${names.at(-1)} cannot be stored here. Allowed types: ${DESIGN_SYSTEM_FILE_EXTENSIONS.join(", ")}.`;
  }
  return null;
}

/** The names of a stored file's path; `invalid` when it cannot name one. */
function checkPath(path: string): string[] {
  const problem = pathProblem(path);
  if (problem !== null) throw invalid(problem);
  return path.split("/");
}

const notPlain = (relative: string) =>
  invalid(`${relative} must be a folder, not a link or a file.`);

/** True when `path` is a plain folder, false when missing (made first with `create`). */
async function plainFolder(path: string, label: string, create: boolean): Promise<boolean> {
  let stat = await lstatOrNull(path);
  if (stat === null) {
    if (!create) return false;
    await NodeFSP.mkdir(path).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    });
    stat = await lstatOrNull(path);
  }
  if (stat === null || stat.isSymbolicLink() || !stat.isDirectory()) throw notPlain(label);
  return true;
}

/** `systems/<id>` below the design root, holding a `system.json`; `not_found` otherwise. */
async function systemFolder(root: string, systemId: string): Promise<string> {
  if (!SYSTEM_ID.test(systemId) || systemId === Store.DESIGN_SYSTEMS_DIR) {
    throw invalid(`${systemId} is not a valid design system id.`);
  }
  const missing = () => new Store.DesignStoreProblem("not_found", `No design system ${systemId}.`);
  const systems = NodePath.join(root, Store.DESIGN_SYSTEMS_DIR);
  if (!(await plainFolder(systems, Store.DESIGN_SYSTEMS_DIR, false))) throw missing();
  const folder = NodePath.join(systems, systemId);
  if (!(await plainFolder(folder, `${Store.DESIGN_SYSTEMS_DIR}/${systemId}`, false))) {
    throw missing();
  }
  const head = await lstatOrNull(NodePath.join(folder, Store.DESIGN_SYSTEM_FILE));
  if (head === null || !head.isFile()) throw missing();
  return folder;
}

/** The system's real `files` folder, or null when it has none yet (made with `create`). */
async function filesFolder(root: string, systemId: string, create: boolean) {
  const files = NodePath.join(await systemFolder(root, systemId), SYSTEM_FILES_DIR);
  if (!(await plainFolder(files, SYSTEM_FILES_DIR, create))) return null;
  return NodeFSP.realpath(files);
}

/**
 * How `name` is spelled on disk in `folder`. A case-insensitive disk finds `Assets` for
 * `assets`; joining the spelling asked for would then fail the realpath check in assertUnmoved.
 */
async function onDiskName(folder: string, name: string): Promise<string> {
  if ((await lstatOrNull(NodePath.join(folder, name))) === null) return name;
  const entries = await NodeFSP.readdir(folder);
  if (entries.includes(name)) return name;
  const lower = name.toLowerCase();
  return entries.find((entry) => entry.toLowerCase() === lower) ?? name;
}

/** The folder holding the file `names` names, each folder checked; null at the first missing one. */
async function parentFolder(files: string, names: readonly string[], create: boolean) {
  let current = files;
  for (const [index, name] of names.slice(0, -1).entries()) {
    current = NodePath.join(current, await onDiskName(current, name));
    const label = `${SYSTEM_FILES_DIR}/${names.slice(0, index + 1).join("/")}`;
    if (!(await plainFolder(current, label, create))) return null;
  }
  return current;
}

/** A folder swapped for a link after it was checked is refused, not written through. */
async function assertUnmoved(folder: string, files: string) {
  const real = await NodeFSP.realpath(folder);
  if (real !== folder) throw notPlain(NodePath.relative(NodePath.dirname(files), folder));
}

const entryOf = (path: string, stat: NodeFS.Stats): DesignSystemFile => ({
  path,
  origin: "stored",
  bytes: stat.size,
  mimeType: systemFileMimeType(path),
  updatedAt: stat.mtime.toISOString(),
});

/** Removes the folders of `names` that are left empty, deepest first, never `files` itself. */
async function removeEmptyFolders(files: string, names: readonly string[]) {
  for (let depth = names.length - 1; depth > 0; depth -= 1) {
    try {
      await NodeFSP.rmdir(NodePath.join(files, ...names.slice(0, depth)));
    } catch {
      return;
    }
  }
}

/** Writes `bytes` as the file `names` names below `files`, through a temp file and a rename. */
async function writeInto(files: string, names: readonly string[], bytes: Uint8Array) {
  const parent = (await parentFolder(files, names, true))!;
  const name = names.at(-1)!;
  const target = NodePath.join(parent, name);
  const existing = await lstatOrNull(target);
  if (existing !== null && !existing.isFile()) {
    throw invalid(`${names.join("/")} is a folder or a link, not a file.`);
  }
  if (existing !== null && !(await NodeFSP.readdir(parent)).includes(name)) {
    // A case-insensitive disk found another file whose name differs only in case.
    throw new Store.DesignStoreProblem(
      "conflict",
      `A file whose name differs from ${name} only in case is already stored. Rename one of them.`,
    );
  }
  await assertUnmoved(parent, files);
  const temp = NodePath.join(parent, `.${name}.${NodeCrypto.randomUUID()}.tmp`);
  try {
    await NodeFSP.writeFile(temp, bytes, { flag: "wx", mode: 0o644 });
    await NodeFSP.rename(temp, target);
  } finally {
    await NodeFSP.rm(temp, { force: true }).catch(() => undefined);
  }
  return NodeFSP.lstat(target);
}

/**
 * The stored files, sorted by path, with their total size. Links, dot files,
 * names that could not be stored and anything past the count limit are left
 * out, so a checkout cannot list files outside the folder.
 */
export async function listSystemFiles(
  root: string,
  systemId: string,
): Promise<{ readonly files: DesignSystemFile[]; readonly usedBytes: number }> {
  const files = await filesFolder(root, systemId, false);
  if (files === null) return { files: [], usedBytes: 0 };
  const listed: DesignSystemFile[] = [];
  const walk = async (folder: string, names: readonly string[]): Promise<void> => {
    const entries = await NodeFSP.readdir(folder, { withFileTypes: true });
    entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
    for (const entry of entries) {
      if (listed.length >= DESIGN_SYSTEM_FILES_MAX_COUNT) return;
      if (nameProblem(entry.name) !== null) continue;
      const path = [...names, entry.name];
      if (entry.isDirectory()) {
        if (path.length < DESIGN_SYSTEM_FILE_PATH_MAX_DEPTH) {
          await walk(NodePath.join(folder, entry.name), path);
        }
        continue;
      }
      if (!entry.isFile() || pathProblem(path.join("/")) !== null) continue;
      const stat = await lstatOrNull(NodePath.join(folder, entry.name));
      if (stat?.isFile()) listed.push(entryOf(path.join("/"), stat));
    }
  };
  await walk(files, []);
  listed.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  return { files: listed, usedBytes: listed.reduce((sum, file) => sum + file.bytes, 0) };
}

/** One stored file's bytes; `not_found` when missing, `invalid` for a link or a folder. */
export async function readSystemFile(
  root: string,
  systemId: string,
  path: string,
): Promise<{ readonly file: DesignSystemFile; readonly bytes: Buffer }> {
  const names = checkPath(path);
  const missing = () => new Store.DesignStoreProblem("not_found", `No file ${path}.`);
  const files = await filesFolder(root, systemId, false);
  const parent = files === null ? null : await parentFolder(files, names, false);
  if (parent === null) throw missing();
  const target = NodePath.join(parent, names.at(-1)!);
  // Without O_NOFOLLOW, refuse a link by lstat first, then check after the open that the
  // handle is that same entry, so a file swapped for a link in between is refused too.
  const seen =
    NO_FOLLOW === undefined
      ? await NodeFSP.lstat(target, { bigint: true }).catch((error: unknown) => {
          if (isMissing(error)) throw missing();
          throw error;
        })
      : null;
  if (seen?.isSymbolicLink()) throw invalid(`${path} is a link.`);
  let handle: NodeFSP.FileHandle;
  try {
    handle = await NodeFSP.open(target, OPEN_FLAGS);
  } catch (error) {
    if (isMissing(error)) throw missing();
    if ((error as NodeJS.ErrnoException).code === "ELOOP") throw invalid(`${path} is a link.`);
    throw error;
  }
  try {
    if (seen !== null) {
      const opened = await handle.stat({ bigint: true });
      if (opened.ino !== seen.ino || opened.dev !== seen.dev) throw invalid(`${path} is a link.`);
    }
    const stat = await handle.stat();
    if (!stat.isFile()) throw invalid(`${path} is not a file.`);
    if (stat.size > DESIGN_SYSTEM_FILE_MAX_BYTES) {
      throw new Store.DesignStoreProblem("too_large", `${path} is over 10 MiB.`);
    }
    // One byte past the size seen, so a file that grew since fstat is still capped.
    const buffer = Buffer.alloc(stat.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > DESIGN_SYSTEM_FILE_MAX_BYTES) {
      throw new Store.DesignStoreProblem("too_large", `${path} is over 10 MiB.`);
    }
    return { file: { ...entryOf(path, stat), bytes: length }, bytes: buffer.subarray(0, length) };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/** How many files, and how many bytes in all, one system may keep. */
interface SystemFileLimits {
  readonly maxFiles: number;
  readonly maxBytes: number;
}

const SYSTEM_FILE_LIMITS: SystemFileLimits = {
  maxFiles: DESIGN_SYSTEM_FILES_MAX_COUNT,
  maxBytes: DESIGN_SYSTEM_FILES_MAX_BYTES,
};

const sizeLabel = (bytes: number) => {
  for (const [unit, size] of [
    ["GiB", 1024 ** 3],
    ["MiB", 1024 ** 2],
    ["KiB", 1024],
  ] as const) {
    if (bytes >= size) return `${Number((bytes / size).toFixed(1))} ${unit}`;
  }
  return `${bytes} bytes`;
};

/**
 * Writes or replaces one stored file, making its folders, within the size and
 * count limits (`limits` is a test seam).
 */
export async function putSystemFile(
  root: string,
  systemId: string,
  path: string,
  bytes: Uint8Array,
  limits: SystemFileLimits = SYSTEM_FILE_LIMITS,
): Promise<DesignSystemFile> {
  const names = checkPath(path);
  if (bytes.byteLength > DESIGN_SYSTEM_FILE_MAX_BYTES) {
    throw new Store.DesignStoreProblem("too_large", "A stored file may be at most 10 MiB.");
  }
  await systemFolder(root, systemId);
  return Store.withDesignSystemLock(root, systemId, async () => {
    const files = (await filesFolder(root, systemId, true))!;
    const { files: listed, usedBytes } = await listSystemFiles(root, systemId);
    const previous = listed.find((file) => file.path === path);
    if (previous === undefined && listed.length >= limits.maxFiles) {
      throw new Store.DesignStoreProblem(
        "too_large",
        `A design system keeps at most ${limits.maxFiles.toLocaleString("en-US")} files. Delete some first.`,
      );
    }
    if (usedBytes - (previous?.bytes ?? 0) + bytes.byteLength > limits.maxBytes) {
      throw new Store.DesignStoreProblem(
        "too_large",
        `This design system's files would be over ${sizeLabel(limits.maxBytes)}. Delete some first.`,
      );
    }
    try {
      return entryOf(path, await writeInto(files, names, bytes));
    } catch (error) {
      await removeEmptyFolders(files, names);
      throw error;
    }
  });
}

/** Removes one stored file and the folders it leaves empty. False when it is already gone. */
export async function deleteSystemFile(
  root: string,
  systemId: string,
  path: string,
): Promise<boolean> {
  const names = checkPath(path);
  await systemFolder(root, systemId);
  return Store.withDesignSystemLock(root, systemId, async () => {
    const files = await filesFolder(root, systemId, false);
    const parent = files === null ? null : await parentFolder(files, names, false);
    if (files === null || parent === null) return false;
    const target = NodePath.join(parent, names.at(-1)!);
    const stat = await lstatOrNull(target);
    if (stat === null) return false;
    if (!stat.isFile()) throw invalid(`${path} is a folder or a link, not a file.`);
    await assertUnmoved(parent, files);
    await NodeFSP.unlink(target);
    await removeEmptyFolders(files, names);
    return true;
  });
}

/** Renames a stored file or moves it to another folder; never over another file. */
export async function moveSystemFile(
  root: string,
  systemId: string,
  from: string,
  to: string,
): Promise<DesignSystemFile> {
  const fromNames = checkPath(from);
  const toNames = checkPath(to);
  await systemFolder(root, systemId);
  return Store.withDesignSystemLock(root, systemId, async () => {
    const files = await filesFolder(root, systemId, false);
    const fromParent = files === null ? null : await parentFolder(files, fromNames, false);
    const source = fromParent === null ? null : NodePath.join(fromParent, fromNames.at(-1)!);
    const stat = source === null ? null : await lstatOrNull(source);
    if (files === null || fromParent === null || source === null || stat === null) {
      throw new Store.DesignStoreProblem("not_found", `No file ${from}.`);
    }
    if (!stat.isFile()) throw invalid(`${from} is a folder or a link, not a file.`);
    if (from === to) return entryOf(to, stat);
    const toParent = (await parentFolder(files, toNames, true))!;
    try {
      const target = NodePath.join(toParent, toNames.at(-1)!);
      const existing = await lstatOrNull(target);
      // The same file under another case, on a case-insensitive disk, is a rename.
      if (existing !== null && (existing.dev !== stat.dev || existing.ino !== stat.ino)) {
        throw new Store.DesignStoreProblem("conflict", `${to} already exists.`);
      }
      await assertUnmoved(fromParent, files);
      await assertUnmoved(toParent, files);
      await NodeFSP.rename(source, target);
      await removeEmptyFolders(files, fromNames);
      return entryOf(to, await NodeFSP.lstat(target));
    } catch (error) {
      await removeEmptyFolders(files, toNames);
      throw error;
    }
  });
}

/**
 * Copies every stored file of one system to another (a copy or a move of the
 * system). Plain files only, as listed; a file that cannot be read is skipped.
 */
export async function copySystemFiles(
  from: { readonly root: string; readonly systemId: string },
  to: { readonly root: string; readonly systemId: string },
): Promise<void> {
  const { files: listed } = await listSystemFiles(from.root, from.systemId);
  if (listed.length === 0) return;
  await systemFolder(to.root, to.systemId);
  await Store.withDesignSystemLock(to.root, to.systemId, async () => {
    const files = (await filesFolder(to.root, to.systemId, true))!;
    for (const file of listed) {
      const read = await readSystemFile(from.root, from.systemId, file.path).catch(() => null);
      if (read !== null) await writeInto(files, file.path.split("/"), read.bytes);
    }
  });
}
