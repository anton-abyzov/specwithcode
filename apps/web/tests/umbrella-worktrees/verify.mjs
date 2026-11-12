#!/usr/bin/env node
// End to end on a real umbrella, with real Git and the server's own launch, add and
// cleanup code (no browser, no provider, no account): every way a thread gets its
// repositories lands where the app says it does.
// Usage: node apps/web/tests/umbrella-worktrees/verify.mjs [/absolute/owned/report-dir]
import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { addIncrement, git, makeUmbrella } from "./fixture.mjs";

const assert = NodeAssert.default;
const fs = NodeFS;
const path = NodePath;
const { createRequire } = NodeModule;
const { fileURLToPath, pathToFileURL } = NodeURL;

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const server = (file) => import(pathToFileURL(path.join(repo, "apps/server/src", file)).href);
const serverRequire = createRequire(path.join(repo, "apps/server/package.json"));
const dependency = (name) => import(pathToFileURL(serverRequire.resolve(name)).href);

const Effect = await dependency("effect/Effect");
const Layer = await dependency("effect/Layer");
const NodeServices = await dependency("@effect/platform-node/NodeServices");
const NodeSqliteClient = await import(
  pathToFileURL(path.join(repo, "packages/shared/src/nodeSqliteClient.ts")).href
);
const ServerConfig = await server("config.ts");
const TerminalManager = await server("terminal/Manager.ts");
const GitVcsDriver = await server("vcs/GitVcsDriver.ts");
const VcsDriverRegistry = await server("vcs/VcsDriverRegistry.ts");
const VcsProcess = await server("vcs/VcsProcess.ts");
const GitManager = await server("git/GitManager.ts");
const GitWorkflowService = await server("git/GitWorkflowService.ts");
const { createWorktreeSet, resolveWorktreeSetRepositories, removeWorktreeSetMembers } =
  await server("git/worktreeSetGit.ts");
const { readWorktreeSet } = await server("worktreeSet.ts");
const { addRepositoryToThread, readThreadRepositories } = await server(
  "project/ThreadRepositories.ts",
);
const { discoverProjectRepositories } = await server("project/ProjectRepositoryDiscovery.ts");
const {
  emptyThreadFolderLaunch,
  incrementWorktreeSetRepositories,
  launchWorkspaceDefault,
  WORKTREE_OFF_NOTICE,
} = await server("mcp/toolkits/project/launchWorkspace.ts");
// What the composer's launch carries (`composerRepositoryLaunch`, covered by
// BranchToolbar.logic.test.ts): nothing for "Agent decides", else the picked paths and,
// for exactly one, its base branch. The web module cannot load outside the bundler.
const composerLaunch = (pick) =>
  pick.repositories.length === 0
    ? {}
    : {
        repositories: pick.repositories,
        ...(pick.repositories.length === 1 && pick.baseBranch !== null
          ? { repositoryBaseBranch: pick.baseBranch }
          : {}),
      };

// Real Git behind the server's workflow service, as the app wires it; no terminals are open.
const driverLayer = GitVcsDriver.layer.pipe(
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "umbrella-worktrees-" })),
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })),
);
const gitLayer = GitWorkflowService.layer.pipe(
  Layer.provide(
    VcsDriverRegistry.layer.pipe(
      Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "umbrella-worktrees-" })),
      Layer.provide(VcsProcess.layer),
    ),
  ),
  Layer.provide(
    Layer.effect(
      GitManager.GitManager,
      Effect.map(GitVcsDriver.GitVcsDriver, (driver) =>
        GitManager.GitManager.of({
          createWorktree: (input) => driver.createWorktree(input),
          localStatus: (input) =>
            driver.statusDetailsLocal(input.cwd).pipe(
              Effect.map((status) => ({
                refName: status.branch,
                hasWorkingTreeChanges: status.hasWorkingTreeChanges,
              })),
            ),
        }),
      ),
    ),
  ),
  Layer.provide(
    Layer.mock(TerminalManager.TerminalManager)({
      subscribeMetadata: (listener) =>
        listener({ type: "snapshot", terminals: [] }).pipe(Effect.as(() => {})),
    }),
  ),
);
const layer = Layer.provideMerge(gitLayer, driverLayer);
const run = (effect) => Effect.runPromise(effect.pipe(Effect.provide(layer), Effect.scoped));
const refused = (effect) => run(effect.pipe(Effect.flip));

const checks = [];
const check = (name, detail) => {
  checks.push({ name, ...detail });
  console.log(`ok  ${name}`);
};
const branchOf = (folder) => git(folder, "symbolic-ref", "--short", "HEAD");
const posix = (value) => value.split(path.sep).join("/");
const ok = {
  level: "ok",
  freeBytes: 200e9,
  totalBytes: 500e9,
  checkedAt: "2026-11-12T00:00:00.000Z",
};

const umbrella = makeUmbrella({ extra: 7 });
const project = { id: "umbrella", workspaceRoot: umbrella.root };
let threads = 0;
/** What ThreadLaunchService does with a worktree strategy: one thread folder on one branch. */
async function launch(strategy, increment) {
  const { workspaceStrategy, notice } = await emptyThreadFolderLaunch(strategy, project);
  const branch = `thread/${++threads}`;
  const folder = path.join(umbrella.worktrees, `thread-${threads}`);
  const members = await run(
    resolveWorktreeSetRepositories(umbrella.root, [], workspaceStrategy.repositories ?? []),
  );
  await run(
    createWorktreeSet({
      folder,
      members,
      branch,
      projectRoot: umbrella.root,
      baseRef: workspaceStrategy.baseRef,
      memberBaseRef: members.length === 1 ? workspaceStrategy.repositoryBaseRef : undefined,
      startFromOrigin: false,
      submodules: null,
    }),
  );
  return { folder, branch, notice, workspaceStrategy, increment };
}
const add = (thread, repository, overrides = {}) =>
  addRepositoryToThread({
    threadId: "thread",
    worktreePath: thread.folder,
    branch: thread.branch,
    usesWorktrees: true,
    projectRoot: umbrella.root,
    checkouts: [],
    repository,
    startFromOrigin: false,
    submodules: null,
    storage: ok,
    addedBy: "agent",
    ...overrides,
  });

try {
  // The folder's repositories are found with nothing saved.
  const found = await discoverProjectRepositories({
    projectId: project.id,
    workspaceRoot: umbrella.root,
    refresh: true,
  });
  assert.equal(found.found.length, 9);
  assert.equal(found.separateClones, true);
  assert.deepEqual(
    found.found.slice(0, 2).map((row) => [row.relativePath, row.branch, row.state]),
    [
      ["repositories/acme/api", "main", "available"],
      ["repositories/acme/extra-1", "main", "available"],
    ],
  );
  const web = found.found.find((row) => row.name === "web");
  assert.deepEqual([web.branch, web.defaultBranch], [null, "main"]);
  check("every clone in the folder is available with nothing saved", { repositories: 9 });

  // 1. A launch naming nothing starts with an empty folder of its own.
  const nothing = await launch({ type: "worktree", baseRef: "main" });
  assert.deepEqual(nothing.workspaceStrategy.repositories, []);
  assert.deepEqual(fs.readdirSync(nothing.folder), []);
  assert.deepEqual((await run(readWorktreeSet(nothing.folder))).members, []);
  assert.ok(nothing.notice.includes("studio_worktree_add_repository"));
  assert.ok(nothing.notice.includes("- api: repositories/acme/api"));
  assert.ok(nothing.notice.includes(umbrella.root));
  check("a launch naming nothing starts in an empty folder", { folder: nothing.folder });

  // 2. The agent adds a repository by relative path: same path, same turn, nothing installed.
  const added = await run(add(nothing, "repositories/acme/api"));
  const apiWorktree = path.join(nothing.folder, "repositories", "acme", "api");
  assert.equal(added.repositoryPath, apiWorktree);
  assert.equal(branchOf(apiWorktree), nothing.branch);
  assert.deepEqual(
    [added.baseRef, added.dependencies, added.alreadyMember],
    ["main", "not_installed", false],
  );
  assert.ok(added.note.includes("Dependencies not installed"));
  assert.ok(!fs.existsSync(path.join(apiWorktree, "node_modules")));
  // A worktree shares its clone's objects: no second clone.
  assert.ok(fs.statSync(path.join(apiWorktree, ".git")).isFile());
  // No branch checked out: cut from its default branch on origin, and the result says so.
  const detached = await run(add(nothing, "repositories/acme/web"));
  assert.equal(detached.baseRef, "origin/main");
  assert.equal(branchOf(path.join(nothing.folder, "repositories", "acme", "web")), nothing.branch);
  // Adding one the thread has returns that member.
  const again = await run(add(nothing, "repositories/acme/api"));
  assert.deepEqual([again.alreadyMember, again.members.length], [true, 2]);
  const held = await run(readThreadRepositories(nothing.folder));
  assert.deepEqual(
    held.map((row) => [row.relativePath, row.baseRef, row.addedBy, row.dependencies, row.changed]),
    [
      ["repositories/acme/api", "main", "agent", "not_installed", false],
      ["repositories/acme/web", "origin/main", "agent", "not_installed", false],
    ],
  );
  // The project folder's clones were not touched.
  assert.equal(branchOf(umbrella.api), "main");
  assert.equal(git(umbrella.api, "status", "--porcelain"), "");
  check("studio_worktree_add_repository adds a worktree at the same path", {
    api: added.baseRef,
    web: detached.baseRef,
  });

  // 3. A launch naming both gets both.
  const both = await launch({
    type: "worktree",
    baseRef: "main",
    repositories: ["repositories/acme/api", "repositories/acme/web"],
  });
  assert.equal(both.notice, null);
  for (const name of ["api", "web"])
    assert.equal(branchOf(path.join(both.folder, "repositories", "acme", name)), both.branch);
  check("a launch naming both repositories gets both", { folder: both.folder });

  // 4. An increment touching both gets both, saved in Environment or not.
  const increment = addIncrement(umbrella.root, "0007-both", [
    "repositories/acme/api",
    "repositories/acme/web",
  ]);
  const incrementRepositories = await incrementWorktreeSetRepositories({
    workspaceRoot: umbrella.root,
    checkouts: [],
    increment,
  });
  assert.deepEqual(incrementRepositories, ["repositories/acme/api", "repositories/acme/web"]);
  const forIncrement = await launch(
    { type: "worktree", baseRef: "main", repositories: incrementRepositories },
    increment,
  );
  assert.deepEqual(
    (await run(readWorktreeSet(forIncrement.folder))).members.map((member) =>
      posix(member.relativePath),
    ),
    incrementRepositories,
  );
  check("an increment touching both gets both", { repositories: incrementRepositories });

  // 5. The composer: "Agent decides" sends nothing; a pick sends the repository and its base.
  const decided = await launch({
    type: "worktree",
    baseRef: "main",
    ...composerLaunch({ repositories: [], baseBranch: null }),
  });
  assert.deepEqual(decided.workspaceStrategy.repositories, []);
  assert.deepEqual(fs.readdirSync(decided.folder), []);
  const picked = composerLaunch({ repositories: ["repositories/acme/api"], baseBranch: "release" });
  const withPick = await launch({
    type: "worktree",
    baseRef: "main",
    repositories: picked.repositories,
    repositoryBaseRef: picked.repositoryBaseBranch,
  });
  const pickedWorktree = path.join(withPick.folder, "repositories", "acme", "api");
  assert.equal(branchOf(pickedWorktree), withPick.branch);
  assert.equal(git(pickedWorktree, "rev-parse", "HEAD"), git(umbrella.api, "rev-parse", "release"));
  assert.deepEqual(fs.readdirSync(path.join(withPick.folder, "repositories", "acme")), ["api"]);
  check("the composer launches with Agent decides and with a pick", { pick: picked });

  // 6. Limits: a ninth repository and an add on a low disk are refused, changing nothing.
  const full = await launch({ type: "worktree", baseRef: "main" });
  const eight = [
    "api",
    "extra-1",
    "extra-2",
    "extra-3",
    "extra-4",
    "extra-5",
    "extra-6",
    "extra-7",
  ];
  for (const name of eight) await run(add(full, `repositories/acme/${name}`));
  const ninth = await refused(add(full, "repositories/acme/web"));
  assert.equal(ninth.code, "invalid_request");
  assert.ok(ninth.message.includes("the most a thread can hold (8)"));
  assert.equal((await run(readWorktreeSet(full.folder))).members.length, 8);
  assert.ok(!fs.existsSync(path.join(full.folder, "repositories", "acme", "web")));
  const lowDisk = await refused(
    add(decided, "repositories/acme/api", { storage: { ...ok, level: "low", freeBytes: 1.2e9 } }),
  );
  assert.ok(lowDisk.message.includes("Only 1.2 GB is free"));
  assert.deepEqual(fs.readdirSync(decided.folder), []);
  check("a ninth repository and a low-disk add are refused", {
    ninth: ninth.message,
    lowDisk: lowDisk.message,
  });

  // 7. Use worktrees off is unchanged: the thread works in the project folder, and cannot add.
  const off = {
    settings: { defaultThreadEnvMode: "local" },
    sources: { defaultThreadEnvMode: "project" },
  };
  assert.deepEqual(launchWorkspaceDefault({ resolved: off, currentBranch: "main" }), {
    type: "root",
  });
  assert.ok(WORKTREE_OFF_NOTICE.includes("Use worktrees is off"));
  const inFolder = await refused(
    add({ folder: null, branch: null }, "repositories/acme/api", { usesWorktrees: false }),
  );
  assert.equal(inFolder.code, "not_in_worktree");
  assert.ok(inFolder.message.includes("Use worktrees is off"));
  // With it on, a thread that works in the project folder is told the fix.
  const noFolder = await refused(add({ folder: null, branch: null }, "repositories/acme/api"));
  assert.ok(noFolder.message.includes("studio_worktree_handoff"));
  check("Use worktrees off keeps the thread in the project folder", {});

  // Cleanup: an empty thread folder goes with its manifest.
  assert.deepEqual(
    await run(removeWorktreeSetMembers({ folder: decided.folder, members: [] })),
    [],
  );
  assert.ok(!fs.existsSync(decided.folder));
  assert.equal(await run(readWorktreeSet(decided.folder)), null);
  check("an empty thread folder is removed with its manifest", {});
} finally {
  umbrella.remove();
}
const receipt = { fixture: "real umbrella with real Git; no browser, provider or account", checks };
if (process.argv[2]) {
  fs.mkdirSync(process.argv[2], { recursive: true });
  fs.writeFileSync(
    path.join(process.argv[2], "umbrella-worktrees-receipt.json"),
    `${JSON.stringify(receipt, null, 2)}\n`,
  );
}
console.log(`${checks.length} checks passed`);
