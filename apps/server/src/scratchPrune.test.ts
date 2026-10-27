// @effect-diagnostics nodeBuiltinImport:off globalDate:off - exercises the age walk on a real temp folder, whose ctimes are wall-clock times.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  archiveFolder,
  DAY_MS,
  decideScratchPrune,
  newestTreeMtime,
  parseAge,
  type ScratchEntry,
  SourcePartlyRemovedError,
} from "./scratchPrune.ts";

const NOW = Date.parse("2026-10-27T12:00:00.000Z");
const ROOT = "/home/me/.specwithcode/scratch";
const AGE = 14 * DAY_MS;

const entry = (name: string, newestMs: number | null, kind: ScratchEntry["kind"] = "directory") =>
  ({
    name,
    paths: [`${ROOT}/${name}`],
    kind,
    age:
      newestMs === null
        ? { known: false, reason: "stat failed" }
        : { known: true, newestMs, entries: 1 },
  }) satisfies ScratchEntry;

const decide = (
  entries: ReadonlyArray<ScratchEntry>,
  livePaths: ReadonlyArray<{ paths: ReadonlyArray<string>; owner: string }> = [],
  olderThanMs = AGE,
) =>
  decideScratchPrune({
    scratchRoots: [ROOT],
    entries,
    livePaths,
    now: NOW,
    olderThanMs,
    foldCase: false,
  }).map(({ name, action, reason }) => ({ name, action, reason }));

describe("decideScratchPrune", () => {
  it("removes only unused folders past the cutoff", () => {
    expect(decide([entry("old", NOW - 20 * DAY_MS), entry("recent", NOW - 2 * DAY_MS)])).toEqual([
      { name: "old", action: "remove", reason: "unused, modified 20d ago" },
      { name: "recent", action: "keep", reason: "modified 2d ago" },
    ]);
  });

  it("keeps a folder whose age is unknown, in the future, or not a number", () => {
    const decisions = decide([
      entry("unreadable", null),
      entry("future", NOW + DAY_MS),
      { ...entry("nan", 0), age: { known: true, newestMs: Number.NaN, entries: 1 } },
    ]);
    expect(decisions.map((decision) => decision.action)).toEqual(["keep", "keep", "keep"]);
    expect(decisions[0]!.reason).toMatch(/^age unknown/);
    expect(decisions[1]!.reason).toBe("modified in the future");
  });

  it("keeps files and symlinks", () => {
    expect(
      decide([
        entry("notes.txt", NOW - 90 * DAY_MS, "file"),
        entry("link", NOW - 90 * DAY_MS, "symlink"),
      ]),
    ).toEqual([
      { name: "notes.txt", action: "keep", reason: "not a folder (file)" },
      { name: "link", action: "keep", reason: "not a folder (symlink)" },
    ]);
  });

  it("keeps folders a live path is inside of, or that a live path holds", () => {
    const old = NOW - 60 * DAY_MS;
    expect(
      decide(
        [entry("chat", old), entry("repo", old), entry("chatty", old)],
        [
          { paths: [`${ROOT}/chat`], owner: "thread t1 (archived)" },
          { paths: [`${ROOT}/repo/packages/app`], owner: "project /p" },
        ],
      ),
    ).toEqual([
      { name: "chat", action: "keep", reason: "in use by thread t1 (archived)" },
      { name: "repo", action: "keep", reason: "in use by project /p" },
      // A shared name prefix is not containment.
      { name: "chatty", action: "remove", reason: "unused, modified 60d ago" },
    ]);
  });

  it("keeps a folder that holds a live path through either spelling", () => {
    const old = NOW - 60 * DAY_MS;
    const aliased = {
      ...entry("via-link", old),
      paths: [`${ROOT}/via-link`, "/link/scratch/via-link"],
    };
    expect(
      decide([aliased], [{ paths: ["/link/scratch/via-link/sub"], owner: "agent session" }]),
    ).toEqual([{ name: "via-link", action: "keep", reason: "in use by agent session" }]);
  });

  it("ignores live paths at or around the scratch folder, which would bind every child", () => {
    const old = NOW - 60 * DAY_MS;
    expect(
      decide(
        [entry("probe", old)],
        [
          { paths: [ROOT], owner: "project scratch" },
          { paths: ["/home/me"], owner: "project home" },
        ],
      ),
    ).toEqual([{ name: "probe", action: "remove", reason: "unused, modified 60d ago" }]);
  });

  it("matches a live path stored with other letter case where the file system ignores case", () => {
    const old = NOW - 60 * DAY_MS;
    const input = {
      scratchRoots: [ROOT],
      entries: [entry("Chat-ABC", old)],
      livePaths: [{ paths: [`${ROOT}/chat-abc`], owner: "thread t1 (open)" }],
      now: NOW,
      olderThanMs: AGE,
      foldCase: false,
    };
    expect(decideScratchPrune({ ...input, foldCase: true })[0]!.reason).toBe(
      "in use by thread t1 (open)",
    );
    // Windows paths compare without case whatever foldCase says.
    if (process.platform !== "win32")
      expect(decideScratchPrune({ ...input, foldCase: false })[0]!.action).toBe("remove");
  });

  it("keeps everything when the cutoff is below seven days or not finite", () => {
    const old = NOW - 60 * DAY_MS;
    expect(decide([entry("a", old)], [], 6 * DAY_MS)[0]!.action).toBe("keep");
    expect(decide([entry("a", old)], [], Number.NaN)[0]!.action).toBe("keep");
  });
});

describe("parseAge", () => {
  it("reads hours, days and weeks", () => {
    expect(parseAge("14d")).toBe(14 * DAY_MS);
    expect(parseAge("2w")).toBe(14 * DAY_MS);
    expect(parseAge("336h")).toBe(14 * DAY_MS);
  });

  it.each(["", "14", "d", "-7d", "7.5d", "7 days", "1y"])("rejects %j", (text) => {
    expect(parseAge(text)).toBeNull();
  });
});

describe("newestTreeMtime and archiveFolder", () => {
  const made: Array<string> = [];
  const temp = () => {
    const folder = NodeFS.realpathSync(
      NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "scratch-prune-")),
    );
    made.push(folder);
    return folder;
  };
  afterEach(() => {
    for (const folder of made.splice(0)) {
      NodeFS.chmodSync(folder, 0o700);
      NodeFS.rmSync(folder, { recursive: true, force: true });
    }
  });
  const setTime = (target: string, ms: number) => NodeFS.utimesSync(target, ms / 1000, ms / 1000);
  // Tests can set mtimes but not ctimes, which utimes moves to the present.
  const modifiedOnly = (stat: NodeFS.Stats) => stat.mtimeMs;

  it("takes the newest mtime anywhere in the tree, without following symlinks", () => {
    const root = temp();
    const folder = NodePath.join(root, "work");
    NodeFS.mkdirSync(NodePath.join(folder, "deep", "deeper"), { recursive: true });
    const file = NodePath.join(folder, "deep", "deeper", "log.txt");
    NodeFS.writeFileSync(file, "x");
    const outside = NodePath.join(root, "outside");
    NodeFS.mkdirSync(outside);
    NodeFS.symlinkSync(outside, NodePath.join(folder, "link"));
    const old = NOW - 30 * DAY_MS;
    for (const target of [
      folder,
      NodePath.join(folder, "deep"),
      NodePath.join(folder, "deep", "deeper"),
    ])
      setTime(target, old);
    NodeFS.lutimesSync(NodePath.join(folder, "link"), old / 1000, old / 1000);
    setTime(outside, NOW);
    setTime(file, NOW - 3 * DAY_MS);
    expect(newestTreeMtime(folder, undefined, modifiedOnly)).toEqual({
      known: true,
      newestMs: NOW - 3 * DAY_MS,
      entries: 5,
    });
  });

  it("counts ctime, so a tree copied in with old mtimes is new", () => {
    const folder = NodePath.join(temp(), "restored");
    NodeFS.mkdirSync(folder);
    NodeFS.writeFileSync(NodePath.join(folder, "log.txt"), "x");
    const before = Date.now() - 1000;
    // What `tar x`, `rsync -a` or `cp -p` leave behind.
    for (const target of [NodePath.join(folder, "log.txt"), folder]) setTime(target, 0);
    const age = newestTreeMtime(folder);
    expect(age.known && age.newestMs >= before).toBe(true);
  });

  it("is unknown past the entry limit or when a folder cannot be listed", () => {
    const root = temp();
    for (const name of ["a", "b", "c"]) NodeFS.writeFileSync(NodePath.join(root, name), "");
    expect(newestTreeMtime(root, 3)).toEqual({ known: false, reason: "more than 3 entries" });
    const locked = NodePath.join(root, "locked");
    NodeFS.mkdirSync(locked);
    NodeFS.writeFileSync(NodePath.join(locked, "secret"), "");
    NodeFS.chmodSync(locked, 0o000);
    try {
      const age = newestTreeMtime(root);
      // Root can read anything; elsewhere the locked folder makes the age unknown.
      if (process.getuid?.() !== 0 && process.platform !== "win32") expect(age.known).toBe(false);
    } finally {
      NodeFS.chmodSync(locked, 0o700);
    }
    expect(newestTreeMtime(NodePath.join(root, "missing")).known).toBe(false);
  });

  it("moves a folder and refuses to overwrite one already archived", () => {
    const root = temp();
    const source = NodePath.join(root, "scratch", "probe");
    const archive = NodePath.join(root, "archive");
    NodeFS.mkdirSync(source, { recursive: true });
    NodeFS.mkdirSync(archive);
    NodeFS.writeFileSync(NodePath.join(source, "run.log"), "kept");
    expect(archiveFolder(source, archive)).toBe(NodePath.join(archive, "probe"));
    expect(NodeFS.readFileSync(NodePath.join(archive, "probe", "run.log"), "utf8")).toBe("kept");
    expect(NodeFS.existsSync(source)).toBe(false);
    NodeFS.mkdirSync(source);
    expect(() => archiveFolder(source, archive)).toThrow(/already exists/);
    expect(NodeFS.existsSync(source)).toBe(true);
    // An empty folder of that name is not replaced either.
    NodeFS.rmSync(NodePath.join(archive, "probe"), { recursive: true });
    NodeFS.mkdirSync(NodePath.join(archive, "probe"));
    expect(() => archiveFolder(source, archive)).toThrow(/already exists/);
    expect(NodeFS.existsSync(source)).toBe(true);
  });

  const crossVolume = () => {
    throw Object.assign(new Error("cross-device link"), { code: "EXDEV" });
  };

  it("copies across volumes, keeping times and symlinks, then removes the source", () => {
    const root = temp();
    const source = NodePath.join(root, "scratch", "probe");
    const archive = NodePath.join(root, "archive");
    NodeFS.mkdirSync(NodePath.join(source, "deep"), { recursive: true });
    NodeFS.mkdirSync(archive);
    NodeFS.writeFileSync(NodePath.join(source, "deep", "run.log"), "kept");
    NodeFS.symlinkSync("../elsewhere", NodePath.join(source, "link"));
    const old = NOW - 30 * DAY_MS;
    setTime(NodePath.join(source, "deep", "run.log"), old);
    expect(archiveFolder(source, archive, crossVolume)).toBe(NodePath.join(archive, "probe"));
    const copied = NodePath.join(archive, "probe");
    expect(NodeFS.readFileSync(NodePath.join(copied, "deep", "run.log"), "utf8")).toBe("kept");
    expect(NodeFS.statSync(NodePath.join(copied, "deep", "run.log")).mtimeMs).toBe(old);
    expect(NodeFS.readlinkSync(NodePath.join(copied, "link"))).toBe(
      NodePath.normalize("../elsewhere"),
    );
    expect(NodeFS.existsSync(source)).toBe(false);
  });

  // Windows ignores these mode bits.
  it.skipIf(process.platform === "win32")(
    "removes a part-way copy and keeps the source when copying fails",
    () => {
      const root = temp();
      const source = NodePath.join(root, "scratch", "probe");
      const archive = NodePath.join(root, "archive");
      NodeFS.mkdirSync(source, { recursive: true });
      NodeFS.mkdirSync(archive);
      NodeFS.writeFileSync(NodePath.join(source, "readable.log"), "kept");
      const locked = NodePath.join(source, "locked");
      NodeFS.mkdirSync(locked);
      NodeFS.writeFileSync(NodePath.join(locked, "secret"), "");
      NodeFS.chmodSync(locked, 0o000);
      try {
        // Root can read anything, so the copy would succeed there.
        if (process.getuid?.() === 0) return;
        expect(() => archiveFolder(source, archive, crossVolume)).toThrow();
        expect(NodeFS.existsSync(NodePath.join(archive, "probe"))).toBe(false);
        expect(NodeFS.existsSync(NodePath.join(source, "readable.log"))).toBe(true);
      } finally {
        NodeFS.chmodSync(locked, 0o700);
      }
    },
  );

  // Windows ignores these mode bits.
  it.skipIf(process.platform === "win32")(
    "says so when the source is only partly removed after a full copy",
    () => {
      const root = temp();
      const source = NodePath.join(root, "scratch", "probe");
      const archive = NodePath.join(root, "archive");
      const sticky = NodePath.join(source, "sticky");
      NodeFS.mkdirSync(sticky, { recursive: true });
      NodeFS.mkdirSync(archive);
      NodeFS.writeFileSync(NodePath.join(sticky, "run.log"), "kept");
      // Readable, so it copies; not writable, so its entries cannot be removed.
      NodeFS.chmodSync(sticky, 0o500);
      try {
        if (process.getuid?.() === 0) return;
        let error: unknown;
        try {
          archiveFolder(source, archive, crossVolume);
        } catch (cause) {
          error = cause;
        }
        expect(error).toBeInstanceOf(SourcePartlyRemovedError);
        expect((error as SourcePartlyRemovedError).target).toBe(NodePath.join(archive, "probe"));
        expect(
          NodeFS.readFileSync(NodePath.join(archive, "probe", "sticky", "run.log"), "utf8"),
        ).toBe("kept");
      } finally {
        NodeFS.chmodSync(sticky, 0o700);
      }
    },
  );
});
