// @effect-diagnostics nodeBuiltinImport:off - the checkpoint runs Git with a private index file.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  HANDOFF_HIDDEN_REF_PREFIX,
  HANDOFF_MAX_SNAPSHOT_FILE_BYTES,
  HANDOFF_MAX_SNAPSHOT_FILES,
  type HandoffSkippedFile,
} from "@specweave-studio/contracts";

import { gitText, runGit } from "../fleet/folderTransfer/git.ts";
import { isSecretLikeProjectPath } from "../workspace/WorkspaceSensitivePaths.ts";

const SKIPPED_LIST_MAX = 200;
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
  /** False when the tree matched the previous checkpoint, which was kept. */
  readonly changed: boolean;
}

export function handoffRef(threadId: string): string {
  if (
    !/^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(threadId) ||
    threadId.includes("..") ||
    threadId.endsWith(".lock")
  ) {
    throw new CheckpointError("failed", "The thread id cannot name a Git ref.");
  }
  return `${HANDOFF_HIDDEN_REF_PREFIX}${threadId}`;
}

async function repositoryRoot(cwd: string): Promise<string> {
  const result = await runGit(cwd, ["rev-parse", "--show-toplevel"], { allowFailure: true });
  if (result.code !== 0) throw new CheckpointError("not_a_repository", "Not a Git repository.");
  return result.stdout.trim();
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
}): Promise<CheckpointCommit> {
  const root = await repositoryRoot(input.cwd);
  const ref = handoffRef(input.threadId);
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
    const [untracked, changed] = await Promise.all([
      runGit(root, ["ls-files", "-z", "--others", "--exclude-standard"], { env }),
      runGit(root, ["diff", "--name-only", "-z", "--no-renames", baseCommit], { env }),
    ]);
    const candidates = new Set<string>();
    for (const entry of changed.stdout.split("\0")) if (entry) candidates.add(entry);
    for (const entry of untracked.stdout.split("\0")) if (entry) candidates.add(entry);

    const skipped: Array<HandoffSkippedFile> = [];
    const skip = (file: HandoffSkippedFile) => {
      if (skipped.length < SKIPPED_LIST_MAX) skipped.push(file);
    };
    let excludedSecretCount = 0;
    const included: Array<string> = [];
    for (const path of [...candidates].toSorted()) {
      if (path.endsWith("/")) {
        skip({ path: path.slice(0, -1), bytes: 0, reason: "submodule" });
        continue;
      }
      if (isSecretLikeProjectPath(path)) {
        excludedSecretCount += 1;
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

    if (included.length > 0) {
      const pathspec = NodePath.join(scratch, "pathspec");
      await NodeFSP.writeFile(pathspec, `${included.join("\0")}\0`, { mode: 0o600 });
      await runGit(root, ["add", "-A", "--pathspec-from-file", pathspec, "--pathspec-file-nul"], {
        env,
      });
    }
    const ownTree = (await runGit(root, ["write-tree"], { env })).stdout.trim();

    const previous = await runGit(root, ["rev-parse", "--verify", "-q", `${ref}^{commit}`], {
      allowFailure: true,
    });
    if (previous.code === 0) {
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
          changed: false,
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
    await runGit(root, ["update-ref", ref, commit]);
    return { root, commit, baseCommit, branch, ref, skipped, excludedSecretCount, changed: true };
  } finally {
    await NodeFSP.rm(scratch, { recursive: true, force: true });
  }
}

/** Pushes only the hidden ref to `origin`; false when there is no origin or the push failed. */
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
