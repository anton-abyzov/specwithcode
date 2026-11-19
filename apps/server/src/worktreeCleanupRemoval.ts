// @effect-diagnostics nodeBuiltinImport:off - removes single files and empty folders with unlink and rmdir, which cannot delete a folder with content.
/**
 * Removing a finished chat folder, for the chat worktree sweep
 * (worktreeCleanupSweep.ts): the evidence copy, then each member with plain
 * `git worktree remove`, deepest first. Nothing here forces a removal or
 * deletes a folder with what is in it.
 *
 * @module worktreeCleanupRemoval
 */
import * as NodeFSP from "node:fs/promises";

import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";

import type * as GitManager from "./git/GitManager.ts";
import { checkWorktreeRegistration } from "./git/worktreeRegistration.ts";
import type * as GitVcsDriver from "./vcs/GitVcsDriver.ts";
import {
  describeRemovalFailure,
  leftBehind,
  openFileHolders,
  openFilesUnder,
  type WorktreeRemovalFailure,
} from "./worktreeRemovalFailures.ts";
import {
  type Assessment,
  encodeJson,
  type MemberState,
} from "./worktreeCleanupMemberFacts.ts";

/** `yyyyMMdd-HHmmss` in UTC, for an evidence folder name. */
/** True when both files hold the same bytes, read in 1 MB chunks. */
async function sameBytes(left: string, right: string): Promise<boolean> {
  const a = await NodeFSP.open(left, "r");
  let b: NodeFSP.FileHandle | null = null;
  try {
    b = await NodeFSP.open(right, "r");
    const [sa, sb] = await Promise.all([a.stat(), b.stat()]);
    if (sa.size !== sb.size) return false;
    const chunk = 1024 * 1024;
    const bufA = Buffer.alloc(chunk);
    const bufB = Buffer.alloc(chunk);
    for (let offset = 0; offset < sa.size; offset += chunk) {
      const [ra, rb] = await Promise.all([
        a.read(bufA, 0, chunk, offset),
        b.read(bufB, 0, chunk, offset),
      ]);
      if (ra.bytesRead !== rb.bytesRead) return false;
      if (!bufA.subarray(0, ra.bytesRead).equals(bufB.subarray(0, rb.bytesRead))) return false;
      if (ra.bytesRead === 0) return false;
    }
    return true;
  } finally {
    await a.close();
    await b?.close();
  }
}

const evidenceStamp = (now: number) =>
  DateTime.formatIso(DateTime.makeUnsafe(now)).slice(0, 19).replace(/[-:]/g, "").replace("T", "-");

export function makeRemoval(deps: {
  readonly git: GitVcsDriver.GitVcsDriver["Service"];
  readonly gitManager: GitManager.GitManager["Service"];
  readonly fs: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly baseDir: string;
  readonly platform: NodeJS.Platform;
  readonly inside: (root: string, target: string) => boolean;
  readonly realOrNull: (value: string) => Effect.Effect<string | null>;
  readonly memberStaysInside: (folder: string, memberPath: string) => Effect.Effect<boolean>;
  readonly readMemberGit: (
    state: MemberState,
    chatBranch: string | null,
    inSet: boolean,
  ) => Effect.Effect<void>;
  readonly readNested: (state: MemberState) => Effect.Effect<void>;
}) {
  const { git, gitManager, fs, path, inside, realOrNull, memberStaysInside, readMemberGit, readNested } =
    deps;

  /**
   * Copies ignored media to a new evidence folder and checks each copy by
   * size. Returns that folder, or null when a copy failed; what a failed run
   * copied is removed again, so retries never pile up copies.
   */
  const copyMedia = Effect.fn("WorktreeCleanupSweep.copyMedia")(function* (
    assessment: Assessment,
    now: number,
  ) {
    const files = assessment.members.flatMap((state) =>
      state.media.map((file) => ({ state, file })),
    );
    const base = path.join(
      deps.baseDir,
      "evidence",
      "removed-worktrees",
      `${path.basename(assessment.group.folder)}-${evidenceStamp(now)}`,
    );
    let target = base;
    for (let index = 2; ; index += 1) {
      // An unreadable evidence folder is a failed copy, not a reason to keep looking.
      const taken = yield* fs.exists(target).pipe(Effect.orElseSucceed(() => null));
      if (taken === false) break;
      if (taken === null || index > 100) return null;
      target = `${base}-${index}`;
    }
    const copied = yield* Effect.gen(function* () {
      for (const { state, file } of files) {
        const source = path.join(state.path, file.relative);
        const copy = path.join(target, state.member.relativePath, file.relative);
        yield* fs.makeDirectory(path.dirname(copy), { recursive: true });
        yield* fs.copyFile(source, copy);
        const sizes = [(yield* fs.stat(source)).size, (yield* fs.stat(copy)).size];
        if (sizes.some((size) => Number(size) !== file.bytes)) return false;
      }
      yield* fs.writeFileString(
        path.join(target, "manifest.json"),
        `${encodeJson({
          folder: assessment.group.folder,
          removedAt: DateTime.formatIso(DateTime.makeUnsafe(now)),
          reason: assessment.decision.reason,
          members: assessment.members.map((state) => ({
            relativePath: state.member.relativePath,
            repository: state.repository,
            branch: state.git?.branch ?? null,
            head: state.head,
          })),
          files: files.map(({ state, file }) => ({
            member: state.member.relativePath,
            path: file.relative,
            bytes: file.bytes,
          })),
        })}\n`,
      );
      return true;
    }).pipe(
      Effect.catch((error) =>
        Effect.logWarning("storage cleanup could not copy media to evidence", {
          folder: assessment.group.folder,
          error,
        }).pipe(Effect.as(false)),
      ),
    );
    if (copied) return target;
    yield* discardEvidence(target);
    return null;
  });

  /**
   * Removes an empty folder, or one holding only Finder's `.DS_Store`: that
   * one file is unlinked by name, then the folder with `rmdir`, which fails on
   * a folder that still holds anything. Never recursive.
   */
  const removeIfEmpty = (folder: string) =>
    Effect.tryPromise(async () => {
      const names = await NodeFSP.readdir(folder);
      if (!names.every((name) => name === ".DS_Store")) return;
      for (const name of names) await NodeFSP.unlink(path.join(folder, name));
      await NodeFSP.rmdir(folder);
    }).pipe(Effect.ignore);

  /**
   * Removes an evidence folder this run made for a removal that then did not
   * happen: each file by name, then each folder once it is empty. A file
   * something else put there stays, and so does its folder.
   */
  const discardEvidence = (target: string) =>
    Effect.tryPromise(async () => {
      const folders: Array<string> = [];
      const pending = [target];
      while (pending.length > 0) {
        const folder = pending.pop()!;
        folders.push(folder);
        for (const dirent of await NodeFSP.readdir(folder, { withFileTypes: true })) {
          const entry = path.join(folder, dirent.name);
          if (dirent.isDirectory()) pending.push(entry);
          else await NodeFSP.unlink(entry);
        }
      }
      for (const folder of folders.toReversed()) await NodeFSP.rmdir(folder);
    }).pipe(Effect.ignore);

  /**
   * One member read again right before it goes: false when anything in it or
   * about it differs from the assessment the removal rests on. Git deletes
   * ignored files without asking, and earlier members can take minutes.
   */
  const memberUnchanged = Effect.fn("WorktreeCleanupSweep.memberUnchanged")(
    function* (
      assessment: Assessment,
      state: MemberState,
      /** Walk untracked and ignored folders for a repository; slow, so only once. */
      walkNested: boolean,
      /** Where it is now, once moved aside for removal; its own path otherwise. */
      at: string = state.path,
    ) {
      if (
        at === state.path &&
        state.member.relativePath !== "" &&
        !(yield* memberStaysInside(assessment.group.folder, state.path))
      )
        return false;
      const registration = yield* checkWorktreeRegistration(at);
      if (!registration.ok || registration.locked) return false;
      // The same repository the assessment found, by the same rule.
      const inSet = state.member.repository !== "";
      if (inSet) {
        if ((yield* realOrNull(path.join(state.repository, ".git"))) !== registration.commonDir)
          return false;
      } else if (registration.repository !== state.repository) return false;
      // A volume mounted at the folder itself has the same real path and other files.
      if (state.member.relativePath === "") {
        const real = yield* realOrNull(at);
        if (real === null) return false;
        const [own, parent] = yield* Effect.all([fs.stat(real), fs.stat(path.dirname(real))]);
        if (own.dev !== parent.dev) return false;
      }
      const again: MemberState = {
        ...state,
        path: at,
        head: null,
        base: null,
        media: [],
        fingerprint: "",
        git: undefined,
      };
      yield* readMemberGit(
        again,
        assessment.chatBranch,
        assessment.members.length > 1 || state.member.repository !== "",
      );
      // The fingerprint starts with the member's path; compare the rest.
      const seen =
        at === state.path
          ? again.fingerprint
          : again.fingerprint.replace(encodeJson(at), encodeJson(state.path));
      if (seen !== state.fingerprint) return false;
      if (!walkNested) return true;
      yield* readNested(again);
      return again.git?.nestedRepository === false;
      // Anything unreadable counts as changed.
    },
    Effect.orElseSucceed(() => false),
  );

  /** Unique commits a recovery ref can keep at most; past it the worktree stays. */
  const REFLOG_KEPT_MAX = 5_000;

  /**
   * Points `refs/specwithcode/retired-worktrees/<name>` at one commit whose
   * parents are every commit the worktree's HEAD reflog reaches, so none
   * becomes unreachable when Git removes the worktree and its reflog. False
   * when that could not be done; the worktree then stays.
   */
  const keepReflog = Effect.fn("WorktreeCleanupSweep.keepReflog")(
    function* (state: MemberState, at: string) {
      // Both sides of every entry: Git's reachability keeps an entry's old
      // value too, and the reflog walk lists only new values.
      // Only the files backend keeps HEAD's reflog in `logs/HEAD`; with any
      // other (reftable) it cannot be read here, so the worktree stays.
      const format = yield* git.execute({
        operation: "WorktreeCleanupSweep.refFormat",
        cwd: at,
        args: ["config", "--get", "extensions.refStorage"],
        maxOutputBytes: 4096,
        allowNonZeroExit: true,
        timeoutMs: 15_000,
      });
      if (format.exitCode === 0 ? format.stdout.trim().toLowerCase() !== "files" : format.exitCode !== 1)
        return false;
      const where = yield* git.execute({
        operation: "WorktreeCleanupSweep.reflogPath",
        cwd: at,
        args: ["rev-parse", "--git-path", "logs/HEAD"],
        maxOutputBytes: 64 * 1024,
        allowNonZeroExit: true,
        timeoutMs: 15_000,
      });
      if (where.exitCode !== 0 || where.stdout.trim() === "") return false;
      const file = path.resolve(at, where.stdout.trim());
      if (!(yield* fs.exists(file))) return true;
      const text = yield* fs.readFileString(file);
      const listed = new Set<string>();
      for (const line of text.split("\n")) {
        if (line === "") continue;
        const entry = /^([0-9a-f]{40,64}) ([0-9a-f]{40,64}) /.exec(line);
        // A line that cannot be read hides history: keep the worktree.
        if (entry === null) return false;
        for (const oid of [entry[1]!, entry[2]!]) if (!/^0+$/.test(oid)) listed.add(oid);
      }
      if (listed.size === 0) return true;
      if (listed.size > REFLOG_KEPT_MAX) return false;
      const kinds = yield* git.execute({
        operation: "WorktreeCleanupSweep.reflogObjects",
        cwd: at,
        args: ["cat-file", "--batch-check=%(objectname) %(objecttype)"],
        stdin: `${[...listed].join("\n")}\n`,
        maxOutputBytes: 8 * 1024 * 1024,
        allowNonZeroExit: true,
        timeoutMs: 30_000,
      });
      if (kinds.exitCode !== 0 || kinds.stdoutTruncated) return false;
      const commits: Array<string> = [];
      for (const line of kinds.stdout.split("\n")) {
        if (line === "") continue;
        const [oid, kind] = line.split(" ");
        // An object already gone has nothing left for the removal to lose.
        if (kind === "missing") continue;
        if (kind !== "commit" || oid === undefined) return false;
        commits.push(oid);
      }
      if (commits.length === 0) return true;
      if (commits.length > REFLOG_KEPT_MAX) return false;
      const tree = yield* git.execute({
        operation: "WorktreeCleanupSweep.reflogTree",
        cwd: at,
        args: ["rev-parse", "--verify", `${commits[0]}^{tree}`],
        maxOutputBytes: 4096,
        allowNonZeroExit: true,
        timeoutMs: 15_000,
      });
      if (tree.exitCode !== 0) return false;
      const keeper = yield* git.execute({
        operation: "WorktreeCleanupSweep.reflogKeeper",
        cwd: at,
        args: [
          "-c",
          "user.name=SpecWithCode storage cleanup",
          "-c",
          "user.email=storage-cleanup@specwithcode.invalid",
          "commit-tree",
          tree.stdout.trim(),
          ...commits.flatMap((commit) => ["-p", commit]),
          "-m",
          `HEAD reflog of the retired worktree ${state.path}`,
        ],
        maxOutputBytes: 4096,
        allowNonZeroExit: true,
        timeoutMs: 30_000,
      });
      if (keeper.exitCode !== 0) return false;
      const name = `${path.basename(state.path)}-${evidenceStamp(DateTime.toEpochMillis(yield* DateTime.now))}`.replace(
        /[^A-Za-z0-9._-]/g,
        "-",
      );
      const ref = yield* git.execute({
        operation: "WorktreeCleanupSweep.reflogRef",
        cwd: at,
        args: [
          "update-ref",
          `refs/specwithcode/retired-worktrees/${name}`,
          keeper.stdout.trim(),
          "",
        ],
        maxOutputBytes: 4096,
        allowNonZeroExit: true,
        timeoutMs: 15_000,
      });
      return ref.exitCode === 0;
    },
    Effect.orElseSucceed(() => false),
  );

  /**
   * Removes the members deepest first without force, stopping at the first
   * that changed or that Git could not remove, then removes the folders left
   * empty. Branches and the manifest stay.
   */
  const removeMembers = Effect.fn("WorktreeCleanupSweep.removeMembers")(function* (
    assessment: Assessment,
    /** Read right before each member goes: false when the folder's use changed. */
    stillFree: Effect.Effect<boolean>,
    /** Where its media was copied; each file is compared with its copy last. */
    evidence: string | null = null,
  ) {
    const depth = (state: MemberState) =>
      state.member.relativePath === "" ? 0 : state.member.relativePath.split(path.sep).length;
    let gone = 0;
    for (const state of assessment.members.toSorted((left, right) => depth(right) - depth(left))) {
      // Removing a member can take minutes: a chat may have been reopened meanwhile.
      // Use, then the member itself, then use again: the member walk takes time too.
      // Last, its files once more without the slow walk, so the reading Git
      // removal rests on is as late as it can be. No lock keeps a process
      // outside the folder from writing into it in the moment that remains.
      if (
        !(yield* stillFree) ||
        !(yield* memberUnchanged(assessment, state, true)) ||
        !(yield* stillFree) ||
        !(yield* memberUnchanged(assessment, state, false))
      )
        return { stopped: "changed" as const, member: "", gone, failure: null };
      // Moved aside first (`git worktree move`, never forced, a rename on the
      // same volume), then read again where it now is: a process that saves a
      // file by the old path from outside the folder writes beside it, not
      // into what Git removes. A member that cannot be moved stays.
      const target = path.join(
        path.dirname(state.path),
        `.${path.basename(state.path)}.retiring-${evidenceStamp(DateTime.toEpochMillis(yield* DateTime.now))}`,
      );
      if (yield* fs.exists(target).pipe(Effect.orElseSucceed(() => true)))
        return { stopped: "changed" as const, member: "", gone, failure: null };
      yield* git
        .execute({
          operation: "WorktreeCleanupSweep.moveAside",
          cwd: state.repository,
          args: ["worktree", "move", state.path, target],
          maxOutputBytes: 64 * 1024,
          allowNonZeroExit: true,
          timeoutMs: 60_000,
        })
        .pipe(Effect.ignore);
      const movedAside =
        (yield* fs.exists(target).pipe(Effect.orElseSucceed(() => false))) &&
        !(yield* fs.exists(state.path).pipe(Effect.orElseSucceed(() => true)));
      if (!movedAside) {
        if (yield* fs.exists(target).pipe(Effect.orElseSucceed(() => true)))
          return {
            stopped: "refused" as const,
            member: target,
            gone,
            failure: {
              folder: assessment.group.folder,
              member: state.member.relativePath === "" ? "the folder" : state.member.relativePath,
              at: DateTime.formatIso(yield* DateTime.now),
              what: `Git left it half moved to ${target} while setting it aside for removal`,
              holders: null,
              removedBefore: gone,
            } satisfies WorktreeRemovalFailure,
          };
        return { stopped: "changed" as const, member: "", gone, failure: null };
      }
      // Kept, moved back where it was: anything it found changed, a writer
      // with a file still open in it, history that could not be kept.
      const keepAside = (why: string) =>
        Effect.gen(function* () {
          const back = yield* git
            .execute({
              operation: "WorktreeCleanupSweep.moveBack",
              cwd: state.repository,
              args: ["worktree", "move", target, state.path],
              maxOutputBytes: 64 * 1024,
              allowNonZeroExit: true,
              timeoutMs: 60_000,
            })
            .pipe(
              Effect.map((result) => result.exitCode === 0),
              Effect.orElseSucceed(() => false),
            );
          if (back) return { stopped: "changed" as const, member: "", gone, failure: null };
          return {
            stopped: "refused" as const,
            member: target,
            gone,
            failure: {
              folder: assessment.group.folder,
              member: state.member.relativePath === "" ? "the folder" : state.member.relativePath,
              at: DateTime.formatIso(yield* DateTime.now),
              what: `${why} after it was set aside at ${target}, and Git could not move it back`,
              holders: null,
              removedBefore: gone,
            } satisfies WorktreeRemovalFailure,
          };
        });
      if (!(yield* memberUnchanged(assessment, state, true, target)))
        return yield* keepAside("It changed");
      // Every commit its HEAD reflog reaches is kept by one ref of the
      // repository before Git deletes that reflog with the worktree, so a
      // branch deleted elsewhere meanwhile loses nothing.
      if (!(yield* keepReflog(state, target))) return yield* keepAside("Its history could not be kept");
      // Last: a process holding a file open in it, even one started outside
      // the folder, could still write after the readings above.
      const realTarget = (yield* realOrNull(target)) ?? target;
      const holders = yield* Effect.promise(() => openFilesUnder(realTarget, deps.platform));
      if (holders === null || holders.length > 0)
        return yield* keepAside(
          holders === null ? "Which process has files open in it is not known" : `${holders.join(", ")} had files open in it`,
        );
      // With nothing open in it and its old path gone, a write needs a new
      // open by the set-aside path; what was read before is read again, so a
      // write that landed before the listing is never removed uncopied.
      if (!(yield* memberUnchanged(assessment, state, false, target)))
        return yield* keepAside("It changed");
      // A same-size rewrite with its time restored passes that reading; the
      // bytes Git is about to delete must be the bytes the evidence holds.
      if (state.media.length > 0) {
        if (evidence === null) return yield* keepAside("Its media has no copy");
        for (const file of state.media) {
          const same = yield* Effect.tryPromise(() =>
            sameBytes(
              path.join(target, file.relative),
              path.join(evidence, state.member.relativePath, file.relative),
            ),
          ).pipe(Effect.orElseSucceed(() => false));
          if (!same) return yield* keepAside("Its media changed after it was copied");
        }
      }
      // Files Git leaves behind were checked by nobody: they stay, and so does the rest.
      const removal = yield* git
        .removeWorktree({
          cwd: state.repository,
          path: target,
          force: false,
          keepLeftBehind: true,
        })
        .pipe(Effect.result);
      if (removal._tag === "Failure") {
        yield* Effect.logWarning("storage cleanup could not remove a worktree; the rest stays", {
          folder: assessment.group.folder,
          member: state.member.relativePath,
          removedBefore: gone,
          error: removal.failure,
        });
        // Nothing more is deleted here, by any means: what Git left was checked
        // by nobody. Only what happened is read, for the person who will look.
        const registration = yield* checkWorktreeRegistration(target).pipe(
          Effect.map((checked) => checked.ok),
          Effect.orElseSucceed(() => false),
        );
        const stillThere = yield* fs.exists(target).pipe(Effect.orElseSucceed(() => true));
        const failure: WorktreeRemovalFailure = {
          folder: assessment.group.folder,
          member: state.member.relativePath === "" ? "the folder" : state.member.relativePath,
          at: DateTime.formatIso(yield* DateTime.now),
          what: describeRemovalFailure({
            stillRegistered: registration,
            left: stillThere ? leftBehind(target) : [],
          }),
          holders: stillThere
            ? yield* Effect.promise(() => openFileHolders(target, deps.platform))
            : [],
          removedBefore: gone,
        };
        return { stopped: "refused" as const, member: failure.member, gone, failure };
      }
      gone += 1;
    }
    // No `git worktree prune`: it drops every registration whose folder is
    // missing, a worktree on a drive that is not attached included, and a
    // plain `git worktree remove` already unregisters what it removes.
    for (const repository of new Set(assessment.members.map((state) => state.repository)))
      yield* gitManager.invalidateStatus(repository);
    const folder = assessment.group.folder;
    for (const state of assessment.members) {
      let parent = path.dirname(state.path);
      while (inside(folder, parent)) {
        yield* removeIfEmpty(parent);
        parent = path.dirname(parent);
      }
    }
    if (yield* fs.exists(folder).pipe(Effect.orElseSucceed(() => false)))
      yield* removeIfEmpty(folder);
    return { stopped: null, member: "", gone, failure: null };
  });

  return { copyMedia, discardEvidence, removeMembers };
}
