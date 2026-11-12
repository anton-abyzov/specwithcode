import type {
  ProjectEnvironmentReadResult,
  ProjectFoundRepository,
} from "@specweave-studio/contracts";
import { ProjectLocation } from "./ProjectLocation";
import {
  absentRowHint,
  orderedRows,
  redundantEntriesLine,
  repositoriesLead,
  repositoryRowStatus,
  repositoryRowSummary,
  skippedLinkLine,
  WORKTREES_OFF_LINE,
} from "./projectRepositoryRows.logic";

/**
 * Environment > Repositories: a read-only list of what the project's threads
 * can use. Nothing here is registered or picked; a row gets a button only
 * where something needs cloning or a saved entry can go.
 */
export function ProjectRepositoryList({
  read,
  saved,
  useWorktrees,
  disabled,
  cloneDisabled = disabled,
  busyKey,
  checking,
  onCheckAgain,
  onClone,
  onRemove,
  onOpenGeneral,
  manageWorktrees,
}: {
  read: ProjectEnvironmentReadResult;
  /** The saved entries, for the names of the ones no longer needed. */
  saved: ReadonlyArray<{ readonly id: string; readonly url: string }>;
  /** The project's Use worktrees switch; null when it is not known here. */
  useWorktrees: boolean | null;
  disabled: boolean;
  /** Cloning also waits for unsaved changes; removing an entry does not. */
  cloneDisabled?: boolean;
  /** The row being cloned now (its relative path). */
  busyKey: string | null;
  checking: boolean;
  onCheckAgain: () => void;
  onClone: (row: ProjectFoundRepository) => void;
  onRemove: (repositoryIds: ReadonlyArray<string>) => void;
  onOpenGeneral?: (() => void) | undefined;
  /** The link to "Manage thread worktrees", owned by the page. */
  manageWorktrees?: React.ReactNode;
}) {
  const rows = orderedRows(read.found ?? []);
  const redundant = redundantEntriesLine(read.redundantEntries ?? [], saved);
  const skipped = read.skippedLinks ?? [];
  return (
    <div data-repository-list="">
      <div className="project-repository-lead">
        <p className="project-muted">{repositoriesLead(read)}</p>
        <div className="project-actions">
          <button className="project-control" disabled={checking} onClick={onCheckAgain}>
            {checking ? "Checking…" : "Check again"}
          </button>
          {manageWorktrees}
        </div>
      </div>
      {useWorktrees === false && (
        <p className="project-notice" data-worktrees-off="">
          {WORKTREES_OFF_LINE}{" "}
          {onOpenGeneral && (
            <button className="project-text-link" onClick={onOpenGeneral}>
              Open General
            </button>
          )}
        </p>
      )}
      {rows.length > 0 && (
        <ul className="project-repository-rows">
          {rows.map((row) => {
            const status = repositoryRowStatus(row);
            const key = row.repositoryId ?? row.relativePath;
            const busy = busyKey === key;
            return (
              <li key={key} className="project-repository-row" data-repository-state={row.state}>
                <div className="project-repository-row-head">
                  <strong>{row.name}</strong>
                  {row.inSpecweave && <span className="project-repository-tag">SpecWeave</span>}
                  <span
                    className="project-repository-status"
                    data-tone={status.tone}
                    aria-label={`${row.name}: ${status.label}`}
                  >
                    {busy ? "Cloning…" : status.label}
                  </span>
                  {status.actions.includes("clone") && (
                    <button
                      className="project-control"
                      disabled={cloneDisabled || busy}
                      aria-label={`Clone ${row.name}`}
                      onClick={() => onClone(row)}
                    >
                      Clone
                    </button>
                  )}
                  {status.actions.includes("clone_again") && (
                    <button
                      className="project-control"
                      disabled={cloneDisabled || busy}
                      aria-label={`Clone ${row.name} again`}
                      onClick={() => onClone(row)}
                    >
                      Clone again
                    </button>
                  )}
                  {status.actions.includes("remove") && row.repositoryId !== undefined && (
                    <button
                      className="project-control"
                      disabled={disabled || busy}
                      aria-label={`Remove ${row.name} from project`}
                      onClick={() => onRemove([row.repositoryId!])}
                    >
                      Remove from project
                    </button>
                  )}
                </div>
                <p className="project-muted project-repository-summary">
                  {repositoryRowSummary(row)}
                  {status.note !== null && ` · ${status.note}`}
                </p>
                {row.state === "absent" && <p className="project-muted">{absentRowHint(row)}</p>}
                {row.state === "missing" && (
                  <p className="project-muted">
                    Its folder is gone. Clone it again, or remove it from the project. Threads that
                    use it keep their checkout.
                  </p>
                )}
                {status.actions.includes("details") && (
                  <details className="project-repository-details">
                    <summary aria-label={`Details of ${row.name}`}>Details</summary>
                    <dl>
                      <dt>Folder</dt>
                      <dd>
                        <ProjectLocation path={row.path} />
                      </dd>
                      <dt>Pulls from</dt>
                      <dd>{row.origin ?? "No remote"}</dd>
                      <dt>Branch</dt>
                      <dd>
                        {row.branch ?? "No branch checked out"}
                        {row.branch === null &&
                          row.defaultBranch !== null &&
                          `; worktrees start from origin/${row.defaultBranch}`}
                      </dd>
                      <dt>Thread worktrees</dt>
                      <dd>{row.threadWorktrees}</dd>
                    </dl>
                  </details>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {(read.foundMore ?? 0) > 0 && (
        <p className="project-muted">
          and {read.foundMore} more.
          {read.foundTruncated === true && " The search stopped early in this large folder."}
        </p>
      )}
      {skipped.length > 0 && (
        <p className="project-muted" data-skipped-links="">
          Skipped:{" "}
          {skipped.map((link, index) => {
            const line = skippedLinkLine(link);
            return (
              <span key={link.path}>
                {index > 0 && " "}
                <code>{line.name}</code> {line.rest}
              </span>
            );
          })}
        </p>
      )}
      {redundant !== null && (
        <div className="project-environment-entry" data-redundant-entries="">
          <p className="project-muted">{redundant.text}</p>
          <button
            className="project-control"
            disabled={disabled}
            onClick={() => onRemove(redundant.ids)}
          >
            {redundant.button}
          </button>
        </div>
      )}
    </div>
  );
}
