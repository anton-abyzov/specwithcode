// @effect-diagnostics nodeBuiltinImport:off - Plain promises over design folders, like DesignStore.
/**
 * Moving a Playground design into a project (`design.move`). Unlike a copy,
 * the design keeps its id, revision, autosave history, named versions,
 * comments, assets, access and thread binding. Under the source design's lock:
 *
 *   1. read the head and compare `expectedRevision`;
 *   2. `prepare` (the service copies in the design system the target lacks);
 *   3. copy the folder into `<target>/.incoming-<id>-<uuid>`: plain folders and
 *      regular files only, checked with lstat, so a link anywhere inside is
 *      refused; the lock is left behind;
 *   4. write the forward record `<playground>/.moved/<id>.json`;
 *   5. rename the staging folder to `<target>/<id>`;
 *   6. remove the source the way delete does.
 *
 * The folder is always copied, never renamed: a rename would carry the held
 * lock into the target, and fails across volumes (EXDEV). A Playground design
 * whose forward record names a project that holds it counts as moved (see
 * `DesignService`), and the record lands before the copy is placed, so there
 * is no moment when both copies can be edited. Every step can run again: a
 * retry after a failure part way finishes the move, and a retry after a move
 * that finished returns the moved design.
 */
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import {
  DesignActor,
  DesignId,
  DesignOwnerInput,
  type DesignDocument,
  type DesignOwner,
} from "@specweave-studio/contracts";
import * as Schema from "effect/Schema";

import * as Store from "./DesignStore.ts";

export const DESIGN_MOVED_DIR = Store.DESIGN_MOVED_DIR;
const INCOMING = ".incoming-";
/** A design system's stored files (README, docs, fonts, asset sets). */
const SYSTEM_FILES_DIR = "files";

/** `<playground>/.moved/<id>.json`: where a Playground design went. */
export const DesignForward = Schema.Struct({
  to: DesignOwnerInput,
  designId: DesignId,
  movedAt: Schema.String,
  actor: DesignActor,
});
export type DesignForward = typeof DesignForward.Type;

const decodeForward = Schema.decodeUnknownSync(DesignForward);
const isDesignId = Schema.is(DesignId);

const isMissing = (error: unknown) =>
  (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";

const lstatOrNull = (path: string) =>
  NodeFSP.lstat(path).catch((error: unknown) => {
    if (isMissing(error)) return null;
    throw error;
  });

const notFoundAsNull = <A>(promise: Promise<A>) =>
  promise.catch((error: unknown) => {
    if (error instanceof Store.DesignStoreProblem && error.code === "not_found") return null;
    throw error;
  });

const sameOwner = (left: DesignOwner, right: DesignOwner) =>
  left.kind === right.kind &&
  left.environmentId === right.environmentId &&
  (left.kind === "playground" || (right.kind === "project" && left.projectId === right.projectId));

const sameTarget = (left: DesignOwnerInput, right: DesignOwnerInput) =>
  left.kind === "playground"
    ? right.kind === "playground"
    : right.kind === "project" && left.projectId === right.projectId;

// ---------------------------------------------------------------------------
// Copying plain folders
// ---------------------------------------------------------------------------

/**
 * Copies the folder `from` to `to`, which must not exist yet. Only plain
 * folders and regular files are copied, each checked with lstat: a link or a
 * special file anywhere inside refuses the whole copy. `skip` gets `/`
 * separated paths relative to `from`.
 */
async function copyPlain(
  from: string,
  to: string,
  skip: (relative: string) => boolean,
  relative = "",
): Promise<void> {
  const stat = await NodeFSP.lstat(from);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw notPlain(relative || ".");
  await NodeFSP.mkdir(to, { mode: 0o755 });
  for (const name of await NodeFSP.readdir(from)) {
    const path = relative === "" ? name : `${relative}/${name}`;
    if (skip(path)) continue;
    const source = NodePath.join(from, name);
    const info = await NodeFSP.lstat(source);
    if (info.isDirectory()) {
      await copyPlain(source, NodePath.join(to, name), skip, path);
    } else if (info.isFile()) {
      await NodeFSP.copyFile(source, NodePath.join(to, name), NodeFS.constants.COPYFILE_EXCL);
    } else {
      throw notPlain(path);
    }
  }
}

const notPlain = (path: string) =>
  new Store.DesignStoreProblem(
    "invalid",
    `${path} is a link or a special file. Only plain files and folders can move; remove it and try again.`,
  );

/**
 * Copies `from` into a new `<parent>/.incoming-<name>-<uuid>` and returns it.
 * Staging folders an earlier attempt left for the same name go first; the
 * caller holds the lock that serializes attempts.
 */
async function stage(
  from: string,
  parent: string,
  name: string,
  skip: (relative: string) => boolean = () => false,
): Promise<string> {
  const prefix = `${INCOMING}${name}-`;
  for (const entry of await NodeFSP.readdir(parent)) {
    if (entry.startsWith(prefix)) {
      await NodeFSP.rm(NodePath.join(parent, entry), { recursive: true, force: true });
    }
  }
  const staging = NodePath.join(parent, `${prefix}${NodeCrypto.randomUUID()}`);
  try {
    await copyPlain(from, staging, skip);
  } catch (error) {
    await NodeFSP.rm(staging, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
  return staging;
}

/** Renames a staged folder into place; something already there is a `conflict`. */
async function place(staging: string, destination: string): Promise<void> {
  try {
    await NodeFSP.rename(staging, destination);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST" || code === "ENOTEMPTY") {
      throw new Store.DesignStoreProblem(
        "conflict",
        `${NodePath.basename(destination)} appeared in the target while moving. Try again.`,
      );
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Forward records
// ---------------------------------------------------------------------------

const forwardFile = (playgroundRoot: string, designId: string) => {
  if (!isDesignId(designId)) {
    throw new Store.DesignStoreProblem("invalid", `${designId} is not a valid design id.`);
  }
  return NodePath.join(playgroundRoot, DESIGN_MOVED_DIR, `${designId}.json`);
};

/** Where a design that left `playgroundRoot` went, or null when it never moved. */
export async function readForward(
  playgroundRoot: string,
  designId: string,
): Promise<DesignForward | null> {
  const file = forwardFile(playgroundRoot, designId);
  const folder = await lstatOrNull(NodePath.dirname(file));
  if (folder === null || folder.isSymbolicLink() || !folder.isDirectory()) return null;
  // Windows has no O_NOFOLLOW: refuse a link by lstat, then check the opened handle is it.
  const noFollow = NodeFS.constants.O_NOFOLLOW as number | undefined;
  let seen: NodeFS.BigIntStats | null = null;
  if (noFollow === undefined) {
    seen = await NodeFSP.lstat(file, { bigint: true }).catch(() => null);
    if (seen === null || seen.isSymbolicLink()) return null;
  }
  let text: string;
  try {
    const handle = await NodeFSP.open(file, NodeFS.constants.O_RDONLY | (noFollow ?? 0));
    try {
      if (seen !== null) {
        const opened = await handle.stat({ bigint: true });
        if (opened.ino !== seen.ino || opened.dev !== seen.dev) return null;
      }
      text = await handle.readFile("utf8");
    } finally {
      await handle.close().catch(() => undefined);
    }
  } catch (error) {
    if (isMissing(error) || (error as NodeJS.ErrnoException).code === "ELOOP") return null;
    throw error;
  }
  try {
    const forward = decodeForward(JSON.parse(text));
    return forward.designId === designId ? forward : null;
  } catch {
    return null;
  }
}

async function writeForward(playgroundRoot: string, forward: DesignForward): Promise<void> {
  const file = forwardFile(playgroundRoot, forward.designId);
  const folder = NodePath.dirname(file);
  // The Playground is private to this machine's user, like the app home.
  await NodeFSP.mkdir(folder, { mode: 0o700 }).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  });
  const stat = await NodeFSP.lstat(folder);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Store.DesignStoreProblem("invalid", `${DESIGN_MOVED_DIR} must be a folder.`);
  }
  const temp = `${file}.${NodeCrypto.randomUUID()}.tmp`;
  try {
    await NodeFSP.writeFile(temp, `${JSON.stringify(forward, null, 2)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    await NodeFSP.rename(temp, file);
  } finally {
    await NodeFSP.rm(temp, { force: true }).catch(() => undefined);
  }
}

/** Whether `root` holds the design's folder with its head file (a plain folder and file). */
export async function designPlaced(root: string, designId: string): Promise<boolean> {
  const folder = await lstatOrNull(Store.designFolder(root, designId));
  if (folder === null || folder.isSymbolicLink() || !folder.isDirectory()) return false;
  const head = await lstatOrNull(
    NodePath.join(Store.designFolder(root, designId), Store.DESIGN_FILE),
  );
  return head !== null && head.isFile();
}

// ---------------------------------------------------------------------------
// Moving a design
// ---------------------------------------------------------------------------

const historyLock = (relative: string) =>
  relative.startsWith(`${Store.DESIGN_HISTORY_DIR}/`) &&
  Store.isDesignLockFile(relative.slice(Store.DESIGN_HISTORY_DIR.length + 1));

/** The revision of the design already at the target, null when nothing is there. */
async function placedRevision(targetRoot: string, designId: string): Promise<number | null> {
  if ((await lstatOrNull(Store.designFolder(targetRoot, designId))) === null) return null;
  const there = await Store.readDesign(targetRoot, designId).catch(() => null);
  if (there === null) {
    throw new Store.DesignStoreProblem(
      "conflict",
      `The project already has a folder ${designId} that is not this design. Move or remove it first.`,
    );
  }
  return there.revision;
}

/** A move that already finished, or not_found: the source folder is gone. */
async function finished(input: MoveDesignInput): Promise<DesignDocument> {
  const forward = await readForward(input.playgroundRoot, input.designId);
  if (
    forward !== null &&
    sameTarget(forward.to, input.to) &&
    (await designPlaced(input.targetRoot, input.designId))
  ) {
    return Store.readDesign(input.targetRoot, input.designId);
  }
  throw new Store.DesignStoreProblem("not_found", `No design ${input.designId}.`);
}

export interface MoveDesignInput {
  /** The Playground's design root: the design's folder and its forward record. */
  readonly playgroundRoot: string;
  readonly designId: string;
  /** The project's design root, already resolved free of links. */
  readonly targetRoot: string;
  readonly to: DesignOwnerInput;
  readonly expectedRevision: number;
  readonly actor: DesignActor;
  readonly movedAt: string;
  /** Runs on the head under the lock before anything is copied; throw to refuse. */
  readonly prepare?: ((current: DesignDocument) => Promise<void>) | undefined;
  /**
   * The project an earlier forward record names when it is not `to`, resolved
   * by the caller before the lock: its design root (null when it cannot be
   * read here), its name, and `gone` when the project was removed from this
   * machine. The record is read again under the lock.
   */
  readonly elsewhere?:
    | {
        readonly to: DesignOwnerInput;
        readonly root: string | null;
        readonly label: string;
        readonly gone?: boolean | undefined;
      }
    | null
    | undefined;
}

const movedElsewhere = (label: string) =>
  new Store.DesignStoreProblem("conflict", `This design already moved to ${label}. Open it there.`);

const maybeElsewhere = (label: string) =>
  new Store.DesignStoreProblem(
    "conflict",
    `This design may already be in ${label}, which this machine can't read right now. Try again once it is back.`,
  );

/** Renames the Playground folder away, then removes it; once renamed away the move is done. */
async function removeSource(playgroundRoot: string, designId: string): Promise<void> {
  const trash = NodePath.join(playgroundRoot, `.deleted-${designId}-${NodeCrypto.randomUUID()}`);
  await NodeFSP.rename(Store.designFolder(playgroundRoot, designId), trash);
  await NodeFSP.rm(trash, { recursive: true, force: true }).catch(() => undefined);
}

/**
 * Removes the Playground copy of a design whose forward record names the
 * project root `targetRoot` and that root holds the design: a move that
 * stopped after placing it. Nothing happens otherwise.
 */
export async function removeMovedSource(
  playgroundRoot: string,
  designId: string,
  targetRoot: string,
): Promise<void> {
  if ((await lstatOrNull(Store.designFolder(playgroundRoot, designId))) === null) return;
  await Store.withDesignLock(playgroundRoot, designId, async () => {
    if ((await readForward(playgroundRoot, designId)) === null) return;
    if (!(await designPlaced(targetRoot, designId))) return;
    await removeSource(playgroundRoot, designId);
  }).catch((error: unknown) => {
    if (
      isMissing(error) ||
      (error instanceof Store.DesignStoreProblem && error.code === "not_found")
    )
      return;
    throw error;
  });
}

/** Moves a Playground design into a project root; the document comes back unchanged. */
export async function moveDesign(input: MoveDesignInput): Promise<DesignDocument> {
  const { playgroundRoot, designId, targetRoot } = input;
  const source = Store.designFolder(playgroundRoot, designId);
  if ((await lstatOrNull(source)) === null) return finished(input);
  return Store.withDesignLock(playgroundRoot, designId, async () => {
    const current = await Store.readDesign(playgroundRoot, designId);
    const earlier = await readForward(playgroundRoot, designId);
    if (earlier !== null && !sameTarget(earlier.to, input.to)) {
      // An earlier move placed it in another project and stopped before removing this copy.
      const known = input.elsewhere;
      if (known === null || known === undefined || !sameTarget(known.to, earlier.to)) {
        throw new Store.DesignStoreProblem(
          "conflict",
          "This design was moved while you were choosing. Open it again.",
        );
      }
      // Only a project removed from this machine is known not to hold it.
      if (known.gone !== true) {
        if (known.root === null) throw maybeElsewhere(known.label);
        if (await designPlaced(known.root, designId)) throw movedElsewhere(known.label);
      }
    }
    if (
      earlier !== null &&
      sameTarget(earlier.to, input.to) &&
      (await placedRevision(targetRoot, designId)) !== null
    ) {
      // An earlier attempt placed it here; the store refuses edits to this copy since, so finish.
      await removeSource(playgroundRoot, designId);
      return Store.readDesign(targetRoot, designId);
    }
    if (current.revision !== input.expectedRevision) {
      throw new Store.DesignStoreProblem(
        "conflict",
        `The design is at revision ${current.revision}, not ${input.expectedRevision}. Read it again first.`,
        current.revision,
      );
    }
    const placed = await placedRevision(targetRoot, designId);
    if (placed !== null && placed !== current.revision) {
      throw new Store.DesignStoreProblem(
        "conflict",
        `The project already has design ${designId} at revision ${placed}. Open it there instead.`,
      );
    }
    await input.prepare?.(current);
    const forward = { to: input.to, designId, movedAt: input.movedAt, actor: input.actor };
    if (placed === null) {
      const staging = await stage(source, targetRoot, designId, historyLock);
      try {
        await writeForward(playgroundRoot, forward);
        await place(staging, Store.designFolder(targetRoot, designId));
      } catch (error) {
        await NodeFSP.rm(staging, { recursive: true, force: true }).catch(() => undefined);
        await NodeFSP.rm(forwardFile(playgroundRoot, designId), { force: true }).catch(
          () => undefined,
        );
        throw error;
      }
    } else {
      // An earlier attempt placed this very design and stopped before removing the source.
      await writeForward(playgroundRoot, forward);
    }
    // Renamed first, so a reader never sees half a design.
    await removeSource(playgroundRoot, designId);
    return current;
  }).catch(async (error: unknown) => {
    // The folder went while this attempt waited for the lock: another attempt moved it.
    const gone =
      isMissing(error) || (error instanceof Store.DesignStoreProblem && error.code === "not_found");
    if (gone && (await lstatOrNull(source)) === null) return finished(input);
    throw error;
  });
}

// ---------------------------------------------------------------------------
// The design system a moved design names
// ---------------------------------------------------------------------------

/**
 * Makes system `systemId` of `from` resolve in `targetRoot` under the same id,
 * so the moved design's `{token}` references keep working. A target that holds
 * the id already is left alone. Otherwise `system.json` is copied in at
 * revision 0 with `copiedFrom`, and its `files/` folder beside it (plain files
 * only); a retry adds `files/` that an earlier attempt did not get to.
 */
export async function copySystemForMove(input: {
  readonly from: { readonly root: string; readonly owner: DesignOwner };
  readonly targetRoot: string;
  readonly systemId: string;
  readonly actor: DesignActor;
  readonly now: string;
}): Promise<void> {
  const { from, targetRoot, systemId, now } = input;
  const original = await notFoundAsNull(Store.readDesignSystem(from.root, systemId));
  // A system its owner no longer holds stays a dangling reference, as it was before the move.
  if (original === null) return;
  let present = await notFoundAsNull(Store.readDesignSystem(targetRoot, systemId));
  if (present === null) {
    present = await Store.writeDesignSystem(
      targetRoot,
      {
        ...original,
        revision: 0,
        createdAt: now,
        updatedAt: now,
        copiedFrom: {
          owner: from.owner,
          id: original.id,
          revision: original.revision,
          copiedAt: now,
        },
      },
      { expectedRevision: null, actor: input.actor, now },
    );
  }
  if (present.copiedFrom?.id !== systemId || !sameOwner(present.copiedFrom.owner, from.owner)) {
    return;
  }
  const filesFrom = NodePath.join(from.root, Store.DESIGN_SYSTEMS_DIR, systemId, SYSTEM_FILES_DIR);
  const systemTo = NodePath.join(targetRoot, Store.DESIGN_SYSTEMS_DIR, systemId);
  const filesTo = NodePath.join(systemTo, SYSTEM_FILES_DIR);
  if ((await lstatOrNull(filesFrom)) === null || (await lstatOrNull(filesTo)) !== null) return;
  const staging = await stage(filesFrom, systemTo, SYSTEM_FILES_DIR);
  try {
    await place(staging, filesTo);
  } catch (error) {
    await NodeFSP.rm(staging, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}
