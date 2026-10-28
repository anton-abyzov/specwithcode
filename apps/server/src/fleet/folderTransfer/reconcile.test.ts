import { describe, expect, it } from "vite-plus/test";

import type { FileClass } from "./classify.ts";
import type { ManifestEntry, RepositoryInfo } from "./manifest.ts";
import {
  gitAccessWarning,
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
    // No question, but the clean b.ts here is overwritten: the row says so.
    expect(row(result)).toMatchObject({ status: "same", replacing: 1 });
    expect(result.totals).toMatchObject({ decisionsNeeded: 0, replacing: 1 });
  });

  it("an empty destination replaces nothing", () => {
    const result = plan({
      repositories: [sourceRepo(".", { status: [" M b.ts"] })],
      entries: [file("a.ts", "a1"), file("b.ts", "b2")],
      destination: { files: [], repositories: [] },
    });
    expect(result.rows.every((item) => item.replacing === 0)).toBe(true);
    expect(result.totals.replacing).toBe(0);
  });

  it("keep-both does not count as replacing; take-theirs and mirror removals do", () => {
    const input = {
      repositories: [sourceRepo(".", { status: [" M a.ts"] })],
      entries: [file("a.ts", "a1")],
      destination: {
        files: [here("a.ts", "a9")],
        repositories: [destinationRepo(".", { status: [" M a.ts"] })],
      },
    };
    expect(plan({ ...input, decisions: { "file:a.ts": "keep-both" } }).totals.replacing).toBe(0);
    expect(plan({ ...input, decisions: { "file:a.ts": "take-theirs" } }).totals.replacing).toBe(1);
    const mirrored = plan({
      repositories: [],
      relations: {},
      entries: [file("a.md", "a", { repo: null, class: "untracked" })],
      destination: {
        files: [
          here("a.md", "a", { repo: null, class: "untracked" }),
          here("old.md", "o", { repo: null, class: "untracked" }),
        ],
        repositories: [],
      },
      mirror: true,
    });
    expect(row(mirrored, "files").replacing).toBe(1);
    expect(mirrored.totals.replacing).toBe(1);
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

  it("a clone this machine cannot read is copied whole, and a readable one uses that address", () => {
    const result = plan({
      repositories: [sourceRepo("."), sourceRepo("svc"), sourceRepo("web")],
      entries: [
        file("svc/.git/HEAD", "h", { class: "repository", repo: "svc" }),
        file("svc/src/a.ts", "a", { repo: "svc" }),
        file("web/src/b.ts", "b", { repo: "web" }),
      ],
      clone: [repoRowId("svc"), repoRowId("web")],
      cloneOrigins: {
        [repoRowId("svc")]: null,
        [repoRowId("web")]: "https://github.com/acme/web.git",
      },
    });
    expect(row(result, repoRowId("svc"))).toMatchObject({ clone: false, cloneAvailable: false });
    expect(row(result, repoRowId("svc")).detail).toContain("cannot read its origin");
    expect(step(result, "svc").kind).toBe("copy");
    expect(step(result, "web")).toMatchObject({
      kind: "clone",
      origin: "https://github.com/acme/web.git",
    });
    expect(result.actions.map((action) => action.path).sort()).toEqual([
      "svc/.git/HEAD",
      "svc/src/a.ts",
    ]);
    expect(result.warnings).toContain(gitAccessWarning(["svc"]));
  });

  it("names every unreadable repository once, with how to sign in", () => {
    expect(gitAccessWarning(["the root repository", "a", "b", "c", "d", "e"])).toBe(
      "The destination machine cannot read the origins of the root repository, a, b, c and 2 more (no GitHub sign-in or SSH key there), so they are copied whole with their history instead of cloned. To clone next time, install the GitHub CLI on it and run gh auth login, then gh auth setup-git.",
    );
  });

  it("a skipped repository, its nested repositories and its worktrees copy nothing", () => {
    const result = plan({
      repositories: [
        sourceRepo("."),
        sourceRepo("repos/ec"),
        sourceRepo("repos/ec/vendor/lib"),
        sourceRepo("repos/ec-wt", { kind: "linked", mainRepository: "repos/ec" }),
        sourceRepo("repos/kept"),
      ],
      entries: [
        file("repos/ec", "", { type: "directory", repo: ".", class: "untracked" }),
        file("repos/ec/.git/HEAD", "h", { class: "repository", repo: "repos/ec" }),
        file("repos/ec/src/a.ts", "a", { repo: "repos/ec" }),
        file("repos/ec/.env", "e", { repo: "repos/ec", class: "secret" }),
        file("repos/ec/vendor/lib/b.ts", "b", { repo: "repos/ec/vendor/lib" }),
        file("repos/ec-wt/c.ts", "c", { repo: "repos/ec-wt" }),
        file("repos/kept/d.ts", "d", { repo: "repos/kept" }),
      ],
      destination: {
        files: [here("repos/ec/local.md", "l", { repo: null, class: "untracked" })],
        repositories: [destinationRepo(".")],
      },
      mirror: true,
      clone: [repoRowId("repos/ec")],
      skip: [repoRowId("repos/ec")],
    });
    for (const path of ["repos/ec", "repos/ec/vendor/lib", "repos/ec-wt"])
      expect(row(result, repoRowId(path))).toMatchObject({
        status: "skipped",
        filesToMove: 0,
        needsDecision: false,
      });
    expect(row(result, repoRowId("repos/ec"))).toMatchObject({ cloneAvailable: true, clone: true });
    expect(result.git.map((item) => item.repo).sort()).toEqual([".", "repos/kept"]);
    expect(result.actions.map((action) => action.path)).toEqual(["repos/kept/d.ts"]);
    expect(planReady(result)).toBe(true);
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

it("zero actions for an occupied nested path mean an unanswered repository choice, not empty source inventory", () => {
  const input = {
    repositories: [sourceRepo("."), sourceRepo("repos/app")],
    entries: [file("repos/app/notes.md", "source", { repo: "repos/app", class: "untracked" })],
    destination: {
      files: [here("repos/app/local.md", "destination", { repo: null, class: "untracked" })],
      repositories: [destinationRepo(".")],
    },
  };
  const unresolved = plan(input);
  expect(row(unresolved, repoRowId("repos/app"))).toMatchObject({
    filesToMove: 0,
    needsDecision: true,
    decision: null,
    status: "conflict",
    detail:
      "Files already occupy this path; the destination scan did not identify a repository here.",
  });
  expect(unresolved.actions).toEqual([]);
  expect(planReady(unresolved)).toBe(false);
  const take = plan({ ...input, decisions: { [repoRowId("repos/app")]: "take-theirs" } });
  expect(row(take, repoRowId("repos/app")).filesToMove).toBe(1);
  expect(take.actions.map((action) => action.path)).toContain("repos/app/notes.md");
  expect(step(take, "repos/app").kind).toBe("replace");
  const keep = plan({ ...input, decisions: { [repoRowId("repos/app")]: "keep-mine" } });
  expect(keep.actions).toEqual([]);
  expect(row(keep, repoRowId("repos/app")).decision).toBe("keep-mine");
});
