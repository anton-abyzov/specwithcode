import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
const assert = NodeAssert;
const { readFileSync } = NodeFS;
const { join } = NodePath;

// 0.1.x and 0.2.x were the alpha line; 1.x.y is the stable line that follows it.
export function compatibleVersion(version) {
  return (
    typeof version === "string" &&
    /^(?:0\.(?:1|2)|1\.(?:0|[1-9][0-9]*))\.(?:0|[1-9][0-9]*)$/.test(version)
  );
}
export function sourceVersion(root) {
  const packages = ["server", "web", "desktop"].map((app) =>
    JSON.parse(readFileSync(join(root, "apps", app, "package.json"), "utf8")),
  );
  const version = packages[0].version;
  assert.ok(compatibleVersion(version), "Unsupported Studio release version");
  assert.ok(
    packages.every((pkg) => pkg.version === version),
    "Studio application versions differ",
  );
  assert.equal(packages[0].name, "specweave-studio");
  return version;
}
export function validateArtifactIdentity(manifest, pkg) {
  assert.equal(manifest.product, "SpecWeave Studio", "Unexpected artifact product");
  assert.ok(compatibleVersion(manifest.version), "Unsupported Studio artifact version");
  assert.equal(pkg.name, "specweave-studio");
  assert.equal(pkg.version, manifest.version, "Package and artifact versions differ");
  assert.equal(manifest.schemaVersion, 1);
  assert.match(manifest.sourceCommit, /^[a-f0-9]{40}$/);
  assert.match(manifest.lockSha256, /^[a-f0-9]{64}$/);
  assert.equal(manifest.runtime, "Node22.20.0");
  assert.equal(manifest.noAuthOrUserStores, true);
  assert.ok(
    manifest.files.some((entry) => entry.path === "package.json" && entry.type === "file"),
    "Artifact package identity is not indexed",
  );
  return manifest.version;
}
