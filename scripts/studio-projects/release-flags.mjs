#!/usr/bin/env node
// The `gh release create` / `gh release edit` flags for a Studio version.
// A plain X.Y.Z from 1.0.0 on is a stable release: GitHub marks it Latest,
// so `releases/latest` and `releases/latest/download/<asset>` links resolve
// to it. A plain 0.x alpha is a normal release that never takes Latest back
// (it has no SpecWithCode-arm64.dmg, so the latest link would 404). A suffixed version (nightly, rc, preview) is a pre-release and never
// becomes Latest. Signed builds that update through electron-updater
// (`releaseType: release`) never see pre-releases at all.
//
// Usage: gh release create "v$V" ... $(node scripts/studio-projects/release-flags.mjs "$V")
// Use it for both the private repo and the public specwithcode repo.
import * as NodeURL from "node:url";

const STABLE = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/;
const SUFFIXED =
  /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)-[0-9A-Za-z][0-9A-Za-z.-]*$/;

export function releaseFlags(version) {
  if (typeof version !== "string") throw new Error("A release version is required.");
  const plain = version.replace(/^v/, "");
  if (STABLE.test(plain))
    return plain.startsWith("0.")
      ? ["--latest=false", "--prerelease=false"]
      : ["--latest", "--prerelease=false"];
  if (SUFFIXED.test(plain)) return ["--prerelease", "--latest=false"];
  throw new Error(`Not a release version: ${version}`);
}

if (process.argv[1] === NodeURL.fileURLToPath(import.meta.url)) {
  try {
    process.stdout.write(`${releaseFlags(process.argv[2]).join(" ")}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
