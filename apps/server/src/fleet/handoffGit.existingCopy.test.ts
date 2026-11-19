// @effect-diagnostics nodeBuiltinImport:off - disposable real Git repositories for the existing-copy update.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { afterEach, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ProcessRunner from "../processRunner.ts";
import * as HandoffGit from "./handoffGit.ts";
import {
  alternatePaths,
  ambientFilters,
  filtersOff,
  lfsEndpoint,
  unsafeExistingCopyConfig,
  unsafeLfsConfig,
} from "./handoffGitConfig.ts";
import {
  changeCode,
  commit,
  fixture,
  git,
  operationId,
  snapshot,
  temporary,
  write,
} from "./handoffGit.testkit.ts";
import type { HandoffGitError, HandoffGitManifest } from "./handoffGitTypes.ts";

const calls: Array<ProcessRunner.ProcessRunInput> = [];
/** Replaces PATH for Git calls, so a test can run Git without Git LFS. */
let pathOverride: string | undefined;
/** This machine's own Git settings for Git calls; none unless a test writes some. */
let globalConfig: string | undefined;
const live = HandoffGit.layer.pipe(
  Layer.provide(
    Layer.effect(
      ProcessRunner.ProcessRunner,
      Effect.gen(function* () {
        const real = yield* ProcessRunner.ProcessRunner;
        return ProcessRunner.ProcessRunner.of({
          run: (input) => {
            calls.push(input);
            return real.run({
              ...input,
              env: {
                ...input.env,
                GIT_CONFIG_GLOBAL: globalConfig ?? "/dev/null",
                GIT_CONFIG_NOSYSTEM: "1",
                ...(pathOverride ? { PATH: pathOverride } : {}),
              },
            });
          },
        });
      }),
    ).pipe(Layer.provide(ProcessRunner.layer)),
  ),
  Layer.provide(NodeServices.layer),
);
const run = <A, E>(f: (service: HandoffGit.HandoffGit["Service"]) => Effect.Effect<A, E>) =>
  Effect.service(HandoffGit.HandoffGit).pipe(Effect.flatMap(f), Effect.provide(live));

afterEach(() => {
  for (const directory of temporary.splice(0))
    NodeFS.rmSync(directory, { recursive: true, force: true });
  calls.length = 0;
  pathOverride = undefined;
  globalConfig = undefined;
});

describe("existing copy update (1326)", () => {
  const idle: HandoffGit.ExistingCopyGuard = { inUse: () => Effect.succeed(false) };
  const sync = (f: ReturnType<typeof fixture>) =>
    run((service) => service.inspect({ workspaceRoot: f.source, operationId, allowChanges: true }));
  const publishSync = (f: ReturnType<typeof fixture>, manifest: HandoffGitManifest) =>
    run((service) =>
      service.publish({ workspaceRoot: f.source, manifest, publish: true, allowChanges: true }),
    );
  const check = (
    f: ReturnType<typeof fixture>,
    manifest: HandoffGitManifest,
    guard: HandoffGit.ExistingCopyGuard = idle,
  ) =>
    run((service) =>
      service.checkExistingCopy({ workspaceRoot: f.destination, manifest, existingCopy: guard }),
    );
  const update = (
    f: ReturnType<typeof fixture>,
    manifest: HandoffGitManifest,
    guard: HandoffGit.ExistingCopyGuard = idle,
  ) =>
    run((service) =>
      service.materialize({
        workspaceRoot: f.destination,
        worktreeParent: f.outputs,
        manifest,
        useProjectFolder: true,
        existingCopy: guard,
      }),
    );
  const refusal = <A>(effect: Effect.Effect<A, HandoffGitError>) =>
    effect.pipe(
      Effect.flip,
      Effect.map((error) => ({
        reason: error.reason,
        repository: error.repository,
        unsafeConfig: error.unsafeConfig,
      })),
    );

  it.effect.each([false, true])(
    "brings every repository of the copy to the source heads (submodule: %s)",
    (submodule) =>
      Effect.gen(function* () {
        const f = fixture(submodule);
        const before = snapshot(f.destination);
        changeCode(f);
        // Uncommitted work stays on the source; only commits travel.
        write(NodePath.join(f.source, "root.ts"), "export const value = 'draft';\n");
        const manifest = yield* sync(f);
        expect(manifest.repositories.map((entry) => entry.relativePath)).toEqual([
          ".",
          "repositories/nested",
        ]);
        yield* publishSync(f, manifest);
        yield* check(f, manifest);
        expect(snapshot(f.destination)).toEqual(before);
        const result = yield* update(f, manifest);
        expect(result.workspaceRoot).toBe(f.destination);
        for (const repository of manifest.repositories) {
          const cwd = NodePath.join(f.destination, repository.relativePath);
          expect(git(cwd, "rev-parse", "HEAD")).toBe(repository.head);
          expect(git(cwd, "status", "--porcelain=v1", "--untracked-files=all")).toBe("");
        }
        expect(git(f.destination, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
        expect(NodeFS.readFileSync(NodePath.join(f.destination, "root.ts"), "utf8")).toBe(
          "export const value = 42;\n",
        );
        expect(NodeFS.readFileSync(NodePath.join(f.destinationNested, "feature.ts"), "utf8")).toBe(
          "export const answer = 42;\n",
        );
        // Hooks, fsmonitor and LFS smudging are off for every call into the copy.
        const intoCopy = calls.filter((call) => call.cwd?.startsWith(f.destination));
        expect(intoCopy.length).toBeGreaterThan(0);
        for (const call of intoCopy) {
          expect(call.args).toContain("core.hooksPath=/dev/null");
          expect(call.args).toContain("core.fsmonitor=false");
          if (call.args.includes("merge")) expect(call.env?.GIT_LFS_SKIP_SMUDGE).toBe("1");
        }
      }),
  );

  it.effect("names nested repositories it can, and leaves out one without an origin", () =>
    Effect.gen(function* () {
      const f = fixture();
      const local = NodePath.join(f.source, "repositories", "no-origin");
      NodeFS.mkdirSync(local);
      git(local, "init", "--initial-branch=main");
      write(NodePath.join(local, "a.txt"), "a\n");
      commit(local);
      write(NodePath.join(f.sourceNested, "feature.ts"), "dirty\n");
      const manifest = yield* sync(f);
      expect(manifest.repositories.map((entry) => entry.relativePath)).toEqual([
        ".",
        "repositories/nested",
      ]);
    }),
  );

  it.effect("refuses a copy with its own commits, and keeps them", () =>
    Effect.gen(function* () {
      const f = fixture();
      write(NodePath.join(f.destination, "local.ts"), "mine\n");
      commit(f.destination);
      const own = git(f.destination, "rev-parse", "HEAD");
      changeCode(f);
      const manifest = yield* sync(f);
      // Before publication the source heads are unknown there: commits no remote has are its own.
      expect((yield* refusal(check(f, manifest))).reason).toBe("diverged-repository");
      yield* publishSync(f, manifest);
      expect(yield* refusal(update(f, manifest))).toMatchObject({
        reason: "diverged-repository",
        repository: ".",
      });
      expect(git(f.destination, "rev-parse", "HEAD")).toBe(own);
    }),
  );

  it.effect("refuses a dirty copy or a detached root before changing anything", () =>
    Effect.gen(function* () {
      const f = fixture();
      changeCode(f);
      const manifest = yield* sync(f);
      yield* publishSync(f, manifest);
      write(NodePath.join(f.destinationNested, "feature.ts"), "edited there\n");
      const dirty = snapshot(f.destinationNested);
      expect(yield* refusal(check(f, manifest))).toMatchObject({
        reason: "dirty-repository",
        repository: "repositories/nested",
      });
      expect((yield* refusal(update(f, manifest))).reason).toBe("dirty-repository");
      expect(snapshot(f.destinationNested)).toEqual(dirty);
      git(f.destinationNested, "checkout", "--", "feature.ts");
      git(f.destination, "checkout", "--detach");
      expect(yield* refusal(check(f, manifest))).toMatchObject({
        reason: "detached-head",
        repository: ".",
      });
      expect((yield* refusal(update(f, manifest))).reason).toBe("detached-head");
    }),
  );

  it.effect("names unsafe .git/config entries and never runs them", () =>
    Effect.gen(function* () {
      const f = fixture();
      const marker = NodePath.join(f.base, "filter-ran");
      changeCode(f);
      const manifest = yield* sync(f);
      yield* publishSync(f, manifest);
      // People and branch notes are fine; a filter driver and an ssh command are not.
      git(f.destination, "config", "user.email", "me@example.invalid");
      git(f.destination, "config", "branch.main.vscode-merge-base", "origin/main");
      git(f.destination, "config", "filter.evil.smudge", `touch ${marker}`);
      git(f.destination, "config", "filter.evil.clean", `touch ${marker}`);
      git(f.destination, "config", "core.sshCommand", `touch ${marker}`);
      // Untracked attributes route every file through the filter on the next status or checkout.
      write(NodePath.join(f.destination, ".git", "info", "attributes"), "* filter=evil\n");
      const before = git(f.destination, "rev-parse", "HEAD");
      for (const attempt of [check(f, manifest), update(f, manifest)])
        expect(yield* refusal(attempt)).toEqual({
          reason: "unsafe-git-config",
          repository: ".",
          unsafeConfig: ["core.sshcommand", "filter.evil.clean", "filter.evil.smudge"],
        });
      expect(git(f.destination, "rev-parse", "HEAD")).toBe(before);
      expect(NodeFS.existsSync(marker)).toBe(false);
    }),
  );

  it.effect("checks every repository for use before the first one moves", () =>
    Effect.gen(function* () {
      const f = fixture();
      changeCode(f);
      const manifest = yield* sync(f);
      yield* publishSync(f, manifest);
      const before = [f.destination, f.destinationNested].map((cwd) => snapshot(cwd));
      const asked: Array<string> = [];
      // A thread works in the nested repository, the second one to move.
      const busyNested: HandoffGit.ExistingCopyGuard = {
        inUse: (folder) =>
          Effect.sync(() => {
            asked.push(folder);
            return folder === f.destinationNested;
          }),
      };
      expect(yield* refusal(update(f, manifest, busyNested))).toMatchObject({
        reason: "in-use",
        repository: "repositories/nested",
      });
      // The root was asked about and left where it was: no repository is ahead of another.
      expect(asked).toEqual([f.destination, f.destinationNested]);
      expect([f.destination, f.destinationNested].map((cwd) => snapshot(cwd))).toEqual(before);
      // Once it is free, the same operation updates the whole umbrella.
      yield* update(f, manifest);
      expect(git(f.destination, "rev-parse", "HEAD")).toBe(manifest.repositories[0]!.head);
      expect(git(f.destinationNested, "rev-parse", "HEAD")).toBe(manifest.repositories[1]!.head);
    }),
  );

  it.effect("re-checks use right before each repository moves", () =>
    Effect.gen(function* () {
      const f = fixture();
      changeCode(f);
      const manifest = yield* sync(f);
      yield* publishSync(f, manifest);
      const asked: Array<string> = [];
      // A thread starts in the nested repository after every check passed and the root moved.
      const startsLate: HandoffGit.ExistingCopyGuard = {
        inUse: (folder) =>
          Effect.sync(() => {
            asked.push(folder);
            return (
              folder === f.destinationNested &&
              asked.filter((seen) => seen === f.destinationNested).length > 1
            );
          }),
      };
      expect(yield* refusal(update(f, manifest, startsLate))).toMatchObject({
        reason: "in-use",
        repository: "repositories/nested",
      });
      expect(asked).toEqual([
        f.destination,
        f.destinationNested,
        f.destination,
        f.destinationNested,
      ]);
      expect(git(f.destination, "rev-parse", "HEAD")).toBe(manifest.repositories[0]!.head);
      const nestedBefore = git(f.destinationNested, "rev-parse", "HEAD");
      expect(nestedBefore).not.toBe(manifest.repositories[1]!.head);
      // Once it is free, the same operation finishes the umbrella.
      yield* update(f, manifest);
      expect(git(f.destinationNested, "rev-parse", "HEAD")).toBe(manifest.repositories[1]!.head);
    }),
  );

  it.effect("checks every linked worktree of a repository for use", () =>
    Effect.gen(function* () {
      const f = fixture();
      changeCode(f);
      const manifest = yield* sync(f);
      yield* publishSync(f, manifest);
      const linked = NodePath.join(f.base, "linked-worker");
      git(f.destination, "worktree", "add", "-b", "worker", linked);
      const guard: HandoffGit.ExistingCopyGuard = {
        inUse: (folder) => Effect.succeed(folder === NodeFS.realpathSync(linked)),
      };
      expect(yield* refusal(check(f, manifest, guard))).toMatchObject({
        reason: "in-use",
        repository: ".",
      });
    }),
  );

  it.effect("refuses an update whose source commits were never published", () =>
    Effect.gen(function* () {
      const f = fixture();
      changeCode(f);
      const manifest = yield* sync(f);
      const before = snapshot(f.destination);
      expect((yield* refusal(update(f, manifest))).reason).toBe("remote-ref-mismatch");
      expect(snapshot(f.destination)).toEqual(before);
    }),
  );

  it.effect("refuses a copy that needs Git LFS where it is not installed", () =>
    Effect.gen(function* () {
      const f = fixture();
      write(
        NodePath.join(f.source, ".gitattributes"),
        "*.bin filter=lfs diff=lfs merge=lfs -text\n",
      );
      write(NodePath.join(f.source, "model.bin"), "binary\n");
      commit(f.source);
      const manifest = yield* sync(f);
      yield* publishSync(f, manifest);
      // Git's own directory as the whole PATH: its helpers resolve, `git lfs` does not.
      pathOverride = NodeChildProcess.execFileSync("git", ["--exec-path"], {
        encoding: "utf8",
      }).trim();
      const before = git(f.destination, "rev-parse", "HEAD");
      expect(yield* refusal(update(f, manifest))).toMatchObject({
        reason: "needs-lfs",
        repository: ".",
      });
      expect(git(f.destination, "rev-parse", "HEAD")).toBe(before);
    }),
  );

  it("judges a copy's own config for what it runs, not for what it carries", () => {
    expect(
      unsafeExistingCopyConfig([
        ["core.repositoryformatversion", "0"],
        ["remote.origin.url", "/srv/git/app.git"],
        ["remote.origin.pushurl", "https://token@example.com/app.git"],
        ["remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"],
        ["branch.main.remote", "origin"],
        ["branch.main.description", "notes"],
        ["user.name", "Someone"],
        ["filter.lfs.process", "git-lfs filter-process"],
        ["maintenance.auto", "false"],
      ]),
    ).toEqual([]);
    expect(
      unsafeExistingCopyConfig([
        ["remote.origin.url", "ext::sh -c touch% /tmp/x"],
        ["remote.origin.uploadpack", "evil"],
        ["branch.main.mergeoptions", "-s evil"],
        ["filter.lfs.process", "evil filter-process"],
        ["include.path", "../other"],
        ["credential.helper", "store"],
        ["core.fsmonitor", "evil"],
      ]),
    ).toEqual([
      "branch.main.mergeoptions",
      "core.fsmonitor",
      "credential.helper",
      "filter.lfs.process",
      "include.path",
      "remote.origin.uploadpack",
      "remote.origin.url",
    ]);
    // A host or user that ssh would read as an option never reaches a fetch.
    expect(
      unsafeExistingCopyConfig([
        ["remote.origin.url", "ssh://-oProxyCommand=evil@github.com/org/repo.git"],
        ["remote.origin.pushurl", "ssh://git@-oProxyCommand=evil/org/repo.git"],
        ["remote.mirror.url", "-oProxyCommand=evil:org/repo.git"],
        ["remote.other.url", "git@-oProxyCommand=evil:org/repo.git"],
        ["submodule.lib.url", "ssh://-oProxyCommand=evil/org/lib.git"],
        ["remote.encoded.url", "ssh://%2DoProxyCommand=evil@github.com/org/repo.git"],
        ["remote.bracket.url", "ssh://git@[-oProxyCommand=evil]/org/repo.git"],
        ["remote.broken.url", "ssh://%zz@github.com/org/repo.git"],
        ["remote.v6.url", "ssh://git@[::1]:2222/org/repo.git"],
        ["remote.fine.url", "ssh://git@github.com/org/repo.git"],
        ["remote.scp.url", "git@github.com:org/repo.git"],
        ["remote.web.url", "https://github.com/org/-repo.git"],
        ["remote.local.url", "../-sibling/repo.git"],
        ["remote.drive.url", "C:\\repos\\app.git"],
      ]),
    ).toEqual([
      "remote.bracket.url",
      "remote.broken.url",
      "remote.encoded.url",
      "remote.mirror.url",
      "remote.origin.pushurl",
      "remote.origin.url",
      "remote.other.url",
      "submodule.lib.url",
    ]);
    // A submodule's Git folder names its checkout; any other `core.worktree` is refused.
    const worktree = [["core.worktree", "../../../repositories/nested"]] as const;
    expect(unsafeExistingCopyConfig(worktree)).toEqual(["core.worktree"]);
    expect(unsafeExistingCopyConfig(worktree, { keepWorktree: () => false })).toEqual([
      "core.worktree",
    ]);
    expect(unsafeExistingCopyConfig(worktree, { keepWorktree: () => true })).toEqual([]);
  });

  it.effect("refuses a remote URL that ssh would read as an option, before any fetch", () =>
    Effect.gen(function* () {
      const f = fixture();
      changeCode(f);
      const manifest = yield* sync(f);
      yield* publishSync(f, manifest);
      git(
        f.destination,
        "config",
        "remote.origin.url",
        "ssh://-oProxyCommand=evil@github.com/org/repo.git",
      );
      const before = snapshot(f.destination);
      for (const attempt of [check(f, manifest), update(f, manifest)])
        expect(yield* refusal(attempt)).toEqual({
          reason: "unsafe-git-config",
          repository: ".",
          unsafeConfig: ["remote.origin.url"],
        });
      expect(snapshot(f.destination)).toEqual(before);
      // No call into the copy reached origin.
      for (const call of calls.filter((call) => call.cwd?.startsWith(f.destination)))
        for (const reaching of ["fetch", "ls-remote", "push", "lfs"])
          expect(call.args).not.toContain(reaching);
    }),
  );

  it.effect("refuses a submodule whose Git folder names another folder as its checkout", () =>
    Effect.gen(function* () {
      const f = fixture(true);
      changeCode(f);
      const manifest = yield* sync(f);
      yield* publishSync(f, manifest);
      const elsewhere = NodePath.join(f.base, "elsewhere");
      NodeFS.mkdirSync(elsewhere);
      const gitDir = git(f.destinationNested, "rev-parse", "--absolute-git-dir");
      // Written straight into the file: Git would refuse to work in the folder otherwise.
      NodeFS.appendFileSync(
        NodePath.join(gitDir, "config.worktree"),
        `[core]\n\tworktree = ${NodePath.relative(gitDir, elsewhere)}\n`,
      );
      const before = git(f.destination, "rev-parse", "HEAD");
      expect(yield* refusal(update(f, manifest))).toMatchObject({
        reason: "unsafe-git-config",
        unsafeConfig: ["core.worktree"],
      });
      expect(git(f.destination, "rev-parse", "HEAD")).toBe(before);
    }),
  );

  // --- Review findings on #366 (Sol, November 14, 2026) ---

  it.effect("checks every initialized submodule's config before status runs in it", () =>
    Effect.gen(function* () {
      const f = fixture(true);
      const marker = NodePath.join(f.base, "submodule-filter-ran");
      const full = yield* sync(f);
      // An older source names only the root; status still recurses into the submodule.
      const manifest = { ...full, repositories: full.repositories.slice(0, 1) };
      git(f.destinationNested, "config", "filter.evil.clean", `touch ${marker}`);
      const gitDir = git(f.destinationNested, "rev-parse", "--absolute-git-dir");
      NodeFS.mkdirSync(NodePath.join(gitDir, "info"), { recursive: true });
      write(NodePath.join(gitDir, "info", "attributes"), "* filter=evil\n");
      // A changed timestamp makes status run the clean filter on the file again.
      const later = 4_102_444_800; // 2100, in seconds
      NodeFS.utimesSync(NodePath.join(f.destinationNested, "feature.ts"), later, later);
      expect(yield* refusal(check(f, manifest))).toEqual({
        reason: "unsafe-git-config",
        repository: "repositories/nested",
        unsafeConfig: ["filter.evil.clean"],
      });
      expect(NodeFS.existsSync(marker)).toBe(false);
    }),
  );

  it.effect("refuses an incoming .lfsconfig that includes other config", () =>
    Effect.gen(function* () {
      const f = fixture();
      write(
        NodePath.join(f.base, "elsewhere.config"),
        "[lfs]\n\turl = https://elsewhere.invalid/lfs\n",
      );
      write(
        NodePath.join(f.source, ".gitattributes"),
        "*.bin filter=lfs diff=lfs merge=lfs -text\n",
      );
      write(
        NodePath.join(f.source, ".lfsconfig"),
        `[include]\n\tpath = ${NodePath.join(f.base, "elsewhere.config")}\n`,
      );
      commit(f.source);
      const manifest = yield* sync(f);
      yield* publishSync(f, manifest);
      const before = git(f.destination, "rev-parse", "HEAD");
      expect(yield* refusal(update(f, manifest))).toEqual({
        reason: "unsafe-git-config",
        repository: ".",
        unsafeConfig: [".lfsconfig include.path"],
      });
      expect(git(f.destination, "rev-parse", "HEAD")).toBe(before);
    }),
  );

  it.effect("reads each commit as itself, whatever replace refs the copy holds", () =>
    Effect.gen(function* () {
      const f = fixture();
      changeCode(f);
      const manifest = yield* sync(f);
      yield* publishSync(f, manifest);
      const incoming = manifest.repositories[0]!.head;
      // A commit on top of the copy's HEAD, then a replace ref naming the incoming commit.
      write(NodePath.join(f.destination, "root.ts"), "export const value = 'substituted';\n");
      commit(f.destination);
      const substitute = git(f.destination, "rev-parse", "HEAD");
      git(f.destination, "reset", "--hard", "HEAD~1");
      git(f.destination, "update-ref", `refs/replace/${incoming}`, substitute);
      yield* update(f, manifest);
      expect(git(f.destination, "rev-parse", "HEAD")).toBe(incoming);
      expect(NodeFS.readFileSync(NodePath.join(f.destination, "root.ts"), "utf8")).toBe(
        "export const value = 42;\n",
      );
    }),
  );

  it.effect("finds LFS files through a nested .gitattributes", () =>
    Effect.gen(function* () {
      const f = fixture();
      NodeFS.mkdirSync(NodePath.join(f.source, "assets"));
      write(
        NodePath.join(f.source, "assets", ".gitattributes"),
        "*.bin filter=lfs diff=lfs merge=lfs -text\n",
      );
      write(NodePath.join(f.source, "assets", "model.bin"), "binary\n");
      commit(f.source);
      const manifest = yield* sync(f);
      yield* publishSync(f, manifest);
      pathOverride = NodeChildProcess.execFileSync("git", ["--exec-path"], {
        encoding: "utf8",
      }).trim();
      const before = git(f.destination, "rev-parse", "HEAD");
      expect(yield* refusal(update(f, manifest))).toMatchObject({
        reason: "needs-lfs",
        repository: ".",
      });
      expect(git(f.destination, "rev-parse", "HEAD")).toBe(before);
    }),
  );

  const lfsInstalled =
    NodeChildProcess.spawnSync("git", ["lfs", "version"], { stdio: "ignore" }).status === 0;
  /** A source with real LFS objects in its file origin, and a copy set up for LFS. */
  const lfsFixture = () => {
    const f = fixture();
    git(f.source, "lfs", "install", "--local");
    git(f.destination, "lfs", "install", "--local");
    // The source's own pushes upload to its origin; `.lfsconfig` below names elsewhere.
    git(f.source, "config", "lfs.url", `file://${f.rootRemote}`);
    write(NodePath.join(f.source, ".gitattributes"), "*.bin filter=lfs diff=lfs merge=lfs -text\n");
    write(NodePath.join(f.source, ".lfsconfig"), "[lfs]\n\turl = file:///nonexistent/lfs-store\n");
    NodeFS.mkdirSync(NodePath.join(f.source, "assets"));
    write(NodePath.join(f.source, "assets", "model.bin"), "real model bytes\n".repeat(64));
    commit(f.source);
    return f;
  };

  it.effect.skipIf(!lfsInstalled)(
    "downloads every LFS file from the approved origin, not .lfsconfig's endpoint",
    () =>
      Effect.gen(function* () {
        const f = lfsFixture();
        const manifest = yield* sync(f);
        yield* publishSync(f, manifest);
        yield* check(f, manifest);
        yield* update(f, manifest);
        expect(
          NodeFS.readFileSync(NodePath.join(f.destination, "assets", "model.bin"), "utf8"),
        ).toBe("real model bytes\n".repeat(64));
        expect(git(f.destination, "status", "--porcelain=v1", "--untracked-files=all")).toBe("");
        const pull = calls.find((call) => call.args.includes("lfs") && call.args.includes("pull"));
        expect(pull?.args).toContain(`lfs.url=file://${f.rootRemote}`);
      }),
  );

  it.effect.skipIf(!lfsInstalled)("names a failed LFS download as its own step", () =>
    Effect.gen(function* () {
      const f = lfsFixture();
      const manifest = yield* sync(f);
      yield* publishSync(f, manifest);
      // The origin's LFS store is out of reach after the source published.
      const store = NodePath.join(f.rootRemote, "lfs");
      NodeFS.renameSync(store, `${store}.away`);
      expect(yield* refusal(update(f, manifest))).toMatchObject({
        reason: "lfs-failed",
        repository: ".",
      });
      // The commits arrived, and the file is still a pointer.
      expect(git(f.destination, "rev-parse", "HEAD")).toBe(manifest.repositories[0]!.head);
      const model = NodePath.join(f.destination, "assets", "model.bin");
      expect(NodeFS.readFileSync(model, "utf8")).toContain("git-lfs.github.com/spec");
      // A retry of the same operation, once the store is back, downloads only the files.
      NodeFS.rmSync(store, { recursive: true, force: true });
      NodeFS.renameSync(`${store}.away`, store);
      calls.length = 0;
      yield* update(f, manifest);
      expect(NodeFS.readFileSync(model, "utf8")).toBe("real model bytes\n".repeat(64));
      expect(calls.some((call) => call.args.includes("merge"))).toBe(false);
    }),
  );

  it("pins the LFS endpoint Git LFS derives from each origin form", () => {
    expect(lfsEndpoint("https://github.com/owner/app")).toBe(
      "https://github.com/owner/app.git/info/lfs",
    );
    expect(lfsEndpoint("https://github.com/owner/app.git/")).toBe(
      "https://github.com/owner/app.git/info/lfs",
    );
    expect(lfsEndpoint("git@github.com:owner/app.git")).toBe("ssh://git@github.com/owner/app.git");
    expect(lfsEndpoint("/srv/git/app.git")).toBe("file:///srv/git/app.git");
    expect(lfsEndpoint("ext::sh -c evil")).toBeNull();
    expect(
      unsafeLfsConfig([
        ["lfs.url", "x"],
        ["remote.origin.lfsurl", "x"],
        ["lfs.fetchexclude", "x"],
        ["include.path", "x"],
        ["lfs.https://example.com/.access", "basic"],
        ["lfs.customtransfer.evil.path", "x"],
      ]),
    ).toEqual(["include.path", "lfs.customtransfer.evil.path", "lfs.https://example.com/.access"]);
  });

  // --- Review findings on #366, second pass ---

  /** A program this machine's own Git settings name as a filter; it records that it ran. */
  const ambientFilter = (f: ReturnType<typeof fixture>, name: string) => {
    const marker = NodePath.join(f.base, `${name}-filter-ran`);
    const script = NodePath.join(f.base, `${name}-filter.sh`);
    write(script, `#!/bin/sh\ntouch ${marker}\ncat\n`);
    NodeFS.chmodSync(script, 0o755);
    globalConfig = NodePath.join(f.base, "global.gitconfig");
    NodeFS.appendFileSync(
      globalConfig,
      `[filter "${name}"]\n\tclean = ${script}\n\tsmudge = ${script}\n\trequired = true\n`,
    );
    return marker;
  };

  it.effect("never runs a filter this machine's own Git settings define", () =>
    Effect.gen(function* () {
      const f = fixture();
      const marker = ambientFilter(f, "stamp");
      // The incoming commit's attributes choose that filter for the files it changes.
      write(NodePath.join(f.source, ".gitattributes"), "*.ts filter=stamp\n");
      changeCode(f);
      const manifest = yield* sync(f);
      yield* publishSync(f, manifest);
      // The copy's own attributes choose it too, and status re-reads a file changed on disk.
      write(NodePath.join(f.destination, ".git", "info", "attributes"), "*.ts filter=stamp\n");
      const later = 4_102_444_800;
      NodeFS.utimesSync(NodePath.join(f.destination, "root.ts"), later, later);
      yield* check(f, manifest);
      yield* update(f, manifest);
      expect(NodeFS.existsSync(marker)).toBe(false);
      expect(git(f.destination, "rev-parse", "HEAD")).toBe(manifest.repositories[0]!.head);
      expect(NodeFS.readFileSync(NodePath.join(f.destination, "root.ts"), "utf8")).toBe(
        "export const value = 42;\n",
      );
      // Sanity: plain Git with the same settings does run it.
      NodeFS.utimesSync(NodePath.join(f.destination, "root.ts"), later + 60, later + 60);
      NodeChildProcess.execFileSync("git", ["-C", f.destination, "status", "--porcelain"], {
        env: { ...process.env, GIT_CONFIG_GLOBAL: globalConfig, GIT_CONFIG_NOSYSTEM: "1" },
      });
      expect(NodeFS.existsSync(marker)).toBe(true);
    }),
  );

  it("reads the filters of this machine's own settings, not the repository's", () => {
    const scoped = [
      ["global", "filter.stamp.clean\nstamp --clean"],
      ["global", "filter.stamp.required\ntrue"],
      ["system", "filter.Crypt.smudge\ngit-crypt smudge"],
      ["command", "filter.off.clean\n"],
      ["global", "filter.lfs.clean\ngit-lfs clean -- %f"],
      ["global", "filter.lfs.smudge\ngit-lfs smudge --skip -- %f"],
      ["global", "filter.lfs.process\ngit-lfs filter-process --skip"],
      ["local", "filter.local.clean\nrun-me"],
      ["local", "filter.stamp.smudge\nstamp --smudge"],
      ["worktree", "filter.tree.smudge\nrun-me"],
      ["global", "user.name\nSomeone"],
    ]
      .map(([scope, entry]) => `${scope}\0${entry}\0`)
      .join("");
    expect([...ambientFilters(scoped)]).toEqual([
      ["stamp", ["filter.stamp.clean", "filter.stamp.smudge"]],
      ["Crypt", ["filter.Crypt.smudge"]],
    ]);
    expect([
      ...ambientFilters("global\0filter.lfs.smudge\nmy-lfs smudge %f\0global\0x.y\nz\0"),
    ]).toEqual([["lfs", ["filter.lfs.smudge"]]]);
    // The repository's own standard entry is what Git uses, so LFS is left alone.
    expect([
      ...ambientFilters(
        "global\0filter.lfs.smudge\nmy-lfs smudge %f\0local\0filter.lfs.smudge\ngit-lfs smudge -- %f\0",
      ),
    ]).toEqual([]);
    expect(filtersOff(["a"])).toEqual([
      "filter.a.clean=",
      "filter.a.smudge=",
      "filter.a.process=",
      "filter.a.required=false",
    ]);
    expect(alternatePaths("# shared\n/srv/a/objects\n\n../../b/objects\r\n")).toEqual([
      "/srv/a/objects",
      "../../b/objects",
    ]);
    expect(alternatePaths('"/srv/quoted\\040path"\n')).toBeNull();
  });

  it.effect("refuses objects borrowed from a repository outside the project folder", () =>
    Effect.gen(function* () {
      const f = fixture();
      changeCode(f);
      const manifest = yield* sync(f);
      yield* publishSync(f, manifest);
      const outside = NodePath.join(f.base, "outside");
      git(f.base, "clone", f.rootRemote, outside);
      const alternates = NodePath.join(f.destination, ".git", "objects", "info", "alternates");
      write(alternates, `${NodePath.join(outside, ".git", "objects")}\n`);
      const before = git(f.destination, "rev-parse", "HEAD");
      const external = { reason: "external-git-storage", repository: ".", unsafeConfig: undefined };
      expect(yield* refusal(check(f, manifest))).toEqual(external);
      expect(yield* refusal(update(f, manifest))).toEqual(external);
      // A store that itself borrows from outside is refused through the chain.
      write(alternates, `${NodePath.join(f.destinationNested, ".git", "objects")}\n`);
      write(
        NodePath.join(f.destinationNested, ".git", "objects", "info", "alternates"),
        `${NodePath.join(outside, ".git", "objects")}\n`,
      );
      expect(yield* refusal(check(f, manifest))).toEqual(external);
      NodeFS.rmSync(NodePath.join(f.destinationNested, ".git", "objects", "info", "alternates"));
      NodeFS.rmSync(alternates);
      // The object store itself linked out of the folder.
      const objects = NodePath.join(f.destination, ".git", "objects");
      const moved = NodePath.join(f.base, "moved-objects");
      NodeFS.renameSync(objects, moved);
      NodeFS.symlinkSync(moved, objects);
      expect(yield* refusal(check(f, manifest))).toEqual(external);
      expect(git(f.destination, "rev-parse", "HEAD")).toBe(before);
      expect(calls.some((call) => call.args.includes("fetch"))).toBe(false);
    }),
  );

  it.effect("updates a copy whose repositories share objects inside the project folder", () =>
    Effect.gen(function* () {
      const f = fixture();
      changeCode(f);
      const manifest = yield* sync(f);
      yield* publishSync(f, manifest);
      write(
        NodePath.join(f.destinationNested, ".git", "objects", "info", "alternates"),
        `${NodePath.join(f.destination, ".git", "objects")}\n`,
      );
      yield* check(f, manifest);
      yield* update(f, manifest);
      expect(git(f.destinationNested, "rev-parse", "HEAD")).toBe(manifest.repositories[1]!.head);
    }),
  );

  it.effect("updates a copy that is a linked worktree, and refuses a folder posing as one", () =>
    Effect.gen(function* () {
      const f = fixture();
      const linked = NodePath.join(f.base, "linked");
      git(f.destination, "worktree", "add", "-b", "copy", linked);
      write(NodePath.join(f.source, "root.ts"), "export const value = 42;\n");
      commit(f.source);
      const full = yield* sync(f);
      yield* publishSync(f, full);
      const manifest = { ...full, repositories: full.repositories.slice(0, 1) };
      const at = (workspaceRoot: string) =>
        run((service) =>
          service.materialize({
            workspaceRoot,
            worktreeParent: f.outputs,
            manifest,
            useProjectFolder: true,
            existingCopy: idle,
          }),
        );
      // A folder whose `.git` names that worktree's Git folder, which names `linked` back.
      const posing = NodePath.join(f.base, "posing");
      NodeFS.mkdirSync(posing);
      NodeFS.copyFileSync(NodePath.join(linked, ".git"), NodePath.join(posing, ".git"));
      expect(yield* refusal(at(posing))).toMatchObject({
        reason: "external-git-storage",
        repository: ".",
      });
      yield* at(linked);
      expect(git(linked, "rev-parse", "HEAD")).toBe(manifest.repositories[0]!.head);
      expect(git(linked, "rev-parse", "--abbrev-ref", "HEAD")).toBe("copy");
    }),
  );

  it.effect("checks a submodule the update adds before status enters its folder", () =>
    Effect.gen(function* () {
      const f = fixture();
      const marker = NodePath.join(f.base, "added-submodule-filter-ran");
      git(f.source, "submodule", "add", f.nestedRemote, "vendor/lib");
      commit(f.source);
      const full = yield* sync(f);
      yield* publishSync(f, full);
      // An older source names only the root. The copy already holds a repository there,
      // hidden from status by its own exclude file.
      const manifest = { ...full, repositories: full.repositories.slice(0, 1) };
      const existing = NodePath.join(f.destination, "vendor", "lib");
      NodeFS.mkdirSync(NodePath.join(f.destination, "vendor"));
      git(f.base, "clone", f.nestedRemote, existing);
      write(NodePath.join(f.destination, ".git", "info", "exclude"), "/vendor/\n");
      git(existing, "config", "filter.evil.clean", `touch ${marker}`);
      write(NodePath.join(existing, ".git", "info", "attributes"), "* filter=evil\n");
      const later = 4_102_444_800;
      NodeFS.utimesSync(NodePath.join(existing, "feature.ts"), later, later);
      const before = git(f.destination, "rev-parse", "HEAD");
      expect(yield* refusal(update(f, manifest))).toEqual({
        reason: "unsafe-git-config",
        repository: "vendor/lib",
        unsafeConfig: ["filter.evil.clean"],
      });
      // Refused before the merge that adds the submodule: the root has not moved.
      expect(git(f.destination, "rev-parse", "HEAD")).toBe(before);
      expect(NodeFS.existsSync(marker)).toBe(false);
    }),
  );

  it.effect("leaves worker worktrees and second clones of an origin out of the manifest", () =>
    Effect.gen(function* () {
      const f = fixture();
      NodeFS.appendFileSync(NodePath.join(f.source, ".gitignore"), "/.worktrees/\n/copies/\n");
      commit(f.source);
      git(f.source, "push", "origin", "main");
      // A worker's linked worktree, a second clone of the root's origin, and a second
      // clone of the nested origin: each is a checkout of its own.
      git(
        f.source,
        "worktree",
        "add",
        "-b",
        "worker",
        NodePath.join(f.source, ".worktrees/worker"),
      );
      NodeFS.mkdirSync(NodePath.join(f.source, "copies"));
      git(f.base, "clone", f.rootRemote, NodePath.join(f.source, "copies/app"));
      git(f.base, "clone", f.nestedRemote, NodePath.join(f.source, "copies/nested"));
      write(NodePath.join(f.source, "copies/nested/feature.ts"), "export const answer = 7;\n");
      commit(NodePath.join(f.source, "copies/nested"));
      // Two clones of the nested origin: nothing says which one the destination holds,
      // so neither is named, and neither is folded into the other.
      expect((yield* sync(f)).repositories.map((repository) => repository.relativePath)).toEqual([
        ".",
      ]);
      NodeFS.rmSync(NodePath.join(f.source, "copies/nested"), { recursive: true, force: true });
      const manifest = yield* sync(f);
      expect(manifest.repositories.map((repository) => repository.relativePath)).toEqual([
        ".",
        "repositories/nested",
      ]);
      yield* publishSync(f, manifest);
      yield* update(f, manifest);
      expect(git(f.destination, "rev-parse", "HEAD")).toBe(manifest.repositories[0]!.head);
    }),
  );

  it.effect("needs nothing from origin when the copy is already at the source heads", () =>
    Effect.gen(function* () {
      const f = fixture();
      // An older source, or one without push access, publishes no ref for the move.
      const manifest = yield* sync(f);
      const before = snapshot(f.destination);
      calls.length = 0;
      yield* check(f, manifest);
      yield* update(f, manifest);
      expect(snapshot(f.destination)).toEqual(before);
      expect(
        calls.some((call) =>
          ["fetch", "ls-remote", "merge"].some((arg) => call.args.includes(arg)),
        ),
      ).toBe(false);
    }),
  );

  it.effect("finds LFS files chosen by the copy's own attributes file", () =>
    Effect.gen(function* () {
      const f = fixture();
      write(NodePath.join(f.source, "model.bin"), "binary\n");
      commit(f.source);
      const manifest = yield* sync(f);
      yield* publishSync(f, manifest);
      write(NodePath.join(f.destination, ".git", "info", "attributes"), "*.bin filter=lfs\n");
      pathOverride = NodeChildProcess.execFileSync("git", ["--exec-path"], {
        encoding: "utf8",
      }).trim();
      const before = git(f.destination, "rev-parse", "HEAD");
      expect(yield* refusal(update(f, manifest))).toMatchObject({ reason: "needs-lfs" });
      expect(git(f.destination, "rev-parse", "HEAD")).toBe(before);
    }),
  );

  it.effect.skipIf(!lfsInstalled)("refuses a Git LFS filter this machine's settings changed", () =>
    Effect.gen(function* () {
      const f = lfsFixture();
      const manifest = yield* sync(f);
      yield* publishSync(f, manifest);
      const marker = ambientFilter(f, "lfs");
      // The copy's own standard LFS entries would win over this machine's; without them
      // Git would run the changed filter.
      git(f.destination, "config", "--remove-section", "filter.lfs");
      const before = git(f.destination, "rev-parse", "HEAD");
      const changed = {
        reason: "unsafe-git-config",
        repository: ".",
        unsafeConfig: ["filter.lfs.clean", "filter.lfs.smudge"].map(
          (key) => `${key} (this machine's Git settings)`,
        ),
      };
      expect(yield* refusal(update(f, manifest))).toEqual(changed);
      expect(git(f.destination, "rev-parse", "HEAD")).toBe(before);
      expect(NodeFS.existsSync(marker)).toBe(false);
    }),
  );

  it.effect.skipIf(!lfsInstalled)("never contacts the LFS server .lfsconfig names", () =>
    Effect.gen(function* () {
      const f = lfsFixture();
      const requests: Array<string> = [];
      const server = NodeHttp.createServer((request, response) => {
        requests.push(`${request.method} ${request.url} ${request.headers.authorization ?? ""}`);
        response.statusCode = 401;
        response.setHeader("WWW-Authenticate", 'Basic realm="lfs"');
        response.end();
      });
      yield* Effect.promise(
        () => new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)),
      );
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      write(
        NodePath.join(f.source, ".lfsconfig"),
        `[lfs]\n\turl = http://127.0.0.1:${port}/elsewhere/lfs\n\tfetchexclude = assets/**\n` +
          `[remote "origin"]\n\tlfsurl = http://127.0.0.1:${port}/elsewhere/lfs\n`,
      );
      commit(f.source);
      const manifest = yield* sync(f);
      yield* publishSync(f, manifest);
      yield* update(f, manifest).pipe(
        Effect.ensuring(
          Effect.promise(() => new Promise<void>((resolve) => server.close(() => resolve()))),
        ),
      );
      expect(requests).toEqual([]);
      // Every file arrived, though `.lfsconfig` asked to leave this folder out.
      expect(NodeFS.readFileSync(NodePath.join(f.destination, "assets", "model.bin"), "utf8")).toBe(
        "real model bytes\n".repeat(64),
      );
    }),
  );
});
