// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off - real clones of a local bare origin, real child processes and real file times.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterAll, afterEach, assert, beforeAll, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { listProcessCwds } from "./homeUsage/processCwds.ts";
import {
  type CloneDecision,
  type CloneSweepContext,
  cloneSweepLivePaths,
  cloneSweepRoots,
  decideClone,
  findClones,
  MERGED_CLONE_GRACE_MS,
  normalizeRemoteUrl,
  planCloneSweep,
  registeredRepositories,
  removeClone,
} from "./mergedCloneSweep.ts";

let root: string;
let origin: string;
let scratch: string;
let counter = 0;
const children: Array<NodeChildProcess.ChildProcess> = [];

const git = (cwd: string, ...args: ReadonlyArray<string>) =>
  NodeChildProcess.execFileSync(
    "git",
    ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.com", ...args],
    { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  ).trim();

/** Makes a clone look untouched for three hours: git's own files carry the age. */
function age(clone: string, ms = 3 * 60 * 60_000) {
  const at = (Date.now() - ms) / 1000;
  for (const name of ["HEAD", "index", "FETCH_HEAD", "ORIG_HEAD", NodePath.join("logs", "HEAD")]) {
    const file = NodePath.join(clone, ".git", name);
    if (NodeFS.existsSync(file)) NodeFS.utimesSync(file, at, at);
  }
}

/** A clone of the origin in its own dated scratch folder, as a review leaves it. */
function clone(prepare: (path: string) => void = () => {}, aged = true): string {
  counter += 1;
  const path = NodePath.join(scratch, `2026-11-0${(counter % 9) + 1}-review-${counter}`, "repo");
  NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
  git(NodePath.dirname(path), "clone", "--quiet", origin, path);
  prepare(path);
  if (aged) age(path);
  return path;
}

const context = (overrides: Partial<CloneSweepContext> = {}): CloneSweepContext => ({
  registeredRemotes: new Set([normalizeRemoteUrl(origin)]),
  livePaths: [],
  processCwds: [],
  now: Date.now(),
  foldCase: false,
  openFilesIn: () => Promise.resolve(false),
  ...overrides,
});

const decide = (path: string, overrides: Partial<CloneSweepContext> = {}) =>
  decideClone({ path, root: scratch, kind: "clone" }, context(overrides));

beforeAll(() => {
  root = NodeFS.realpathSync(NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "clone-sweep-")));
  origin = NodePath.join(root, "origin.git");
  scratch = NodePath.join(root, "scratch");
  NodeFS.mkdirSync(scratch);
  git(root, "init", "--quiet", "--bare", "--initial-branch=main", origin);
  const seed = NodePath.join(root, "seed");
  git(root, "clone", "--quiet", origin, seed);
  NodeFS.writeFileSync(NodePath.join(seed, "package.json"), JSON.stringify({ name: "widgets" }));
  NodeFS.writeFileSync(NodePath.join(seed, ".gitignore"), "*.log\noutside-link\n");
  NodeFS.writeFileSync(NodePath.join(seed, "readme.md"), "one\n");
  git(seed, "add", "-A");
  git(seed, "commit", "--quiet", "-m", "first");
  git(seed, "push", "--quiet", "origin", "HEAD:main");
  // A pushed branch whose pull request is still open: not in main.
  git(seed, "checkout", "--quiet", "-b", "feature");
  NodeFS.writeFileSync(NodePath.join(seed, "feature.md"), "wip\n");
  git(seed, "add", "-A");
  git(seed, "commit", "--quiet", "-m", "feature");
  git(seed, "push", "--quiet", "origin", "feature");
});

afterEach(() => {
  for (const child of children.splice(0)) child.kill("SIGKILL");
});

afterAll(() => {
  NodeFS.rmSync(root, { recursive: true, force: true });
});

describe("merged clone sweep", () => {
  it("removes a merged, clean, unused clone and its emptied dated folder, nothing else", async () => {
    const path = clone();
    const sibling = clone();
    const decision = await decide(path);
    assert.strictEqual(decision.action, "remove");
    assert.include(decision.reason, "merged: HEAD is in origin/main");
    assert.strictEqual(decision.branch, "main");
    // Deciding touched nothing: the clone is as old as before.
    assert.strictEqual((await decide(path)).action, "remove");

    const removal = await removeClone(decision, context());
    assert.deepStrictEqual(removal, { result: "removed", removedParent: NodePath.dirname(path) });
    assert.isFalse(NodeFS.existsSync(NodePath.dirname(path)));
    assert.isTrue(NodeFS.existsSync(sibling));
    assert.isTrue(NodeFS.existsSync(scratch));
    assert.isTrue(NodeFS.existsSync(origin));
  });

  it("keeps the dated folder when something else is in it", async () => {
    const path = clone();
    NodeFS.writeFileSync(NodePath.join(NodePath.dirname(path), "notes.md"), "review notes");
    const removal = await removeClone(await decide(path), context());
    assert.deepStrictEqual(removal, { result: "removed" });
    assert.isTrue(NodeFS.existsSync(NodePath.join(NodePath.dirname(path), "notes.md")));
  });

  it("keeps a clone with a commit that is on no remote", async () => {
    const path = clone((repo) => {
      NodeFS.writeFileSync(NodePath.join(repo, "readme.md"), "two\n");
      git(repo, "commit", "--quiet", "-am", "local only");
    });
    const decision = await decide(path);
    assert.strictEqual(decision.action, "keep");
    assert.strictEqual(decision.reason, "has commits that are on no remote");
    // The same on a branch that is not checked out.
    const other = clone((repo) => {
      git(repo, "checkout", "--quiet", "-b", "side");
      NodeFS.writeFileSync(NodePath.join(repo, "readme.md"), "side\n");
      git(repo, "commit", "--quiet", "-am", "side work");
      git(repo, "checkout", "--quiet", "main");
    });
    assert.strictEqual((await decide(other)).reason, "has commits that are on no remote");
  });

  it("keeps a clone with a modified file", async () => {
    const path = clone((repo) =>
      NodeFS.writeFileSync(NodePath.join(repo, "readme.md"), "edited\n"),
    );
    const decision = await decide(path);
    assert.strictEqual(decision.action, "keep");
    assert.strictEqual(decision.reason, "uncommitted or untracked files (1)");
  });

  it("keeps a clone with an untracked file", async () => {
    const path = clone((repo) =>
      NodeFS.writeFileSync(NodePath.join(repo, "findings.md"), "notes\n"),
    );
    const decision = await decide(path);
    assert.strictEqual(decision.action, "keep");
    assert.strictEqual(decision.reason, "uncommitted or untracked files (1)");
    // An ignored file alone does not keep it.
    const ignored = clone((repo) =>
      NodeFS.writeFileSync(NodePath.join(repo, "run.log"), "output\n"),
    );
    assert.strictEqual((await decide(ignored)).action, "remove");
  });

  it("keeps a clone with a stash", async () => {
    const path = clone((repo) => {
      NodeFS.writeFileSync(NodePath.join(repo, "readme.md"), "stashed\n");
      git(repo, "stash", "--quiet");
    });
    const decision = await decide(path);
    assert.strictEqual(decision.action, "keep");
    assert.strictEqual(decision.reason, "has a stash");
  });

  it("keeps a clone a thread, project or agent session is bound to, or to a folder inside it", async () => {
    const path = clone();
    const livePaths = cloneSweepLivePaths(
      {
        projects: [],
        threads: [
          {
            kind: "thread",
            threadId: "thread-1",
            projectId: null,
            title: null,
            worktreePath: NodePath.join(path, "packages", "app"),
            path: NodePath.join(path, "packages", "app"),
            paths: [NodePath.join(path, "packages", "app")],
            archived: false,
            settled: false,
            deleted: false,
            cleanupPending: false,
            cleanupFailed: false,
          },
        ],
        sessions: [],
      },
      [],
    );
    const decision = await decide(path, { livePaths });
    assert.strictEqual(decision.action, "keep");
    assert.strictEqual(decision.reason, "in use by thread thread-1 (open)");
    // An archived thread no longer keeps it; a project's own checkout always does.
    const archived = cloneSweepLivePaths(
      { projects: [], threads: [{ ...bindingOf(path), archived: true }], sessions: [] },
      [],
    );
    assert.strictEqual((await decide(path, { livePaths: archived })).action, "remove");
    const checkout = cloneSweepLivePaths({ projects: [], threads: [], sessions: [] }, [path]);
    assert.include(
      (await decide(path, { livePaths: checkout })).reason,
      "in use by project checkout",
    );
    // A folder around the clone (the scratch folder as a project root) binds nothing in it.
    const around = [{ paths: [scratch], owner: `project ${scratch}` }];
    assert.strictEqual((await decide(path, { livePaths: around })).action, "remove");
  });

  it.effect("keeps a clone a running process works in", () =>
    Effect.gen(function* () {
      const path = clone();
      const child = NodeChildProcess.spawn(
        process.execPath,
        ["-e", "setTimeout(() => {}, 60000)"],
        {
          cwd: path,
          stdio: "ignore",
        },
      );
      children.push(child);
      yield* Effect.promise(() => new Promise((resolve) => child.once("spawn", resolve)));
      // oxlint-disable-next-line studio/no-global-process-runtime -- the real host's process list.
      const processCwds = yield* listProcessCwds(process.platform);
      const decision = yield* Effect.promise(() => decide(path, { processCwds }));
      assert.strictEqual(decision.action, "keep");
      // Where processes cannot be listed (Windows), every clone is kept.
      assert.strictEqual(
        decision.reason,
        processCwds === null ? "cannot list running processes" : `a process is working in ${path}`,
      );
    }),
  );

  it("keeps a clone when open files cannot be ruled out", async () => {
    const path = clone();
    const open = await decide(path, { openFilesIn: () => Promise.resolve(true) });
    assert.strictEqual(open.reason, "a process has a file open in it");
    const unknown = await decide(path, { openFilesIn: () => Promise.resolve(null) });
    assert.strictEqual(unknown.reason, "cannot check for open files");
    assert.strictEqual(
      (await decide(path, { processCwds: null })).reason,
      "cannot list running processes",
    );
  });

  it("keeps a clone inside the grace period", async () => {
    const path = clone(() => {}, false);
    const decision = await decide(path);
    assert.strictEqual(decision.action, "keep");
    assert.match(decision.reason, /^changed \d+ min ago, inside the 120 min grace period$/);
    age(path, MERGED_CLONE_GRACE_MS - 60_000);
    assert.strictEqual((await decide(path)).action, "keep");
    age(path, MERGED_CLONE_GRACE_MS + 60_000);
    assert.strictEqual((await decide(path)).action, "remove");
  });

  it("keeps a clone whose pull request is open, and removes it once that pull request merged", async () => {
    const path = clone((repo) => git(repo, "checkout", "--quiet", "feature"));
    const head = git(path, "rev-parse", "HEAD");
    const asked: Array<unknown> = [];
    const open = await decide(path, {
      mergedPullRequest: (input) => {
        asked.push(input);
        return Promise.resolve(null);
      },
    });
    assert.strictEqual(open.action, "keep");
    assert.strictEqual(
      open.reason,
      "not merged: HEAD is not in origin/main and no merged pull request has this head",
    );
    assert.deepStrictEqual(asked, [{ clone: path, branch: "feature", head }]);
    // Without gh only ancestry counts.
    assert.include((await decide(path)).reason, "pull requests were not checked");

    const merged = await decide(path, { mergedPullRequest: () => Promise.resolve(12) });
    assert.strictEqual(merged.action, "remove");
    assert.include(merged.reason, "merged: pull request #12");
  });

  it("keeps clones of repositories that are not a registered project's", async () => {
    const path = clone();
    const decision = await decide(path, {
      registeredRemotes: new Set(["github.com/acme/other"]),
    });
    assert.strictEqual(decision.action, "keep");
    assert.strictEqual(decision.reason, "origin is not a registered project's repository");
  });

  it("removes nothing in a dry run and lists every clone with its reason", async () => {
    const merged = clone();
    const dirty = clone((repo) => NodeFS.writeFileSync(NodePath.join(repo, "notes.md"), "x"));
    const decisions = await planCloneSweep([scratch], context());
    const byPath = new Map(decisions.map((decision) => [decision.path, decision]));
    assert.strictEqual(byPath.get(merged)?.action, "remove");
    assert.strictEqual(byPath.get(dirty)?.action, "keep");
    assert.isTrue(decisions.every((decision) => decision.reason.length > 0));
    assert.isTrue(NodeFS.existsSync(NodePath.join(merged, ".git")));
    assert.isTrue(NodeFS.existsSync(NodePath.join(dirty, "notes.md")));
  });

  it("decides again right before removing and leaves a clone that changed", async () => {
    const path = clone();
    const decision = await decide(path);
    assert.strictEqual(decision.action, "remove");
    NodeFS.writeFileSync(NodePath.join(path, "late.md"), "written after the plan");
    const removal = await removeClone(decision, context());
    assert.strictEqual(removal.result, "skipped");
    assert.include(removal.detail ?? "", "uncommitted or untracked files");
    assert.isTrue(NodeFS.existsSync(NodePath.join(path, "late.md")));
  });

  it("never follows a symlink out of the clone, and never enters a clone through one", async () => {
    const outside = NodePath.join(root, "outside");
    NodeFS.mkdirSync(outside, { recursive: true });
    NodeFS.writeFileSync(NodePath.join(outside, "keep.txt"), "not the clone's");
    const path = clone((repo) =>
      NodeFS.symlinkSync(outside, NodePath.join(repo, "outside-link"), "dir"),
    );
    const removal = await removeClone(await decide(path), context());
    assert.strictEqual(removal.result, "removed");
    assert.isFalse(NodeFS.existsSync(path));
    assert.strictEqual(
      NodeFS.readFileSync(NodePath.join(outside, "keep.txt"), "utf8"),
      "not the clone's",
    );

    // A link in the scratch folder to a clone elsewhere is not a candidate.
    const elsewhere = NodePath.join(root, "elsewhere");
    git(root, "clone", "--quiet", origin, elsewhere);
    age(elsewhere);
    NodeFS.symlinkSync(elsewhere, NodePath.join(scratch, "linked-clone"), "dir");
    const found = await findClones([scratch]);
    assert.isFalse(found.some((candidate) => candidate.path.includes("linked-clone")));
    assert.isFalse(found.some((candidate) => candidate.path === elsewhere));
    // Asked directly, the link is refused too.
    const forced: CloneDecision = {
      path: NodePath.join(scratch, "linked-clone"),
      root: scratch,
      kind: "clone",
      action: "remove",
      reason: "",
      origin: null,
      head: null,
      branch: null,
    };
    assert.strictEqual((await removeClone(forced, context())).result, "skipped");
    assert.isTrue(NodeFS.existsSync(NodePath.join(elsewhere, ".git")));
  });

  it("only reports a source tree without .git, and keeps linked worktrees", async () => {
    const exported = NodePath.join(scratch, "2026-11-01-export", "widgets-src");
    NodeFS.mkdirSync(exported, { recursive: true });
    NodeFS.writeFileSync(
      NodePath.join(exported, "package.json"),
      JSON.stringify({ name: "widgets" }),
    );
    const linked = NodePath.join(scratch, "2026-11-01-export", "linked");
    NodeFS.mkdirSync(linked);
    NodeFS.writeFileSync(
      NodePath.join(linked, ".git"),
      "gitdir: /somewhere/.git/worktrees/linked\n",
    );

    const decisions = await planCloneSweep([scratch], context(), { sourceTreeNames: ["widgets"] });
    const tree = decisions.find((decision) => decision.path === exported)!;
    assert.deepStrictEqual(
      { kind: tree.kind, action: tree.action },
      { kind: "source-tree", action: "report" },
    );
    assert.strictEqual((await removeClone(tree, context())).result, "skipped");
    assert.isTrue(NodeFS.existsSync(exported));
    const worktree = decisions.find((decision) => decision.path === linked)!;
    assert.strictEqual(worktree.action, "keep");
    assert.include(worktree.reason, "linked worktree");
  });

  it("finds clones only to a bounded depth and never inside node_modules or another clone", async () => {
    const deep = NodePath.join(scratch, "a", "b", "c", "too-deep");
    NodeFS.mkdirSync(NodePath.join(deep, ".git"), { recursive: true });
    const vendored = NodePath.join(scratch, "pkg", "node_modules", "dep");
    NodeFS.mkdirSync(NodePath.join(vendored, ".git"), { recursive: true });
    const outer = clone();
    NodeFS.mkdirSync(NodePath.join(outer, "nested", ".git"), { recursive: true });
    const found = (await findClones([scratch])).map((candidate) => candidate.path);
    assert.include(found, outer);
    assert.notInclude(found, deep);
    assert.notInclude(found, vendored);
    assert.notInclude(found, NodePath.join(outer, "nested"));
  });

  it("reads registered repositories from projects and compares remotes by one spelling", async () => {
    const checkout = NodePath.join(root, "seed");
    const registered = await registeredRepositories([
      {
        workspace_root: checkout,
        workspace_settings_json: JSON.stringify({
          environment: {
            additionalFolders: [],
            repositories: [{ url: "https://github.com/Acme/App.git", localPath: null }],
          },
        }),
      },
      { workspace_root: NodePath.join(root, "not-a-repository"), workspace_settings_json: null },
    ]);
    assert.isTrue(registered.remotes.has(normalizeRemoteUrl(origin)));
    assert.isTrue(registered.remotes.has("github.com/acme/app"));
    assert.deepStrictEqual(registered.checkouts, [checkout]);
    assert.deepStrictEqual(registered.sourceTreeNames, ["widgets"]);
    for (const spelling of [
      "https://github.com/acme/app",
      "git@github.com:Acme/App.git",
      "ssh://git@github.com/acme/app.git/",
      "https://token@github.com/acme/app.git",
    ])
      assert.strictEqual(normalizeRemoteUrl(spelling), "github.com/acme/app");
    assert.strictEqual(normalizeRemoteUrl("/srv/git/app.git/"), "/srv/git/app");
    const roots = cloneSweepRoots("/home/app", ["/work/project"]);
    assert.include(roots, NodePath.join("/home/app", "scratch"));
    assert.include(roots, NodePath.join("/work/project", "scratch"));
    assert.include(roots, NodePath.join("/work/project", ".artifacts"));
  });
});

function bindingOf(path: string) {
  return {
    kind: "thread" as const,
    threadId: "thread-2",
    projectId: null,
    title: null,
    worktreePath: path,
    path,
    paths: [path],
    archived: false,
    settled: false,
    deleted: false,
    cleanupPending: false,
    cleanupFailed: false,
  };
}
