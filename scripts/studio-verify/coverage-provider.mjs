import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

// The coverage plugin is not a workspace dependency: pnpm-lock.yaml must stay identical to
// the pinned upstream lock. source-checks.mjs needs it for its two coverage steps, so it is
// installed out of tree (outside the workspace lockfile) and required up front here.
export const COVERAGE_PROVIDER = "@vitest/coverage-v8";
export const COVERAGE_PROVIDER_VERSION = "5.0.1";

const resolveManifest = (dir) =>
  createRequire(join(dir, "package.json")).resolve(COVERAGE_PROVIDER + "/package.json");

export function requireCoverageProvider(packageDirs, resolve = resolveManifest) {
  return packageDirs.map((dir) => {
    let manifest;
    try {
      manifest = resolve(dir);
    } catch {
      throw new Error(
        `${COVERAGE_PROVIDER}@${COVERAGE_PROVIDER_VERSION} is not installed for ${dir}. ` +
          "It is kept out of the pinned lockfile; install that exact version out of tree, " +
          "then rerun source-checks.",
      );
    }
    const { name, version } = JSON.parse(readFileSync(manifest, "utf8"));
    assert.equal(name, COVERAGE_PROVIDER, "Resolved coverage plugin has the wrong package name");
    assert.equal(
      version,
      COVERAGE_PROVIDER_VERSION,
      `Coverage plugin ${version} does not match the Vitest ${COVERAGE_PROVIDER_VERSION} runner`,
    );
    return { dir, manifest, version };
  });
}
