import type { useCopyScope } from "./HandoffCopyScope";

/** Discovery is a hint; the destination review checks which origins it can actually read. */
export function HandoffShareRepositories({
  scope,
  machineLabel,
}: {
  readonly scope: ReturnType<typeof useCopyScope>;
  readonly machineLabel: string;
}) {
  if (scope.loading)
    return (
      <p role="status" className="text-sm text-muted-foreground">
        Checking nested repositories…
      </p>
    );
  if (scope.notice)
    return (
      <p className="text-sm text-muted-foreground">
        Nested repositories could not be checked. Review the files to transfer before continuing.
      </p>
    );
  const { repositories, repositoryOrigins, truncated } = scope.selected;
  return (
    <div
      className="space-y-2 text-sm text-muted-foreground"
      data-slot="handoff-nested-repositories"
    >
      {repositories.length > 0 ? (
        <>
          <p>This folder contains separate Git repositories:</p>
          <ul className="max-h-48 overflow-y-auto space-y-1">
            {repositories.map((path) => {
              const kind = repositoryOrigins?.find((item) => item.path === path)?.kind;
              return (
                <li key={path} className="wrap-anywhere">
                  <span className="font-medium text-foreground">{path}</span>
                  {" · "}
                  {kind === "remote"
                    ? "Clone from origin if accessible"
                    : kind === "copy"
                      ? "Copy required"
                      : "Check in transfer review"}
                </li>
              );
            })}
          </ul>
          <p>
            {machineLabel} can clone accessible origins. The review copies selected local changes
            and files Git cannot carry. Repositories without a usable origin can be copied whole.
          </p>
        </>
      ) : (
        <p>Use the transfer review to copy local files and check for repositories.</p>
      )}
      {truncated && (
        <p>
          The repository list is incomplete. The transfer review checks the selected folder again.
        </p>
      )}
    </div>
  );
}
