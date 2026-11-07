// @effect-diagnostics nodeBuiltinImport:off - Plain promises over the increment folder, like launchIncrement.
/**
 * The repositories a SpecWeave increment changes, for a worktree set: its
 * `metadata.json` `repositories` (paths relative to the project root, or a
 * project environment repository id), else the owners of its task `Files`.
 *
 * @module incrementRepositories
 */
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import type { LaunchRepositoryCheckout } from "../orchestration-v2/ThreadLaunchService.ts";

export interface IncrementRepositorySources {
  /** `metadata.json` `repositories`, or null when the increment declares none. */
  readonly declared: ReadonlyArray<string> | null;
  /** Task `Files` paths, relative to the project root. */
  readonly files: ReadonlyArray<string>;
}

const FILES_FIELD = /(?:\*\*Files\*\*|\bFiles):?\*{0,2}\s*([^|\n]+)/gu;

/** Task `Files` entries in spec.md (`| Files: a, b |`) or tasks.md (`**Files**: a, b`). */
export function taskFilesFrom(markdown: string): ReadonlyArray<string> {
  const files: Array<string> = [];
  for (const match of markdown.matchAll(FILES_FIELD)) {
    for (const raw of match[1]!.split(",")) {
      const entry = raw.trim().replace(/^`|`$/gu, "").trim();
      if (entry === "" || /^(none|n\/a|-)$/iu.test(entry)) continue;
      // `a/b.ts (new)` and `a/b.ts:12` name the same file.
      files.push(entry.replace(/\s+\(.*\)$/u, "").replace(/:\d+(?:-\d+)?$/u, ""));
    }
  }
  return files;
}

export async function readIncrementRepositorySources(input: {
  /** The checkout whose `.specweave/increments` holds the increment. */
  readonly root: string;
  readonly incrementId: string;
}): Promise<IncrementRepositorySources> {
  const folder = NodePath.join(input.root, ".specweave", "increments", input.incrementId);
  const read = (name: string) =>
    NodeFSP.readFile(NodePath.join(folder, name), "utf8").catch(() => null);
  const [metadata, spec, tasks] = await Promise.all([
    read("metadata.json"),
    read("spec.md"),
    read("tasks.md"),
  ]);
  let declared: Array<string> | null = null;
  try {
    const parsed: unknown = metadata === null ? null : JSON.parse(metadata);
    const field =
      parsed !== null && typeof parsed === "object"
        ? (parsed as { repositories?: unknown }).repositories
        : undefined;
    if (Array.isArray(field)) {
      declared = field.flatMap((entry: unknown) =>
        typeof entry === "string" && entry.trim() !== ""
          ? [entry.trim()]
          : entry !== null &&
              typeof entry === "object" &&
              typeof (entry as { path?: unknown }).path === "string"
            ? [(entry as { path: string }).path.trim()]
            : [],
      );
    }
  } catch {
    declared = null;
  }
  return {
    declared: declared !== null && declared.length > 0 ? declared : null,
    files: [...taskFilesFrom(spec ?? ""), ...taskFilesFrom(tasks ?? "")],
  };
}

export type IncrementRepositoryCandidate = {
  /** Absolute path of the repository's main checkout. */
  readonly path: string;
  readonly id?: string | undefined;
};

/**
 * Candidate repositories, before the caller checks each is a git checkout. A
 * declared entry is an environment repository id, else a path relative to the
 * project root. Without declarations, each task file belongs to the deepest
 * environment repository holding it, else its `repositories/<org>/<repo>`
 * folder, else the project root when its first folder is there.
 */
export function incrementRepositoryCandidates(input: {
  readonly projectRoot: string;
  readonly checkouts: ReadonlyArray<LaunchRepositoryCheckout>;
  readonly sources: IncrementRepositorySources;
  /**
   * Names at the top of the project root. A file whose first folder is not
   * there belongs to no repository here (another project's path), so it is
   * left out rather than assigned to the root.
   */
  readonly rootEntries: ReadonlySet<string>;
}): ReadonlyArray<IncrementRepositoryCandidate> {
  const root = NodePath.resolve(input.projectRoot);
  const candidates: Array<IncrementRepositoryCandidate> = [];
  const add = (candidate: IncrementRepositoryCandidate) => {
    if (!candidates.some((entry) => entry.path === candidate.path)) candidates.push(candidate);
  };
  const checkoutAt = (path: string) =>
    input.checkouts.find((checkout) => NodePath.resolve(checkout.path) === path);
  if (input.sources.declared !== null) {
    for (const entry of input.sources.declared) {
      const byId = input.checkouts.find((checkout) => checkout.id === entry);
      if (byId !== undefined) {
        add({ path: NodePath.resolve(byId.path), id: byId.id });
        continue;
      }
      const path = NodePath.resolve(root, entry);
      add({ path, ...(checkoutAt(path) ? { id: checkoutAt(path)!.id } : {}) });
    }
    return candidates;
  }
  const owners = input.checkouts
    .map((checkout) => ({ id: checkout.id, path: NodePath.resolve(checkout.path) }))
    .toSorted((left, right) => right.path.length - left.path.length);
  for (const file of input.sources.files) {
    const absolute = NodePath.resolve(root, file);
    const owner = owners.find(
      (checkout) =>
        absolute === checkout.path || absolute.startsWith(`${checkout.path}${NodePath.sep}`),
    );
    if (owner !== undefined) {
      add(owner);
      continue;
    }
    const relative = NodePath.relative(root, absolute);
    if (relative.startsWith("..") || NodePath.isAbsolute(relative)) continue;
    const parts = relative.split(NodePath.sep);
    if (!input.rootEntries.has(parts[0]!)) continue;
    if (parts[0] === "repositories" && parts.length > 3) {
      add({ path: NodePath.join(root, parts[0], parts[1]!, parts[2]!) });
      continue;
    }
    add({ path: root });
  }
  return candidates;
}
