// @effect-diagnostics nodeBuiltinImport:off globalDate:off - disposable real Git fixtures only, and a clock moved forward for a record's age.
/**
 * The guarded fast-forward (1390, design round 4): what it refuses before the
 * lock, what it checks again under it, and what it says after a write that
 * did not go as planned. Every case runs real Git in a temporary repository,
 * through the service a window calls where the case allows it.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "@effect/vitest";
import {
  type Project,
  ProjectId,
  PROJECT_SYNC_CHANGED_HEAD_DETAIL,
  PROJECT_SYNC_CHANGED_UPSTREAM_DETAIL,
  PROJECT_SYNC_FETCH_KEPT_MS,
  PROJECT_SYNC_FETCHES_KEPT,
  PROJECT_SYNC_GRAFTS_DETAIL,
  PROJECT_SYNC_NO_FETCH_DETAIL,
  PROJECT_SYNC_UNVERIFIED_DETAIL,
  projectSyncFilesDifferDetail,
  projectSyncFilterDetail,
  projectSyncHeldElsewhereDetail,
  projectSyncInTheWayDetail,
  projectSyncLockedDetail,
  projectSyncPartialDetail,
  projectSyncSubmoduleDetail,
} from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { vi } from "vite-plus/test";

import {
  cleanUp,
  commit,
  git,
  gitHooks,
  isolateGit,
  restoreGit,
  snapshot,
  twoMachines,
  write,
} from "../handoff/extrasTestKit.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectService from "../project/ProjectService.ts";
import { runGit } from "./folderTransfer/git.ts";
import * as ProjectSync from "./ProjectSync.ts";
import { keepFetch, keptFetch, newFetchRecord } from "./projectSyncRecord.ts";
import { refTransaction, type RefTransactionFactory } from "./refTransaction.ts";

vi.mock("./folderTransfer/git.ts", async (importOriginal) => {
  const kit = await import("../handoff/extrasTestKit.ts");
  return kit.recordingGit(await importOriginal<typeof import("./folderTransfer/git.ts")>());
});

/** Folders a test made read-only, given their modes back before they are removed. */
const locked: Array<string> = [];
beforeAll(isolateGit);
afterAll(restoreGit);
afterEach(() => {
  for (const folder of locked.splice(0)) NodeFS.chmodSync(folder, 0o755);
  vi.restoreAllMocks();
  cleanUp();
});

const projectA = ProjectId.make("project-guarded");
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
function behind(
  change: (a: string) => void = (a) => write(a, "app.ts", "export const a = 2;\n"),
  stage: "all" | "as-is" = "all",
) {
  const f = twoMachines();
  const was = git(f.b, "rev-parse", "HEAD");
  change(f.a);
  if (stage === "all") git(f.a, "add", "-A");
  git(f.a, "commit", "-q", "-m", "published");
  git(f.a, "push", "-q", "origin", "main");
  return { ...f, was, head: git(f.a, "rev-parse", "HEAD") };
}

/** Fetches, then runs the move of the root; `admitted` acts right after `prepare: ok`. */
const fetchAndMove = (
  f: { readonly b: string },
  options: {
    readonly otherBranch?: string | null;
    readonly admitted?: () => void;
  } = {},
) =>
  withSync(f.b, (sync) =>
    Effect.gen(function* () {
      const fetched = yield* sync.fetch(one);
      // The first command after the transaction is prepared is the admission point's
      // read of the Git folders: the second such read of the run.
      let folders = 0;
      gitHooks.before = (command) => {
        if (command.cwd !== f.b || !command.args.includes("--path-format=absolute")) return;
        folders += 1;
        if (folders === 2) options.admitted?.();
      };
      const run = yield* sync.run({
        ...one,
        fetchId: fetched.fetchId,
        fastForward: [{ path: ".", otherBranch: options.otherBranch ?? null }],
        clone: [],
      });
      gitHooks.before = null;
      return { fetched, step: run.repositories[0]! };
    }),
  );
const lockFiles = (cwd: string) =>
  NodeFS.readdirSync(NodePath.join(cwd, ".git"), { recursive: true })
    .map(String)
    .filter((name) => name.endsWith(".lock"));
const readOnly = (folder: string) => {
  NodeFS.chmodSync(folder, 0o555);
  locked.push(folder);
};

describe("a branch checked out in another worktree too (B20, G2)", () => {
  it.effect("is not moved, and neither checkout changes", () => {
    const f = behind();
    // A second checkout of `main`, forced: Git allows it, and moving one leaves the other's
    // files behind the branch.
    const other = NodePath.join(f.base, "second");
    git(f.b, "worktree", "add", "-q", "--force", other, "main");
    const before = { here: snapshot(f.b), there: snapshot(other) };
    return fetchAndMove(f).pipe(
      Effect.map(({ step }) => {
        expect(step).toMatchObject({
          action: "none",
          reason: "refused",
          moved: 0,
          detail: projectSyncHeldElsewhereDetail("main", NodeFS.realpathSync(other)),
        });
        expect({ here: snapshot(f.b), there: snapshot(other) }).toEqual(before);
        expect(git(f.b, "rev-parse", "main")).toBe(f.was);
        expect(lockFiles(f.b)).toEqual([]);
      }),
    );
  });
});

describe("nothing Git does not track is written over (D4-02, G1)", () => {
  it.effect("refuses when an ignored folder stands where the move adds a file", () => {
    const f = behind((a) => write(a, "cache", "tracked now\n"));
    NodeFS.appendFileSync(NodePath.join(f.b, ".git", "info", "exclude"), "cache/\n");
    write(f.b, "cache/state.json", "{}\n");
    return fetchAndMove(f).pipe(
      Effect.map(({ step }) => {
        expect(step).toMatchObject({
          action: "none",
          moved: 0,
          detail: projectSyncInTheWayDetail("cache"),
        });
        expect(NodeFS.readFileSync(NodePath.join(f.b, "cache", "state.json"), "utf8")).toBe("{}\n");
        expect(git(f.b, "rev-parse", "HEAD")).toBe(f.was);
      }),
    );
  });

  it.effect("refuses when a folder on the way is a link, and writes nothing through it", () => {
    const f = behind((a) => write(a, "vendor/lib.ts", "export const lib = 1;\n"));
    const elsewhere = NodePath.join(f.base, "elsewhere");
    NodeFS.mkdirSync(elsewhere);
    NodeFS.symlinkSync(elsewhere, NodePath.join(f.b, "vendor"));
    NodeFS.appendFileSync(NodePath.join(f.b, ".git", "info", "exclude"), "vendor\n");
    return fetchAndMove(f).pipe(
      Effect.map(({ step }) => {
        expect(step).toMatchObject({ moved: 0, detail: projectSyncInTheWayDetail("vendor") });
        expect(NodeFS.readdirSync(elsewhere)).toEqual([]);
        expect(git(f.b, "rev-parse", "HEAD")).toBe(f.was);
      }),
    );
  });
});

describe("history and content Sync does not run (D4-03)", () => {
  it.effect("refuses a move that changes a submodule, also with submodule.recurse set", () => {
    const f = behind(
      (a) => git(a, "update-index", "--add", "--cacheinfo", `160000,${"1".repeat(40)},mod`),
      "as-is",
    );
    git(f.b, "config", "submodule.recurse", "true");
    return fetchAndMove(f).pipe(
      Effect.map(({ step }) => {
        expect(step).toMatchObject({ moved: 0, detail: projectSyncSubmoduleDetail("mod") });
        expect(git(f.b, "rev-parse", "HEAD")).toBe(f.was);
      }),
    );
  });

  it.effect("refuses a file that goes through a Git filter, and never runs the filter", () => {
    const f = behind((a) => {
      write(a, ".gitattributes", "*.txt filter=probe\n");
      write(a, "notes.txt", "notes\n");
    });
    const fired = NodePath.join(f.base, "fired");
    git(f.b, "config", "filter.probe.smudge", `sh -c 'touch "${fired}"; cat'`);
    git(f.b, "config", "filter.probe.clean", "cat");
    return fetchAndMove(f).pipe(
      Effect.map(({ step }) => {
        expect(step).toMatchObject({
          moved: 0,
          detail: projectSyncFilterDetail("notes.txt", "probe"),
        });
        expect(NodeFS.existsSync(fired)).toBe(false);
        expect(git(f.b, "rev-parse", "HEAD")).toBe(f.was);
      }),
    );
  });

  it.effect("moves to the real commit when a replacement stands in for it here", () => {
    const f = behind();
    // A commit of its own, after the fetch, that `git replace` puts in the target's place.
    const fake = git(
      f.b,
      "commit-tree",
      git(f.b, "rev-parse", "HEAD^{tree}"),
      "-p",
      f.was,
      "-m",
      "stand-in",
    );
    return withSync(f.b, (sync) =>
      Effect.gen(function* () {
        const fetched = yield* sync.fetch(one);
        git(f.b, "replace", f.head, fake);
        const run = yield* sync.run({
          ...one,
          fetchId: fetched.fetchId,
          fastForward: [{ path: ".", otherBranch: null }],
          clone: [],
        });
        expect(run.repositories[0]).toMatchObject({ action: "fast-forward", moved: 1 });
        expect(git(f.b, "rev-parse", "main")).toBe(f.head);
        // The target's own file, not the stand-in's.
        expect(NodeFS.readFileSync(NodePath.join(f.b, "app.ts"), "utf8")).toBe(
          "export const a = 2;\n",
        );
        // Read as Sync reads it: the stand-in is no part of the checkout.
        expect(git(f.b, "--no-replace-objects", "status", "--porcelain=v1")).toBe("");
      }),
    );
  });

  it.effect(
    "plans and moves by the real history when a replacement makes unrelated commits look related",
    () => {
      const f = twoMachines();
      const was = git(f.b, "rev-parse", "HEAD");
      // origin is rewritten to a commit that does not follow from B's.
      git(f.a, "checkout", "-q", "--orphan", "rewritten");
      write(f.a, "app.ts", "export const a = 'rewritten';\n");
      git(f.a, "add", "-A");
      git(f.a, "commit", "-q", "-m", "rewritten");
      git(f.a, "push", "-q", "--force", "origin", "rewritten:main");
      const unrelated = git(f.a, "rev-parse", "HEAD");
      // Here a replacement says it does: the same tree, with B's commit as its parent.
      git(f.b, "fetch", "-q", "origin");
      const lookalike = git(
        f.b,
        "commit-tree",
        git(f.b, "rev-parse", `${unrelated}^{tree}`),
        "-p",
        was,
        "-m",
        "lookalike",
      );
      git(f.b, "replace", unrelated, lookalike);
      expect(git(f.b, "merge-base", "--is-ancestor", was, unrelated)).toBe("");
      return fetchAndMove(f).pipe(
        Effect.map(({ fetched, step }) => {
          // Real history: B's two commits and the one unrelated commit, not one behind.
          expect(fetched.repositories[0]).toMatchObject({ ahead: 2, behind: 1 });
          expect(step).toMatchObject({ moved: 0, downgraded: true });
          expect(git(f.b, "rev-parse", "main")).toBe(was);
        }),
      );
    },
  );

  it.effect("refuses a repository with grafts", () => {
    const f = behind();
    // A graft that says what the history says already: its being there is enough.
    write(f.b, ".git/info/grafts", `${f.head} ${f.was}\n`);
    return fetchAndMove(f).pipe(
      Effect.map(({ step }) => {
        expect(step).toMatchObject({ moved: 0, detail: PROJECT_SYNC_GRAFTS_DETAIL });
        expect(git(f.b, "rev-parse", "HEAD")).toBe(f.was);
      }),
    );
  });
});

describe("one admission point, under the lock (D4-04)", () => {
  it.effect("declines when the named fetch expires after prepare, and leaves no lock", () => {
    const f = behind();
    const realNow = Date.now.bind(Date);
    return fetchAndMove(f, {
      admitted: () => {
        const later = realNow() + PROJECT_SYNC_FETCH_KEPT_MS + 60_000;
        vi.spyOn(Date, "now").mockReturnValue(later);
      },
    }).pipe(
      Effect.map(({ step }) => {
        expect(step).toMatchObject({ moved: 0, detail: PROJECT_SYNC_NO_FETCH_DETAIL });
        expect(git(f.b, "rev-parse", "HEAD")).toBe(f.was);
        expect(lockFiles(f.b)).toEqual([]);
      }),
    );
  });

  it.effect("declines when the named fetch is evicted by newer ones after prepare", () => {
    const f = behind();
    return fetchAndMove(f, {
      admitted: () => {
        for (let index = 0; index < PROJECT_SYNC_FETCHES_KEPT; index += 1)
          keepFetch(newFetchRecord("project-guarded"));
      },
    }).pipe(
      Effect.map(({ step }) => {
        expect(step).toMatchObject({ moved: 0, detail: PROJECT_SYNC_NO_FETCH_DETAIL });
        expect(git(f.b, "rev-parse", "HEAD")).toBe(f.was);
        expect(lockFiles(f.b)).toEqual([]);
      }),
    );
  });

  it.effect("declines when the branch's upstream changes after prepare", () => {
    const f = behind();
    return fetchAndMove(f, {
      admitted: () => git(f.b, "config", "branch.main.merge", "refs/heads/elsewhere"),
    }).pipe(
      Effect.map(({ step }) => {
        expect(step).toMatchObject({ moved: 0, detail: PROJECT_SYNC_CHANGED_UPSTREAM_DETAIL });
        expect(git(f.b, "rev-parse", "HEAD")).toBe(f.was);
        expect(lockFiles(f.b)).toEqual([]);
      }),
    );
  });

  it.effect("declines when a file is edited after prepare, and keeps the edit", () => {
    const f = behind();
    return fetchAndMove(f, {
      admitted: () => write(f.b, "app.ts", "export const a = 'mine';\n"),
    }).pipe(
      Effect.map(({ step }) => {
        expect(step).toMatchObject({ action: "fetch", reason: "uncommitted", moved: 0 });
        expect(NodeFS.readFileSync(NodePath.join(f.b, "app.ts"), "utf8")).toBe(
          "export const a = 'mine';\n",
        );
        expect(git(f.b, "rev-parse", "HEAD")).toBe(f.was);
      }),
    );
  });

  it("keeps a fetch for an hour, the newest 32, and to its own project", () => {
    const first = newFetchRecord("p");
    keepFetch(first);
    expect(keptFetch("p", first.id)).toBe(first);
    expect(keptFetch("other", first.id)).toBeUndefined();
    expect(keptFetch("p", first.id, first.atMs + PROJECT_SYNC_FETCH_KEPT_MS + 1)).toBeUndefined();
    const second = newFetchRecord("p");
    keepFetch(second);
    for (let index = 0; index < PROJECT_SYNC_FETCHES_KEPT; index += 1)
      keepFetch(newFetchRecord("p"));
    expect(keptFetch("p", second.id)).toBeUndefined();
  });
});

describe("the other machine's branch as either spelling (D4-05)", () => {
  it.effect("moves when the plan names the branch in full", () => {
    const f = behind();
    return fetchAndMove(f, { otherBranch: "refs/heads/main" }).pipe(
      Effect.map(({ fetched, step }) => {
        expect(fetched.repositories[0]).toMatchObject({ upstreamCommit: f.head });
        expect(step).toMatchObject({ action: "fast-forward", moved: 1 });
        expect(git(f.b, "rev-parse", "HEAD")).toBe(f.head);
      }),
    );
  });
});

describe("what a write that did not go as planned says (D4-01, D4-06)", () => {
  it.effect(
    "a tree write that fails part way: the branch stays, the changed files are named",
    () => {
      const f = behind((a) => {
        write(a, "app.ts", "export const a = 2;\n");
        write(a, "sub/x.ts", "export const x = 1;\n");
      });
      NodeFS.mkdirSync(NodePath.join(f.b, "sub"));
      readOnly(NodePath.join(f.b, "sub"));
      return fetchAndMove(f).pipe(
        Effect.map(({ step }) => {
          expect(step).toMatchObject({
            moved: 0,
            detail: projectSyncPartialDetail("main", 1, "app.ts"),
          });
          expect(step.movedUnverified ?? false).toBe(false);
          expect(git(f.b, "rev-parse", "main")).toBe(f.was);
          expect(git(f.b, "symbolic-ref", "HEAD")).toBe("refs/heads/main");
          // Nothing is put back and no lock is left: the person sees the checkout as it is.
          expect(NodeFS.readFileSync(NodePath.join(f.b, "app.ts"), "utf8")).toBe(
            "export const a = 2;\n",
          );
          expect(lockFiles(f.b)).toEqual([]);
        }),
      );
    },
  );

  it.effect("a deletion Git only warned about: moved, and the file still here is named", () => {
    const f = twoMachines();
    commit(f.a, "keep/old.txt", "old\n");
    git(f.a, "push", "-q", "origin", "main");
    git(f.b, "pull", "-q", "--ff-only");
    const was = git(f.b, "rev-parse", "HEAD");
    git(f.a, "rm", "-q", "keep/old.txt");
    write(f.a, "app.ts", "export const a = 2;\n");
    git(f.a, "add", "-A");
    git(f.a, "commit", "-q", "-m", "drop the old file");
    git(f.a, "push", "-q", "origin", "main");
    const head = git(f.a, "rev-parse", "HEAD");
    readOnly(NodePath.join(f.b, "keep"));
    return fetchAndMove(f).pipe(
      Effect.map(({ step }) => {
        expect(git(f.b, "rev-parse", "main")).toBe(head);
        expect(step).toMatchObject({
          action: "fast-forward",
          moved: 1,
          detail: projectSyncFilesDifferDetail(1, "keep/old.txt"),
        });
        expect(NodeFS.existsSync(NodePath.join(f.b, "keep", "old.txt"))).toBe(true);
        expect(was).not.toBe(head);
      }),
    );
  });

  it.effect("another Git holding HEAD's lock: not moved, and its lock is left alone", () => {
    const f = behind();
    const lock = NodePath.join(f.b, ".git", "HEAD.lock");
    return withSync(f.b, (sync) =>
      Effect.gen(function* () {
        const fetched = yield* sync.fetch(one);
        NodeFS.writeFileSync(lock, "");
        const run = yield* sync.run({
          ...one,
          fetchId: fetched.fetchId,
          fastForward: [{ path: ".", otherBranch: null }],
          clone: [],
        });
        const step = run.repositories[0]!;
        expect(step).toMatchObject({ action: "none", reason: "refused", moved: 0 });
        expect(step.detail).toMatch(/^Git is busy in this checkout \(.+\), so it was not moved/);
        expect(projectSyncLockedDetail("x")).toBe(
          "Git is busy in this checkout (x), so it was not moved. Sync again.",
        );
        expect(NodeFS.existsSync(lock)).toBe(true);
        expect(git(f.b, "rev-parse", "HEAD")).toBe(f.was);
        NodeFS.rmSync(lock);
      }),
    );
  });

  /** Fetches B with a real runner, then moves it with `transaction` in place of Git's own. */
  const moveWith = async (f: ReturnType<typeof behind>, transaction: RefTransactionFactory) => {
    const fetched = newFetchRecord("project-guarded");
    const context: ProjectSync.SyncContext = {
      git: (cwd, args, options) => runGit(cwd, args, options),
      inUse: async () => null,
      fetched,
      transaction,
    };
    await ProjectSync.fetchAll(context, [{ path: ".", cwd: f.b }]);
    return ProjectSync.fastForwardRepository(context, { path: ".", cwd: f.b }, null);
  };

  it("a branch moved by someone else just before prepare: Git's old-value check declines", async () => {
    const f = behind();
    const step = await moveWith(f, (cwd, message) => {
      const real = refTransaction(cwd, message);
      return {
        ...real,
        prepare: (lines) => {
          git(f.b, "commit", "-q", "--allow-empty", "-m", "racing");
          return real.prepare(lines);
        },
      };
    });
    expect(step).toMatchObject({ moved: 0, detail: PROJECT_SYNC_CHANGED_HEAD_DETAIL });
    expect(git(f.b, "log", "-1", "--format=%s")).toBe("racing");
    expect(lockFiles(f.b)).toEqual([]);
  });

  it("a ref commit that fails: the branch stays, the moved files are named, no lock is left", async () => {
    const f = behind();
    const step = await moveWith(f, (cwd, message) => {
      const real = refTransaction(cwd, message);
      return {
        ...real,
        commit: async () => {
          await real.abort();
          return { ok: false, reason: "cannot lock ref 'refs/heads/main'" };
        },
      };
    });
    expect(step).toMatchObject({ moved: 0, detail: projectSyncPartialDetail("main", 1, "app.ts") });
    expect(step.movedUnverified ?? false).toBe(false);
    expect(git(f.b, "rev-parse", "main")).toBe(f.was);
    expect(lockFiles(f.b)).toEqual([]);
  });

  it("a commit whose answer is lost: no count, said as unverified, the branch as Git left it", async () => {
    const f = behind();
    const step = await moveWith(f, (cwd, message) => {
      const real = refTransaction(cwd, message);
      return {
        ...real,
        commit: async () => {
          await real.commit();
          throw new Error("Git ended without answering the commit.");
        },
      };
    });
    expect(step).toMatchObject({
      action: "fast-forward",
      moved: 0,
      movedUnverified: true,
      detail: PROJECT_SYNC_UNVERIFIED_DETAIL,
    });
    expect(git(f.b, "rev-parse", "main")).toBe(f.head);
  });
});

describe("a status that could not be read (D4-06, P3-09)", () => {
  it("is unread, never clean, with no branch or commit made up", async () => {
    const f = twoMachines();
    const [status] = await ProjectSync.statusOf(
      async (cwd, args, options) =>
        args[0] === "status"
          ? { code: 128, stdout: "", stderr: "fatal: unable to read the index" }
          : runGit(cwd, args, options),
      [{ path: ".", cwd: f.b }],
    );
    expect(status).toEqual({ path: ".", branch: null, head: null, clean: false, unread: true });
  });
});
