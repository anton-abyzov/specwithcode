import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";
import * as NodeTest from "node:test";
import * as NodeURL from "node:url";

import { releaseFlags } from "./release-flags.mjs";

const assert = NodeAssert;
const { test } = NodeTest;
const script = NodePath.join(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "release-flags.mjs",
);

test("a plain 1.0.x version is published as the Latest release", () => {
  for (const version of ["1.0.0", "v1.0.0", "1.0.276"])
    assert.deepEqual(releaseFlags(version), ["--latest", "--prerelease=false"]);
});

test("from 1.1.0 every build is an insiders pre-release; only the train makes it stable", () => {
  for (const version of ["1.1.0", "v1.1.7", "1.2.10", "2.0.0"])
    assert.deepEqual(releaseFlags(version), ["--prerelease", "--latest=false"]);
});

test("a plain 0.x alpha never takes Latest from a stable release", () => {
  for (const version of ["0.2.12", "v0.2.13", "0.1.0"])
    assert.deepEqual(releaseFlags(version), ["--latest=false", "--prerelease=false"]);
});

test("a suffixed version is a pre-release and never Latest", () => {
  for (const version of ["1.0.0-nightly.20261012.1", "1.0.0-rc.1", "1.0.1-preview.20261012.3"])
    assert.deepEqual(releaseFlags(version), ["--prerelease", "--latest=false"]);
});

test("anything that is not a release version is refused", () => {
  for (const version of ["1.0", "01.0.0", "1.0.0-", "latest", "", undefined])
    assert.throws(() => releaseFlags(version));
});

test("the command line prints the flags for gh", () => {
  assert.equal(
    NodeChildProcess.execFileSync(process.execPath, [script, "1.0.0"], { encoding: "utf8" }),
    "--latest --prerelease=false\n",
  );
  const failed = NodeChildProcess.spawnSync(process.execPath, [script, "1.0"], {
    encoding: "utf8",
  });
  assert.equal(failed.status, 1);
  assert.equal(
    NodeChildProcess.execFileSync(process.execPath, [script, "1.1.0"], { encoding: "utf8" }),
    "--prerelease --latest=false\n",
  );
});
