// @effect-diagnostics nodeBuiltinImport:off - compares files in a private temporary folder.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import { sameBytes } from "./worktreeCleanupRemoval.ts";

const temporary: Array<string> = [];
const scratch = () => {
  const folder = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "same-bytes-"));
  temporary.push(folder);
  return folder;
};

afterEach(() => {
  for (const folder of temporary.splice(0)) NodeFS.rmSync(folder, { recursive: true, force: true });
});

describe("a file and its evidence copy", () => {
  const pair = (left: Buffer, right: Buffer) => {
    const folder = scratch();
    NodeFS.writeFileSync(NodePath.join(folder, "a"), left);
    NodeFS.writeFileSync(NodePath.join(folder, "b"), right);
    return [NodePath.join(folder, "a"), NodePath.join(folder, "b")] as const;
  };

  it("match when every byte matches, across chunk edges", async () => {
    const bytes = Buffer.alloc(2 * 1024 * 1024 + 17, 7);
    expect(await sameBytes(...pair(bytes, Buffer.from(bytes)))).toBe(true);
    expect(await sameBytes(...pair(Buffer.alloc(0), Buffer.alloc(0)))).toBe(true);
  });

  it("differ on one changed byte of the same length, anywhere", async () => {
    const bytes = Buffer.alloc(2 * 1024 * 1024 + 17, 7);
    for (const at of [0, 768 * 1024, 1024 * 1024, bytes.length - 1]) {
      const changed = Buffer.from(bytes);
      changed[at] = 8;
      expect(await sameBytes(...pair(bytes, changed))).toBe(false);
    }
  });

  it("differ on another length, and a missing file is an error", async () => {
    expect(await sameBytes(...pair(Buffer.from("abc"), Buffer.from("abcd")))).toBe(false);
    await expect(sameBytes(NodePath.join(scratch(), "missing"), "/nowhere")).rejects.toThrow();
  });
});
