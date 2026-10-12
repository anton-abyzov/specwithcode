import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

function comparisonPath(value: string, caseFold: boolean): string {
  const normalized = `${value.replaceAll("\\", "/").replace(/\/+$/, "")}/`;
  return caseFold ? normalized.toLowerCase() : normalized;
}

/** Keep both configured and filesystem spellings: macOS /var may resolve to /private/var. */
export const makeProjectExclusionFilter = Effect.fn(
  "AgentSessionScanner.makeProjectExclusionFilter",
)(function* (input: {
  readonly baseDir: string;
  readonly worktreesDir: string;
  readonly homeDir: string;
  readonly tempDir: string;
  readonly caseFold: boolean;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const aliases = (directory: string) => {
    const resolved = path.resolve(directory);
    return fs.realPath(resolved).pipe(
      Effect.orElseSucceed(() => resolved),
      Effect.map((canonical) =>
        [resolved, canonical].map((value) => comparisonPath(value, input.caseFold)),
      ),
    );
  };
  const exactRoots = new Set(
    (yield* Effect.forEach([input.homeDir, input.tempDir, "/tmp", "/private/tmp"], aliases)).flat(),
  );
  const ancestorRoots = (yield* Effect.forEach(
    [
      input.baseDir,
      input.worktreesDir,
      path.join(input.homeDir, "Downloads"),
      path.join(input.homeDir, "Documents", "Codex"),
    ],
    aliases,
  )).flat();
  return (candidatePath: string): boolean => {
    const candidate = comparisonPath(candidatePath, input.caseFold);
    return (
      exactRoots.has(candidate) ||
      ancestorRoots.some((root) => candidate.startsWith(root)) ||
      candidate.includes("/.specweave-studio/worktrees/")
    );
  };
});
