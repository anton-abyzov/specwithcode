import { describe, expect, it } from "vite-plus/test";

import type { FileClass } from "./classify.ts";
import type { ManifestEntry, RepositoryInfo } from "./manifest.ts";
import {
  planReady,
  planReconcile,
  repoRowId,
  type DestinationFile,
  type DestinationRepository,
  type PlanInput,
  type Relation,
} from "./reconcile.ts";

const A = "a".repeat(40);
const B = "b".repeat(40);
const C = "c".repeat(40);

const sourceRepo = (path: string, patch: Partial<RepositoryInfo> = {}): RepositoryInfo => ({
  path,
  kind: "main",
  head: A,
  branch: "main",
  branches: { main: A },
  stash: null,
  stashCount: 0,
  identity: `github.com/acme/${path === "." ? "umbrella" : path.split("/").at(-1)}`,
  origin: `https://github.com/acme/${path === "." ? "umbrella" : path.split("/").at(-1)}.git`,
  status: [],
  worktrees: [],
  mainRepository: null,
  ...patch,
});
const destinationRepo = (
  path: string,
  patch: Partial<DestinationRepository> = {},
): DestinationRepository => ({
  path,
  kind: "main",
  head: A,
  branch: "main",
  branches: { main: A },
  identity: `github.com/acme/${path === "." ? "umbrella" : path.split("/").at(-1)}`,
  status: [],
  ...patch,
});
const file = (path: string, sha: string, patch: Partial<ManifestEntry> = {}): ManifestEntry => ({
  path,
  type: "file",
  mode: 0o644,
  size: sha.length,
  mtimeMs: 1,
  class: "tracked",
  repo: ".",
  sha256: sha.padEnd(64, "0"),
  chunks: [sha.padEnd(64, "0")],
  ...patch,
});
const here = (
  path: string,
  sha: string,
  patch: Partial<DestinationFile> = {},
): DestinationFile => ({
  path,
  type: "file",
  size: sha.length,
  sha256: sha.padEnd(64, "0"),
  class: "tracked" as FileClass,
  repo: ".",
  ...patch,
});

const plan = (patch: Partial<PlanInput> & { relation?: Relation }) =>
  planReconcile({
    sourceMachine: "Anton's M4MAX",
    repositories: [sourceRepo(".")],
    entries: [],
    targetRoot: "/Users/me/Projects/umbrella",
    destination: { files: [], repositories: [destinationRepo(".")] },
    relations: { ".": patch.relation ?? "same" },
    caseInsensitive: false,
    ...patch,
  });
const row = (result: ReturnType<typeof plan>, id = repoRowId(".")) =>
  result.rows.find((item) => item.id === id)!;
const step = (result: ReturnType<typeof plan>, repo = ".") =>
  result.git.find((item) => item.repo === repo)!;

describe("repository matrix", () => {
  it("same HEAD, both clean: nothing to do", () => {
    const result = plan({
      entries: [file("README.md", "r1")],
      destination: { files: [here("README.md", "r1")], repositories: [destinationRepo(".")] },
    });
    expect(row(result)).toMatchObject({ status: "same", needsDecision: false, filesToMove: 0 });
    expect(step(result)).toMatchObject({ moveHead: "none", fetch: false });
    expect(result.actions).toEqual([]);
    expect(planReady(result)).toBe(true);
  });

  it("destination behind and clean: fast-forward with Git objects only", () => {
    const result = plan({
      relation: "destination-behind",
      repositories: [sourceRepo(".", { head: B, branches: { main: B } })],
      entries: [
        file(".git/objects/pack/p.pack", "pk", { class: "repository" }),
        file("README.md", "r2"),
      ],
      destination: { files: [here("README.md", "r1")], repositories: [destinationRepo(".")] },
    });
    expect(row(result)).toMatchObject({ status: "fast-forward", needsDecision: false });
    expect(step(result)).toMatchObject({
      moveHead: "fast-forward",
      fetch: true,
      stashDestination: false,
    });
    expect(result.actions.map((action) => [action.path, action.kind])).toEqual([
      [".git/objects/pack/p.pack", "stage"],
    ]);
  });

  it("destination ahead: kept, source branches imported under swc/from-<machine>", () => {
    const result = plan({
      relation: "destination-ahead",
      repositories: [sourceRepo(".", { head: B, branches: { main: B } })],
    });
    expect(row(result)).toMatchObject({ status: "ahead", needsDecision: false });
    expect(step(result)).toMatchObject({
      moveHead: "none",
      importBranches: true,
      importPrefix: "swc/from-Anton-s-M4MAX",
    });
  });

  it("diverged: needs a decision, and every choice keeps both histories", () => {
    const input = {
      relation: "diverged" as const,
      repositories: [sourceRepo(".", { head: B, branches: { main: B } })],
    };
    const undecided = plan(input);
    expect(row(undecided)).toMatchObject({
      status: "diverged",
      needsDecision: true,
      choices: ["keep-mine", "take-theirs", "leave-both"],
    });
    expect(planReady(undecided)).toBe(false);
    for (const choice of ["keep-mine", "leave-both", "take-theirs"] as const) {
      const decided = plan({ ...input, decisions: { [repoRowId(".")]: choice } });
      expect(planReady(decided)).toBe(true);
      expect(step(decided).importBranches).toBe(true);
      expect(step(decided).moveHead).toBe(choice === "take-theirs" ? "take-theirs" : "none");
    }
  });

  it("destination dirty and behind: leaves the worktree unless take theirs, which stashes first", () => {
    const input = {
      relation: "destination-behind" as const,
      repositories: [sourceRepo(".", { head: B, branches: { main: B } })],
      destination: { files: [], repositories: [destinationRepo(".", { status: [" M src/x.ts"] })] },
    };
    expect(row(plan(input))).toMatchObject({ status: "dirty", needsDecision: true });
    expect(step(plan({ ...input, decisions: { [repoRowId(".")]: "keep-mine" } }))).toMatchObject({
      moveHead: "none",
      stashDestination: false,
    });
    expect(step(plan({ ...input, decisions: { [repoRowId(".")]: "take-theirs" } }))).toMatchObject({
      moveHead: "fast-forward",
      stashDestination: true,
    });
  });

  it("both dirty, different files: source changes go on top without a question", () => {
    const result = plan({
      repositories: [sourceRepo(".", { status: [" M b.ts"] })],
      entries: [file("a.ts", "a1"), file("b.ts", "b2")],
      destination: {
        files: [here("a.ts", "a9"), here("b.ts", "b1")],
        repositories: [destinationRepo(".", { status: [" M a.ts"] })],
      },
    });
    expect(row(result).needsDecision).toBe(false);
    expect(result.actions).toEqual([
      expect.objectContaining({ path: "b.ts", kind: "write", replaces: true }),
    ]);
  });

  it("both dirty, same file differs: a per-file conflict", () => {
    const input = {
      repositories: [sourceRepo(".", { status: [" M a.ts"] })],
      entries: [file("a.ts", "a1")],
      destination: {
        files: [here("a.ts", "a9")],
        repositories: [destinationRepo(".", { status: [" M a.ts"] })],
      },
    };
    const undecided = plan(input);
    expect(row(undecided)).toMatchObject({ status: "conflict", needsDecision: true });
    expect(row(undecided).conflicts).toEqual([
      expect.objectContaining({
        path: "a.ts",
        choices: ["keep-mine", "take-theirs", "keep-both"],
        decision: null,
      }),
    ]);
    const both = plan({ ...input, decisions: { "file:a.ts": "keep-both" } });
    expect(both.actions).toEqual([
      expect.objectContaining({ kind: "keep-both", writePath: "a.ts.from-Anton-s-M4MAX" }),
    ]);
    expect(plan({ ...input, decisions: { "file:a.ts": "keep-mine" } }).actions).toEqual([]);
  });

  it("repository only on the source is copied whole; only on the destination is kept", () => {
    const result = plan({
      repositories: [sourceRepo("."), sourceRepo("repositories/svc-new")],
      entries: [
        file("repositories/svc-new/.git/HEAD", "h", {
          class: "repository",
          repo: "repositories/svc-new",
        }),
        file("repositories/svc-new/src/a.ts", "a", { repo: "repositories/svc-new" }),
      ],
      destination: {
        files: [],
        repositories: [destinationRepo("."), destinationRepo("repositories/svc-old")],
      },
    });
    expect(row(result, repoRowId("repositories/svc-new"))).toMatchObject({
      status: "new",
      filesToMove: 2,
      cloneAvailable: true,
    });
    expect(row(result, repoRowId("repositories/svc-old"))).toMatchObject({ status: "only-here" });
    expect(step(result, "repositories/svc-new").kind).toBe("copy");
  });

  it("clone from origin skips Git data and clean tracked files but keeps local work", () => {
    const result = plan({
      repositories: [sourceRepo("."), sourceRepo("svc", { status: ["?? notes.md"] })],
      entries: [
        file("svc/.git/HEAD", "h", { class: "repository", repo: "svc" }),
        file("svc/src/a.ts", "a", { repo: "svc" }),
        file("svc/notes.md", "n", { repo: "svc", class: "untracked" }),
      ],
      clone: [repoRowId("svc")],
    });
    expect(step(result, "svc").kind).toBe("clone");
    expect(result.actions.map((action) => action.path)).toEqual(["svc/notes.md"]);
  });

  it("a different repository at the same path is a conflict", () => {
    const result = plan({
      repositories: [sourceRepo("."), sourceRepo("svc")],
      destination: {
        files: [],
        repositories: [
          destinationRepo("."),
          destinationRepo("svc", { identity: "github.com/other/svc" }),
        ],
      },
    });
    expect(row(result, repoRowId("svc"))).toMatchObject({
      status: "conflict",
      needsDecision: true,
    });
  });
});

describe("files outside repositories", () => {
  const outside = (path: string, sha: string) =>
    file(path, sha, { repo: null, class: "untracked" });
  const outsideHere = (path: string, sha: string) =>
    here(path, sha, { repo: null, class: "untracked" });
  const base = { repositories: [] as Array<RepositoryInfo>, relations: {} };

  it("copies new files, keeps destination-only files, and asks when content differs", () => {
    const result = plan({
      ...base,
      entries: [outside("new.md", "n"), outside("same.md", "s"), outside("diff.md", "d1")],
      destination: {
        files: [
          outsideHere("same.md", "s"),
          outsideHere("diff.md", "d2"),
          outsideHere("mine.md", "m"),
        ],
        repositories: [],
      },
    });
    expect(result.actions.map((action) => action.path)).toEqual(["new.md"]);
    expect(row(result, "files")).toMatchObject({ status: "conflict", needsDecision: true });
    expect(row(result, "files").conflicts.map((conflict) => conflict.path)).toEqual(["diff.md"]);
  });

  it("mirror exactly moves destination-only files to the backup instead of deleting", () => {
    const result = plan({
      ...base,
      entries: [outside("a.md", "a")],
      destination: {
        files: [outsideHere("a.md", "a"), outsideHere("old.md", "o")],
        repositories: [],
      },
      mirror: true,
    });
    expect(result.actions).toEqual([
      expect.objectContaining({ path: "old.md", kind: "remove", replaces: true }),
    ]);
  });

  it("reuses bytes already on this machine", () => {
    const result = plan({
      ...base,
      entries: [outside("copy/big.bin", "bigbin")],
      destination: { files: [outsideHere("elsewhere/big.bin", "bigbin")], repositories: [] },
    });
    expect(result.actions[0]).toMatchObject({
      localSource: "/Users/me/Projects/umbrella/elsewhere/big.bin",
    });
    expect(result.totals).toMatchObject({ bytesToMove: 0, bytesPresent: 6 });
  });

  it("on a case-insensitive disk, names differing only by case land on one file", () => {
    const result = plan({
      ...base,
      caseInsensitive: true,
      entries: [outside("README.md", "r1"), outside("Readme.md", "r2")],
      destination: { files: [outsideHere("readme.MD", "r1")], repositories: [] },
    });
    expect(result.actions).toEqual([]);
    expect(result.warnings).toEqual([expect.stringContaining("differ only by case")]);
  });

  it("never overwrites files in an existing non-repository folder without a decision", () => {
    const result = plan({
      repositories: [sourceRepo(".")],
      entries: [file("README.md", "r1")],
      destination: {
        files: [here("README.md", "zz", { repo: null, class: "untracked" })],
        repositories: [],
      },
    });
    expect(row(result)).toMatchObject({ status: "new", needsDecision: true });
    expect(result.actions).toEqual([]);
  });

  it("a folder of other files where a repository would go needs a decision", () => {
    const result = plan({
      repositories: [sourceRepo("."), sourceRepo("svc")],
      entries: [file("svc/a.ts", "a", { repo: "svc" })],
      destination: {
        files: [here("svc/other.txt", "o", { repo: ".", class: "untracked" })],
        repositories: [destinationRepo(".")],
      },
    });
    expect(row(result, repoRowId("svc"))).toMatchObject({
      status: "conflict",
      needsDecision: true,
    });
    const replaced = plan({
      repositories: [sourceRepo("."), sourceRepo("svc")],
      entries: [file("svc/a.ts", "a", { repo: "svc" })],
      destination: {
        files: [here("svc/other.txt", "o", { repo: ".", class: "untracked" })],
        repositories: [destinationRepo(".")],
      },
      decisions: { [repoRowId("svc")]: "take-theirs" },
    });
    expect(step(replaced, "svc").kind).toBe("replace");
    expect(replaced.actions.map((action) => action.path)).toEqual(["svc/a.ts"]);
  });
});
