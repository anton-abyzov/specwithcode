import { ProjectLocation } from "./ProjectLocation";
import { useEffect, useId, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import {
  CommandId,
  projectRepositoryIdentity,
  type ProjectEnvironmentEntryRef,
  type ProjectFoundRepository,
  type ProjectWorkspaceReadResult,
} from "@specweave-studio/contracts";
import type { EnvironmentProject } from "@specweave-studio/client-runtime/state/shell";
import { squashAtomCommandFailure } from "@specweave-studio/client-runtime/state/runtime";
import { projectWorkspace } from "../../studio/projectWorkspace";
import { useMachineNickname } from "../../studio/machineNickname";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { randomUUID } from "../../lib/utils";
import { CharacterCount } from "../ui/character-count";
import { ProjectRepositoryList } from "./ProjectRepositoryList";
import {
  entryMatchesFolder,
  entryMatchesRepository,
  environmentFieldErrorCount,
} from "./projectEnvironmentDraft";
import {
  cloneFolderError,
  defaultCloneFolder,
  insideProjectFolder,
  olderServerLine,
  resolveCloneFolder,
} from "./projectRepositoryRows.logic";

type EnvironmentDraft = ProjectWorkspaceReadResult["settings"]["environment"];
/** A clone or match to run once the entry it needs is saved. */
type PendingPreparation = { readonly id: string; readonly mode: "clone" | "match" };

export function ProjectEnvironment({
  project,
  projectKey,
  kind,
  value,
  revision,
  dirty,
  disabled,
  admissionBlocked,
  navigationBlocked,
  onChange,
  onPrepared,
  onDraftChange,
  onBusyChange,
  entryError = null,
  onFieldErrorsChange,
  resetKey = 0,
  onOpenGeneral,
}: {
  project: EnvironmentProject;
  projectKey: string;
  kind: "code" | "personal";
  value: EnvironmentDraft;
  revision: number;
  dirty: boolean;
  disabled: boolean;
  admissionBlocked: boolean;
  navigationBlocked: boolean;
  onChange: (value: EnvironmentDraft) => void;
  onPrepared: (revision: number, value: EnvironmentDraft) => void;
  onDraftChange: (dirty: boolean) => void;
  onBusyChange: (busy: boolean) => void;
  /** A rejected save that named one entry: shown beside that entry. */
  entryError?: { readonly entry: ProjectEnvironmentEntryRef; readonly message: string } | null;
  /** How many entries have a field that cannot be saved as typed. */
  onFieldErrorsChange?: (count: number, urlEditOpen: boolean) => void;
  /** Changes on Discard, which keeps the same revision, to drop open edits. */
  resetKey?: number;
  /** Opens the General tab, where the Use worktrees switch is. */
  onOpenGeneral?: () => void;
}) {
  const countId = useId();
  // "Check again" walks the folder anew; until then the server's shared list is used.
  const [recheck, setRecheck] = useState(false);
  const query = useEnvironmentQuery(
    projectWorkspace.environmentRead({
      environmentId: project.environmentId,
      input: { projectId: project.id, discover: true, ...(recheck ? { refresh: true } : {}) },
    }),
  );
  const prepare = useAtomCommand(projectWorkspace.environmentPrepare);
  const machine = useMachineNickname(project.environmentId) || project.environmentId;
  const [url, setUrl] = useState("");
  const [cloneFolder, setCloneFolder] = useState<string | null>(null);
  const [folder, setFolder] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [uncertainKey, setUncertainKey] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingPreparation | null>(null);
  const sectionRef = useRef<HTMLElement>(null);
  const inFlight = useRef(false);
  const requests = useRef(new Map<string, string>());
  useEffect(() => {
    query.refresh();
  }, [revision, query.refresh]);
  // Discard drops an entry waiting to be cloned with it.
  useEffect(() => setPending(null), [resetKey]);
  const fieldErrors = environmentFieldErrorCount(value);
  useEffect(() => {
    onFieldErrorsChange?.(fieldErrors, false);
  }, [fieldErrors, onFieldErrorsChange]);
  // Bring the entry a save rejected into view.
  useEffect(() => {
    if (!entryError) return;
    const key =
      entryError.entry.kind === "repository"
        ? `repository:${entryError.entry.repositoryId ?? ""}`
        : `folder:${entryError.entry.path}`;
    const target = [
      ...(sectionRef.current?.querySelectorAll<HTMLElement>("[data-entry-key]") ?? []),
    ].find((element) => element.dataset.entryKey === key);
    target?.scrollIntoView?.({ block: "center" });
    target?.querySelector<HTMLElement>("input, button")?.focus({ preventScroll: true });
  }, [entryError]);
  useEffect(() => {
    onDraftChange(Boolean(url || folder));
  }, [url, folder, onDraftChange]);
  const blocked = disabled || busy !== null;
  const read = query.data;
  const found = read?.found;
  const problems = read?.problems ?? [];
  const folderProblem = (path: string) =>
    problems.find((problem) => problem.kind === "folder" && problem.path === path);
  /** Re-point a moved folder and every checkout saved inside it. Save still re-checks it. */
  const repoint = (from: string, to: string) => {
    const moved = (localPath: string | null) => {
      if (localPath === null) return null;
      const rest = localPath.slice(from.length);
      return localPath === from || (localPath.startsWith(from) && /^[\\/]/.test(rest))
        ? `${to}${rest}`
        : localPath;
    };
    onChange({
      additionalFolders: value.additionalFolders.includes(to)
        ? value.additionalFolders.filter((path) => path !== from)
        : value.additionalFolders.map((path) => (path === from ? to : path)),
      repositories: value.repositories.map((repository) => ({
        ...repository,
        localPath: moved(repository.localPath),
      })),
    });
  };
  const removeRepositories = (ids: ReadonlyArray<string>) =>
    onChange({
      ...value,
      repositories: value.repositories.filter((repository) => !ids.includes(repository.id)),
    });
  async function run(repositoryId: string, mode: "clone" | "match") {
    if (blocked || admissionBlocked || dirty || inFlight.current) return;
    inFlight.current = true;
    setBusy(repositoryId);
    onBusyChange(true);
    setError(null);
    const key = `${revision}:${repositoryId}:${mode}`;
    const commandId = requests.current.get(key) ?? randomUUID();
    requests.current.set(key, commandId);
    try {
      const result = await prepare({
        environmentId: project.environmentId,
        input: {
          projectId: project.id,
          repositoryId,
          expectedRevision: revision,
          commandId: CommandId.make(commandId),
          mode,
        },
      });
      if (result._tag === "Failure") {
        const cause = squashAtomCommandFailure(result);
        if (
          cause &&
          typeof cause === "object" &&
          "code" in cause &&
          (cause.code === "outcome_unknown" || cause.code === "preparation_failed")
        )
          setUncertainKey(key);
        setError(
          cause instanceof Error
            ? cause.message
            : "The clone was not confirmed. Your saved configuration is unchanged.",
        );
      } else {
        requests.current.delete(key);
        setUncertainKey(null);
        onPrepared(result.value.revision, {
          additionalFolders: result.value.additionalFolders,
          repositories: result.value.repositories.map(({ id, url, localPath }) => ({
            id,
            url,
            localPath,
          })),
        });
        query.refresh();
      }
    } catch {
      setUncertainKey(key);
      setError(
        "The host did not confirm this request. Retry checks the same request; it does not overwrite a checkout.",
      );
    } finally {
      inFlight.current = false;
      setBusy(null);
      onBusyChange(false);
    }
  }
  // An entry added here is cloned (or matched) as soon as it is saved with the project.
  const pendingSaved =
    pending !== null &&
    !dirty &&
    (read?.repositories.some((repository) => repository.id === pending.id) ?? false);
  useEffect(() => {
    if (!pendingSaved || pending === null || blocked || admissionBlocked) return;
    setPending(null);
    void run(pending.id, pending.mode);
    // `run` reads the latest state; only the saved entry starts it.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingSaved]);
  /** Save an entry for `repositoryUrl` at `localPath`, then clone or match it there. */
  const addEntry = (repositoryUrl: string, localPath: string, mode: "clone" | "match") => {
    const id = randomUUID();
    onChange({
      ...value,
      repositories: [...value.repositories, { id, url: repositoryUrl, localPath }],
    });
    setPending({ id, mode });
  };
  const cloneRow = (row: ProjectFoundRepository) => {
    if (row.repositoryId !== undefined) return void run(row.repositoryId, "clone");
    // SpecWeave lists it and nothing is saved: save it at the listed folder, then clone.
    if (row.origin !== null) addEntry(`https://github.com/${row.origin}.git`, row.path, "clone");
  };
  const urlIdentity = projectRepositoryIdentity(url.trim());
  const duplicateUrl =
    urlIdentity !== null &&
    value.repositories.some((r) => projectRepositoryIdentity(r.url) === urlIdentity);
  const typedFolder = cloneFolder ?? defaultCloneFolder(url, found ?? []);
  const folderError = url.trim() === "" ? null : cloneFolderError(typedFolder);
  const cannotAdd =
    blocked ||
    urlIdentity === null ||
    duplicateUrl ||
    folderError !== null ||
    value.repositories.length >= 32;
  const submitAdd = (mode: "clone" | "match") => {
    addEntry(url.trim(), resolveCloneFolder(project.workspaceRoot, typedFolder), mode);
    setUrl("");
    setCloneFolder(null);
  };
  // Open only when there is nothing to show: no repository saved and none in the folder.
  const nothingYet =
    read !== null &&
    value.repositories.length === 0 &&
    (found?.length ?? 0) === 0 &&
    read.rootIsRepository !== true;
  const manageWorktrees = navigationBlocked ? (
    <button className="project-text-link" disabled>
      Manage thread worktrees
    </button>
  ) : (
    <Link
      className="project-text-link"
      to="/settings/projects"
      search={{ project: projectKey, machine: project.environmentId }}
    >
      Manage thread worktrees
    </Link>
  );
  return (
    <section className="project-settings-section" ref={sectionRef}>
      <h2>Environment</h2>
      <p className="project-muted">
        {kind === "personal"
          ? "Personal work uses private, app-managed storage on this machine. Git is optional."
          : "What this project's threads can reach on this machine: the repositories in its folder and any other folder you allow."}
      </p>
      {admissionBlocked && (
        <p className="project-notice">
          Resume or restore this project before cloning a repository.
        </p>
      )}
      <dl className="project-environment">
        <dt>{kind === "personal" ? "Managed project storage" : "Project folder"}</dt>
        <dd>
          <ProjectLocation path={project.workspaceRoot} />
        </dd>
        <dt>Machine</dt>
        <dd>{machine}</dd>
      </dl>
      {error && (
        <p className="project-notice" role="alert">
          {error}
        </p>
      )}
      {uncertainKey && (
        <div className="project-notice">
          <p>
            The previous clone may have changed files. Inspect the destination before permitting a
            new request.
          </p>
          <button
            className="project-control"
            disabled={blocked || admissionBlocked || dirty}
            onClick={() => {
              requests.current.delete(uncertainKey);
              setUncertainKey(null);
              setError(null);
            }}
          >
            I inspected the destination; allow a new request
          </button>
        </div>
      )}
      <section className="project-environment-section">
        <h3>Repositories</h3>
        {query.error && <p role="alert">The repository list is unavailable: {query.error}</p>}
        {read !== null && found !== undefined && (
          <ProjectRepositoryList
            read={read}
            saved={value.repositories}
            useWorktrees={kind === "personal" ? null : project.defaultThreadEnvMode === "worktree"}
            disabled={blocked}
            cloneDisabled={blocked || admissionBlocked || dirty}
            busyKey={busy}
            checking={query.isPending}
            onCheckAgain={() => {
              if (recheck) query.refresh();
              else setRecheck(true);
            }}
            onClone={cloneRow}
            onRemove={removeRepositories}
            onOpenGeneral={onOpenGeneral}
            manageWorktrees={manageWorktrees}
          />
        )}
        {navigationBlocked && (
          <p className="project-muted">
            Save or discard your drafts and finish pending operations before opening thread
            worktrees.
          </p>
        )}
        {read !== null && found === undefined && (
          // An older server finds nothing in the folder: its saved repositories, and what to do.
          <div data-older-server="">
            <p className="project-notice">{olderServerLine(machine)}</p>
            {manageWorktrees}
            {value.repositories.map((repository) => (
              <div
                className="project-environment-entry"
                key={repository.id}
                data-entry-key={`repository:${repository.id}`}
              >
                <code>{repository.url}</code>
                <button
                  className="project-control"
                  disabled={blocked}
                  aria-label={`Remove repository ${repository.url}`}
                  onClick={() => removeRepositories([repository.id])}
                >
                  Remove from project
                </button>
              </div>
            ))}
            {value.repositories.length === 0 && (
              <p className="project-muted">No repository is saved for this project.</p>
            )}
          </div>
        )}
        {read === null && !query.error && <p className="project-muted">Reading the folder…</p>}
        {problems
          .filter((problem) => problem.kind === "repository")
          .map((problem) => (
            <div
              className="project-environment-entry"
              key={`${problem.repositoryId ?? ""}:${problem.path}`}
              data-entry-key={`repository:${problem.repositoryId ?? ""}`}
            >
              <p className="project-muted" role="status">
                {problem.message}
              </p>
              {problem.updatePath !== undefined && problem.repositoryId !== undefined && (
                <button
                  className="project-control"
                  disabled={blocked}
                  onClick={() =>
                    onChange({
                      ...value,
                      repositories: value.repositories.map((repository) =>
                        repository.id === problem.repositoryId
                          ? { ...repository, localPath: problem.updatePath! }
                          : repository,
                      ),
                    })
                  }
                >
                  Update path
                </button>
              )}
            </div>
          ))}
        {entryError?.entry.kind === "repository" &&
          value.repositories.some((repository) =>
            entryMatchesRepository(entryError.entry, repository.id),
          ) && (
            <p
              className="project-field-error"
              role="alert"
              data-entry-key={`repository:${entryError.entry.repositoryId ?? ""}`}
            >
              {entryError.message}
            </p>
          )}
        {pending !== null && dirty && (
          <p className="project-notice" role="status">
            Save changes to {pending.mode === "clone" ? "clone it" : "use that checkout"}.
          </p>
        )}
        <details className="project-repository-add" open={nothingYet || url !== ""}>
          <summary>Add a repository that is not in this folder</summary>
          <label>
            Git URL
            <input
              value={url}
              maxLength={2048}
              aria-describedby={countId}
              disabled={blocked}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://github.com/organization/repository.git"
              autoComplete="off"
            />
            <CharacterCount id={countId} value={url} max={2048} />
          </label>
          <label>
            Folder
            <input
              value={typedFolder}
              disabled={blocked}
              aria-invalid={folderError !== null}
              onChange={(e) => setCloneFolder(e.target.value)}
              placeholder="repositories/organization/repository"
              autoComplete="off"
            />
          </label>
          <p className="project-muted">
            The folder is inside the project folder unless you type a full path. Git on this machine
            signs in; the app stores no password.
          </p>
          {url.trim() && urlIdentity === null && (
            <p className="project-field-error" role="alert">
              Use a credential-free HTTPS or SSH repository URL, without a query or fragment.
            </p>
          )}
          {duplicateUrl && (
            <p className="project-field-error" role="alert">
              This repository is already saved for the project.
            </p>
          )}
          {urlIdentity !== null && folderError !== null && (
            <p className="project-field-error" role="alert">
              {folderError}
            </p>
          )}
          <div className="project-actions">
            <button
              className="project-control"
              disabled={cannotAdd}
              onClick={() => submitAdd("clone")}
            >
              Clone
            </button>
            <button
              className="project-control"
              disabled={cannotAdd}
              onClick={() => submitAdd("match")}
            >
              It is already checked out there
            </button>
          </div>
        </details>
        <p className="project-muted">
          Removing an entry from the project deletes no files and no remote repository. Threads that
          use it keep their checkout.
        </p>
      </section>
      <section className="project-environment-section">
        <h3>Other folders agents can use</h3>
        <p className="project-muted">
          Folders outside the project folder that new work may read and change on this machine.
          Provider permissions still apply.
        </p>
        {value.additionalFolders.map((path) => {
          const problem = folderProblem(path);
          const saveError = entryMatchesFolder(entryError?.entry, path) ? entryError : null;
          const inside = insideProjectFolder(project.workspaceRoot, path);
          return (
            <div key={path} data-entry-key={`folder:${path}`}>
              <div className="project-environment-entry">
                <ProjectLocation path={path} />
                {problem?.updatePath !== undefined && (
                  <button
                    className="project-control"
                    disabled={blocked}
                    aria-label={`Update folder ${path} to ${problem.updatePath}`}
                    onClick={() => repoint(path, problem.updatePath!)}
                  >
                    Update path
                  </button>
                )}
                <button
                  className="project-control"
                  disabled={blocked}
                  aria-label={`Remove folder ${path}`}
                  onClick={() =>
                    onChange({
                      ...value,
                      additionalFolders: value.additionalFolders.filter((p) => p !== path),
                    })
                  }
                >
                  Remove
                </button>
              </div>
              {inside && (
                <p className="project-muted" data-inside-project="">
                  Already inside the project folder, so this entry does nothing.
                </p>
              )}
              {problem && (
                <p className="project-muted" role="status">
                  {problem.message}
                  {problem.updatePath !== undefined &&
                    " It is a checkout of the same repository, so Update path can point the entry there."}
                </p>
              )}
              {saveError && (
                <p className="project-field-error" role="alert">
                  {saveError.message}
                </p>
              )}
            </div>
          );
        })}
        {value.additionalFolders.length === 0 && (
          <p className="project-muted">No other folder is allowed.</p>
        )}
        <label>
          Folder path
          <input
            value={folder}
            disabled={blocked}
            onChange={(e) => setFolder(e.target.value)}
            placeholder="Absolute path on this machine"
          />
        </label>
        <button
          className="project-control"
          disabled={
            blocked ||
            !folder.trim() ||
            value.additionalFolders.length >= 16 ||
            value.additionalFolders.includes(folder.trim())
          }
          onClick={() => {
            onChange({ ...value, additionalFolders: [...value.additionalFolders, folder.trim()] });
            setFolder("");
          }}
        >
          Add folder
        </button>
      </section>
    </section>
  );
}
