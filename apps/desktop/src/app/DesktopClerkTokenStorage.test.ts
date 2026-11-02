// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, assert, describe, it, vi } from "vite-plus/test";

import { clerkTokenFilePath, withOwnerOnlyTokenFile } from "./DesktopClerkTokenStorage.ts";

const directories: string[] = [];

function tempDir(): string {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "clerk-token-storage-"));
  directories.push(directory);
  return directory;
}

const mode = (filePath: string): number => NodeFS.statSync(filePath).mode & 0o777;

function writingStorage(filePath: string) {
  return {
    getItem: vi.fn(() => Promise.resolve(null)),
    setItem: vi.fn((_key: string, value: string) => {
      NodeFS.writeFileSync(filePath, value, { mode: 0o666 });
      NodeFS.chmodSync(filePath, 0o666);
      return Promise.resolve();
    }),
    removeItem: vi.fn(() => {
      NodeFS.chmodSync(filePath, 0o666);
      return Promise.resolve();
    }),
  };
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
});

describe("withOwnerOnlyTokenFile", () => {
  it.skipIf(process.platform === "win32")("tightens an existing file when it opens", () => {
    const filePath = clerkTokenFilePath(tempDir());
    NodeFS.writeFileSync(filePath, "{}");
    NodeFS.chmodSync(filePath, 0o666);
    withOwnerOnlyTokenFile(writingStorage(filePath), filePath);
    assert.equal(mode(filePath), 0o600);
  });

  it.skipIf(process.platform === "win32")("tightens the file again after each write", async () => {
    const filePath = clerkTokenFilePath(tempDir());
    const storage = withOwnerOnlyTokenFile(writingStorage(filePath), filePath);
    await storage.setItem("token", "value");
    assert.equal(mode(filePath), 0o600);
    NodeFS.chmodSync(filePath, 0o666);
    await storage.removeItem("token");
    assert.equal(mode(filePath), 0o600);
  });

  it.skipIf(process.platform === "win32")("leaves the target of a symlink alone", () => {
    const directory = tempDir();
    const target = NodePath.join(directory, "target.json");
    NodeFS.writeFileSync(target, "{}");
    NodeFS.chmodSync(target, 0o644);
    const filePath = clerkTokenFilePath(directory);
    NodeFS.symlinkSync(target, filePath);
    withOwnerOnlyTokenFile(writingStorage(filePath), filePath);
    assert.equal(mode(target), 0o644);
  });

  it("opens before the first sign-in, when no file exists", async () => {
    const filePath = clerkTokenFilePath(tempDir());
    const inner = writingStorage(filePath);
    const storage = withOwnerOnlyTokenFile(inner, filePath);
    assert.isNull(await storage.getItem("token"));
    assert.deepEqual(inner.getItem.mock.calls, [["token"]]);
  });
});
