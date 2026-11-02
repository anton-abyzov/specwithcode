import { useEffect, useEffectEvent, useRef, useState } from "react";
import type { EnvironmentProject } from "@specweave-studio/client-runtime/state/shell";
import { squashAtomCommandFailure } from "@specweave-studio/client-runtime/state/runtime";
import {
  AuthSourceControlWriteScope,
  type ProjectNestedRepository,
  type ProjectRepositoriesReadResult,
  type ProjectRepositoryPresence,
} from "@specweave-studio/contracts";

import { projectEnvironment } from "../../state/projects";
import { useEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { copyRepositoryText, summarizeCopyRepositories } from "../../studio/projectRepositories";
import { Button } from "../ui/button";

export type RepositoryInventory =
  | { readonly status: "loading" }
  | { readonly status: "unavailable" }
  | { readonly status: "ready"; readonly result: ProjectRepositoriesReadResult };

const failureText = (cause: unknown, fallback: string) =>
  cause instanceof Error && cause.message ? cause.message : fallback;

/**
 * The checkouts inside the project folder on `source`'s machine: what every
 * other copy should hold. Read again when the page opens, so a repository
 * added to the folder since shows up without anyone listing it.
 */
export function useRepositoryInventory(
  source: EnvironmentProject | undefined,
  enabled: boolean,
): RepositoryInventory {
  const read = useAtomCommand(projectEnvironment.repositoriesRead, { reportFailure: false });
  const key = enabled && source !== undefined ? `${source.environmentId}\u0000${source.id}` : null;
  const [answer, setAnswer] = useState<{
    readonly key: string;
    readonly inventory: RepositoryInventory;
  } | null>(null);
  const load = useEffectEvent((current: string) => {
    if (source === undefined) return () => {};
    let live = true;
    void read({ environmentId: source.environmentId, input: { projectId: source.id } }).then(
      (result) => {
        if (!live) return;
        // A machine too old to list its checkouts shows nothing, as before.
        setAnswer({
          key: current,
          inventory:
            result._tag === "Failure"
              ? { status: "unavailable" }
              : { status: "ready", result: result.value },
        });
      },
    );
    return () => {
      live = false;
    };
  });
  useEffect(() => (key === null ? undefined : load(key)), [key]);
  if (key === null) return { status: "unavailable" };
  return answer?.key === key ? answer.inventory : { status: "loading" };
}

type Check =
  | { readonly status: "failed"; readonly message: string }
  | { readonly status: "ready"; readonly results: ReadonlyArray<ProjectRepositoryPresence> };

/**
 * One copy's line in Settings > Project > Machines: whether it holds the
 * project's checkouts, compared by remote, and Clone from origin for the
 * missing ones. The clone runs on that machine with its own Git credentials;
 * nothing is copied from here.
 */
export function ProjectCopyRepositories({
  copy,
  inventory,
  label,
  problem,
}: {
  readonly copy: EnvironmentProject;
  readonly inventory: RepositoryInventory;
  readonly label: string;
  /** Why that machine cannot be asked now, or null. */
  readonly problem: string | null;
}) {
  const check = useAtomCommand(projectEnvironment.repositoriesCheck, { reportFailure: false });
  // The check can clone, so that machine accepts it only from a device that may write there.
  const allowed = useEnvironmentScope(copy.environmentId, AuthSourceControlWriteScope);
  const repositories = inventory.status === "ready" ? inventory.result.repositories : null;
  const asking = allowed && problem === null && repositories !== null && repositories.length > 0;
  // An answer counts only for the list it was asked about.
  const [answer, setAnswer] = useState<{
    readonly repositories: ReadonlyArray<ProjectNestedRepository>;
    readonly check: Check;
  } | null>(null);
  const [cloning, setCloning] = useState(false);
  const generation = useRef(0);

  const ask = useEffectEvent(
    async (list: ReadonlyArray<ProjectNestedRepository>, clone: boolean) => {
      const current = ++generation.current;
      const result = await check({
        environmentId: copy.environmentId,
        input: { projectId: copy.id, repositories: list, clone },
      });
      if (current !== generation.current) return;
      setCloning(false);
      setAnswer({
        repositories: list,
        check:
          result._tag === "Failure"
            ? {
                status: "failed",
                message: failureText(
                  squashAtomCommandFailure(result),
                  `The repositories on ${label} could not be checked.`,
                ),
              }
            : { status: "ready", results: result.value.results },
      });
    },
  );
  useEffect(() => {
    if (asking && repositories !== null) void ask(repositories, false);
  }, [asking, repositories]);

  if (!asking || repositories === null) return null;
  if (answer === null || answer.repositories !== repositories)
    return <span className="block text-muted-foreground">Checking its repositories…</span>;
  if (answer.check.status === "failed")
    return (
      <span className="block text-muted-foreground" data-copy-repositories="">
        {answer.check.message}
      </span>
    );
  const summary = summarizeCopyRepositories(repositories, answer.check.results);
  return (
    <span className="block" data-copy-repositories="">
      <span className="block">{copyRepositoryText(summary)}</span>
      {summary.missing.length > 0 ? (
        <Button
          size="xs"
          variant="outline"
          className="mt-1"
          disabled={cloning}
          onClick={() => {
            setCloning(true);
            void ask(repositories, true);
          }}
        >
          {cloning ? "Cloning…" : `Clone from origin on ${label}`}
        </Button>
      ) : null}
    </span>
  );
}
