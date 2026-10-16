// @effect-diagnostics nodeBuiltinImport:off - realpathSync.native resolves Windows 8.3 short names, which the Effect realPath does not.
import * as NodeFS from "node:fs";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { SourceControlProviderError } from "@specweave-studio/contracts";
import { expect, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { TestClock } from "effect/testing";

import * as ProcessRunner from "../processRunner.ts";
import * as RepositoryIdentityResolver from "./RepositoryIdentityResolver.ts";

const normalizePathSeparators = (value: string) => value.replaceAll("\\", "/");
const normalizeResolvedPath = (value: string) => normalizePathSeparators(value);

const git = (cwd: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const processRunner = yield* ProcessRunner.ProcessRunner;
    return yield* processRunner.run({
      command: "git",
      args: ["-C", cwd, ...args],
    });
  }).pipe(Effect.provide(ProcessRunner.layer));

const layerRepositoryIdentityResolverTest = (options: {
  readonly positiveCacheTtl?: Duration.Input;
  readonly negativeCacheTtl?: Duration.Input;
}) =>
  Layer.effect(
    RepositoryIdentityResolver.RepositoryIdentityResolver,
    RepositoryIdentityResolver.make({
      cacheCapacity: 16,
      ...options,
    }),
  ).pipe(Layer.provide(ProcessRunner.layer));

it.layer(NodeServices.layer)("RepositoryIdentityResolverLive", (it) => {
  it.effect("refreshes the Git root only when requested", () => {
    const calls: Array<ReadonlyArray<string>> = [];
    let rootPath = "/repo";
    let remoteUrl = "git@github.com:StudioTools/studio.git";
    let refinements = 0;
    let refinementFails = false;
    const layerProcessRunner = Layer.succeed(ProcessRunner.ProcessRunner, {
      run: (input) =>
        Effect.sync(() => {
          calls.push(input.args);
          return {
            stdout: input.args.includes("rev-parse")
              ? `${rootPath}\n`
              : `origin\t${remoteUrl} (fetch)\n`,
            stderr: "",
            code: ChildProcessSpawner.ExitCode(0),
            timedOut: false,
            stdoutTruncated: false,
            stderrTruncated: false,
            stdoutInvalidUtf8: false,
            stderrInvalidUtf8: false,
          };
        }),
    });
    const layerResolver = Layer.effect(
      RepositoryIdentityResolver.RepositoryIdentityResolver,
      RepositoryIdentityResolver.make({
        refine: (identity) => {
          refinements++;
          if (refinementFails)
            return Effect.fail(
              new SourceControlProviderError({
                provider: "forgejo",
                operation: "detectProvider",
                cwd: rootPath,
                detail: "account unavailable",
              }),
            );
          return Effect.succeed(
            identity.canonicalKey.startsWith("ssh.forge.test/")
              ? {
                  ...identity,
                  provider: "forgejo",
                  webUrl: "http://forge.test:3000/git/team/repo",
                }
              : identity,
          );
        },
      }),
    ).pipe(Layer.provide(layerProcessRunner));

    return Effect.gen(function* () {
      const resolver = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
      const first = yield* resolver.resolve("/repo/packages/web");
      rootPath = "/repo/packages/web";
      // Longer than the one-minute cadence of the background sweeps.
      yield* TestClock.adjust(Duration.minutes(10));
      const second = yield* resolver.resolve("/repo/packages/web");

      expect(first?.canonicalKey).toBe("github.com/studiotools/studio");
      expect(second).toEqual(first);
      expect(refinements).toBe(1);
      expect(calls).toEqual([
        ["-C", "/repo/packages/web", "rev-parse", "--show-toplevel"],
        ["-C", "/repo", "remote", "-v"],
      ]);

      const refreshed = yield* resolver.resolve("/repo/packages/web", { refresh: true });
      expect(refreshed?.rootPath).toBe("/repo/packages/web");
      expect(yield* resolver.resolve("/repo/packages/web")).toEqual(refreshed);
      expect(calls.slice(2)).toEqual([
        ["-C", "/repo/packages/web", "rev-parse", "--show-toplevel"],
        ["-C", "/repo/packages/web", "remote", "-v"],
      ]);
      remoteUrl = "git@ssh.forge.test:team/repo.git";
      const forgejo = yield* resolver.resolve(rootPath, { refresh: true });
      expect(forgejo?.webUrl).toBe("http://forge.test:3000/git/team/repo");
      expect(forgejo?.provider).toBe("forgejo");
      expect(forgejo?.canonicalKey).toBe("ssh.forge.test/team/repo");
      expect(forgejo?.locator.remoteUrl).toBe(remoteUrl);
      expect(yield* resolver.resolve(rootPath)).toEqual(forgejo);
      expect(refinements).toBe(3);
      refinementFails = true;
      const unavailable = yield* resolver.resolve(rootPath, { refresh: true });
      expect(unavailable?.webUrl).toBeUndefined();
      expect(unavailable?.canonicalKey).toBe("ssh.forge.test/team/repo");
    }).pipe(Effect.provide(Layer.merge(TestClock.layer(), layerResolver)));
  });

  it.effect("retries Git root discovery after the negative TTL", () => {
    const calls: Array<ReadonlyArray<string>> = [];
    let rootAttempts = 0;
    const layerProcessRunner = Layer.succeed(ProcessRunner.ProcessRunner, {
      run: (input) =>
        Effect.sync(() => {
          calls.push(input.args);
          const rootLookup = input.args.includes("rev-parse");
          const failed = rootLookup && rootAttempts++ === 0;
          return {
            stdout: rootLookup
              ? failed
                ? ""
                : "/repo\n"
              : "origin\tgit@github.com:StudioTools/studio.git (fetch)\n",
            stderr: failed ? "temporary Git failure" : "",
            code: ChildProcessSpawner.ExitCode(failed ? 1 : 0),
            timedOut: false,
            stdoutTruncated: false,
            stderrTruncated: false,
            stdoutInvalidUtf8: false,
            stderrInvalidUtf8: false,
          };
        }),
    });
    const layerResolver = Layer.effect(
      RepositoryIdentityResolver.RepositoryIdentityResolver,
      RepositoryIdentityResolver.make(),
    ).pipe(Layer.provide(layerProcessRunner));

    return Effect.gen(function* () {
      const resolver = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
      expect(yield* resolver.resolve("/repo/packages/web")).toBeNull();
      expect(yield* resolver.resolve("/repo/packages/web")).toBeNull();

      yield* TestClock.adjust(Duration.minutes(1));
      const recovered = yield* resolver.resolve("/repo/packages/web");
      expect(recovered?.rootPath).toBe("/repo");
      expect(calls).toEqual([
        ["-C", "/repo/packages/web", "rev-parse", "--show-toplevel"],
        ["-C", "/repo/packages/web", "rev-parse", "--show-toplevel"],
        ["-C", "/repo", "remote", "-v"],
      ]);
    }).pipe(Effect.provide(Layer.merge(TestClock.layer(), layerResolver)));
  });

  it.effect("does not spawn git for a folder that is not there", () => {
    const calls: Array<ReadonlyArray<string>> = [];
    const existing = new Set(["/repo/packages/web"]);
    const layerProcessRunner = Layer.succeed(ProcessRunner.ProcessRunner, {
      run: (input) =>
        Effect.sync(() => {
          calls.push(input.args);
          return {
            stdout: input.args.includes("rev-parse")
              ? "/repo\n"
              : "origin\tgit@github.com:StudioTools/studio.git (fetch)\n",
            stderr: "",
            code: ChildProcessSpawner.ExitCode(0),
            timedOut: false,
            stdoutTruncated: false,
            stderrTruncated: false,
            stdoutInvalidUtf8: false,
            stderrInvalidUtf8: false,
          };
        }),
    });
    const layerResolver = Layer.effect(
      RepositoryIdentityResolver.RepositoryIdentityResolver,
      RepositoryIdentityResolver.make({
        negativeCacheTtl: Duration.minutes(5),
        cwdExists: (cwd) => Effect.sync(() => existing.has(cwd)),
      }),
    ).pipe(Layer.provide(layerProcessRunner));

    return Effect.gen(function* () {
      const resolver = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
      expect(yield* resolver.resolve("/gone/checkout")).toBeNull();
      expect(calls).toEqual([]);

      // Still null inside the negative TTL, even once the folder appears...
      existing.add("/gone/checkout");
      yield* TestClock.adjust(Duration.minutes(1));
      expect(yield* resolver.resolve("/gone/checkout")).toBeNull();
      expect(calls).toEqual([]);
      // ...and found after it, or at once when a caller asks for a refresh.
      expect((yield* resolver.resolve("/repo/packages/web", { refresh: true }))?.rootPath).toBe(
        "/repo",
      );
      yield* TestClock.adjust(Duration.minutes(5));
      expect((yield* resolver.resolve("/gone/checkout"))?.rootPath).toBe("/repo");
      expect(calls).toEqual([
        ["-C", "/repo/packages/web", "rev-parse", "--show-toplevel"],
        ["-C", "/repo", "remote", "-v"],
        ["-C", "/gone/checkout", "rev-parse", "--show-toplevel"],
      ]);
    }).pipe(Effect.provide(Layer.merge(TestClock.layer(), layerResolver)));
  });

  it.effect("normalizes equivalent GitHub remotes into a stable repository identity", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "studio-repository-identity-test-",
      });

      yield* git(cwd, ["init"]);
      yield* git(cwd, ["remote", "add", "origin", "git@github.com:StudioTools/studio.git"]);

      const resolver = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
      const identity = yield* resolver.resolve(cwd);
      // Native realpath, since git reports the long form of a directory the
      // temp dir may name by its 8.3 short form on Windows.
      const resolvedIdentityRoot =
        identity?.rootPath === undefined ? "" : NodeFS.realpathSync.native(identity.rootPath);
      const resolvedCwd = NodeFS.realpathSync.native(cwd);

      expect(identity).not.toBeNull();
      expect(identity?.canonicalKey).toBe("github.com/studiotools/studio");
      expect(normalizeResolvedPath(resolvedIdentityRoot)).toBe(normalizeResolvedPath(resolvedCwd));
      expect(identity?.displayName).toBe("studiotools/studio");
      expect(identity?.provider).toBe("github");
      expect(identity?.owner).toBe("studiotools");
      expect(identity?.name).toBe("studio");
    }).pipe(Effect.provide(RepositoryIdentityResolver.layer)),
  );

  it.effect.each(["origin", "upstream"] as const)(
    "resolves a real local partial-clone with an annotated %s remote",
    (remoteName) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "studio-repository-identity-partial-clone-",
        });
        const source = path.join(root, "source");
        const clone = path.join(root, "clone");
        yield* fileSystem.makeDirectory(source);
        expect((yield* git(source, ["init"])).code).toBe(0);
        yield* fileSystem.writeFileString(path.join(source, "README.md"), "local fixture\n");
        expect((yield* git(source, ["add", "README.md"])).code).toBe(0);
        expect(
          (yield* git(source, [
            "-c",
            "user.name=Studio Test",
            "-c",
            "user.email=studio-test@example.invalid",
            "-c",
            "commit.gpgsign=false",
            "commit",
            "-m",
            "local fixture",
          ])).code,
        ).toBe(0);
        expect((yield* git(source, ["config", "uploadpack.allowFilter", "true"])).code).toBe(0);
        // --no-local uses upload-pack even for this scratch path, so the clone
        // really negotiates a blob filter. No network or real fleet config is used.
        expect(
          (yield* git(root, [
            "clone",
            "--no-local",
            "--no-checkout",
            "--filter=blob:none",
            "--origin",
            remoteName,
            source,
            clone,
          ])).code,
        ).toBe(0);
        expect(
          (yield* git(clone, ["rev-list", "--objects", "--all", "--missing=print"])).stdout,
        ).toMatch(/^\?[0-9a-f]{40}$/m);
        const remoteUrl = "git@github.com:anton-abyzov/specweave-umb.git";
        expect((yield* git(clone, ["remote", "set-url", remoteName, remoteUrl])).code).toBe(0);
        expect((yield* git(clone, ["config", `remote.${remoteName}.promisor`])).stdout.trim()).toBe(
          "true",
        );
        const remoteOutput = (yield* git(clone, ["remote", "-v"])).stdout;
        expect(remoteOutput).toContain(`${remoteName}\t${remoteUrl} (fetch) [blob:none]`);

        const resolver = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
        const identity = yield* resolver.resolve(clone);
        expect(identity?.canonicalKey).toBe("github.com/anton-abyzov/specweave-umb");
        expect(identity?.locator).toEqual({ source: "git-remote", remoteName, remoteUrl });
        if (identity?.rootPath === undefined) {
          throw new Error("Expected resolved repository root path");
        }
        expect(NodeFS.realpathSync.native(identity.rootPath)).toBe(
          NodeFS.realpathSync.native(clone),
        );

        const otherRemote = remoteName === "origin" ? "upstream" : "origin";
        expect(
          (yield* git(clone, ["remote", "add", otherRemote, "git@github.com:acme/other.git"])).code,
        ).toBe(0);
        const preferred = yield* resolver.resolve(clone, { refresh: true });
        expect(preferred?.locator.remoteName).toBe("upstream");
        expect(preferred?.canonicalKey).toBe(
          remoteName === "upstream"
            ? "github.com/anton-abyzov/specweave-umb"
            : "github.com/acme/other",
        );
        expect(preferred?.origin?.canonicalKey).toBe(
          remoteName === "origin"
            ? "github.com/anton-abyzov/specweave-umb"
            : "github.com/acme/other",
        );
      }).pipe(Effect.provide(RepositoryIdentityResolver.layer)),
  );

  it.effect.each([
    { suffix: " [tree:0]", valid: true },
    { suffix: " [blob:limit=1048576]", valid: true },
    { suffix: " [combine:blob:none+tree:1]", valid: true },
    { suffix: " [blob:none", valid: false },
    { suffix: " [blob:none] garbage", valid: false },
    { suffix: " arbitrary trailing text", valid: false },
  ])("accepts only complete partial-clone remote annotations: $suffix", ({ suffix, valid }) => {
    const layerProcessRunner = Layer.succeed(ProcessRunner.ProcessRunner, {
      run: (input) =>
        Effect.succeed({
          stdout: input.args.includes("rev-parse")
            ? "/repo\n"
            : [
                `origin\tgit@github.com:acme/fetch.git (fetch)${suffix}`,
                "origin\tgit@github.com:acme/push.git (push) [blob:none]",
                "upstream\tgit@github.com:acme/push-only.git (push)",
                "missing-url (fetch)",
                "malformed\tgit@github.com:acme/malformed.git fetch",
              ].join("\n"),
          stderr: "",
          code: ChildProcessSpawner.ExitCode(0),
          timedOut: false,
          stdoutTruncated: false,
          stderrTruncated: false,
          stdoutInvalidUtf8: false,
          stderrInvalidUtf8: false,
        }),
    });
    const layerResolver = Layer.effect(
      RepositoryIdentityResolver.RepositoryIdentityResolver,
      RepositoryIdentityResolver.make(),
    ).pipe(Layer.provide(layerProcessRunner));
    return Effect.gen(function* () {
      const resolver = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
      const identity = yield* resolver.resolve("/repo");
      if (valid) {
        expect(identity?.canonicalKey).toBe("github.com/acme/fetch");
        expect(identity?.locator).toEqual({
          source: "git-remote",
          remoteName: "origin",
          remoteUrl: "git@github.com:acme/fetch.git",
        });
      } else {
        expect(identity).toBeNull();
      }
    }).pipe(Effect.provide(layerResolver));
  });

  it.effect("returns the git top-level root path when resolving from a nested workspace", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const repoRoot = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "studio-repository-identity-nested-root-test-",
      });
      const nestedWorkspace = path.join(repoRoot, "packages", "web");

      yield* fileSystem.makeDirectory(nestedWorkspace, { recursive: true });
      yield* git(repoRoot, ["init"]);
      yield* git(repoRoot, ["remote", "add", "origin", "git@github.com:StudioTools/studio.git"]);

      const resolver = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
      const identity = yield* resolver.resolve(nestedWorkspace);
      const resolvedIdentityRoot =
        identity?.rootPath === undefined ? "" : NodeFS.realpathSync.native(identity.rootPath);
      const resolvedRepoRoot = NodeFS.realpathSync.native(repoRoot);

      expect(identity).not.toBeNull();
      expect(identity?.canonicalKey).toBe("github.com/studiotools/studio");
      expect(normalizeResolvedPath(resolvedIdentityRoot)).toBe(
        normalizeResolvedPath(resolvedRepoRoot),
      );
    }).pipe(Effect.provide(RepositoryIdentityResolver.layer)),
  );

  it.effect("returns null for non-git folders and repos without remotes", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const nonGitDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "studio-repository-identity-non-git-",
      });
      const gitDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "studio-repository-identity-no-remote-",
      });

      yield* git(gitDir, ["init"]);

      const resolver = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
      const nonGitIdentity = yield* resolver.resolve(nonGitDir);
      const noRemoteIdentity = yield* resolver.resolve(gitDir);

      expect(nonGitIdentity).toBeNull();
      expect(noRemoteIdentity).toBeNull();
    }).pipe(Effect.provide(RepositoryIdentityResolver.layer)),
  );

  it.effect.each(["add", "replace"] as const)(
    "refreshes the primary upstream after %s before cache expiry",
    (change) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const cwd = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "studio-repository-identity-upstream-test-",
        });

        yield* git(cwd, ["init"]);
        yield* git(cwd, ["remote", "add", "origin", "git@github.com:acme/studio.git"]);
        if (change === "replace") {
          yield* git(cwd, ["remote", "add", "upstream", "git@github.com:StudioTools/previous.git"]);
        }

        const resolver = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
        const initialIdentity = yield* resolver.resolve(cwd);
        expect(initialIdentity?.canonicalKey).toBe(
          change === "add" ? "github.com/acme/studio" : "github.com/studiotools/previous",
        );

        yield* git(cwd, [
          "remote",
          change === "add" ? "add" : "set-url",
          "upstream",
          "git@github.com:StudioTools/studio.git",
        ]);
        expect(yield* resolver.resolve(cwd)).toEqual(initialIdentity);
        const identity = yield* resolver.resolve(cwd, { refresh: true });

        expect(identity).not.toBeNull();
        expect(identity?.locator.remoteName).toBe("upstream");
        expect(identity?.canonicalKey).toBe("github.com/studiotools/studio");
        expect(identity?.displayName).toBe("studiotools/studio");
        expect(yield* resolver.resolve(cwd)).toEqual(identity);
      }).pipe(Effect.provide(RepositoryIdentityResolver.layer)),
  );

  it.effect("reports a fork's own remote as origin next to the upstream identity", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "studio-repository-identity-fork-test-",
      });

      yield* git(cwd, ["init"]);
      yield* git(cwd, ["remote", "add", "origin", "git@github.com:acme/studio-fork.git"]);
      yield* git(cwd, ["remote", "add", "upstream", "git@github.com:StudioTools/studio.git"]);

      const resolver = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
      const identity = yield* resolver.resolve(cwd);

      expect(identity?.canonicalKey).toBe("github.com/studiotools/studio");
      expect(identity?.displayName).toBe("studiotools/studio");
      expect(identity?.origin).toEqual({
        canonicalKey: "github.com/acme/studio-fork",
        displayName: "acme/studio-fork",
      });
    }).pipe(Effect.provide(RepositoryIdentityResolver.layer)),
  );

  it.effect("uses the last remote path segment as the repository name for nested groups", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "studio-repository-identity-nested-group-test-",
      });

      yield* git(cwd, ["init"]);
      yield* git(cwd, [
        "remote",
        "add",
        "origin",
        "git@gitlab.com:StudioTools/platform/studio.git",
      ]);

      const resolver = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
      const identity = yield* resolver.resolve(cwd);

      expect(identity).not.toBeNull();
      expect(identity?.canonicalKey).toBe("gitlab.com/studiotools/platform/studio");
      expect(identity?.displayName).toBe("studiotools/platform/studio");
      expect(identity?.owner).toBe("studiotools");
      expect(identity?.name).toBe("studio");
    }).pipe(Effect.provide(RepositoryIdentityResolver.layer)),
  );

  it.effect(
    "keeps null identities cached across repeated resolves until the negative TTL expires",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const cwd = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "studio-repository-identity-late-remote-test-",
        });

        yield* git(cwd, ["init"]);

        const resolver = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
        const initialIdentity = yield* resolver.resolve(cwd);
        expect(initialIdentity).toBeNull();

        yield* git(cwd, ["remote", "add", "origin", "git@github.com:StudioTools/studio.git"]);

        for (const _attempt of [1, 2, 3]) {
          const cachedIdentity = yield* resolver.resolve(cwd);
          expect(cachedIdentity).toBeNull();
        }

        yield* TestClock.adjust(Duration.millis(120));

        const refreshedIdentity = yield* resolver.resolve(cwd);
        expect(refreshedIdentity).not.toBeNull();
        expect(refreshedIdentity?.canonicalKey).toBe("github.com/studiotools/studio");
        expect(refreshedIdentity?.name).toBe("studio");
      }).pipe(
        Effect.provide(
          Layer.merge(
            TestClock.layer(),
            layerRepositoryIdentityResolverTest({
              negativeCacheTtl: Duration.millis(50),
              positiveCacheTtl: Duration.seconds(1),
            }),
          ),
        ),
      ),
  );

  it.effect("refreshes cached identities after the positive TTL when a remote changes", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "studio-repository-identity-remote-change-test-",
      });

      yield* git(cwd, ["init"]);
      yield* git(cwd, ["remote", "add", "origin", "git@github.com:StudioTools/studio.git"]);

      const resolver = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
      const initialIdentity = yield* resolver.resolve(cwd);
      expect(initialIdentity).not.toBeNull();
      expect(initialIdentity?.canonicalKey).toBe("github.com/studiotools/studio");

      yield* git(cwd, [
        "remote",
        "set-url",
        "origin",
        "git@github.com:StudioTools/studio-next.git",
      ]);

      const cachedIdentity = yield* resolver.resolve(cwd);
      expect(cachedIdentity).not.toBeNull();
      expect(cachedIdentity?.canonicalKey).toBe("github.com/studiotools/studio");

      yield* TestClock.adjust(Duration.millis(180));

      const refreshedIdentity = yield* resolver.resolve(cwd);
      expect(refreshedIdentity).not.toBeNull();
      expect(refreshedIdentity?.canonicalKey).toBe("github.com/studiotools/studio-next");
      expect(refreshedIdentity?.displayName).toBe("studiotools/studio-next");
      expect(refreshedIdentity?.name).toBe("studio-next");
    }).pipe(
      Effect.provide(
        Layer.merge(
          TestClock.layer(),
          layerRepositoryIdentityResolverTest({
            negativeCacheTtl: Duration.millis(50),
            positiveCacheTtl: Duration.millis(100),
          }),
        ),
      ),
    ),
  );
});
