// @effect-diagnostics nodeBuiltinImport:off globalDate:off - disposable real Git fixtures, and a fixed time for a branch name.
/**
 * Sync extras, review round 5 (1390): refs a send did not write are never
 * removed (R5-06), "only here" goes by the local branch's own name (R5-08), a
 * fetch row is proof only for the checkout it was read in (R5-09), and a read
 * that failed is unread, never a zero or an empty list (R5-10).
 */
import * as NodePath from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";

import {
  PROJECT_SYNC_EXTRAS_UNREAD_DETAIL,
  type ProjectSyncStep,
} from "@specweave-studio/contracts";

import { knownCommits } from "../handoff/bundleGit.ts";
import { refComponent } from "../handoff/checkpointGit.ts";
import { landExtra } from "../handoff/ExtrasReceiver.ts";
import {
  cleanUp,
  commit,
  git,
  isolateGit,
  restoreGit,
  twoMachines,
  write,
} from "../handoff/extrasTestKit.ts";
import * as Extras from "./ProjectSyncExtras.ts";
import type { Row } from "./projectSyncRecord.ts";

/** Lets a test change what one Git command answered, as if Git had said it. */
const answer = vi.hoisted(() => ({
  change: null as
    | ((
        args: ReadonlyArray<string>,
        real: { readonly code: number; readonly stdout: string; readonly stderr: string },
      ) => { readonly code: number; readonly stdout: string; readonly stderr: string })
    | null,
}));

vi.mock("./folderTransfer/git.ts", async (importOriginal) => {
  const kit = await import("../handoff/extrasTestKit.ts");
  const actual = await importOriginal<typeof import("./folderTransfer/git.ts")>();
  const recorded = kit.recordingGit(actual);
  const runGit: typeof actual.runGit = async (cwd, args, options) => {
    const real = await recorded.runGit(cwd, args, { ...options, allowFailure: true });
    const said = answer.change === null ? real : answer.change(args, real);
    if (said.code !== 0 && options?.allowFailure !== true)
      throw new actual.FolderGitError(args, said.code, said.stderr);
    return said;
  };
  const module: typeof actual = {
    ...recorded,
    runGit,
    gitText: async (cwd, args) => (await runGit(cwd, args)).stdout.trim(),
    gitList: async (cwd, args) => (await runGit(cwd, args)).stdout.split("\0").filter(Boolean),
  };
  return module;
});

beforeAll(isolateGit);
afterAll(restoreGit);
afterEach(() => {
  answer.change = null;
  cleanUp();
});

const OPERATION = "0a1b2c3d-1111-4222-8333-444455556666";
const NOW = new Date(2026, 10, 18, 9, 5, 7);
const HIDDEN = `refs/specwithcode/extras/${refComponent(OPERATION)}/0`;
const failed = { code: 128, stdout: "", stderr: "fatal: could not read" };

const peerOn = (destination: string): Extras.ExtrasPeer => ({
  negotiate: (candidates) => knownCommits(destination, candidates),
  replicate: (meta, bundle) =>
    landExtra({
      root: destination,
      bundle,
      commit: meta.commit,
      sourceLabel: "M4",
      leaf: meta.leaf,
      operationId: OPERATION,
    }),
});

const send = (
  source: string,
  item: Parameters<typeof Extras.sendExtra>[0]["item"],
  peer: Extras.ExtrasPeer,
) =>
  Extras.sendExtra({
    repository: { path: ".", cwd: source },
    item,
    operationId: OPERATION,
    index: 0,
    sourceLabel: "M4",
    now: NOW,
    peer,
  });

/** The row a fetch of `remote` would have written in `cwd`: origin's branches at their commits now. */
function rowFor(cwd: string, remote: string, change: Partial<Row> = {}): Row {
  const originHeads = new Map<string, string>();
  for (const line of git(cwd, "ls-remote", "--heads", remote).split("\n")) {
    const [oid, ref] = line.split("\t");
    if (oid !== undefined && ref !== undefined) originHeads.set(ref, oid);
  }
  return {
    path: ".",
    cwd,
    gitDir: git(cwd, "rev-parse", "--absolute-git-dir"),
    readable: true,
    branch: null,
    head: null,
    upstream: null,
    target: null,
    originHeads,
    ahead: 0,
    behind: 0,
    planned: {} as ProjectSyncStep,
    ...change,
  };
}

const refAt = (cwd: string, ref: string) => git(cwd, "for-each-ref", "--format=%(objectname)", ref);

describe("a send removes only the refs it wrote (R5-06)", () => {
  it("leaves a hidden ref of the same name another process holds, at its commit", async () => {
    const f = twoMachines();
    const theirs = git(f.a, "rev-parse", "HEAD");
    git(f.a, "update-ref", HIDDEN, theirs);
    commit(f.a, "app.ts", "export const a = 2;\n");
    const result = await send(f.a, { kind: "branch", path: ".", branch: "main" }, peerOn(f.b));
    expect(refAt(f.a, HIDDEN)).toBe(theirs);
    // The send's own ref is in a private repository (R8-01): the name in this one is not its.
    expect(result).toMatchObject({ status: "sent" });
  });

  it("writes and removes nothing for a branch that is gone", async () => {
    const f = twoMachines();
    const theirs = git(f.a, "rev-parse", "HEAD");
    git(f.a, "update-ref", HIDDEN, theirs);
    const result = await send(f.a, { kind: "branch", path: ".", branch: "gone" }, peerOn(f.b));
    expect(result).toMatchObject({ status: "stays", stays: "missing-branch" });
    expect(refAt(f.a, HIDDEN)).toBe(theirs);
  });

  it("leaves a snapshot ref of the same name another process holds", async () => {
    const f = twoMachines();
    const theirs = git(f.a, "rev-parse", "HEAD");
    git(f.a, "update-ref", HIDDEN, theirs);
    write(f.a, "app.ts", "export const a = 'edited';\n");
    const result = await send(f.a, { kind: "uncommitted", path: ".", sendAnyway: [] }, peerOn(f.b));
    expect(refAt(f.a, HIDDEN)).toBe(theirs);
    expect(result).toMatchObject({ status: "sent" });
  });

  it("removes its own ref once the branch is sent", async () => {
    const f = twoMachines();
    commit(f.a, "app.ts", "export const a = 2;\n");
    const result = await send(f.a, { kind: "branch", path: ".", branch: "main" }, peerOn(f.b));
    expect(result).toMatchObject({ status: "sent" });
    expect(refAt(f.a, HIDDEN)).toBe("");
  });
});

describe("only here goes by the local branch's own name (R5-08)", () => {
  it("does not list `work` tracking origin/release when origin has `work` and no `release`", async () => {
    const f = twoMachines();
    git(f.a, "checkout", "-q", "-b", "work");
    commit(f.a, "work.ts", "export const work = 1;\n");
    git(f.a, "push", "-q", "origin", "work");
    const own = commit(f.a, "work.ts", "export const work = 2;\n");
    git(f.a, "config", "branch.work.remote", "origin");
    git(f.a, "config", "branch.work.merge", "refs/heads/release");
    const extras = await Extras.inventoryRepository({ path: ".", cwd: f.a }, rowFor(f.a, f.remote));
    expect(extras.onlyHere).toEqual([]);
    expect(extras.notPushed).toEqual([{ branch: "work", head: own, commits: 1 }]);
  });

  it("lists a local-only branch level with a differently named live upstream", async () => {
    const f = twoMachines();
    git(f.a, "branch", "-q", "--track", "level", "origin/main");
    const extras = await Extras.inventoryRepository({ path: ".", cwd: f.a }, rowFor(f.a, f.remote));
    expect(extras.onlyHere.map((entry) => `${entry.branch} ${entry.commits}`)).toEqual(["level 0"]);
  });
});

describe("a fetch row is proof only where it was read (R5-09)", () => {
  it("takes an unread row for no proof, however many branches it lists", async () => {
    const f = twoMachines();
    git(f.a, "branch", "-q", "local-only", "main");
    const extras = await Extras.inventoryRepository(
      { path: ".", cwd: f.a },
      rowFor(f.a, f.remote, { readable: false }),
    );
    expect(extras.onlyHere).toEqual([]);
    expect(extras.onlyHereUnknown).toBe(true);
  });

  it("takes a row read in another folder for no proof", async () => {
    const f = twoMachines();
    git(f.a, "branch", "-q", "local-only", "main");
    const extras = await Extras.inventoryRepository(
      { path: ".", cwd: f.a },
      rowFor(f.a, f.remote, { cwd: f.b, gitDir: NodePath.join(f.b, ".git") }),
    );
    expect(extras.onlyHere).toEqual([]);
    expect(extras.onlyHereUnknown).toBe(true);
  });
});

describe("a read that failed is unread (R5-10)", () => {
  it("a changed-file list Git could not give is unread, not no file left out", async () => {
    const f = twoMachines();
    write(f.a, ".env", "API_KEY=abc\n");
    git(f.a, "add", "-f", ".env");
    git(f.a, "commit", "-q", "-m", "env");
    write(f.a, ".env", "API_KEY=changed\n");
    answer.change = (args, real) => (args[0] === "diff" && args.includes("HEAD") ? failed : real);
    const extras = await Extras.inventoryRepository({ path: ".", cwd: f.a }, rowFor(f.a, f.remote));
    expect(extras.unreadDetail).toBe(PROJECT_SYNC_EXTRAS_UNREAD_DETAIL);
  });

  it("untracked files Git could not list make the checkout unread, not a failed inventory", async () => {
    const f = twoMachines();
    answer.change = (args, real) =>
      args[0] === "ls-files" && args.includes("--others") && !args.includes("--ignored")
        ? failed
        : real;
    const extras = await Extras.inventoryRepository({ path: ".", cwd: f.a }).catch(() => null);
    expect(extras?.unreadDetail).toBe(PROJECT_SYNC_EXTRAS_UNREAD_DETAIL);
  });

  it("one checkout Git could not list is unread beside a readable sibling", async () => {
    const f = twoMachines();
    commit(f.b, "app.ts", "export const a = 'b';\n");
    answer.change = (args, real) =>
      args[0] === "ls-files" && args.includes("--others") && !args.includes("--ignored")
        ? failed
        : real;
    let calls = 0;
    const listed = await Extras.inventoryAll(
      [
        { path: ".", cwd: f.a },
        { path: "other", cwd: f.b },
      ],
      () => {
        calls += 1;
        // Only the first checkout's untracked files cannot be listed.
        if (calls === 2) answer.change = null;
        return undefined;
      },
    );
    expect(listed.map((entry) => entry.unreadDetail ?? "read")).toEqual([
      PROJECT_SYNC_EXTRAS_UNREAD_DETAIL,
      "read",
    ]);
    expect(listed[1]!.notPushed.map((entry) => entry.commits)).toEqual([1]);
  });

  it("without a fetch, a tracking ref Git could not read is unread, not absent", async () => {
    const f = twoMachines();
    git(f.a, "checkout", "-q", "-b", "work");
    commit(f.a, "work.ts", "export const work = 1;\n");
    answer.change = (args, real) =>
      args.some((arg) => arg.startsWith("refs/remotes/origin/work")) ? failed : real;
    const extras = await Extras.inventoryRepository({ path: ".", cwd: f.a });
    expect(extras.unreadDetail).toBe(PROJECT_SYNC_EXTRAS_UNREAD_DETAIL);
  });

  it("a count of the commits sent with uncommitted work that failed is unknown, not 0", async () => {
    const f = twoMachines();
    commit(f.a, "app.ts", "export const a = 2;\n");
    write(f.a, "app.ts", "export const a = 'edited';\n");
    answer.change = (args, real) =>
      args[0] === "rev-list" && args.includes("--remotes=origin") ? failed : real;
    const result = await send(f.a, { kind: "uncommitted", path: ".", sendAnyway: [] }, peerOn(f.b));
    expect(result.status).toBe("sent");
    expect(result.includedCommitsUnknown).toBe(true);
    // The wire keeps its number; the flag says it is no count.
    expect(result.includedCommits).toBe(0);
  });
});
