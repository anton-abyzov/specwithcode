// @effect-diagnostics nodeBuiltinImport:off - plain temporary files only.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it, vi } from "vite-plus/test";

import { partialPath, removePartials } from "./apply.ts";

// Native ESM namespace exports cannot be spied on directly.
vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof NodeFSP>()),
}));

const nameBytes = (path: string) => Buffer.byteLength(NodePath.basename(path));

describe("partialPath", () => {
  it("keeps a short name and its folder", () => {
    const target = NodePath.join(NodePath.sep, "target", "docs", "README.md");
    const partial = partialPath(target, "/state/journal.ndjson");
    expect(NodePath.dirname(partial)).toBe(NodePath.dirname(target));
    expect(NodePath.basename(partial)).toMatch(/^\.README\.md\.swc-partial-[0-9a-f]{12}$/);
  });

  it("stays within 255 bytes for a name near the limit", async () => {
    const name = `${"report-".repeat(33)}x.md`; // 235 bytes
    const partial = partialPath(NodePath.join("/target", name), "/state/journal.ndjson");
    expect(nameBytes(partial)).toBeLessThanOrEqual(255);
    expect(partialPath(NodePath.join("/target", `${name}.b`), "/state/journal.ndjson")).not.toBe(
      partial,
    );
    const folder = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "partial-name-"));
    try {
      const real = partialPath(NodePath.join(folder, name), "/state/journal.ndjson");
      await NodeFSP.writeFile(real, "partial");
      expect(await NodeFSP.readFile(real, "utf8")).toBe("partial");
    } finally {
      await NodeFSP.rm(folder, { recursive: true, force: true });
    }
  });

  it("never cuts a multi-byte character", () => {
    const name = "отчёт-".repeat(30); // 330 bytes
    const partial = NodePath.basename(partialPath(NodePath.join("/target", name), "/j"));
    expect(Buffer.byteLength(partial)).toBeLessThanOrEqual(255);
    expect(partial).not.toContain("�");
    expect(name.startsWith(partial.slice(1, partial.indexOf(".swc-partial-")))).toBe(true);
  });
});

describe("pre-clipping partial cleanup", () => {
  it.each(["EACCES", "EIO"])("propagates %s without caching a failed listing", async (code) => {
    const to = NodePath.join(NodePath.sep, "target", "report");
    const folder = NodePath.dirname(to);
    const listings = new Map<string, ReadonlyArray<string>>();
    const error = Object.assign(new Error(`${code}: cannot list folder`), { code });
    const rm = vi.spyOn(NodeFSP, "rm").mockResolvedValue(undefined);
    const readdir = vi.spyOn(NodeFSP, "readdir").mockRejectedValue(error);
    try {
      await expect(removePartials(to, "/journal", listings)).rejects.toBe(error);
      expect(listings.has(folder)).toBe(false);
      readdir.mockResolvedValue([]);
      await removePartials(to, "/journal", listings);
      expect(readdir).toHaveBeenCalledTimes(2);
      expect(listings.get(folder)).toEqual([]);
    } finally {
      rm.mockRestore();
      readdir.mockRestore();
    }
  });

  it("allows cleanup when the parent folder is absent", async () => {
    const to = NodePath.join(NodePath.sep, "absent", "report");
    const rm = vi.spyOn(NodeFSP, "rm").mockResolvedValue(undefined);
    const readdir = vi
      .spyOn(NodeFSP, "readdir")
      .mockRejectedValue(Object.assign(new Error("missing parent"), { code: "ENOENT" }));
    try {
      await expect(removePartials(to, "/journal", new Map())).resolves.toBeUndefined();
    } finally {
      rm.mockRestore();
      readdir.mockRestore();
    }
  });

  it.each([true, false])(
    "removes the exact old path only when listed (present: %s)",
    async (present) => {
      const folder = NodePath.join(NodePath.sep, "target");
      const name = "a".repeat(235);
      const to = NodePath.join(folder, name);
      const journal = "/state/journal.ndjson";
      const oldName = (target: string, log: string) =>
        `.${NodePath.basename(target)}.swc-partial-${NodeCrypto.createHash("sha256")
          .update(`${log}\0${target}`)
          .digest("hex")
          .slice(0, 12)}`;
      const old = oldName(to, journal);
      expect(Buffer.byteLength(old)).toBeGreaterThan(255);
      const names = [
        ...(present ? [old] : []),
        oldName(to, `${journal}.other`),
        oldName(`${to}b`, journal),
        NodePath.basename(partialPath(to, `${journal}.other`)),
      ];
      const rm = vi.spyOn(NodeFSP, "rm").mockResolvedValue(undefined);
      try {
        await removePartials(to, journal, new Map([[folder, names]]));
        expect(rm.mock.calls).toEqual([
          [partialPath(to, journal), { recursive: true, force: true }],
          ...(present ? [[NodePath.join(folder, old), { recursive: true, force: true }]] : []),
        ]);
      } finally {
        rm.mockRestore();
      }
    },
  );
});
