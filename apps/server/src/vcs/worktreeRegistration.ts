/**
 * Which folders Git has registered as worktrees, read from
 * `git worktree list --porcelain -z`. Git prints forward slashes and the real
 * path, so both sides are compared in that form.
 */
const comparable = (path: string, platform: NodeJS.Platform) => {
  const slashed = path.replaceAll("\\", "/").replace(/\/+$/, "");
  return platform === "win32" ? slashed.toLowerCase() : slashed;
};

export function parseWorktreeListPaths(stdout: string): ReadonlyArray<string> {
  return stdout
    .split("\0")
    .filter((field) => field.startsWith("worktree "))
    .map((field) => field.slice("worktree ".length));
}

/** Whether any of `candidates` (the path as given, and its real path) is a registered worktree. */
export function isRegisteredWorktree(
  listStdout: string,
  candidates: ReadonlyArray<string>,
  platform: NodeJS.Platform,
): boolean {
  const registered = new Set(
    parseWorktreeListPaths(listStdout).map((path) => comparable(path, platform)),
  );
  return candidates.some((candidate) => registered.has(comparable(candidate, platform)));
}

/** Whether `inner` is `outer` or sits inside it. */
export function isSameOrInside(inner: string, outer: string, platform: NodeJS.Platform): boolean {
  const a = comparable(inner, platform);
  const b = comparable(outer, platform);
  return a === b || a.startsWith(`${b}/`);
}
