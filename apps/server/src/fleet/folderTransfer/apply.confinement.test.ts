// @effect-diagnostics nodeBuiltinImport:off - disposable folders only.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { applyPlan, type ApplyInput } from "./apply.ts";
import type { FolderAccess } from "./confinement.ts";
import { git } from "./folderFixture.testkit.ts";
import type { RepositoryInfo } from "./manifest.ts";
import type { FileAction, GitStep, Plan } from "./reconcile.ts";
import { undoApply } from "./undo.ts";

/**
 * Destination path confinement: Apply writes only through folders the app's user
 * controls alone. Ownership by another user is simulated through the stat seam,
 * because a test run has no second account.
 */

type Stat = NodeFS.BigIntStats;
type Lstat = (path: string) => Promise<Stat | null>;
/** The fields these tests add to Apply's input and result. */
type ConfinedInput = ApplyInput & {
  confinement?: {
    lstat?: Lstat;
    uid?: number;
    platform?: NodeJS.Platform;
    access?: (paths: ReadonlyArray<string>) => Promise<ReadonlyMap<string, FolderAccess>>;
    secure?: (path: string) => Promise<void>;
  };
  /** What the person approved: the target's kind and, when it existed, which folder it was. */
  approved?: { kind: "empty" | "reviewed"; identity: string | null };
  sourceRepositories: ReadonlyArray<RepositoryInfo>;
};
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
  steps: (target: string) => ReadonlyArray<GitStep> = () => [],
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
    git: [...steps(target)],
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

/** True once Apply has started giving folders their final mode. */
const committed = (file: string) =>
  NodeFS.existsSync(file) && (NodeFS.statSync(NodePath.dirname(file)).mode & 0o777) !== 0o700;

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
      const landing: Array<string> = [];
      const file = NodePath.join(target, "new", "deep", "a.txt");
      input.confinement = {
        lstat: async (asked) => {
          const stat = await realLstat(asked);
          // Every reading until the commit begins. From then on folders take their
          // final modes, which the assertions after the run pin one by one.
          if (stat && created.includes(asked) && !committed(file))
            landing.push(
              `${NodePath.relative(target, asked) || "."}:${(stat.mode & 0o777n).toString(8)}`,
            );
          return stat;
        },
      };
      expect((await run(input)).refused).toEqual([]);
      // While files were landing, every folder Apply made was the user's alone.
      expect(landing.length).toBeGreaterThan(0);
      expect([...new Set(landing.map((line) => line.split(":")[1]))]).toEqual(["700"]);
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

const identityOf = (path: string) => {
  const stat = NodeFS.lstatSync(path, { bigint: true });
  return `${stat.dev}:${stat.ino}`;
};

describe.skipIf(!posix)("a folder Apply makes", () => {
  it("is verified before anything is written into it", async () => {
    const { input, target } = scenario(() => undefined, { "new/a.txt": "a\n" });
    // The new folder comes out open to a group, as one made under inherited access would.
    input.confinement = seam(NodePath.join(target, "new"), { mode: 0o770 });
    await expect(run(input)).rejects.toMatchObject({
      reason: "group-writable",
      folder: "new",
      written: [],
    });
    expect(NodeFS.existsSync(NodePath.join(target, "new", "a.txt"))).toBe(false);
  });
});

describe.skipIf(!posix)("what the person approved", () => {
  it("a file that appeared where the plan saw none is refused, not backed up and replaced", async () => {
    const { input, target } = scenario(
      (root) => NodeFS.writeFileSync(NodePath.join(root, "a.txt"), "appeared after the review\n"),
      { "a.txt": "copied\n" },
    );
    await expect(run(input)).rejects.toMatchObject({ reason: "changed-since-preview" });
    expect(NodeFS.readFileSync(NodePath.join(target, "a.txt"), "utf8")).toBe(
      "appeared after the review\n",
    );
    expect(NodeFS.existsSync(input.backupRoot)).toBe(false);
  });

  it("another folder standing at the approved path is refused", async () => {
    const { input, directory, target } = scenario(() => undefined, { "a.txt": "a\n" });
    input.approved = { kind: "reviewed", identity: identityOf(target) };
    NodeFS.renameSync(target, NodePath.join(directory, "target-was"));
    NodeFS.mkdirSync(target, { mode: 0o700 });
    await expect(run(input)).rejects.toMatchObject({ reason: "folder-changed" });
    expect(bytes(target)).toEqual({});
  });

  it("a target approved as absent that exists now is refused", async () => {
    const { input, target } = scenario(
      (root) => NodeFS.writeFileSync(NodePath.join(root, "theirs.txt"), "theirs\n"),
      { "a.txt": "a\n" },
    );
    input.approved = { kind: "empty", identity: null };
    await expect(run(input)).rejects.toMatchObject({ reason: "changed-since-preview" });
    expect(Object.keys(bytes(target))).toEqual(["theirs.txt"]);
  });

  it("a target approved as empty that holds something now is refused", async () => {
    const { input, target } = scenario(
      (root) => NodeFS.writeFileSync(NodePath.join(root, "theirs.txt"), "theirs\n"),
      { "a.txt": "a\n" },
    );
    input.approved = { kind: "empty", identity: identityOf(target) };
    await expect(run(input)).rejects.toMatchObject({ reason: "changed-since-preview" });
    expect(Object.keys(bytes(target))).toEqual(["theirs.txt"]);
  });

  it("the approved folder itself copies", async () => {
    const { input, target } = scenario(() => undefined, { "a.txt": "a\n" });
    input.approved = { kind: "empty", identity: identityOf(target) };
    expect((await run(input)).refused).toEqual([]);
    expect(NodeFS.readFileSync(NodePath.join(target, "a.txt"), "utf8")).toBe("a\n");
  });

  it("a retry is held to the folder the first run wrote into", async () => {
    const { input, directory, target } = scenario(false, { "a.txt": "a\n" });
    input.approved = { kind: "empty", identity: null };
    await run(input);
    NodeFS.renameSync(target, NodePath.join(directory, "target-was"));
    NodeFS.mkdirSync(target, { mode: 0o700 });
    await expect(run(input)).rejects.toMatchObject({ reason: "folder-changed" });
    expect(bytes(target)).toEqual({});
  });
});

describe.skipIf(!posix)("a link above the target", () => {
  it("whose text climbs back up is refused: where it leads is not certain", async () => {
    const { input, directory, outside } = scenario(() => undefined, { "a.txt": "a\n" });
    NodeFS.mkdirSync(NodePath.join(directory, "hop"), { mode: 0o700 });
    NodeFS.symlinkSync("../target", NodePath.join(directory, "hop", "link"));
    const through = NodePath.join(directory, "hop", "link");
    const before = bytes(outside);
    await expect(run({ ...input, targetRoot: through })).rejects.toMatchObject({
      reason: "link-in-path",
    });
    expect(bytes(NodePath.join(directory, "target"))).toEqual({});
    expect(bytes(outside)).toEqual(before);
  });
});

describe.skipIf(!posix)("Windows ownership and missing names, through the seam", () => {
  const windows = (
    directory: string,
    answer: (path: string) => FolderAccess,
  ): NonNullable<ConfinedInput["confinement"]> => ({
    platform: "win32",
    access: async (paths) =>
      new Map(
        paths.map((path) => [
          path,
          path.startsWith(directory)
            ? answer(path)
            : { owner: "trusted", othersMayWrite: false, othersMayReplace: false },
        ]),
      ),
    secure: async () => undefined,
  });
  const mine: FolderAccess = { owner: "user", othersMayWrite: false, othersMayReplace: false };

  it("inside the target only the app's user may own a folder", async () => {
    const { input, directory, target } = scenario(() => undefined, { "a.txt": "a\n" });
    input.confinement = windows(directory, (path) =>
      path === target ? { ...mine, owner: "trusted" } : mine,
    );
    expect((await run(input)).refused).toEqual([
      { path: "a.txt", folder: ".", reason: "not-owned" },
    ]);
    expect(bytes(target)).toEqual({});
  });

  it("a folder where others may add entries cannot hold a target that does not exist yet", async () => {
    const { input, directory, target } = scenario(false, { "a.txt": "a\n" });
    input.confinement = windows(directory, (path) =>
      path === directory ? { ...mine, othersMayWrite: true } : mine,
    );
    await expect(run(input)).rejects.toMatchObject({ reason: "acl-entry", path: directory });
    expect(NodeFS.existsSync(target)).toBe(false);
  });

  it("the same folder may hold a target that exists and is the user's", async () => {
    const { input, directory, target } = scenario(() => undefined, { "a.txt": "a\n" });
    input.confinement = windows(directory, (path) =>
      path === directory ? { ...mine, othersMayWrite: true } : mine,
    );
    expect((await run(input)).refused).toEqual([]);
    expect(NodeFS.readFileSync(NodePath.join(target, "a.txt"), "utf8")).toBe("a\n");
  });
});

const existingStep = (sourceHead: string): GitStep => ({
  repo: ".",
  row: "repo:.",
  kind: "existing",
  sourceHead,
  sourceBranch: "main",
  identity: null,
  origin: null,
  sourceBranches: {},
  sourceStashCount: 0,
  fetch: false,
  moveHead: "fast-forward",
  stashDestination: false,
  importBranches: false,
  importPrefix: "swc/from-source",
  mainRepository: null,
});

/** A repository at `root` whose `next` branch changes a file in `shared`. */
function repository(root: string) {
  git(root, "init", "-q");
  NodeFS.mkdirSync(NodePath.join(root, "shared"), { mode: 0o700 });
  NodeFS.writeFileSync(NodePath.join(root, "shared", "f.txt"), "one\n");
  NodeFS.writeFileSync(NodePath.join(root, "top.txt"), "one\n");
  git(root, "add", ".");
  git(root, "commit", "-q", "-m", "one");
  git(root, "checkout", "-q", "-b", "next");
  NodeFS.writeFileSync(NodePath.join(root, "shared", "f.txt"), "two\n");
  git(root, "commit", "-q", "-am", "two");
  git(root, "checkout", "-q", "main");
}

describe.skipIf(!posix)("a Git step that updates working files", () => {
  const moved = (prepare: (root: string, outside: string) => void) => {
    let next = "";
    const made = scenario(
      (root, outside) => {
        repository(root);
        next = git(root, "rev-parse", "next");
        prepare(root, outside);
      },
      {},
      [],
      () => [existingStep(next)],
    );
    return { ...made, next, was: git(made.target, "rev-parse", "HEAD") };
  };

  it("moves the branch in a private repository", async () => {
    const { input, target, next } = moved(() => undefined);
    await run(input);
    expect(git(target, "rev-parse", "HEAD")).toBe(next);
    expect(NodeFS.readFileSync(NodePath.join(target, "shared", "f.txt"), "utf8")).toBe("two\n");
  });

  it("is refused when a tracked folder it would write into is open to a group", async () => {
    const { input, target, outside, was } = moved((root) =>
      NodeFS.chmodSync(NodePath.join(root, "shared"), 0o770),
    );
    const before = bytes(outside);
    await expect(run(input)).rejects.toMatchObject({ reason: "group-writable" });
    expect(git(target, "rev-parse", "HEAD")).toBe(was);
    expect(NodeFS.readFileSync(NodePath.join(target, "shared", "f.txt"), "utf8")).toBe("one\n");
    expect(bytes(outside)).toEqual(before);
  });

  it("is refused when a folder of its Git data is open to a group", async () => {
    const { input, target, was } = moved((root) =>
      NodeFS.chmodSync(NodePath.join(root, ".git", "refs", "heads"), 0o770),
    );
    await expect(run(input)).rejects.toMatchObject({ reason: "group-writable" });
    expect(git(target, "rev-parse", "HEAD")).toBe(was);
    expect(NodeFS.readFileSync(NodePath.join(target, "shared", "f.txt"), "utf8")).toBe("one\n");
  });
});

describe.skipIf(!posix)("repairing a copied worktree's pointer", () => {
  /** A main repository and a linked worktree whose `.git` is a hard link to a file outside. */
  const copied = (
    prepare: (admin: string, root: string) => void = () => undefined,
    mainRepository = "main",
  ) => {
    let head = "";
    let admin = "";
    const made = scenario(
      (root, outside) => {
        const main = NodePath.join(root, "main");
        NodeFS.mkdirSync(main, { mode: 0o700 });
        repository(main);
        git(main, "worktree", "add", "-q", "-b", "side", NodePath.join(root, "wt"));
        head = git(NodePath.join(root, "wt"), "rev-parse", "HEAD");
        admin = NodePath.join(main, ".git", "worktrees", "wt");
        const pointer = NodePath.join(outside, "pointer");
        // As it arrives: naming the source machine's folders.
        NodeFS.writeFileSync(
          pointer,
          `gitdir: ${NodePath.join(base, "source-machine", "main", ".git", "worktrees", "wt")}\n`,
        );
        NodeFS.rmSync(NodePath.join(root, "wt", ".git"));
        NodeFS.linkSync(pointer, NodePath.join(root, "wt", ".git"));
        prepare(admin, root);
      },
      {},
      [],
      () => [{ ...existingStep(head), kind: "copy", repo: "wt", row: "repo:wt", mainRepository }],
    );
    made.input.sourceRepositories = [
      {
        path: "wt",
        kind: "linked",
        head,
        branch: "side",
        branches: {},
        stash: null,
        stashCount: 0,
        identity: null,
        origin: null,
        status: [],
        worktrees: [],
        mainRepository,
      } as RepositoryInfo,
    ];
    return { ...made, admin };
  };

  it("puts a new file in its place and leaves the bytes of the old one alone", async () => {
    const { input, target, outside, admin } = copied();
    const before = bytes(outside);
    await run(input);
    expect(bytes(outside)).toEqual(before);
    expect(NodeFS.readFileSync(NodePath.join(target, "wt", ".git"), "utf8")).toBe(
      `gitdir: ${admin}\n`,
    );
    expect(NodeFS.lstatSync(NodePath.join(target, "wt", ".git")).nlink).toBe(1);
  });

  it("is left alone when the main repository's record for it is open to a group", async () => {
    const { input, target, outside } = copied((admin) => NodeFS.chmodSync(admin, 0o770));
    const before = bytes(outside);
    const result = await run(input);
    expect(bytes(outside)).toEqual(before);
    expect(NodeFS.lstatSync(NodePath.join(target, "wt", ".git")).nlink).toBe(2);
    expect(result.warnings.some((line) => line.includes("git worktree repair"))).toBe(true);
  });
});

describe.skipIf(!posix)("repairing a worktree whose header names another repository", () => {
  const repair = (prepare: (admin: string, root: string) => void, mainRepository = "main") => {
    let admin = "";
    let head = "";
    const made = scenario(
      (root, outside) => {
        const main = NodePath.join(root, "main");
        NodeFS.mkdirSync(main, { mode: 0o700 });
        repository(main);
        git(main, "worktree", "add", "-q", "-b", "side", NodePath.join(root, "wt"));
        head = git(NodePath.join(root, "wt"), "rev-parse", "HEAD");
        admin = NodePath.join(main, ".git", "worktrees", "wt");
        const pointer = NodePath.join(outside, "pointer");
        NodeFS.writeFileSync(
          pointer,
          `gitdir: ${NodePath.join(base, "source-machine", "main", ".git", "worktrees", "wt")}\n`,
        );
        NodeFS.rmSync(NodePath.join(root, "wt", ".git"));
        NodeFS.linkSync(pointer, NodePath.join(root, "wt", ".git"));
        prepare(admin, root);
      },
      {},
      [],
      () => [{ ...existingStep(head), kind: "copy", repo: "wt", row: "repo:wt", mainRepository }],
    );
    made.input.sourceRepositories = [
      {
        path: "wt",
        kind: "linked",
        head,
        branch: "side",
        branches: {},
        stash: null,
        stashCount: 0,
        identity: null,
        origin: null,
        status: [],
        worktrees: [],
        mainRepository,
      } as RepositoryInfo,
    ];
    return { ...made, admin };
  };

  it("never touches a repository outside the target, whatever the header says", async () => {
    let record = "";
    const { input, target } = repair((_admin, root) => {
      // The user's own repository beside the target, with a worktree of the same name.
      const unrelated = NodePath.join(NodePath.dirname(root), "unrelated");
      NodeFS.mkdirSync(unrelated, { mode: 0o700 });
      repository(unrelated);
      const elsewhere = NodePath.join(NodePath.dirname(root), "elsewhere");
      NodeFS.mkdirSync(elsewhere, { mode: 0o700 });
      git(unrelated, "worktree", "add", "-q", "-b", "side", NodePath.join(elsewhere, "wt"));
      record = NodePath.join(unrelated, ".git", "worktrees", "wt", "gitdir");
    }, "../unrelated");
    const before = NodeFS.readFileSync(record, "utf8");
    const result = await run(input).catch((cause: unknown) => cause);
    expect(NodeFS.readFileSync(record, "utf8")).toBe(before);
    expect(NodeFS.lstatSync(NodePath.join(target, "wt", ".git")).nlink).toBe(2);
    expect(result).not.toBeInstanceOf(TypeError);
  });

  it("leaves a record alone that belongs to another worktree", async () => {
    const foreign = `${NodePath.join(base, "source-machine", "another", ".git")}\n`;
    const { input, target, admin } = repair((record) =>
      NodeFS.writeFileSync(NodePath.join(record, "gitdir"), foreign),
    );
    const result = await run(input);
    expect(NodeFS.readFileSync(NodePath.join(admin, "gitdir"), "utf8")).toBe(foreign);
    expect(NodeFS.lstatSync(NodePath.join(target, "wt", ".git")).nlink).toBe(2);
    expect(result.warnings.some((line) => line.includes("git worktree repair"))).toBe(true);
  });
});

describe.skipIf(!posix)("Git data that shares its bytes with a file elsewhere", () => {
  it("refuses the branch move: Git appends to its log in place", async () => {
    let next = "";
    const { input, target, outside } = scenario(
      (root, elsewhere) => {
        repository(root);
        next = git(root, "rev-parse", "next");
        NodeFS.linkSync(
          NodePath.join(root, ".git", "logs", "HEAD"),
          NodePath.join(elsewhere, "log"),
        );
      },
      {},
      [],
      () => [existingStep(next)],
    );
    const was = git(target, "rev-parse", "HEAD");
    const before = bytes(outside);
    await expect(run(input)).rejects.toMatchObject({ reason: "git-failed" });
    expect(bytes(outside)).toEqual(before);
    expect(git(target, "rev-parse", "HEAD")).toBe(was);
    expect(NodeFS.readFileSync(NodePath.join(target, "shared", "f.txt"), "utf8")).toBe("one\n");
  });
});

describe.skipIf(!posix)("a clone into a folder that already holds something", () => {
  const cloned = (mode: number) => {
    counter += 1;
    const origin = NodePath.join(base, `origin-${counter}`);
    NodeFS.mkdirSync(origin, { mode: 0o700 });
    repository(origin);
    const head = git(origin, "rev-parse", "HEAD");
    return scenario(
      (root) => {
        NodeFS.mkdirSync(NodePath.join(root, "repo"), { mode: 0o700 });
        NodeFS.mkdirSync(NodePath.join(root, "repo", "shared"));
        NodeFS.chmodSync(NodePath.join(root, "repo", "shared"), mode);
        NodeFS.writeFileSync(NodePath.join(root, "repo", "shared", "mine.txt"), "mine\n");
      },
      {},
      [],
      () => [
        {
          ...existingStep(head),
          kind: "clone",
          repo: "repo",
          row: "repo:repo",
          origin,
          moveHead: "none",
        },
      ],
    );
  };

  it("checks out into private folders", async () => {
    const { input, target } = cloned(0o700);
    await run(input);
    expect(NodeFS.readFileSync(NodePath.join(target, "repo", "shared", "f.txt"), "utf8")).toBe(
      "one\n",
    );
  });

  it("is refused before the checkout when a folder it writes into is open to a group", async () => {
    const { input, target } = cloned(0o770);
    await expect(run(input)).rejects.toMatchObject({ reason: "group-writable" });
    expect(NodeFS.readdirSync(NodePath.join(target, "repo", "shared"))).toEqual(["mine.txt"]);
    expect(NodeFS.existsSync(NodePath.join(target, "repo", "top.txt"))).toBe(false);
  });
});

describe.skipIf(!posix)("a retry", () => {
  it("never deletes a file that is neither the copy nor the backed-up original", async () => {
    const { input, target } = scenario(
      (root) => NodeFS.writeFileSync(NodePath.join(root, "a.txt"), "written since the first run\n"),
      { "a.txt": "copied\n" },
    );
    (input.plan.actions as Array<FileAction>)[0] = {
      ...fileAction("a.txt", "copied\n"),
      replaces: true,
    };
    // The first run backed the reviewed file up and stopped.
    const backup = NodePath.join(input.backupRoot, "files", "a.txt");
    NodeFS.mkdirSync(NodePath.dirname(backup), { recursive: true });
    NodeFS.writeFileSync(backup, "the reviewed original\n");
    NodeFS.writeFileSync(
      input.journalFile,
      `${JSON.stringify({ t: "backup", path: "a.txt", backup })}\n`,
    );
    await expect(run(input)).rejects.toMatchObject({ reason: "changed-since-preview" });
    expect(NodeFS.readFileSync(NodePath.join(target, "a.txt"), "utf8")).toBe(
      "written since the first run\n",
    );
    expect(NodeFS.readFileSync(backup, "utf8")).toBe("the reviewed original\n");
  });
});

describe.skipIf(!posix)("Windows rights a new entry would inherit, through the seam", () => {
  it("refuse the folder before anything is made in it", async () => {
    const { input, directory, target } = scenario(() => undefined, { "new/a.txt": "a\n" });
    const mine = { owner: "user", othersMayWrite: false, othersMayReplace: false } as FolderAccess;
    input.confinement = {
      platform: "win32",
      access: async (paths) =>
        new Map(
          paths.map((path) => [
            path,
            path === target
              ? ({ ...mine, childrenOpen: true } as FolderAccess)
              : path.startsWith(directory)
                ? mine
                : ({ ...mine, owner: "trusted" } as FolderAccess),
          ]),
        ),
      secure: async () => undefined,
    };
    expect((await run(input)).refused).toEqual([
      { path: "new/a.txt", folder: ".", reason: "acl-entry" },
    ]);
    expect(NodeFS.existsSync(NodePath.join(target, "new"))).toBe(false);
  });
});
