// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalDateInEffect:off - walks real temp folders.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as EffectVitest from "@effect/vitest";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { measureTree } from "./measure.ts";
import { walkTreeSync, type WalkFs, type WalkInput } from "./walkTree.ts";

const temps: Array<string> = [];
const tempDir = () => {
  const dir = NodeFS.realpathSync(NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "walk-")));
  temps.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of temps.splice(0)) NodeFS.rmSync(dir, { recursive: true, force: true });
});

const write = (path: string, bytes: number) => {
  NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
  NodeFS.writeFileSync(path, Buffer.alloc(bytes, 1));
};
const sizeOf = (path: string) => {
  const stat = NodeFS.lstatSync(path);
  return stat.blocks > 0 ? stat.blocks * 512 : stat.size;
};
const run = (input: WalkInput, fs: WalkFs = NodeFS as unknown as WalkFs, stop = () => false) =>
  walkTreeSync(input, fs, NodePath, stop, () => Date.now());
const input = (root: string, parts: WalkInput["parts"] = []): WalkInput => ({
  root,
  parts,
  maxEntries: 1_000_000,
  deadlineMs: 60_000,
});
const part = (result: ReturnType<typeof run>, key: string) =>
  result.parts.find((entry) => entry.key === key)!;

describe("walkTreeSync", () => {
  it("counts a hard-linked file once", () => {
    const root = tempDir();
    write(NodePath.join(root, "a", "big.bin"), 256 * 1024);
    NodeFS.linkSync(NodePath.join(root, "a", "big.bin"), NodePath.join(root, "b-link.bin"));
    const once = run(input(root));
    NodeFS.rmSync(NodePath.join(root, "b-link.bin"));
    const without = run(input(root));
    expect(once.complete).toBe(true);
    // The second link adds no file bytes (the folder's own entry may grow a little).
    expect(once.totalBytes - without.totalBytes).toBeLessThan(4096);
    expect(once.totalBytes).toBeGreaterThanOrEqual(256 * 1024);
  });

  it("never follows a symlink and counts it by its own size", () => {
    const root = tempDir();
    const outside = tempDir();
    write(NodePath.join(outside, "huge.bin"), 1024 * 1024);
    NodeFS.symlinkSync(outside, NodePath.join(root, "linked-dir"));
    NodeFS.symlinkSync(NodePath.join(outside, "huge.bin"), NodePath.join(root, "linked-file"));
    const result = run(input(root));
    expect(result.complete).toBe(true);
    expect(result.totalBytes).toBeLessThan(1024 * 1024);
    expect(result.entries).toBe(3);
  });

  it("splits parts from the rest and counts checkouts in worktrees", () => {
    const root = tempDir();
    const worktrees = NodePath.join(root, "m4", "worktrees");
    write(NodePath.join(worktrees, "repo-a", ".git"), 40);
    write(NodePath.join(worktrees, "project", "repo-b", ".git"), 40);
    write(NodePath.join(worktrees, "repo-a", "src", "index.ts"), 64 * 1024);
    write(NodePath.join(root, "backups", "copy.bin"), 128 * 1024);
    write(NodePath.join(root, "loose.bin"), 32 * 1024);
    const result = run(
      input(root, [
        { key: "worktrees", paths: [worktrees], countCheckouts: true },
        { key: "backups", paths: [NodePath.join(root, "backups")] },
        { key: "missing", paths: [NodePath.join(root, "nope")] },
      ]),
    );
    expect(part(result, "worktrees").checkouts).toBe(2);
    expect(part(result, "worktrees").bytes).toBeGreaterThanOrEqual(64 * 1024);
    expect(part(result, "backups").bytes).toBeGreaterThanOrEqual(128 * 1024);
    expect(part(result, "missing").bytes).toBe(0);
    // `other` holds the loose file but none of the parts.
    expect(part(result, "other").bytes).toBeLessThan(128 * 1024);
    expect(part(result, "other").bytes).toBeGreaterThanOrEqual(
      sizeOf(NodePath.join(root, "loose.bin")),
    );
    expect(result.totalBytes).toBe(result.parts.reduce((sum, entry) => sum + entry.bytes, 0));
  });

  it("reports each scratch child's size and newest change", () => {
    const root = tempDir();
    const scratch = NodePath.join(root, "scratch");
    write(NodePath.join(scratch, "probe", "notes.txt"), 10);
    write(NodePath.join(scratch, "probe", "node_modules", "pkg", "index.js"), 4096);
    write(NodePath.join(scratch, "loose.log"), 10);
    const before = Date.now() - 60_000;
    const result = run(input(root, [{ key: "scratch", paths: [scratch], children: true }]));
    const children = part(result, "scratch").children;
    expect(children.map((child) => [child.name, child.kind])).toEqual([
      ["loose.log", "file"],
      ["probe", "directory"],
    ]);
    const probe = children[1]!;
    expect(probe.bytes).toBeGreaterThanOrEqual(4096);
    expect(probe.newestMs).toBeGreaterThan(before);
    const only = run({
      ...input(root, [
        { key: "scratch", paths: [scratch], children: true, onlyChildren: ["probe"] },
      ]),
      measureRest: false,
    });
    expect(only.parts.map((entry) => entry.key)).toEqual(["scratch"]);
    expect(part(only, "scratch").children.map((child) => child.name)).toEqual(["probe"]);
  });

  // oxlint-disable-next-line studio/no-global-process-runtime -- picks which tests run; no Effect runtime yet.
  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "leaves a child's age unknown when part of it cannot be read",
    () => {
      const root = tempDir();
      const scratch = NodePath.join(root, "scratch");
      const locked = NodePath.join(scratch, "probe", "locked");
      write(NodePath.join(locked, "file"), 10);
      NodeFS.chmodSync(locked, 0o000);
      try {
        const result = run(input(root, [{ key: "scratch", paths: [scratch], children: true }]));
        expect(part(result, "scratch").children[0]!.newestMs).toBeNull();
        expect(result.unreadable).toBeGreaterThan(0);
      } finally {
        NodeFS.chmodSync(locked, 0o700);
      }
    },
  );

  it("skips entries on another device", () => {
    const root = "/home/me/.specwithcode";
    const tree: Record<string, { dev: bigint; children?: Array<string> }> = {
      [root]: { dev: 1n, children: ["m4", "mounted"] },
      [`${root}/m4`]: { dev: 1n, children: ["file"] },
      [`${root}/m4/file`]: { dev: 1n },
      [`${root}/mounted`]: { dev: 2n, children: ["secret"] },
      [`${root}/mounted/secret`]: { dev: 2n },
    };
    const read: Array<string> = [];
    const fake: WalkFs = {
      lstatSync: (path) => {
        const node = tree[path];
        if (node === undefined) throw new Error(`ENOENT ${path}`);
        return {
          dev: node.dev,
          ino: BigInt(Object.keys(tree).indexOf(path) + 1),
          nlink: 1n,
          size: 1000n,
          blocks: 0n,
          mtimeMs: 1n,
          ctimeMs: 1n,
          isDirectory: () => node.children !== undefined,
          isFile: () => node.children === undefined,
          isSymbolicLink: () => false,
        };
      },
      readdirSync: (path) => {
        read.push(path);
        return [...(tree[path]?.children ?? [])];
      },
    };
    const result = run(input(root), fake);
    expect(result.otherDevice).toBe(1);
    expect(result.totalBytes).toBe(3000);
    expect(read).not.toContain(`${root}/mounted`);
  });

  it("stops when asked, at the entry limit and reports itself incomplete", () => {
    const root = tempDir();
    for (let index = 0; index < 300; index += 1) write(NodePath.join(root, `f${index}`), 1);
    const cancelled = run(input(root), NodeFS as unknown as WalkFs, () => true);
    expect(cancelled.complete).toBe(false);
    expect(cancelled.stopped).toBe("cancelled");
    expect(cancelled.entries).toBeLessThan(300);
    const limited = run({ ...input(root), maxEntries: 10 });
    expect(limited.stopped).toBe("entries");
    expect(limited.entries).toBe(10);
  });
});

describe("walkTreeSync budgets and moved folders", () => {
  it("measures parts listed before a huge one when the entry limit trips", () => {
    const root = tempDir();
    write(NodePath.join(root, "scratch", "probe", "out.log"), 4096);
    for (let index = 0; index < 200; index += 1)
      write(NodePath.join(root, "worktrees", "lane", "node_modules", `f${index}`), 1);
    const result = run({
      ...input(root, [
        { key: "scratch", paths: [NodePath.join(root, "scratch")], children: true },
        { key: "worktrees", paths: [NodePath.join(root, "worktrees")] },
      ]),
      maxEntries: 50,
    });
    expect(result.complete).toBe(false);
    const scratch = part(result, "scratch");
    expect(scratch.bytes).toBeGreaterThanOrEqual(4096);
    expect(scratch.children[0]!.newestMs).not.toBeNull();
  });

  it("measures a home folder and a worktrees folder that are symlinks to elsewhere", () => {
    const user = tempDir();
    const elsewhere = tempDir();
    const realHome = NodePath.join(elsewhere, "home");
    const realWorktrees = NodePath.join(elsewhere, "worktrees");
    write(NodePath.join(realHome, "m4", "userdata", "db"), 8192);
    write(NodePath.join(realWorktrees, "lane", "big.bin"), 64 * 1024);
    const home = NodePath.join(user, ".specwithcode");
    NodeFS.symlinkSync(realHome, home);
    NodeFS.symlinkSync(realWorktrees, NodePath.join(realHome, "m4", "worktrees"));
    const result = run(
      input(home, [{ key: "worktrees", paths: [NodePath.join(home, "m4", "worktrees")] }]),
      NodeFS as unknown as WalkFs,
    );
    expect(result.complete).toBe(true);
    expect(part(result, "worktrees").bytes).toBeGreaterThanOrEqual(64 * 1024);
    expect(part(result, "other").bytes).toBeGreaterThanOrEqual(8192);
    // The worktrees link is skipped in the rest, so nothing counts twice.
    expect(part(result, "other").bytes).toBeLessThan(64 * 1024);
  });

  it("never resolves a part to a folder holding the root", () => {
    const user = tempDir();
    const home = NodePath.join(user, ".specwithcode");
    write(NodePath.join(home, "m4", "file"), 4096);
    NodeFS.symlinkSync(user, NodePath.join(home, "m4", "worktrees"));
    const result = run(
      input(home, [{ key: "worktrees", paths: [NodePath.join(home, "m4", "worktrees")] }]),
    );
    expect(part(result, "worktrees").bytes).toBeLessThan(4096);
  });

  it("pauses every 1024 entries and not when stopped", () => {
    const root = tempDir();
    for (let index = 0; index < 2100; index += 1) write(NodePath.join(root, `f${index}`), 1);
    let pauses = 0;
    walkTreeSync(
      input(root),
      NodeFS as unknown as WalkFs,
      NodePath,
      () => false,
      () => Date.now(),
      () => {
        pauses += 1;
      },
    );
    expect(pauses).toBe(2);
  });
});

describe("measureTree", () => {
  EffectVitest.it.effect("walks in a worker thread", () =>
    Effect.gen(function* () {
      const root = tempDir();
      write(NodePath.join(root, "a.bin"), 64 * 1024);
      const result = yield* measureTree(input(root));
      expect(result.complete).toBe(true);
      expect(result.totalBytes).toBeGreaterThanOrEqual(64 * 1024);
    }),
  );

  EffectVitest.it.effect("is cancelled by interruption", () =>
    Effect.gen(function* () {
      const root = tempDir();
      for (let index = 0; index < 50; index += 1) write(NodePath.join(root, `f${index}`), 1);
      const fiber = yield* Effect.forkChild(measureTree(input(root)));
      const exit = yield* Fiber.interrupt(fiber).pipe(Effect.andThen(Fiber.await(fiber)));
      expect(Exit.hasInterrupts(exit)).toBe(true);
    }),
  );
});
