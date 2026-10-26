import assert from "node:assert/strict";

// Both command names run the same entry; `specweave-studio` stays the identity
// that installers, services and receipts use (docs/studio/naming.md).
export const RUNTIME_BINS = Object.freeze({
  "specweave-studio": "./bin.mjs",
  specwithcode: "./bin.mjs",
});

/** The package.json written at the root of the release runtime bundle. */
export function runtimePackage(version) {
  return {
    name: "specweave-studio",
    version,
    private: true,
    type: "module",
    license: "UNLICENSED",
    engines: { node: "^22.20.0" },
    bin: { ...RUNTIME_BINS },
  };
}

/** A bundle must register every command name, each pointing at the one entry. */
export function verifyRuntimeBins(pkg) {
  assert.deepEqual(
    pkg.bin,
    { ...RUNTIME_BINS },
    "Runtime package must register specweave-studio and specwithcode",
  );
}
