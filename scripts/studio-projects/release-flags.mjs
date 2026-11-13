#!/usr/bin/env node
// The `gh release create` / `gh release edit` flags for a Studio version.
// A plain X.Y.Z from 1.0.0 on is a stable release: GitHub marks it Latest,
// so `releases/latest` and `releases/latest/download/<asset>` links resolve
// to it. A plain 0.x alpha is a normal release that never takes Latest back
// (it has no SpecWithCode-arm64.dmg, so the latest link would 404). A suffixed version (nightly, rc, preview) is a pre-release and never
// becomes Latest. Signed builds that update through electron-updater
// (`releaseType: release`) never see pre-releases at all.
//
// From 1.1.0 on every build is an Insiders build (docs/studio/release-train.md):
// a pre-release that never takes Latest, so only Insiders installs see it. Only
// the daily train (scripts/release/release_train.py) makes a release stable, by
// promoting that same release once it has soaked, or at once for a hotfix. No
// flag here can publish a 1.1+ build as stable. 1.0.x is the frozen first line
// and keeps the flags it always had.
//
// Usage: gh release create "v$V" ... $(node scripts/studio-projects/release-flags.mjs "$V")
// Use it for both the private repo and the public specwithcode repo.
import * as NodeURL from "node:url";

const STABLE = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/;
const SUFFIXED =
  /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)-[0-9A-Za-z][0-9A-Za-z.-]*$/;

/** True for plain versions on the train: 1.1.0 and above. */
export function onTrain(plain) {
  const [major, minor] = plain.split(".").map(Number);
  return major > 1 || (major === 1 && minor >= 1);
}

export function releaseFlags(version) {
  if (typeof version !== "string") throw new Error("A release version is required.");
  const plain = version.replace(/^v/, "");
  if (STABLE.test(plain)) {
    if (plain.startsWith("0.")) return ["--latest=false", "--prerelease=false"];
    if (onTrain(plain)) return ["--prerelease", "--latest=false"];
    return ["--latest", "--prerelease=false"];
  }
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
