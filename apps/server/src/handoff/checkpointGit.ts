// @effect-diagnostics nodeBuiltinImport:off - the checkpoint runs Git with a private index file.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  HANDOFF_HIDDEN_REF_PREFIX,
  HANDOFF_MAX_SNAPSHOT_FILE_BYTES,
  HANDOFF_MAX_SNAPSHOT_FILES,
  type HandoffSkippedFile,
} from "@specweave-studio/contracts";

import { cloneStagingIn } from "../fleet/cloneStaging.ts";
import { gitText, runGit } from "../fleet/folderTransfer/git.ts";
import {
  isSecretLikeProjectPath,
  isUntrackedSecretConfigPath,
} from "../workspace/WorkspaceSensitivePaths.ts";
import {
  checkSnapshotContent,
  checkStagedContent,
  type SnapshotContentFinding,
} from "./snapshotSecrets.ts";

const SKIPPED_LIST_MAX = 200;
const REQUIRED_SECRET_PATHS_MAX = 200;
const CHECKPOINT_IDENTITY = {
  GIT_AUTHOR_NAME: "SpecWithCode",
  GIT_AUTHOR_EMAIL: "handoff@specwithcode.invalid",
  GIT_COMMITTER_NAME: "SpecWithCode",
  GIT_COMMITTER_EMAIL: "handoff@specwithcode.invalid",
};

export class CheckpointError extends Error {
  readonly code: "not_a_repository" | "no_commit" | "failed";
  constructor(code: CheckpointError["code"], message: string) {
    super(message);
    this.code = code;
  }
}

export interface CheckpointCommit {
  readonly root: string;
  readonly commit: string;
  readonly baseCommit: string;
  readonly branch: string | null;
  readonly ref: string;
  readonly skipped: ReadonlyArray<HandoffSkippedFile>;
  readonly excludedSecretCount: number;
  /** Secret-like and ignored env files present in the worktree (paths only), sorted. */
  readonly requiredSecretPaths: ReadonlyArray<string>;
  /** False when the tree matched the previous checkpoint, which was kept. */
  readonly changed: boolean;
  /** Changed and untracked files left out as secrets by their name. Never sent to another machine. */
  readonly excludedSecretPaths: ReadonlyArray<string>;
  /** Local only: the first file left out for its size or the file count, also past the capped list. */
  readonly overLimit: HandoffSkippedFile | null;
  /** Untracked files the content check left out; empty unless `contentCheck` was asked for. */
  readonly leftOutByContent: ReadonlyArray<SnapshotContentFinding>;
  /** Files in the snapshot, after everything left out. */
  readonly includedFileCount: number;
}

const REF_COMPONENT = /^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/;

/**
 * One Git ref path component for an id. Real ids carry `:` and `%`, which a
 * ref cannot hold, so anything outside the plain set becomes a readable slug
 * plus a hash of the whole id: deterministic, unique and always valid.
 */
export function refComponent(id: string): string {
  if (
    id.length > 0 &&
    id.length <= 120 &&
    REF_COMPONENT.test(id) &&
    !id.includes("..") &&
    !id.endsWith(".") &&
    !id.endsWith(".lock")
  ) {
    return id;
  }
  const slug =
    id
      .replace(/[^A-Za-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "id";
  return `${slug}-${NodeCrypto.createHash("sha256").update(id).digest("hex").slice(0, 16)}`;
}

export function handoffRef(threadId: string): string {
  return `${HANDOFF_HIDDEN_REF_PREFIX}${refComponent(threadId)}`;
}

async function repositoryRoot(cwd: string): Promise<string> {
  const result = await runGit(cwd, ["rev-parse", "--show-toplevel"], { allowFailure: true });
  if (result.code !== 0) throw new CheckpointError("not_a_repository", "Not a Git repository.");
  // Git prints the top level with forward slashes on Windows; resolve gives
  // the platform's native form so callers can compare it with their paths.
  return NodePath.resolve(result.stdout.trim());
}

/**
 * Writes the worktree as a commit on `refs/specwithcode/handoff/<threadId>`,
 * parented on HEAD. A private GIT_INDEX_FILE holds the snapshot, so HEAD, the
 * real index and the working tree never change. Untracked secret-like files
 * and ignored files stay out; oversized files, nested repositories and files
 * past the count cap are skipped and listed.
 */
export async function writeCheckpoint(input: {
  readonly cwd: string;
  readonly threadId: string;
  readonly message?: string;
  /** Another ref to write the snapshot to; defaults to the thread's hidden handoff ref. */
  readonly ref?: string;
  /**
   * Create `ref` only where no ref of that name exists (Git checks under its
   * lock): a ref someone else holds is never reused or overwritten, and the
   * call fails instead.
   */
  readonly exclusive?: boolean;
  /**
   * The Git folder `ref` is written in (and an earlier one read from), when
   * not the checkout's own: a private repository that reads the checkout's
   * objects through its alternates. The snapshot's objects are always written
   * in the checkout's object store.
   */
  readonly refGitDir?: string;
  /**
   * Also check untracked files by content (`snapshotSecrets.ts`) and leave out
   * what it flags, except the files named in `sendAnyway`. Off unless asked
   * for: a thread's checkpoint keeps today's name check alone until the thread
   * can show which files were left out.
   */
  readonly contentCheck?: {
    readonly pastLimit: "leave-out" | "name-only";
    readonly sendAnyway?: ReadonlyArray<string>;
    /** Runs between the check of the files and their staging. Tests rewrite a file here. */
    readonly onChecked?: () => Promise<void>;
  };
}): Promise<CheckpointCommit> {
  const root = await repositoryRoot(input.cwd);
  const ref = input.ref ?? handoffRef(input.threadId);
  const refEnv = input.refGitDir === undefined ? {} : { env: { GIT_DIR: input.refGitDir } };
  const head = await runGit(root, ["rev-parse", "--verify", "-q", "HEAD^{commit}"], {
    allowFailure: true,
  });
  if (head.code !== 0) {
    throw new CheckpointError(
      "no_commit",
      "The repository has no commit to build a checkpoint on.",
    );
  }
  const baseCommit = head.stdout.trim();
  const symbolic = await runGit(root, ["symbolic-ref", "-q", "--short", "HEAD"], {
    allowFailure: true,
  });
  const branch = symbolic.code === 0 ? symbolic.stdout.trim() || null : null;

  const scratch = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "swc-handoff-"));
  try {
    const env = { GIT_INDEX_FILE: NodePath.join(scratch, "index") };
    await runGit(root, ["read-tree", baseCommit], { env });
    const [untracked, changed, ignored] = await Promise.all([
      runGit(root, ["ls-files", "-z", "--others", "--exclude-standard"], { env }),
      runGit(root, ["diff", "--name-only", "-z", "--no-renames", baseCommit], { env }),
      runGit(
        root,
        ["ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--directory"],
        { env },
      ),
    ]);
    // A folder a Sync clone is being made in (it carries the clone step's mark) is not
    // this checkout's work: neither its mark nor the half-made clone is ever carried, and
    // no ignored secret in it is asked for.
    const staging = cloneStagingIn(root);
    const secretPaths = new Set<string>();
    for (const entry of ignored.stdout.split("\0")) {
      if (
        entry &&
        !entry.endsWith("/") &&
        (isSecretLikeProjectPath(entry) || isUntrackedSecretConfigPath(entry)) &&
        !(await staging.has(entry))
      )
        secretPaths.add(entry);
    }
    const candidates = new Set<string>();
    const untrackedPaths = new Set<string>();
    for (const entry of untracked.stdout.split("\0"))
      if (entry && !(await staging.has(entry))) untrackedPaths.add(entry);
    for (const entry of changed.stdout.split("\0")) if (entry) candidates.add(entry);
    for (const entry of untrackedPaths) candidates.add(entry);

    const skipped: Array<HandoffSkippedFile> = [];
    let overLimit: HandoffSkippedFile | null = null;
    const skip = (file: HandoffSkippedFile) => {
      // The list is capped for display; the first file over a limit is kept apart from it.
      if (file.reason !== "submodule" && overLimit === null) overLimit = file;
      if (skipped.length < SKIPPED_LIST_MAX) skipped.push(file);
    };
    let excludedSecretCount = 0;
    const excludedSecretPaths: Array<string> = [];
    let included: Array<string> = [];
    for (const path of [...candidates].toSorted()) {
      if (path.endsWith("/")) {
        skip({ path: path.slice(0, -1), bytes: 0, reason: "submodule" });
        continue;
      }
      // A tracked appsettings.json is ordinary work; an untracked one usually holds secrets.
      if (
        isSecretLikeProjectPath(path) ||
        (untrackedPaths.has(path) && isUntrackedSecretConfigPath(path))
      ) {
        excludedSecretCount += 1;
        secretPaths.add(path);
        excludedSecretPaths.push(path);
        continue;
      }
      const stat = await NodeFSP.lstat(NodePath.join(root, path)).catch(() => null);
      if (stat !== null && stat.isDirectory()) {
        skip({ path, bytes: 0, reason: "submodule" });
        continue;
      }
      const bytes = stat === null || stat.isSymbolicLink() ? 0 : stat.size;
      if (bytes > HANDOFF_MAX_SNAPSHOT_FILE_BYTES) {
        skip({ path, bytes, reason: "too-large" });
        continue;
      }
      if (included.length >= HANDOFF_MAX_SNAPSHOT_FILES) {
        skip({ path, bytes, reason: "too-many-files" });
        continue;
      }
      included.push(path);
    }

    let leftOutByContent: ReadonlyArray<SnapshotContentFinding> = [];
    if (input.contentCheck !== undefined) {
      const checked = await checkSnapshotContent({
        root,
        untracked: included.filter((path) => untrackedPaths.has(path)),
        allow: new Set(input.contentCheck.sendAnyway ?? []),
        pastLimit: input.contentCheck.pastLimit,
      });
      leftOutByContent = checked.leftOut;
      const out = new Set(leftOutByContent.map((file) => file.path));
      included = included.filter((path) => !out.has(path));
      await input.contentCheck.onChecked?.();
    }

    if (included.length > 0) {
      const pathspec = NodePath.join(scratch, "pathspec");
      await NodeFSP.writeFile(pathspec, `${included.join("\0")}\0`, { mode: 0o600 });
      await runGit(root, ["add", "-A", "--pathspec-from-file", pathspec, "--pathspec-file-nul"], {
        env,
      });
    }
    let ownTree = (await runGit(root, ["write-tree"], { env })).stdout.trim();
    if (input.contentCheck !== undefined) {
      // What is checked is what travels: the staged blobs are judged, not the files
      // read a moment earlier, which a running thread may have rewritten since.
      const staged = await checkStagedContent({
        root,
        baseCommit,
        tree: ownTree,
        secretName: (path) => isSecretLikeProjectPath(path) || isUntrackedSecretConfigPath(path),
        allow: new Set(input.contentCheck.sendAnyway ?? []),
        maxFileBytes: HANDOFF_MAX_SNAPSHOT_FILE_BYTES,
        maxChangedFiles: HANDOFF_MAX_SNAPSHOT_FILES,
      });
      if (staged.tooLarge !== null) skip({ ...staged.tooLarge, reason: "too-large" });
      if (staged.tooMany !== null)
        skip({ path: staged.tooMany.path, bytes: 0, reason: "too-many-files" });
      for (const path of staged.secretNames) {
        excludedSecretCount += 1;
        secretPaths.add(path);
        excludedSecretPaths.push(path);
      }
      if (staged.flagged.length > 0 || staged.secretNames.length > 0) {
        const flagged = [...staged.flagged.map((file) => file.path), ...staged.secretNames];
        for (let index = 0; index < flagged.length; index += 100) {
          await runGit(
            root,
            ["update-index", "--force-remove", "--", ...flagged.slice(index, index + 100)],
            { env },
          );
        }
        const out = new Set(flagged);
        leftOutByContent = [
          ...leftOutByContent.filter((file) => !out.has(file.path)),
          ...staged.flagged,
        ];
        included = included.filter((path) => !out.has(path));
        ownTree = (await runGit(root, ["write-tree"], { env })).stdout.trim();
      }
    }
    const local = {
      excludedSecretPaths,
      leftOutByContent,
      includedFileCount: included.length,
      overLimit: overLimit as HandoffSkippedFile | null,
    };
    const requiredSecretPaths = [...secretPaths]
      .filter((path) => path.length <= 1024)
      .toSorted()
      .slice(0, REQUIRED_SECRET_PATHS_MAX);

    const previous =
      input.exclusive === true
        ? null
        : await runGit(root, ["rev-parse", "--verify", "-q", `${ref}^{commit}`], {
            allowFailure: true,
            ...refEnv,
          });
    if (previous !== null && previous.code === 0) {
      const previousCommit = previous.stdout.trim();
      const [previousTree, previousParent] = await Promise.all([
        gitText(root, ["rev-parse", `${previousCommit}^{tree}`]),
        runGit(root, ["rev-parse", "-q", "--verify", `${previousCommit}^1`], {
          allowFailure: true,
        }),
      ]);
      if (previousTree === ownTree && previousParent.stdout.trim() === baseCommit) {
        return {
          root,
          commit: previousCommit,
          baseCommit,
          branch,
          ref,
          skipped,
          excludedSecretCount,
          requiredSecretPaths,
          changed: false,
          ...local,
        };
      }
    }

    const commit = (
      await runGit(
        root,
        [
          "commit-tree",
          ownTree,
          "-p",
          baseCommit,
          "-m",
          input.message ?? `SpecWithCode handoff checkpoint for ${input.threadId}`,
        ],
        { env: CHECKPOINT_IDENTITY },
      )
    ).stdout.trim();
    await runGit(
      root,
      ["update-ref", ref, commit, ...(input.exclusive === true ? [""] : [])],
      refEnv,
    );
    return {
      root,
      commit,
      baseCommit,
      branch,
      ref,
      skipped,
      excludedSecretCount,
      requiredSecretPaths,
      changed: true,
      ...local,
    };
  } finally {
    await NodeFSP.rm(scratch, { recursive: true, force: true });
  }
}

/** Pushes only the hidden ref to `origin`; false when there is no origin or the push failed. */
const FENCED_BRANCH_ATTEMPTS = 20;

function machineSlug(label: string): string {
  return (
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "machine"
  );
}

async function treeOf(root: string, commit: string): Promise<string | null> {
  const result = await runGit(root, ["rev-parse", "-q", "--verify", `${commit}^{tree}`], {
    allowFailure: true,
  });
  return result.code === 0 ? result.stdout.trim() : null;
}

/**
 * A copy fenced while it was away (another machine continued the thread)
 * keeps what it changed after its last handed-over checkpoint on
 * `swc/from-<machine>/<branch>` for review. The branch only gains a ref:
 * HEAD, the index and the working tree stay as they are, and nothing is
 * merged. Returns the branch name, or null when nothing changed.
 */
export async function keepFencedChanges(input: {
  readonly cwd: string;
  readonly threadId: string;
  readonly machineLabel: string;
  /** The checkpoint the other machine continued from, when known. */
  readonly handedOverCommit: string | null;
}): Promise<string | null> {
  const scratchRef = `refs/specwithcode/fenced/${refComponent(input.threadId)}`;
  const snapshot = await writeCheckpoint({
    cwd: input.cwd,
    threadId: input.threadId,
    ref: scratchRef,
    message: `SpecWithCode: changes on ${input.machineLabel} after another machine continued this thread`,
  });
  const root = snapshot.root;
  try {
    const own = await treeOf(root, snapshot.commit);
    const handedOver =
      input.handedOverCommit === null ? null : await treeOf(root, input.handedOverCommit);
    const compareTo = handedOver ?? (await treeOf(root, snapshot.baseCommit));
    if (own === null || own === compareTo) return null;
    const leaf = snapshot.branch ?? `thread-${refComponent(input.threadId)}`;
    const base = `swc/from-${machineSlug(input.machineLabel)}/${leaf}`;
    const valid = await runGit(root, ["check-ref-format", "--branch", base], {
      allowFailure: true,
    });
    const stem =
      valid.code === 0
        ? base
        : `swc/from-${machineSlug(input.machineLabel)}/thread-${refComponent(input.threadId)}`;
    for (let attempt = 1; attempt <= FENCED_BRANCH_ATTEMPTS; attempt += 1) {
      const name = attempt === 1 ? stem : `${stem}-${attempt}`;
      // An empty old value creates the branch only if it does not exist yet.
      const created = await runGit(
        root,
        ["update-ref", `refs/heads/${name}`, snapshot.commit, ""],
        { allowFailure: true },
      );
      if (created.code === 0) return name;
    }
    throw new CheckpointError("failed", `Could not name a branch for the changes under ${stem}.`);
  } finally {
    await runGit(root, ["update-ref", "-d", scratchRef], { allowFailure: true });
  }
}

export async function pushCheckpointRef(root: string, ref: string): Promise<boolean> {
  const origin = await runGit(root, ["remote", "get-url", "origin"], { allowFailure: true });
  if (origin.code !== 0) return false;
  const pushed = await runGit(
    root,
    ["push", "--no-verify", "--quiet", "origin", `+${ref}:${ref}`],
    {
      allowFailure: true,
      timeoutMs: 60_000,
    },
  );
  return pushed.code === 0;
}
