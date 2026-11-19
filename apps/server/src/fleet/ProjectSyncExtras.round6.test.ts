// @effect-diagnostics nodeBuiltinImport:off globalDate:off - disposable real Git fixtures, and a fixed time for a branch name.
/**
 * Sync extras, review round 6 (1390, R6-03): a send removes its temporary
 * ref only in the repository it wrote it in, and only while that ref is still
 * a direct ref at the commit it wrote. A branch the name was pointed at, and a
 * ref of the same name in a repository the checkout was moved to, stay.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";

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

vi.mock("./folderTransfer/git.ts", async (importOriginal) => {
  const kit = await import("../handoff/extrasTestKit.ts");
  return kit.recordingGit(await importOriginal<typeof import("./folderTransfer/git.ts")>());
});

beforeAll(isolateGit);
afterAll(restoreGit);
afterEach(cleanUp);

const OPERATION = "0a1b2c3d-1111-4222-8333-444455556677";
const NOW = new Date(2026, 10, 19, 9, 5, 7);
const HIDDEN = `refs/specwithcode/extras/${refComponent(OPERATION)}/0`;

/** The other machine; `meanwhile` runs while the send waits for it, after the hidden ref exists. */
const peerOn = (
  destination: string,
  meanwhile: () => void = () => undefined,
): Extras.ExtrasPeer => ({
  negotiate: async (candidates) => {
    meanwhile();
    return knownCommits(destination, candidates);
  },
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

const refAt = (cwd: string, ref: string) => git(cwd, "for-each-ref", "--format=%(objectname)", ref);

describe("a send removes only its own direct ref, in its own repository (R6-03)", () => {
  it("a branch: the branch the hidden name was pointed at stays", async () => {
    const f = twoMachines();
    commit(f.a, "app.ts", "export const a = 2;\n");
    const tip = git(f.a, "rev-parse", "HEAD");
    git(f.a, "branch", "keep", tip);
    const result = await send(
      f.a,
      { kind: "branch", path: ".", branch: "main" },
      peerOn(f.b, () => git(f.a, "symbolic-ref", HIDDEN, "refs/heads/keep")),
    );
    expect(refAt(f.a, "refs/heads/keep")).toBe(tip);
    expect(git(f.a, "symbolic-ref", HIDDEN)).toBe("refs/heads/keep");
    expect(result.detail ?? "").toContain(HIDDEN);
  });

  it("a snapshot: the branch the hidden name was pointed at stays", async () => {
    const f = twoMachines();
    write(f.a, "app.ts", "export const a = 'edited';\n");
    const result = await send(
      f.a,
      { kind: "uncommitted", path: ".", sendAnyway: [] },
      peerOn(f.b, () => {
        git(f.a, "update-ref", "refs/heads/keep", git(f.a, "rev-parse", HIDDEN));
        git(f.a, "symbolic-ref", HIDDEN, "refs/heads/keep");
      }),
    );
    expect(refAt(f.a, "refs/heads/keep")).not.toBe("");
    expect(git(f.a, "symbolic-ref", HIDDEN)).toBe("refs/heads/keep");
    expect(result.detail ?? "").toContain(HIDDEN);
  });

  it("a checkout moved to another Git folder: that folder's ref of the same name stays", async () => {
    const f = twoMachines();
    commit(f.a, "app.ts", "export const a = 2;\n");
    const tip = git(f.a, "rev-parse", "HEAD");
    const first = NodePath.join(f.base, "a-git");
    const second = NodePath.join(f.base, "a-git-copy");
    NodeFS.renameSync(NodePath.join(f.a, ".git"), first);
    NodeFS.writeFileSync(NodePath.join(f.a, ".git"), `gitdir: ${first}\n`);
    const result = await send(
      f.a,
      { kind: "branch", path: ".", branch: "main" },
      peerOn(f.b, () => {
        // The copy has the hidden ref too, by the same name and at the same commit.
        NodeFS.cpSync(first, second, { recursive: true });
        NodeFS.writeFileSync(NodePath.join(f.a, ".git"), `gitdir: ${second}\n`);
      }),
    );
    expect(
      git(f.base, `--git-dir=${second}`, "for-each-ref", "--format=%(objectname)", HIDDEN),
    ).toBe(tip);
    // Its own ref, in the repository it wrote it in, is removed.
    expect(
      git(f.base, `--git-dir=${first}`, "for-each-ref", "--format=%(objectname)", HIDDEN),
    ).toBe("");
    // Nothing was sent from a repository the send did not start in.
    expect(result).toMatchObject({ status: "stays", stays: "failed" });
  });
});

describe("a repository replaced at the same path keeps its ref (R7-02)", () => {
  /** Puts a copy of the Git folder in its place: same path, same refs, another directory. */
  const replace = (cwd: string) => {
    const gitDir = NodePath.join(cwd, ".git");
    const copy = `${gitDir}-copy`;
    NodeFS.cpSync(gitDir, copy, { recursive: true });
    NodeFS.rmSync(gitDir, { recursive: true, force: true });
    NodeFS.renameSync(copy, gitDir);
  };

  it("a branch send", async () => {
    const f = twoMachines();
    commit(f.a, "app.ts", "export const a = 2;\n");
    const tip = git(f.a, "rev-parse", "HEAD");
    const result = await send(
      f.a,
      { kind: "branch", path: ".", branch: "main" },
      peerOn(f.b, () => replace(f.a)),
    );
    expect(refAt(f.a, HIDDEN)).toBe(tip);
    expect(result.detail ?? "").toContain("cleanup could not confirm ownership");
  });

  it("a snapshot send", async () => {
    const f = twoMachines();
    write(f.a, "app.ts", "export const a = 'edited';\n");
    let snapshot = "";
    const result = await send(
      f.a,
      { kind: "uncommitted", path: ".", sendAnyway: [] },
      peerOn(f.b, () => {
        snapshot = git(f.a, "rev-parse", HIDDEN);
        replace(f.a);
      }),
    );
    expect(snapshot).not.toBe("");
    expect(refAt(f.a, HIDDEN)).toBe(snapshot);
    expect(result.detail ?? "").toContain("cleanup could not confirm ownership");
  });
});

describe("a ref already gone is not said to be left (follow-up 2)", () => {
  it("another program removed the hidden ref: nothing is reported as left", async () => {
    const f = twoMachines();
    commit(f.a, "app.ts", "export const a = 2;\n");
    const result = await send(
      f.a,
      { kind: "branch", path: ".", branch: "main" },
      peerOn(f.b, () => git(f.a, "update-ref", "-d", HIDDEN)),
    );
    expect(refAt(f.a, HIDDEN)).toBe("");
    expect(result.detail ?? "").not.toContain("left in the repository");
    expect(result.detail ?? "").not.toContain("could not confirm ownership");
  });
});
