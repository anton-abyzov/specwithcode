import {
  ProjectId,
  type EnvironmentId,
  type FolderCopyLeftBehind,
} from "@specweave-studio/contracts";
import { useEffect, useState } from "react";
import { useAtomCommand } from "../../state/use-atom-command";
import { machineHandoff } from "../../studio/machineHandoff";

const plural = (count: number, one: string, many = `${one}s`) =>
  `${count} ${count === 1 ? one : many}`;

type Repository = FolderCopyLeftBehind["repositories"][number];

/** One repository's line: what a move would leave behind on the source. */
export function leftBehindLine(repository: Repository): string {
  const parts: Array<string> = [];
  if (repository.unpushedCommits === null)
    parts.push(`${repository.branch ?? "current checkout"} has no upstream`);
  else if (repository.unpushedCommits > 0)
    parts.push(
      `${plural(repository.unpushedCommits, "unpushed commit")} on ${repository.branch ?? "this checkout"}`,
    );
  if (repository.uncommittedChanges > 0)
    parts.push(plural(repository.uncommittedChanges, "uncommitted change"));
  if (repository.branchesAhead > 0)
    parts.push(`${plural(repository.branchesAhead, "other branch", "other branches")} ahead`);
  if (repository.branchesWithoutUpstream > 0)
    parts.push(
      plural(repository.branchesWithoutUpstream, "local-only branch", "local-only branches"),
    );
  return parts.join(", ");
}

/**
 * Before a move: work Git cannot carry stays on this machine. It never blocks the move;
 * the person decides whether to push or copy it first. Says nothing while it cannot read
 * the list, such as from a source on an older version.
 */
export function HandoffLeftBehind({
  environmentId,
  projectId,
  sourceLabel,
}: {
  readonly environmentId: EnvironmentId;
  readonly projectId: string;
  readonly sourceLabel: string;
}) {
  const read = useAtomCommand(machineHandoff.copyLeftBehind, { reportFailure: false });
  const [repositories, setRepositories] = useState<ReadonlyArray<Repository>>([]);
  useEffect(() => {
    let stale = false;
    void Promise.resolve(
      read({ environmentId, input: { projectId: ProjectId.make(projectId) } }),
    ).then(
      (result) => {
        if (!stale && result._tag === "Success") setRepositories(result.value?.repositories ?? []);
      },
      () => undefined,
    );
    return () => {
      stale = true;
    };
    // The command is stable; only the project decides what to read.
  }, [environmentId, projectId]);
  if (repositories.length === 0) return null;
  return (
    <details className="rounded-md border p-3 text-sm" data-slot="handoff-left-behind">
      <summary className="cursor-pointer">
        {plural(repositories.length, "repository keeps", "repositories keep")} work on {sourceLabel}{" "}
        that Git won't carry
      </summary>
      <ul className="mt-2 space-y-1 text-xs text-muted-foreground">
        {repositories.map((repository) => (
          <li key={repository.path} className="wrap-anywhere">
            <span className="font-medium text-foreground">{repository.name}</span>:{" "}
            {leftBehindLine(repository)}
          </li>
        ))}
      </ul>
      <p className="mt-2 text-xs text-muted-foreground">
        Push it first, or use Copy local files. The move goes ahead either way.
      </p>
    </details>
  );
}
