// @effect-diagnostics nodeBuiltinImport:off globalDate:off - disposable real Git fixtures, and a fixed time for a branch name.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";

import { knownCommits } from "../handoff/bundleGit.ts";
import { landExtra } from "../handoff/ExtrasReceiver.ts";
import {
  allRefs,
  branches,
  cleanUp,
  commit,
  fakeToken,
  filesOf,
  git,
  gitCommandsNotAllowed,
  isolateGit,
  recordedGit,
  restoreGit,
  snapshot,
  twoMachines,
  write,
} from "../handoff/extrasTestKit.ts";
import {
  type ExtrasPeer,
  ExtrasPeerFailure,
  inventoryRepository,
  sendExtra,
  snapshotLeaf,
  sweepStaleExtraRefs,
} from "./ProjectSyncExtras.ts";

vi.mock("./folderTransfer/git.ts", async (importOriginal) => {
  const kit = await import("../handoff/extrasTestKit.ts");
  return kit.recordingGit(await importOriginal<typeof import("./folderTransfer/git.ts")>());
});

beforeAll(isolateGit);
afterAll(restoreGit);
afterEach(cleanUp);

const OPERATION = "0a1b2c3d-1111-4222-8333-444455556666";
const NOW = new Date(2026, 10, 18, 9, 5, 7);

/** The other machine's server, standing on its real repository: what the peer route does there. */
function peerOn(destination: string) {
  const sent: Array<{ leaf: string; bytes: number }> = [];
  const peer: ExtrasPeer = {
    negotiate: (candidates) => knownCommits(destination, candidates),
    replicate: async (meta, bundle) => {
      sent.push({ leaf: meta.leaf, bytes: bundle?.byteLength ?? 0 });
      return landExtra({
        root: destination,
        bundle,
        commit: meta.commit,
        sourceLabel: "M4",
        leaf: meta.leaf,
        operationId: OPERATION,
      });
    },
  };
  return { peer, sent };
}

const send = (
  source: string,
  item: Parameters<typeof sendExtra>[0]["item"],
  peer: ExtrasPeer,
  limits?: Parameters<typeof sendExtra>[0]["limits"],
) =>
  sendExtra({
    repository: { path: ".", cwd: source },
    item,
    operationId: OPERATION,
    index: 0,
    sourceLabel: "M4",
    now: NOW,
    peer,
    ...(limits === undefined ? {} : { limits }),
  });

describe("what Git does not carry (1390 AC-12)", () => {
  it("lists commits not pushed per branch, branches only here, files, stashes and files left out", async () => {
    const f = twoMachines();
    commit(f.a, "app.ts", "export const a = 2;\n");
    commit(f.a, "app.ts", "export const a = 3;\n");
    git(f.a, "checkout", "-q", "-b", "pushed");
    git(f.a, "push", "-q", "-u", "origin", "pushed");
    git(f.a, "checkout", "-q", "-b", "local-only");
    commit(f.a, "local.ts", "export const local = 1;\n");
    git(f.a, "checkout", "-q", "main");
    // A branch that arrived from another machine is that machine's work.
    git(f.a, "branch", "swc/from-M5/feature");
    write(f.a, "app.ts", "export const a = 'edited';\n");
    git(f.a, "stash", "push", "-q");
    write(f.a, "app.ts", "export const a = 'edited again';\n");
    write(f.a, "new.txt", "new\n");
    write(f.a, "notes.txt", `key ${fakeToken()}\n`);
    write(f.a, ".env", "API_KEY=abc\n");
    // A secret Git ignores is listed too: only the sealed route can bring it.
    git(f.a, "config", "core.excludesFile", NodePath.join(f.base, "excludes"));
    write(f.base, "excludes", ".env.local\n");
    write(f.a, ".env.local", "API_KEY=local\n");
    const before = snapshot(f.a);
    const refs = allRefs(f.a);
    const extras = await inventoryRepository({ path: ".", cwd: f.a });
    expect(extras.notPushed.map((entry) => `${entry.branch} ${entry.commits}`)).toEqual(["main 2"]);
    expect(extras.onlyHere.map((entry) => `${entry.branch} ${entry.commits}`)).toEqual([
      "local-only 1",
    ]);
    expect(extras).toMatchObject({
      path: ".",
      changedFiles: 1,
      untrackedFiles: 3,
      stashes: 1,
      branchesNotListed: 0,
      leftOutNotListed: 0,
    });
    expect(extras.leftOut.map((file) => `${file.path} ${file.reason} ${file.kind}`)).toEqual([
      ".env name null",
      ".env.local name null",
      "notes.txt content GitHub token",
    ]);
    expect(extras.leftOut.every((file) => typeof file.modifiedAtMs === "number")).toBe(true);
    // Reading changes nothing: no ref, no index entry, no file.
    expect(snapshot(f.a)).toEqual(before);
    expect(allRefs(f.a)).toBe(refs);
  });

  it("lists nothing for a clean, pushed repository", async () => {
    const f = twoMachines();
    expect(await inventoryRepository({ path: ".", cwd: f.b })).toEqual({
      path: ".",
      notPushed: [],
      onlyHere: [],
      branchesNotListed: 0,
      changedFiles: 0,
      untrackedFiles: 0,
      stashes: 0,
      leftOut: [],
      leftOutNotListed: 0,
    });
  });
});

describe("sending extras to the other machine (1390 AC-13)", () => {
  it("sends commits not pushed as one bundle that leaves out what the other machine holds", async () => {
    const f = twoMachines();
    const tip = commit(f.a, "app.ts", "export const a = 2;\n");
    const source = snapshot(f.a);
    const sourceRefs = allRefs(f.a);
    const destination = snapshot(f.b);
    const remote = allRefs(f.remote);
    const { peer, sent } = peerOn(f.b);
    const result = await send(f.a, { kind: "branch", path: ".", branch: "main" }, peer);
    expect(result).toMatchObject({
      kind: "branch",
      branch: "main",
      status: "sent",
      arrivedAs: "swc/from-M4/main",
      landed: "created",
      stays: null,
    });
    expect(result.bytes).toBeGreaterThan(0);
    expect(sent).toEqual([{ leaf: "main", bytes: result.bytes }]);
    expect(git(f.b, "rev-parse", "refs/heads/swc/from-M4/main")).toBe(tip);
    // The bundle held one commit, not the history the other machine already has.
    expect(git(f.b, "rev-list", "--count", "swc/from-M4/main", "^origin/main")).toBe("1");
    // Nothing changed on the source (its hidden ref is gone), in the other
    // machine's working folder, or on the remote.
    expect(snapshot(f.a)).toEqual(source);
    expect(allRefs(f.a)).toBe(sourceRefs);
    expect(snapshot(f.b)).toEqual(destination);
    expect(allRefs(f.remote)).toBe(remote);
  });

  it("sends a branch that exists only here, whole when the other machine holds none of it", async () => {
    const f = twoMachines();
    git(f.a, "checkout", "-q", "--orphan", "island");
    git(f.a, "rm", "-rq", "--cached", ".");
    const tip = commit(f.a, "island.ts", "export const island = 1;\n");
    const { peer } = peerOn(f.b);
    const result = await send(f.a, { kind: "branch", path: ".", branch: "island" }, peer);
    expect(result).toMatchObject({ status: "sent", arrivedAs: "swc/from-M4/island" });
    expect(git(f.b, "rev-parse", "refs/heads/swc/from-M4/island")).toBe(tip);
  });

  it("sends no bundle when the other machine already holds the branch's head", async () => {
    const f = twoMachines();
    const { peer, sent } = peerOn(f.b);
    const result = await send(f.a, { kind: "branch", path: ".", branch: "main" }, peer);
    expect(result).toMatchObject({ status: "sent", arrivedAs: "swc/from-M4/main", bytes: 0 });
    expect(sent).toEqual([{ leaf: "main", bytes: 0 }]);
  });

  it("sends uncommitted work as one snapshot commit on its own branch", async () => {
    const f = twoMachines();
    write(f.a, "app.ts", "export const a = 'edited';\n");
    write(f.a, "new.txt", "new\n");
    write(f.a, "notes.txt", `key ${fakeToken()}\n`);
    write(f.a, ".env", "API_KEY=abc\n");
    git(f.a, "add", "--", "new.txt");
    const source = snapshot(f.a);
    const sourceRefs = allRefs(f.a);
    const destination = snapshot(f.b);
    const { peer } = peerOn(f.b);
    const result = await send(f.a, { kind: "uncommitted", path: ".", sendAnyway: [] }, peer);
    const name = "swc/from-M4/uncommitted-20261118-090507-0a1b2c";
    expect(snapshotLeaf(NOW, OPERATION)).toBe("uncommitted-20261118-090507-0a1b2c");
    expect(result).toMatchObject({
      kind: "uncommitted",
      status: "sent",
      arrivedAs: name,
      landed: "created",
      includedCommits: 0,
      includedBranch: null,
    });
    expect(result.leftOut.map((file) => `${file.path} ${file.reason}`)).toEqual([
      ".env name",
      "notes.txt content",
    ]);
    // One commit, whose parent is the source's HEAD, holding the work without the files left out.
    expect(git(f.b, "rev-parse", `${name}^`)).toBe(source.head);
    expect(git(f.b, "show", `${name}:app.ts`)).toBe("export const a = 'edited';");
    expect(filesOf(f.b, name)).toEqual([".gitignore", "app.ts", "new.txt"]);
    // The source's branch, index and working tree are unchanged; so is the other machine's folder.
    expect(snapshot(f.a)).toEqual(source);
    expect(allRefs(f.a)).toBe(sourceRefs);
    expect(snapshot(f.b)).toEqual(destination);
    expect(NodeFS.existsSync(NodePath.join(f.b, "new.txt"))).toBe(false);
  });

  it("carries commits not pushed in the same bundle as the uncommitted work on top of them", async () => {
    const f = twoMachines();
    commit(f.a, "app.ts", "export const a = 2;\n");
    const head = commit(f.a, "app.ts", "export const a = 3;\n");
    write(f.a, "app.ts", "export const a = 'edited';\n");
    const { peer, sent } = peerOn(f.b);
    const result = await send(f.a, { kind: "uncommitted", path: ".", sendAnyway: [] }, peer);
    expect(result).toMatchObject({ status: "sent", includedCommits: 2, includedBranch: "main" });
    expect(sent).toHaveLength(1);
    expect(git(f.b, "rev-parse", `${result.arrivedAs}^`)).toBe(head);
    expect(git(f.b, "rev-list", "--count", result.arrivedAs!, "^origin/main")).toBe("3");
  });

  it("sends a flagged file anyway when its line was pressed", async () => {
    const f = twoMachines();
    write(f.a, "notes.txt", `key ${fakeToken()}\n`);
    write(f.a, ".env", "API_KEY=abc\n");
    const { peer } = peerOn(f.b);
    const result = await send(
      f.a,
      { kind: "uncommitted", path: ".", sendAnyway: ["notes.txt", ".env"] },
      peer,
    );
    expect(filesOf(f.b, result.arrivedAs!)).toContain("notes.txt");
    // A secret by name travels only sealed, never in a snapshot.
    expect(filesOf(f.b, result.arrivedAs!)).not.toContain(".env");
    expect(result.leftOut.map((file) => file.path)).toEqual([".env"]);
  });

  it("stays when there is nothing to send, or the branch is gone", async () => {
    const f = twoMachines();
    write(f.a, ".env", "API_KEY=abc\n");
    const { peer, sent } = peerOn(f.b);
    expect(await send(f.a, { kind: "uncommitted", path: ".", sendAnyway: [] }, peer)).toMatchObject(
      { status: "stays", stays: "nothing-to-send", arrivedAs: null },
    );
    expect(await send(f.a, { kind: "branch", path: ".", branch: "gone" }, peer)).toMatchObject({
      status: "stays",
      stays: "missing-branch",
    });
    expect(sent).toEqual([]);
    expect(branches(f.b).some((line) => line.startsWith("swc/from-"))).toBe(false);
  });
});

describe("limits, measured on what would travel (1390 AC-34)", () => {
  it("keeps a branch with a file over the limit, naming the file", async () => {
    const f = twoMachines();
    write(f.a, "assets/big.bin", NodeCrypto.randomBytes(300 * 1024));
    git(f.a, "add", "--", "assets/big.bin");
    git(f.a, "commit", "-q", "-m", "big");
    const { peer, sent } = peerOn(f.b);
    const result = await send(f.a, { kind: "branch", path: ".", branch: "main" }, peer, {
      maxFileBytes: 200 * 1024,
    });
    expect(result).toMatchObject({ status: "stays", stays: "file-too-large" });
    expect(result.detail).toContain("assets/big.bin");
    expect(sent).toEqual([]);
    // Under the limit it travels.
    expect(
      await send(f.a, { kind: "branch", path: ".", branch: "main" }, peer, {
        maxFileBytes: 400 * 1024,
      }),
    ).toMatchObject({ status: "sent" });
  });

  it("keeps a branch whose commits touch more files than the limit, with the count", async () => {
    const f = twoMachines();
    for (const name of ["one.ts", "two.ts", "three.ts"]) commit(f.a, name, `// ${name}\n`);
    const { peer, sent } = peerOn(f.b);
    const result = await send(f.a, { kind: "branch", path: ".", branch: "main" }, peer, {
      maxFiles: 2,
    });
    expect(result).toMatchObject({ status: "stays", stays: "too-many-files" });
    expect(result.detail).toMatch(/^3 files/);
    expect(sent).toEqual([]);
  });

  it("keeps an extra whose bundle is over the limit", async () => {
    const f = twoMachines();
    write(f.a, "data.bin", NodeCrypto.randomBytes(300 * 1024));
    git(f.a, "add", "--", "data.bin");
    git(f.a, "commit", "-q", "-m", "data");
    const { peer, sent } = peerOn(f.b);
    const result = await send(f.a, { kind: "branch", path: ".", branch: "main" }, peer, {
      maxBundleBytes: 100 * 1024,
    });
    expect(result).toMatchObject({ status: "stays", stays: "bundle-too-large" });
    expect(sent).toEqual([]);
    expect(allRefs(f.a)).not.toContain("refs/specwithcode/extras/");
  });

  it("keeps uncommitted work with a file over 10 MB, naming the file", async () => {
    const f = twoMachines();
    write(f.a, "dump.sql", Buffer.alloc(10 * 1024 * 1024 + 1, 97));
    write(f.a, "small.txt", "small\n");
    const { peer, sent } = peerOn(f.b);
    const result = await send(f.a, { kind: "uncommitted", path: ".", sendAnyway: [] }, peer);
    expect(result).toMatchObject({ status: "stays", stays: "file-too-large" });
    expect(result.detail).toContain("dump.sql");
    expect(sent).toEqual([]);
  });
});

describe("limits on uncommitted work (1390 AC-34)", () => {
  it("measures the commits that travel under the uncommitted work", async () => {
    const f = twoMachines();
    write(f.a, "logs/big.log", NodeCrypto.randomBytes(300 * 1024));
    git(f.a, "add", "--", "logs/big.log");
    git(f.a, "commit", "-q", "-m", "big");
    commit(f.a, "two.ts", "// two\n");
    write(f.a, "app.ts", "export const a = 'edited';\n");
    const { peer, sent } = peerOn(f.b);
    const item = { kind: "uncommitted", path: ".", sendAnyway: [] } as const;
    const large = await send(f.a, item, peer, { maxFileBytes: 200 * 1024 });
    expect(large).toMatchObject({ status: "stays", stays: "file-too-large" });
    expect(large.detail).toContain("logs/big.log");
    const many = await send(f.a, item, peer, { maxFiles: 2 });
    expect(many).toMatchObject({ status: "stays", stays: "too-many-files" });
    expect(many.detail).toMatch(/^3 files/);
    expect(sent).toEqual([]);
    expect(allRefs(f.a)).not.toContain("refs/specwithcode/extras/");
    expect(await send(f.a, item, peer, { maxFiles: 3 })).toMatchObject({ status: "sent" });
  });

  it("keeps uncommitted work over a limit however many nested checkouts come before it", async () => {
    const f = twoMachines();
    // More nested checkouts than the list of skipped folders holds.
    for (let index = 0; index < 205; index += 1)
      git(f.base, "init", "-q", NodePath.join(f.a, "deps", `d${String(index).padStart(3, "0")}`));
    write(f.a, "zz-model.bin", Buffer.alloc(10 * 1024 * 1024 + 1, 97));
    const { peer, sent } = peerOn(f.b);
    const result = await send(f.a, { kind: "uncommitted", path: ".", sendAnyway: [] }, peer);
    expect(result).toMatchObject({ status: "stays", stays: "file-too-large" });
    expect(result.detail).toContain("zz-model.bin");
    expect(sent).toEqual([]);
  });
});

describe("hidden refs of dead operations (P2-08)", () => {
  it("sweeps the refs a dead send left behind, and keeps those of a send under way", async () => {
    const f = twoMachines();
    const head = git(f.a, "rev-parse", "HEAD");
    git(f.a, "update-ref", "refs/specwithcode/extras/dead-op/0", head);
    git(f.a, "update-ref", "refs/specwithcode/extras/dead-op/1", head);
    git(f.a, "update-ref", "refs/specwithcode/extras/live-op/0", head);
    git(f.a, "update-ref", "refs/specwithcode/handoff/keep", head);
    const before = snapshot(f.a);
    await sweepStaleExtraRefs(f.a, new Set(["live-op"]));
    const refs = allRefs(f.a);
    expect(refs).not.toContain("refs/specwithcode/extras/dead-op/");
    expect(refs).toContain("refs/specwithcode/extras/live-op/0");
    expect(refs).toContain("refs/specwithcode/handoff/keep");
    expect(snapshot(f.a)).toEqual(before);
  });
});

describe("when the other machine does not take an extra", () => {
  const failing = (failure: ExtrasPeerFailure): ExtrasPeer => ({
    negotiate: async () => {
      throw failure;
    },
    replicate: async () => {
      throw failure;
    },
  });

  it("says a machine from before Sync needs an update, and leaves no ref behind", async () => {
    const f = twoMachines();
    commit(f.a, "app.ts", "export const a = 2;\n");
    const refs = allRefs(f.a);
    for (const [stays, message] of [
      ["needs-update", "M5 runs a SpecWithCode from before Sync."],
      ["refused", "M5: no work grant for App"],
      ["unreachable", "M5 did not answer."],
    ] as const) {
      const result = await send(
        f.a,
        { kind: "branch", path: ".", branch: "main" },
        failing(new ExtrasPeerFailure(stays, message)),
      );
      expect(result).toMatchObject({ status: "stays", stays, detail: message, arrivedAs: null });
    }
    expect(allRefs(f.a)).toBe(refs);
  });
});

describe("the Git commands the extras code runs", () => {
  // Runs last: every test above recorded what the code under test ran.
  it("runs only reads, private-index snapshots, hidden refs, bundles and arrival branches", () => {
    const commands = recordedGit();
    expect(commands.length).toBeGreaterThan(100);
    expect(gitCommandsNotAllowed()).toEqual([]);
    const verbs = new Set(commands.map((command) => command.args[0]));
    for (const verb of ["bundle", "update-ref", "fetch"]) expect(verbs.has(verb), verb).toBe(true);
  });
});
