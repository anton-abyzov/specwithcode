// @effect-diagnostics nodeBuiltinImport:off globalDate:off - disposable real Git fixtures, and a fixed time for a branch name.
/**
 * Sync extras, review round 9 (1390): a send's private repository lives in
 * Sync's own marked staging folder, carries a marker with a token only this
 * send knows, and is removed only while that marker still holds the token
 * (AC-11 exclusion 5 leaves a program that replaces that folder out of
 * scope). Every command in it runs with no inherited repository location,
 * a snapshot's objects are written into it from the start, and it is made
 * with the source's object format named explicitly.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
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

const restoreEnv: Array<() => void> = [];
const leftovers: Array<string> = [];
beforeAll(isolateGit);
afterAll(restoreGit);
afterEach(() => {
  for (const undo of restoreEnv.splice(0)) undo();
  for (const folder of leftovers.splice(0)) NodeFS.rmSync(folder, { recursive: true, force: true });
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
/** Sync's staging folder, and the marker file each send's own folder carries. */
const STAGING_ROOT = NodePath.join(NodeOS.tmpdir(), "swc-sync-staging");
const MARKER = "swc-sync-send";

type Item = Parameters<typeof Extras.sendExtra>[0]["item"];
const branchItem: Item = { kind: "branch", path: ".", branch: "main" };
const snapshotItem: Item = { kind: "uncommitted", path: ".", sendAnyway: [] };

const peerOn = (
  destination: string,
  options: {
    readonly during?: () => void;
    readonly sent?: (commit: string, bundle: Uint8Array | null) => void;
    readonly land?: boolean;
    readonly knowsNothing?: boolean;
  } = {},
): Extras.ExtrasPeer => ({
  negotiate: async (candidates) => {
    options.during?.();
    return options.knowsNothing === true ? [] : knownCommits(destination, candidates);
  },
  replicate: async (meta, bundle) => {
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

const send = (
  source: string,
  item: Item,
  peer: Extras.ExtrasPeer,
  limits?: Parameters<typeof Extras.sendExtra>[0]["limits"],
) =>
  Extras.sendExtra({
    repository: { path: ".", cwd: source },
    item,
    operationId: OPERATION,
    index: 0,
    sourceLabel: "M4",
    now: NOW,
    peer,
    ...(limits === undefined ? {} : { limits }),
  });

/** The send's own Git folder: where the code under test wrote its temporary ref, from `from` on. */
const ownGitDir = (from: number, destination: string) => {
  const writes = recordedGit()
    .slice(from)
    .filter(
      (command) =>
        command.args[0] === "update-ref" &&
        command.args.includes(HIDDEN) &&
        !command.cwd.startsWith(destination),
    );
  return writes.at(-1)?.gitDir ?? null;
};
const real = (path: string) => NodeFS.realpathSync(path);

describe("the send's repository is in Sync's staging folder (R9-01)", () => {
  it("under the staging root, with a marker holding a token, removed after the send", async () => {
    const f = twoMachines();
    commit(f.a, "app.ts", "export const a = 2;\n");
    const from = recordedGit().length;
    let folder: string | null = null;
    let marker = "";
    const result = await send(
      f.a,
      branchItem,
      peerOn(f.b, {
        during: () => {
          const gitDir = ownGitDir(from, f.b);
          folder = gitDir === null ? null : NodePath.dirname(gitDir);
          if (folder !== null) leftovers.push(folder);
          const file = folder === null ? "" : NodePath.join(folder, MARKER);
          marker = NodeFS.existsSync(file) ? NodeFS.readFileSync(file, "utf8") : "";
        },
      }),
    );
    expect(result.status).toBe("sent");
    expect(folder).not.toBeNull();
    expect(real(NodePath.dirname(folder!))).toBe(real(STAGING_ROOT));
    expect(marker).toMatch(/\btoken [0-9a-f]{32}\n/);
    expect(NodeFS.existsSync(folder!)).toBe(false);
  });

  for (const [name, limits, status] of [
    ["a send that is sent", undefined, "sent"],
    ["a send that stays", { maxBundleBytes: 1 }, "stays"],
  ] as const) {
    it(`${name}: a folder whose marker token does not match survives cleanup`, async () => {
      const f = twoMachines();
      commit(f.a, "app.ts", "export const a = 2;\n");
      const tip = git(f.a, "rev-parse", "HEAD");
      const from = recordedGit().length;
      let folder = "";
      const result = await send(
        f.a,
        branchItem,
        peerOn(f.b, {
          during: () => {
            const gitDir = ownGitDir(from, f.b);
            if (gitDir === null) return;
            folder = NodePath.dirname(gitDir);
            // Another program puts a copy in its place, with its own marker and its own ref.
            const original = `${folder}-original`;
            NodeFS.renameSync(folder, original);
            leftovers.push(original, folder);
            NodeFS.cpSync(original, folder, { recursive: true });
            NodeFS.writeFileSync(NodePath.join(folder, MARKER), `token ${"f".repeat(32)}\n`);
            NodeFS.writeFileSync(NodePath.join(folder, "sentinel"), "theirs\n");
            git(f.base, `--git-dir=${gitDir}`, "update-ref", "refs/heads/foreign", tip);
          },
        }),
        limits,
      );
      expect(result.status).toBe(status);
      expect(folder).not.toBe("");
      expect(NodeFS.readFileSync(NodePath.join(folder, "sentinel"), "utf8")).toBe("theirs\n");
      expect(
        git(
          f.base,
          `--git-dir=${NodePath.join(folder, "refs.git")}`,
          "rev-parse",
          "refs/heads/foreign",
        ),
      ).toBe(tip);
      expect(result.detail ?? "").toContain(folder);
    });
  }
});

/** Runs Git as the code under test ran `command`: this process's environment, then its own. */
const asRecorded = (command: RecordedGit, args: Array<string>) => {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const [key, value] of Object.entries(command.env)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  return NodeChildProcess.execFileSync("git", ["-C", command.cwd, ...args], {
    encoding: "utf8",
    env,
  }).trim();
};

describe("private commands open only the private repository (follow-up 1)", () => {
  it("inherited repository locations: the common directory is the private one, the source unchanged", async () => {
    const f = twoMachines();
    write(f.a, "app.ts", "export const a = 'edited';\n");
    const gitDir = real(NodePath.join(f.a, ".git"));
    const config = NodeFS.readFileSync(NodePath.join(gitDir, "config"), "utf8");
    const refs = allRefs(f.a);
    // A server started from inside a Git hook of the source: each names the source itself.
    setEnv("GIT_COMMON_DIR", gitDir);
    setEnv("GIT_OBJECT_DIRECTORY", NodePath.join(gitDir, "objects"));
    setEnv("GIT_WORK_TREE", real(f.a));
    const from = recordedGit().length;
    const common: Array<string> = [];
    const result = await send(
      f.a,
      snapshotItem,
      peerOn(f.b, {
        knowsNothing: true,
        land: false,
        during: () => {
          for (const command of recordedGit().slice(from))
            if (command.gitDir !== null && !command.gitDir.startsWith(f.base))
              // Both read while the send's folder is there.
              common.push(
                `${real(asRecorded(command, ["rev-parse", "--path-format=absolute", "--git-common-dir"]))} ${real(command.gitDir)}`,
              );
        },
      }),
    );
    expect(result.status).toBe("sent");
    expect(common.length).toBeGreaterThan(0);
    for (const line of common) {
      const [effective, own] = line.split(" ");
      expect(effective).toBe(own);
    }
    expect(NodeFS.readFileSync(NodePath.join(gitDir, "config"), "utf8")).toBe(config);
    expect(allRefs(f.a)).toBe(refs);
  });
});

describe("a prune in the source cannot break a snapshot send (follow-up 2)", () => {
  it("prune --expire=now while the peer is asked: still sent, and the bundle verifies", async () => {
    const f = twoMachines();
    write(f.a, "app.ts", "export const a = 'edited';\n");
    write(f.a, "new.ts", "export const fresh = 1;\n");
    let bundle: Uint8Array | null = null;
    let sentCommit = "";
    const result = await send(
      f.a,
      snapshotItem,
      peerOn(f.b, {
        during: () => git(f.a, "prune", "--expire=now"),
        sent: (oid, bytes) => {
          sentCommit = oid;
          bundle = bytes;
        },
        land: false,
      }),
    );
    expect(result).toMatchObject({ status: "sent" });
    const file = NodePath.join(f.base, "sent.bundle");
    NodeFS.writeFileSync(file, bundle!);
    git(f.b, "bundle", "verify", "-q", file);
    expect(git(f.b, "bundle", "list-heads", file).split(" ")[0]).toBe(sentCommit);
  });
});

describe("the private repository has the source's object format (follow-up 4)", () => {
  it("a SHA-1 source sends where new repositories default to SHA-256", async () => {
    const f = twoMachines();
    write(f.a, "app.ts", "export const a = 'edited';\n");
    setEnv("GIT_DEFAULT_HASH", "sha256");
    const from = recordedGit().length;
    const result = await send(f.a, snapshotItem, peerOn(f.b, { land: false }));
    expect(result.status).toBe("sent");
    const inits = recordedGit()
      .slice(from)
      .filter((command) => command.args[0] === "init");
    expect(inits.map((command) => command.args.join(" "))).toEqual([
      "init --bare -q --template= --object-format=sha1",
    ]);
  });
});
