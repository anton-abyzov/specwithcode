import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { ProjectId, type ProjectEnvironmentSettings } from "@specweave-studio/contracts";
import * as ProcessRunner from "../processRunner.ts";
import { previewWorkspaceImport } from "./ProjectEnvironmentImport.ts";

const layer = ProcessRunner.layer.pipe(Layer.provideMerge(NodeServices.layer));
const setup = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  // Native separators: approvals are compared with the canonical folders.
  const path = yield* Path.Path;
  const runner = yield* ProcessRunner.ProcessRunner;
  const root = yield* fs
    .makeTempDirectoryScoped({ prefix: "studio-import-" })
    .pipe(Effect.flatMap((p) => fs.realPath(p)));
  const main = path.join(root, "workspace");
  yield* fs.makeDirectory(path.join(main, ".specweave"), { recursive: true });
  const git = (cwd: string, args: string[]) =>
    runner
      .run({
        command: "git",
        cwd,
        args,
        env: {
          ...process.env,
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_TERMINAL_PROMPT: "0",
        },
      })
      .pipe(Effect.tap((result) => Effect.sync(() => assert.equal(result.code, 0))));
  const repo = (name: string, url = `https://github.com/team/${name}`) =>
    Effect.gen(function* () {
      const folder = path.join(main, name);
      yield* fs.makeDirectory(folder);
      yield* git(folder, ["init"]);
      yield* git(folder, ["remote", "add", "origin", url]);
      yield* fs.writeFileString(path.join(folder, "untracked.txt"), "retained bytes\n");
      return folder;
    });
  const config = (repos: unknown[]) =>
    fs.writeFileString(
      path.join(main, ".specweave", "config.json"),
      JSON.stringify({ workspace: { repos } }),
    );
  const preview = (
    environment: ProjectEnvironmentSettings = { additionalFolders: [], repositories: [] },
    selectedRoot = main,
  ) =>
    previewWorkspaceImport({
      projectId: ProjectId.make("stable-project"),
      workspaceRoot: main,
      root: selectedRoot,
      revision: 7,
      environment,
    });
  return { fs, path, root, main, git, repo, config, preview };
});
it.layer(layer, { excludeTestServices: true })("workspace import preview", (it) => {
  it.effect("matches CLI identities for uppercase suffixes, GitHub casing and SSH ports", () =>
    Effect.gen(function* () {
      const x = yield* setup;
      const cases = [
        ["default-port", "ssh://git@GitHub.com:22/Org/Repo.GIT", "github.com/org/repo"],
        ["custom-port", "ssh://git@GitHub.com:2222/Org/Repo.GIT", "github.com:2222/org/repo"],
        ["other-host", "ssh://git@git.example:2222/Org/Repo.GIT", "git.example:2222/Org/Repo"],
      ];
      for (const [id, url] of cases) yield* x.repo(id!, url!);
      yield* x.config(cases.map(([id, , identity]) => ({ id, path: id, identity })));
      assert.deepEqual(
        (yield* x.preview()).repositories.map((repo) => repo.status),
        ["add", "add", "add"],
      );
    }),
  );
  it.effect(
    "inspects the selected checkout despite inherited Git directory and config overrides",
    () =>
      Effect.gen(function* () {
        const x = yield* setup;
        const selected = yield* x.repo("selected");
        const foreign = yield* x.repo("foreign");
        yield* x.config([
          { id: "selected", path: "selected", identity: "github.com/team/selected" },
        ]);
        const injected = {
          GIT_DIR: x.path.join(foreign, ".git"),
          GIT_WORK_TREE: selected,
          GIT_COMMON_DIR: x.path.join(foreign, ".git"),
          GIT_CONFIG_COUNT: "1",
          GIT_CONFIG_KEY_0: "remote.origin.url",
          GIT_CONFIG_VALUE_0: "https://github.com/foreign/spoofed",
        };
        const previous = Object.fromEntries(
          Object.keys(injected).map((key) => [key, process.env[key]]),
        );
        const result = yield* Effect.acquireUseRelease(
          Effect.sync(() => Object.assign(process.env, injected)),
          () => x.preview(),
          () =>
            Effect.sync(() => {
              for (const [key, value] of Object.entries(previous)) {
                if (value === undefined) delete process.env[key];
                else process.env[key] = value;
              }
            }),
        );
        assert.equal(result.repositories[0]!.status, "add");
        assert.equal(result.repositories[0]!.url, "https://github.com/team/selected");
        assert.equal(result.repositories[0]!.path, selected);
      }),
  );
  it.effect(
    "adopts flat paths, preserves existing IDs and distinguishes owners and checkouts",
    () =>
      Effect.gen(function* () {
        const x = yield* setup;
        const a = yield* x.repo("a", "git@github.com:owner-a/common.git");
        const b = yield* x.repo("b", "https://github.com/owner-b/common");
        const c = yield* x.repo("c", "https://github.com/owner-a/common");
        yield* x.config([
          { id: "old-config-id", path: "a", identity: "github.com/owner-a/common" },
          { id: "owner-b-common", path: b, sync: { github: { owner: "owner-b", repo: "common" } } },
          { id: "owner-a-clone", path: "c" },
        ]);
        const before = (yield* x.git(a, ["status", "--porcelain=v1"])).stdout;
        const preview = yield* x.preview({
          additionalFolders: [],
          repositories: [
            { id: "existing-local-id", url: "https://github.com/owner-a/common", localPath: a },
          ],
        });
        assert.isTrue(preview.canApply);
        assert.deepEqual(
          preview.repositories.map((r) => [r.id, r.status]),
          [
            ["existing-local-id", "existing"],
            ["owner-b-common", "add"],
            ["owner-a-clone", "add"],
          ],
        );
        assert.deepEqual(
          preview.environment.repositories.map((r) => r.localPath),
          [a, b, c],
        );
        assert.equal((yield* x.git(a, ["status", "--porcelain=v1"])).stdout, before);
        assert.equal(
          yield* x.fs.readFileString(x.path.join(a, "untracked.txt")),
          "retained bytes\n",
        );
        assert.isFalse(yield* x.fs.exists(x.path.join(a, ".specweave")));
        const repeated = yield* x.preview(preview.environment);
        assert.deepEqual(
          repeated.repositories.map((r) => r.status),
          ["existing", "existing", "existing"],
        );
      }),
  );
  it.effect("requires an existing grant for a sibling checkout and never adds access", () =>
    Effect.gen(function* () {
      const x = yield* setup;
      const original = yield* x.repo("outside");
      const outside = x.path.join(x.root, "outside");
      yield* x.fs.rename(original, outside);
      yield* x.config([{ id: "outside", path: "../outside" }]);
      const rejected = yield* x.preview();
      assert.isFalse(rejected.canApply);
      assert.include(rejected.repositories[0]!.reason, "Approve");
      assert.deepEqual(rejected.environment.additionalFolders, []);
      const allowed = yield* x.preview({ additionalFolders: [outside], repositories: [] });
      assert.isTrue(allowed.canApply);
      assert.deepEqual(allowed.environment.additionalFolders, [outside]);
      assert.notEqual(rejected.fingerprint, allowed.fingerprint);
    }),
  );
  it.effect(
    "rejects root and config escapes, changed grants, missing config and malformed inventory",
    () =>
      Effect.gen(function* () {
        const x = yield* setup;
        yield* x.config([]);
        const outside = x.path.join(x.root, "outside");
        yield* x.fs.makeDirectory(outside);
        assert.equal(
          (yield* x.preview(undefined, outside).pipe(Effect.flip)).code,
          "path_not_approved",
        );
        const alias = x.path.join(x.root, "alias");
        yield* x.fs.symlink(outside, alias);
        assert.equal(
          (yield* x.preview({ additionalFolders: [alias], repositories: [] }).pipe(Effect.flip))
            .code,
          "path_not_approved",
        );
        yield* x.fs.writeFileString(
          x.path.join(outside, "config.json"),
          '{"workspace":{"repos":[]}}',
        );
        yield* x.fs.remove(x.path.join(x.main, ".specweave", "config.json"));
        yield* x.fs.symlink(
          x.path.join(outside, "config.json"),
          x.path.join(x.main, ".specweave", "config.json"),
        );
        assert.equal((yield* x.preview().pipe(Effect.flip)).code, "path_not_approved");
        yield* x.fs.remove(x.path.join(x.main, ".specweave", "config.json"));
        assert.equal((yield* x.preview().pipe(Effect.flip)).code, "invalid");
        yield* x.fs.writeFileString(
          x.path.join(x.main, ".specweave", "config.json"),
          '{"workspace":{"repos":"wrong"}}',
        );
        assert.equal((yield* x.preview().pipe(Effect.flip)).code, "invalid");
      }),
  );
  it.effect(
    "reports collisions, mismatched identities, subfolders and unsafe remotes without changing anything",
    () =>
      Effect.gen(function* () {
        const x = yield* setup;
        const a = yield* x.repo("a");
        yield* x.fs.makeDirectory(x.path.join(a, "sub"));
        yield* x.config([
          { id: "a", path: "a", identity: "github.com/other/a" },
          { id: "sub", path: "a/sub" },
          { id: "gone", path: "missing" },
        ]);
        let preview = yield* x.preview();
        assert.isFalse(preview.canApply);
        assert.deepEqual(
          preview.repositories.map((r) => r.status),
          ["blocked", "blocked", "blocked"],
        );
        assert.deepEqual(preview.environment.repositories, []);
        yield* x.config([
          { id: "duplicate", path: "a" },
          { id: "second", path: a },
        ]);
        preview = yield* x.preview();
        assert.isFalse(preview.canApply);
        assert.include(preview.repositories[1]!.reason, "Duplicate");
        yield* x.git(a, [
          "remote",
          "set-url",
          "origin",
          "https://user:private-token@github.com/team/a",
        ]);
        yield* x.config([{ id: "a", path: "a" }]);
        preview = yield* x.preview();
        assert.isFalse(preview.canApply);
        assert.isNull(preview.repositories[0]!.url);
        assert.notInclude(JSON.stringify(preview), "private-token");
      }),
  );
  it.effect("shows capacity and ID conflicts rather than dropping repositories", () =>
    Effect.gen(function* () {
      const x = yield* setup;
      yield* x.repo("new");
      yield* x.config([{ id: "new", path: "new" }]);
      const repositories = Array.from({ length: 32 }, (_, i) => ({
        id: `existing-${i}`,
        url: `https://github.com/team/existing-${i}`,
        localPath: x.path.join(x.main, `unused-${i}`),
      }));
      const preview = yield* x.preview({ additionalFolders: [], repositories });
      assert.isFalse(preview.canApply);
      assert.include(preview.repositories[0]!.reason, "32 repositories");
      assert.equal(preview.environment.repositories.length, 32);
      const collision = yield* x.preview({
        additionalFolders: [],
        repositories: [{ ...repositories[0]!, id: "new" }],
      });
      assert.include(collision.repositories[0]!.reason, "ID is already");
      yield* x.repo("second");
      yield* x.config([
        { id: "new", path: "new" },
        { id: "second", path: "second" },
      ]);
      const partial = yield* x.preview({
        additionalFolders: [],
        repositories: repositories.slice(0, 31),
      });
      assert.isTrue(partial.canApply);
      assert.deepEqual(
        partial.repositories.map((row) => row.status),
        ["add", "blocked"],
      );
      assert.equal(partial.environment.repositories.length, 32);
      assert.equal(partial.environment.repositories.at(-1)!.id, "new");
    }),
  );
});
