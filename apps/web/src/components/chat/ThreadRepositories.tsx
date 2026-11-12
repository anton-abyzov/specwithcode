import { useEffect, useMemo, useRef, useState } from "react";
import {
  CommandId,
  type EnvironmentId,
  type ProjectFoundRepository,
  type ProjectId,
  type ThreadId,
  type ThreadRepositories as HeldRepositories,
} from "@specweave-studio/contracts";
import { squashAtomCommandFailure } from "@specweave-studio/client-runtime/state/runtime";
import { projectWorkspace } from "../../studio/projectWorkspace";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { randomUUID } from "../../lib/utils";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import {
  addableThreadRepositories,
  threadRepositoriesLabel,
  threadRepositoryEvents,
  threadRepositoryEventText,
  threadRepositoryLine,
  threadRepositoryPullRequest,
  type ThreadRepositoryEvent,
} from "../BranchToolbar.logic";

/** What the thread's repositories need from its shell. */
export interface ThreadRepositoriesShell {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly id: ThreadId;
  readonly worktreePath: string | null;
  readonly activeRunId?: unknown;
  readonly pullRequests?:
    | ReadonlyArray<{ readonly repository: string; readonly number: number; readonly url: string }>
    | undefined;
}

/** While the agent works it may add a repository or install dependencies. */
const ACTIVE_REFRESH_MS = 8_000;

/**
 * The thread's repositories with the project's found ones, read through the
 * project's environment. Null for a thread in the project folder; `thread` is
 * absent for a plain worktree and on a server that does not report it.
 */
export function useThreadRepositories(shell: ThreadRepositoriesShell | null) {
  const enabled = shell !== null && shell.worktreePath !== null;
  const query = useEnvironmentQuery(
    enabled
      ? projectWorkspace.environmentRead({
          environmentId: shell.environmentId,
          input: { projectId: shell.projectId, discover: true, threadId: shell.id },
        })
      : null,
  );
  const active = enabled && shell.activeRunId != null;
  const { refresh } = query;
  useEffect(() => {
    if (!enabled) return;
    // Once more as the run ends, so the last add or install shows.
    if (!active) return refresh();
    const timer = setInterval(refresh, ACTIVE_REFRESH_MS);
    return () => clearInterval(timer);
  }, [active, enabled, refresh]);
  return { read: enabled ? query.data : null, refresh };
}

/** The timeline's repository rows, the same array while nothing about them changed. */
export function useThreadRepositoryEvents(
  shell: ThreadRepositoriesShell | null,
): ReadonlyArray<ThreadRepositoryEvent> | undefined {
  const { read } = useThreadRepositories(shell);
  const events = threadRepositoryEvents(read?.thread);
  const key = JSON.stringify(events);
  const stable = useRef<{ key: string; events: ReadonlyArray<ThreadRepositoryEvent> }>(null);
  if (stable.current?.key !== key) stable.current = { key, events };
  return stable.current.events.length === 0 ? undefined : stable.current.events;
}

/** "Started in its own folder with no repository." and one row per repository added. */
export function ThreadRepositoryEventRows({
  events,
}: {
  events: ReadonlyArray<ThreadRepositoryEvent>;
}) {
  return (
    <ul
      className="flex flex-col gap-1.5 text-xs text-muted-foreground"
      data-thread-repository-events=""
    >
      {events.map((event) => {
        const text = threadRepositoryEventText(event);
        return (
          <li key={event.id} className="min-w-0" data-thread-repository-event={event.kind}>
            <span className="text-foreground">
              {text.title}
              {text.name !== null && (
                <>
                  {" "}
                  <code className="rounded bg-muted px-1 py-px">{text.name}</code>
                </>
              )}
            </span>{" "}
            <span className="[overflow-wrap:anywhere]">{text.detail}</span>
          </li>
        );
      })}
    </ul>
  );
}

/** The popover's content: each repository, and "Add repository" for the ones not held. */
export function ThreadRepositoriesList({
  thread,
  found,
  pullRequests,
  adding,
  error,
  onAdd,
}: {
  thread: HeldRepositories;
  /** The project's repositories; absent on a server that does not find them (no Add). */
  found: ReadonlyArray<ProjectFoundRepository> | undefined;
  pullRequests?: ThreadRepositoriesShell["pullRequests"];
  adding: string | null;
  error: string | null;
  onAdd: (repository: ProjectFoundRepository) => void;
}) {
  const [choosing, setChoosing] = useState(false);
  const addable = addableThreadRepositories(found, thread);
  return (
    <div className="flex flex-col gap-2 text-xs" data-thread-repositories="">
      <p className="font-medium text-foreground">
        {threadRepositoriesLabel(thread.branch, thread.repositories.length)}
      </p>
      {thread.repositories.length === 0 && (
        <p className="text-muted-foreground">
          This thread has its own folder and no repository yet. The agent adds the ones it changes;
          you can add one too.
        </p>
      )}
      <ul className="flex flex-col gap-2">
        {thread.repositories.map((repository) => {
          const pullRequest = threadRepositoryPullRequest(repository, found, pullRequests);
          return (
            <li key={repository.relativePath} className="min-w-0" data-thread-repository="">
              <div className="flex items-baseline justify-between gap-2">
                <strong className="min-w-0 font-medium [overflow-wrap:anywhere]">
                  {repository.name}
                </strong>
                <span className="shrink-0 text-muted-foreground">
                  {repository.changed ? "Changed" : "No changes"}
                </span>
              </div>
              <p className="text-muted-foreground [overflow-wrap:anywhere]">
                {threadRepositoryLine(repository)}
                {pullRequest !== null && (
                  <>
                    {" · "}
                    <a
                      className="underline"
                      href={pullRequest.url}
                      target="_blank"
                      rel="noreferrer"
                    >
                      #{pullRequest.number}
                    </a>
                  </>
                )}
              </p>
            </li>
          );
        })}
      </ul>
      {thread.repositories.length > 1 && (
        <p className="text-muted-foreground">One pull request per repository with commits.</p>
      )}
      {error !== null && (
        <p className="text-destructive" role="alert">
          {error}
        </p>
      )}
      {found !== undefined &&
        (thread.repositories.length >= thread.limit ? (
          <p className="text-muted-foreground">
            A thread holds at most {thread.limit} repositories.
          </p>
        ) : addable.length === 0 ? null : choosing ? (
          <ul
            className="flex max-h-48 flex-col gap-0.5 overflow-y-auto"
            aria-label="Add repository"
          >
            {addable.map((repository) => (
              <li key={repository.relativePath}>
                <button
                  type="button"
                  className="w-full rounded px-1.5 py-1 text-left hover:bg-accent disabled:opacity-60"
                  disabled={adding !== null}
                  aria-label={`Add ${repository.name}`}
                  onClick={() => onAdd(repository)}
                >
                  {adding === repository.relativePath
                    ? `Adding ${repository.name}…`
                    : repository.name}
                  <span className="block text-muted-foreground [overflow-wrap:anywhere]">
                    {repository.relativePath}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <button
            type="button"
            className="w-fit rounded border px-2 py-1 hover:bg-accent"
            onClick={() => setChoosing(true)}
          >
            Add repository
          </button>
        ))}
    </div>
  );
}

/**
 * The thread's branch and how many repositories it holds, opening the list.
 * Renders nothing for a thread that has no folder of its own.
 */
export function ThreadRepositoriesChip({ shell }: { shell: ThreadRepositoriesShell | null }) {
  const { read, refresh } = useThreadRepositories(shell);
  const prepare = useAtomCommand(projectWorkspace.environmentPrepare, { reportFailure: false });
  const [adding, setAdding] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const thread = read?.thread;
  const label = useMemo(
    () =>
      thread === undefined
        ? null
        : threadRepositoriesLabel(thread.branch, thread.repositories.length),
    [thread],
  );
  if (shell === null || thread === undefined || label === null) return null;
  const add = async (repository: ProjectFoundRepository) => {
    setAdding(repository.relativePath);
    setError(null);
    try {
      const result = await prepare({
        environmentId: shell.environmentId,
        input: {
          projectId: shell.projectId,
          // Not read for this mode; the thread and the repository are.
          repositoryId: "thread",
          expectedRevision: 0,
          commandId: CommandId.make(randomUUID()),
          mode: "thread_add",
          threadId: shell.id,
          repository: repository.relativePath,
        },
      });
      if (result._tag === "Failure") {
        const cause = squashAtomCommandFailure(result);
        setError(cause instanceof Error ? cause.message : "The repository was not added.");
      }
    } finally {
      setAdding(null);
      refresh();
    }
  };
  return (
    <Popover>
      <PopoverTrigger
        className="inline-flex min-h-6 max-w-64 shrink items-center truncate rounded px-1.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
        aria-label={`Repositories: ${label}`}
        data-thread-repositories-chip=""
      >
        <span className="truncate">{label}</span>
      </PopoverTrigger>
      <PopoverPopup width="md" padding="compact" align="start">
        <ThreadRepositoriesList
          thread={thread}
          found={read?.found}
          pullRequests={shell.pullRequests}
          adding={adding}
          error={error}
          onAdd={(repository) => void add(repository)}
        />
      </PopoverPopup>
    </Popover>
  );
}
