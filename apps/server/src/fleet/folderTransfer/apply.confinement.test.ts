// @effect-diagnostics nodeBuiltinImport:off - disposable folders only.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { applyPlan, type ApplyInput } from "./apply.ts";
import type { FileAction, Plan } from "./reconcile.ts";
import { undoApply } from "./undo.ts";

/**
 * Destination path confinement: Apply writes only through folders the app's user
 * controls alone. Ownership by another user is simulated through the stat seam,
 * because a test run has no second account.
 */

type Stat = NodeFS.BigIntStats;
type Lstat = (path: string) => Promise<Stat | null>;
/** The fields these tests add to Apply's input and result. */
type ConfinedInput = ApplyInput & { confinement?: { lstat?: Lstat; uid?: number } };
interface Refused {
  readonly path: string;
  readonly folder: string;
  readonly reason: string;
}
type ConfinedResult = Awaited<ReturnType<typeof applyPlan>> & {
  readonly refused: ReadonlyArray<Refused>;
};

const run = (input: ConfinedInput) => applyPlan(input) as Promise<ConfinedResult>;

const realLstat: Lstat = (path) =>
  NodeFSP.lstat(path, { bigint: true }).catch((cause: unknown) => {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw cause;
  });

/** `stat` as it would read with another owner, permission bits or identity. */
function reading(stat: Stat, facts: { uid?: number; mode?: number; ino?: bigint }): Stat {
  const copy = Object.assign(Object.create(Object.getPrototypeOf(stat) as object), stat) as Stat;
  if (facts.uid !== undefined) copy.uid = BigInt(facts.uid);
  if (facts.mode !== undefined) copy.mode = (stat.mode & ~0o7777n) | BigInt(facts.mode);
  if (facts.ino !== undefined) copy.ino = facts.ino;
  return copy;
}

/** A seam that reads `path` with `facts` once `when` holds, and everything else as it is. */
const seam = (
  path: string,
  facts: Parameters<typeof reading>[1],
  when: () => boolean = () => true,
): { lstat: Lstat } => ({
  lstat: async (asked) => {
    const stat = await realLstat(asked);
    return stat && asked === path && when() ? reading(stat, facts) : stat;
  },
});

const OTHER_USER = 4242;
const posix = process.platform !== "win32";

let base: string;
let counter = 0;

beforeAll(() => {
  base = NodeFS.realpathSync(NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "swc-confine-")));
});
afterAll(() => NodeFS.rmSync(base, { recursive: true, force: true }));

const sha = (body: string) => NodeCrypto.createHash("sha256").update(body).digest("hex");

/** Every entry below `root` with its bytes, permission bits and link target. */
function bytes(root: string): Record<string, string> {
  const result: Record<string, string> = {};
  const walk = (directory: string) => {
    for (const name of NodeFS.readdirSync(directory)) {
      const absolute = NodePath.join(directory, name);
      const relative = NodePath.relative(root, absolute).split(NodePath.sep).join("/");
      const stat = NodeFS.lstatSync(absolute);
      const mode = (stat.mode & 0o7777).toString(8);
      if (stat.isSymbolicLink()) result[relative] = `link:${NodeFS.readlinkSync(absolute)}`;
      else if (stat.isDirectory()) {
        result[`${relative}/`] = mode;
        walk(absolute);
      } else result[relative] = `${mode}:${NodeFS.readFileSync(absolute).toString("hex")}`;
    }
  };
  if (NodeFS.existsSync(root)) walk(root);
  return result;
}

const fileAction = (path: string, body: string): FileAction => ({
  path,
  kind: "write",
  entry: {
    path,
    type: "file",
    mode: 0o644,
    size: Buffer.byteLength(body),
    mtimeMs: 0,
    class: "untracked",
    repo: null,
    sha256: sha(body),
  },
  replaces: false,
  localSource: null,
  row: "files",
  writePath: path,
});

const folderAction = (path: string, mode = 0o755): FileAction => ({
  path,
  kind: "mkdir",
  entry: { path, type: "directory", mode, size: 0, mtimeMs: 0, class: "untracked", repo: null },
  replaces: false,
  localSource: null,
  row: "files",
  writePath: path,
});

/**
 * A destination folder, a folder outside it that no copy may touch, the staged
 * files and the Apply input for `files`. `target: false` leaves the target missing.
 */
function scenario(
  destination: ((target: string, outside: string) => void) | false,
  files: Record<string, string>,
  extra: ReadonlyArray<FileAction> = [],
) {
  counter += 1;
  const directory = NodePath.join(base, `case-${counter}`);
  const target = NodePath.join(directory, "target");
  const staging = NodePath.join(directory, "staging");
  const outside = NodePath.join(directory, "outside");
  NodeFS.mkdirSync(staging, { recursive: true, mode: 0o700 });
  NodeFS.mkdirSync(outside, { mode: 0o700 });
  NodeFS.writeFileSync(NodePath.join(outside, "keep.txt"), "not part of the copy\n");
  if (destination) {
    NodeFS.mkdirSync(target, { mode: 0o700 });
    destination(target, outside);
  }
  for (const [path, body] of Object.entries(files)) {
    const file = NodePath.join(staging, ...path.split("/"));
    NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true });
    NodeFS.writeFileSync(file, body);
  }
  const plan = {
    rows: [],
    actions: [...extra, ...Object.entries(files).map(([path, body]) => fileAction(path, body))],
    git: [],
    totals: { filesToMove: 0, bytesToMove: 0, bytesPresent: 0, decisionsNeeded: 0, replacing: 0 },
    warnings: [],
  } satisfies Plan;
  const input: ConfinedInput = {
    operationId: `confine-${counter}`,
    targetRoot: target,
    stagingRoot: staging,
    backupRoot: NodePath.join(directory, "backups"),
    journalFile: NodePath.join(directory, "journal.ndjson"),
    plan,
    sourceRepositories: [],
    leftBehind: new Set(),
  };
  return { input, directory, target, outside };
}

const folder = (target: string, name: string, mode = 0o700) => {
  NodeFS.mkdirSync(NodePath.join(target, name), { mode });
  // mkdir applies the umask; the test means exactly these bits.
  NodeFS.chmodSync(NodePath.join(target, name), mode);
};

describe("a privately owned tree", () => {
  it("copies, with nothing refused", async () => {
    const { input, target, outside } = scenario((root) => folder(root, "docs"), {
      "docs/a.txt": "a\n",
      "new/deep/b.txt": "b\n",
      "c.txt": "c\n",
    });
    const before = bytes(outside);
    const result = await run(input);
    expect(result.refused).toEqual([]);
    expect(NodeFS.readFileSync(NodePath.join(target, "docs", "a.txt"), "utf8")).toBe("a\n");
    expect(NodeFS.readFileSync(NodePath.join(target, "new", "deep", "b.txt"), "utf8")).toBe("b\n");
    expect(NodeFS.readFileSync(NodePath.join(target, "c.txt"), "utf8")).toBe("c\n");
    expect(bytes(outside)).toEqual(before);
  });
});

describe.skipIf(!posix)("an unsafe folder below the target", () => {
  it.each([
    ["writable by group", 0o770, "group-writable"],
    ["writable by others", 0o707, "other-writable"],
  ])("%s is refused before anything in it changes", async (words, mode, reason) => {
    const { input, target, outside } = scenario(
      (root) => {
        folder(root, "shared", mode);
        NodeFS.writeFileSync(NodePath.join(root, "shared", "theirs.txt"), "theirs\n");
        folder(root, "own");
      },
      { "own/b.txt": "b\n", "shared/a.txt": "a\n", "shared/new/c.txt": "c\n" },
    );
    const outsideBefore = bytes(outside);
    const sharedBefore = bytes(NodePath.join(target, "shared"));
    const result = await run(input);
    expect(result.refused).toEqual([
      { path: "shared/a.txt", folder: "shared", reason },
      { path: "shared/new/c.txt", folder: "shared", reason },
    ]);
    expect(result.warnings.some((line) => line.includes("shared") && line.includes(words))).toBe(
      true,
    );
    expect(bytes(NodePath.join(target, "shared"))).toEqual(sharedBefore);
    expect(bytes(outside)).toEqual(outsideBefore);
    // The entry whose chain passes is still applied.
    expect(NodeFS.readFileSync(NodePath.join(target, "own", "b.txt"), "utf8")).toBe("b\n");
  });

  it("owned by another user is refused before anything in it changes", async () => {
    const { input, target, outside } = scenario(
      (root) => {
        folder(root, "theirs");
        folder(root, "own");
      },
      { "own/b.txt": "b\n", "theirs/a.txt": "a\n" },
    );
    input.confinement = seam(NodePath.join(target, "theirs"), { uid: OTHER_USER });
    const before = bytes(outside);
    const result = await run(input);
    expect(result.refused).toEqual([
      { path: "theirs/a.txt", folder: "theirs", reason: "not-owned" },
    ]);
    expect(result.warnings.some((line) => line.includes("not owned by you"))).toBe(true);
    expect(bytes(NodePath.join(target, "theirs"))).toEqual({});
    expect(bytes(outside)).toEqual(before);
    expect(NodeFS.readFileSync(NodePath.join(target, "own", "b.txt"), "utf8")).toBe("b\n");
  });

  it("that is a link is refused, and the folder it names stays as it was", async () => {
    const { input, target, outside } = scenario(
      (root, elsewhere) => {
        NodeFS.symlinkSync(elsewhere, NodePath.join(root, "linked"));
        folder(root, "own");
      },
      { "linked/a.txt": "a\n", "own/b.txt": "b\n" },
    );
    const before = bytes(outside);
    const result = await run(input);
    expect(result.refused).toEqual([
      { path: "linked/a.txt", folder: "linked", reason: "link-in-path" },
    ]);
    expect(bytes(outside)).toEqual(before);
    expect(NodeFS.lstatSync(NodePath.join(target, "linked")).isSymbolicLink()).toBe(true);
    expect(NodeFS.readFileSync(NodePath.join(target, "own", "b.txt"), "utf8")).toBe("b\n");
  });

  it("is checked for every entry of a batch, not only the first", async () => {
    const { input, target, outside } = scenario(
      (root) => {
        folder(root, "a");
        folder(root, "m", 0o770);
        folder(root, "z");
      },
      { "a/1.txt": "1\n", "a/2.txt": "2\n", "m/3.txt": "3\n", "z/4.txt": "4\n", "z/5.txt": "5\n" },
    );
    const before = bytes(outside);
    const result = await run(input);
    expect(result.refused).toEqual([{ path: "m/3.txt", folder: "m", reason: "group-writable" }]);
    expect(Object.keys(bytes(target)).sort()).toEqual([
      "a/",
      "a/1.txt",
      "a/2.txt",
      "m/",
      "z/",
      "z/4.txt",
      "z/5.txt",
    ]);
    expect(bytes(outside)).toEqual(before);
  });

  it("that turns unsafe during the batch stops the copy before the next write", async () => {
    const { input, target } = scenario((root) => folder(root, "d"), {
      "d/1.txt": "1\n",
      "d/2.txt": "2\n",
      "d/3.txt": "3\n",
    });
    const first = NodePath.join(target, "d", "1.txt");
    input.confinement = seam(NodePath.join(target, "d"), { mode: 0o770 }, () =>
      NodeFS.existsSync(first),
    );
    await expect(run(input)).rejects.toMatchObject({
      reason: "group-writable",
      folder: "d",
      written: ["d/1.txt"],
    });
    expect(Object.keys(bytes(target)).sort()).toEqual(["d/", "d/1.txt"]);
  });
});

describe.skipIf(!posix)("a folder whose identity changes between the check and the write", () => {
  it("stops the copy, names the folder and what was written, and Undo removes it", async () => {
    const { input, target, outside } = scenario((root) => folder(root, "d"), {
      "d/1.txt": "1\n",
      "d/2.txt": "2\n",
    });
    const before = bytes(outside);
    const first = NodePath.join(target, "d", "1.txt");
    // Another folder stands at `d` once the first file has landed.
    input.confinement = seam(NodePath.join(target, "d"), { ino: 987_654_321n }, () =>
      NodeFS.existsSync(first),
    );
    await expect(run(input)).rejects.toMatchObject({
      reason: "folder-changed",
      folder: "d",
      written: ["d/1.txt"],
    });
    expect(NodeFS.existsSync(NodePath.join(target, "d", "2.txt"))).toBe(false);
    const undo = await undoApply({
      targetRoot: input.targetRoot,
      backupRoot: input.backupRoot,
      journalFile: input.journalFile,
    });
    expect(undo).toMatchObject({ kept: [], problems: [] });
    expect(bytes(target)).toEqual({ "d/": "700" });
    expect(bytes(outside)).toEqual(before);
  });
});

describe.skipIf(!posix)("the folders above the target", () => {
  it("a sticky folder owned by another user refuses the copy before it starts", async () => {
    const { input, directory, target, outside } = scenario(() => undefined, { "a.txt": "a\n" });
    input.confinement = seam(directory, { uid: OTHER_USER, mode: 0o1777 });
    const before = bytes(outside);
    await expect(run(input)).rejects.toMatchObject({ reason: "not-owned", path: directory });
    expect(bytes(target)).toEqual({});
    expect(bytes(outside)).toEqual(before);
  });

  it("a sticky folder owned by root qualifies when the target in it is yours", async () => {
    const { input, directory, target } = scenario(() => undefined, { "a.txt": "a\n" });
    input.confinement = seam(directory, { uid: 0, mode: 0o1777 });
    expect((await run(input)).refused).toEqual([]);
    expect(NodeFS.readFileSync(NodePath.join(target, "a.txt"), "utf8")).toBe("a\n");
  });

  it("a sticky folder never qualifies for a target that does not exist yet", async () => {
    const { input, directory, target } = scenario(false, { "a.txt": "a\n" });
    input.confinement = seam(directory, { uid: 0, mode: 0o1777 });
    await expect(run(input)).rejects.toMatchObject({ reason: "other-writable", path: directory });
    expect(NodeFS.existsSync(target)).toBe(false);
  });

  it("a folder another user owns refuses the copy", async () => {
    const { input, directory, target } = scenario(() => undefined, { "a.txt": "a\n" });
    input.confinement = seam(directory, { uid: OTHER_USER });
    await expect(run(input)).rejects.toMatchObject({ reason: "not-owned", path: directory });
    expect(bytes(target)).toEqual({});
  });
});

describe.skipIf(!posix)("Add into a target that does not exist", () => {
  it("is refused under a group-writable folder, and the target is not created", async () => {
    const { input, directory, target, outside } = scenario(false, { "a.txt": "a\n" });
    NodeFS.chmodSync(directory, 0o770);
    const before = bytes(outside);
    await expect(run(input)).rejects.toMatchObject({ reason: "group-writable", path: directory });
    expect(NodeFS.existsSync(target)).toBe(false);
    expect(bytes(outside)).toEqual(before);
  });

  it("creates its folders private and gives them their final mode only at the end", async () => {
    const umask = process.umask(0o022);
    try {
      const { input, target } = scenario(false, { "new/deep/a.txt": "a\n" }, [
        folderAction("new", 0o750),
      ]);
      const created = [target, NodePath.join(target, "new"), NodePath.join(target, "new", "deep")];
      const seen: Array<string> = [];
      input.confinement = {
        lstat: async (asked) => {
          const stat = await realLstat(asked);
          if (stat && created.includes(asked))
            seen.push(`${NodePath.relative(target, asked) || "."}:${(stat.mode & 0o777n).toString(8)}`);
          return stat;
        },
      };
      expect((await run(input)).refused).toEqual([]);
      expect(seen.length).toBeGreaterThan(0);
      // While files were landing, every folder Apply made was the user's alone.
      expect([...new Set(seen.map((line) => line.split(":")[1]))]).toEqual(["700"]);
      expect(bytes(target)).toMatchObject({ "new/": "750", "new/deep/": "755" });
      expect((NodeFS.statSync(target).mode & 0o777).toString(8)).toBe("755");
      expect(NodeFS.readFileSync(NodePath.join(target, "new", "deep", "a.txt"), "utf8")).toBe(
        "a\n",
      );
    } finally {
      process.umask(umask);
    }
  });
});
