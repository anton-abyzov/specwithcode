import * as Schema from "effect/Schema";
import { EnvironmentId, ProjectId } from "./baseSchemas.ts";
import { MachineHandoffOperationId, MachineHandoffSourceChanges } from "./machineHandoff.ts";

/**
 * Folder copy: the destination pulls the project folder from the source over
 * the source's private tailnet address with an operation-scoped grant.
 */
const bounded = (max: number) => Schema.String.check(Schema.isMaxLength(max));
const count = Schema.Number;

export const FolderCopyScopesInput = Schema.Struct({ projectId: ProjectId });
export type FolderCopyScopesInput = typeof FolderCopyScopesInput.Type;
export const FolderCopyScopes = Schema.Struct({
  projectRoot: bounded(4096),
  recommendedCopyRoot: bounded(4096),
  scopes: Schema.Array(
    Schema.Struct({
      copyRoot: bounded(4096),
      projectRelativePath: bounded(4096),
      kind: Schema.Literals(["project", "workspace"]),
      label: bounded(200),
      repositories: Schema.Array(bounded(4096)),
      truncated: Schema.Boolean,
    }),
  ),
});
export type FolderCopyScopes = typeof FolderCopyScopes.Type;
export const FolderCopyCapabilities = Schema.Struct({ scopeVersion: Schema.Literal(1) });
const scopeFields = {
  /** Canonical source folder explicitly selected for this operation. */
  copyRoot: Schema.optional(bounded(4096)),
  /** Coordinator project inside that folder; absent means the legacy root project. */
  projectRelativePath: Schema.optional(bounded(4096)),
};

export const FolderCopyMode = Schema.Literals(["copy-only", "copy-and-move"]);
export type FolderCopyMode = typeof FolderCopyMode.Type;
export const FolderCopyFileClass = Schema.Literals([
  "repository",
  "tracked",
  "untracked",
  "ignoredData",
  "rebuildable",
  "secret",
]);
export type FolderCopyFileClass = typeof FolderCopyFileClass.Type;
export const FolderCopyChoice = Schema.Literals([
  "keep-mine",
  "take-theirs",
  "leave-both",
  "keep-both",
]);
export type FolderCopyChoice = typeof FolderCopyChoice.Type;

const ClassTotal = Schema.Struct({ files: count, bytes: count });
export const FolderCopyClassTotals = Schema.Struct({
  repository: ClassTotal,
  tracked: ClassTotal,
  untracked: ClassTotal,
  ignoredData: ClassTotal,
  rebuildable: ClassTotal,
  secret: ClassTotal,
});

export const FolderCopySourceSummary = Schema.Struct({
  totals: FolderCopyClassTotals,
  repositories: Schema.Array(
    Schema.Struct({
      path: bounded(4096),
      kind: Schema.Literals(["main", "linked", "gitfile"]),
      head: Schema.NullOr(bounded(64)),
      branch: Schema.NullOr(bounded(1024)),
      branchCount: count,
      stashCount: count,
      changedFiles: count,
    }),
  ),
  secretFiles: Schema.Array(Schema.Struct({ path: bounded(4096), size: count })),
  linksOutside: count,
  warnings: Schema.Array(bounded(2000)),
  /**
   * What measuring left out to stay fast: rebuildable folders (dependencies, build
   * output, caches) are not counted, and linked worktrees inside the folder are not
   * copied. Older sources omit it.
   */
  skipped: Schema.optional(
    Schema.Struct({
      rebuildableFolders: count,
      worktrees: Schema.Array(bounded(4096)),
      /**
       * Skipped worktrees with uncommitted (staged, unstaged or untracked) changes,
       * which stay on this machine. Older sources omit it.
       */
      dirtyWorktrees: Schema.optional(Schema.Array(bounded(4096))),
      /**
       * Skipped worktrees whose status check failed or timed out; they may hold
       * uncommitted changes. Older sources omit it.
       */
      uncheckedWorktrees: Schema.optional(Schema.Array(bounded(4096))),
      /**
       * Skipped worktrees on a detached HEAD no branch contains, or with a rebase,
       * merge, cherry-pick or revert in progress: committed work there would not
       * travel. Older sources omit it.
       */
      strandedWorktrees: Schema.optional(Schema.Array(bounded(4096))),
      /** True totals before the lists above were capped. Older sources omit them. */
      worktreeCount: Schema.optional(count),
      dirtyCount: Schema.optional(count),
    }),
  ),
});
export type FolderCopySourceSummary = typeof FolderCopySourceSummary.Type;

export const FolderCopySourceStatus = Schema.Struct({
  ...scopeFields,
  operationId: MachineHandoffOperationId,
  projectId: ProjectId,
  mode: FolderCopyMode,
  state: Schema.Literals([
    "scanning",
    "scanned",
    "building",
    "ready",
    "failed",
    "committed",
    "released",
    "cancelled",
  ]),
  summary: Schema.NullOr(FolderCopySourceSummary),
  scanCompletedAt: Schema.optional(count),
  capturedAt: Schema.optional(count),
  freshness: Schema.optional(
    Schema.Struct({
      checkedAt: count,
      current: Schema.Boolean,
      summary: Schema.optional(FolderCopySourceSummary),
    }),
  ),
  /** Files and bytes measured so far while scanning, or hashed so far while building. */
  progress: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        files: count,
        bytes: count,
        /**
         * What the source is doing (older sources omit it): "listing" files,
         * "checking-worktrees" for uncommitted changes, copying the "git-snapshot"
         * (files/bytes are Git data copied) or "hashing" the selected files.
         */
        step: Schema.optional(
          Schema.Literals(["listing", "checking-worktrees", "git-snapshot", "hashing"]),
        ),
        /** While hashing: the selected files and bytes to read in all. */
        totalFiles: Schema.optional(count),
        totalBytes: Schema.optional(count),
      }),
    ),
  ),
  error: Schema.NullOr(bounded(2000)),
  releaseReason: Schema.NullOr(bounded(500)),
  /** Secret files the person approved for this destination: paths and sizes only. */
  secrets: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        files: Schema.Array(Schema.Struct({ path: bounded(4096), size: count })),
        approvedAt: count,
        destinationLabel: bounded(200),
      }),
    ),
  ),
});
export type FolderCopySourceStatus = typeof FolderCopySourceStatus.Type;

export const FolderCopyOfferInput = Schema.Struct({
  projectId: ProjectId,
  operationId: MachineHandoffOperationId,
  mode: FolderCopyMode,
  destinationEnvironmentId: EnvironmentId,
  copyRoot: Schema.optional(bounded(4096)),
});
export type FolderCopyOfferInput = typeof FolderCopyOfferInput.Type;
/** What the destination needs to pull. The browser relays it once; the token expires with the copy. */
export const FolderCopyOffer = Schema.Struct({
  ...scopeFields,
  operationId: MachineHandoffOperationId,
  sourceEnvironmentId: EnvironmentId,
  sourceProjectId: ProjectId,
  sourceUrl: bounded(2048),
  /** The source's SpecWithCode Connect address, tried when `sourceUrl` does not answer. */
  sourceConnectUrl: Schema.optional(bounded(2048)),
  sourceMachine: bounded(200),
  token: bounded(4096),
  title: bounded(1000),
  mode: FolderCopyMode,
  status: FolderCopySourceStatus,
});
export type FolderCopyOffer = typeof FolderCopyOffer.Type;

/** The secret files the person ticked, sent to this destination only. Empty withdraws them. */
export const FolderCopySecretsInput = Schema.Struct({
  operationId: MachineHandoffOperationId,
  paths: Schema.Array(bounded(4096)).check(Schema.isMaxLength(500)),
  destinationLabel: bounded(200),
});
export type FolderCopySecretsInput = typeof FolderCopySecretsInput.Type;

export const FolderCopySentSecretsInput = Schema.Struct({
  destinationEnvironmentId: Schema.optional(EnvironmentId),
});
export type FolderCopySentSecretsInput = typeof FolderCopySentSecretsInput.Type;
/** Which secret files this machine sent where, and when. Never their contents. */
export const FolderCopySentSecrets = Schema.Struct({
  entries: Schema.Array(
    Schema.Struct({
      operationId: MachineHandoffOperationId,
      destinationEnvironmentId: bounded(200),
      destinationLabel: bounded(200),
      folder: bounded(4096),
      path: bounded(4096),
      size: count,
      sentAt: bounded(64),
    }),
  ),
});
export type FolderCopySentSecrets = typeof FolderCopySentSecrets.Type;

/** Source: what differs since a committed copy-and-move, read again after the coordinator moved. */
export const FolderCopyDriftInput = Schema.Struct({
  projectId: ProjectId,
  operationId: MachineHandoffOperationId,
});
export type FolderCopyDriftInput = typeof FolderCopyDriftInput.Type;
export const FolderCopyDriftResult = Schema.Struct({
  drift: MachineHandoffSourceChanges,
  /** The paths the person moved without; they stay only on the source. */
  leftOnSource: Schema.optional(
    Schema.Struct({
      digest: MachineHandoffSourceChanges.fields.digest,
      total: count,
      recordedAt: count,
    }),
  ),
});
export type FolderCopyDriftResult = typeof FolderCopyDriftResult.Type;

export const FolderCopySourceStatusInput = Schema.Struct({
  operationId: MachineHandoffOperationId,
  refresh: Schema.optional(Schema.Boolean),
});
export type FolderCopySourceStatusInput = typeof FolderCopySourceStatusInput.Type;
export const FolderCopyOperationInput = Schema.Struct({ operationId: MachineHandoffOperationId });
export type FolderCopyOperationInput = typeof FolderCopyOperationInput.Type;
export const FolderCopyCancelInput = Schema.Struct({
  operationId: MachineHandoffOperationId,
  reason: bounded(400),
});
export type FolderCopyCancelInput = typeof FolderCopyCancelInput.Type;
/** Returns the coordinator to the source after a copy-and-move that did not finish. */
export const FolderCopyReleaseInput = Schema.Struct({
  projectId: ProjectId,
  operationId: MachineHandoffOperationId,
  reason: bounded(400),
});
export type FolderCopyReleaseInput = typeof FolderCopyReleaseInput.Type;
export const FolderCopyReleaseResult = Schema.Struct({
  projectId: ProjectId,
  released: Schema.Boolean,
});

export const FolderCopyStartInput = Schema.Struct({
  ...scopeFields,
  operationId: MachineHandoffOperationId,
  sourceEnvironmentId: EnvironmentId,
  sourceProjectId: ProjectId,
  sourceUrl: bounded(2048),
  sourceConnectUrl: Schema.optional(bounded(2048)),
  sourceMachine: bounded(200),
  token: bounded(4096),
  title: bounded(1000),
  mode: FolderCopyMode,
  targetFolder: bounded(4096),
  selection: Schema.optional(Schema.Array(FolderCopyFileClass)),
  /** Copy-and-move: the project id the moving coordinator expects for this folder. */
  projectId: Schema.optional(ProjectId),
});
export type FolderCopyStartInput = typeof FolderCopyStartInput.Type;

/** A decision key that answers every file conflict in one row, including unlisted ones. */
export const FOLDER_COPY_ALL_CONFLICTS_PREFIX = "all:";
export const folderCopyAllConflictsKey = (rowId: string) =>
  `${FOLDER_COPY_ALL_CONFLICTS_PREFIX}${rowId}`;

export const FolderCopyDecideInput = Schema.Struct({
  operationId: MachineHandoffOperationId,
  decisions: Schema.optional(Schema.Record(bounded(4200), FolderCopyChoice)),
  clone: Schema.optional(Schema.Array(bounded(4200))),
  /** Repository rows to leave out of the copy entirely. Older destinations ignore it. */
  skip: Schema.optional(Schema.Array(bounded(4200))),
  mirror: Schema.optional(Schema.Boolean),
});
export type FolderCopyDecideInput = typeof FolderCopyDecideInput.Type;

export const FolderCopyUndoInput = Schema.Struct({
  operationId: MachineHandoffOperationId,
  /** Preview only: list what Undo would restore and which files changed after Apply. */
  preview: Schema.Boolean,
  /** Also move files edited after Apply to the backup folder. */
  force: Schema.Boolean,
});
export type FolderCopyUndoInput = typeof FolderCopyUndoInput.Type;

export const FolderCopyRow = Schema.Struct({
  id: bounded(4200),
  kind: Schema.Literals(["repository", "files"]),
  path: bounded(4096),
  status: Schema.Literals([
    "same",
    "fast-forward",
    "ahead",
    "diverged",
    "dirty",
    "conflict",
    "new",
    "only-here",
    "skipped",
  ]),
  detail: bounded(4000),
  filesToMove: count,
  bytesToMove: count,
  bytesPresent: count,
  choices: Schema.Array(FolderCopyChoice),
  decision: Schema.NullOr(FolderCopyChoice),
  needsDecision: Schema.Boolean,
  conflicts: Schema.Array(
    Schema.Struct({
      id: bounded(4200),
      path: bounded(4096),
      reason: Schema.Literals(["differs", "type-differs"]),
      choices: Schema.Array(FolderCopyChoice),
      decision: Schema.NullOr(FolderCopyChoice),
    }),
  ),
  /** Conflicts beyond those listed. */
  moreConflicts: count,
  cloneAvailable: Schema.Boolean,
  clone: Schema.Boolean,
  /**
   * Files on this machine the row's plan overwrites or moves to the backup folder,
   * even when the row needs no decision. Older destinations omit it.
   */
  replacing: Schema.optional(count),
});
export type FolderCopyRow = typeof FolderCopyRow.Type;

export const FolderCopyState = Schema.Literals([
  "planned",
  "scanning",
  "previewed",
  "approved",
  "transferring",
  "verifying",
  "applying",
  "applied",
  "undone",
  "failed",
  "cancelled",
]);
export type FolderCopyState = typeof FolderCopyState.Type;

export const FolderCopyStatus = Schema.Struct({
  capturedAt: Schema.optional(count),
  ...scopeFields,
  /** Registered coordinator workspace, which can be below targetFolder. */
  projectFolder: Schema.optional(bounded(4096)),
  operationId: MachineHandoffOperationId,
  sourceEnvironmentId: EnvironmentId,
  sourceProjectId: ProjectId,
  sourceMachine: bounded(200),
  mode: FolderCopyMode,
  targetFolder: bounded(4096),
  title: bounded(1000),
  selection: Schema.Array(FolderCopyFileClass),
  mirror: Schema.Boolean,
  state: FolderCopyState,
  failedStep: Schema.NullOr(FolderCopyState),
  /** Restoration started but has not completed; recover with Undo, never Apply Retry. */
  undoIncomplete: Schema.optional(Schema.Boolean),
  error: Schema.NullOr(Schema.Struct({ code: bounded(64), message: bounded(4000) })),
  progress: Schema.NullOr(
    Schema.Struct({
      phase: Schema.Literals(["manifest", "files", "verify", "apply"]),
      filesDone: count,
      filesTotal: count,
      bytesDone: count,
      bytesTotal: count,
      bytesLocal: count,
    }),
  ),
  disk: Schema.NullOr(Schema.Struct({ needed: count, free: count })),
  rows: Schema.Array(FolderCopyRow),
  totals: Schema.NullOr(
    Schema.Struct({
      filesToMove: count,
      bytesToMove: count,
      bytesPresent: count,
      decisionsNeeded: count,
      /** Sum of the rows' `replacing`. Older destinations omit it. */
      replacing: Schema.optional(count),
    }),
  ),
  checks: Schema.Array(
    Schema.Struct({
      repo: bounded(4096),
      ok: Schema.Boolean,
      problems: Schema.Array(bounded(4000)),
    }),
  ),
  warnings: Schema.Array(bounded(4000)),
  unstable: Schema.Array(bounded(4096)),
  committed: Schema.Boolean,
  projectId: Schema.NullOr(ProjectId),
  /** Set once the Apply backups were discarded (after 14 days); Undo is gone then. */
  backupsDiscardedAt: Schema.optional(bounded(64)),
  /** Secret files received after Apply, each mode 0600; paths only. */
  secrets: Schema.optional(
    Schema.Array(
      Schema.Struct({
        path: bounded(4096),
        writtenAs: bounded(4200),
        size: count,
        state: Schema.Literals(["written", "unchanged", "beside"]),
      }),
    ),
  ),
  createdAt: bounded(64),
  updatedAt: bounded(64),
});
export type FolderCopyStatus = typeof FolderCopyStatus.Type;

export const FolderCopyUndoResult = Schema.Struct({
  status: FolderCopyStatus,
  items: Schema.Array(
    Schema.Struct({
      path: bounded(4096),
      kind: Schema.Literals(["file", "ref", "head", "stash", "worktree", "clone"]),
      state: Schema.Literals(["restore", "edited", "missing"]),
      detail: bounded(4000),
    }),
  ),
  edited: count,
  undone: Schema.Boolean,
  kept: Schema.Array(bounded(4096)),
  problems: Schema.Array(bounded(4000)),
});
export type FolderCopyUndoResult = typeof FolderCopyUndoResult.Type;

export class FolderCopyError extends Schema.TaggedError<FolderCopyError>()("FolderCopyError", {
  code: Schema.Literals([
    "not_found",
    "busy",
    "invalid",
    "no_private_url",
    "unreachable",
    "outdated_source",
    "unauthorized",
    "wrong_machine",
    "refused",
    "disk_space",
    "not_a_folder",
    "apply_refused",
    "copy_failed",
  ]),
  detail: Schema.optional(bounded(4000)),
  /** A refused preview must be replaced by an explicitly reviewed comparison. */
  recovery: Schema.optional(Schema.Literal("compare_again")),
}) {
  override get message(): string {
    // A source refusal's detail names the machine and the next step on its own.
    if (this.code === "unauthorized" && this.detail) return this.detail;
    const base = {
      not_found: "The copy or its project is no longer available.",
      busy: "Finish active work in this project before moving it.",
      invalid: "The copy request is invalid.",
      no_private_url:
        "This machine has no private tailnet address or SpecWithCode Connect address yet. Turn on remote access for it in Settings > Connections, then try again.",
      unreachable: "The source machine stopped answering. Check that both machines are online.",
      outdated_source:
        "The source machine runs an older SpecWithCode without folder copy. Update it first.",
      unauthorized: "The source no longer accepts this copy. Start it again.",
      wrong_machine: "The source address answered for a different machine.",
      refused: "The copy was refused.",
      disk_space: "There is not enough free space here for the copy.",
      not_a_folder: "The chosen location is not a folder.",
      apply_refused: "The copy could not be applied safely. Nothing was changed after the refusal.",
      copy_failed: "The copy failed.",
    }[this.code];
    return this.detail ? `${base} ${this.detail}` : base;
  }
}
