// @effect-diagnostics nodeBuiltinImport:off - disposable folders only.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";

import { applyPlan, partialPath, type ApplyInput, type JournalEntry } from "./apply.ts";
import { JsonLog } from "./durable.ts";
import { git } from "./folderFixture.testkit.ts";
import type { FileAction, Plan } from "./reconcile.ts";
import { previewUndo, undoApply } from "./undo.ts";

vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof NodeFSP>()),
}));

let base: string;
let counter = 0;

beforeAll(() => {
  base = NodeFS.realpathSync(NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "swc-recover-")));
});
afterAll(() => NodeFS.rmSync(base, { recursive: true, force: true }));

const sha = (body: string) => NodeCrypto.createHash("sha256").update(body).digest("hex");

/** Every folder, file and link below `root`: an empty folder left behind shows. */
function tree(root: string): Record<string, string> {
  const result: Record<string, string> = {};
  const walk = (directory: string) => {
    for (const name of NodeFS.readdirSync(directory)) {
      const absolute = NodePath.join(directory, name);
      const relative = NodePath.relative(root, absolute).split(NodePath.sep).join("/");
      const stat = NodeFS.lstatSync(absolute);
      if (stat.isSymbolicLink()) result[relative] = `link:${NodeFS.readlinkSync(absolute)}`;
      else if (stat.isDirectory()) {
        result[`${relative}/`] = "";
        walk(absolute);
      } else result[relative] = NodeFS.readFileSync(absolute, "utf8");
    }
  };
  if (NodeFS.existsSync(root)) walk(root);
  return result;
}

const fileAction = (path: string, body: string, replaces = false): FileAction => ({
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
  replaces,
  localSource: null,
  row: "files",
  writePath: path,
});

const folderAction = (path: string, replaces = false): FileAction => ({
  path,
  kind: "mkdir",
  entry: {
    path,
    type: "directory",
    mode: 0o755,
    size: 0,
    mtimeMs: 0,
    class: "untracked",
    repo: null,
  },
  replaces,
  localSource: null,
  row: "files",
  writePath: path,
});

/** A destination folder, staged files and the Apply input for `actions`. */
function scenario(
  destination: (target: string) => void,
  staged: Record<string, string>,
  actions: Array<FileAction>,
) {
  counter += 1;
  const directory = NodePath.join(base, `case-${counter}`);
  const target = NodePath.join(directory, "target");
  const staging = NodePath.join(directory, "staging");
  NodeFS.mkdirSync(target, { recursive: true });
  NodeFS.mkdirSync(staging, { recursive: true });
  destination(target);
  for (const [path, body] of Object.entries(staged)) {
    const file = NodePath.join(staging, ...path.split("/"));
    NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true });
    NodeFS.writeFileSync(file, body);
  }
  const plan = {
    rows: [],
    actions,
    git: [],
    totals: { filesToMove: 0, bytesToMove: 0, bytesPresent: 0, decisionsNeeded: 0, replacing: 0 },
    warnings: [],
  } satisfies Plan;
  const input: ApplyInput = {
    operationId: `recover-${counter}`,
    targetRoot: target,
    stagingRoot: staging,
    backupRoot: NodePath.join(directory, "backups"),
    journalFile: NodePath.join(directory, "journal.ndjson"),
    plan,
    sourceRepositories: [],
    leftBehind: new Set(),
  };
  return { input, target, staging };
}

const undoOf = (input: ApplyInput, force = false) =>
  undoApply({
    targetRoot: input.targetRoot,
    backupRoot: input.backupRoot,
    journalFile: input.journalFile,
    force,
  });

describe("a take-theirs folder that replaces a file or link", () => {
  it.each([
    [
      "a file",
      (target: string) => NodeFS.writeFileSync(NodePath.join(target, "T"), "original T\n"),
      { "T/x": "copied x\n" },
      [folderAction("T", true), fileAction("T/x", "copied x\n")],
    ],
    [
      "a link",
      (target: string) => NodeFS.symlinkSync("somewhere-else", NodePath.join(target, "T")),
      { "T/x": "copied x\n" },
      [folderAction("T", true), fileAction("T/x", "copied x\n")],
    ],
    [
      "a file, with a nested folder",
      (target: string) => NodeFS.writeFileSync(NodePath.join(target, "T"), "original T\n"),
      { "T/a/x": "copied x\n" },
      [folderAction("T", true), folderAction("T/a"), fileAction("T/a/x", "copied x\n")],
    ],
    [
      "a file, with a nested folder the plan does not list",
      (target: string) => NodeFS.writeFileSync(NodePath.join(target, "T"), "original T\n"),
      { "T/a/x": "copied x\n" },
      [folderAction("T", true), fileAction("T/a/x", "copied x\n")],
    ],
  ] as const)(
    "journals its backup and mkdir before what goes inside, so Undo restores %s exactly",
    async (_label, destination, staged, actions) => {
      const { input, target } = scenario(
        (folder) => {
          destination(folder);
          NodeFS.writeFileSync(NodePath.join(folder, "keep"), "kept\n");
        },
        staged,
        [...actions],
      );
      const before = tree(target);
      await applyPlan(input);
      expect(NodeFS.lstatSync(NodePath.join(target, "T")).isDirectory()).toBe(true);
      const order = (await new JsonLog<JournalEntry>(input.journalFile).read()).map(
        (entry) => `${entry.t}:${"path" in entry ? entry.path : ""}`,
      );
      const intent = order.findIndex((line) => line.startsWith("write:T/"));
      expect(order.indexOf("backup:T")).toBeLessThan(intent);
      expect(order.indexOf("mkdir:T")).toBeLessThan(intent);
      expect(
        (await previewUndo({ targetRoot: target, journalFile: input.journalFile })).edited,
      ).toBe(0);
      const undo = await undoOf(input);
      expect(undo).toMatchObject({ kept: [], problems: [] });
      expect(tree(target)).toEqual(before);
    },
  );
});

describe("Undo after a crash", () => {
  it("never moves an original whose backup was recorded but not saved, even when forced", async () => {
    const { input, target } = scenario(
      (folder) => NodeFS.writeFileSync(NodePath.join(folder, "g"), "made by git\n"),
      { g: "copied\n" },
      [],
    );
    // A crash between the synced backup record and its move.
    const log = new JsonLog<JournalEntry>(input.journalFile);
    await log.append({ t: "write", path: "g", sha256: sha("copied\n"), linkTarget: null });
    await log.append({
      t: "backup",
      path: "g",
      backup: NodePath.join(input.backupRoot, "files", "g"),
    });
    await log.close();
    const preview = await previewUndo({ targetRoot: target, journalFile: input.journalFile });
    expect(preview.items).toEqual([]);
    const undo = await undoOf(input, true);
    expect(undo.movedToBackup).toEqual([]);
    expect(tree(target)).toEqual({ g: "made by git\n" });
  });
});

/** Journals `write` intents for `paths` as an Apply that stopped before acting would have. */
async function intents(input: ApplyInput, paths: Record<string, string>) {
  const log = new JsonLog<JournalEntry>(input.journalFile);
  for (const [path, body] of Object.entries(paths))
    await log.append({ t: "write", path, sha256: sha(body), linkTarget: null }, true);
  await log.close();
}

const LEGACY_BIG = ".big.swc-0b5e5a0e-3c1f-4a8e-9a57-2f1c3d4e5f60.partial";
const LEGACY_OTHER = ".other.swc-0b5e5a0e-3c1f-4a8e-9a57-2f1c3d4e5f60.partial";

describe("a cross-volume copy killed mid-way", () => {
  it.each(["Apply replay", "Undo"])("%s reports a cleanup listing failure", async (mode) => {
    const { input, target } = scenario(
      (folder) => NodeFS.writeFileSync(NodePath.join(folder, LEGACY_BIG), "unfinished"),
      { big: "BIG\n" },
      [fileAction("big", "BIG\n")],
    );
    await intents(input, { big: "BIG\n" });
    const error = Object.assign(new Error("EACCES: cannot list partials"), { code: "EACCES" });
    const readdir = vi.spyOn(NodeFSP, "readdir").mockRejectedValue(error);
    try {
      if (mode === "Apply replay") {
        await expect(applyPlan(input)).rejects.toBe(error);
      } else {
        expect((await undoOf(input)).problems).toEqual(["big: EACCES: cannot list partials"]);
      }
    } finally {
      readdir.mockRestore();
    }
    expect(NodeFS.readFileSync(NodePath.join(target, LEGACY_BIG), "utf8")).toBe("unfinished");
    // A retry after the failure is fixed can enumerate and clean up normally.
    if (mode === "Apply replay") await applyPlan(input);
    else expect((await undoOf(input)).problems).toEqual([]);
    expect(NodeFS.existsSync(NodePath.join(target, LEGACY_BIG))).toBe(false);
  });

  it.for(["Apply replay", "Undo"])(
    "%s removes a pre-clipping Unicode partial and preserves another operation's partials",
    async (mode, context) => {
      const name = "é".repeat(120);
      const { input, target } = scenario(() => undefined, { [name]: "complete\n" }, [
        fileAction(name, "complete\n"),
      ]);
      const to = NodePath.join(target, name);
      // Reproduce the previous release's spelling independently of partialPath.
      const oldPartial = (journal: string) =>
        NodePath.join(target, `.${name}.swc-partial-${sha(`${journal}\0${to}`).slice(0, 12)}`);
      const old = oldPartial(input.journalFile);
      expect(Buffer.byteLength(NodePath.basename(old))).toBe(266);
      expect(old).not.toBe(partialPath(to, input.journalFile));
      try {
        NodeFS.writeFileSync(old, "unfinished");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENAMETOOLONG") throw error;
        context.skip("Host filesystem cannot contain the pre-upgrade Unicode partial");
        return;
      }
      const otherOld = oldPartial(`${input.journalFile}.other`);
      const otherCurrent = partialPath(to, `${input.journalFile}.other`);
      NodeFS.writeFileSync(otherOld, "other old partial");
      NodeFS.writeFileSync(otherCurrent, "other current partial");
      NodeFS.writeFileSync(partialPath(to, input.journalFile), "current unfinished");
      await intents(input, { [name]: "complete\n" });
      if (mode === "Apply replay") {
        const result = await applyPlan(input);
        expect(result.warnings).toEqual([]);
        expect(NodeFS.readFileSync(to, "utf8")).toBe("complete\n");
      } else {
        expect((await undoOf(input)).problems).toEqual([]);
      }
      expect(tree(target)).toEqual({
        ...(mode === "Apply replay" ? { [name]: "complete\n" } : {}),
        [NodePath.basename(otherOld)]: "other old partial",
        [NodePath.basename(otherCurrent)]: "other current partial",
      });
    },
  );

  it("names its partial per target, and replay removes the leftover", async () => {
    const { input, target } = scenario(() => undefined, { big: "BIG\n" }, [
      fileAction("big", "BIG\n"),
    ]);
    const partial = partialPath(NodePath.join(target, "big"), input.journalFile);
    expect(NodePath.dirname(partial)).toBe(target);
    expect(NodePath.basename(partial)).toMatch(/^\.big\.swc-partial-[0-9a-f]{12}$/);
    expect(partialPath(NodePath.join(target, "big"), `${input.journalFile}.other`)).not.toBe(
      partial,
    );
    NodeFS.writeFileSync(partial, "BI");
    const log = new JsonLog<JournalEntry>(input.journalFile);
    await log.append({ t: "write", path: "big", sha256: sha("BIG\n"), linkTarget: null }, true);
    await log.close();
    await applyPlan(input);
    expect(tree(target)).toEqual({ big: "BIG\n" });
  });

  it("and Undo removes the leftover too", async () => {
    const { input, target } = scenario(() => undefined, { big: "BIG\n" }, []);
    NodeFS.writeFileSync(partialPath(NodePath.join(target, "big"), input.journalFile), "BI");
    const log = new JsonLog<JournalEntry>(input.journalFile);
    await log.append({ t: "write", path: "big", sha256: sha("BIG\n"), linkTarget: null }, true);
    await log.close();
    const undo = await undoOf(input);
    expect(undo.problems).toEqual([]);
    expect(tree(target)).toEqual({});
  });
});

describe("partial names never touch a person's own files", () => {
  it("keeps a person's own .notes.swc-partial through Apply, a replay and Undo", async () => {
    const { input, target } = scenario(
      (folder) => NodeFS.writeFileSync(NodePath.join(folder, ".notes.swc-partial"), "mine\n"),
      { notes: "copied notes\n" },
      [fileAction("notes", "copied notes\n")],
    );
    await applyPlan(input);
    // A replay (the done mark lost) sweeps leftovers of every journaled write.
    const lines = NodeFS.readFileSync(input.journalFile, "utf8")
      .split("\n")
      .filter((line) => line && JSON.parse(line).t !== "done");
    NodeFS.writeFileSync(input.journalFile, `${lines.join("\n")}\n`);
    await applyPlan(input);
    expect(tree(target)).toEqual({ ".notes.swc-partial": "mine\n", notes: "copied notes\n" });
    const undo = await undoOf(input);
    expect(undo).toMatchObject({ kept: [], problems: [] });
    expect(tree(target)).toEqual({ ".notes.swc-partial": "mine\n" });
  });

  it("replay removes an earlier version's partial for a journaled write only", async () => {
    const { input, target } = scenario(
      (folder) => {
        NodeFS.writeFileSync(NodePath.join(folder, LEGACY_BIG), "BI");
        NodeFS.writeFileSync(NodePath.join(folder, LEGACY_OTHER), "not ours to judge\n");
      },
      { big: "BIG\n" },
      [fileAction("big", "BIG\n")],
    );
    await intents(input, { big: "BIG\n" });
    await applyPlan(input);
    expect(tree(target)).toEqual({ big: "BIG\n", [LEGACY_OTHER]: "not ours to judge\n" });
  });

  it("Undo removes an earlier version's partial for a journaled write only", async () => {
    const { input, target } = scenario(
      (folder) => {
        NodeFS.writeFileSync(NodePath.join(folder, LEGACY_BIG), "BI");
        NodeFS.writeFileSync(NodePath.join(folder, LEGACY_OTHER), "not ours to judge\n");
      },
      {},
      [],
    );
    await intents(input, { big: "BIG\n" });
    const undo = await undoOf(input);
    expect(undo.problems).toEqual([]);
    expect(tree(target)).toEqual({ [LEGACY_OTHER]: "not ours to judge\n" });
  });
});

describe("replay", () => {
  it("redoes a write whose done mark survived but whose rename was lost", async () => {
    const { input, target, staging } = scenario(() => undefined, { a: "A\n", b: "B\n" }, [
      fileAction("a", "A\n"),
      fileAction("b", "B\n"),
    ]);
    await applyPlan(input);
    // The folder's rename of `a` never reached the disk; the journal kept its done mark.
    const lines = NodeFS.readFileSync(input.journalFile, "utf8")
      .split("\n")
      .filter((line) => line && JSON.parse(line).t !== "done");
    NodeFS.writeFileSync(input.journalFile, `${lines.join("\n")}\n`);
    NodeFS.renameSync(NodePath.join(target, "a"), NodePath.join(staging, "a"));
    await applyPlan(input);
    expect(tree(target)).toEqual({ a: "A\n", b: "B\n" });
    const undo = await undoOf(input);
    expect(undo).toMatchObject({ kept: [], problems: [] });
    expect(tree(target)).toEqual({});
  });
});

describe("folder checks", () => {
  it("checks folders again in each batch: one swapped for a link after an earlier batch is refused", async () => {
    const elsewhere = NodePath.join(base, "elsewhere-batches");
    NodeFS.mkdirSync(elsewhere, { recursive: true });
    const names = Array.from({ length: 600 }, (_, index) => `d/f${String(index).padStart(4, "0")}`);
    const { input, target } = scenario(
      (folder) => NodeFS.mkdirSync(NodePath.join(folder, "d")),
      Object.fromEntries(names.map((name) => [name, `${name}\n`])),
      names.map((name) => fileAction(name, `${name}\n`)),
    );
    // The first batch holds 512 files; swap `d` for a link once its last file is done.
    const probe = await NodeFSP.open(NodePath.join(base, "probe"), "w");
    const prototype = Object.getPrototypeOf(probe) as NodeFSP.FileHandle;
    await probe.close();
    const original = prototype.appendFile;
    const spy = vi.spyOn(prototype, "appendFile").mockImplementation(async function (
      this: NodeFSP.FileHandle,
      ...args: Parameters<NodeFSP.FileHandle["appendFile"]>
    ) {
      await original.apply(this, args);
      if (String(args[0]).includes(`"write-done","path":"${names[511]}"`)) {
        NodeFS.renameSync(NodePath.join(target, "d"), NodePath.join(target, "d-moved"));
        NodeFS.symlinkSync(elsewhere, NodePath.join(target, "d"));
      }
    });
    try {
      await expect(applyPlan(input)).rejects.toMatchObject({ reason: "link-in-path" });
    } finally {
      spy.mockRestore();
    }
    expect(NodeFS.readdirSync(elsewhere)).toEqual([]);
  });
});

/**
 * A repository whose Git data reaches the target at its first commit (the
 * snapshot) while its working files are read after `later` changed them, as a
 * copy racing the source's commits does. `.git` is placed outside Apply.
 */
function racingRepository(initial: (source: string) => void, later: (source: string) => void) {
  counter += 1;
  const directory = NodePath.join(base, `race-${counter}`);
  const source = NodePath.join(directory, "source");
  const target = NodePath.join(directory, "target");
  const staging = NodePath.join(directory, "staging");
  NodeFS.mkdirSync(source, { recursive: true });
  NodeFS.mkdirSync(staging, { recursive: true });
  git(source, "init", "-q");
  initial(source);
  git(source, "add", "-A");
  git(source, "commit", "-q", "-m", "snapshot");
  const head = git(source, "rev-parse", "HEAD");
  const branch = git(source, "branch", "--show-current");
  NodeFS.cpSync(NodePath.join(source, ".git"), NodePath.join(target, ".git"), { recursive: true });
  later(source);
  git(source, "add", "-A");
  git(source, "commit", "-q", "-m", "after the snapshot");
  const actions: Array<FileAction> = [];
  for (const name of NodeFS.readdirSync(source).sort()) {
    if (name === ".git") continue;
    const absolute = NodePath.join(source, name);
    if (NodeFS.lstatSync(absolute).isSymbolicLink()) {
      actions.push({
        path: name,
        kind: "link",
        entry: {
          path: name,
          type: "symlink",
          mode: 0o777,
          size: 0,
          mtimeMs: 0,
          class: "tracked",
          repo: ".",
          target: NodeFS.readlinkSync(absolute),
        },
        replaces: false,
        localSource: null,
        row: "files",
        writePath: name,
      });
    } else {
      const body = NodeFS.readFileSync(absolute, "utf8");
      NodeFS.writeFileSync(NodePath.join(staging, name), body);
      actions.push(fileAction(name, body));
    }
  }
  const input: ApplyInput = {
    operationId: `race-${counter}`,
    targetRoot: target,
    stagingRoot: staging,
    backupRoot: NodePath.join(directory, "backups"),
    journalFile: NodePath.join(directory, "journal.ndjson"),
    plan: {
      rows: [],
      actions,
      git: [
        {
          repo: ".",
          row: "repo",
          kind: "copy",
          sourceHead: head,
          sourceBranch: branch,
          identity: null,
          origin: null,
          sourceBranches: { [branch]: head },
          sourceStashCount: 0,
          fetch: false,
          moveHead: "none",
          stashDestination: false,
          importBranches: false,
          importPrefix: "swc/from-source",
          mainRepository: null,
        },
      ],
      totals: { filesToMove: 0, bytesToMove: 0, bytesPresent: 0, decisionsNeeded: 0, replacing: 0 },
      warnings: [],
    },
    sourceRepositories: [
      {
        path: ".",
        kind: "main",
        head,
        branch,
        branches: { [branch]: head },
        stash: null,
        stashCount: 0,
        identity: null,
        origin: null,
        status: [],
        worktrees: [],
        mainRepository: null,
      },
    ],
    leftBehind: new Set(),
  };
  const index = NodePath.join(target, ".git", "index");
  return { input, target, indexHash: () => sha(NodeFS.readFileSync(index, "latin1")) };
}

const withoutGit = (root: string) =>
  Object.fromEntries(Object.entries(tree(root)).filter(([path]) => !path.startsWith(".git/")));

describe("restoring files that changed on the source after the Git snapshot", () => {
  // Git on Windows checks links out as plain files (core.symlinks is off).
  it.skipIf(process.platform === "win32").each([
    [
      "a link that became a file",
      (source: string) => {
        NodeFS.writeFileSync(NodePath.join(source, "a"), "A\n");
        NodeFS.symlinkSync("a", NodePath.join(source, "ln"));
      },
      (source: string) => {
        NodeFS.unlinkSync(NodePath.join(source, "ln"));
        NodeFS.writeFileSync(NodePath.join(source, "ln"), "now a file\n");
      },
      { a: "A\n", ln: "link:a" },
    ],
    [
      "a retargeted link",
      (source: string) => NodeFS.symlinkSync("x", NodePath.join(source, "ln")),
      (source: string) => {
        NodeFS.unlinkSync(NodePath.join(source, "ln"));
        NodeFS.symlinkSync("y", NodePath.join(source, "ln"));
      },
      { ln: "link:x" },
    ],
  ] as const)(
    "journals and counts %s, leaves the copied index alone, and Undo removes it",
    async (_label, initial, later, expected) => {
      const { input, target, indexHash } = racingRepository(initial, later);
      const index = indexHash();
      const result = await applyPlan(input);
      expect(withoutGit(target)).toEqual(expected);
      expect(result.restored).toEqual(["ln"]);
      expect(result.warnings).toEqual([
        "1 file changed on the source after copying started; the copy has them as they were when it started. Copy again to bring the newer versions. (ln)",
      ]);
      expect(result.checks).toEqual([{ repo: ".", ok: true, problems: [] }]);
      expect(indexHash()).toBe(index);
      expect(
        (await previewUndo({ targetRoot: target, journalFile: input.journalFile })).edited,
      ).toBe(0);
      const undo = await undoOf(input);
      expect(undo).toMatchObject({ kept: [], problems: [] });
      expect(withoutGit(target)).toEqual({});
    },
  );

  it("journals each restore before it lands: a power cut after the restore replays, and Undo removes it", async () => {
    const { input, target } = racingRepository(
      (source) => NodeFS.writeFileSync(NodePath.join(source, "churn.txt"), "old\n"),
      (source) => NodeFS.writeFileSync(NodePath.join(source, "churn.txt"), "new, longer\n"),
    );
    const churn = NodePath.join(target, "churn.txt");
    const restoredHere = () =>
      NodeFS.existsSync(churn) && NodeFS.readFileSync(churn, "utf8") === "old\n";
    // The cut falls at the first sync once the snapshot version is in place: lines
    // written after the last finished sync are lost, the restored file stays.
    const probe = await NodeFSP.open(NodePath.join(base, "probe"), "w");
    const prototype = Object.getPrototypeOf(probe) as NodeFSP.FileHandle;
    await probe.close();
    const original = prototype.sync;
    let durable = 0;
    let crashed = false;
    const spy = vi.spyOn(prototype, "sync").mockImplementation(async function (
      this: NodeFSP.FileHandle,
    ) {
      if (crashed) return;
      if (restoredHere()) {
        crashed = true;
        throw new Error("simulated power cut");
      }
      await original.call(this);
      durable = NodeFS.statSync(input.journalFile).size;
    });
    try {
      await expect(applyPlan(input)).rejects.toThrow("simulated power cut");
    } finally {
      spy.mockRestore();
    }
    NodeFS.truncateSync(input.journalFile, durable);
    expect(restoredHere()).toBe(true);

    const replay = await applyPlan(input);
    expect(replay.restored).toEqual(["churn.txt"]);
    expect(replay.warnings).toHaveLength(1);
    const undo = await undoOf(input);
    expect(undo).toMatchObject({ kept: [], problems: [] });
    expect(withoutGit(target)).toEqual({});
  });

  it.each([false, true])(
    "Undo after a crash between the synced restore and its move removes Apply's own write (force: %s)",
    async (force) => {
      const { input, target } = racingRepository(
        (source) => NodeFS.writeFileSync(NodePath.join(source, "churn.txt"), "old\n"),
        (source) => NodeFS.writeFileSync(NodePath.join(source, "churn.txt"), "new, longer\n"),
      );
      const probe = await NodeFSP.open(NodePath.join(base, "probe"), "w");
      const prototype = Object.getPrototypeOf(probe) as NodeFSP.FileHandle;
      await probe.close();
      const original = prototype.sync;
      let crashed = false;
      const spy = vi.spyOn(prototype, "sync").mockImplementation(async function (
        this: NodeFSP.FileHandle,
      ) {
        await original.call(this);
        if (!crashed && NodeFS.readFileSync(input.journalFile, "utf8").includes('"t":"restore"')) {
          crashed = true;
          throw new Error("simulated crash before the restore lands");
        }
      });
      try {
        await expect(applyPlan(input)).rejects.toThrow("simulated crash before the restore lands");
      } finally {
        spy.mockRestore();
      }
      // The file still holds Apply's write; the restore never landed.
      expect(withoutGit(target)).toEqual({ "churn.txt": "new, longer\n" });
      expect(
        (await previewUndo({ targetRoot: target, journalFile: input.journalFile })).edited,
      ).toBe(0);
      const undo = await undoOf(input, force);
      expect(undo).toMatchObject({ kept: [], movedToBackup: [], problems: [] });
      expect(withoutGit(target)).toEqual({});
    },
  );
});
