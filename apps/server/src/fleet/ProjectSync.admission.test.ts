// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off - disposable real Git fixtures only.
/**
 * The guarded fast-forward, review round 5 (1390): the history it goes by,
 * the last checks before the write, the Git folder every command opens, what
 * a read that failed is said as, and what a write that did not go as planned
 * says. Real Git in temporary repositories only.
 */
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "@effect/vitest";
import {
  type Project,
  ProjectId,
  PROJECT_SYNC_CHANGED_FOLDER_DETAIL,
  PROJECT_SYNC_CHANGED_UPSTREAM_DETAIL,
  PROJECT_SYNC_FETCH_KEPT_MS,
  PROJECT_SYNC_FETCHES_KEPT,
  PROJECT_SYNC_FETCHED_UNREAD_DETAIL,
  PROJECT_SYNC_GIT_TOO_OLD_DETAIL,
  PROJECT_SYNC_NO_FETCH_DETAIL,
  PROJECT_SYNC_PARTIAL_CLONE_DETAIL,
  PROJECT_SYNC_STATE_UNREAD_DETAIL,
  PROJECT_SYNC_THREADS_UNREAD_DETAIL,
  planProjectSyncRepository,
  projectSyncMovedByOtherDetail,
  projectSyncSwitchedAwayDetail,
} from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { vi } from "vite-plus/test";

import {
  cleanUp,
  git,
  gitHooks,
  isolateGit,
  restoreGit,
  twoMachines,
  write,
} from "../handoff/extrasTestKit.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectService from "../project/ProjectService.ts";
import { runGit } from "./folderTransfer/git.ts";
import * as ProjectSync from "./ProjectSync.ts";
import { uncommittedCount } from "./projectSyncGit.ts";
import { keepFetch, keptFetch, newFetchRecord } from "./projectSyncRecord.ts";
import { refTransaction, type RefTransactionFactory } from "./refTransaction.ts";

vi.mock("./folderTransfer/git.ts", async (importOriginal) => {
  const kit = await import("../handoff/extrasTestKit.ts");
  return kit.recordingGit(await importOriginal<typeof import("./folderTransfer/git.ts")>());
});

const locked: Array<string> = [];
const restoreEnv: Array<() => void> = [];
beforeAll(isolateGit);
afterAll(restoreGit);
afterEach(() => {
  for (const folder of locked.splice(0)) NodeFS.chmodSync(folder, 0o755);
  for (const undo of restoreEnv.splice(0)) undo();
  vi.restoreAllMocks();
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

const projectA = ProjectId.make("project-admission");
const project = (workspaceRoot: string) =>
  ({ id: projectA, title: "App", workspaceRoot, workspaceSettings: {} }) as unknown as Project;
const withSync = <A, E>(
  folder: string,
  body: (sync: ProjectSync.ProjectSync["Service"]) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    return yield* body(yield* ProjectSync.ProjectSync);
  }).pipe(
    Effect.provide(
      ProjectSync.layer.pipe(
        Layer.provide(
          Layer.mock(ProjectService.ProjectService)({
            snapshot: Effect.succeed({
              projects: [project(folder)],
              updatedAt: "2026-11-19T00:00:00.000Z",
            }),
          }),
        ),
        Layer.provideMerge(SqlitePersistence.layerMemory),
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
  );
const one = { projectId: projectA };

/** Machine B one commit behind origin's `main`; `change` shapes the commit A publishes. */
function behind(change: (a: string) => void = (a) => write(a, "app.ts", "export const a = 2;\n")) {
  const f = twoMachines();
  const was = git(f.b, "rev-parse", "HEAD");
  change(f.a);
  git(f.a, "add", "-A");
  git(f.a, "commit", "-q", "-m", "published");
  git(f.a, "push", "-q", "origin", "main");
  return { ...f, was, head: git(f.a, "rev-parse", "HEAD") };
}

const lockFiles = (gitDir: string) =>
  NodeFS.readdirSync(gitDir, { recursive: true })
    .map(String)
    .filter((name) => name.endsWith(".lock"));

type Runner = ProjectSync.SyncContext["git"];
const real: Runner = (cwd, args, options) => runGit(cwd, args, options);

/**
 * Fetches B, then moves it, as a run does: the record kept and looked up on
 * every read. `inUse` is asked at the fetch, before the lock and last under it.
 */
const fetchThenRun = async (
  f: { readonly b: string },
  options: {
    readonly git?: Runner;
    readonly inUse?: ProjectSync.SyncContext["inUse"];
    readonly transaction?: RefTransactionFactory;
  } = {},
) => {
  const record = newFetchRecord("project-admission");
  const base = {
    git: options.git ?? real,
    inUse: options.inUse ?? (async () => null),
    ...(options.transaction === undefined ? {} : { transaction: options.transaction }),
  };
  const facts = await ProjectSync.fetchAll({ ...base, fetched: record }, [{ path: ".", cwd: f.b }]);
  keepFetch(record);
  const step = await ProjectSync.fastForwardRepository(
    { ...base, record: () => keptFetch("project-admission", record.id) },
    { path: ".", cwd: f.b },
    null,
  );
  return { facts: facts[0]!, record, step };
};

describe("the history a move goes by (R5-01)", () => {
  it.effect("an inherited graft file never makes an unrelated commit a fast-forward", () => {
    const f = twoMachines();
    const was = git(f.b, "rev-parse", "HEAD");
    git(f.a, "checkout", "-q", "--orphan", "rewritten");
    write(f.a, "app.ts", "export const a = 'unrelated';\n");
    git(f.a, "add", "-A");
    git(f.a, "commit", "-q", "-m", "unrelated");
    git(f.a, "push", "-q", "--force", "origin", "rewritten:main");
    const unrelated = git(f.a, "rev-parse", "HEAD");
    // A graft file outside the repository that makes the unrelated commit a child of B's.
    const grafts = NodePath.join(f.base, "grafts");
    NodeFS.writeFileSync(grafts, `${unrelated} ${was}\n`);
    setEnv("GIT_GRAFT_FILE", grafts);
    return withSync(f.b, (sync) =>
      Effect.gen(function* () {
        const fetched = yield* sync.fetch(one);
        const run = yield* sync.run({
          ...one,
          fetchId: fetched.fetchId,
          fastForward: [{ path: ".", otherBranch: null }],
          clone: [],
        });
        // Both tips as they were: B's branch, and origin's unrelated commit.
        expect(git(f.b, "rev-parse", "refs/heads/main")).toBe(was);
        expect(git(f.remote, "rev-parse", "refs/heads/main")).toBe(unrelated);
        expect(run.repositories[0]).toMatchObject({ moved: 0 });
        // Counted by the real history: two commits of its own, one of origin's.
        expect(fetched.repositories[0]).toMatchObject({ ahead: 2, behind: 1 });
      }),
    );
  });
});

describe("a partial clone on a Git that could fetch behind Sync's back (R5-02)", () => {
  const partial = (b: string) => {
    git(b, "config", "remote.origin.promisor", "true");
    git(b, "config", "extensions.partialClone", "origin");
  };
  const versioned =
    (version: string): Runner =>
    async (cwd, args, options) =>
      args[0] === "version"
        ? { code: 0, stdout: `git version ${version}\n`, stderr: "" }
        : runGit(cwd, args, options);

  it("Git 2.44: declined before any read of the target, the branch where it was", async () => {
    const f = behind();
    partial(f.b);
    const seen: Array<string> = [];
    const git244: Runner = async (cwd, args, options) => {
      seen.push(args.join(" "));
      return versioned("2.44.0")(cwd, args, options);
    };
    const { step } = await fetchThenRun(f, { git: git244 });
    expect(git(f.b, "rev-parse", "refs/heads/main")).toBe(f.was);
    expect(step).toMatchObject({ moved: 0, detail: PROJECT_SYNC_PARTIAL_CLONE_DETAIL });
    // Nothing that reads the target's objects ran in the move.
    const afterFetch = seen.slice(seen.findIndex((command) => command.startsWith("fetch")) + 1);
    expect(
      afterFetch.filter((command) => /^(cat-file|merge-base|diff-tree|read-tree)/.test(command)),
    ).toEqual([]);
  });

  it("Git 2.45 and newer: a partial clone moves (Git fetches nothing it is not asked to)", async () => {
    const f = behind();
    partial(f.b);
    const { step } = await fetchThenRun(f, { git: versioned("2.45.0") });
    expect(step).toMatchObject({ action: "fast-forward", moved: 1 });
    expect(git(f.b, "rev-parse", "refs/heads/main")).toBe(f.head);
  });
});

describe("the last checks come right before the write (R5-03)", () => {
  /** Free at the fetch and before the lock; `last` runs inside the last call, under the lock. */
  const lastAsked = (last: () => void): ProjectSync.SyncContext["inUse"] => {
    let asked = 0;
    return async () => {
      asked += 1;
      if (asked === 3) last();
      return null;
    };
  };

  it("declines when the fetch is evicted by newer ones during the last probe", async () => {
    const f = behind();
    const { step } = await fetchThenRun(f, {
      inUse: lastAsked(() => {
        for (let index = 0; index < PROJECT_SYNC_FETCHES_KEPT; index += 1)
          keepFetch(newFetchRecord("project-admission"));
      }),
    });
    expect(git(f.b, "rev-parse", "refs/heads/main")).toBe(f.was);
    expect(step).toMatchObject({ moved: 0, detail: PROJECT_SYNC_NO_FETCH_DETAIL });
  });

  it("declines when the fetch expires during the last probe", async () => {
    const f = behind();
    const realNow = Date.now.bind(Date);
    const { step } = await fetchThenRun(f, {
      inUse: lastAsked(() => {
        vi.spyOn(Date, "now").mockReturnValue(realNow() + PROJECT_SYNC_FETCH_KEPT_MS + 60_000);
      }),
    });
    expect(git(f.b, "rev-parse", "refs/heads/main")).toBe(f.was);
    expect(step).toMatchObject({ moved: 0, detail: PROJECT_SYNC_NO_FETCH_DETAIL });
    expect(lockFiles(NodePath.join(f.b, ".git"))).toEqual([]);
  });

  it("declines when the upstream changes during the last probe", async () => {
    const f = behind();
    const { step } = await fetchThenRun(f, {
      inUse: lastAsked(() => git(f.b, "config", "branch.main.merge", "refs/heads/elsewhere")),
    });
    expect(git(f.b, "rev-parse", "refs/heads/main")).toBe(f.was);
    expect(step).toMatchObject({ moved: 0, detail: PROJECT_SYNC_CHANGED_UPSTREAM_DETAIL });
  });
});

describe("one Git folder for the whole move (R5-04)", () => {
  it("declines when the checkout's .git is pointed at another Git folder under the lock", async () => {
    const f = behind();
    // B keeps its Git folder outside the checkout, and a copy of it has the same branch,
    // commit and upstream.
    const first = NodePath.join(f.base, "b-git");
    const second = NodePath.join(f.base, "b-git-copy");
    NodeFS.renameSync(NodePath.join(f.b, ".git"), first);
    NodeFS.writeFileSync(NodePath.join(f.b, ".git"), `gitdir: ${first}\n`);
    const fetched = newFetchRecord("project-admission");
    await ProjectSync.fetchAll({ git: real, inUse: async () => null, fetched }, [
      { path: ".", cwd: f.b },
    ]);
    keepFetch(fetched);
    NodeFS.cpSync(first, second, { recursive: true });
    // Right after the lock is taken, the checkout is bound to the copy.
    gitHooks.before = (command) => {
      if (command.cwd === f.b && command.args.includes("--refresh"))
        NodeFS.writeFileSync(NodePath.join(f.b, ".git"), `gitdir: ${second}\n`);
    };
    const step = await ProjectSync.fastForwardRepository(
      {
        git: real,
        inUse: async () => null,
        record: () => keptFetch("project-admission", fetched.id),
      },
      { path: ".", cwd: f.b },
      null,
    );
    gitHooks.before = null;
    const tip = (gitDir: string) =>
      git(f.base, `--git-dir=${gitDir}`, "rev-parse", "refs/heads/main");
    expect(tip(first)).toBe(f.was);
    expect(tip(second)).toBe(f.was);
    expect(step).toMatchObject({ moved: 0, detail: PROJECT_SYNC_CHANGED_FOLDER_DETAIL });
    for (const gitDir of [first, second])
      expect(
        git(
          f.base,
          `--git-dir=${gitDir}`,
          `--work-tree=${f.b}`,
          "diff-index",
          "--cached",
          "--name-only",
          "HEAD",
        ),
      ).toBe("");
    expect(NodeFS.readFileSync(NodePath.join(f.b, "app.ts"), "utf8")).toBe("export const a = 1;\n");
    expect(lockFiles(first)).toEqual([]);
  });
});

describe("a file name that is not UTF-8 (R5-05)", () => {
  const name = Buffer.from([0x66, 0x80]);
  const canName = (() => {
    const probe = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "swc-name-"));
    try {
      NodeFS.writeFileSync(Buffer.concat([Buffer.from(`${probe}/`), name]), "x");
      return true;
    } catch {
      return false;
    } finally {
      NodeFS.rmSync(probe, { recursive: true, force: true });
    }
  })();
  // macOS refuses such a name (EILSEQ); Linux keeps it byte for byte.
  it.skipIf(!canName)(
    "is never written over: the move declines, the ignored file stays",
    async () => {
      const f = behind((a) => {
        NodeFS.writeFileSync(Buffer.concat([Buffer.from(`${a}/`), name]), "theirs\n");
        write(a, "app.ts", "export const a = 2;\n");
      });
      // B has an ignored file of its own with that very byte name.
      NodeFS.appendFileSync(NodePath.join(f.b, ".git", "info", "exclude"), "f*\n");
      const mine = Buffer.concat([Buffer.from(`${f.b}/`), name]);
      NodeFS.writeFileSync(mine, "mine\n");
      const { step } = await fetchThenRun(f);
      expect(NodeFS.readFileSync(mine, "utf8")).toBe("mine\n");
      expect(git(f.b, "rev-parse", "refs/heads/main")).toBe(f.was);
      expect(step).toMatchObject({ moved: 0, detail: PROJECT_SYNC_STATE_UNREAD_DETAIL });
    },
  );
});

describe("a read that failed is said as unread, never as a fact (R5-11)", () => {
  it("a fatal index refresh under the lock declines", async () => {
    const f = behind();
    const { step } = await fetchThenRun(f, {
      git: async (cwd, args, options) =>
        args[0] === "update-index"
          ? { code: 128, stdout: "", stderr: "fatal: index file corrupt" }
          : runGit(cwd, args, options),
    });
    expect(git(f.b, "rev-parse", "refs/heads/main")).toBe(f.was);
    expect(step).toMatchObject({ moved: 0, detail: PROJECT_SYNC_STATE_UNREAD_DETAIL });
  });

  it("a staging folder that could not be listed is no count", async () => {
    const f = twoMachines();
    NodeFS.mkdirSync(NodePath.join(f.b, "parent"));
    NodeFS.writeFileSync(NodePath.join(f.b, "parent", "note.txt"), "x\n");
    const count = await uncommittedCount(
      async (cwd, args, options) =>
        args[0] === "ls-files"
          ? { code: 128, stdout: "", stderr: "fatal: cannot list" }
          : runGit(cwd, args, options),
      f.b,
    );
    expect(count).toBeNull();
  });

  it("a thread list that could not be read is unread, never a thread", async () => {
    const f = behind();
    const { facts, step } = await fetchThenRun(f, { inUse: async () => undefined });
    expect(git(f.b, "rev-parse", "refs/heads/main")).toBe(f.was);
    expect(facts).toMatchObject({ inUseBy: null, stateUnread: true });
    expect(facts.unreadDetail).toBe(PROJECT_SYNC_THREADS_UNREAD_DETAIL);
    expect(step).toMatchObject({ moved: 0 });
  });
});

describe("which read failed stays said (R5-12)", () => {
  it("a version that could not be read is not an old Git", async () => {
    const f = behind();
    const { facts, step } = await fetchThenRun(f, {
      git: async (cwd, args, options) =>
        args[0] === "version"
          ? { code: 1, stdout: "", stderr: "fatal: cannot run" }
          : runGit(cwd, args, options),
    });
    expect(facts.unreadDetail).not.toBe(PROJECT_SYNC_GIT_TOO_OLD_DETAIL);
    expect(facts).toMatchObject({ fetch: "ok", unreadDetail: PROJECT_SYNC_FETCHED_UNREAD_DETAIL });
    expect(step).toMatchObject({ moved: 0, detail: PROJECT_SYNC_FETCHED_UNREAD_DETAIL });
  });

  it("an unread checkout of a valid fetch is said unread on run, not 'no fetch'", async () => {
    const f = behind();
    const { record, step } = await fetchThenRun(f, {
      git: async (cwd, args, options) => {
        const out = await runGit(cwd, args, options);
        return args[0] === "fetch" ? { ...out, stdout: "not porcelain\n" } : out;
      },
    });
    expect(record.rows.get(".")).toMatchObject({ readable: false });
    expect(step).toMatchObject({ moved: 0, detail: PROJECT_SYNC_FETCHED_UNREAD_DETAIL });
    expect(git(f.b, "rev-parse", "refs/heads/main")).toBe(f.was);
  });

  it("no remote, or a failed fetch, keeps its reason and the unread detail", () => {
    const facts = {
      path: ".",
      branch: null,
      head: null,
      upstream: null,
      otherUpstream: null,
      ahead: 0,
      behind: 0,
      uncommitted: 0,
      stateUnread: true,
      unreadDetail: PROJECT_SYNC_STATE_UNREAD_DETAIL,
      inUseBy: null,
      remote: null,
      fetchError: null,
    } as const;
    expect(planProjectSyncRepository({ ...facts, fetch: "no-remote" }, null)).toMatchObject({
      reason: "no-remote",
      detail: PROJECT_SYNC_STATE_UNREAD_DETAIL,
    });
    const failed = planProjectSyncRepository(
      { ...facts, fetch: "failed", fetchError: "could not reach origin" },
      null,
    );
    expect(failed.reason).toBe("fetch-failed");
    expect(failed.detail).toContain("could not reach origin");
    expect(failed.detail).toContain(PROJECT_SYNC_STATE_UNREAD_DETAIL);
  });
});

describe("what readback says (R5-13)", () => {
  it("a switch after Git confirmed the move: the branch is at the target, the checkout is elsewhere", async () => {
    const f = behind();
    const { step } = await fetchThenRun(f, {
      transaction: (cwd, message) => {
        const inner = refTransaction(cwd, message);
        return {
          ...inner,
          commit: async () => {
            const answer = await inner.commit();
            git(f.b, "checkout", "-q", "-b", "other");
            return answer;
          },
        };
      },
    });
    expect(git(f.b, "rev-parse", "refs/heads/main")).toBe(f.head);
    expect(step.detail ?? "").not.toContain("not at the commit");
    expect(step).toMatchObject({
      moved: 0,
      movedUnverified: true,
      detail: projectSyncSwitchedAwayDetail("main", "other"),
    });
  });

  it("a branch another program moved after Sync aborted: Sync claims nothing of it", async () => {
    const f = behind((a) => {
      write(a, "app.ts", "export const a = 2;\n");
      write(a, "sub/x.ts", "export const x = 1;\n");
    });
    NodeFS.mkdirSync(NodePath.join(f.b, "sub"));
    NodeFS.chmodSync(NodePath.join(f.b, "sub"), 0o555);
    locked.push(NodePath.join(f.b, "sub"));
    const other = git(f.b, "commit-tree", "-p", f.was, "-m", "elsewhere", `${f.was}^{tree}`);
    let treeFailed = false;
    gitHooks.after = (command) => {
      if (command.args.includes("read-tree")) treeFailed = true;
    };
    gitHooks.before = (command) => {
      if (treeFailed && command.args.includes("--verify") && command.cwd === f.b) {
        treeFailed = false;
        git(f.b, "update-ref", "refs/heads/main", other);
      }
    };
    const { step } = await fetchThenRun(f);
    gitHooks.before = null;
    gitHooks.after = null;
    expect(git(f.b, "rev-parse", "refs/heads/main")).toBe(other);
    expect(step.movedUnverified ?? false).toBe(false);
    expect(step).toMatchObject({ moved: 0, detail: projectSyncMovedByOtherDetail("main", other) });
  });
});

describe("the transaction is owned from start to end (R5-14)", () => {
  it("a prepare that throws after Git prepared still closes the transaction", async () => {
    const f = behind();
    const opened: Array<ReturnType<RefTransactionFactory>> = [];
    const outcome = await fetchThenRun(f, {
      transaction: (cwd, message) => {
        const inner = refTransaction(cwd, message);
        opened.push(inner);
        return {
          ...inner,
          prepare: async (lines) => {
            await inner.prepare(lines);
            throw new Error("the answer could not be read");
          },
        };
      },
    }).then(
      () => "returned",
      () => "threw",
    );
    try {
      expect(outcome).toBe("threw");
      expect(lockFiles(NodePath.join(f.b, ".git"))).toEqual([]);
      expect(git(f.b, "rev-parse", "refs/heads/main")).toBe(f.was);
    } finally {
      for (const transaction of opened) await transaction.abort();
    }
  });

  it("a commit Git never answers ends by a deadline, and the child is stopped", async () => {
    const bin = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "swc-fake-git-"));
    const pidFile = NodePath.join(bin, "pid");
    // A Git that prepares, then never answers the commit.
    NodeFS.writeFileSync(
      NodePath.join(bin, "git"),
      [
        "#!/bin/sh",
        `echo $$ > '${pidFile}'`,
        "while read line; do",
        '  case "$line" in',
        '    start) echo "start: ok" ;;',
        '    prepare) echo "prepare: ok" ;;',
        "    commit) exec sleep 20 ;;",
        "  esac",
        "done",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    setEnv("PATH", `${bin}${NodePath.delimiter}${process.env.PATH ?? ""}`);
    const transaction = refTransaction(bin, "sync: fast-forward", { commitMs: 300 });
    try {
      expect(await transaction.prepare(["update HEAD a b"])).toEqual({ ok: true });
      const started = Date.now();
      const outcome = await Promise.race([
        transaction.commit().then(
          () => "answered",
          () => "lost",
        ),
        new Promise((resolve) => setTimeout(() => resolve("still waiting"), 5_000)),
      ]);
      expect(outcome).toBe("lost");
      expect(Date.now() - started).toBeLessThan(5_000);
      // The child was stopped, not left waiting.
      const pid = Number(NodeFS.readFileSync(pidFile, "utf8").trim());
      expect(() => process.kill(pid, 0)).toThrow();
    } finally {
      const pid = Number(NodeFS.readFileSync(pidFile, "utf8").trim());
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already stopped.
      }
      NodeFS.rmSync(bin, { recursive: true, force: true });
    }
  }, 10_000);
});
