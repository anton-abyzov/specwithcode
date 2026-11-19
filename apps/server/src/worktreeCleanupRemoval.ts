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
  type WorktreeRemovalFailure,
} from "./worktreeRemovalFailures.ts";
import {
  type Assessment,
  encodeJson,
  type MemberState,
} from "./worktreeCleanupMemberFacts.ts";

/** `yyyyMMdd-HHmmss` in UTC, for an evidence folder name. */
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
    ) {
      if (
        state.member.relativePath !== "" &&
        !(yield* memberStaysInside(assessment.group.folder, state.path))
      )
        return false;
      const registration = yield* checkWorktreeRegistration(state.path);
      if (!registration.ok || registration.locked) return false;
      // The same repository the assessment found, by the same rule.
      const inSet = state.member.repository !== "";
      if (inSet) {
        if ((yield* realOrNull(path.join(state.repository, ".git"))) !== registration.commonDir)
          return false;
      } else if (registration.repository !== state.repository) return false;
      // A volume mounted at the folder itself has the same real path and other files.
      if (state.member.relativePath === "") {
        const real = yield* realOrNull(state.path);
        if (real === null) return false;
        const [own, parent] = yield* Effect.all([fs.stat(real), fs.stat(path.dirname(real))]);
        if (own.dev !== parent.dev) return false;
      }
      const again: MemberState = {
        ...state,
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
      if (again.fingerprint !== state.fingerprint) return false;
      if (!walkNested) return true;
      yield* readNested(again);
      return again.git?.nestedRepository === false;
      // Anything unreadable counts as changed.
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
      // Files Git leaves behind were checked by nobody: they stay, and so does the rest.
      const removal = yield* git
        .removeWorktree({
          cwd: state.repository,
          path: state.path,
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
        const registration = yield* checkWorktreeRegistration(state.path).pipe(
          Effect.map((checked) => checked.ok),
          Effect.orElseSucceed(() => false),
        );
        const stillThere = yield* fs.exists(state.path).pipe(Effect.orElseSucceed(() => true));
        const failure: WorktreeRemovalFailure = {
          folder: assessment.group.folder,
          member: state.member.relativePath === "" ? "the folder" : state.member.relativePath,
          at: DateTime.formatIso(yield* DateTime.now),
          what: describeRemovalFailure({
            stillRegistered: registration,
            left: stillThere ? leftBehind(state.path) : [],
          }),
          holders: stillThere
            ? yield* Effect.promise(() => openFileHolders(state.path, deps.platform))
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
