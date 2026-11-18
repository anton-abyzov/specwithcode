// @effect-diagnostics nodeBuiltinImport:off - disposable real Git fixtures only.
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
  twoMachines,
  write,
} from "./extrasTestKit.ts";
import { checkSnapshotContent, readFileHead } from "./snapshotSecrets.ts";

beforeAll(isolateGit);
afterAll(restoreGit);
afterEach(cleanUp);

const KB = 1024;
const filler = (bytes: number) => "x".repeat(bytes - 1) + "\n";

describe("the snapshot's content check (1390 AC-14)", () => {
  it("reads the first 64 KB of a file of any size, where readSmallText returns nothing", async () => {
    const { a } = twoMachines();
    write(a, "big.txt", `token=${fakeToken()}\n${filler(200 * KB)}`);
    const absolute = NodePath.join(a, "big.txt");
    expect(await readSmallText(absolute, 64 * KB)).toBeNull();
    const head = await readFileHead(absolute);
    expect(head).not.toBeNull();
    expect(Buffer.byteLength(head!)).toBe(64 * KB);
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

  it("never follows a link, and skips binary files and folders", async () => {
    const { a, base } = twoMachines();
    write(base, "outside.txt", `token=${fakeToken()}\n`);
    NodeFS.symlinkSync(NodePath.join(base, "outside.txt"), NodePath.join(a, "link.txt"));
    write(a, "image.bin", Buffer.concat([Buffer.from([0, 1, 2, 0]), Buffer.from(fakeToken())]));
    NodeFS.mkdirSync(NodePath.join(a, "folder"));
    expect(await readFileHead(NodePath.join(a, "link.txt"))).toBeNull();
    expect(await readFileHead(NodePath.join(a, "image.bin"))).toBeNull();
    expect(await readFileHead(NodePath.join(a, "folder"))).toBeNull();
    expect(await readFileHead(NodePath.join(a, "gone.txt"))).toBeNull();
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
    expect(leftOut.filter((line) => line.startsWith(".specweave/project/credentials.json"))).toHaveLength(
      1,
    );
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
