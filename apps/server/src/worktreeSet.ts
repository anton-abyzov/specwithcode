/**
 * A worktree set: one thread folder holding one git worktree per repository an
 * increment changes, all on the same branch. The thread records the folder as
 * its worktree path; the members are listed in a manifest beside the folder
 * (`.<folder>.worktree-set.json`), which survives the folder being deleted so
 * restore can recreate every member.
 *
 * Each member sits at its repository's path relative to the project root: the
 * project root's own repository is the folder itself, `repositories/a/b` is
 * `<folder>/repositories/a/b`. A repository outside the project root sits at
 * `<folder>/<its folder name>`.
 *
 * @module worktreeSet
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

export interface WorktreeSetMember {
  /** The repository's main checkout, absolute. */
  readonly repository: string;
  /** Where its worktree sits inside the thread folder; "" is the folder itself. */
  readonly relativePath: string;
  /** The project environment repository id, when the member is one. */
  readonly id?: string | undefined;
  /** The branch or ref its worktree was cut from, when the app recorded it. */
  readonly baseRef?: string | undefined;
  /** Who added it to a running thread; absent for a member made at launch. */
  readonly addedBy?: "agent" | "user" | undefined;
  readonly addedAt?: string | undefined;
}

const WorktreeSetManifest = Schema.Struct({
  version: Schema.Literal(1),
  members: Schema.Array(
    Schema.Struct({
      repository: Schema.String,
      relativePath: Schema.String,
      id: Schema.optional(Schema.String),
      baseRef: Schema.optional(Schema.String),
      addedBy: Schema.optional(Schema.Literals(["agent", "user"])),
      addedAt: Schema.optional(Schema.String),
    }),
  ),
});
export type WorktreeSetManifest = typeof WorktreeSetManifest.Type;
const decodeManifest = Schema.decodeUnknownEffect(Schema.fromJsonString(WorktreeSetManifest));
const encodeManifest = Schema.encodeEffect(Schema.fromJsonString(WorktreeSetManifest));

/** The manifest beside the thread folder; dot-prefixed so folder scans skip it. */
export function worktreeSetManifestPath(
  threadFolder: string,
  path: Pick<Path.Path, "join" | "dirname" | "basename">,
): string {
  return path.join(path.dirname(threadFolder), `.${path.basename(threadFolder)}.worktree-set.json`);
}

/** Where a member's worktree sits: the thread folder joined with its relative path. */
export function worktreeSetMemberPath(
  threadFolder: string,
  member: Pick<WorktreeSetMember, "relativePath">,
  path: Pick<Path.Path, "join">,
): string {
  return member.relativePath === "" ? threadFolder : path.join(threadFolder, member.relativePath);
}

/**
 * Lays out the repositories of a set inside the thread folder, the project
 * root's own repository first: it must exist before the folders nested in it.
 * Repositories are deduplicated by path; a repository outside the project root
 * takes its folder name, suffixed when two share one.
 */
export function planWorktreeSet(
  projectRoot: string,
  repositories: ReadonlyArray<{ readonly path: string; readonly id?: string | undefined }>,
  path: Pick<Path.Path, "resolve" | "relative" | "isAbsolute" | "basename" | "sep">,
  /** Top-level names in the project folder, which a repository outside it must not take. */
  reserved: ReadonlyArray<string> = [],
): ReadonlyArray<WorktreeSetMember> {
  const root = path.resolve(projectRoot);
  const seen = new Set<string>();
  // Case-insensitive: macOS and Windows folders are.
  const taken = new Set<string>(reserved.map((name) => name.toLowerCase()));
  const inside: Array<WorktreeSetMember> = [];
  const outside: Array<{ repository: string; id?: string | undefined }> = [];
  for (const entry of repositories) {
    const repository = path.resolve(root, entry.path);
    if (seen.has(repository)) continue;
    seen.add(repository);
    const relative = path.relative(root, repository);
    if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
      inside.push({ repository, relativePath: relative, ...(entry.id ? { id: entry.id } : {}) });
      taken.add((relative.split(path.sep)[0] ?? relative).toLowerCase());
    } else {
      outside.push({ repository, ...(entry.id ? { id: entry.id } : {}) });
    }
  }
  // Shallowest first, so the root member exists before folders nested in it.
  const depth = (member: WorktreeSetMember) =>
    member.relativePath === "" ? 0 : member.relativePath.split(path.sep).length;
  const members = inside.toSorted(
    (left, right) =>
      depth(left) - depth(right) || (left.relativePath < right.relativePath ? -1 : 1),
  );
  for (const entry of outside) {
    const base = path.basename(entry.repository);
    let name = base;
    for (let index = 2; taken.has(name.toLowerCase()); index += 1) name = `${base}-${index}`;
    taken.add(name.toLowerCase());
    members.push({
      repository: entry.repository,
      relativePath: name,
      ...(entry.id ? { id: entry.id } : {}),
    });
  }
  return members;
}

/** The set's manifest, or null when the folder is a plain worktree (or unreadable). */
export const readWorktreeSet = Effect.fn("worktreeSet.read")(function* (threadFolder: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const file = worktreeSetManifestPath(threadFolder, path);
  // Most thread folders are plain worktrees: look before reading.
  if (!(yield* fs.exists(file).pipe(Effect.orElseSucceed(() => false)))) return null;
  return yield* fs.readFileString(file).pipe(
    Effect.flatMap((text) => decodeManifest(text)),
    Effect.orElseSucceed(() => null),
  );
});

export const writeWorktreeSet = Effect.fn("worktreeSet.write")(function* (
  threadFolder: string,
  members: ReadonlyArray<WorktreeSetMember>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const file = worktreeSetManifestPath(threadFolder, path);
  yield* fs.makeDirectory(path.dirname(file), { recursive: true });
  const text = yield* encodeManifest({
    version: 1,
    members: members.map((member) => ({
      repository: member.repository,
      relativePath: member.relativePath,
      ...(member.id ? { id: member.id } : {}),
      ...(member.baseRef ? { baseRef: member.baseRef } : {}),
      ...(member.addedBy ? { addedBy: member.addedBy } : {}),
      ...(member.addedAt ? { addedAt: member.addedAt } : {}),
    })),
  });
  const temporary = `${file}.tmp`;
  yield* fs.writeFileString(temporary, `${text}\n`);
  yield* fs.rename(temporary, file);
});

export const removeWorktreeSetManifest = Effect.fn("worktreeSet.removeManifest")(function* (
  threadFolder: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.remove(worktreeSetManifestPath(threadFolder, path), { force: true });
});
