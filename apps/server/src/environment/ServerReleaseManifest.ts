import { HostProcessArguments } from "@specweave-studio/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

/** Written next to `bin.mjs` by scripts/studio-fleet/bundle.mjs. */
export const SERVER_RELEASE_MANIFEST = "studio-manifest.json";

const SOURCE_COMMIT = /^[0-9a-f]{40}$/;

export function parseReleaseSourceCommit(text: string): string | null {
  try {
    const manifest = JSON.parse(text) as { product?: unknown; sourceCommit?: unknown };
    return manifest.product === "SpecWeave Studio" &&
      typeof manifest.sourceCommit === "string" &&
      SOURCE_COMMIT.test(manifest.sourceCommit)
      ? manifest.sourceCommit
      : null;
  } catch {
    return null;
  }
}

/**
 * The commit an installed service release was bundled from, read from the
 * release manifest beside its entry script. Dev checkouts and npm installs
 * have no manifest and report null.
 */
export const readServerReleaseSourceCommit = Effect.fn("readServerReleaseSourceCommit")(function* (
  moduleUrl: string = import.meta.url,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const args = yield* HostProcessArguments;
  const moduleDirectory = yield* path.fromFileUrl(new URL(moduleUrl)).pipe(
    Effect.map((file) => path.dirname(file)),
    Effect.orElseSucceed(() => null),
  );
  const directories = new Set<string>();
  if (args[1]) directories.add(path.dirname(path.resolve(args[1])));
  if (moduleDirectory !== null) directories.add(moduleDirectory);
  for (const directory of directories) {
    const text = yield* fileSystem
      .readFileString(path.join(directory, SERVER_RELEASE_MANIFEST))
      .pipe(Effect.orElseSucceed(() => null));
    const commit = text === null ? null : parseReleaseSourceCommit(text);
    if (commit !== null) return commit;
  }
  return null;
});
