import type { EnvironmentId, LinkedMemoryExport, ProjectId } from "@specweave-studio/contracts";

/**
 * Two-way replication of linked project memory, driven from one place over
 * export and merge calls on each member: the app window drives it for
 * pairs no server drives, and a member's server drives the pairs it owns
 * (`LinkedPeerSync`), so memory moves without an open window.
 *
 * @module linkedMemorySync
 */

export interface LinkedMemoryMember {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly label: string;
}

export interface LinkedMemoryExportOptions {
  /** `nextCursor` of the previous page. */
  readonly cursor?: string;
  /** Only the digest of the whole memory, no files. */
  readonly digestOnly?: boolean;
}

export interface LinkedMemoryDriver {
  /** One page of the member's memory, or null when it could not be read now. */
  readonly exportMemory: (
    member: LinkedMemoryMember,
    options?: LinkedMemoryExportOptions,
  ) => Promise<LinkedMemoryExport | null>;
  /** Merges the peer's memory into the member; false when the member refused or failed. */
  readonly mergeMemory: (
    member: LinkedMemoryMember,
    peer: LinkedMemoryMember,
    memory: LinkedMemoryExport,
  ) => Promise<boolean>;
  /** A pair still differs after a pass and its retry. Defaults to a console warning. */
  readonly reportMismatch?: (left: LinkedMemoryMember, right: LinkedMemoryMember) => void;
  /** A pair another driver keeps in step: this pass leaves it alone. */
  readonly skipPair?: (left: LinkedMemoryMember, right: LinkedMemoryMember) => boolean;
}

/** More pages than 16 MiB of memory needs at 2 MiB each; past this an export is left incomplete. */
const MAX_EXPORT_PAGES = 64;

/** A member's whole memory as the pages it sent, `MEMORY.md` first. */
type MemoryPages = ReadonlyArray<LinkedMemoryExport>;

const fingerprint = (pages: MemoryPages) => {
  const files = new Map<string, string>();
  for (const page of pages) for (const file of page.files) files.set(file.name, file.contentSha256);
  return JSON.stringify([
    [...files].toSorted(),
    pages.flatMap((page) => page.tombstones.map((tombstone) => tombstone.name)).toSorted(),
  ]);
};

/** Every file arrived: an older machine that cannot page leaves the rest out. */
const complete = (pages: MemoryPages) => pages.at(-1)?.truncated === false;

/** Both copies hold the same files and deletions, so the pair has nothing to merge. */
const agree = (left: MemoryPages, right: MemoryPages) =>
  complete(left) && complete(right) && fingerprint(left) === fingerprint(right);

const settle = async <A>(run: () => Promise<A>, fallback: A): Promise<A> => {
  try {
    return await run();
  } catch {
    return fallback;
  }
};

/** Fetches every page of a member's memory, after `first` when given; null when a page failed. */
async function exportAll(
  driver: LinkedMemoryDriver,
  member: LinkedMemoryMember,
  first?: LinkedMemoryExport,
): Promise<MemoryPages | null> {
  const pages: LinkedMemoryExport[] = first ? [first] : [];
  const seen = new Set<string>();
  let cursor = first?.nextCursor;
  if (first && cursor === undefined) return pages;
  if (cursor !== undefined) seen.add(cursor);
  do {
    const options = cursor === undefined ? undefined : { cursor };
    const page = await settle(() => driver.exportMemory(member, options), null);
    if (!page) return null;
    pages.push(page);
    cursor = page.nextCursor;
    // A repeated cursor or an endless export stops here; the last page says it is cut short.
    if (cursor !== undefined && (seen.has(cursor) || pages.length >= MAX_EXPORT_PAGES)) break;
    if (cursor !== undefined) seen.add(cursor);
  } while (cursor !== undefined);
  return pages;
}

/** Exports both sides, then merges each into the other page by page; false when nothing ran. */
async function mergePair(
  driver: LinkedMemoryDriver,
  left: LinkedMemoryMember,
  right: LinkedMemoryMember,
): Promise<boolean> {
  // Equal whole-memory digests already prove agreement, so an idle pass moves no memory.
  const leftDigest = await settle(() => driver.exportMemory(left, { digestOnly: true }), null);
  if (!leftDigest) return false;
  const rightDigest = await settle(() => driver.exportMemory(right, { digestOnly: true }), null);
  if (!rightDigest) return false;
  if (leftDigest.digest !== undefined && leftDigest.digest === rightDigest.digest) return false;
  const firstLeft = await settle(() => driver.exportMemory(left), null);
  if (!firstLeft) return false;
  const firstRight = await settle(() => driver.exportMemory(right), null);
  if (!firstRight) return false;
  const fromLeft = await exportAll(driver, left, firstLeft);
  if (!fromLeft) return false;
  const fromRight = await exportAll(driver, right, firstRight);
  if (!fromRight || agree(fromLeft, fromRight)) return false;
  // Absence never deletes on merge, so each page merges on its own.
  for (const page of fromRight) await settle(() => driver.mergeMemory(left, right, page), false);
  for (const page of fromLeft) await settle(() => driver.mergeMemory(right, left, page), false);
  return true;
}

/**
 * Whether both copies now hold the same memory: their digests when both
 * machines send one, else their full exports. Null when that cannot be told,
 * for example a copy is unreachable or too old to send all of its memory.
 */
async function confirmPair(
  driver: LinkedMemoryDriver,
  left: LinkedMemoryMember,
  right: LinkedMemoryMember,
): Promise<boolean | null> {
  const digest = (member: LinkedMemoryMember) =>
    settle(() => driver.exportMemory(member, { digestOnly: true }), null).then(
      (memory) => memory?.digest,
    );
  const leftDigest = await digest(left);
  const rightDigest = await digest(right);
  if (leftDigest !== undefined && rightDigest !== undefined) return leftDigest === rightDigest;
  const fromLeft = await exportAll(driver, left);
  const fromRight = fromLeft && (await exportAll(driver, right));
  if (!fromLeft || !fromRight || !complete(fromLeft) || !complete(fromRight)) return null;
  return fingerprint(fromLeft) === fingerprint(fromRight);
}

const warnMismatch = (left: LinkedMemoryMember, right: LinkedMemoryMember) =>
  // @effect-diagnostics-next-line globalConsole:off - also runs in the app window, without Effect.
  console.warn("Linked project memory still differs after a sync and a retry", {
    left: { environmentId: left.environmentId, projectId: left.projectId },
    right: { environmentId: right.environmentId, projectId: right.projectId },
  });

/**
 * One pass of two-way memory replication. Every pair of reachable copies is
 * exported on both sides first, all pages of each, then each side merges the
 * other's export, so a failure on one side never changes what the other side
 * sees. Afterwards both sides are compared; a pair that still differs (a
 * conflict copy made on one side, a write in between) gets one more round,
 * and a mismatch after that is reported. A pair that fails is skipped until
 * the next pass.
 */
export async function syncLinkedMemory(
  groups: ReadonlyArray<ReadonlyArray<LinkedMemoryMember>>,
  driver: LinkedMemoryDriver,
): Promise<void> {
  const report = driver.reportMismatch ?? warnMismatch;
  for (const members of groups) {
    for (const [index, left] of members.entries()) {
      for (const right of members.slice(index + 1)) {
        if (left.environmentId === right.environmentId) continue;
        if (driver.skipPair?.(left, right)) continue;
        if (!(await mergePair(driver, left, right))) continue;
        if ((await confirmPair(driver, left, right)) !== false) continue;
        if (!(await mergePair(driver, left, right))) continue;
        if ((await confirmPair(driver, left, right)) === false) report(left, right);
      }
    }
  }
}
