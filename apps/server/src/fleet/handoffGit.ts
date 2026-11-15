import { stringifyJson } from "../json.ts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Semaphore from "effect/Semaphore";

import * as ProcessRunner from "../processRunner.ts";
import { parseNullConfigList } from "./folderTransfer/safeGitConfig.ts";
import {
  alternatePaths,
  ambientFilters,
  filtersOff,
  lfsEndpoint,
  unsafeExistingCopyConfig,
  unsafeLfsConfig,
} from "./handoffGitConfig.ts";
import {
  canonicalOrigin,
  type CheckpointWorker,
  type ExistingCopyGuard,
  HANDOFF_HEAD,
  HANDOFF_OPERATION,
  handoffRef,
  HandoffGitError,
  HandoffGitManifest,
  type HandoffGitMaterialization,
  type HandoffGitRepository,
  type HandoffGitService,
  type ManifestInput,
  safeRelativePath,
  validManifest,
} from "./handoffGitTypes.ts";

type Stage = HandoffGitError["stage"];
export type { ExistingCopyGuard } from "./handoffGitTypes.ts";

export class HandoffGit extends Context.Service<HandoffGit, HandoffGitService>()(
  "specweave-studio/fleet/handoffGit",
) {}

// Dependency/build caches are not project repositories. Git ignore rules are NOT
// used: initialized repositories in ignored repositories/ or other source dirs
// must be inspected. Hitting any traversal bound fails closed.
const EXCLUDED = new Set([".git", "node_modules"]);
const MAX_DIRECTORIES = 20_000;
const MAX_ENTRIES = 200_000;
const MAX_DEPTH = 24;

/**
 * `-c` settings every Git call of an existing copy's check or update carries: this machine's
 * own filters switched off, so a repository's attributes cannot choose a program to run.
 */
class ExistingCopyGit extends Context.Reference<ReadonlyArray<string>>(
  "specweave-studio/fleet/handoffGit/existingCopyGit",
  { defaultValue: () => [] },
) {}

/** The keys of a Git LFS filter this machine's settings changed from the standard one. */
class AmbientLfs extends Context.Reference<ReadonlyArray<string> | null>(
  "specweave-studio/fleet/handoffGit/ambientLfs",
  { defaultValue: () => null },
) {}

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
      /** Read `.gitattributes` from this commit instead of the checked-out files. */
      readonly attributesOf?: string;
      readonly stdin?: string;
    } = {},
  ) {
    const hardening = yield* ExistingCopyGit;
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
          ...[...hardening, ...(options.config ?? [])].flatMap((setting) => ["-c", setting]),
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
          // Objects come from the repository's own store, checked by `guardStorage`.
          GIT_ALTERNATE_OBJECT_DIRECTORIES: "",
          ...(options.attributesOf === undefined ? {} : { GIT_ATTR_SOURCE: options.attributesOf }),
          // Even cat-file/status/ancestry reads can fetch missing promisor objects and
          // rewrite clone config. Only authorized transfer operations may hydrate them.
          GIT_NO_LAZY_FETCH: ["fetch", "push", "worktree", "lfs"].includes(args[0] ?? "")
            ? "0"
            : "1",
          // A checkout writes LFS pointers instead of downloading during a merge.
          ...(lfs ? {} : { GIT_LFS_SKIP_SMUDGE: "1" }),
        },
        ...(options.stdin === undefined ? {} : { stdin: options.stdin }),
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
    // A `core.worktree` is read relative to the Git folder. A submodule's names its checkout:
    // the only value that may stay is a relative one naming the folder being checked.
    const folder = yield* io(fs.realPath(cwd), stage);
    const ownWorktree = new Set<string>();
    for (const [key, value] of entries) {
      if (key.trim().toLowerCase() !== "core.worktree") continue;
      if (value === "" || path.isAbsolute(value) || /^[A-Za-z]:|[\\\u0000-\u001f]/.test(value))
        continue;
      const named = yield* fs
        .realPath(path.resolve(gitDir, value))
        .pipe(Effect.orElseSucceed(() => null));
      if (named === folder) ownWorktree.add(value);
    }
    return { entries, keepWorktree: (value: string) => ownWorktree.has(value) };
  });
  /**
   * Where a repository of an existing copy keeps its Git data. Admitted: a Git folder inside
   * the project folder (its own `.git`, or a submodule's under `.git/modules`), and the main
   * repository of a linked worktree when that repository lists this folder as its worktree.
   * Objects are read from that store alone: a link out of it, or an `alternates` entry naming
   * a store outside the admitted folders, is refused before any call reads an object.
   */
  const guardStorage = Effect.fn("HandoffGit.guardStorage")(function* (
    admitted: Array<string>,
    cwd: string,
    stage: Stage,
  ) {
    const refuse = blocked(stage, "external-git-storage");
    const real = (target: string) => io(fs.realPath(target), stage);
    const within = (parent: string, child: string) =>
      child === parent || child.startsWith(parent + path.sep);
    const gitDir = yield* real(yield* text(cwd, ["rev-parse", "--absolute-git-dir"], stage));
    const common = yield* real(
      yield* text(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"], stage),
    );
    const allowed = (store: string) => admitted.some((folder) => within(folder, store));
    if (!allowed(gitDir) || !allowed(common)) {
      // A linked worktree: its main repository must name this folder back.
      const back = yield* fs.readFileString(path.join(gitDir, "gitdir")).pipe(Effect.option);
      if (
        gitDir === common ||
        path.dirname(gitDir) !== path.join(common, "worktrees") ||
        back._tag === "None" ||
        (yield* real(path.resolve(gitDir, back.value.trim())).pipe(
          Effect.orElseSucceed(() => ""),
        )) !== (yield* real(path.join(cwd, ".git")))
      )
        return yield* refuse;
      admitted.push(common);
    }
    const pending = [path.join(common, "objects")];
    const seen = new Set<string>();
    while (pending.length > 0) {
      const store = pending.shift()!;
      if (!(yield* io(fs.exists(store), stage))) return yield* refuse;
      const actual = yield* real(store);
      // Git follows at most five alternates in a chain; a longer one is not a normal layout.
      if (actual !== store || !allowed(actual) || seen.size >= 8) return yield* refuse;
      if (seen.has(actual)) continue;
      seen.add(actual);
      // No entry of the store, its packs or its `info` folder is a link to somewhere else.
      for (const folder of [actual, path.join(actual, "pack"), path.join(actual, "info")]) {
        if (!(yield* io(fs.exists(folder), stage))) continue;
        const names = yield* io(fs.readDirectory(folder), stage);
        if (names.length > 4096) return yield* blocked(stage, "scan-limit");
        for (const name of names)
          if (
            (yield* io(fs.readLink(path.join(folder, name)).pipe(Effect.option), stage))._tag ===
            "Some"
          )
            return yield* refuse;
      }
      if (yield* io(fs.exists(path.join(actual, "info", "http-alternates")), stage))
        return yield* refuse;
      const file = path.join(actual, "info", "alternates");
      if (!(yield* io(fs.exists(file), stage))) continue;
      const listed = alternatePaths(yield* io(fs.readFileString(file), stage));
      if (listed === null) return yield* refuse;
      for (const alternate of listed) {
        const target = path.resolve(actual, alternate);
        if (!(yield* io(fs.exists(target), stage))) return yield* refuse;
        pending.push(yield* real(target));
      }
    }
  });
  /**
   * One repository's config, then each initialized submodule's, since `status
   * --ignore-submodules=none` runs Git (and its filters) in every one of them, listed in the
   * manifest or not. With `incoming`, the submodules that commit names are checked too: a
   * merge to it makes status enter their folders when they are already there.
   */
  const guardConfigTree: (
    admitted: Array<string>,
    cwd: string,
    relativePath: string,
    stage: Stage,
    guarded: Set<string>,
    depth: number,
    incoming?: string,
  ) => Effect.Effect<void, HandoffGitError> = Effect.fn("HandoffGit.guardConfigTree")(function* (
    admitted: Array<string>,
    cwd: string,
    relativePath: string,
    stage: Stage,
    guarded: Set<string>,
    depth: number,
    incoming?: string,
  ) {
    const real = yield* io(fs.realPath(cwd), stage);
    const listings: Array<string> = [];
    // Reached before as a submodule of another repository: only the incoming commit is new.
    if (!guarded.has(real)) {
      guarded.add(real);
      if (depth > 16 || guarded.size > 512)
        return yield* blocked(stage, "scan-limit", { repository: relativePath });
      const { entries, keepWorktree } = yield* ownConfig(cwd, stage);
      const unsafeConfig = unsafeExistingCopyConfig(entries, { keepWorktree });
      if (unsafeConfig.length > 0)
        return yield* blocked(stage, "unsafe-git-config", {
          repository: relativePath,
          unsafeConfig: unsafeConfig.slice(0, 32),
        });
      yield* guardStorage(admitted, cwd, stage).pipe(at(relativePath));
      listings.push((yield* git(cwd, ["ls-files", "--stage", "-z"], stage)).stdout);
    }
    if (incoming !== undefined)
      listings.push((yield* git(cwd, ["ls-tree", "-r", "-z", incoming], stage)).stdout);
    const submodules = new Set<string>();
    for (const listing of listings)
      for (const entry of listing.split("\0"))
        if (entry.startsWith("160000 ")) submodules.add(entry.slice(entry.indexOf("\t") + 1));
    for (const submodule of submodules) {
      const child = relativePath === "." ? submodule : `${relativePath}/${submodule}`;
      if (!safeRelativePath(submodule))
        return yield* blocked(stage, "unsafe-path", { repository: child });
      const folder = path.join(cwd, submodule);
      if (!(yield* io(fs.exists(path.join(folder, ".git")), stage))) continue;
      // Status enters it as a repository of its own: it must be one, in this folder.
      if (
        (yield* io(fs.readLink(folder).pipe(Effect.option), stage))._tag === "Some" ||
        (yield* io(fs.readLink(path.join(folder, ".git")).pipe(Effect.option), stage))._tag ===
          "Some" ||
        path.resolve(yield* text(folder, ["rev-parse", "--show-toplevel"], stage)) !== folder
      )
        return yield* blocked(stage, "unsafe-path", { repository: child });
      yield* guardConfigTree(admitted, folder, child, stage, guarded, depth + 1);
    }
  });
  /**
   * Before any status, fetch or merge in an existing copy: every manifest repository is there,
   * holds only safe config, and the root is on a branch. With `incoming` (the source heads
   * are fetched), the submodules those heads name are checked as well, before any merge.
   */
  const guardExistingCopy = Effect.fn("HandoffGit.guardExistingCopy")(function* (
    input: ManifestInput,
    stage: Stage,
    incoming = false,
  ) {
    const guarded = new Set<string>();
    // The project folder first; a linked worktree's main repository joins when it checks out.
    const admitted = [yield* io(fs.realPath(input.workspaceRoot), stage)];
    for (const repository of input.manifest.repositories) {
      const relativePath = repository.relativePath;
      const cwd = yield* resolveRepository(input.workspaceRoot, relativePath, stage).pipe(
        at(relativePath),
      );
      const moves = incoming && (yield* text(cwd, ["rev-parse", "HEAD"], stage)) !== repository.head;
      yield* guardConfigTree(
        admitted,
        cwd,
        relativePath,
        stage,
        guarded,
        0,
        moves ? repository.head : undefined,
      );
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
    if (found.code === 0) return true;
    // Attributes also come from `.git/info/attributes` and this machine's own attributes
    // file: ask Git what each incoming path resolves to.
    const names = (yield* git(cwd, ["ls-tree", "-r", "-z", "--name-only", commit], stage)).stdout;
    if (names === "") return false;
    const fields = (yield* git(cwd, ["check-attr", "-z", "--stdin", "filter"], stage, false, {
      attributesOf: commit,
      stdin: names,
    })).stdout.split("\0");
    for (let index = 2; index < fields.length; index += 3) if (fields[index] === "lfs") return true;
    return false;
  });
  /**
   * Switches off every filter this machine's own Git settings define, for the calls of one
   * check or update. Standard Git LFS stays, since its download is a step of its own.
   */
  const withoutAmbientFilters =
    (root: string, stage: Stage) =>
    <A, R>(effect: Effect.Effect<A, HandoffGitError, R>) =>
      Effect.gen(function* () {
        const ambient = ambientFilters(
          (yield* git(root, ["config", "--list", "--null", "--show-scope"], stage)).stdout,
        );
        return yield* effect.pipe(
          Effect.provideService(ExistingCopyGit, filtersOff(ambient.keys())),
          // A changed LFS filter cannot be both switched off and used for the download.
          Effect.provideService(AmbientLfs, ambient.get("lfs") ?? null),
        );
      });
  const refuseAmbientLfs = Effect.fn("HandoffGit.refuseAmbientLfs")(function* (
    relativePath: string,
    stage: Stage,
  ) {
    const keys = yield* AmbientLfs;
    if (keys !== null)
      return yield* blocked(stage, "unsafe-git-config", {
        repository: relativePath,
        unsafeConfig: keys.map((key) => `${key} (this machine's Git settings)`),
      });
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
  /** A repository's folder and every linked worktree of it. */
  const checkouts = Effect.fn("HandoffGit.checkouts")(function* (cwd: string, stage: Stage) {
    const listed = yield* text(cwd, ["worktree", "list", "--porcelain", "-z"], stage);
    const folders = new Set([cwd]);
    for (const line of listed.split("\0"))
      if (line.startsWith("worktree ")) folders.add(path.resolve(line.slice("worktree ".length)));
    return [...folders];
  });
  const existingCopyFolders = (input: ManifestInput) =>
    Effect.gen(function* () {
      const folders = new Set([input.workspaceRoot]);
      if (!validManifest(input.manifest)) return [...folders];
      for (const repository of input.manifest.repositories)
        yield* resolveRepository(input.workspaceRoot, repository.relativePath, "preflight").pipe(
          Effect.flatMap((cwd) => checkouts(cwd, "preflight")),
          Effect.map((found) => found.forEach((folder) => folders.add(folder))),
          Effect.ignore,
        );
      return [...folders];
    });
  /** The folder, and every linked worktree of its repository, is free of running work. */
  const notInUse = Effect.fn("HandoffGit.notInUse")(function* (
    guard: ExistingCopyGuard,
    cwd: string,
    relativePath: string,
    stage: Stage,
  ) {
    for (const folder of yield* checkouts(cwd, stage))
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
    const config = [
      `lfs.url=${endpoint}`,
      `remote.origin.lfsurl=${endpoint}`,
      // Every file, whatever `.lfsconfig` leaves out: the copy must end without pointers.
      "lfs.fetchinclude=",
      "lfs.fetchexclude=",
    ];
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
      let repositories: Array<HandoffGitRepository> = [];
      for (const relativePath of relativePaths) {
        const described = Effect.gen(function* () {
          const cwd = yield* resolveRepository(input.workspaceRoot, relativePath, "inspect");
          // A linked worktree inside the folder is a worker's checkout of a repository already
          // named, not another repository to bring over.
          if (
            input.allowChanges &&
            relativePath !== "." &&
            (yield* text(cwd, ["rev-parse", "--absolute-git-dir"], "inspect")) !==
              (yield* text(
                cwd,
                ["rev-parse", "--path-format=absolute", "--git-common-dir"],
                "inspect",
              ))
          )
            return yield* blocked("inspect", "missing-repository");
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
      if (input.allowChanges) {
        // A manifest names each origin once. Separate clones of one origin are separate
        // checkouts, never one repository, and nothing says which of them the destination
        // holds: the root stays, and a nested repository that shares its origin with the
        // root or with another nested one is left as it is on the destination.
        const clones = new Map<string, number>();
        for (const { identity } of repositories)
          clones.set(identity, (clones.get(identity) ?? 0) + 1);
        repositories = repositories.filter(
          ({ identity }, index) => index === 0 || clones.get(identity) === 1,
        );
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
          yield* refuseAmbientLfs(repository.relativePath, stage);
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
            // A copy already at the source head needs nothing from origin, so a source that
            // published no ref (an older one, or one without push access) is not a refusal.
            if (
              existingCopy &&
              (yield* text(cwd, ["rev-parse", "HEAD"], stage)) === repository.head
            )
              return;
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
              if (existingCopy && lfs) yield* refuseAmbientLfs(repository.relativePath, stage);
              yield* checkLfsConfig(cwd, repository.head, repository.relativePath, stage);
            }
          }
          // An existing copy refuses before any merge when its LFS files could not download.
          if (existingCopy && !lfs && needsLfs.size > 0)
            return yield* blocked(stage, "needs-lfs", { repository: [...needsLfs][0]! });
          if (existingCopy) {
            // Every repository that still has to move is free, and every submodule the source
            // heads name holds only safe config, before the first merge: a refusal here
            // leaves the whole copy where it was, never some repositories ahead of others.
            for (const repository of input.manifest.repositories) {
              const cwd = yield* resolveRepository(
                input.workspaceRoot,
                repository.relativePath,
                stage,
              );
              if ((yield* text(cwd, ["rev-parse", "HEAD"], stage)) !== repository.head)
                yield* notInUse(existingCopy, cwd, repository.relativePath, stage);
            }
            yield* guardExistingCopy(input, stage, true);
          }
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
          // The merges may have added submodules whose folders were already there: check
          // their config and storage before the final status enters them.
          if (existingCopy) yield* guardExistingCopy(input, stage);
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
    checkExistingCopy: atRealRoot(
      (input: Parameters<typeof checkExistingCopy>[0]) =>
        checkExistingCopy(input).pipe(withoutAmbientFilters(input.workspaceRoot, "preflight")),
      "preflight",
    ),
    existingCopyFolders: (input) =>
      atRealRoot(
        existingCopyFolders,
        "preflight",
      )(input).pipe(Effect.orElseSucceed(() => [input.workspaceRoot])),
    verifyWorkerCheckpoints: atRealRoot(verifyWorkerCheckpoints, "inspect"),
    reportWorkerCheckpoints: atRealRoot(reportWorkerCheckpoints, "inspect"),
    publish: atRealRoot(publish, "publish"),
    // The project keeps its registered path; only the checks use the real one.
    materialize: (input) =>
      atRealRoot(
        (real: typeof input) =>
          real.existingCopy
            ? materialize(real).pipe(withoutAmbientFilters(real.workspaceRoot, "materialize"))
            : materialize(real),
        "materialize",
      )(input).pipe(
        Effect.map((result) =>
          input.useProjectFolder ? { ...result, workspaceRoot: input.workspaceRoot } : result,
        ),
      ),
  });
});

export const layer = Layer.effect(HandoffGit, make);
