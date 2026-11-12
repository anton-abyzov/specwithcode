// @effect-diagnostics nodeBuiltinImport:off - exclusive create, no-follow opens, positional reads and statfs.
/**
 * One file moved between two of the owner's machines: what may move, where it
 * may land, and writing it so a partial or tampered copy never appears under
 * its final name. Both sides use this; the MCP tools only carry the bytes.
 */
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { MAX_SECRET_FILE_BYTES } from "../folderTransfer/secrets.ts";
import { exposesProtectedFolder } from "../../project/ProjectEnvironmentPaths.ts";
import {
  isSecretLikeProjectPath,
  isUntrackedSecretConfigPath,
} from "../../workspace/WorkspaceSensitivePaths.ts";

/** Base64 of this fits a fleet MCP request and answer with room to spare. */
export const CHUNK_BYTES = 2 * 1024 * 1024;
export const MAX_FILE_BYTES = 4 * 1024 * 1024 * 1024;
export { MAX_SECRET_FILE_BYTES };
/** A machine must keep this much free after receiving a file. */
export const FREE_SPACE_MARGIN_BYTES = 1024 * 1024 * 1024;
const SNIFF_BYTES = 64 * 1024;
const STAGING = ".staging";
const NEVER_MOVED_SEGMENTS = new Set([".git", ".specwithcode", ".specweave-studio"]);
const STAGING_MAX_AGE_MS = 24 * 60 * 60 * 1000;

const CREDENTIAL_CONTENT =
  /"private_key"\s*:|"client_secret"\s*:|-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/u;
/** Undefined on Windows, where the open simply follows; the identity check still applies. */
const NO_FOLLOW = NodeFS.constants.O_NOFOLLOW ?? 0;

export class FileTransferRefusal extends Error {}

const GIB = 1024 * 1024 * 1024;
const MIB = 1024 * 1024;
export const formatBytes = (bytes: number) =>
  bytes >= GIB ? `${(bytes / GIB).toFixed(1)} GB` : `${Math.ceil(bytes / MIB)} MB`;

export const chunkCount = (size: number) => Math.max(1, Math.ceil(size / CHUNK_BYTES));

export const inboxFolder = (stateDir: string) => NodePath.join(stateDir, "transfers");

/** `~/x` means this machine's home, so one path can name a file on either side. */
export const expandHome = (path: string, home = NodeOS.homedir()) =>
  path === "~" || path.startsWith("~/") ? NodePath.join(home, path.slice(1)) : path;

export const isWithin = (root: string, value: string) => {
  const relative = NodePath.relative(root, value);
  return (
    relative === "" ||
    (!NodePath.isAbsolute(relative) &&
      relative !== ".." &&
      !relative.startsWith(`..${NodePath.sep}`))
  );
};

/** The real form of each folder that exists; a missing one reaches nothing. */
export const realRoots = async (roots: ReadonlyArray<string>) => {
  const found = await Promise.all(roots.map((root) => NodeFSP.realpath(root).catch(() => null)));
  return found.filter((root): root is string => root !== null);
};

/** A regular file by its real path, however the caller spelled it. */
export const resolveFile = async (asked: string) => {
  const expanded = expandHome(asked);
  if (!NodePath.isAbsolute(expanded))
    throw new FileTransferRefusal(`Name the file by its absolute path, not ${asked}.`);
  const real = await NodeFSP.realpath(expanded).catch(() => null);
  if (real === null) throw new FileTransferRefusal(`${asked} does not exist on that machine.`);
  const stat = await NodeFSP.stat(real);
  if (!stat.isFile())
    throw new FileTransferRefusal(
      `${asked} is not a regular file. To put a whole project folder on that machine, call studio_project_add_to_machine with its projectId; for any other folder, archive it first and send the archive.`,
    );
  if (stat.size > MAX_FILE_BYTES)
    throw new FileTransferRefusal(`${asked} is ${formatBytes(stat.size)}; the limit is 4 GB.`);
  return { real, size: stat.size };
};

const secretByName = (real: string) => {
  const relative = real.split(NodePath.sep).filter(Boolean).join("/");
  return isSecretLikeProjectPath(relative) || isUntrackedSecretConfigPath(relative);
};

const holdsCredential = (bytes: Uint8Array) =>
  CREDENTIAL_CONTENT.test(Buffer.from(bytes).toString("latin1"));

/** One file as it was checked: every later read must still be this same file, unchanged. */
export interface PinnedFile {
  readonly real: string;
  readonly dev: number;
  readonly ino: number;
  readonly size: number;
  readonly mtimeMs: number;
  /** By name, as folder copy decides, or by what the file holds: a key file can be named anything. */
  readonly secret: boolean;
}

const sniff = async (handle: NodeFSP.FileHandle) => {
  const buffer = Buffer.alloc(SNIFF_BYTES);
  const { bytesRead } = await handle.read(buffer, 0, SNIFF_BYTES, 0);
  return holdsCredential(buffer.subarray(0, bytesRead));
};

/** Checks the file through one open descriptor, so a swap cannot split the check from the file. */
export const pinFile = async (real: string): Promise<PinnedFile> => {
  const handle = await NodeFSP.open(real, NodeFS.constants.O_RDONLY | NO_FOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new FileTransferRefusal(`${real} is not a regular file.`);
    return {
      real,
      dev: stat.dev,
      ino: stat.ino,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      secret: secretByName(real) || (await sniff(handle)),
    };
  } finally {
    await handle.close();
  }
};

export const looksSecret = async (real: string) => (await pinFile(real)).secret;

const openPinned = async (pin: PinnedFile) => {
  const handle = await NodeFSP.open(pin.real, NodeFS.constants.O_RDONLY | NO_FOLLOW).catch(() => {
    throw new FileTransferRefusal(`${pin.real} changed during the transfer. Start it again.`);
  });
  const stat = await handle.stat();
  if (
    stat.dev !== pin.dev ||
    stat.ino !== pin.ino ||
    stat.size !== pin.size ||
    stat.mtimeMs !== pin.mtimeMs
  ) {
    await handle.close();
    throw new FileTransferRefusal(`${pin.real} changed during the transfer. Start it again.`);
  }
  return handle;
};

export const sha256Pinned = async (pin: PinnedFile) => {
  const handle = await openPinned(pin);
  try {
    const hash = NodeCrypto.createHash("sha256");
    for await (const part of handle.createReadStream({ autoClose: false }))
      hash.update(part as Buffer);
    return hash.digest("hex");
  } finally {
    await handle.close();
  }
};

export const sha256File = async (real: string) => sha256Pinned(await pinFile(real));

/**
 * One chunk of the file that was checked. A chunk of a plain file that holds a
 * credential is refused here too: such a file was declared plain only by what
 * its first bytes showed.
 */
export const readPinned = async (pin: PinnedFile, index: number) => {
  const handle = await openPinned(pin);
  try {
    const buffer = Buffer.alloc(CHUNK_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, CHUNK_BYTES, index * CHUNK_BYTES);
    const bytes = buffer.subarray(0, bytesRead);
    if (!pin.secret && holdsCredential(bytes))
      throw new FileTransferRefusal(
        `${pin.real} holds a credential past its start, so it was not sent. Nothing secret left this machine.`,
      );
    return bytes;
  } finally {
    await handle.close();
  }
};

/** The deepest part of a path that exists, as a real path, and the names still to create. */
const nearestExisting = async (path: string) => {
  let existing = path;
  const missing: string[] = [];
  for (;;) {
    const real = await NodeFSP.realpath(existing).catch(() => null);
    if (real !== null) return { existing: real, missing };
    const parent = NodePath.dirname(existing);
    if (parent === existing) return { existing, missing };
    missing.unshift(NodePath.basename(existing));
    existing = parent;
  }
};

/**
 * Checks a file resolved earlier and confirms the name still leads there: a
 * folder swapped between the two could otherwise pass a key off as plain.
 */
export const pinResolved = async (real: string) => {
  const pin = await pinFile(real);
  if ((await NodeFSP.realpath(real).catch(() => null)) !== real)
    throw new FileTransferRefusal(`${real} changed during the transfer. Start it again.`);
  return pin;
};

/**
 * Credential folders and this app's own state never move, whoever asks: reaching
 * another machine goes through a grant, not a copied key. The app's own working
 * folders are ordinary files and stay usable.
 */
export const isCredentialLocation = async (real: string, baseDir: string, stateDir: string) => {
  const baseReal = await NodeFSP.realpath(baseDir).catch(() => baseDir);
  const stateReal = await NodeFSP.realpath(stateDir).catch(() => stateDir);
  const working = [
    inboxFolder(stateDir),
    inboxFolder(stateReal),
    ...[baseDir, baseReal].flatMap((base) => [
      NodePath.join(base, "worktrees"),
      NodePath.join(base, "scratch"),
      NodePath.join(base, "projects"),
    ]),
    // Older installs keep checkouts beside the machine's own folder.
    NodePath.join(NodePath.dirname(baseReal), "worktrees"),
  ];
  // A checkout can hold a nested app home, secrets and all, so what counts is the path below the working folder.
  const root = working.find((candidate) => isWithin(candidate, real));
  const below = root === undefined ? real : NodePath.relative(root, real);
  if (below.split(NodePath.sep).some((segment) => NEVER_MOVED_SEGMENTS.has(segment))) return true;
  if (root !== undefined) return false;
  if (isWithin(baseDir, real) || isWithin(baseReal, real)) return true;
  // A destination's folders may not exist yet; what exists above them decides.
  const { existing } = await nearestExisting(NodePath.dirname(real));
  return exposesProtectedFolder(existing, NodeOS.homedir(), NodePath);
};

/** Refuses a file that would leave `machine` short of space, naming both sizes. */
export const assertRoomFor = async (path: string, size: number, machine: string) => {
  const { existing } = await nearestExisting(path);
  const stats = await NodeFSP.statfs(existing);
  const free = Number(stats.bavail) * Number(stats.bsize);
  if (free < size + FREE_SPACE_MARGIN_BYTES)
    throw new FileTransferRefusal(
      `${machine} has ${formatBytes(free)} free at ${existing}. This file needs ${formatBytes(size)} plus ${formatBytes(FREE_SPACE_MARGIN_BYTES)} kept free. Clear space there, or rebuild the file where there is room.`,
    );
};

/** A file name that cannot climb out of the folder it lands in. */
export const safeFileName = (name: string) => {
  const base = NodePath.basename(name.replaceAll("\\", "/"));
  if (base === "" || base === "." || base === "..")
    throw new FileTransferRefusal(`${name} is not a file name.`);
  return base;
};

/**
 * Where a received file lands: the named place when it is inside `roots` and
 * does not exist yet, otherwise a new folder of its own in the inbox.
 */
export const landingPath = async (input: {
  readonly name: string;
  readonly destinationPath?: string | undefined;
  readonly roots: ReadonlyArray<string>;
  readonly inbox: string;
  readonly id: string;
}) => {
  if (input.destinationPath === undefined)
    return NodePath.join(input.inbox, input.id, safeFileName(input.name));
  const wanted = NodePath.normalize(expandHome(input.destinationPath));
  if (!NodePath.isAbsolute(wanted))
    throw new FileTransferRefusal(
      `Name the destination by its absolute path, not ${input.destinationPath}.`,
    );
  // Nothing is created until the deepest folder that exists is known to be allowed.
  const { existing, missing } = await nearestExisting(NodePath.dirname(wanted));
  const real = NodePath.join(existing, ...missing, NodePath.basename(wanted));
  const refused = real.split(NodePath.sep).includes(".git");
  if (refused || !input.roots.some((root) => isWithin(root, real)))
    throw new FileTransferRefusal(
      `${input.destinationPath} is outside what this transfer may write. Omit destinationPath to receive it in the transfer inbox.`,
    );
  return real;
};

/**
 * Writes a file in the inbox's staging folder, then puts it at its final name
 * in one step: a file already there is never replaced, and a wrong hash or a
 * restart leaves nothing in the project. Staged files nobody finished are
 * swept by `sweepStaging`.
 */
export class IncomingFile {
  private written = 0;
  private readonly final: string;
  private readonly partial: string;
  private readonly handle: NodeFSP.FileHandle;
  private readonly size: number;
  private readonly secret: boolean;

  private constructor(
    final: string,
    partial: string,
    handle: NodeFSP.FileHandle,
    size: number,
    secret: boolean,
  ) {
    this.final = final;
    this.partial = partial;
    this.handle = handle;
    this.size = size;
    this.secret = secret;
  }

  static async open(input: {
    readonly final: string;
    readonly size: number;
    readonly secret: boolean;
    readonly inbox: string;
  }) {
    if (await NodeFSP.lstat(input.final).catch(() => null))
      throw new FileTransferRefusal(`${input.final} already exists; nothing was overwritten.`);
    const staging = NodePath.join(input.inbox, STAGING);
    await NodeFSP.mkdir(staging, { recursive: true, mode: 0o700 });
    const partial = NodePath.join(staging, NodeCrypto.randomUUID());
    const handle = await NodeFSP.open(
      partial,
      NodeFS.constants.O_CREAT | NodeFS.constants.O_EXCL | NodeFS.constants.O_WRONLY | NO_FOLLOW,
      input.secret ? 0o600 : 0o644,
    );
    return new IncomingFile(input.final, partial, handle, input.size, input.secret);
  }

  /** Index-addressed, so a chunk sent twice after a lost answer writes the same bytes. */
  async write(index: number, bytes: Uint8Array) {
    const offset = index * CHUNK_BYTES;
    if (offset + bytes.byteLength > this.size)
      throw new FileTransferRefusal("The file came out longer than announced.");
    await this.handle.write(bytes, 0, bytes.byteLength, offset);
    this.written = Math.max(this.written, offset + bytes.byteLength);
  }

  async finish(expectedSha256: string | null) {
    try {
      await this.handle.sync();
      await this.handle.close();
      if (this.written !== this.size)
        throw new FileTransferRefusal("The file arrived incomplete; nothing was kept.");
      if (expectedSha256 !== null && (await sha256File(this.partial)) !== expectedSha256)
        throw new FileTransferRefusal("The file arrived changed; its hash differs. Nothing kept.");
      // Sniffed before it has a name anyone can read: a secret arrives declared, or not at all.
      if (!this.secret && (secretByName(this.final) || (await pinFile(this.partial)).secret))
        throw new FileTransferRefusal(
          "The file looks like a secret but was not sent as one, so it was not kept.",
        );
      await NodeFSP.mkdir(NodePath.dirname(this.final), { recursive: true, mode: 0o700 });
      await NodeFSP.link(this.partial, this.final).catch(async (cause: NodeJS.ErrnoException) => {
        if (cause.code === "EEXIST")
          throw new FileTransferRefusal(`${this.final} already exists; nothing was overwritten.`);
        if (cause.code !== "EXDEV") throw cause;
        // Another volume: copied beside the final name first, so a crash leaves no partial file there.
        const beside = `${this.final}.${NodeCrypto.randomUUID()}.partial`;
        try {
          await NodeFSP.copyFile(this.partial, beside, NodeFS.constants.COPYFILE_EXCL);
          await NodeFSP.link(beside, this.final);
        } catch (failure) {
          if ((failure as NodeJS.ErrnoException).code === "EEXIST")
            throw new FileTransferRefusal(`${this.final} already exists; nothing was overwritten.`);
          throw failure;
        } finally {
          await NodeFSP.rm(beside, { force: true });
        }
      });
    } finally {
      await this.handle.close().catch(() => undefined);
      await NodeFSP.rm(this.partial, { force: true });
    }
    return this.final;
  }

  async abandon() {
    await this.handle.close().catch(() => undefined);
    await NodeFSP.rm(this.partial, { force: true });
  }
}

/** Removes staged files a restart or a lost connection left behind. */
export const sweepStaging = async (inbox: string, now: number) => {
  const staging = NodePath.join(inbox, STAGING);
  const names = await NodeFSP.readdir(staging).catch(() => []);
  await Promise.all(
    names.map(async (name) => {
      const path = NodePath.join(staging, name);
      const stat = await NodeFSP.stat(path).catch(() => null);
      if (stat !== null && now - stat.mtimeMs > STAGING_MAX_AGE_MS)
        await NodeFSP.rm(path, { force: true });
    }),
  );
};
