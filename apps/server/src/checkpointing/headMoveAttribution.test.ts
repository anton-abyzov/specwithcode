import { describe, expect, it } from "vite-plus/test";

import {
  checkpointHeadOid,
  checkpointMessage,
  headMoveOnlyPaths,
  localCommitsSince,
  parseCommitPaths,
} from "./headMoveAttribution.ts";

const OID_A = "a".repeat(40);
const OID_B = "b".repeat(40);
const OID_C = "c".repeat(40);

describe("checkpoint HEAD trailer", () => {
  it("round-trips the HEAD a checkpoint was taken at", () => {
    const message = checkpointMessage("refs/studio/checkpoints/x", OID_A);
    expect(message.split("\n")[0]).toBe(
      "specweave-studio checkpoint ref=refs/studio/checkpoints/x",
    );
    expect(checkpointHeadOid(message)).toBe(OID_A);
  });

  it("reads no HEAD from checkpoints written before it was recorded", () => {
    expect(checkpointHeadOid("specweave-studio checkpoint ref=refs/studio/checkpoints/x")).toBe(
      null,
    );
    expect(checkpointMessage("refs/x", null)).toBe("specweave-studio checkpoint ref=refs/x");
  });
});

describe("local commits", () => {
  const reflog = [
    `${OID_A}\tHEAD@{200}\tcommit: turn work`,
    `${OID_B}\tHEAD@{210}\tmerge origin/develop: Fast-forward`,
    `${OID_C}\tHEAD@{220}\tcommit (amend): turn work`,
    `${"d".repeat(40)}\tHEAD@{100}\tcommit: before the turn`,
    `${"e".repeat(40)}\tHEAD@{230}\tcheckout: moving from main to develop`,
    `${"f".repeat(40)}\tHEAD@{240}\trebase -i (pick): replayed`,
    `${"1".repeat(40)}\tHEAD@{250}\tcommit (merge): Merge branch 'x'`,
  ].join("\n");

  it("counts commits, amends and replayed picks made since the turn began", () => {
    expect([...localCommitsSince(reflog, 150)].toSorted()).toEqual([OID_A, OID_C, "f".repeat(40)]);
  });
});

describe("files only a HEAD move changed", () => {
  const commits = parseCommitPaths(
    [
      `@@${OID_A}`,
      "",
      "mine.txt",
      "shared.txt",
      `@@${OID_B}`,
      "",
      "theirs.txt",
      "shared.txt",
      "dirty.txt",
    ].join("\n"),
  );

  it("parses each commit's paths", () => {
    expect(commits).toEqual([
      { oid: OID_A, paths: ["mine.txt", "shared.txt"] },
      { oid: OID_B, paths: ["theirs.txt", "shared.txt", "dirty.txt"] },
    ]);
  });

  it("leaves out files from commits made elsewhere, keeping local and edited ones", () => {
    const moved = headMoveOnlyPaths({
      commits,
      localCommits: new Set([OID_A]),
      dirtyBefore: [],
      dirtyAfter: ["dirty.txt"],
    });
    expect([...moved]).toEqual(["theirs.txt"]);
  });

  it("keeps everything when every commit was made here", () => {
    expect(
      headMoveOnlyPaths({
        commits,
        localCommits: new Set([OID_A, OID_B]),
        dirtyBefore: [],
        dirtyAfter: [],
      }).size,
    ).toBe(0);
  });
});
