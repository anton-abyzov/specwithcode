import { useSyncExternalStore } from "react";
import { useTx } from "../../i18n";
import type {
  EnvironmentId,
  ProjectFoundRepository,
  ThreadEnvMode,
} from "@specweave-studio/contracts";
import { useEnvironmentQuery } from "../../state/query";
import { vcsEnvironment } from "../../state/vcs";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import {
  AGENT_DECIDES,
  composerRepositoriesLabel,
  composerRepositoryPicks,
  toggleComposerRepository,
  type ComposerRepositoryPick,
} from "../BranchToolbar.logic";

/** The composer's pick for a draft; "Agent decides" until the person checks a repository. */
export function useComposerRepositoryPick(threadId: string): ComposerRepositoryPick {
  return useSyncExternalStore(composerRepositoryPicks.subscribe, () =>
    composerRepositoryPicks.get(threadId),
  );
}

/** The branches of the one picked repository, to start its worktree from. */
function BaseBranchPicker({
  environmentId,
  repository,
  value,
  onChange,
}: {
  environmentId: EnvironmentId;
  repository: ProjectFoundRepository;
  value: string | null;
  onChange: (branch: string) => void;
}) {
  const refs = useEnvironmentQuery(
    vcsEnvironment.listRefs({
      environmentId,
      input: { cwd: repository.path, refKind: "local", limit: 100 },
    }),
  );
  const names = new Set((refs.data?.refs ?? []).map((ref) => ref.name));
  if (value !== null) names.add(value);
  if (names.size === 0) return null;
  return (
    <label className="flex items-center justify-between gap-2 border-t pt-2 text-xs">
      <span className="text-muted-foreground">Base branch</span>
      <select
        aria-label={`Base branch of ${repository.name}`}
        className="min-w-0 max-w-44 rounded border bg-transparent px-1 py-0.5"
        value={value ?? ""}
        onChange={(event) => onChange(event.target.value)}
      >
        {value === null && <option value="">Default</option>}
        {[...names].map((name) => (
          <option key={name} value={name}>
            {name}
          </option>
        ))}
      </select>
    </label>
  );
}

/** "Repositories": the agent decides, or any checked set of the folder's repositories. */
export function ComposerRepositoriesControl({
  environmentId,
  found,
  pick,
  onChange,
}: {
  environmentId: EnvironmentId;
  found: ReadonlyArray<ProjectFoundRepository>;
  pick: ComposerRepositoryPick;
  onChange: (pick: ComposerRepositoryPick) => void;
}) {
  const only =
    pick.repositories.length === 1
      ? (found.find((row) => row.relativePath === pick.repositories[0]) ?? null)
      : null;
  return (
    <Popover>
      <PopoverTrigger
        render={
          <button
            type="button"
            className="inline-flex min-h-7 max-w-56 shrink items-center gap-1 truncate rounded px-1.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
            data-composer-repositories=""
          />
        }
      >
        <span className="truncate">{composerRepositoriesLabel(pick, found)}</span>
        <span aria-hidden>▾</span>
      </PopoverTrigger>
      <PopoverPopup width="sm" padding="compact" align="start" side="top">
        <div className="flex flex-col gap-1 text-xs" role="group" aria-label="Repositories">
          <label className="flex cursor-pointer items-center gap-2 rounded px-1 py-1 hover:bg-accent">
            <input
              type="radio"
              className="accent-primary"
              checked={pick.repositories.length === 0}
              onChange={() => onChange(AGENT_DECIDES)}
            />
            <span>
              Agent decides
              <span className="block text-muted-foreground">
                It adds the repositories the task changes.
              </span>
            </span>
          </label>
          <div className="flex max-h-56 flex-col overflow-y-auto">
            {found.map((row) => (
              <label
                key={row.relativePath}
                className="flex cursor-pointer items-center gap-2 rounded px-1 py-1 hover:bg-accent"
              >
                <input
                  type="checkbox"
                  className="size-3.5 accent-primary"
                  checked={pick.repositories.includes(row.relativePath)}
                  onChange={() => onChange(toggleComposerRepository(pick, row.relativePath, found))}
                />
                <span className="min-w-0 truncate">{row.name}</span>
              </label>
            ))}
          </div>
          {only !== null && (
            <BaseBranchPicker
              environmentId={environmentId}
              repository={only}
              value={pick.baseBranch}
              onChange={(baseBranch) => onChange({ ...pick, baseBranch })}
            />
          )}
          <p className="text-muted-foreground">Holds for this message only.</p>
        </div>
      </PopoverPopup>
    </Popover>
  );
}

/** An explicit per-chat choice. Never rewrites a saved current-checkout choice. */
export function WorkspaceModeControl({
  mode,
  onChange,
  disabled = false,
  repositories,
}: {
  mode: ThreadEnvMode;
  onChange: (mode: ThreadEnvMode) => void;
  disabled?: boolean;
  /** In a project folder of separate clones: which repositories the thread starts with. */
  repositories?:
    | {
        readonly environmentId: EnvironmentId;
        readonly found: ReadonlyArray<ProjectFoundRepository>;
        readonly pick: ComposerRepositoryPick;
        readonly onChange: (pick: ComposerRepositoryPick) => void;
      }
    | undefined;
}) {
  const tx = useTx();
  return (
    <>
      <label className="inline-flex min-h-7 shrink-0 cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
        <input
          type="checkbox"
          aria-label={tx("Use worktree")}
          checked={mode === "worktree"}
          disabled={disabled}
          onChange={(event) => onChange(event.target.checked ? "worktree" : "local")}
          className="size-3.5 accent-primary"
        />
        <span>{mode === "worktree" ? tx("Use worktree") : tx("Current checkout")}</span>
      </label>
      {mode === "worktree" && repositories !== undefined && repositories.found.length > 0 && (
        <ComposerRepositoriesControl {...repositories} />
      )}
    </>
  );
}
