// @effect-diagnostics nodeBuiltinImport:off - disposable real Git repositories for the existing-copy update.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { afterEach, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ProcessRunner from "../processRunner.ts";
import * as HandoffGit from "./handoffGit.ts";
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
                GIT_CONFIG_GLOBAL: "/dev/null",
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

  it.effect("re-checks use right before each repository moves", () =>
    Effect.gen(function* () {
      const f = fixture();
      changeCode(f);
      const manifest = yield* sync(f);
      yield* publishSync(f, manifest);
      const asked: Array<string> = [];
      // A thread starts in the nested repository after the root moved.
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
      expect(asked).toEqual([f.destination, f.destinationNested]);
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
      HandoffGit.unsafeExistingCopyConfig([
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
      HandoffGit.unsafeExistingCopyConfig([
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
  });

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
      // The origin lost its LFS store after the source published.
      NodeFS.rmSync(NodePath.join(f.rootRemote, "lfs"), { recursive: true, force: true });
      expect(yield* refusal(update(f, manifest))).toMatchObject({
        reason: "lfs-failed",
        repository: ".",
      });
      // The commits arrived; a retry of the same operation downloads only the files.
      expect(git(f.destination, "rev-parse", "HEAD")).toBe(manifest.repositories[0]!.head);
    }),
  );

  it("pins the LFS endpoint Git LFS derives from each origin form", () => {
    expect(HandoffGit.lfsEndpoint("https://github.com/owner/app")).toBe(
      "https://github.com/owner/app.git/info/lfs",
    );
    expect(HandoffGit.lfsEndpoint("https://github.com/owner/app.git/")).toBe(
      "https://github.com/owner/app.git/info/lfs",
    );
    expect(HandoffGit.lfsEndpoint("git@github.com:owner/app.git")).toBe(
      "ssh://git@github.com/owner/app.git",
    );
    expect(HandoffGit.lfsEndpoint("/srv/git/app.git")).toBe("file:///srv/git/app.git");
    expect(HandoffGit.lfsEndpoint("ext::sh -c evil")).toBeNull();
    expect(
      HandoffGit.unsafeLfsConfig([
        ["lfs.url", "x"],
        ["remote.origin.lfsurl", "x"],
        ["lfs.fetchexclude", "x"],
        ["include.path", "x"],
        ["lfs.https://example.com/.access", "basic"],
        ["lfs.customtransfer.evil.path", "x"],
      ]),
    ).toEqual(["include.path", "lfs.customtransfer.evil.path", "lfs.https://example.com/.access"]);
  });
});
