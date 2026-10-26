import * as Schema from "effect/Schema";
import {
  EnvironmentId,
  FolderCopyError,
  type FolderCopyOffer,
  type FolderCopyRow,
  type FolderCopySentSecrets,
  type FolderCopySourceStatus,
  type FolderCopyStatus,
  type FolderCopyUndoResult,
  type MachineHandoffRepository,
  ProjectId,
} from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import { sha256 } from "../nodeCrypto.ts";
import { CopyError, type DestinationRecord } from "./folderTransfer/destinationService.ts";
import type { Plan } from "./folderTransfer/reconcile.ts";
import {
  SourceTransferError,
  type SourceOperationRecord,
  type SourceSummary,
} from "./folderTransfer/sourceService.ts";
import type { SentSecret } from "./folderTransfer/secrets.ts";
import type { UndoPreview, UndoResult } from "./folderTransfer/undo.ts";
import { copiedProjectFolder } from "./folderCopyScope.ts";
import { handoffRef, safeRelativePath } from "./handoffGitTypes.ts";

/** Conflicts listed per row; the rest are counted so a status stays small. */
export const MAX_ROW_CONFLICTS = 200;
const MAX_MANIFEST_REPOSITORIES = 128;
const HEAD = /^[a-f0-9]{40}$/;

const text = (value: unknown, max: number) => String(value ?? "").slice(0, max);
/** A non-negative whole number for a wire count. */
const count = (value: unknown) => {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.trunc(number) : 0;
};
/** Linked worktree paths listed in a status; the summary's own list may be longer. */
const MAX_SKIPPED_WORKTREES = 200;
const PROGRESS_STEPS: ReadonlySet<string> = new Set([
  "listing",
  "checking-worktrees",
  "git-snapshot",
  "hashing",
]);

/** Maps the folder transfer services' errors to the wire error. */
export function folderCopyError(cause: unknown): FolderCopyError {
  if (Schema.is(FolderCopyError)(cause)) return cause;
  if (cause instanceof CopyError) {
    const detail = text(cause.message, 3000);
    return new FolderCopyError({
      code: cause.code === "cancelled" ? "refused" : cause.code,
      ...(detail ? { detail } : {}),
    });
  }
  if (cause instanceof SourceTransferError) {
    if (cause.status === 404) return new FolderCopyError({ code: "not_found" });
    if (cause.status === 401 || cause.status === 403)
      return new FolderCopyError({ code: "unauthorized" });
    if (cause.code === "conflict")
      return new FolderCopyError({
        code: "invalid",
        detail: "This copy was offered for a different project or machine.",
      });
    if (cause.status === 400)
      return new FolderCopyError({ code: "invalid", detail: text(cause.message, 3000) });
    if (cause.status === 409)
      return new FolderCopyError({ code: "refused", detail: `The copy is ${cause.code}.` });
    return new FolderCopyError({ code: "copy_failed", detail: text(cause.code, 200) });
  }
  const detail = cause instanceof Error ? text(cause.message, 3000) : "";
  return new FolderCopyError({ code: "copy_failed", ...(detail ? { detail } : {}) });
}

/** Runs a promise-returning step and maps its failure to the wire error. */
export const attempt = <A>(task: () => Promise<A>) =>
  Effect.tryPromise({ try: task, catch: folderCopyError });

/** A capped, bounded list of skipped worktree paths, or nothing when the source omitted it. */
const skippedList = <K extends string>(key: K, paths: ReadonlyArray<string> | undefined) =>
  paths
    ? ({
        [key]: paths.slice(0, MAX_SKIPPED_WORKTREES).map((path) => text(path, 4096)),
      } as Record<K, Array<string>>)
    : ({} as Partial<Record<K, Array<string>>>);

export function sourceStatus(record: SourceOperationRecord): FolderCopySourceStatus {
  return {
    copyRoot: record.folder,
    projectRelativePath: record.projectRelativePath ?? ".",
    operationId: record.operationId,
    projectId: ProjectId.make(record.projectId),
    mode: record.mode,
    state: record.state,
    summary: record.summary
      ? {
          totals: record.summary.totals,
          repositories: record.summary.repositories.map((repository) => ({
            path: text(repository.path, 4096),
            kind: repository.kind,
            head: repository.head,
            branch: repository.branch === null ? null : text(repository.branch, 1024),
            branchCount: repository.branchCount,
            stashCount: repository.stashCount,
            changedFiles: repository.changedFiles,
          })),
          secretFiles: record.summary.secretFiles.map((file) => ({
            path: text(file.path, 4096),
            size: file.size,
          })),
          linksOutside: record.summary.linksOutside,
          warnings: record.summary.warnings.map((warning) => text(warning, 2000)),
          ...(record.summary.skipped
            ? {
                skipped: {
                  rebuildableFolders: count(record.summary.skipped.rebuildableFolders),
                  worktrees: record.summary.skipped.worktrees
                    .slice(0, MAX_SKIPPED_WORKTREES)
                    .map((path) => text(path, 4096)),
                  ...skippedList("dirtyWorktrees", record.summary.skipped.dirtyWorktrees),
                  ...skippedList("uncheckedWorktrees", record.summary.skipped.uncheckedWorktrees),
                  ...skippedList("strandedWorktrees", record.summary.skipped.strandedWorktrees),
                  ...(record.summary.skipped.worktreeCount !== undefined
                    ? { worktreeCount: count(record.summary.skipped.worktreeCount) }
                    : {}),
                  ...(record.summary.skipped.dirtyCount !== undefined
                    ? { dirtyCount: count(record.summary.skipped.dirtyCount) }
                    : {}),
                },
              }
            : {}),
        }
      : null,
    ...(record.progress
      ? {
          progress: {
            files: count(record.progress.files),
            bytes: count(record.progress.bytes),
            ...(record.progress.step && PROGRESS_STEPS.has(record.progress.step)
              ? { step: record.progress.step }
              : {}),
            ...(record.progress.totalFiles !== undefined
              ? { totalFiles: count(record.progress.totalFiles) }
              : {}),
            ...(record.progress.totalBytes !== undefined
              ? { totalBytes: count(record.progress.totalBytes) }
              : {}),
          },
        }
      : {}),
    error: record.error === null ? null : text(record.error, 2000),
    releaseReason: record.releaseReason === null ? null : text(record.releaseReason, 500),
    ...(record.secrets !== undefined
      ? {
          secrets: record.secrets
            ? {
                files: record.secrets.files.map((file) => ({
                  path: text(file.path, 4096),
                  size: file.size,
                })),
                approvedAt: record.secrets.approvedAt,
                destinationLabel: text(record.secrets.destinationLabel, 200),
              }
            : null,
        }
      : {}),
  };
}

function row(planRow: Plan["rows"][number]): FolderCopyRow {
  return {
    id: planRow.id,
    kind: planRow.kind,
    path: planRow.path,
    status: planRow.status,
    detail: text(planRow.detail, 4000),
    filesToMove: planRow.filesToMove,
    bytesToMove: planRow.bytesToMove,
    bytesPresent: planRow.bytesPresent,
    choices: planRow.choices,
    decision: planRow.decision,
    needsDecision: planRow.needsDecision,
    conflicts: planRow.conflicts.slice(0, MAX_ROW_CONFLICTS).map((conflict) => ({
      id: conflict.id,
      path: conflict.path,
      reason: conflict.reason,
      choices: conflict.choices,
      decision: conflict.decision,
    })),
    moreConflicts: Math.max(0, planRow.conflicts.length - MAX_ROW_CONFLICTS),
    cloneAvailable: planRow.cloneAvailable,
    clone: planRow.clone,
    ...(planRow.replacing !== undefined ? { replacing: count(planRow.replacing) } : {}),
  };
}

/** The destination record as the browser sees it; the transfer token never leaves the server. */
export function copyStatus(record: DestinationRecord, plan: Plan | null): FolderCopyStatus {
  return {
    ...(record.copyRoot ? { copyRoot: record.copyRoot } : {}),
    projectRelativePath: record.projectRelativePath ?? ".",
    projectFolder: copiedProjectFolder(record.targetFolder, record.projectRelativePath),
    operationId: record.operationId,
    sourceEnvironmentId: EnvironmentId.make(record.sourceEnvironmentId),
    sourceProjectId: ProjectId.make(record.sourceProjectId),
    sourceMachine: text(record.sourceMachine, 200),
    mode: record.mode,
    targetFolder: record.targetFolder,
    title: text(record.title, 1000),
    selection: record.selection,
    mirror: record.mirror,
    state: record.state,
    failedStep: record.failedStep,
    error: record.error
      ? { code: record.error.code, message: text(record.error.message, 4000) }
      : null,
    progress: record.progress,
    disk: record.disk,
    rows: plan ? plan.rows.map(row) : [],
    totals: plan
      ? {
          filesToMove: plan.totals.filesToMove,
          bytesToMove: plan.totals.bytesToMove,
          bytesPresent: plan.totals.bytesPresent,
          decisionsNeeded: plan.totals.decisionsNeeded,
          // A plan saved by an older version has no count; omit it rather than show 0.
          ...(typeof plan.totals.replacing === "number"
            ? { replacing: count(plan.totals.replacing) }
            : {}),
        }
      : null,
    checks: record.checks.map((check) => ({
      repo: check.repo,
      ok: check.ok,
      problems: check.problems.map((problem) => text(problem, 4000)),
    })),
    warnings: [...record.warnings, ...(plan?.warnings ?? [])].map((warning) => text(warning, 4000)),
    unstable: record.unstable,
    committed: record.committed,
    projectId: record.projectId === null ? null : ProjectId.make(record.projectId),
    ...(record.backupsDiscardedAt ? { backupsDiscardedAt: record.backupsDiscardedAt } : {}),
    ...(record.secrets
      ? {
          secrets: record.secrets.map((file) => ({
            path: text(file.path, 4096),
            writtenAs: text(file.writtenAs, 4200),
            size: file.size,
            state: file.state,
          })),
        }
      : {}),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

export function sentSecretsResult(entries: ReadonlyArray<SentSecret>): FolderCopySentSecrets {
  return {
    entries: entries.slice(-2000).map((entry) => ({
      operationId: entry.operationId,
      destinationEnvironmentId: text(entry.destinationEnvironmentId, 200),
      destinationLabel: text(entry.destinationLabel, 200),
      folder: text(entry.folder, 4096),
      path: text(entry.path, 4096),
      size: entry.size,
      sentAt: text(entry.sentAt, 64),
    })),
  };
}

export function undoResult(
  status: FolderCopyStatus,
  preview: UndoPreview,
  result: UndoResult | null,
): FolderCopyUndoResult {
  return {
    status,
    items: preview.items.map((item) => ({
      path: item.path,
      kind: item.kind,
      state: item.state,
      detail: text(item.detail, 4000),
    })),
    edited: preview.edited,
    undone: result !== null,
    kept: result ? [...result.kept, ...result.movedToBackup] : [],
    problems: result ? result.problems.map((problem) => text(problem, 4000)) : [],
  };
}

export function offerResult(input: {
  readonly record: SourceOperationRecord;
  readonly token: string;
  readonly sourceEnvironmentId: string;
  readonly sourceUrl: string;
  readonly sourceMachine: string;
  readonly title: string;
}): FolderCopyOffer {
  return {
    copyRoot: input.record.folder,
    projectRelativePath: input.record.projectRelativePath ?? ".",
    operationId: input.record.operationId,
    sourceEnvironmentId: EnvironmentId.make(input.sourceEnvironmentId),
    sourceProjectId: ProjectId.make(input.record.projectId),
    sourceUrl: input.sourceUrl,
    sourceMachine: text(input.sourceMachine, 200),
    token: input.token,
    title: text(input.title, 1000),
    mode: input.record.mode,
    status: sourceStatus(input.record),
  };
}

/**
 * The handoff manifest for a folder copy. The copy carries the files, so the
 * manifest only names the repositories and their heads at the scan; refs are
 * never pushed. A folder that is not itself a repository gets a synthetic root
 * entry pinned to a fingerprint of the scan.
 */
export function folderCopyManifestRepositories(
  operationId: string,
  summary: SourceSummary,
): ReadonlyArray<MachineHandoffRepository> {
  const repositories: Array<MachineHandoffRepository> = [];
  const seen = new Set<string>();
  const ordered = [...summary.repositories].sort((left, right) =>
    left.path === "." ? -1 : right.path === "." ? 1 : left.path < right.path ? -1 : 1,
  );
  for (const repository of ordered) {
    if (repositories.length >= MAX_MANIFEST_REPOSITORIES) break;
    if (repository.head === null || !HEAD.test(repository.head)) continue;
    if (repository.path !== "." && !safeRelativePath(repository.path)) continue;
    if (seen.has(repository.path) || repository.path.length > 512) continue;
    seen.add(repository.path);
    repositories.push({
      relativePath: repository.path,
      identity: `folder-copy:${encodeURIComponent(repository.path)}`.slice(0, 512),
      head: repository.head,
      ref: handoffRef(operationId, repository.head),
    });
  }
  if (repositories[0]?.relativePath !== ".") {
    const head = sha256([JSON.stringify([operationId, summary.totals])], "hex").slice(0, 40);
    repositories.unshift({
      relativePath: ".",
      identity: "folder-copy:root",
      head,
      ref: handoffRef(operationId, head),
    });
    if (repositories.length > MAX_MANIFEST_REPOSITORIES) repositories.pop();
  }
  return repositories;
}

/** A stable project id for a copied folder, so a retried registration never creates two. */
export function copiedProjectId(operationId: string): ProjectId {
  const hex = sha256([`folder-copy-project:${operationId}`], "hex");
  return ProjectId.make(
    `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`,
  );
}
