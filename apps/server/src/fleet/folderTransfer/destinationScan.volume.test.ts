// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - disposable folders only.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";

import * as Scan from "./destinationScan.ts";

/**
 * The name rules of the volume a copy lands on are read, never tested by
 * writing: nothing outside the target is created or removed to learn them.
 */

interface Rules {
  readonly known: boolean;
  readonly caseInsensitive: boolean;
}
interface Reader {
  readonly lstat: (
    path: string,
  ) => Promise<{ dev: bigint; ino: bigint; isDirectory: () => boolean } | null>;
  readonly names: (folder: string) => Promise<ReadonlyArray<string>>;
}
const rules = (target: string, reader?: Partial<Reader>): Promise<Rules> =>
  (
    Scan as unknown as {
      volumeNameRules: (target: string, reader?: Partial<Reader>) => Promise<Rules>;
    }
  ).volumeNameRules(target, reader);

let base: string;
beforeAll(() => {
  base = NodeFS.realpathSync(NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "swc-volume-")));
});
afterAll(() => NodeFS.rmSync(base, { recursive: true, force: true }));

const listing = (folder: string) =>
  Object.fromEntries(
    NodeFS.readdirSync(folder).map((name) => [
      name,
      NodeFS.statSync(NodePath.join(folder, name)).isFile()
        ? NodeFS.readFileSync(NodePath.join(folder, name), "utf8")
        : "",
    ]),
  );

describe("caseInsensitiveAt", () => {
  it("leaves a file alone that already has the name its probe used to take", async () => {
    const parent = NodePath.join(base, "occupied");
    NodeFS.mkdirSync(parent);
    const now = vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    try {
      const occupant = NodePath.join(parent, `.swc-case-probe-${process.pid}-1700000000000`);
      NodeFS.writeFileSync(occupant, "someone's file\n");
      await Scan.caseInsensitiveAt(NodePath.join(parent, "target"));
      expect(NodeFS.readFileSync(occupant, "utf8")).toBe("someone's file\n");
    } finally {
      now.mockRestore();
    }
  });

  it("creates and removes nothing", async () => {
    const parent = NodePath.join(base, "quiet");
    NodeFS.mkdirSync(NodePath.join(parent, "Target"), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(parent, "Target", "Readme.md"), "x\n");
    const names: Array<string> = [];
    const watcher = NodeFS.watch(parent, { recursive: false }, (_event, name) => {
      if (name) names.push(String(name));
    });
    try {
      const before = listing(parent);
      await Scan.caseInsensitiveAt(NodePath.join(parent, "Target"));
      await Scan.caseInsensitiveAt(NodePath.join(parent, "absent"));
      expect(listing(parent)).toEqual(before);
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(names.filter((name) => name.includes("swc-case-probe"))).toEqual([]);
    } finally {
      watcher.close();
    }
  });
});

describe("volumeNameRules", () => {
  it("reads the rules from an entry inside the target", async () => {
    const target = NodePath.join(base, "inside");
    NodeFS.mkdirSync(target);
    NodeFS.writeFileSync(NodePath.join(target, "Readme.md"), "x\n");
    const folded = NodeFS.existsSync(NodePath.join(target, "README.MD"));
    expect(await rules(target)).toEqual({ known: true, caseInsensitive: folded });
  });

  it("tells two names from one name written two ways", async () => {
    const stat = (ino: bigint) => ({ dev: 1n, ino, isDirectory: () => true });
    const names = async () => ["Readme.md"];
    expect(
      await rules("/t", { names, lstat: async (path) => stat(path.endsWith("/t") ? 1n : 7n) }),
    ).toEqual({ known: true, caseInsensitive: true });
    expect(
      await rules("/t", {
        names,
        lstat: async (path) =>
          path.endsWith("/t") ? stat(1n) : path.endsWith("Readme.md") ? stat(7n) : null,
      }),
    ).toEqual({ known: true, caseInsensitive: false });
  });

  it("a read that fails is not the operating system's default: the rules are unknown", async () => {
    const target = NodePath.join(base, "unreadable");
    NodeFS.mkdirSync(target);
    expect(
      await rules(target, {
        names: async () => {
          throw new Error("EACCES");
        },
      }),
    ).toEqual({ known: false, caseInsensitive: true });
  });

  it("does not take the rules of another volume above the target", async () => {
    const stat = (dev: bigint, ino: bigint) => ({ dev, ino, isDirectory: () => true });
    // The target is an empty mount point; only the folder above it has a name to try.
    expect(
      await rules("/mnt/t", {
        names: async (folder) => (folder === "/mnt/t" ? [] : ["Data"]),
        lstat: async (path) => (path === "/mnt/t" ? stat(2n, 1n) : stat(1n, 5n)),
      }),
    ).toEqual({ known: false, caseInsensitive: true });
  });
});
