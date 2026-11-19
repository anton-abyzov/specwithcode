// @effect-diagnostics nodeBuiltinImport:off globalDate:off - real git copies under a private test home, with a bare repository as their remote.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, assert, beforeEach, describe, it } from "@effect/vitest";

import {
  CHECKS_COPY_UNUSED_MS,
  type ChecksCopyFacts,
  decideChecksCopy,
  listChecksCopies,
  readChecksCopyFacts,
  retireChecksCopy,
} from "./checksCopyRetention.ts";
import { heavyCheckPaths, type HeavyCheckPaths } from "./cli/heavyCheckLock.ts";
import {
  CHECKS_COPY_LAST_USED_FILE,
  checksCopyContaining,
  touchChecksCopyUse,
} from "./cli/verificationCopy.ts";

const DAY_MS = 86_400_000;

let root: string;
let home: string;
let remote: string;
let gatePaths: HeavyCheckPaths;
/** Eight days after the fixture was written: file times cannot be set back past ctime, so the clock moves forward. */
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

/** A clone of the bare remote at `<parent>/<name>`, its one commit pushed. */
const makeCopy = (parent: string, name = "widgets") => {
  NodeFS.mkdirSync(parent, { recursive: true });
  const copy = NodePath.join(parent, name);
  git(parent, "clone", "--quiet", remote, copy);
  return copy;
};

const options = (extra: { processCwds?: ReadonlyArray<string> | null } = {}) => ({
  home,
  gatePaths,
  processCwds: extra.processCwds === undefined ? [] : extra.processCwds,
  nowMs,
});

const facts = (overrides: Partial<ChecksCopyFacts> = {}): ChecksCopyFacts => ({
  path: "/home/verify/widgets",
  lastUsedMs: 0,
  clean: true,
  localCommits: 0,
  stash: false,
  processInside: false,
  gateHeldInside: false,
  ...overrides,
});

beforeEach(() => {
  root = NodeFS.realpathSync(NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "checks-copy-")));
  home = NodePath.join(root, "home");
  gatePaths = heavyCheckPaths(NodePath.join(root, "locks"));
  NodeFS.mkdirSync(gatePaths.dir, { recursive: true });
  const seed = NodePath.join(root, "seed");
  remote = NodePath.join(root, "remote.git");
  NodeFS.mkdirSync(seed);
  git(seed, "init", "--quiet", "--initial-branch=main");
  NodeFS.writeFileSync(NodePath.join(seed, "a.txt"), "a\n");
  NodeFS.writeFileSync(NodePath.join(seed, ".gitignore"), "node_modules\n");
  git(seed, "add", "-A");
  git(seed, "commit", "--quiet", "-m", "first");
  git(root, "clone", "--quiet", "--bare", seed, remote);
  nowMs = Date.now() + 8 * DAY_MS;
});

afterEach(() => {
  NodeFS.rmSync(root, { recursive: true, force: true });
});

describe("decideChecksCopy", () => {
  const old = 0;
  const now = old + CHECKS_COPY_UNUSED_MS;

  it("removes a copy unused for exactly 7 days with nothing to lose", () => {
    assert.strictEqual(decideChecksCopy(facts({ lastUsedMs: old }), now).action, "remove");
  });

  const keeps: ReadonlyArray<readonly [string, Partial<ChecksCopyFacts>, number, RegExp]> = [
    ["a use 1 ms inside 7 days", { lastUsedMs: old + 1 }, now, /within 7 days/],
    ["a use in the future", { lastUsedMs: now + 1 }, now, /future/],
    ["an unreadable last use", { lastUsedMs: null }, now, /last used could not be read/],
    ["a dirty tree", { clean: false }, now, /uncommitted or untracked/],
    ["an unreadable tree", { clean: null }, now, /could not be read/],
    ["commits made in it", { localCommits: 2 }, now, /2 commits were made in it/],
    ["an unreadable reflog", { localCommits: null }, now, /could not be read/],
    ["a stash", { stash: true }, now, /stash/],
    ["an unreadable stash", { stash: null }, now, /could not be read/],
    ["a process inside", { processInside: true }, now, /process works in it/],
    ["unknown processes", { processInside: null }, now, /could not be read/],
    ["the gate held inside", { gateHeldInside: true }, now, /heavy-check gate is held/],
    ["an unreadable gate", { gateHeldInside: null }, now, /could not be read/],
  ];
  for (const [label, overrides, at, reason] of keeps)
    it(`keeps a copy with ${label}`, () => {
      const decision = decideChecksCopy(facts({ lastUsedMs: old, ...overrides }), at);
      assert.strictEqual(decision.action, "keep");
      assert.match(decision.reason, reason);
    });
});

describe("last use", () => {
  it("finds the copy a folder is in and records its use in .git", () => {
    const copy = makeCopy(NodePath.join(home, "verify"));
    const inner = NodePath.join(copy, "src", "deep");
    NodeFS.mkdirSync(inner, { recursive: true });
    assert.strictEqual(checksCopyContaining(inner), copy);
    assert.strictEqual(checksCopyContaining(copy), copy);
    assert.strictEqual(checksCopyContaining(root), null);
    const at = Date.now() - DAY_MS;
    touchChecksCopyUse(copy, at);
    const marker = NodePath.join(copy, ".git", CHECKS_COPY_LAST_USED_FILE);
    assert.strictEqual(NodeFS.readFileSync(marker, "utf8").trim(), new Date(at).toISOString());
    assert.strictEqual(Math.round(NodeFS.statSync(marker).mtimeMs / 1000), Math.round(at / 1000));
  });

  it("never throws for a folder that is not a copy", () => {
    touchChecksCopyUse(NodePath.join(root, "missing"));
    assert.isFalse(NodeFS.existsSync(NodePath.join(root, "missing")));
  });
});

describe("listChecksCopies", () => {
  it("lists real copies with a real .git and skips links and plain folders", () => {
    const copy = makeCopy(NodePath.join(home, "verify"));
    const outside = makeCopy(NodePath.join(root, "elsewhere"));
    NodeFS.symlinkSync(outside, NodePath.join(home, "verify", "linked"));
    NodeFS.mkdirSync(NodePath.join(home, "verify", "plain"));
    assert.deepStrictEqual(listChecksCopies(home), [copy]);
  });

  it("lists nothing when verify itself is a link", () => {
    makeCopy(NodePath.join(root, "real-verify"));
    NodeFS.mkdirSync(home, { recursive: true });
    NodeFS.symlinkSync(NodePath.join(root, "real-verify"), NodePath.join(home, "verify"));
    assert.deepStrictEqual(listChecksCopies(home), []);
  });
});

describe("retireChecksCopy", () => {
  it("removes an old clean copy whose commits are all on the remote", () => {
    const copy = makeCopy(NodePath.join(home, "verify"));
    const result = retireChecksCopy(copy, options());
    assert.isTrue(result.removed, result.reason);
    assert.isFalse(NodeFS.existsSync(copy));
    assert.isTrue(typeof result.bytes === "number" || result.bytes === null);
    assert.isTrue(NodeFS.existsSync(remote));
  });

  it("keeps a copy a commit was made in", () => {
    const copy = makeCopy(NodePath.join(home, "verify"));
    NodeFS.writeFileSync(NodePath.join(copy, "b.txt"), "b\n");
    git(copy, "add", "-A");
    git(copy, "commit", "--quiet", "-m", "local only");
    const result = retireChecksCopy(copy, options());
    assert.isFalse(result.removed);
    assert.match(result.reason, /commits were made in it/);
    assert.isTrue(NodeFS.existsSync(copy));
  });

  it("keeps a copy with a stash", () => {
    const copy = makeCopy(NodePath.join(home, "verify"));
    NodeFS.writeFileSync(NodePath.join(copy, "a.txt"), "changed\n");
    git(copy, "stash", "push", "--quiet", "-m", "fixture");
    const result = retireChecksCopy(copy, options());
    assert.isFalse(result.removed);
    assert.match(result.reason, /stash/);
    assert.isTrue(NodeFS.existsSync(copy));
  });

  it("keeps a copy used yesterday", () => {
    const copy = makeCopy(NodePath.join(home, "verify"));
    touchChecksCopyUse(copy, nowMs - DAY_MS);
    const result = retireChecksCopy(copy, options());
    assert.isFalse(result.removed);
    assert.match(result.reason, /within 7 days/);
    assert.isTrue(NodeFS.existsSync(copy));
  });

  it("keeps a copy with an untracked file but not for an ignored one", () => {
    const copy = makeCopy(NodePath.join(home, "verify"));
    NodeFS.mkdirSync(NodePath.join(copy, "node_modules"));
    NodeFS.writeFileSync(NodePath.join(copy, "node_modules", "x.js"), "x\n");
    assert.isTrue(readChecksCopyFacts(copy, options()).clean);
    NodeFS.writeFileSync(NodePath.join(copy, "notes.txt"), "mine\n");
    const result = retireChecksCopy(copy, options());
    assert.isFalse(result.removed);
    assert.match(result.reason, /uncommitted or untracked/);
  });

  it("keeps a copy a process works in, and every copy when processes are unknown", () => {
    const copy = makeCopy(NodePath.join(home, "verify"));
    NodeFS.mkdirSync(NodePath.join(copy, "src"));
    const inside = retireChecksCopy(copy, options({ processCwds: [NodePath.join(copy, "src")] }));
    assert.match(inside.reason, /process works in it/);
    const unknown = retireChecksCopy(copy, options({ processCwds: null }));
    assert.match(unknown.reason, /could not be read/);
    assert.isTrue(NodeFS.existsSync(copy));
  });

  it("keeps a copy the heavy-check gate is held from, and when the gate record is unreadable", () => {
    const copy = makeCopy(NodePath.join(home, "verify"));
    NodeFS.writeFileSync(
      gatePaths.lockFile,
      JSON.stringify({ id: "x", pid: 1, host: NodeOS.hostname(), cwd: NodePath.join(copy, "apps") }),
    );
    assert.match(retireChecksCopy(copy, options()).reason, /heavy-check gate is held/);
    NodeFS.writeFileSync(gatePaths.lockFile, "not json");
    assert.match(retireChecksCopy(copy, options()).reason, /could not be read/);
    NodeFS.writeFileSync(
      gatePaths.lockFile,
      JSON.stringify({ id: "x", pid: 1, host: NodeOS.hostname(), cwd: root }),
    );
    assert.isTrue(retireChecksCopy(copy, options()).removed);
  });

  it("refuses a removable copy outside verify, and one reached through a link", () => {
    const outside = makeCopy(NodePath.join(root, "other", "verify"));
    NodeFS.mkdirSync(NodePath.join(home, "verify"), { recursive: true });
    const refused = retireChecksCopy(outside, options());
    assert.isFalse(refused.removed);
    assert.match(refused.reason, /not a checks copy folder inside verify/);
    assert.isTrue(NodeFS.existsSync(NodePath.join(outside, ".git")));

    const link = NodePath.join(home, "verify", "linked");
    NodeFS.symlinkSync(outside, link);
    const linked = retireChecksCopy(link, options());
    assert.isFalse(linked.removed);
    assert.isTrue(NodeFS.existsSync(NodePath.join(outside, ".git")));
  });
});
