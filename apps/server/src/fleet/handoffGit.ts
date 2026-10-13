import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Semaphore from "effect/Semaphore";

import * as ProcessRunner from "../processRunner.ts";
import {
  canonicalOrigin,
  HANDOFF_HEAD,
  HANDOFF_OPERATION,
  handoffRef,
  HandoffGitError,
  HandoffGitManifest,
  type HandoffGitMaterialization,
  type HandoffGitRepository,
  safeRelativePath,
  validManifest,
} from "./handoffGitTypes.ts";

type Stage = HandoffGitError["stage"];
type ManifestInput = { readonly workspaceRoot: string; readonly manifest: HandoffGitManifest };

export class HandoffGit extends Context.Service<
  HandoffGit,
  {
    readonly inspect: (input: {
      readonly operationId: string;
      readonly workspaceRoot: string;
    }) => Effect.Effect<HandoffGitManifest, HandoffGitError>;
    readonly preflight: (input: ManifestInput) => Effect.Effect<void, HandoffGitError>;
    readonly verifyWorkerCheckpoints: (
      input: ManifestInput & {
        readonly workers: ReadonlyArray<{
          readonly worktreePath: string | null;
          readonly branch: string | null;
        }>;
      },
    ) => Effect.Effect<void, HandoffGitError>;
    readonly publish: (
      input: ManifestInput & { readonly publish: true },
    ) => Effect.Effect<HandoffGitManifest, HandoffGitError>;
    /** workspaceRoot must come from a registered project; worktreeParent is server-owned configuration. */
    readonly materialize: (
      input: ManifestInput & { readonly worktreeParent: string },
    ) => Effect.Effect<HandoffGitMaterialization, HandoffGitError>;
  }
>()("studio/fleet/HandoffGit") {}

// Dependency/build caches are not project repositories. Git ignore rules are NOT
// used: initialized repositories in ignored repositories/ or other source dirs
// must be inspected. Hitting any traversal bound fails closed.
const EXCLUDED = new Set([".git", "node_modules"]);
const MAX_DIRECTORIES = 20_000;
const MAX_ENTRIES = 200_000;
const MAX_DEPTH = 24;

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const runner = yield* ProcessRunner.ProcessRunner;
  const lock = yield* Semaphore.make(1);

  const blocked = (stage: Stage, reason: HandoffGitError["reason"]) =>
    Effect.fail(new HandoffGitError({ stage, reason }));
  const io = <A, E, R>(effect: Effect.Effect<A, E, R>, stage: Stage) =>
    effect.pipe(
      Effect.mapError(
        (cause) => new HandoffGitError({ stage, reason: "filesystem-failed", cause }),
      ),
    );
  const checkManifest = (manifest: HandoffGitManifest, stage: Stage) =>
    validManifest(manifest) ? Effect.void : blocked(stage, "invalid-manifest");

  const git = Effect.fn("HandoffGit.git")(function* (
    cwd: string,
    args: ReadonlyArray<string>,
    stage: Stage,
    allowFailure = false,
  ) {
    const result = yield* runner
      .run({
        command: "git",
        args: [
          "--no-optional-locks",
          ...(args[0] === "push" ? [] : ["-c", "core.hooksPath=/dev/null"]),
          "-C",
          cwd,
          ...args,
        ],
        cwd,
        env: { GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", GIT_LITERAL_PATHSPECS: "1" },
        timeout: "60 seconds",
        outputMode: "error",
        maxOutputBytes: 8 * 1024 * 1024,
      })
      .pipe(
        Effect.mapError((cause) => new HandoffGitError({ stage, reason: "git-failed", cause })),
      );
    if (
      result.timedOut ||
      result.code === null ||
      result.stdoutTruncated ||
      result.stderrTruncated ||
      result.stdoutInvalidUtf8 ||
      (!allowFailure && result.code !== 0)
    )
      return yield* blocked(stage, "git-failed");
    return result;
  });
  const text = (cwd: string, args: ReadonlyArray<string>, stage: Stage) =>
    git(cwd, args, stage).pipe(Effect.map((result) => result.stdout.trim()));

  const realDirectory = Effect.fn("HandoffGit.realDirectory")(function* (
    directory: string,
    stage: Stage,
  ) {
    if (!path.isAbsolute(directory) || path.normalize(directory) !== directory)
      return yield* blocked(stage, "unsafe-path");
    const real = yield* io(fs.realPath(directory), stage);
    if (real !== directory || (yield* io(fs.stat(real), stage)).type !== "Directory")
      return yield* blocked(stage, "unsafe-path");
    return real;
  });
  const resolveRepository = Effect.fn("HandoffGit.resolveRepository")(function* (
    root: string,
    relative: string,
    stage: Stage,
  ) {
    if (!safeRelativePath(relative)) return yield* blocked(stage, "unsafe-path");
    const absolute = relative === "." ? root : path.join(root, relative);
    if (!(yield* io(fs.exists(path.join(absolute, ".git")), stage)))
      return yield* blocked(stage, "missing-repository");
    yield* realDirectory(absolute, stage);
    if (
      (yield* io(fs.readLink(path.join(absolute, ".git")).pipe(Effect.option), stage))._tag ===
      "Some"
    )
      return yield* blocked(stage, "unsafe-path");
    const top = yield* text(absolute, ["rev-parse", "--show-toplevel"], stage);
    if (top !== absolute) return yield* blocked(stage, "missing-repository");
    return absolute;
  });

  const discover = Effect.fn("HandoffGit.discover")(function* (root: string, stage: Stage) {
    yield* realDirectory(root, stage);
    const pending = [{ absolute: root, depth: 0 }];
    const repositories: Array<string> = [];
    let directories = 0,
      entries = 0;
    while (pending.length) {
      const current = pending.shift()!;
      if (++directories > MAX_DIRECTORIES || current.depth > MAX_DEPTH)
        return yield* blocked(stage, "scan-limit");
      const names = (yield* io(fs.readDirectory(current.absolute), stage)).sort();
      entries += names.length;
      if (entries > MAX_ENTRIES) return yield* blocked(stage, "scan-limit");
      if (names.includes(".git")) {
        const relative =
          current.absolute === root
            ? "."
            : path.relative(root, current.absolute).split(path.sep).join("/");
        yield* resolveRepository(root, relative, stage);
        repositories.push(relative);
        if (repositories.length > 128) return yield* blocked(stage, "scan-limit");
      }
      for (const name of names) {
        if (EXCLUDED.has(name)) continue;
        const child = path.join(current.absolute, name);
        const link = yield* fs.readLink(child).pipe(Effect.option);
        if (link._tag === "Some") {
          // Never follow links. A link exposing a repository is an ambiguous
          // machine identity, while ordinary tracked file links are preserved.
          const target = yield* fs.stat(child).pipe(Effect.option);
          if (target._tag === "Some" && target.value.type === "Directory")
            return yield* blocked(stage, "unsafe-path");
          continue;
        }
        if ((yield* io(fs.stat(child), stage)).type === "Directory")
          pending.push({ absolute: child, depth: current.depth + 1 });
      }
    }
    if (repositories[0] !== ".") return yield* blocked(stage, "missing-repository");
    return repositories.sort((a, b) => (a === "." ? -1 : b === "." ? 1 : a.localeCompare(b)));
  });

  const identity = Effect.fn("HandoffGit.identity")(function* (cwd: string, stage: Stage) {
    const remote = yield* text(cwd, ["config", "--get-all", "remote.origin.url"], stage);
    const canonical = canonicalOrigin(remote);
    if (!canonical) return yield* blocked(stage, "identity-mismatch");
    const push = yield* git(cwd, ["config", "--get-all", "remote.origin.pushurl"], stage, true);
    if (push.code !== 1 && (push.code !== 0 || canonicalOrigin(push.stdout.trim()) !== canonical))
      return yield* blocked(stage, "identity-mismatch");
    // Git applies insteadOf/pushInsteadOf rewrites after reading remote config.
    // Bind both effective endpoints too; never publish to another identity.
    for (const options of [["--all"], ["--push", "--all"]]) {
      if (
        canonicalOrigin(yield* text(cwd, ["remote", "get-url", ...options, "origin"], stage)) !==
        canonical
      )
        return yield* blocked(stage, "identity-mismatch");
    }
    return canonical;
  });
  const clean = Effect.fn("HandoffGit.clean")(function* (
    cwd: string,
    stage: Stage,
    requireInitialized = true,
  ) {
    if (
      yield* text(
        cwd,
        ["status", "--porcelain=v1", "--untracked-files=all", "--ignore-submodules=none"],
        stage,
      )
    )
      return yield* blocked(stage, "dirty-repository");
    const entries = (yield* git(cwd, ["ls-files", "--stage", "-z"], stage)).stdout.split("\0");
    for (const entry of entries) {
      if (entry.startsWith("120000 ")) {
        const relative = entry.slice(entry.indexOf("\t") + 1);
        if (!safeRelativePath(relative)) return yield* blocked(stage, "unsafe-path");
        const link = yield* io(fs.readLink(path.join(cwd, relative)), stage);
        if (path.isAbsolute(link)) return yield* blocked(stage, "unsafe-path");
        const target = path.resolve(cwd, path.dirname(relative), link);
        if (!target.startsWith(cwd + path.sep)) return yield* blocked(stage, "unsafe-path");
        // A dangling final target can still have an existing parent link that
        // escapes. Resolve the nearest existing ancestor before accepting it.
        let existing = target;
        while (!(yield* io(fs.exists(existing), stage)) && existing !== cwd)
          existing = path.dirname(existing);
        const real = yield* io(fs.realPath(existing), stage);
        if (real !== cwd && !real.startsWith(cwd + path.sep))
          return yield* blocked(stage, "unsafe-path");
      }
      if (!requireInitialized || !entry.startsWith("160000 ")) continue;
      const relative = entry.slice(entry.indexOf("\t") + 1);
      if (
        !safeRelativePath(relative) ||
        !(yield* io(fs.exists(path.join(cwd, relative, ".git")), stage))
      )
        return yield* blocked(stage, "uninitialized-repository");
    }
  });
  const compareAncestry = Effect.fn("HandoffGit.compareAncestry")(function* (
    cwd: string,
    incoming: string,
    stage: Stage,
    allowMissing: boolean,
  ) {
    const object = yield* git(cwd, ["cat-file", "-e", `${incoming}^{commit}`], stage, true);
    if (object.code !== 0) {
      if (allowMissing) return;
      return yield* blocked(stage, "remote-ref-mismatch");
    }
    const ahead = yield* git(cwd, ["merge-base", "--is-ancestor", "HEAD", incoming], stage, true);
    const behind = yield* git(cwd, ["merge-base", "--is-ancestor", incoming, "HEAD"], stage, true);
    if (ahead.code !== 0 && behind.code !== 0) return yield* blocked(stage, "diverged-repository");
  });

  const inspect: HandoffGit["Service"]["inspect"] = Effect.fn("HandoffGit.inspect")(
    function* (input) {
      if (!HANDOFF_OPERATION.test(input.operationId))
        return yield* blocked("inspect", "invalid-manifest");
      const relativePaths = yield* discover(input.workspaceRoot, "inspect");
      const repositories: Array<HandoffGitRepository> = [];
      for (const relativePath of relativePaths) {
        const cwd = yield* resolveRepository(input.workspaceRoot, relativePath, "inspect");
        yield* clean(cwd, "inspect");
        const head = yield* text(cwd, ["rev-parse", "HEAD"], "inspect");
        if (!HANDOFF_HEAD.test(head)) return yield* blocked("inspect", "missing-repository");
        repositories.push({
          relativePath,
          identity: yield* identity(cwd, "inspect"),
          head,
          ref: handoffRef(input.operationId, head),
        });
      }
      const manifest: HandoffGitManifest = {
        version: 1,
        operationId: input.operationId,
        repositories,
      };
      yield* checkManifest(manifest, "inspect");
      return manifest;
    },
  );

  const preflightAt = Effect.fn("HandoffGit.preflightAt")(function* (
    input: ManifestInput,
    stage: Stage,
  ) {
    yield* checkManifest(input.manifest, stage);
    // A destination may have more initialized repositories than this source.
    // Validate only the exact paths being transferred; extra checkouts are not
    // read, fetched, copied, or changed by the handoff.
    for (const repository of input.manifest.repositories) {
      const cwd = yield* resolveRepository(input.workspaceRoot, repository.relativePath, stage);
      if ((yield* identity(cwd, stage)) !== repository.identity)
        return yield* blocked(stage, "identity-mismatch");
      yield* clean(cwd, stage);
      const upstream = yield* git(cwd, ["rev-parse", "--verify", "@{upstream}"], stage, true);
      if (upstream.code === 0) yield* compareAncestry(cwd, upstream.stdout.trim(), stage, false);
      yield* compareAncestry(cwd, repository.head, stage, true);
    }
  });
  const preflight: HandoffGit["Service"]["preflight"] = (input) => preflightAt(input, "preflight");

  const verifyWorkerCheckpoints: HandoffGit["Service"]["verifyWorkerCheckpoints"] = (input) =>
    Effect.gen(function* () {
      const stage = "inspect" as const;
      yield* checkManifest(input.manifest, stage);
      const workers = [
        ...new Map(input.workers.map((worker) => [JSON.stringify(worker), worker])).values(),
      ];
      if (workers.length > 100) return yield* blocked(stage, "worker-checkpoint");
      for (const { worktreePath: workspaceRoot, branch } of workers) {
        // Removing a checkout does not remove its branch. Prove surviving local
        // refs are included before treating the path as historical context.
        if (branch !== null) {
          const ref = `refs/heads/${branch}`;
          if (
            !branch ||
            branch.startsWith("-") ||
            branch.startsWith("refs/") ||
            (yield* git(input.workspaceRoot, ["check-ref-format", ref], stage, true)).code !== 0
          )
            return yield* blocked(stage, "worker-checkpoint");
          for (const repository of input.manifest.repositories) {
            const source = yield* resolveRepository(
              input.workspaceRoot,
              repository.relativePath,
              stage,
            );
            if (
              (yield* identity(source, stage)) !== repository.identity ||
              (yield* text(source, ["rev-parse", "HEAD"], stage)) !== repository.head
            )
              return yield* blocked(stage, "worker-checkpoint");
            const exists = yield* git(
              source,
              ["show-ref", "--verify", "--quiet", ref],
              stage,
              true,
            );
            if (exists.code === 1) continue;
            if (exists.code !== 0) return yield* blocked(stage, "worker-checkpoint");
            const head = yield* text(
              source,
              ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`],
              stage,
            );
            if (
              !HANDOFF_HEAD.test(head) ||
              (yield* git(
                source,
                ["merge-base", "--is-ancestor", head, repository.head],
                stage,
                true,
              )).code !== 0
            )
              return yield* blocked(stage, "worker-checkpoint");
          }
        }
        if (workspaceRoot === null) continue;
        if (!path.isAbsolute(workspaceRoot) || path.normalize(workspaceRoot) !== workspaceRoot)
          return yield* blocked(stage, "worker-checkpoint");
        if ((yield* fs.readLink(workspaceRoot).pipe(Effect.option))._tag === "Some")
          return yield* blocked(stage, "worker-checkpoint");
        if (!(yield* io(fs.exists(workspaceRoot), stage))) {
          if (branch === null) return yield* blocked(stage, "worker-checkpoint");
          continue;
        }
        for (const relativePath of yield* discover(workspaceRoot, stage)) {
          const worker = yield* resolveRepository(workspaceRoot, relativePath, stage);
          yield* clean(worker, stage);
          const workerIdentity = yield* identity(worker, stage);
          const repository = input.manifest.repositories.find(
            (row) => row.identity === workerIdentity,
          );
          if (!repository) return yield* blocked(stage, "worker-checkpoint");
          const source = yield* resolveRepository(
            input.workspaceRoot,
            repository.relativePath,
            stage,
          );
          if (
            (yield* identity(source, stage)) !== repository.identity ||
            (yield* text(source, ["rev-parse", "HEAD"], stage)) !== repository.head
          )
            return yield* blocked(stage, "worker-checkpoint");
          const workerHead = yield* text(worker, ["rev-parse", "HEAD"], stage);
          if (
            !HANDOFF_HEAD.test(workerHead) ||
            (yield* git(
              source,
              ["merge-base", "--is-ancestor", workerHead, repository.head],
              stage,
              true,
            )).code !== 0
          )
            return yield* blocked(stage, "worker-checkpoint");
        }
      }
    }).pipe(
      Effect.mapError(
        (cause) => new HandoffGitError({ stage: "inspect", reason: "worker-checkpoint", cause }),
      ),
    );

  const remoteHead = Effect.fn("HandoffGit.remoteHead")(function* (
    cwd: string,
    ref: string,
    stage: Stage,
  ) {
    const lines = (yield* text(cwd, ["ls-remote", "--refs", "origin", ref], stage))
      .split("\n")
      .filter(Boolean);
    if (lines.length === 0) return null;
    if (lines.length !== 1) return yield* blocked(stage, "remote-ref-mismatch");
    const [head, actualRef] = lines[0]!.split("\t");
    if (!head || !HANDOFF_HEAD.test(head) || actualRef !== ref)
      return yield* blocked(stage, "remote-ref-mismatch");
    return head;
  });
  const publish: HandoffGit["Service"]["publish"] = (input) =>
    lock.withPermit(
      Effect.gen(function* () {
        if (input.publish !== true) return yield* blocked("publish", "invalid-manifest");
        yield* checkManifest(input.manifest, "publish");
        const actual = yield* inspect({
          workspaceRoot: input.workspaceRoot,
          operationId: input.manifest.operationId,
        });
        if (JSON.stringify(actual) !== JSON.stringify(input.manifest))
          return yield* blocked("publish", "source-changed");
        // The operation is bound before the first network write. A process restart
        // can retry a partial publication, but cannot reuse its ID for other code.
        const common = yield* text(
          input.workspaceRoot,
          ["rev-parse", "--path-format=absolute", "--git-common-dir"],
          "publish",
        );
        const records = path.join(common, "studio-handoffs");
        if (!(yield* io(fs.exists(records), "publish")))
          yield* io(fs.makeDirectory(records, { mode: 0o700 }), "publish");
        yield* realDirectory(records, "publish");
        const record = path.join(records, `${input.manifest.operationId}.json`);
        const binding = JSON.stringify(input.manifest);
        if (!(yield* io(fs.exists(record), "publish"))) {
          yield* fs
            .writeFileString(record, binding, { flag: "wx", mode: 0o600 })
            .pipe(Effect.catch(() => Effect.void));
        }
        if (
          (yield* io(fs.readLink(record).pipe(Effect.option), "publish"))._tag === "Some" ||
          (yield* io(fs.readFileString(record), "publish")) !== binding
        )
          return yield* blocked("publish", "operation-conflict");
        for (const repository of input.manifest.repositories) {
          const cwd = yield* resolveRepository(
            input.workspaceRoot,
            repository.relativePath,
            "publish",
          );
          yield* clean(cwd, "publish");
          if (
            (yield* identity(cwd, "publish")) !== repository.identity ||
            (yield* text(cwd, ["rev-parse", "HEAD"], "publish")) !== repository.head
          )
            return yield* blocked("publish", "source-changed");
          const existing = yield* remoteHead(cwd, repository.ref, "publish");
          if (existing !== null && existing !== repository.head)
            return yield* blocked("publish", "remote-ref-mismatch");
          if (existing === null)
            yield* git(
              cwd,
              ["push", "--porcelain", "origin", `${repository.head}:${repository.ref}`],
              "publish",
            );
          if ((yield* remoteHead(cwd, repository.ref, "publish")) !== repository.head)
            return yield* blocked("publish", "remote-ref-mismatch");
        }
        return input.manifest;
      }),
    );

  const materialize: HandoffGit["Service"]["materialize"] = (input) =>
    lock.withPermit(
      Effect.gen(function* () {
        const stage = "materialize" as const;
        yield* preflightAt(input, stage);
        yield* realDirectory(input.worktreeParent, stage);
        if (
          input.worktreeParent === input.workspaceRoot ||
          input.worktreeParent.startsWith(input.workspaceRoot + path.sep)
        )
          return yield* blocked(stage, "unsafe-path");
        const operationDir = path.join(input.worktreeParent, input.manifest.operationId);
        const workspaceRoot = path.join(operationDir, "workspace");
        const receiptPath = path.join(operationDir, "git-operation.json");
        const encoded = JSON.stringify(input.manifest);
        const digest = yield* io(
          crypto.digest("SHA-256", new TextEncoder().encode(encoded)),
          stage,
        );
        const manifestSha256 = Array.from(digest, (byte) =>
          byte.toString(16).padStart(2, "0"),
        ).join("");
        const receipt = JSON.stringify({
          version: 1,
          manifestSha256,
          registeredRoot: input.workspaceRoot,
          manifest: input.manifest,
        });
        if (yield* io(fs.exists(operationDir), stage)) {
          yield* realDirectory(operationDir, stage);
        } else {
          yield* io(fs.makeDirectory(operationDir, { mode: 0o700 }), stage);
        }
        if (!(yield* io(fs.exists(receiptPath), stage))) {
          // Recover a crash after mkdir, before receipt creation. The server-owned
          // UUID directory must be completely empty; never adopt existing files.
          if ((yield* io(fs.readDirectory(operationDir), stage)).length !== 0)
            return yield* blocked(stage, "operation-conflict");
          yield* fs
            .writeFileString(receiptPath, receipt, { flag: "wx", mode: 0o600 })
            .pipe(Effect.catch(() => Effect.void));
        }
        if (
          (yield* io(fs.readLink(receiptPath).pipe(Effect.option), stage))._tag === "Some" ||
          (yield* io(fs.readFileString(receiptPath), stage)) !== receipt
        )
          return yield* blocked(stage, "operation-conflict");
        // Fetch only the named immutable refs. Do not update FETCH_HEAD, branches,
        // remote tracking refs, or the original worktree/index.
        for (const repository of input.manifest.repositories) {
          const cwd = yield* resolveRepository(input.workspaceRoot, repository.relativePath, stage);
          if ((yield* remoteHead(cwd, repository.ref, stage)) !== repository.head)
            return yield* blocked(stage, "remote-ref-mismatch");
          yield* git(
            cwd,
            [
              "fetch",
              "--refmap=",
              "--no-tags",
              "--no-write-fetch-head",
              "--no-recurse-submodules",
              "origin",
              repository.ref,
            ],
            stage,
          );
          if ((yield* remoteHead(cwd, repository.ref, stage)) !== repository.head)
            return yield* blocked(stage, "remote-ref-mismatch");
          yield* compareAncestry(cwd, repository.head, stage, false);
        }
        yield* preflightAt(input, stage);
        const repositories: Array<HandoffGitRepository & { readonly worktreePath: string }> = [];
        for (const repository of input.manifest.repositories) {
          const cwd = yield* resolveRepository(input.workspaceRoot, repository.relativePath, stage);
          const worktreePath =
            repository.relativePath === "."
              ? workspaceRoot
              : path.join(workspaceRoot, repository.relativePath);
          // Ancestors created by an earlier root/nested checkout may be symlinks.
          // Only ordinary directories may contain the new nested worktree.
          const ancestors: Array<string> = [];
          let ancestor = path.dirname(worktreePath);
          while (ancestor !== operationDir) {
            ancestors.unshift(ancestor);
            ancestor = path.dirname(ancestor);
          }
          for (const directory of ancestors) {
            if (yield* io(fs.exists(directory), stage)) yield* realDirectory(directory, stage);
            else yield* io(fs.makeDirectory(directory, { mode: 0o700 }), stage);
          }
          if (yield* io(fs.exists(path.join(worktreePath, ".git")), stage)) {
            yield* resolveRepository(workspaceRoot, repository.relativePath, stage);
            const existingHead = yield* text(worktreePath, ["rev-parse", "HEAD"], stage);
            if ((yield* git(worktreePath, ["symbolic-ref", "-q", "HEAD"], stage, true)).code !== 1)
              return yield* blocked(stage, "worktree-conflict");
            const originalCommon = yield* text(
              cwd,
              ["rev-parse", "--path-format=absolute", "--git-common-dir"],
              stage,
            );
            const outputCommon = yield* text(
              worktreePath,
              ["rev-parse", "--path-format=absolute", "--git-common-dir"],
              stage,
            );
            if (existingHead !== repository.head || originalCommon !== outputCommon)
              return yield* blocked(stage, "worktree-conflict");
            // A previous attempt may have created the root but not its nested
            // worktrees. Their initialization is verified after the entire set.
            yield* clean(worktreePath, stage, false);
          } else {
            if (yield* io(fs.exists(worktreePath), stage)) {
              yield* realDirectory(worktreePath, stage);
              if ((yield* io(fs.readDirectory(worktreePath), stage)).length)
                return yield* blocked(stage, "worktree-conflict");
            }
            yield* git(
              cwd,
              ["worktree", "add", "--detach", "--", worktreePath, repository.head],
              stage,
            );
          }
          if ((yield* text(worktreePath, ["rev-parse", "HEAD"], stage)) !== repository.head)
            return yield* blocked(stage, "worktree-conflict");
          repositories.push({ ...repository, worktreePath });
        }
        for (const repository of repositories) yield* clean(repository.worktreePath, stage);
        yield* preflightAt(input, stage);
        return {
          operationId: input.manifest.operationId,
          workspaceRoot,
          manifestSha256,
          repositories,
        };
      }),
    );

  return HandoffGit.of({ inspect, preflight, verifyWorkerCheckpoints, publish, materialize });
});

export const layer = Layer.effect(HandoffGit, make);
