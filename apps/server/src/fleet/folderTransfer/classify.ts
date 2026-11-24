import {
  isSecretLikeProjectPath,
  isUntrackedSecretConfigPath,
} from "../../workspace/WorkspaceSensitivePaths.ts";

/**
 * What a copied file is, which decides whether it moves by default:
 * - `repository`: Git's own data (`.git` folders and linked-worktree `.git` files).
 * - `tracked` / `untracked`: work in a checkout; untracked also covers files
 *   outside any repository.
 * - `rebuildable`: ignored output the project's setup recreates.
 * - `ignoredData`: every other ignored file, often the only copy (evidence, notes).
 * - `secret`: credential-like files outside Git; never copied without a per-file choice.
 */
export const FILE_CLASSES = [
  "repository",
  "tracked",
  "untracked",
  "ignoredData",
  "rebuildable",
  "secret",
] as const;
export type FileClass = (typeof FILE_CLASSES)[number];

/** On unless the person turns it off; rebuildable and secret files stay behind. */
export const DEFAULT_SELECTION: ReadonlyArray<FileClass> = [
  "repository",
  "tracked",
  "untracked",
  "ignoredData",
];
/** "Exact copy of everything": every class except secrets, which have their own step. */
export const EXACT_SELECTION: ReadonlyArray<FileClass> = [...DEFAULT_SELECTION, "rebuildable"];

/** Folder names whose ignored contents are build output, dependencies or caches. */
const REBUILDABLE_DIRECTORIES = new Set([
  "node_modules",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".turbo",
  ".parcel-cache",
  ".vite",
  "dist",
  "build",
  "out",
  "target",
  "DerivedData",
  "Pods",
  ".gradle",
  "coverage",
  ".nyc_output",
  ".cache",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  ".tox",
  ".venv",
  "venv",
  // direnv's per-machine cache: layout virtualenvs and flake shells, rebuilt by direnv allow.
  ".direnv",
  "bin",
  "obj",
  // Pure build and test output; `.wrangler` (local state) and `release/` stay data.
  ".open-next",
  "dist-electron",
  "playwright-report",
  "test-results",
]);

/** True when an ignored path sits in (or is) a rebuildable folder. */
export function isRebuildablePath(relative: string): boolean {
  return relative.split("/").some((part) => REBUILDABLE_DIRECTORIES.has(part));
}

export function isRebuildableDirectoryName(name: string): boolean {
  return REBUILDABLE_DIRECTORIES.has(name);
}

/**
 * Whether a path reads as a secret even when Git tracks it: a secret-like name, or a
 * match for the project's own "Secret files" patterns. Untracked-only config names
 * (`isUntrackedSecretConfigPath`) are left out, since a tracked one is usually a template.
 */
export function isSecretPath(
  relative: string,
  secretPattern?: ((relative: string) => boolean) | undefined,
): boolean {
  return isSecretLikeProjectPath(relative) || secretPattern?.(relative) === true;
}

/**
 * The class of one file given what Git says about it. Tracked files are always
 * work: their content is already in the repository data, and leaving one out would
 * make `git status` differ on the destination.
 */
export function classifyFile(input: {
  readonly relative: string;
  readonly insideGitData: boolean;
  readonly gitState: "tracked" | "untracked" | "ignored" | "outside";
  /** The project's own "Secret files" patterns (`secretPatternMatcher`). */
  readonly secretPattern?: ((relative: string) => boolean) | undefined;
}): FileClass {
  if (input.insideGitData) return "repository";
  if (input.gitState === "tracked") return "tracked";
  if (
    isSecretPath(input.relative, input.secretPattern) ||
    isUntrackedSecretConfigPath(input.relative)
  )
    return "secret";
  // Finder metadata is recreated locally and may only be hidden by the source
  // user's global ignore file, which deliberately does not move to another host.
  if (input.relative.split("/").at(-1) === ".DS_Store") return "rebuildable";
  if (input.gitState === "ignored")
    return isRebuildablePath(input.relative) ? "rebuildable" : "ignoredData";
  if (input.gitState === "outside" && isRebuildablePath(input.relative)) return "rebuildable";
  return "untracked";
}
