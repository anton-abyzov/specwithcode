// @effect-diagnostics nodeBuiltinImport:off - disposable real Git fixtures only.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "@effect/vitest";

import { readSmallText } from "../fleet/folderTransfer/secretContent.ts";
import { writeCheckpoint } from "./checkpointGit.ts";
import {
  cleanUp,
  commit,
  fakeKeyHeader,
  fakeToken,
  filesOf,
  git,
  isolateGit,
  restoreGit,
  snapshot,
  stagingFolder,
  twoMachines,
  write,
} from "./extrasTestKit.ts";
import { checkSnapshotContent, checkStagedContent, readFileHead } from "./snapshotSecrets.ts";

beforeAll(isolateGit);
afterAll(restoreGit);
afterEach(cleanUp);

const KB = 1024;
const canRead = (file: string) => {
  try {
    NodeFS.readFileSync(file);
    return true;
  } catch {
    return false;
  }
};
const filler = (bytes: number) => "x".repeat(bytes - 1) + "\n";

describe("the snapshot's content check (1390 AC-14)", () => {
  it("reads the first 64 KB of a file of any size, where readSmallText returns nothing", async () => {
    const { a } = twoMachines();
    write(a, "big.txt", `token=${fakeToken()}\n${filler(200 * KB)}`);
    const absolute = NodePath.join(a, "big.txt");
    expect(await readSmallText(absolute, 64 * KB)).toBeNull();
    const head = await readFileHead(absolute);
    expect(Buffer.isBuffer(head) && head.length).toBe(64 * KB);
    const checked = await checkSnapshotContent({
      root: a,
      untracked: ["big.txt"],
      pastLimit: "leave-out",
    });
    expect(checked.leftOut).toEqual([{ path: "big.txt", reason: "content", kind: "GitHub token" }]);
  });

  it("does not find a token past the first 64 KB, and says nothing about it", async () => {
    const { a } = twoMachines();
    write(a, "deep.txt", `${filler(64 * KB)}token=${fakeToken()}\n`);
    const checked = await checkSnapshotContent({
      root: a,
      untracked: ["deep.txt"],
      pastLimit: "leave-out",
    });
    expect(checked.leftOut).toEqual([]);
  });

  it("never follows a link, and reads no folder or missing file", async () => {
    const { a, base } = twoMachines();
    write(base, "outside.txt", `token=${fakeToken()}\n`);
    NodeFS.symlinkSync(NodePath.join(base, "outside.txt"), NodePath.join(a, "link.txt"));
    NodeFS.mkdirSync(NodePath.join(a, "folder"));
    expect(await readFileHead(NodePath.join(a, "link.txt"))).toBeNull();
    expect(await readFileHead(NodePath.join(a, "folder"))).toBeNull();
    expect(await readFileHead(NodePath.join(a, "gone.txt"))).toBeNull();
    // A link travels as a link, not as the file it points to: there is no content to flag.
    const checked = await checkSnapshotContent({
      root: a,
      untracked: ["link.txt"],
      pastLimit: "leave-out",
    });
    expect(checked.leftOut).toEqual([]);
  });

  it("finds a token in a binary file and in a UTF-16 one (P2-04)", async () => {
    const { a } = twoMachines();
    const token = fakeToken();
    write(a, "image.bin", Buffer.concat([Buffer.from([0, 1, 2, 0]), Buffer.from(token)]));
    write(a, "notes-le.txt", Buffer.from(`\ufefftoken=${token}\r\n`, "utf16le"));
    write(a, "notes-be.txt", Buffer.from(`\ufefftoken=${token}\r\n`, "utf16le").swap16());
    write(a, "notes-nobom.txt", Buffer.from(`token=${token}\r\n`, "utf16le"));
    write(a, "plain.bin", Buffer.from([0, 1, 2, 3, 0, 255, 254]));
    const checked = await checkSnapshotContent({
      root: a,
      untracked: ["image.bin", "notes-be.txt", "notes-le.txt", "notes-nobom.txt", "plain.bin"],
      pastLimit: "leave-out",
    });
    expect(checked.leftOut).toEqual(
      ["image.bin", "notes-be.txt", "notes-le.txt", "notes-nobom.txt"].map((path) => ({
        path,
        reason: "content",
        kind: "GitHub token",
      })),
    );
  });

  it("reports a file it cannot read as not checked, never as fine (P2-04)", async () => {
    const { a } = twoMachines();
    write(a, "locked.txt", `token=${fakeToken()}\n`);
    NodeFS.chmodSync(NodePath.join(a, "locked.txt"), 0o000);
    try {
      // Where the mode does not keep this process out (an administrator, a file system
      // without modes), the case does not exist.
      if (canRead(NodePath.join(a, "locked.txt"))) return;
      expect(await readFileHead(NodePath.join(a, "locked.txt"))).toBe("unreadable");
      const dialog = await checkSnapshotContent({
        root: a,
        untracked: ["locked.txt"],
        pastLimit: "leave-out",
      });
      expect(dialog.leftOut).toEqual([{ path: "locked.txt", reason: "not-checked", kind: null }]);
      const standby = await checkSnapshotContent({
        root: a,
        untracked: ["locked.txt"],
        pastLimit: "name-only",
      });
      expect(standby).toEqual({ leftOut: [], notCheckedCount: 1 });
    } finally {
      NodeFS.chmodSync(NodePath.join(a, "locked.txt"), 0o600);
    }
  });

  it("reads at most the file cap: the rest is left out in a dialog, counted for a standby", async () => {
    const { a } = twoMachines();
    const names = ["a.txt", "b.txt", "c.txt", "d.txt"];
    for (const name of names) write(a, name, "plain\n");
    write(a, "d.txt", `token=${fakeToken()}\n`);
    const dialog = await checkSnapshotContent({
      root: a,
      untracked: names,
      pastLimit: "leave-out",
      maxFiles: 2,
    });
    expect(dialog.leftOut).toEqual([
      { path: "c.txt", reason: "not-checked", kind: null },
      { path: "d.txt", reason: "not-checked", kind: null },
    ]);
    expect(dialog.notCheckedCount).toBe(0);
    const standby = await checkSnapshotContent({
      root: a,
      untracked: names,
      pastLimit: "name-only",
      maxFiles: 2,
    });
    expect(standby).toEqual({ leftOut: [], notCheckedCount: 2 });
    // "Send anyway" files are neither read nor counted against the cap.
    const allowed = await checkSnapshotContent({
      root: a,
      untracked: names,
      allow: new Set(["a.txt", "b.txt", "d.txt"]),
      pastLimit: "leave-out",
      maxFiles: 1,
    });
    expect(allowed.leftOut).toEqual([]);
  });
});

/** The case of AC-31: what a snapshot of real uncommitted work carries and leaves out. */
function dirtyRepository() {
  const { a } = twoMachines();
  commit(a, "test/fixture.pem.txt", `${fakeKeyHeader()}\nfixture\n`);
  commit(a, "old.ts", "export const old = 1;\n");
  // Tracked file holding a key header, changed: checked by name only, so it travels.
  write(a, "test/fixture.pem.txt", `${fakeKeyHeader()}\nfixture, edited\n`);
  NodeFS.rmSync(NodePath.join(a, "old.ts"));
  write(a, ".specweave/project/credentials.json", `{"token":"${fakeToken()}"}\n`);
  write(a, "notes.txt", `remember: ${fakeToken()}\n`);
  write(a, "deep.txt", `${filler(64 * KB)}token=${fakeToken()}\n`);
  write(a, "plain.txt", "nothing to see\n");
  write(a, ".env", "API_KEY=abc\n");
  return a;
}

describe("a snapshot with the content check (1390 AC-14, AC-31)", () => {
  it("leaves out flagged untracked files, and lets the rest travel", async () => {
    const a = dirtyRepository();
    const before = snapshot(a);
    const written = await writeCheckpoint({
      cwd: a,
      threadId: "sync-test",
      ref: "refs/specwithcode/extras/test/0",
      contentCheck: { pastLimit: "leave-out" },
    });
    const carried = filesOf(a, written.commit);
    expect(carried).not.toContain(".specweave/project/credentials.json");
    expect(carried).not.toContain("notes.txt");
    expect(carried).not.toContain(".env");
    // A token past the first 64 KB travels: the check does not reach it.
    expect(carried).toContain("deep.txt");
    expect(carried).toContain("plain.txt");
    // The tracked file with a key header travels with its change; the deletion travels.
    expect(git(a, "show", `${written.commit}:test/fixture.pem.txt`)).toContain("fixture, edited");
    expect(carried).not.toContain("old.ts");
    const leftOut = [
      ...written.excludedSecretPaths.map((path) => `${path} name`),
      ...written.leftOutByContent.map((file) => `${file.path} ${file.reason} ${file.kind}`),
    ].toSorted();
    expect(leftOut).toContain("notes.txt content GitHub token");
    expect(leftOut).toContain(".env name");
    expect(
      leftOut.filter((line) => line.startsWith(".specweave/project/credentials.json")),
    ).toHaveLength(1);
    expect(leftOut.some((line) => line.startsWith("deep.txt"))).toBe(false);
    // Built with a private index: the branch, index and working tree did not change.
    expect(snapshot(a)).toEqual(before);
  });

  it("sends a flagged file anyway when asked to, but never a secret by name", async () => {
    const a = dirtyRepository();
    const written = await writeCheckpoint({
      cwd: a,
      threadId: "sync-test",
      ref: "refs/specwithcode/extras/test/1",
      contentCheck: { pastLimit: "leave-out", sendAnyway: ["notes.txt", ".env"] },
    });
    const carried = filesOf(a, written.commit);
    expect(carried).toContain("notes.txt");
    expect(carried).not.toContain(".env");
    expect(written.leftOutByContent.map((file) => file.path)).not.toContain("notes.txt");
  });

  it("checks what was staged, not what was read before it (P2-05)", async () => {
    const a = dirtyRepository();
    write(a, "later.txt", "nothing to see\n");
    write(a, "grows.bin", "small\n");
    write(a, "stays.txt", "fine\n");
    const before = snapshot(a);
    const written = await writeCheckpoint({
      cwd: a,
      threadId: "sync-test",
      ref: "refs/specwithcode/extras/test/2",
      contentCheck: {
        pastLimit: "leave-out",
        // A running thread rewrites two files between the check and the staging.
        onChecked: async () => {
          write(a, "later.txt", `token=${fakeToken()}\n`);
          write(a, "grows.bin", Buffer.alloc(10 * 1024 * 1024 + 1, 97));
        },
      },
    });
    const carried = filesOf(a, written.commit);
    expect(carried).toContain("stays.txt");
    expect(carried).not.toContain("later.txt");
    expect(written.leftOutByContent).toContainEqual({
      path: "later.txt",
      reason: "content",
      kind: "GitHub token",
    });
    // The file that grew past the limit is named, so the caller keeps the extra.
    expect(written.overLimit).toMatchObject({ path: "grows.bin", reason: "too-large" });
    expect(written.overLimit!.bytes).toBe(10 * 1024 * 1024 + 1);
    write(a, "later.txt", "nothing to see\n");
    write(a, "grows.bin", "small\n");
    expect(snapshot(a)).toEqual(before);
  });

  it("judges files that appear in a folder swapped in for a checked file (P2-05)", async () => {
    const a = dirtyRepository();
    write(a, "swap.txt", "nothing to see\n");
    const written = await writeCheckpoint({
      cwd: a,
      threadId: "sync-test",
      ref: "refs/specwithcode/extras/test/3",
      contentCheck: {
        pastLimit: "leave-out",
        // The checked file becomes a folder holding a note with a token and a secret by name.
        onChecked: async () => {
          NodeFS.rmSync(NodePath.join(a, "swap.txt"));
          write(a, "swap.txt/n.txt", `token=${fakeToken()}\n`);
          write(a, "swap.txt/.env", "API_KEY=1\n");
          write(a, "swap.txt/fine.txt", "fine\n");
        },
      },
    });
    const carried = filesOf(a, written.commit);
    expect(carried).toContain("swap.txt/fine.txt");
    expect(carried).not.toContain("swap.txt/n.txt");
    expect(carried).not.toContain("swap.txt/.env");
    expect(written.leftOutByContent).toContainEqual({
      path: "swap.txt/n.txt",
      reason: "content",
      kind: "GitHub token",
    });
    expect(written.excludedSecretPaths).toContain("swap.txt/.env");
    expect(written.excludedSecretCount).toBe(written.excludedSecretPaths.length);
    NodeFS.rmSync(NodePath.join(a, "swap.txt"), { recursive: true });
  });

  /** Stages everything in a throwaway repository and returns the tree and its base commit. */
  const stagedTree = (folder: string) => {
    git(folder, "add", "-A");
    return { baseCommit: git(folder, "rev-parse", "HEAD"), tree: git(folder, "write-tree") };
  };
  const stagedCheck = (folder: string, limits: { maxFiles?: number; maxChangedFiles?: number }) =>
    checkStagedContent({
      root: folder,
      ...stagedTree(folder),
      secretName: (path) => path.endsWith(".env"),
      maxFileBytes: 10 * 1024 * 1024,
      maxChangedFiles: limits.maxChangedFiles ?? 20_000,
      ...(limits.maxFiles === undefined ? {} : { maxFiles: limits.maxFiles }),
    });

  it("reports staged files past the read limit as not checked, never as fine (P2-12)", async () => {
    const { a } = twoMachines();
    write(a, "new/a.txt", "fine\n");
    write(a, "new/b.txt", `token=${fakeToken()}\n`);
    write(a, "new/c.txt", "fine\n");
    write(a, "new/d.txt", `token=${fakeToken()}\n`);
    const staged = await stagedCheck(a, { maxFiles: 2 });
    // The first two are read; the other two are named as not checked, whatever they hold.
    expect(staged.flagged).toEqual([
      { path: "new/b.txt", reason: "content", kind: "GitHub token" },
      { path: "new/c.txt", reason: "not-checked", kind: null },
      { path: "new/d.txt", reason: "not-checked", kind: null },
    ]);
    // Within the limit nothing is reported as not checked.
    expect((await stagedCheck(a, {})).flagged.map((file) => file.reason)).toEqual([
      "content",
      "content",
    ]);
  });

  it("names the first changed file past the file limit, secrets by name aside (tooMany)", async () => {
    const { a } = twoMachines();
    write(a, "app.ts", "export const a = 'changed';\n");
    write(a, "b.txt", "fine\n");
    write(a, "c.txt", "fine\n");
    write(a, "a.env", "KEY=1\n");
    const tree = stagedTree(a);
    const check = (maxChangedFiles: number) =>
      checkStagedContent({
        root: a,
        ...tree,
        secretName: (path) => path.endsWith(".env"),
        maxFileBytes: 10 * 1024 * 1024,
        maxChangedFiles,
      });
    // Three files travel (a changed one and two new ones); the secret by name is not counted.
    expect((await check(3)).tooMany).toBeNull();
    expect((await check(2)).tooMany).toEqual({ path: "c.txt" });
    expect((await check(1)).tooMany).toEqual({ path: "b.txt" });
    expect((await check(2)).secretNames).toEqual(["a.env"]);
  });

  it.skipIf(NodePath.sep !== "/")(
    "does not wait on a pipe put where a listed file was (P2-17)",
    async () => {
      const { a } = twoMachines();
      write(a, "fine.txt", `token=${fakeToken()}\n`);
      const pipe = NodePath.join(a, "pipe.txt");
      NodeChildProcess.execFileSync("mkfifo", [pipe]);
      try {
        // Nothing of its own to read, like a link or a folder; and the check goes on.
        expect(await readFileHead(pipe)).toBeNull();
        const checked = await checkSnapshotContent({
          root: a,
          untracked: ["pipe.txt", "fine.txt"],
          pastLimit: "leave-out",
        });
        expect(checked.leftOut).toEqual([
          { path: "fine.txt", reason: "content", kind: "GitHub token" },
        ]);
      } finally {
        // A reader still waiting on the pipe (the defect) is let go, so the run can end.
        try {
          NodeFS.closeSync(
            NodeFS.openSync(pipe, NodeFS.constants.O_WRONLY | NodeFS.constants.O_NONBLOCK),
          );
        } catch {
          // No reader is waiting.
        }
      }
    },
    10_000,
  );

  it("never carries a clone's staging folder, with or without its Git data (P2-24)", async () => {
    const a = dirtyRepository();
    // A clone stopped before Git made its data, and one stopped later.
    stagingFolder(a, ".swc-clone-lib-Ab12Cd", { repository: false });
    stagingFolder(a, "packages/.swc-clone-ui-Zz99Zz");
    // A folder of the person's own that only has such a name travels like any other.
    stagingFolder(a, ".swc-clone-mine-Ab12Cd", { mark: false, repository: false });
    for (const contentCheck of [undefined, { pastLimit: "leave-out" as const }]) {
      const written = await writeCheckpoint({
        cwd: a,
        threadId: "sync-test",
        ...(contentCheck === undefined
          ? {}
          : { ref: "refs/specwithcode/extras/test/4", contentCheck }),
      });
      const carried = filesOf(a, written.commit);
      expect(carried.filter((path) => path.includes(".swc-clone-"))).toEqual([
        ".swc-clone-mine-Ab12Cd/clone/half.ts",
      ]);
      expect(written.skipped.filter((file) => file.path.includes(".swc-clone-"))).toEqual([]);
    }
  });

  it("asks for no ignored secret that lies in a clone's staging folder (P2-34)", async () => {
    const { a } = twoMachines();
    commit(a, ".gitignore", "ignored.log\n.env\n");
    const staging = stagingFolder(a, ".swc-clone-lib-Ab12Cd", { repository: false });
    write(staging, "clone/.env", "API_KEY=abc\n");
    const mine = stagingFolder(a, ".swc-clone-mine-Ab12Cd", { mark: false, repository: false });
    write(mine, "clone/.env", "API_KEY=abc\n");
    write(a, ".env", "API_KEY=abc\n");
    const written = await writeCheckpoint({ cwd: a, threadId: "sync-test" });
    expect(written.requiredSecretPaths).toEqual([".env", ".swc-clone-mine-Ab12Cd/clone/.env"]);
  });

  it("leaves a thread's checkpoint as it is today: no content check unless asked for", async () => {
    const a = dirtyRepository();
    const written = await writeCheckpoint({ cwd: a, threadId: "thread-1" });
    const carried = filesOf(a, written.commit);
    // Today's behaviour: only the name check. The untracked note with a token still travels.
    expect(carried).toContain("notes.txt");
    expect(carried).toContain("deep.txt");
    expect(carried).not.toContain(".env");
    expect(written.leftOutByContent).toEqual([]);
    expect(written.excludedSecretCount).toBe(written.excludedSecretPaths.length);
  });
});
