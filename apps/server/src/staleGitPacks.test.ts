// @effect-diagnostics nodeBuiltinImport:off globalDate:off - a real git repository with leftover download files planted in it.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, assert, beforeEach, describe, it } from "@effect/vitest";

import {
  CHECKS_COPY_STALE_PACK_MS,
  findStaleGitPacks,
  removeStaleGitPacks,
  SWEEP_STALE_PACK_MS,
  verificationCopyGitDirs,
} from "./staleGitPacks.ts";

let root: string;
let repo: string;
let gitDir: string;
let packDir: string;
/** Ten hours after the files were written: ctime cannot be set back, so the clock moves forward instead. */
let nowMs: number;

const git = (cwd: string, ...args: ReadonlyArray<string>) =>
  NodeChildProcess.execFileSync(
    "git",
    [
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.com",
      "-c",
      "core.hooksPath=/dev/null",
      ...args,
    ],
    { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  ).trim();

const plant = (relative: string, bytes = 16) => {
  const file = NodePath.join(gitDir, relative);
  NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true });
  NodeFS.writeFileSync(file, Buffer.alloc(bytes));
  return file;
};

/** Sets mtime so the file is `ageMs` old at `nowMs`; only ever moves it forward of the real ctime. */
const age = (file: string, ageMs: number) => {
  const seconds = (nowMs - ageMs) / 1000;
  NodeFS.utimesSync(file, seconds, seconds);
};

const names = (packs: ReadonlyArray<{ readonly path: string }>) =>
  packs.map((pack) => NodePath.relative(gitDir, pack.path)).toSorted();

const exists = (relative: string) => NodeFS.existsSync(NodePath.join(gitDir, relative));

beforeEach(() => {
  root = NodeFS.realpathSync(NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "stale-packs-")));
  repo = NodePath.join(root, "repo");
  NodeFS.mkdirSync(repo);
  git(repo, "init", "--quiet", "--initial-branch=main");
  NodeFS.writeFileSync(NodePath.join(repo, "a.txt"), "a\n");
  git(repo, "add", "-A");
  git(repo, "commit", "--quiet", "-m", "first");
  NodeFS.writeFileSync(NodePath.join(repo, "b.txt"), "b\n");
  git(repo, "add", "-A");
  git(repo, "commit", "--quiet", "-m", "second");
  // One real pack, plus the loose objects of a third commit.
  git(repo, "repack", "--quiet", "-a", "-d");
  NodeFS.writeFileSync(NodePath.join(repo, "c.txt"), "c\n");
  git(repo, "add", "-A");
  git(repo, "commit", "--quiet", "-m", "third");
  gitDir = NodePath.join(repo, ".git");
  packDir = NodePath.join(gitDir, "objects", "pack");
  nowMs = Date.now() + 10 * 3_600_000;
});

afterEach(() => {
  NodeFS.chmodSync(packDir, 0o755);
  NodeFS.rmSync(root, { recursive: true, force: true });
});

describe("stale git packs", () => {
  it("finds only old temporary download files and keeps real packs, links, folders and fresh files", () => {
    const options = { olderThanMs: CHECKS_COPY_STALE_PACK_MS, nowMs };
    plant("objects/pack/tmp_pack_old", 1000);
    plant("objects/pack/tmp_obj_old", 10);
    plant("objects/ab/tmp_obj_old", 20);
    plant("objects/pack/.tmp-4242-pack-0123abcd.pack", 30);
    age(plant("objects/pack/tmp_pack_two_hours"), 2 * 3_600_000);
    // One minute short of the limit: a fetch may still be writing it.
    age(plant("objects/pack/tmp_pack_fresh"), CHECKS_COPY_STALE_PACK_MS - 60_000);
    age(plant("objects/cd/tmp_obj_fresh"), 0);
    NodeFS.symlinkSync(NodePath.join(root, "elsewhere"), NodePath.join(packDir, "tmp_pack_x"));
    NodeFS.mkdirSync(NodePath.join(packDir, "tmp_pack_dir"));
    // Not git's temporary names, or not in a place git writes them.
    plant("objects/tmp_obj_top");
    plant("objects/info/tmp_obj_info");
    plant("objects/xyz/tmp_obj_bad_dir");
    plant("objects/pack/old_tmp_pack_x");
    plant("objects/pack/pack-keep.keep");

    assert.deepStrictEqual(names(findStaleGitPacks(gitDir, options)), [
      "objects/ab/tmp_obj_old",
      "objects/pack/.tmp-4242-pack-0123abcd.pack",
      "objects/pack/tmp_obj_old",
      "objects/pack/tmp_pack_old",
      "objects/pack/tmp_pack_two_hours",
    ]);
    // Six hours for the sweep: the two-hour-old file stays.
    assert.notInclude(
      names(findStaleGitPacks(gitDir, { olderThanMs: SWEEP_STALE_PACK_MS, nowMs })),
      "objects/pack/tmp_pack_two_hours",
    );

    const realPacks = NodeFS.readdirSync(packDir).filter((name) => name.startsWith("pack-"));
    const looseObjects = Number(/count: (\d+)/.exec(git(repo, "count-objects", "-v"))?.[1] ?? "0");
    const result = removeStaleGitPacks(gitDir, options);
    assert.deepStrictEqual(names(result.removed), [
      "objects/ab/tmp_obj_old",
      "objects/pack/.tmp-4242-pack-0123abcd.pack",
      "objects/pack/tmp_obj_old",
      "objects/pack/tmp_pack_old",
      "objects/pack/tmp_pack_two_hours",
    ]);
    assert.strictEqual(result.bytes, 1000 + 10 + 20 + 30 + 16);
    assert.deepStrictEqual(result.failed, []);

    assert.isFalse(exists("objects/pack/tmp_pack_old"));
    assert.isFalse(exists("objects/ab/tmp_obj_old"));
    for (const kept of [
      "objects/pack/tmp_pack_fresh",
      "objects/cd/tmp_obj_fresh",
      "objects/pack/tmp_pack_dir",
      "objects/tmp_obj_top",
      "objects/info/tmp_obj_info",
      "objects/xyz/tmp_obj_bad_dir",
      "objects/pack/old_tmp_pack_x",
      "objects/pack/pack-keep.keep",
    ])
      assert.isTrue(exists(kept), kept);
    assert.isTrue(NodeFS.lstatSync(NodePath.join(packDir, "tmp_pack_x")).isSymbolicLink());
    for (const name of realPacks) assert.isTrue(NodeFS.existsSync(NodePath.join(packDir, name)));
    // The repository is whole: every pack and loose object is still there and readable.
    assert.strictEqual(
      Number(/count: (\d+)/.exec(git(repo, "count-objects", "-v"))?.[1] ?? "0"),
      looseObjects,
    );
    git(repo, "fsck", "--no-progress", "--strict");
    assert.strictEqual(git(repo, "log", "--format=%s").split("\n").length, 3);
  });

  it("reads the age again before removing, and keeps a file a fetch touched since the listing", () => {
    const options = { olderThanMs: CHECKS_COPY_STALE_PACK_MS, nowMs };
    const touched = plant("objects/pack/tmp_pack_resumed");
    assert.strictEqual(findStaleGitPacks(gitDir, options).length, 1);
    age(touched, 0);
    const result = removeStaleGitPacks(gitDir, options);
    assert.deepStrictEqual(result.removed, []);
    assert.isTrue(NodeFS.existsSync(touched));
  });

  it("lists a file it could not remove instead of throwing", () => {
    const stuck = plant("objects/pack/tmp_pack_stuck");
    NodeFS.chmodSync(packDir, 0o555);
    const result = removeStaleGitPacks(gitDir, { olderThanMs: CHECKS_COPY_STALE_PACK_MS, nowMs });
    NodeFS.chmodSync(packDir, 0o755);
    assert.deepStrictEqual(result.removed, []);
    assert.deepStrictEqual(result.failed, [stuck]);
    assert.isTrue(NodeFS.existsSync(stuck));
  });

  it("returns nothing for a missing or linked folder", () => {
    const options = { olderThanMs: CHECKS_COPY_STALE_PACK_MS, nowMs };
    plant("objects/pack/tmp_pack_old");
    assert.deepStrictEqual(findStaleGitPacks(NodePath.join(root, "missing"), options), []);
    assert.deepStrictEqual(findStaleGitPacks(repo, options), []);
    const linked = NodePath.join(root, "linked.git");
    NodeFS.symlinkSync(gitDir, linked);
    assert.deepStrictEqual(findStaleGitPacks(linked, options), []);
    assert.deepStrictEqual(removeStaleGitPacks(linked, options).removed, []);
    assert.isTrue(exists("objects/pack/tmp_pack_old"));
  });

  it("lists the .git folder of each real copy under <home>/verify and nothing else", () => {
    const home = NodePath.join(root, "home");
    const verify = NodePath.join(home, "verify");
    for (const name of ["widgets", "gadgets"])
      NodeFS.mkdirSync(NodePath.join(verify, name, ".git"), { recursive: true });
    // A linked worktree's .git is a file.
    NodeFS.mkdirSync(NodePath.join(verify, "worktree"));
    NodeFS.writeFileSync(NodePath.join(verify, "worktree", ".git"), "gitdir: /elsewhere\n");
    // A copy whose .git links elsewhere, and a copy that is itself a link.
    NodeFS.mkdirSync(NodePath.join(verify, "linked-git"));
    NodeFS.symlinkSync(gitDir, NodePath.join(verify, "linked-git", ".git"));
    NodeFS.symlinkSync(repo, NodePath.join(verify, "linked-copy"));
    NodeFS.mkdirSync(NodePath.join(verify, "no-git"));
    NodeFS.writeFileSync(NodePath.join(verify, "notes.txt"), "");
    // Repositories elsewhere in the home are not copies.
    NodeFS.mkdirSync(NodePath.join(home, "worktrees", "chat", ".git"), { recursive: true });

    assert.deepStrictEqual(verificationCopyGitDirs(home), [
      NodePath.join(verify, "gadgets", ".git"),
      NodePath.join(verify, "widgets", ".git"),
    ]);
    assert.deepStrictEqual(verificationCopyGitDirs(NodePath.join(root, "no-home")), []);
    // A verify folder that is a link points outside the home.
    const otherHome = NodePath.join(root, "other-home");
    NodeFS.mkdirSync(otherHome);
    NodeFS.symlinkSync(verify, NodePath.join(otherHome, "verify"));
    assert.deepStrictEqual(verificationCopyGitDirs(otherHome), []);
  });
});
