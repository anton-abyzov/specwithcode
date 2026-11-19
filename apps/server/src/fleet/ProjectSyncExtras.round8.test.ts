// @effect-diagnostics nodeBuiltinImport:off globalDate:off - disposable real Git fixtures, and a fixed time for a branch name.
/**
 * Sync extras, review round 8 (1390, R8-01): a send writes no ref in the
 * user's repository at all. Its objects go into the repository's own object
 * store; its temporary ref lives in a private repository of its own, which
 * reads those objects through `objects/info/alternates`, makes the bundle and
 * is removed afterwards. A repository put back at the same path at any point
 * of the send keeps every one of its refs, and the bundle still verifies on
 * the receiving side.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";

import { knownCommits } from "../handoff/bundleGit.ts";
import { refComponent } from "../handoff/checkpointGit.ts";
import { landExtra } from "../handoff/ExtrasReceiver.ts";
import {
  allRefs,
  cleanUp,
  commit,
  git,
  gitCommandsNotAllowed,
  gitHooks,
  isolateGit,
  type RecordedGit,
  recordedGit,
  restoreGit,
  twoMachines,
  write,
} from "../handoff/extrasTestKit.ts";
import * as Extras from "./ProjectSyncExtras.ts";

vi.mock("./folderTransfer/git.ts", async (importOriginal) => {
  const kit = await import("../handoff/extrasTestKit.ts");
  return kit.recordingGit(await importOriginal<typeof import("./folderTransfer/git.ts")>());
});

// Fixed dates: every fixture commit and every snapshot commit has the same id in each run.
const DATES = {
  GIT_AUTHOR_DATE: "2026-11-19T09:00:00Z",
  GIT_COMMITTER_DATE: "2026-11-19T09:00:00Z",
};
const savedDates: Record<string, string | undefined> = {};
beforeAll(() => {
  isolateGit();
  for (const [key, value] of Object.entries(DATES)) {
    savedDates[key] = process.env[key];
    process.env[key] = value;
  }
});
afterAll(() => {
  restoreGit();
  for (const key of Object.keys(DATES)) {
    if (savedDates[key] === undefined) delete process.env[key];
    else process.env[key] = savedDates[key];
  }
});
const restoreEnv: Array<() => void> = [];
afterEach(() => {
  for (const undo of restoreEnv.splice(0)) undo();
  cleanUp();
});
const setEnv = (key: string, value: string) => {
  const was = process.env[key];
  process.env[key] = value;
  restoreEnv.push(() => {
    if (was === undefined) delete process.env[key];
    else process.env[key] = was;
  });
};

const OPERATION = "0a1b2c3d-1111-4222-8333-444455556677";
const NOW = new Date(2026, 10, 19, 9, 5, 7);
const HIDDEN = `refs/specwithcode/extras/${refComponent(OPERATION)}/0`;

type Item = Parameters<typeof Extras.sendExtra>[0]["item"];
const branchItem: Item = { kind: "branch", path: ".", branch: "main" };
const snapshotItem: Item = { kind: "uncommitted", path: ".", sendAnyway: [] };

/** Machine A with work to send of `kind`: a commit not on origin, or an edited file. */
const withWork = (kind: "branch" | "uncommitted") => {
  const f = twoMachines();
  if (kind === "branch") commit(f.a, "app.ts", "export const a = 2;\n");
  else write(f.a, "app.ts", "export const a = 'edited';\n");
  return f;
};

/**
 * The other machine. `during` runs while the send waits for each answer;
 * `sent` gets the bundle and its commit. It lands the bundle unless `land` is false.
 */
const peerOn = (
  destination: string,
  options: {
    readonly during?: () => void;
    readonly sent?: (commit: string, bundle: Uint8Array | null) => void;
    readonly land?: boolean;
    readonly known?: (candidates: ReadonlyArray<string>) => Promise<ReadonlyArray<string>>;
  } = {},
): Extras.ExtrasPeer => ({
  negotiate: async (candidates) => {
    options.during?.();
    return (options.known ?? ((c) => knownCommits(destination, c)))(candidates);
  },
  replicate: async (meta, bundle) => {
    options.during?.();
    options.sent?.(meta.commit, bundle);
    if (options.land === false) return { branch: `swc/from-m4/${meta.leaf}`, landed: "created" };
    return landExtra({
      root: destination,
      bundle,
      commit: meta.commit,
      sourceLabel: "M4",
      leaf: meta.leaf,
      operationId: OPERATION,
    });
  },
});

const send = (source: string, item: Item, peer: Extras.ExtrasPeer) =>
  Extras.sendExtra({
    repository: { path: ".", cwd: source },
    item,
    operationId: OPERATION,
    index: 0,
    sourceLabel: "M4",
    now: NOW,
    peer,
  });

const kinds = [
  ["a branch send", "branch", branchItem],
  ["a snapshot send", "uncommitted", snapshotItem],
] as const;

describe("a send writes no ref in the user's repository (R8-01)", () => {
  for (const [name, kind, item] of kinds) {
    it(`${name}: no new ref while it runs or after it, and its own repository is removed`, async () => {
      const f = withWork(kind);
      const before = allRefs(f.a);
      const seen: Array<string> = [];
      const from = recordedGit().length;
      const result = await send(f.a, item, peerOn(f.b, { during: () => seen.push(allRefs(f.a)) }));
      expect(result.status).toBe("sent");
      expect(seen).toEqual([before, before]);
      expect(allRefs(f.a)).toBe(before);
      expect(result.detail).toBeNull();
      // Every write of the send's own ref went to a Git folder that is not the user's, and
      // that folder is gone.
      const own = recordedGit()
        .slice(from)
        .filter((command) => command.args.includes(HIDDEN) && !command.cwd.startsWith(f.b));
      expect(own.length).toBeGreaterThan(0);
      for (const command of own) {
        expect(command.gitDir).not.toBeNull();
        expect(command.gitDir!.startsWith(f.base)).toBe(false);
        expect(NodeFS.existsSync(command.gitDir!)).toBe(false);
      }
      expect(gitCommandsNotAllowed()).toEqual([]);
    });
  }

  it("a send that stays: no new ref either", async () => {
    const f = withWork("branch");
    const before = allRefs(f.a);
    const seen: Array<string> = [];
    const result = await Extras.sendExtra({
      repository: { path: ".", cwd: f.a },
      item: branchItem,
      operationId: OPERATION,
      index: 0,
      sourceLabel: "M4",
      now: NOW,
      peer: peerOn(f.b, { during: () => seen.push(allRefs(f.a)) }),
      limits: { maxBundleBytes: 1 },
    });
    expect(result).toMatchObject({ status: "stays", stays: "bundle-too-large" });
    expect(seen).toEqual([before]);
    expect(allRefs(f.a)).toBe(before);
  });
});

describe("a repository put back at the same path keeps every ref (R8-01)", () => {
  /**
   * Puts a copy of A's Git folder in its place, with `HIDDEN` planted at `oid`
   * (or at HEAD while `oid` is not there yet), and returns the copy's refs.
   */
  const replace = (cwd: string, oid: string) => {
    const gitDir = NodePath.join(cwd, ".git");
    const copy = `${gitDir}-copy`;
    NodeFS.cpSync(gitDir, copy, { recursive: true });
    NodeFS.rmSync(gitDir, { recursive: true, force: true });
    NodeFS.renameSync(copy, gitDir);
    let there = true;
    try {
      git(cwd, "cat-file", "-e", `${oid}^{commit}`);
    } catch {
      there = false;
    }
    git(cwd, "update-ref", HIDDEN, there ? oid : git(cwd, "rev-parse", "HEAD"));
    return allRefs(cwd);
  };
  const sourceSide = (command: RecordedGit, destination: string) =>
    !command.cwd.startsWith(destination);

  for (const [name, kind, item] of kinds) {
    it(`${name}: replaced before each of the send's Git commands in turn`, async () => {
      // The commit this send sends, the same in every run (fixed dates).
      let sentCommit = "";
      {
        const f = withWork(kind);
        await send(f.a, item, peerOn(f.b, { sent: (oid) => (sentCommit = oid) }));
        cleanUp();
      }
      expect(sentCommit).not.toBe("");
      const lost: Array<string> = [];
      for (let point = 0; ; point += 1) {
        const f = withWork(kind);
        let index = 0;
        let kept: string | null = null;
        let at = "";
        gitHooks.before = (command) => {
          if (!sourceSide(command, f.b)) return;
          if (index++ !== point) return;
          at = command.args.join(" ");
          kept = replace(f.a, sentCommit);
        };
        await send(f.a, item, peerOn(f.b));
        gitHooks.before = null;
        if (kept === null) break;
        const now = allRefs(f.a);
        if (now !== kept) lost.push(`before \`${at}\`: ${kept} became ${now}`);
        cleanUp();
      }
      expect(lost).toEqual([]);
    }, 240_000);
  }
});

describe("the bundle still verifies on the receiving side (R8-01)", () => {
  const verified = async (
    kind: "branch" | "uncommitted",
    known?: (candidates: ReadonlyArray<string>) => Promise<ReadonlyArray<string>>,
  ) => {
    const f = withWork(kind);
    let bundle: Uint8Array | null = null;
    let sentCommit = "";
    const result = await send(
      f.a,
      kind === "branch" ? branchItem : snapshotItem,
      peerOn(f.b, {
        sent: (oid, bytes) => {
          sentCommit = oid;
          bundle = bytes;
        },
        ...(known === undefined ? {} : { known }),
      }),
    );
    expect(result.status).toBe("sent");
    expect(bundle).not.toBeNull();
    const file = NodePath.join(f.base, "sent.bundle");
    NodeFS.writeFileSync(file, bundle!);
    git(f.b, "bundle", "verify", "-q", file);
    expect(git(f.b, "bundle", "list-heads", file).split(" ")[0]).toBe(sentCommit);
    expect(git(f.b, "cat-file", "-t", sentCommit)).toBe("commit");
    return f;
  };

  for (const [name, kind] of kinds) {
    it(`${name}, to a machine that holds the base`, async () => {
      await verified(kind);
    });
    it(`${name}, to a machine that holds nothing: the whole history travels`, async () => {
      const f = await verified(kind, async () => []);
      expect(git(f.b, "rev-list", "--count", "HEAD")).not.toBe("0");
    });
  }

  it("from a shallow clone", async () => {
    const f = twoMachines();
    commit(f.a, "app.ts", "export const a = 2;\n");
    git(f.a, "push", "-q", "origin", "main");
    commit(f.a, "app.ts", "export const a = 3;\n");
    const shallow = NodePath.join(f.base, "shallow");
    git(f.base, "clone", "-q", "--depth=1", `file://${f.remote}`, shallow);
    write(shallow, "app.ts", "export const a = 'edited';\n");
    let bundle: Uint8Array | null = null;
    const result = await send(
      shallow,
      snapshotItem,
      peerOn(f.b, { sent: (_oid, bytes) => (bundle = bytes) }),
    );
    expect(result.status).toBe("sent");
    const file = NodePath.join(f.base, "sent.bundle");
    NodeFS.writeFileSync(file, bundle!);
    git(f.b, "bundle", "verify", "-q", file);
  });
});

describe("nothing in a send runs gc or prune (R8-01)", () => {
  for (const [name, kind, item] of kinds) {
    it(name, async () => {
      const f = withWork(kind);
      const trace = NodePath.join(f.base, "git.trace");
      setEnv("GIT_TRACE", trace);
      // The bundle is not landed here: the receiver's own fetch may run maintenance.
      const result = await send(f.a, item, peerOn(f.b, { land: false }));
      expect(result.status).toBe("sent");
      const text = NodeFS.existsSync(trace) ? NodeFS.readFileSync(trace, "utf8") : "";
      expect(text).toContain("trace:");
      expect(text).not.toMatch(/\bgit (gc|prune|repack|maintenance|prune-packed)\b/);
    });
  }
});
