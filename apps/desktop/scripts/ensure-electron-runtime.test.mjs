import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, assert, describe, it } from "vite-plus/test";

import { machOProblem } from "./ensure-electron-runtime.mjs";

const scratchDirs = [];

afterEach(() => {
  for (const dir of scratchDirs.splice(0)) {
    NodeFS.rmSync(dir, { recursive: true, force: true });
  }
});

// A 64-bit Mach-O with one __TEXT segment covering `segmentSize` bytes from offset 0.
function machO(segmentSize) {
  const header = Buffer.alloc(32 + 72);
  header.writeUInt32LE(0xfeedfacf, 0);
  header.writeUInt32LE(1, 16);
  header.writeUInt32LE(72, 20);
  header.writeUInt32LE(0x19, 32);
  header.writeUInt32LE(72, 36);
  header.write("__TEXT", 40, "latin1");
  header.writeBigUInt64LE(0n, 72);
  header.writeBigUInt64LE(BigInt(segmentSize), 80);
  return header;
}

function fatMachO(slice, sliceSize) {
  const fat = Buffer.alloc(4096);
  fat.writeUInt32BE(0xcafebabe, 0);
  fat.writeUInt32BE(1, 4);
  fat.writeUInt32BE(4096, 16);
  fat.writeUInt32BE(sliceSize, 20);
  return Buffer.concat([fat, slice]);
}

function write(bytes) {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "electron-runtime-test-"));
  scratchDirs.push(dir);
  const filePath = NodePath.join(dir, "Electron Framework");
  NodeFS.writeFileSync(filePath, bytes);
  return filePath;
}

describe("machOProblem", () => {
  it("accepts a binary whose segments fit in the file", () => {
    const bytes = Buffer.concat([machO(4096), Buffer.alloc(4096 - 104)]);
    assert.isNull(machOProblem(write(bytes)));
  });

  it("rejects a binary cut off before its segments end", () => {
    assert.match(machOProblem(write(machO(4096))), /segment __TEXT ends past the end/);
  });

  it("checks each slice of a universal binary", () => {
    const slice = Buffer.concat([machO(4096), Buffer.alloc(4096 - 104)]);
    assert.isNull(machOProblem(write(fatMachO(slice, slice.length))));
    assert.match(
      machOProblem(write(fatMachO(slice.subarray(0, 2048), slice.length))),
      /fat slice ends past the end/,
    );
  });

  it("rejects files that are not Mach-O", () => {
    assert.equal(machOProblem(write(Buffer.from("#!/bin/sh\necho hi\n"))), "not a 64-bit Mach-O");
    assert.equal(machOProblem("/nonexistent/Electron Framework"), "missing");
  });
});
