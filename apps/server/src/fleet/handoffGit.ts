import { stringifyJson } from "../json.ts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Semaphore from "effect/Semaphore";

import * as ProcessRunner from "../processRunner.ts";
import { parseNullConfigList, safeGitConfigEntries } from "./folderTransfer/safeGitConfig.ts";
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
type CheckpointWorker = {
  readonly worktreePath: string | null;
  readonly branch: string | null;
};
type ManifestInput = {
  readonly workspaceRoot: string;
  readonly manifest: HandoffGitManifest;
  readonly resumeProjectFolder?: boolean;
};
/**
 * Updating a destination's existing copy (1326): `inUse` says whether a thread or another
 * project works in a folder; it is asked again right before each repository moves.
 */
export interface ExistingCopyGuard {
  readonly inUse: (folder: string) => Effect.Effect<boolean>;
}

export class HandoffGit extends Context.Service<
  HandoffGit,
  {
    readonly inspect: (input: {
      readonly operationId: string;
      readonly workspaceRoot: string;
      /** Name what is checked out even with uncommitted changes: nothing is sent through Git. */
      readonly allowChanges?: boolean;
    }) => Effect.Effect<HandoffGitManifest, HandoffGitError>;
    /** The destination's folder holds the same repository as the source's root. */
    readonly verifyRootIdentity: (input: ManifestInput) => Effect.Effect<void, HandoffGitError>;
    readonly preflight: (input: ManifestInput) => Effect.Effect<void, HandoffGitError>;
    readonly verifyWorkerCheckpoints: (
      input: ManifestInput & {
        readonly workers: ReadonlyArray<{
          readonly worktreePath: string | null;
          readonly branch: string | null;
        }>;
      },
    ) => Effect.Effect<void, HandoffGitError>;
    /**
     * The workers verifyWorkerCheckpoints would refuse, for a handoff that leaves
     * them on the source: any number of them, without refusing any. Past
     * MAX_REPORTED_WORKTREES surviving worktrees, the rest are reported unchecked.
     */
    readonly reportWorkerCheckpoints: (
      input: ManifestInput & { readonly workers: ReadonlyArray<CheckpointWorker> },
    ) => Effect.Effect<ReadonlyArray<CheckpointWorker>, HandoffGitError>;
    /** `allowChanges`: a Git sync move publishes each repository's HEAD whatever is uncommitted. */
    readonly publish: (
      input: ManifestInput & { readonly publish: true; readonly allowChanges?: boolean },
    ) => Effect.Effect<HandoffGitManifest, HandoffGitError>;
    /**
     * Whether an existing copy can be brought to the manifest heads, without changing it:
     * fails with the reason it cannot (a Git sync move's preview).
     */
    readonly checkExistingCopy: (
      input: ManifestInput & { readonly existingCopy: ExistingCopyGuard },
    ) => Effect.Effect<void, HandoffGitError>;
    /**
     * workspaceRoot must come from a registered project; worktreeParent is server-owned configuration.
     * `existingCopy` (with useProjectFolder): the folder is a copy that predates this move, so its
     * `.git/config` is checked against the safe list first, its root must be on a branch, each
     * repository is re-checked for use right before it moves, and Git LFS files download as their
     * own step.
     */
    readonly materialize: (
      input: ManifestInput & {
        readonly worktreeParent: string;
        readonly useProjectFolder?: boolean;
        readonly existingCopy?: ExistingCopyGuard;
      },
    ) => Effect.Effect<HandoffGitMaterialization, HandoffGitError>;
  }
>()("specweave-studio/fleet/handoffGit") {}

// Dependency/build caches are not project repositories. Git ignore rules are NOT
// used: initialized repositories in ignored repositories/ or other source dirs
// must be inspected. Hitting any traversal bound fails closed.
const EXCLUDED = new Set([".git", "node_modules"]);
const MAX_DIRECTORIES = 20_000;
const MAX_ENTRIES = 200_000;
const MAX_DEPTH = 24;
/**
 * `.git/config` keys an existing copy may hold beyond the folder copy's safe list
 * (`safeGitConfig.ts`): they name people, signing and push defaults, and run nothing
 * during a fetch and fast-forward.
 */
const LOCAL_INERT_KEYS = new Set([
  "user.name",
  "user.email",
  "user.signingkey",
  "commit.gpgsign",
  "tag.gpgsign",
  "gpg.format",
  "push.default",
  "push.autosetupremote",
  "init.defaultbranch",
  "gc.auto",
  "rerere.enabled",
  "rerere.autoupdate",
  "merge.conflictstyle",
  "maintenance.auto",
  "maintenance.strategy",
]);
/** `git lfs install --local` writes these; the update turns LFS filters off either way. */
const STANDARD_LFS_FILTER = new Map([
  ["filter.lfs.clean", "git-lfs clean -- %f"],
  ["filter.lfs.smudge", "git-lfs smudge -- %f"],
  ["filter.lfs.process", "git-lfs filter-process"],
  ["filter.lfs.required", "true"],
]);
const HELPER_URL = /^[A-Za-z][A-Za-z0-9+.-]*::/;

/**
 * The keys of a destination's own `.git/config` entries that could run a command or reach
 * elsewhere during the update, sorted and without values (a URL may hold a token). Remote
 * URLs are judged for running something, not for carrying: a local path is fine here.
 */
export function unsafeExistingCopyConfig(
  entries: ReadonlyArray<readonly [string, string]>,
): Array<string> {
  const unsafe = new Set<string>();
  for (const [rawKey, value] of entries) {
    const key = rawKey.trim();
    const lower = key.toLowerCase();
    if (LOCAL_INERT_KEYS.has(lower) || STANDARD_LFS_FILTER.get(lower) === value.trim()) continue;
    const first = lower.indexOf(".");
    const last = lower.lastIndexOf(".");
    const section = lower.slice(0, first);
    const name = lower.slice(last + 1);
    if (first > 0 && last > first) {
      if (section === "branch" && name !== "mergeoptions") continue;
      if (
        (section === "remote" && (name === "url" || name === "pushurl")) ||
        (section === "submodule" && name === "url")
      ) {
        if (!HELPER_URL.test(value.trim())) continue;
        unsafe.add(key);
        continue;
      }
      if (section === "remote" && ["push", "prune", "mirror", "skipdefaultupdate"].includes(name))
        continue;
      if (section === "submodule" && name === "ignore") continue;
      if (section === "maintenance" && (name === "enabled" || name === "schedule")) continue;
    }
    if (safeGitConfigEntries([[key, value]]).length === 1) continue;
    unsafe.add(key);
  }
  return [...unsafe].sort();
}

/** `.lfsconfig` keys that only choose what LFS fetches; endpoints are pinned anyway. */
const LFSCONFIG_KEYS = new Set([
  "lfs.url",
  "lfs.pushurl",
  "lfs.fetchinclude",
  "lfs.fetchexclude",
  "lfs.locksverify",
]);
/** The keys of a repository's `.lfsconfig` beyond what it may set, sorted. */
export function unsafeLfsConfig(entries: ReadonlyArray<readonly [string, string]>): Array<string> {
  const unsafe = new Set<string>();
  for (const [rawKey] of entries) {
    const key = rawKey.trim().toLowerCase();
    if (LFSCONFIG_KEYS.has(key) || /^remote\.[^.]+(\..+)?\.(lfsurl|lfspushurl)$/.test(key))
      continue;
    unsafe.add(key);
  }
  return [...unsafe].sort();
}
/**
 * The LFS endpoint Git LFS itself derives from an origin URL, pinned so a repository's
 * `.lfsconfig` cannot send the download elsewhere. Null for a form it does not know.
 */
export function lfsEndpoint(origin: string): string | null {
  const value = origin.trim();
  if (/^https?:\/\//i.test(value)) {
    const base = value.replace(/\/+$/, "");
    return `${base.endsWith(".git") ? base : `${base}.git`}/info/lfs`;
  }
  if (/^(ssh|file):\/\//i.test(value)) return value;
  if (value.startsWith("/")) return `file://${value}`;
  const drive = /^([A-Za-z]):[\\/](.*)$/.exec(value);
  if (drive) return `file:///${drive[1]}:/${drive[2]!.replace(/\\/g, "/")}`;
  const scp = /^([A-Za-z0-9._-]+@[A-Za-z0-9.-]+):(?!\/\/)(.+)$/.exec(value);
  if (scp) return `ssh://${scp[1]}/${scp[2]!.replace(/^\/+/, "")}`;
  return null;
}

/** A report walks at most this many surviving worker worktrees, a few at a time. */
export const MAX_REPORTED_WORKTREES = 100;
const WORKTREE_CONCURRENCY = 8;

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const runner = yield* ProcessRunner.ProcessRunner;
  const lock = yield* Semaphore.make(1);

  const blocked = (
    stage: Stage,
    reason: HandoffGitError["reason"],
    detail: { readonly repository?: string; readonly unsafeConfig?: ReadonlyArray<string> } = {},
  ) =>
    Effect.fail(
      new HandoffGitError({
        stage,
        reason,
        ...(detail.repository === undefined ? {} : { repository: detail.repository }),
        ...(detail.unsafeConfig === undefined ? {} : { unsafeConfig: [...detail.unsafeConfig] }),
      }),
    );
  /** Names the repository a refusal stopped at, when it does not already. */
  const at =
    (repository: string) =>
    <A, R>(effect: Effect.Effect<A, HandoffGitError, R>) =>
      effect.pipe(
        Effect.mapError((error) =>
          error.repository !== undefined
            ? error
            : new HandoffGitError({
                stage: error.stage,
                reason: error.reason,
                repository,
                ...(error.unsafeConfig === undefined ? {} : { unsafeConfig: error.unsafeConfig }),
                ...(error.cause === undefined ? {} : { cause: error.cause }),
              }),
        ),
      );
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
    options: {
      /** `-c` settings for this call alone, such as the pinned LFS endpoint. */
      readonly config?: ReadonlyArray<string>;
      /** Pathspec magic (`:(glob)`) for this call; every other call reads pathspecs literally. */
      readonly pathspecMagic?: boolean;
    } = {},
  ) {
    // Git LFS downloads are their own step, so a missing file or server names itself.
    const lfs = args[0] === "lfs";
    const result = yield* runner
      .run({
        command: "git",
        args: [
          "--no-optional-locks",
          // Publication keeps the source's own pre-push checks; nothing else runs a hook,
          // and no file-system monitor command runs in either machine's checkout.
          ...(args[0] === "push"
            ? []
            : ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false"]),
          ...(options.config ?? []).flatMap((setting) => ["-c", setting]),
          "-C",
          cwd,
          ...args,
        ],
        cwd,
        env: {
          GIT_TERMINAL_PROMPT: "0",
          GIT_OPTIONAL_LOCKS: "0",
          // git-lfs checks files out through its own `:(attr)` pathspecs, and with literal
          // pathspecs its pull downloads objects but leaves every file as a pointer.
          GIT_LITERAL_PATHSPECS: options.pathspecMagic || lfs ? "0" : "1",
          // A commit is what its ID names: replace refs and grafts in a checkout could
          // otherwise substitute other trees while HEAD and status look right.
          GIT_NO_REPLACE_OBJECTS: "1",
          GIT_GRAFT_FILE: "/dev/null",
          // Even cat-file/status/ancestry reads can fetch missing promisor objects and
          // rewrite clone config. Only authorized transfer operations may hydrate them.
          GIT_NO_LAZY_FETCH: ["fetch", "push", "worktree", "lfs"].includes(args[0] ?? "")
            ? "0"
            : "1",
          // A checkout writes LFS pointers instead of downloading during a merge.
          ...(lfs ? {} : { GIT_LFS_SKIP_SMUDGE: "1" }),
        },
        timeout: lfs ? "10 minutes" : "60 seconds",
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
  /**
   * A project folder may sit under a linked parent (`~/Projects` linked to `/srv/work`). Git
   * reports real paths, so every check runs from the real one; the folder itself is no link.
   */
  const realRoot = Effect.fn("HandoffGit.realRoot")(function* (root: string, stage: Stage) {
    if (!path.isAbsolute(root) || path.resolve(root) !== root)
      return yield* blocked(stage, "unsafe-path");
    if ((yield* fs.readLink(root).pipe(Effect.option))._tag === "Some")
      return yield* blocked(stage, "unsafe-path");
    return yield* io(fs.realPath(root), stage);
  });
  const atRealRoot =
    <I extends { readonly workspaceRoot: string }, A, E, R>(
      method: (input: I) => Effect.Effect<A, E, R>,
      stage: Stage,
    ) =>
    (input: I) =>
      realRoot(input.workspaceRoot, stage).pipe(
        Effect.flatMap((workspaceRoot) => method({ ...input, workspaceRoot })),
      );
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
    // Git prints forward slashes on Windows; compare in native form.
    const top = path.resolve(yield* text(absolute, ["rev-parse", "--show-toplevel"], stage));
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
    appliedGitlinks: ReadonlyMap<string, string> = new Map(),
  ) {
    const status = (yield* git(
      cwd,
      ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignore-submodules=none"],
      stage,
    )).stdout;
    for (const entry of status.split("\0").filter(Boolean)) {
      const relative = entry.slice(3);
      const incoming = appliedGitlinks.get(relative);
      // Only the exact unstaged gitlink mismatch created by our earlier parent FF is recoverable.
      if (!entry.startsWith(" M ") || !incoming) return yield* blocked(stage, "dirty-repository");
      const indexed = yield* text(cwd, ["ls-files", "--stage", "--", relative], stage);
      if (indexed !== `160000 ${incoming} 0\t${relative}`)
        return yield* blocked(stage, "dirty-repository");
      const nested = path.join(cwd, relative);
      if (
        (yield* git(nested, ["merge-base", "--is-ancestor", "HEAD", incoming], stage, true))
          .code !== 0
      )
        return yield* blocked(stage, "diverged-repository");
      // Each declared nested repository is checked separately before any mutation.
    }
    const entries = (yield* git(cwd, ["ls-files", "--stage", "-z"], stage)).stdout.split("\0");
    for (const entry of entries) {
      if (entry.startsWith("120000 ")) {
        const relative = entry.slice(entry.indexOf("\t") + 1);
        if (!safeRelativePath(relative)) return yield* blocked(stage, "unsafe-path");
        // Git without symlink support (core.symlinks=false, the Windows default)
        // checks a link out as a plain file holding its target; the indexed blob
        // is the target either way, so check that one too.
        const oid = entry.slice("120000 ".length, entry.indexOf(" ", "120000 ".length));
        const link = yield* fs
          .readLink(path.join(cwd, relative))
          .pipe(
            Effect.catch(() =>
              git(cwd, ["cat-file", "blob", oid], stage).pipe(
                Effect.map((result) => result.stdout),
              ),
            ),
          );
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

  /** The repository's own config files, read without following includes or running anything. */
  const ownConfig = Effect.fn("HandoffGit.ownConfig")(function* (cwd: string, stage: Stage) {
    const gitDir = yield* text(cwd, ["rev-parse", "--path-format=absolute", "--git-dir"], stage);
    const common = yield* text(
      cwd,
      ["rev-parse", "--path-format=absolute", "--git-common-dir"],
      stage,
    );
    const entries: Array<readonly [string, string]> = [];
    for (const file of new Set([
      path.join(common, "config"),
      path.join(common, "config.worktree"),
      path.join(gitDir, "config.worktree"),
    ])) {
      if (!(yield* io(fs.exists(file), stage))) continue;
      const listed = yield* git(
        cwd,
        ["config", "--file", file, "--no-includes", "--null", "--list"],
        stage,
      );
      entries.push(...parseNullConfigList(listed.stdout));
    }
    return entries;
  });
  /**
   * One repository's config, then each initialized submodule's, since `status
   * --ignore-submodules=none` runs Git (and its filters) in every one of them, listed in the
   * manifest or not.
   */
  const guardConfigTree: (
    cwd: string,
    relativePath: string,
    stage: Stage,
    guarded: Set<string>,
    depth: number,
  ) => Effect.Effect<void, HandoffGitError> = Effect.fn("HandoffGit.guardConfigTree")(function* (
    cwd: string,
    relativePath: string,
    stage: Stage,
    guarded: Set<string>,
    depth: number,
  ) {
    const real = yield* io(fs.realPath(cwd), stage);
    if (guarded.has(real)) return;
    guarded.add(real);
    if (depth > 16 || guarded.size > 512)
      return yield* blocked(stage, "scan-limit", { repository: relativePath });
    const unsafeConfig = unsafeExistingCopyConfig(yield* ownConfig(cwd, stage));
    if (unsafeConfig.length > 0)
      return yield* blocked(stage, "unsafe-git-config", {
        repository: relativePath,
        unsafeConfig: unsafeConfig.slice(0, 32),
      });
    for (const entry of (yield* git(cwd, ["ls-files", "--stage", "-z"], stage)).stdout.split(
      "\0",
    )) {
      if (!entry.startsWith("160000 ")) continue;
      const submodule = entry.slice(entry.indexOf("\t") + 1);
      const child = relativePath === "." ? submodule : `${relativePath}/${submodule}`;
      if (!safeRelativePath(submodule))
        return yield* blocked(stage, "unsafe-path", { repository: child });
      const folder = path.join(cwd, submodule);
      if (!(yield* io(fs.exists(path.join(folder, ".git")), stage))) continue;
      yield* guardConfigTree(folder, child, stage, guarded, depth + 1);
    }
  });
  /**
   * Before any status, fetch or merge in an existing copy: every manifest repository is there,
   * holds only safe config, and the root is on a branch.
   */
  const guardExistingCopy = Effect.fn("HandoffGit.guardExistingCopy")(function* (
    input: ManifestInput,
    stage: Stage,
  ) {
    const guarded = new Set<string>();
    for (const repository of input.manifest.repositories) {
      const relativePath = repository.relativePath;
      const cwd = yield* resolveRepository(input.workspaceRoot, relativePath, stage).pipe(
        at(relativePath),
      );
      yield* guardConfigTree(cwd, relativePath, stage, guarded, 0);
      if (
        relativePath === "." &&
        (yield* git(cwd, ["symbolic-ref", "-q", "HEAD"], stage, true)).code !== 0
      )
        return yield* blocked(stage, "detached-head", { repository: relativePath });
    }
  });
  /** Whether any `.gitattributes` in a commit, at any depth, sends files through Git LFS. */
  const usesLfs = Effect.fn("HandoffGit.usesLfs")(function* (
    cwd: string,
    commit: string,
    stage: Stage,
  ) {
    const found = yield* git(
      cwd,
      ["grep", "-l", "-I", "-z", "-e", "filter=lfs", commit, "--", ":(glob)**/.gitattributes"],
      stage,
      true,
      { pathspecMagic: true },
    );
    if (found.code !== 0 && found.code !== 1) return yield* blocked(stage, "git-failed");
    return found.code === 0;
  });
  /**
   * A repository's `.lfsconfig` (the incoming commit's, or an untracked one in the folder) may
   * only narrow what LFS fetches: no includes, no access or transfer settings. Its endpoints
   * are overridden by the pinned one.
   */
  const checkLfsConfig = Effect.fn("HandoffGit.checkLfsConfig")(function* (
    cwd: string,
    commit: string,
    relativePath: string,
    stage: Stage,
  ) {
    const entries: Array<readonly [string, string]> = [];
    if ((yield* git(cwd, ["cat-file", "-e", `${commit}:.lfsconfig`], stage, true)).code === 0)
      entries.push(
        ...parseNullConfigList(
          (yield* git(
            cwd,
            ["config", "--blob", `${commit}:.lfsconfig`, "--no-includes", "--null", "--list"],
            stage,
          )).stdout,
        ),
      );
    const file = path.join(cwd, ".lfsconfig");
    if (
      (yield* io(fs.exists(file), stage)) &&
      (yield* text(cwd, ["ls-files", "-z", "--", ".lfsconfig"], stage)) === ""
    )
      entries.push(
        ...parseNullConfigList(
          (yield* git(cwd, ["config", "--file", file, "--no-includes", "--null", "--list"], stage))
            .stdout,
        ),
      );
    const unsafeConfig = unsafeLfsConfig(entries);
    if (unsafeConfig.length > 0)
      return yield* blocked(stage, "unsafe-git-config", {
        repository: relativePath,
        unsafeConfig: unsafeConfig.slice(0, 32).map((key) => `.lfsconfig ${key}`),
      });
  });
  const lfsInstalled = (cwd: string, stage: Stage) =>
    git(cwd, ["lfs", "version"], stage, true).pipe(
      Effect.map((result) => result.code === 0),
      Effect.orElseSucceed(() => false),
    );
  /** The folder, and every linked worktree of its repository, is free of running work. */
  const notInUse = Effect.fn("HandoffGit.notInUse")(function* (
    guard: ExistingCopyGuard,
    cwd: string,
    relativePath: string,
    stage: Stage,
  ) {
    const listed = yield* text(cwd, ["worktree", "list", "--porcelain", "-z"], stage);
    const folders = new Set([cwd]);
    for (const line of listed.split("\0"))
      if (line.startsWith("worktree ")) folders.add(path.resolve(line.slice("worktree ".length)));
    for (const folder of folders)
      if (yield* guard.inUse(folder))
        return yield* blocked(stage, "in-use", { repository: relativePath });
  });
  /** Downloads the LFS files a fast-forward left as pointers; a failure names itself. */
  const pullLfs = Effect.fn("HandoffGit.pullLfs")(function* (
    cwd: string,
    relativePath: string,
    stage: Stage,
  ) {
    const endpoint = lfsEndpoint(yield* text(cwd, ["remote", "get-url", "origin"], stage));
    if (endpoint === null) return yield* blocked(stage, "lfs-failed", { repository: relativePath });
    // Only the approved origin's LFS store, whatever `.lfsconfig` names.
    const config = [`lfs.url=${endpoint}`, `remote.origin.lfsurl=${endpoint}`];
    const pulled = yield* git(cwd, ["lfs", "pull", "origin"], stage, true, { config }).pipe(
      Effect.catchTag("HandoffGitError", () => Effect.succeed(null)),
    );
    if (pulled === null || pulled.code !== 0)
      return yield* blocked(stage, "lfs-failed", { repository: relativePath });
    // Every LFS file is downloaded: `-` marks one left as a pointer.
    const listed = yield* git(cwd, ["lfs", "ls-files"], stage, true, { config }).pipe(
      Effect.catchTag("HandoffGitError", () => Effect.succeed(null)),
    );
    if (
      listed === null ||
      listed.code !== 0 ||
      listed.stdout.split("\n").some((line) => /^\S+ - /.test(line))
    )
      return yield* blocked(stage, "lfs-failed", { repository: relativePath });
  });

  const inspect: HandoffGit["Service"]["inspect"] = Effect.fn("HandoffGit.inspect")(
    function* (input) {
      if (!HANDOFF_OPERATION.test(input.operationId))
        return yield* blocked("inspect", "invalid-manifest");
      // A Git sync move names every repository it can, so the destination's copy reaches
      // each head (1326). Its root is required; a nested repository without a commit or an
      // origin, or a tree past the scan limits, is left out rather than refusing the move.
      const relativePaths = input.allowChanges
        ? yield* discover(input.workspaceRoot, "inspect").pipe(
            Effect.catchTag("HandoffGitError", () => Effect.succeed(["."])),
          )
        : yield* discover(input.workspaceRoot, "inspect");
      const repositories: Array<HandoffGitRepository> = [];
      for (const relativePath of relativePaths) {
        const described = Effect.gen(function* () {
          const cwd = yield* resolveRepository(input.workspaceRoot, relativePath, "inspect");
          if (!input.allowChanges) yield* clean(cwd, "inspect");
          const head = yield* text(cwd, ["rev-parse", "HEAD"], "inspect");
          if (!HANDOFF_HEAD.test(head)) return yield* blocked("inspect", "missing-repository");
          return {
            relativePath,
            identity: yield* identity(cwd, "inspect"),
            head,
            ref: handoffRef(input.operationId, head),
          };
        });
        if (input.allowChanges && relativePath !== ".") {
          const found = yield* described.pipe(Effect.option);
          if (found._tag === "Some") repositories.push(found.value);
        } else repositories.push(yield* described);
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

  const verifyRootIdentity: HandoffGit["Service"]["verifyRootIdentity"] = Effect.fn(
    "HandoffGit.verifyRootIdentity",
  )(function* (input) {
    yield* checkManifest(input.manifest, "preflight");
    const root = input.manifest.repositories.find((entry) => entry.relativePath === ".");
    const cwd = yield* resolveRepository(input.workspaceRoot, ".", "preflight");
    if (!root || (yield* identity(cwd, "preflight")) !== root.identity)
      return yield* blocked("preflight", "identity-mismatch");
  });

  const preflightAt = Effect.fn("HandoffGit.preflightAt")(function* (
    input: ManifestInput,
    stage: Stage,
  ) {
    yield* checkManifest(input.manifest, stage);
    // A destination may have more initialized repositories than this source.
    // Validate only the exact paths being transferred; extra checkouts are not
    // read, fetched, copied, or changed by the handoff.
    for (const repository of input.manifest.repositories) {
      yield* Effect.gen(function* () {
        const cwd = yield* resolveRepository(input.workspaceRoot, repository.relativePath, stage);
        if ((yield* identity(cwd, stage)) !== repository.identity)
          return yield* blocked(stage, "identity-mismatch");
        const appliedGitlinks = new Map<string, string>();
        if (
          input.resumeProjectFolder &&
          (yield* text(cwd, ["rev-parse", "HEAD"], stage)) === repository.head
        ) {
          const prefix = repository.relativePath === "." ? "" : `${repository.relativePath}/`;
          for (const child of input.manifest.repositories) {
            if (
              child.relativePath !== repository.relativePath &&
              child.relativePath.startsWith(prefix)
            )
              appliedGitlinks.set(child.relativePath.slice(prefix.length), child.head);
          }
        }
        yield* clean(cwd, stage, true, appliedGitlinks);
        const upstream = yield* git(cwd, ["rev-parse", "--verify", "@{upstream}"], stage, true);
        if (upstream.code === 0) yield* compareAncestry(cwd, upstream.stdout.trim(), stage, false);
        yield* compareAncestry(cwd, repository.head, stage, true);
      }).pipe(at(repository.relativePath));
    }
  });
  const preflight: HandoffGit["Service"]["preflight"] = (input) => preflightAt(input, "preflight");

  const checkExistingCopy: HandoffGit["Service"]["checkExistingCopy"] = Effect.fn(
    "HandoffGit.checkExistingCopy",
  )(function* (input) {
    const stage = "preflight" as const;
    yield* checkManifest(input.manifest, stage);
    yield* guardExistingCopy(input, stage);
    const lfs = yield* lfsInstalled(input.workspaceRoot, stage);
    for (const repository of input.manifest.repositories) {
      yield* Effect.gen(function* () {
        const cwd = yield* resolveRepository(input.workspaceRoot, repository.relativePath, stage);
        if ((yield* identity(cwd, stage)) !== repository.identity)
          return yield* blocked(stage, "identity-mismatch");
        yield* clean(cwd, stage);
        const upstream = yield* git(cwd, ["rev-parse", "--verify", "@{upstream}"], stage, true);
        if (upstream.code === 0) yield* compareAncestry(cwd, upstream.stdout.trim(), stage, false);
        const present =
          (yield* git(cwd, ["cat-file", "-e", `${repository.head}^{commit}`], stage, true)).code ===
          0;
        if (present) {
          // Already there, or strictly behind: anything else would discard this copy's commits.
          if (
            (yield* git(cwd, ["merge-base", "--is-ancestor", "HEAD", repository.head], stage, true))
              .code !== 0
          )
            return yield* blocked(stage, "diverged-repository");
        } else {
          // The source heads arrive only with the move; commits no remote has are this copy's own.
          const own = yield* text(
            cwd,
            ["rev-list", "--count", "HEAD", "--not", "--remotes"],
            stage,
          );
          if (own !== "0") return yield* blocked(stage, "diverged-repository");
        }
        const commit = present ? repository.head : "HEAD";
        if (yield* usesLfs(cwd, commit, stage)) {
          if (!lfs) return yield* blocked(stage, "needs-lfs");
          yield* checkLfsConfig(cwd, commit, repository.relativePath, stage);
        }
        yield* notInUse(input.existingCopy, cwd, repository.relativePath, stage);
      }).pipe(at(repository.relativePath));
    }
  });

  /** A worker's checkout, if it still exists, holds only commits the source workspace includes. */
  const checkWorktree = Effect.fn("HandoffGit.checkWorktree")(function* (
    input: ManifestInput,
    worktreePath: string,
    branch: string | null,
  ) {
    const stage = "inspect" as const;
    if (!path.isAbsolute(worktreePath) || path.resolve(worktreePath) !== worktreePath)
      return yield* blocked(stage, "worker-checkpoint");
    if ((yield* fs.readLink(worktreePath).pipe(Effect.option))._tag === "Some")
      return yield* blocked(stage, "worker-checkpoint");
    if (!(yield* io(fs.exists(worktreePath), stage))) {
      if (branch === null) return yield* blocked(stage, "worker-checkpoint");
      return;
    }
    // Like the project folder, a worker's checkout may sit under a linked parent.
    const workspaceRoot = yield* io(fs.realPath(worktreePath), stage);
    for (const relativePath of yield* discover(workspaceRoot, stage)) {
      const worker = yield* resolveRepository(workspaceRoot, relativePath, stage);
      yield* clean(worker, stage);
      const workerIdentity = yield* identity(worker, stage);
      const repository = input.manifest.repositories.find((row) => row.identity === workerIdentity);
      if (!repository) return yield* blocked(stage, "worker-checkpoint");
      const source = yield* resolveRepository(input.workspaceRoot, repository.relativePath, stage);
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
  });

  const verifyWorkerCheckpoints: HandoffGit["Service"]["verifyWorkerCheckpoints"] = (input) =>
    Effect.gen(function* () {
      const stage = "inspect" as const;
      yield* checkManifest(input.manifest, stage);
      const workers = [
        ...new Map(input.workers.map((worker) => [stringifyJson(worker), worker])).values(),
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
        if (workspaceRoot !== null) yield* checkWorktree(input, workspaceRoot, branch);
      }
    }).pipe(
      Effect.mapError(
        (cause) => new HandoffGitError({ stage: "inspect", reason: "worker-checkpoint", cause }),
      ),
    );

  const reportWorkerCheckpoints: HandoffGit["Service"]["reportWorkerCheckpoints"] = (input) =>
    Effect.gen(function* () {
      const stage = "inspect" as const;
      yield* checkManifest(input.manifest, stage);
      // Each source repository is checked once, and one listing names every local branch its
      // handed-off head does not include, so a branch costs no Git call of its own. A worktree
      // still on disk needs its own walk and checks: the first MAX_REPORTED_WORKTREES of them run
      // a few at a time, and the rest are reported unchecked, as one that fails its check is.
      const unmerged = new Set<string>();
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
        const listed = yield* text(
          source,
          ["for-each-ref", `--no-merged=${repository.head}`, "--format=%(refname)", "refs/heads/"],
          stage,
        );
        for (const ref of listed.split("\n")) if (ref) unmerged.add(ref);
      }
      const workers = [
        ...new Map(input.workers.map((worker) => [stringifyJson(worker), worker])).values(),
      ];
      const reported = new Set<CheckpointWorker>();
      const worktrees: Array<{ worker: CheckpointWorker; worktreePath: string }> = [];
      let walks = 0;
      for (const worker of workers) {
        const { branch, worktreePath } = worker;
        // A name no ref can have is compared, never passed to Git.
        if (
          branch !== null &&
          (!branch ||
            branch.startsWith("-") ||
            branch.startsWith("refs/") ||
            unmerged.has(`refs/heads/${branch}`))
        )
          reported.add(worker);
        else if (worktreePath !== null) {
          // A removed checkout costs one lookup; only one still on disk counts toward the limit.
          const present = yield* fs.exists(worktreePath).pipe(Effect.orElseSucceed(() => true));
          if (present && walks++ >= MAX_REPORTED_WORKTREES) reported.add(worker);
          else worktrees.push({ worker, worktreePath });
        }
      }
      yield* Effect.forEach(
        worktrees,
        ({ worker, worktreePath }) =>
          checkWorktree(input, worktreePath, worker.branch).pipe(
            Effect.catchTags({ HandoffGitError: () => Effect.sync(() => reported.add(worker)) }),
          ),
        { concurrency: WORKTREE_CONCURRENCY, discard: true },
      );
      return workers.filter((worker) => reported.has(worker));
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
          ...(input.allowChanges ? { allowChanges: true } : {}),
        });
        if (stringifyJson(actual) !== stringifyJson(input.manifest))
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
        const binding = stringifyJson(input.manifest);
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
          // A Git sync move sends commits only; uncommitted work stays on this machine.
          if (!input.allowChanges) yield* clean(cwd, "publish");
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
        const existingCopy = input.existingCopy;
        if (existingCopy && !input.useProjectFolder)
          return yield* blocked(stage, "invalid-manifest");
        if (existingCopy) {
          yield* checkManifest(input.manifest, stage);
          yield* guardExistingCopy(input, stage);
        }
        const resuming =
          input.useProjectFolder &&
          (yield* io(
            fs.exists(
              path.join(input.worktreeParent, input.manifest.operationId, "git-operation.json"),
            ),
            stage,
          ));
        const checkedInput = { ...input, resumeProjectFolder: !!resuming };
        yield* preflightAt(checkedInput, stage);
        yield* realDirectory(input.worktreeParent, stage);
        if (
          input.worktreeParent === input.workspaceRoot ||
          input.worktreeParent.startsWith(input.workspaceRoot + path.sep)
        )
          return yield* blocked(stage, "unsafe-path");
        const operationDir = path.join(input.worktreeParent, input.manifest.operationId);
        const workspaceRoot = path.join(operationDir, "workspace");
        const receiptPath = path.join(operationDir, "git-operation.json");
        const encoded = stringifyJson(input.manifest);
        const digest = yield* io(
          crypto.digest("SHA-256", new TextEncoder().encode(encoded)),
          stage,
        );
        const manifestSha256 = Array.from(digest, (byte) =>
          byte.toString(16).padStart(2, "0"),
        ).join("");
        const receipt = stringifyJson({
          version: 1,
          manifestSha256,
          ...(input.useProjectFolder ? { executionMode: "project-folder" } : {}),
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
          yield* Effect.gen(function* () {
            const cwd = yield* resolveRepository(
              input.workspaceRoot,
              repository.relativePath,
              stage,
            );
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
          }).pipe(at(repository.relativePath));
        }
        yield* preflightAt(checkedInput, stage);
        if (input.useProjectFolder) {
          // Validate every repository before updating any branch. Never discard local commits.
          for (const repository of input.manifest.repositories) {
            const cwd = yield* resolveRepository(
              input.workspaceRoot,
              repository.relativePath,
              stage,
            );
            if (
              (yield* git(
                cwd,
                ["merge-base", "--is-ancestor", "HEAD", repository.head],
                stage,
                true,
              )).code !== 0
            )
              return yield* blocked(stage, "diverged-repository", {
                repository: repository.relativePath,
              });
          }
          const lfs = yield* lfsInstalled(input.workspaceRoot, stage);
          const needsLfs = new Set<string>();
          for (const repository of input.manifest.repositories) {
            const cwd = yield* resolveRepository(
              input.workspaceRoot,
              repository.relativePath,
              stage,
            );
            if (yield* usesLfs(cwd, repository.head, stage)) {
              needsLfs.add(repository.relativePath);
              yield* checkLfsConfig(cwd, repository.head, repository.relativePath, stage);
            }
          }
          // An existing copy refuses before any merge when its LFS files could not download.
          if (existingCopy && !lfs && needsLfs.size > 0)
            return yield* blocked(stage, "needs-lfs", { repository: [...needsLfs][0]! });
          const repositories: Array<HandoffGitRepository & { readonly worktreePath: string }> = [];
          // Advance the root before nested repositories, then validate the complete umbrella.
          for (const repository of input.manifest.repositories) {
            const cwd = yield* resolveRepository(
              input.workspaceRoot,
              repository.relativePath,
              stage,
            );
            if ((yield* text(cwd, ["rev-parse", "HEAD"], stage)) !== repository.head) {
              // Right before this repository moves: nothing started in it since the checks.
              if (existingCopy) yield* notInUse(existingCopy, cwd, repository.relativePath, stage);
              yield* clean(cwd, stage, false).pipe(at(repository.relativePath));
              yield* git(
                cwd,
                ["merge", "--ff-only", "--no-edit", "--no-overwrite-ignore", repository.head],
                stage,
              );
            }
            if ((yield* text(cwd, ["rev-parse", "HEAD"], stage)) !== repository.head)
              return yield* blocked(stage, "worktree-conflict", {
                repository: repository.relativePath,
              });
            repositories.push({ ...repository, worktreePath: cwd });
          }
          for (const repository of repositories)
            if (lfs && needsLfs.has(repository.relativePath))
              yield* pullLfs(repository.worktreePath, repository.relativePath, stage);
          for (const repository of repositories)
            yield* clean(repository.worktreePath, stage).pipe(at(repository.relativePath));
          return {
            operationId: input.manifest.operationId,
            workspaceRoot: input.workspaceRoot,
            manifestSha256,
            repositories,
          };
        }
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
        // Checkouts wrote LFS pointers; download the files where Git LFS is installed.
        if (yield* lfsInstalled(input.workspaceRoot, stage))
          for (const repository of repositories)
            if (yield* usesLfs(repository.worktreePath, repository.head, stage)) {
              yield* checkLfsConfig(
                repository.worktreePath,
                repository.head,
                repository.relativePath,
                stage,
              );
              yield* pullLfs(repository.worktreePath, repository.relativePath, stage);
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

  return HandoffGit.of({
    inspect: atRealRoot(inspect, "inspect"),
    verifyRootIdentity: atRealRoot(verifyRootIdentity, "preflight"),
    preflight: atRealRoot(preflight, "preflight"),
    checkExistingCopy: atRealRoot(checkExistingCopy, "preflight"),
    verifyWorkerCheckpoints: atRealRoot(verifyWorkerCheckpoints, "inspect"),
    reportWorkerCheckpoints: atRealRoot(reportWorkerCheckpoints, "inspect"),
    publish: atRealRoot(publish, "publish"),
    // The project keeps its registered path; only the checks use the real one.
    materialize: (input) =>
      atRealRoot(
        materialize,
        "materialize",
      )(input).pipe(
        Effect.map((result) =>
          input.useProjectFolder ? { ...result, workspaceRoot: input.workspaceRoot } : result,
        ),
      ),
  });
});

export const layer = Layer.effect(HandoffGit, make);
