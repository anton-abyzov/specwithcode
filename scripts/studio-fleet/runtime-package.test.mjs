import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runtimePackage, verifyRuntimeBins } from "./runtime-package.mjs";

test("runtime bundle package registers both command names on the one entry", () => {
  const pkg = runtimePackage("0.2.7");
  assert.equal(pkg.name, "specweave-studio");
  assert.equal(pkg.version, "0.2.7");
  assert.deepEqual(pkg.bin, { "specweave-studio": "./bin.mjs", specwithcode: "./bin.mjs" });
  verifyRuntimeBins(pkg);
});

test("bundle verification rejects a runtime package without the specwithcode bin", () => {
  // The 0.2.6 bundle shape: only the identity name was registered.
  assert.throws(
    () => verifyRuntimeBins({ name: "specweave-studio", bin: { "specweave-studio": "./bin.mjs" } }),
    /specwithcode/,
  );
  assert.throws(() =>
    verifyRuntimeBins({
      name: "specweave-studio",
      bin: { "specweave-studio": "./bin.mjs", specwithcode: "./other.mjs" },
    }),
  );
  assert.throws(() => verifyRuntimeBins({ name: "specweave-studio" }));
});

test("bundle.mjs writes the shared runtime package and verify-bundle checks its bins", () => {
  const bundle = readFileSync(new URL("./bundle.mjs", import.meta.url), "utf8");
  assert.match(bundle, /JSON\.stringify\(runtimePackage\(version\)/);
  assert.doesNotMatch(bundle, /bin: \{ 'specweave-studio': '\.\/bin\.mjs' \}/);
  const verify = readFileSync(new URL("./verify-bundle.mjs", import.meta.url), "utf8");
  assert.match(verify, /verifyRuntimeBins\(runtimePackageJson\)/);
});
