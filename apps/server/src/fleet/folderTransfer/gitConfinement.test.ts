// @effect-diagnostics nodeBuiltinImport:off - disposable Git repositories only.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { git } from "./folderFixture.testkit.ts";
import { gitTouchedPaths } from "./gitConfinement.ts";

/**
 * The folders Apply checks before Git writes come from the paths Git prints. A
 * name whose bytes are not UTF-8 reads back as another name, so the folder
 * checked would not be the folder Git writes into: such a list is refused.
 */

let base: string;
beforeAll(() => {
  base = NodeFS.realpathSync(NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "swc-gitpaths-")));
});
afterAll(() => NodeFS.rmSync(base, { recursive: true, force: true }));

/** A commit whose tree holds `dir/<name>/file`, with `name` given as raw bytes. */
function commitWith(repo: string, name: Buffer): string {
  const run = (args: Array<string>, input?: Buffer) =>
    NodeChildProcess.execFileSync("git", ["-C", repo, ...args], { input })
      .toString()
      .trim();
  const blob = run(["hash-object", "-w", "--stdin"], Buffer.from("x\n"));
  const inner = run(["mktree"], Buffer.from(`100644 blob ${blob}\tfile\n`));
  const named = run(
    ["mktree"],
    Buffer.concat([Buffer.from(`040000 tree ${inner}\t`), name, Buffer.from("\n")]),
  );
  const top = run(["mktree"], Buffer.from(`040000 tree ${named}\tdir\n`));
  return run([
    "-c",
    "user.name=T",
    "-c",
    "user.email=t@example.invalid",
    "commit-tree",
    top,
    "-m",
    "c",
  ]);
}

describe("gitTouchedPaths", () => {
  it("lists the paths of a commit whose names are UTF-8", async () => {
    const repo = NodePath.join(base, "plain");
    NodeFS.mkdirSync(repo);
    git(repo, "init", "-q");
    const commit = commitWith(repo, Buffer.from("café"));
    expect(await gitTouchedPaths(repo, null, commit)).toEqual(["dir/café/file"]);
  });

  it("refuses a list holding a name that is not UTF-8", async () => {
    const repo = NodePath.join(base, "raw");
    NodeFS.mkdirSync(repo);
    git(repo, "init", "-q");
    const commit = commitWith(repo, Buffer.from([0x61, 0xff, 0x62]));
    expect(await gitTouchedPaths(repo, null, commit)).toBeNull();
  });
});
