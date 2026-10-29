import * as NodePath from "@effect/platform-node/NodePath";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/process";

import {
  GitCommandError,
  SourceControlProviderError,
  type SourceControlCloneRepositoryInput,
} from "@specweave-studio/contracts";

import * as ServerConfig from "../config.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as BitbucketApi from "./BitbucketApi.ts";
import * as BitbucketSourceControlProvider from "./BitbucketSourceControlProvider.ts";
import type * as SourceControlProvider from "./SourceControlProvider.ts";
import * as SourceControlProviderRegistry from "./SourceControlProviderRegistry.ts";
import * as SourceControlRepositoryService from "./SourceControlRepositoryService.ts";

const isSourceControlProviderError = Schema.is(SourceControlProviderError);

const CLONE_URLS = {
  nameWithOwner: "octocat/studio",
  url: "https://github.com/octocat/studio",
  sshUrl: "git@github.com:octocat/studio.git",
};

function makeProvider(
  overrides: Partial<SourceControlProvider.SourceControlProvider["Service"]> = {},
): SourceControlProvider.SourceControlProvider["Service"] {
  const unsupported = (operation: string) =>
    Effect.die(`unexpected provider operation ${operation}`) as Effect.Effect<
      never,
      SourceControlProviderError
    >;

  return {
    kind: "github",
    listChangeRequests: () => unsupported("listChangeRequests"),
    getChangeRequest: () => unsupported("getChangeRequest"),
    createChangeRequest: () => unsupported("createChangeRequest"),
    getRepositoryCloneUrls: () => Effect.succeed(CLONE_URLS),
    createRepository: () => Effect.succeed(CLONE_URLS),
    getDefaultBranch: () => Effect.succeed(null),
    checkoutChangeRequest: () => unsupported("checkoutChangeRequest"),
    ...overrides,
  };
}

function processOutput(): GitVcsDriver.ExecuteGitResult {
  return {
    exitCode: ChildProcessSpawner.ExitCode(0),
    stdout: "",
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
  };
}

function layer(input: {
  readonly provider?: SourceControlProvider.SourceControlProvider["Service"];
  readonly git?: Partial<GitVcsDriver.GitVcsDriver["Service"]>;
  readonly fileSystem?: FileSystem.FileSystem;
}) {
  const layerService = SourceControlRepositoryService.layer.pipe(
    Layer.provide(
      Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({
        resolveLink: () => undefined,
        get: () => Effect.succeed(input.provider ?? makeProvider()),
      }),
    ),
    Layer.provide(
      Layer.mock(GitVcsDriver.GitVcsDriver)({
        execute: () => Effect.succeed(processOutput()),
        ensureRemote: () => Effect.succeed("origin"),
        pushCurrentBranch: () =>
          Effect.succeed({
            status: "pushed" as const,
            branch: "feature/remote-v1",
            upstreamBranch: "origin/feature/remote-v1",
            setUpstream: true,
          }),
        ...input.git,
      }),
    ),
    Layer.provide(
      ServerConfig.layerTest(
        process.cwd(),
        input.fileSystem
          ? "/tmp/studio-source-control-repos"
          : { prefix: "studio-source-control-repos-" },
      ),
    ),
  );

  return input.fileSystem
    ? layerService.pipe(
        Layer.provide(Layer.succeed(FileSystem.FileSystem, input.fileSystem)),
        Layer.provideMerge(NodePath.layer),
      )
    : layerService.pipe(Layer.provideMerge(NodeServices.layer));
}

it.effect("looks up repositories through the requested provider without search", () => {
  const calls: Array<{ cwd: string; repository: string }> = [];
  const provider = makeProvider({
    getRepositoryCloneUrls: (input) =>
      Effect.sync(() => {
        calls.push({ cwd: input.cwd, repository: input.repository });
        return CLONE_URLS;
      }),
  });

  return Effect.gen(function* () {
    const service = yield* SourceControlRepositoryService.SourceControlRepositoryService;
    const result = yield* service.lookupRepository({
      provider: "github",
      repository: "octocat/studio",
      cwd: "/workspace",
    });

    assert.deepStrictEqual(result, { provider: "github", ...CLONE_URLS });
    assert.deepStrictEqual(calls, [{ cwd: "/workspace", repository: "octocat/studio" }]);
  }).pipe(Effect.provide(layer({ provider })));
});

it.effect("preserves provider failures without deriving the repository message from them", () => {
  const providerCause = new SourceControlProviderError({
    provider: "github",
    operation: "getRepositoryCloneUrls",
    cwd: "/workspace",
    repository: "octocat/studio",
    detail: "credential token abc123 was rejected",
  });
  const provider = makeProvider({
    getRepositoryCloneUrls: () => Effect.fail(providerCause),
  });

  return Effect.gen(function* () {
    const service = yield* SourceControlRepositoryService.SourceControlRepositoryService;
    const error = yield* Effect.flip(
      service.lookupRepository({
        provider: "github",
        repository: "octocat/studio",
        cwd: "/workspace",
      }),
    );

    assert.strictEqual(error.provider, "github");
    assert.strictEqual(error.operation, "lookupRepository");
    assert.strictEqual(error.detail, "The source control operation could not be completed.");
    assert.strictEqual(
      error.message,
      "Source control repository operation lookupRepository failed for github: The source control operation could not be completed.",
    );
    assert.strictEqual(error.cause, providerCause);
  }).pipe(Effect.provide(layer({ provider })));
});

it.effect(
  "reports the safe Bitbucket locator detail through repository lookup and publishing",
  () =>
    Effect.gen(function* () {
      const locatorCause = new BitbucketApi.BitbucketRepositoryLocatorError({
        repository: "credential-token-abc123",
      });
      const provider = yield* BitbucketSourceControlProvider.make.pipe(
        Effect.provide(
          Layer.mock(BitbucketApi.BitbucketApi)({
            getRepositoryCloneUrls: () => Effect.fail(locatorCause),
            createRepository: () => Effect.fail(locatorCause),
          }),
        ),
      );

      yield* Effect.gen(function* () {
        const service = yield* SourceControlRepositoryService.SourceControlRepositoryService;
        const input = {
          provider: "bitbucket" as const,
          repository: locatorCause.repository,
          cwd: "/workspace",
        };
        for (const operation of [
          service.lookupRepository(input).pipe(Effect.asVoid),
          service.publishRepository({ ...input, visibility: "private" }).pipe(Effect.asVoid),
        ]) {
          const error = yield* Effect.flip(operation);

          assert.strictEqual(error.provider, "bitbucket");
          assert.strictEqual(
            error.detail,
            "Bitbucket repositories must be specified as workspace/repository.",
          );
          assert.notInclude(error.message, locatorCause.repository);
          assert.instanceOf(error.cause, SourceControlProviderError);
          assert.strictEqual(
            isSourceControlProviderError(error.cause) ? error.cause.cause : null,
            locatorCause,
          );
        }
      }).pipe(Effect.provide(layer({ provider })));
    }),
);

it.effect("keeps a plain Bitbucket locator lookalike out of the repository message", () => {
  const provider = makeProvider({
    kind: "bitbucket",
    getRepositoryCloneUrls: () =>
      Effect.fail(
        new SourceControlProviderError({
          provider: "bitbucket",
          operation: "getRepositoryCloneUrls",
          cwd: "/workspace",
          detail: "credential token abc123 was rejected",
          cause: {
            _tag: "BitbucketRepositoryLocatorError",
            repository: "studio",
            detail: "credential token abc123 was rejected",
          },
        }),
      ),
  });

  return Effect.gen(function* () {
    const service = yield* SourceControlRepositoryService.SourceControlRepositoryService;
    const error = yield* Effect.flip(
      service.lookupRepository({ provider: "bitbucket", repository: "studio" }),
    );

    assert.strictEqual(error.detail, "The source control operation could not be completed.");
    assert.notInclude(error.message, "abc123");
  }).pipe(Effect.provide(layer({ provider })));
});

it.effect("keeps arbitrary Bitbucket request failures out of the repository message", () =>
  Effect.gen(function* () {
    const cause = new BitbucketApi.BitbucketRequestError({
      operation: "getRepository",
      cause: new Error("credential token abc123 was rejected"),
    });
    const provider = yield* BitbucketSourceControlProvider.make.pipe(
      Effect.provide(
        Layer.mock(BitbucketApi.BitbucketApi)({
          getRepositoryCloneUrls: () => Effect.fail(cause),
        }),
      ),
    );

    yield* Effect.gen(function* () {
      const service = yield* SourceControlRepositoryService.SourceControlRepositoryService;
      const error = yield* Effect.flip(
        service.lookupRepository({
          provider: "bitbucket",
          repository: "anton-abyzov/specwithcode",
          cwd: "/workspace",
        }),
      );

      assert.strictEqual(error.detail, "The source control operation could not be completed.");
      assert.notInclude(error.message, "abc123");
      assert.notInclude(error.message, cause.detail);
    }).pipe(Effect.provide(layer({ provider })));
  }),
);

it.effect("clones a looked-up repository into the requested destination", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const parent = yield* fs.makeTempDirectoryScoped({
      prefix: "studio-source-control-clone-parent-",
    });
    const destinationPath = path.join(parent, "studio");
    const cloneCalls: Array<{ cwd: string; args: ReadonlyArray<string> }> = [];

    yield* Effect.gen(function* () {
      const service = yield* SourceControlRepositoryService.SourceControlRepositoryService;
      const result = yield* service.cloneRepository({
        provider: "github",
        repository: "octocat/studio",
        destinationPath,
        protocol: "https",
      });

      assert.deepStrictEqual(result, {
        cwd: destinationPath,
        remoteUrl: CLONE_URLS.url,
        repository: { provider: "github", ...CLONE_URLS },
      });
      assert.deepStrictEqual(cloneCalls, [
        {
          cwd: parent,
          args: ["clone", "--progress", "--", CLONE_URLS.url, "studio"],
        },
      ]);
    }).pipe(
      Effect.provide(
        layer({
          git: {
            execute: (input) =>
              Effect.sync(() => {
                cloneCalls.push({ cwd: input.cwd, args: input.args });
                return processOutput();
              }),
          },
        }),
      ),
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect.each(["--bare", "source.git"])(
  "clones a local repository named %s as a working tree",
  (repositoryName) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const git = yield* GitVcsDriver.GitVcsDriver;
      const parent = yield* fs.makeTempDirectoryScoped({ prefix: "studio-clone-options-" });
      yield* git.execute({
        operation: "test.init",
        cwd: parent,
        args: ["init", "--bare", path.join(parent, repositoryName)],
      });
      const destinationPath = path.join(parent, "checkout");
      yield* Effect.gen(function* () {
        const service = yield* SourceControlRepositoryService.SourceControlRepositoryService;
        const result = yield* service.cloneRepository({
          remoteUrl: repositoryName,
          destinationPath,
        });
        assert.strictEqual(result.cwd, destinationPath);
        assert.isTrue(yield* fs.exists(path.join(destinationPath, ".git")));
      }).pipe(Effect.provide(layer({ git: { execute: git.execute } })));
    }).pipe(
      Effect.provide(
        GitVcsDriver.layer.pipe(
          Layer.provide(
            ServerConfig.layerTest(process.cwd(), {
              prefix: "studio-clone-options-config-",
            }),
          ),
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    ),
);

it.effect("reports clone progress from git's stderr and keeps its error text on failure", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const parent = yield* fs.makeTempDirectoryScoped({
      prefix: "studio-source-control-clone-progress-",
    });
    const destinationPath = path.join(parent, "studio");
    const progress: Array<{ stage: string; percent: number | null; detail: string | null }> = [];

    const stderrLines = [
      "Cloning into 'studio'...",
      "remote: Enumerating objects: 10, done.",
      "Receiving objects:  40% (4/10), 1.00 MiB | 2.00 MiB/s",
      "Receiving objects: 100% (10/10), 2.50 MiB | 2.00 MiB/s, done.",
      "fatal: early EOF",
      "fatal: unable to access 'https://user:s3c@ret@github.com/octocat/studio.git/': could not resolve host",
    ];
    const error = yield* Effect.gen(function* () {
      const service = yield* SourceControlRepositoryService.SourceControlRepositoryService;
      return yield* Effect.flip(
        service.cloneRepository(
          { remoteUrl: CLONE_URLS.sshUrl, destinationPath },
          { onProgress: (line) => Effect.sync(() => void progress.push(line)) },
        ),
      );
    }).pipe(
      Effect.provide(
        layer({
          git: {
            execute: (input) =>
              Effect.gen(function* () {
                for (const line of stderrLines) {
                  yield* input.progress?.onStderrLine?.(line) ?? Effect.void;
                }
                return yield* new GitCommandError({
                  operation: input.operation,
                  command: "git",
                  cwd: input.cwd,
                  detail: "Git command exited with a non-zero status.",
                  exitCode: 128,
                });
              }),
          },
        }),
      ),
    );

    assert.deepStrictEqual(progress, [
      { stage: "counting", percent: null, detail: null },
      { stage: "receiving", percent: 40, detail: "1.00 MiB | 2.00 MiB/s" },
      { stage: "receiving", percent: 100, detail: "2.50 MiB | 2.00 MiB/s" },
    ]);
    // Git echoes the remote in some failures; the credentials must not follow.
    assert.strictEqual(
      error.detail,
      "fatal: early EOF fatal: unable to access 'https://github.com/octocat/studio.git/': could not resolve host",
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);

function rejectingSsh(
  urls: Array<string>,
  httpsFails: boolean,
  reason: GitCommandError["reason"] = "authentication_failed",
) {
  return {
    execute: (input: GitVcsDriver.ExecuteGitInput) =>
      Effect.gen(function* () {
        const url = input.args.at(-2)!;
        urls.push(url);
        if (url.startsWith("https://") && !httpsFails) return processOutput();
        yield* (
          input.progress?.onStderrLine?.(
            url.startsWith("https://")
              ? "fatal: could not read Username for 'https://github.com': terminal prompts disabled"
              : "git@github.com: Permission denied (publickey).",
          ) ?? Effect.void
        );
        return yield* new GitCommandError({
          operation: input.operation,
          command: "git",
          cwd: input.cwd,
          reason,
          detail: "Git command exited with a non-zero status.",
        });
      }),
  } satisfies Partial<GitVcsDriver.GitVcsDriver["Service"]>;
}

const cloneInTemporaryDirectory = (
  git: Partial<GitVcsDriver.GitVcsDriver["Service"]>,
  input: Omit<SourceControlCloneRepositoryInput, "destinationPath">,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const parent = yield* fs
      .makeTempDirectoryScoped({ prefix: "studio-clone-fallback-" })
      .pipe(Effect.orDie);
    return yield* Effect.gen(function* () {
      const service = yield* SourceControlRepositoryService.SourceControlRepositoryService;
      return yield* service.cloneRepository({
        ...input,
        destinationPath: path.join(parent, "studio"),
      });
    }).pipe(Effect.provide(layer({ git }).pipe(Layer.orDie)));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

it.effect("retries a clone over HTTPS when the SSH login is refused", () =>
  Effect.gen(function* () {
    const urls: Array<string> = [];
    const result = yield* cloneInTemporaryDirectory(rejectingSsh(urls, false), {
      remoteUrl: CLONE_URLS.sshUrl,
    });

    assert.deepStrictEqual(urls, [CLONE_URLS.sshUrl, "https://github.com/octocat/studio.git"]);
    assert.strictEqual(result.remoteUrl, "https://github.com/octocat/studio.git");
  }),
);

it.effect("retries a looked-up repository over the provider's own HTTPS URL", () =>
  Effect.gen(function* () {
    const urls: Array<string> = [];
    const result = yield* cloneInTemporaryDirectory(
      rejectingSsh(urls, false, "host_key_unverified"),
      { provider: "github", repository: "octocat/studio" },
    );

    assert.deepStrictEqual(urls, [CLONE_URLS.sshUrl, CLONE_URLS.url]);
    assert.strictEqual(result.remoteUrl, CLONE_URLS.url);
  }),
);

it.effect("reports both failures when the HTTPS retry fails too", () =>
  Effect.gen(function* () {
    const urls: Array<string> = [];
    const error = yield* Effect.flip(
      cloneInTemporaryDirectory(rejectingSsh(urls, true), { remoteUrl: CLONE_URLS.sshUrl }),
    );

    assert.strictEqual(urls.length, 2);
    assert.strictEqual(
      error.detail,
      "git@github.com: Permission denied (publickey). Cloning over HTTPS instead also failed: fatal: could not read Username for 'https://github.com': terminal prompts disabled",
    );
  }),
);

it.effect.each([
  ["the caller asked for SSH", "ssh", "authentication_failed", CLONE_URLS.sshUrl],
  ["git failed for another reason", undefined, "remote_unreachable", CLONE_URLS.sshUrl],
  [
    "the SSH URL has a custom port",
    undefined,
    "authentication_failed",
    "ssh://git@host.example:2222/a/b.git",
  ],
] as const)("does not retry over HTTPS when %s", ([, protocol, reason, remoteUrl]) =>
  Effect.gen(function* () {
    const urls: Array<string> = [];
    yield* Effect.flip(
      cloneInTemporaryDirectory(rejectingSsh(urls, false, reason), {
        remoteUrl,
        ...(protocol === undefined ? {} : { protocol }),
      }),
    );

    assert.deepStrictEqual(urls, [remoteUrl]);
  }),
);

it.effect("strips embedded credentials from the remote URL it reports", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const parent = yield* fs.makeTempDirectoryScoped({ prefix: "studio-source-control-redact-" });
    const destinationPath = path.join(parent, "studio");
    const cloneArgs: Array<ReadonlyArray<string>> = [];
    const result = yield* Effect.gen(function* () {
      const service = yield* SourceControlRepositoryService.SourceControlRepositoryService;
      return yield* service.prepareClone({
        remoteUrl: "https://user:s3cret@github.com/octocat/studio.git",
        destinationPath,
      });
    }).pipe(
      Effect.provide(
        layer({
          git: {
            execute: (input) =>
              Effect.sync(() => {
                cloneArgs.push(input.args);
                return processOutput();
              }),
          },
        }),
      ),
    );
    assert.equal(result.remoteUrl, "https://github.com/octocat/studio.git");
    // Git itself still receives the credentials.
    assert.equal(result.cloneUrl, "https://user:s3cret@github.com/octocat/studio.git");
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("discards only a directory git wrote to", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const parent = yield* fs.makeTempDirectoryScoped({ prefix: "studio-source-control-discard-" });
    const partial = path.join(parent, "partial");
    yield* fs.makeDirectory(path.join(partial, ".git"), { recursive: true });
    yield* fs.writeFileString(path.join(partial, "README.md"), "half");
    const foreign = path.join(parent, "foreign");
    yield* fs.makeDirectory(foreign);
    yield* fs.writeFileString(path.join(foreign, "notes.txt"), "mine");

    // A file where the directory should be must not be removed either.
    const replaced = path.join(parent, "replaced");
    yield* fs.writeFileString(replaced, "not a directory");

    yield* Effect.gen(function* () {
      const service = yield* SourceControlRepositoryService.SourceControlRepositoryService;
      yield* service.discardClone(partial);
      const error = yield* Effect.flip(service.discardClone(foreign));
      assert.include(error.detail, "not from the clone");
      const replacedError = yield* Effect.flip(service.discardClone(replaced));
      assert.include(replacedError.detail, "could not be inspected");
      // A destination that never got created is nothing to discard.
      yield* service.discardClone(path.join(parent, "missing"));
    }).pipe(Effect.provide(layer({})));

    // The partial clone is emptied but its directory (the workspace root) stays.
    assert.deepStrictEqual(yield* fs.readDirectory(partial), []);
    assert.deepStrictEqual(yield* fs.readDirectory(foreign), ["notes.txt"]);
    assert.strictEqual(yield* fs.readFileString(replaced), "not a directory");
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("redacts query tokens and userinfo containing '@' from reported URLs", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const parent = yield* fs.makeTempDirectoryScoped({ prefix: "studio-source-control-redact2-" });
    yield* Effect.gen(function* () {
      const service = yield* SourceControlRepositoryService.SourceControlRepositoryService;
      const query = yield* service.prepareClone({
        remoteUrl: "https://github.com/octocat/studio.git?access_token=s3cret",
        destinationPath: path.join(parent, "a"),
      });
      assert.equal(query.remoteUrl, "https://github.com/octocat/studio.git");
      const nested = yield* service.prepareClone({
        remoteUrl: "https://user:pa@rt@github.com/octocat/studio.git",
        destinationPath: path.join(parent, "b"),
      });
      assert.equal(nested.remoteUrl, "https://github.com/octocat/studio.git");
    }).pipe(Effect.provide(layer({})));
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("preserves destination probe failures instead of treating them as missing paths", () => {
  const fileSystemCause = PlatformError.systemError({
    _tag: "PermissionDenied",
    module: "FileSystem",
    method: "exists",
    pathOrDescriptor: "/restricted/studio",
  });

  return Effect.gen(function* () {
    const service = yield* SourceControlRepositoryService.SourceControlRepositoryService;
    const error = yield* Effect.flip(
      service.cloneRepository({
        remoteUrl: CLONE_URLS.sshUrl,
        destinationPath: "/restricted/studio",
      }),
    );

    assert.strictEqual(error.provider, "unknown");
    assert.strictEqual(error.operation, "cloneRepository");
    assert.strictEqual(error.cause, fileSystemCause);
  }).pipe(
    Effect.provide(
      layer({
        fileSystem: FileSystem.makeNoop({
          exists: () => Effect.fail(fileSystemCause),
          makeDirectory: () => Effect.void,
        }),
      }),
    ),
  );
});

it.effect("publishes by creating the repository, adding a remote, and pushing upstream", () => {
  const createCalls: Array<{ cwd: string; repository: string; visibility: string }> = [];
  const remoteCalls: Array<{ cwd: string; preferredName: string; url: string }> = [];
  const pushCalls: Array<{ cwd: string; remoteName: string | null | undefined }> = [];
  const provider = makeProvider({
    createRepository: (input) =>
      Effect.sync(() => {
        createCalls.push({
          cwd: input.cwd,
          repository: input.repository,
          visibility: input.visibility,
        });
        return CLONE_URLS;
      }),
  });

  return Effect.gen(function* () {
    const service = yield* SourceControlRepositoryService.SourceControlRepositoryService;
    const result = yield* service.publishRepository({
      cwd: "/workspace",
      provider: "github",
      repository: "octocat/studio",
      visibility: "private",
      remoteName: "origin",
      protocol: "ssh",
    });

    assert.deepStrictEqual(result, {
      repository: { provider: "github", ...CLONE_URLS },
      remoteName: "origin",
      remoteUrl: CLONE_URLS.sshUrl,
      branch: "feature/remote-v1",
      upstreamBranch: "origin/feature/remote-v1",
      status: "pushed",
    });
    assert.deepStrictEqual(createCalls, [
      { cwd: "/workspace", repository: "octocat/studio", visibility: "private" },
    ]);
    assert.deepStrictEqual(remoteCalls, [
      { cwd: "/workspace", preferredName: "origin", url: CLONE_URLS.sshUrl },
    ]);
    assert.deepStrictEqual(pushCalls, [{ cwd: "/workspace", remoteName: "origin" }]);
  }).pipe(
    Effect.provide(
      layer({
        provider,
        git: {
          ensureRemote: (input) =>
            Effect.sync(() => {
              remoteCalls.push(input);
              return "origin";
            }),
          pushCurrentBranch: (cwd, _fallbackBranch, options) =>
            Effect.sync(() => {
              pushCalls.push({ cwd, remoteName: options?.remoteName });
              return {
                status: "pushed" as const,
                branch: "feature/remote-v1",
                upstreamBranch: "origin/feature/remote-v1",
                setUpstream: true,
              };
            }),
        },
      }),
    ),
  );
});

it.effect("publishes to the remote name returned by ensureRemote", () => {
  const pushCalls: Array<{ cwd: string; remoteName: string | null | undefined }> = [];

  return Effect.gen(function* () {
    const service = yield* SourceControlRepositoryService.SourceControlRepositoryService;
    const result = yield* service.publishRepository({
      cwd: "/workspace",
      provider: "github",
      repository: "octocat/studio",
      visibility: "private",
      remoteName: "origin",
      protocol: "ssh",
    });

    assert.equal(result.remoteName, "origin-1");
    assert.deepStrictEqual(pushCalls, [{ cwd: "/workspace", remoteName: "origin-1" }]);
  }).pipe(
    Effect.provide(
      layer({
        git: {
          ensureRemote: () => Effect.succeed("origin-1"),
          pushCurrentBranch: (cwd, _fallbackBranch, options) =>
            Effect.sync(() => {
              pushCalls.push({ cwd, remoteName: options?.remoteName });
              return {
                status: "pushed" as const,
                branch: "feature/remote-v1",
                upstreamBranch: `${options?.remoteName ?? "missing"}/feature/remote-v1`,
                setUpstream: true,
              };
            }),
        },
      }),
    ),
  );
});

it.effect("publish succeeds with status remote_added when the local repo has no commits", () => {
  let pushCalls = 0;
  return Effect.gen(function* () {
    const service = yield* SourceControlRepositoryService.SourceControlRepositoryService;
    const result = yield* service.publishRepository({
      cwd: "/workspace",
      provider: "github",
      repository: "octocat/studio",
      visibility: "private",
      remoteName: "origin",
      protocol: "ssh",
    });

    assert.deepStrictEqual(result, {
      repository: { provider: "github", ...CLONE_URLS },
      remoteName: "origin",
      remoteUrl: CLONE_URLS.sshUrl,
      branch: "main",
      status: "remote_added",
    });
    assert.strictEqual(pushCalls, 0);
  }).pipe(
    Effect.provide(
      layer({
        git: {
          execute: (input) =>
            input.args[0] === "rev-parse"
              ? Effect.fail(
                  new GitCommandError({
                    operation: input.operation,
                    command: "git rev-parse --verify HEAD",
                    cwd: input.cwd,
                    detail: "fatal: Needed a single revision",
                  }),
                )
              : Effect.succeed(processOutput()),
          statusDetails: () =>
            Effect.succeed({
              isRepo: true,
              hasOriginRemote: true,
              isDefaultBranch: true,
              branch: "main",
              upstreamRef: null,
              hasWorkingTreeChanges: false,
              workingTree: { files: [], insertions: 0, deletions: 0 },
              hasUpstream: false,
              aheadCount: 0,
              behindCount: 0,
              aheadOfDefaultCount: 0,
            }),
          pushCurrentBranch: () =>
            Effect.sync(() => {
              pushCalls += 1;
              return {
                status: "pushed" as const,
                branch: "main",
                upstreamBranch: "origin/main",
                setUpstream: true,
              };
            }),
        },
      }),
    ),
  );
});

it.effect("checks remote access with git ls-remote before a clone", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const git = yield* GitVcsDriver.GitVcsDriver;
    const parent = yield* fs.makeTempDirectoryScoped({ prefix: "studio-remote-access-" });
    const bare = path.join(parent, "origin.git");
    yield* git.execute({ operation: "test.init", cwd: parent, args: ["init", "--bare", bare] });
    yield* Effect.gen(function* () {
      const service = yield* SourceControlRepositoryService.SourceControlRepositoryService;
      const ok = yield* service.checkRemoteAccess({ remoteUrl: bare });
      assert.deepStrictEqual(ok, { status: "ok", detail: null });

      const missing = yield* service.checkRemoteAccess({
        remoteUrl: path.join(parent, "missing.git"),
      });
      assert.strictEqual(missing.status, "no-access");
      assert.isNotNull(missing.detail);

      const refused = yield* Effect.flip(
        service.checkRemoteAccess({ remoteUrl: "ext::sh -c touch% /tmp/pwned" }),
      );
      assert.strictEqual(refused.detail, "That clone URL is not allowed.");
      const option = yield* Effect.flip(
        service.checkRemoteAccess({ remoteUrl: "--upload-pack=touch /tmp/pwned" }),
      );
      assert.strictEqual(option.detail, "That clone URL is not allowed.");
    }).pipe(Effect.provide(layer({ git: { execute: git.execute } })));
  }).pipe(
    Effect.provide(
      GitVcsDriver.layer.pipe(
        Layer.provide(
          ServerConfig.layerTest(process.cwd(), { prefix: "studio-remote-access-config-" }),
        ),
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
  ),
);

function lsRemote(urls: Array<string>, answers: (url: string) => "ok" | "denied" | "timeout") {
  return {
    execute: (input: GitVcsDriver.ExecuteGitInput) =>
      Effect.gen(function* () {
        const url = input.args.at(-1)!;
        urls.push(url);
        const answer = answers(url);
        if (answer === "timeout") {
          return yield* new GitCommandError({
            operation: input.operation,
            command: "git",
            cwd: input.cwd,
            detail: "Git command timed out.",
          });
        }
        return answer === "ok"
          ? processOutput()
          : {
              ...processOutput(),
              exitCode: ChildProcessSpawner.ExitCode(128),
              stderr: "git@github.com: Permission denied (publickey).\n",
            };
      }),
  } satisfies Partial<GitVcsDriver.GitVcsDriver["Service"]>;
}

const checkAccess = (git: Partial<GitVcsDriver.GitVcsDriver["Service"]>, remoteUrl: string) =>
  Effect.gen(function* () {
    const service = yield* SourceControlRepositoryService.SourceControlRepositoryService;
    return yield* service.checkRemoteAccess({ remoteUrl });
  }).pipe(Effect.provide(layer({ git })));

it.effect("checks the HTTPS form when the SSH key is refused, as a clone would", () =>
  Effect.gen(function* () {
    const urls: Array<string> = [];
    const result = yield* checkAccess(
      lsRemote(urls, (url) => (url.startsWith("https://") ? "ok" : "denied")),
      CLONE_URLS.sshUrl,
    );
    assert.deepStrictEqual(result, { status: "ok", detail: null });
    assert.deepStrictEqual(urls, [CLONE_URLS.sshUrl, "https://github.com/octocat/studio.git"]);
  }),
);

it.effect("reports the SSH refusal when neither form answers", () =>
  Effect.gen(function* () {
    const urls: Array<string> = [];
    const result = yield* checkAccess(
      lsRemote(urls, () => "denied"),
      CLONE_URLS.sshUrl,
    );
    assert.strictEqual(result.status, "no-access");
    assert.strictEqual(result.detail, "git@github.com: Permission denied (publickey).");
    assert.strictEqual(urls.length, 2);
  }),
);

it.effect.each([
  ["an HTTPS URL", "https://github.com/octocat/studio.git", "denied"],
  ["an SSH URL that timed out", CLONE_URLS.sshUrl, "timeout"],
  ["an SSH URL with a custom port", "ssh://git@host.example:2222/a/b.git", "denied"],
] as const)("asks only once for %s", ([, remoteUrl, answer]) =>
  Effect.gen(function* () {
    const urls: Array<string> = [];
    yield* checkAccess(
      lsRemote(urls, () => answer),
      remoteUrl,
    );
    assert.deepStrictEqual(urls, [remoteUrl]);
  }),
);

it("keeps credentials and tokens out of the remote access detail", () => {
  const detail = SourceControlRepositoryService.remoteAccessDetail(
    "remote: Invalid username or token.\nfatal: Authentication failed for 'https://bob:ghp_abcdefghijklmnop@github.com/o/r.git/'\n",
  );
  assert.isNotNull(detail);
  assert.notInclude(detail ?? "", "ghp_abcdefghijklmnop");
  assert.notInclude(detail ?? "", "bob:");
});

it.effect("inspects a clone destination without reading a parent repository", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const git = yield* GitVcsDriver.GitVcsDriver;
    const parent = yield* fs.makeTempDirectoryScoped({ prefix: "studio-inspect-destination-" });
    const clone = path.join(parent, "clone");
    yield* git.execute({ operation: "test.init", cwd: parent, args: ["init", clone] });
    yield* git.execute({
      operation: "test.remote",
      cwd: clone,
      args: ["remote", "add", "origin", "git@github.com:Team/Repo.git"],
    });
    const worktree = path.join(parent, "worktree");
    yield* git.execute({
      operation: "test.commit",
      cwd: clone,
      args: ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "--allow-empty", "-m", "x"],
    });
    yield* git.execute({
      operation: "test.worktree",
      cwd: clone,
      args: ["worktree", "add", worktree],
    });
    const unfinished = path.join(parent, "unfinished");
    yield* git.execute({ operation: "test.init", cwd: parent, args: ["init", unfinished] });
    yield* git.execute({
      operation: "test.remote",
      cwd: unfinished,
      args: ["remote", "add", "origin", "git@github.com:Team/Repo.git"],
    });
    const plain = path.join(clone, "plain");
    yield* fs.makeDirectory(path.join(plain, "src"), { recursive: true });
    const empty = path.join(parent, "empty");
    yield* fs.makeDirectory(empty);
    yield* Effect.gen(function* () {
      const service = yield* SourceControlRepositoryService.SourceControlRepositoryService;
      const remoteUrl = "https://github.com/team/repo.git";
      const same = yield* service.inspectDestination({ path: clone, remoteUrl });
      assert.deepStrictEqual(same, {
        path: clone,
        state: "repository",
        originKey: "github.com/Team/Repo",
        sameRepository: true,
        checkedOut: true,
      });
      const linked = yield* service.inspectDestination({ path: worktree, remoteUrl });
      assert.strictEqual(linked.state, "repository");
      assert.isTrue(linked.sameRepository);
      assert.isTrue(linked.checkedOut);
      // An interrupted clone: origin written, nothing fetched or checked out.
      const partial = yield* service.inspectDestination({ path: unfinished, remoteUrl });
      assert.deepStrictEqual(partial, {
        path: unfinished,
        state: "repository",
        originKey: "github.com/Team/Repo",
        sameRepository: true,
        checkedOut: false,
      });
      const lock = path.join(clone, ".git", "index.lock");
      yield* fs.writeFileString(lock, "");
      assert.isFalse((yield* service.inspectDestination({ path: clone, remoteUrl })).checkedOut);
      yield* fs.remove(lock);
      const other = yield* service.inspectDestination({
        path: clone,
        remoteUrl: "https://github.com/team/other.git",
      });
      assert.isFalse(other.sameRepository);
      assert.strictEqual(
        (yield* service.inspectDestination({ path: plain, remoteUrl })).state,
        "not-repository",
      );
      assert.strictEqual((yield* service.inspectDestination({ path: empty })).state, "empty");
      assert.strictEqual(
        (yield* service.inspectDestination({ path: path.join(parent, "nope") })).state,
        "missing",
      );
    }).pipe(Effect.provide(layer({ git: { execute: git.execute } })));
  }).pipe(
    Effect.provide(
      GitVcsDriver.layer.pipe(
        Layer.provide(
          ServerConfig.layerTest(process.cwd(), { prefix: "studio-inspect-destination-config-" }),
        ),
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
  ),
);
