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

/**
 * The version an npm-distributed release manifest names. scripts/studio-fleet/npm-package.mjs
 * writes `distribution: "npm"` into the package it publishes; every other
 * manifest (fleet runtime archive, desktop bundle) returns null.
 */
export function parseNpmReleaseVersion(text: string): string | null {
  try {
    const manifest = JSON.parse(text) as {
      product?: unknown;
      version?: unknown;
      distribution?: unknown;
    };
    return manifest.product === "SpecWeave Studio" &&
      manifest.distribution === "npm" &&
      typeof manifest.version === "string" &&
      manifest.version.length > 0
      ? manifest.version
      : null;
  } catch {
    return null;
  }
}

export interface NpmPackageRuntime {
  /** The installed package directory: `bin.mjs`, the web client and a flat `node_modules`. */
  readonly dir: string;
  readonly version: string;
}

/**
 * The installed `specwithcode` npm package this process runs from, found
 * through the same entry and module directories as the source commit. Null
 * outside an npm install. Symlinks are resolved, so `<prefix>/bin/specwithcode`
 * leads to the package itself.
 */
export const findNpmPackageRuntime = Effect.fn("findNpmPackageRuntime")(function* (
  moduleUrl: string = import.meta.url,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const args = yield* HostProcessArguments;
  const candidates: string[] = [];
  if (args[1]) candidates.push(path.resolve(args[1]));
  const moduleFile = yield* path
    .fromFileUrl(new URL(moduleUrl))
    .pipe(Effect.orElseSucceed(() => null));
  if (moduleFile !== null) candidates.push(moduleFile);
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const real = yield* fileSystem.realPath(candidate).pipe(Effect.orElseSucceed(() => null));
    if (real === null) continue;
    const directory = path.dirname(real);
    if (seen.has(directory)) continue;
    seen.add(directory);
    const text = yield* fileSystem
      .readFileString(path.join(directory, SERVER_RELEASE_MANIFEST))
      .pipe(Effect.orElseSucceed(() => null));
    const version = text === null ? null : parseNpmReleaseVersion(text);
    if (version === null) continue;
    const hasEntry = yield* fileSystem
      .exists(path.join(directory, "bin.mjs"))
      .pipe(Effect.orElseSucceed(() => false));
    if (hasEntry) return { dir: directory, version } satisfies NpmPackageRuntime;
  }
  return null;
});
