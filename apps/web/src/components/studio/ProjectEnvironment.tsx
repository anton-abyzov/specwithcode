import { ProjectLocation } from "./ProjectLocation";
import { useEffect, useId, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import {
  CommandId,
  projectRepositoryIdentity,
  type ProjectEnvironmentEntryRef,
  type ProjectWorkspaceReadResult,
} from "@specweave-studio/contracts";
import type { EnvironmentProject } from "@specweave-studio/client-runtime/state/shell";
import { squashAtomCommandFailure } from "@specweave-studio/client-runtime/state/runtime";
import { projectWorkspace } from "../../studio/projectWorkspace";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { randomUUID } from "../../lib/utils";
import { CharacterCount } from "../ui/character-count";
import { ProjectEnvironmentImport } from "./ProjectEnvironmentImport";
import {
  checkoutPathError,
  entryMatchesFolder,
  entryMatchesRepository,
  environmentFieldErrorCount,
  originUpdateFor,
  repositoryShortName,
  repositoryUrlError,
} from "./projectEnvironmentDraft";

type EnvironmentDraft = ProjectWorkspaceReadResult["settings"]["environment"];
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
  onFieldErrorsChange?: (count: number) => void;
}) {
  const countId = useId();
  const query = useEnvironmentQuery(
    projectWorkspace.environmentRead({
      environmentId: project.environmentId,
      input: { projectId: project.id },
    }),
  );
  const prepare = useAtomCommand(projectWorkspace.environmentPrepare);
  const previewImport = useAtomCommand(projectWorkspace.environmentImportPreview, {
    reportFailure: false,
  });
  const importWorkspace = useAtomCommand(projectWorkspace.environmentImport, {
    reportFailure: false,
  });
  const [url, setUrl] = useState("");
  const [folder, setFolder] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [uncertainKey, setUncertainKey] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  // URL edits in progress and what each entry held before, for Cancel and "was".
  const [editingUrl, setEditingUrl] = useState<{ id: string; value: string } | null>(null);
  const [urlBefore, setUrlBefore] = useState<ReadonlyMap<string, string>>(new Map());
  const [pathBefore, setPathBefore] = useState<ReadonlyMap<string, string | null>>(new Map());
  const sectionRef = useRef<HTMLElement>(null);
  const inFlight = useRef(false);
  const requests = useRef(new Map<string, string>());
  useEffect(() => {
    query.refresh();
  }, [revision, query.refresh]);
  // A save or Discard starts a new baseline.
  useEffect(() => {
    setEditingUrl(null);
    setUrlBefore(new Map());
    setPathBefore(new Map());
  }, [revision]);
  const fieldErrors = environmentFieldErrorCount(value);
  useEffect(() => {
    onFieldErrorsChange?.(fieldErrors);
  }, [fieldErrors, onFieldErrorsChange]);
  // Bring the entry a save rejected into view, with its field focused.
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
  const setRepository = (
    id: string,
    update: (
      repository: EnvironmentDraft["repositories"][number],
    ) => Partial<EnvironmentDraft["repositories"][number]>,
  ) => {
    const current = value.repositories.find((repository) => repository.id === id);
    if (!current) return;
    const next = update(current);
    if (next.url !== undefined && next.url !== current.url && !urlBefore.has(id))
      setUrlBefore((map) => new Map(map).set(id, current.url));
    if (next.localPath !== undefined && next.localPath !== current.localPath && !pathBefore.has(id))
      setPathBefore((map) => new Map(map).set(id, current.localPath));
    onChange({
      ...value,
      repositories: value.repositories.map((repository) =>
        repository.id === id ? { ...repository, ...next } : repository,
      ),
    });
  };
  useEffect(() => {
    onDraftChange(Boolean(url || folder));
  }, [url, folder, onDraftChange]);
  const blocked = disabled || busy !== null;
  const problems = query.data?.problems ?? [];
  const folderProblem = (folder: string) =>
    problems.find((problem) => problem.kind === "folder" && problem.path === folder);
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
        ? value.additionalFolders.filter((folder) => folder !== from)
        : value.additionalFolders.map((folder) => (folder === from ? to : folder)),
      repositories: value.repositories.map((repository) => ({
        ...repository,
        localPath: moved(repository.localPath),
      })),
    });
  };
  const urlIdentity = projectRepositoryIdentity(url.trim());
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
            : "Repository preparation was not confirmed. Your saved configuration is unchanged.",
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
  return (
    <section className="project-settings-section" ref={sectionRef}>
      <h2>Environment</h2>
      <p className="project-muted">
        {kind === "personal"
          ? "Personal work uses private, app-managed storage on this machine. Git is optional."
          : "This project can use its execution folder, additional folders and several repositories together."}
      </p>
      {admissionBlocked && (
        <p className="project-notice">
          Resume or restore this project before preparing or matching a repository.
        </p>
      )}
      <dl className="project-environment">
        <dt>
          {kind === "personal" ? "Managed project storage" : "Execution folder on this machine"}
        </dt>
        <dd>
          <ProjectLocation path={project.workspaceRoot} />
        </dd>
        <dt>Execution machine</dt>
        <dd>{project.environmentId}</dd>
      </dl>
      {error && (
        <p className="project-notice" role="alert">
          {error}
        </p>
      )}
      {uncertainKey && (
        <div className="project-notice">
          <p>
            The previous preparation may have changed files. Inspect the destination before
            permitting a new request.
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
        <h3>Approved additional folders</h3>
        <p className="project-muted">
          Allow new work to access these existing folders on this machine. The execution folder
          remains available. Provider permissions still apply.
        </p>
        {value.additionalFolders.map((path) => {
          const problem = folderProblem(path);
          const saveError = entryMatchesFolder(entryError?.entry, path) ? entryError : null;
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
          <p className="project-muted">No additional folders approved.</p>
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
      <section className="project-environment-section">
        <h3>Repositories</h3>
        <p className="project-muted">
          Add credential-free HTTPS or SSH Git URLs. Authentication comes from Git on this machine.
          Adding a URL does not clone it or create a hosted GitHub App.
        </p>
        {query.error && <p role="alert">Repository status unavailable: {query.error}</p>}
        {value.repositories.map((repository) => {
          const observed = query.data?.repositories.find(
            (item) =>
              item.id === repository.id &&
              item.url === repository.url &&
              item.localPath === repository.localPath,
          );
          // The saved checkout, even after its URL was edited here, for the origin check.
          const savedCheckout = query.data?.repositories.find(
            (item) => item.id === repository.id && item.localPath === repository.localPath,
          );
          const problem = problems.find(
            (item) =>
              item.kind === "repository" &&
              item.repositoryId === repository.id &&
              (item.path === repository.localPath || (repository.localPath === null && !dirty)),
          );
          const pathError = checkoutPathError(repository.localPath);
          const origin = originUpdateFor(repository, savedCheckout);
          const previousUrl = urlBefore.get(repository.id);
          const editing = editingUrl?.id === repository.id ? editingUrl : null;
          const editError = editing
            ? repositoryUrlError(editing.value, value.repositories, repository.id)
            : null;
          const saveError = entryMatchesRepository(entryError?.entry, repository.id)
            ? entryError
            : null;
          const pathId = `checkout-path-${repository.id}`;
          return (
            <article
              className="project-repository-entry"
              key={repository.id}
              data-entry-key={`repository:${repository.id}`}
            >
              {editing ? (
                <div className="project-environment-entry">
                  <input
                    aria-label={`Repository URL for ${repository.url}`}
                    aria-invalid={editError !== null}
                    value={editing.value}
                    maxLength={2048}
                    autoComplete="off"
                    autoFocus
                    onChange={(e) => setEditingUrl({ id: repository.id, value: e.target.value })}
                    onKeyDown={(e) => {
                      if (e.key === "Escape") setEditingUrl(null);
                      if (e.key === "Enter" && editError === null) {
                        setRepository(repository.id, () => ({ url: editing.value.trim() }));
                        setEditingUrl(null);
                      }
                    }}
                  />
                  <button className="project-control" onClick={() => setEditingUrl(null)}>
                    Cancel
                  </button>
                  <button
                    className="project-control"
                    disabled={editError !== null}
                    onClick={() => {
                      setRepository(repository.id, () => ({ url: editing.value.trim() }));
                      setEditingUrl(null);
                    }}
                  >
                    Done
                  </button>
                </div>
              ) : (
                <div className="project-environment-entry">
                  <code>{repository.url}</code>
                  <button
                    className="project-control"
                    disabled={blocked}
                    aria-label={`Edit URL ${repository.url}`}
                    onClick={() => setEditingUrl({ id: repository.id, value: repository.url })}
                  >
                    Edit URL
                  </button>
                  <button
                    className="project-control"
                    disabled={blocked}
                    aria-label={`Remove repository ${repository.url}`}
                    onClick={() =>
                      onChange({
                        ...value,
                        repositories: value.repositories.filter((r) => r.id !== repository.id),
                      })
                    }
                  >
                    Remove
                  </button>
                </div>
              )}
              {editing && editError && (
                <p className="project-field-error" role="alert">
                  {editError}
                </p>
              )}
              {previousUrl !== undefined && previousUrl !== repository.url && (
                <p className="project-muted" role="status">
                  URL changed, unsaved. Was <code>{previousUrl}</code>; the checkout path is kept.{" "}
                  <button
                    className="project-text-link"
                    disabled={blocked}
                    onClick={() => setRepository(repository.id, () => ({ url: previousUrl }))}
                  >
                    Undo
                  </button>
                </p>
              )}
              {origin && previousUrl === undefined && (
                <div className="project-notice" role="status">
                  <p>
                    This checkout&apos;s origin is <code>{origin}</code>.
                  </p>
                  <button
                    className="project-control"
                    disabled={blocked}
                    onClick={() => setRepository(repository.id, () => ({ url: origin }))}
                  >
                    Update URL to {repositoryShortName(origin)}
                  </button>
                </div>
              )}
              <p className="project-muted" role="status">
                {busy === repository.id
                  ? "Checking on this machine…"
                  : observed
                    ? `Checkout: ${observed.status}`
                    : problem && !dirty
                      ? problem.message
                      : dirty
                        ? "Unsaved repository settings"
                        : query.isPending
                          ? "Checking checkout…"
                          : "Checkout status unknown"}
              </p>
              <label>
                Checkout path
                <input
                  id={pathId}
                  aria-label={`Checkout path for ${repository.url}`}
                  aria-invalid={pathError !== null}
                  aria-describedby={pathError ? `${pathId}-error` : undefined}
                  value={repository.localPath ?? ""}
                  disabled={blocked}
                  placeholder="Leave empty for a managed checkout"
                  onChange={(e) =>
                    setRepository(repository.id, () => ({ localPath: e.target.value || null }))
                  }
                />
              </label>
              {pathError ? (
                <p className="project-field-error" id={`${pathId}-error`} role="alert">
                  {pathError.message}
                  {pathError.url !== undefined &&
                    projectRepositoryIdentity(pathError.url) !==
                      projectRepositoryIdentity(repository.url) &&
                    repositoryUrlError(pathError.url, value.repositories, repository.id) ===
                      null && (
                      <>
                        {" "}
                        <button
                          className="project-text-link"
                          disabled={blocked}
                          onClick={() => {
                            const before = pathBefore.get(repository.id);
                            setRepository(repository.id, () => ({
                              url: pathError.url!,
                              localPath: before === undefined ? null : before,
                            }));
                          }}
                        >
                          Use as repository URL
                        </button>
                      </>
                    )}
                </p>
              ) : (
                <p className="project-muted">
                  Use an existing checkout, or a new destination inside the execution folder or an
                  approved folder.
                </p>
              )}
              {saveError && (
                <p className="project-field-error" role="alert">
                  {saveError.message}
                </p>
              )}
              <div className="project-actions">
                {problem?.updatePath !== undefined && (
                  <button
                    className="project-control"
                    disabled={blocked}
                    onClick={() =>
                      setRepository(repository.id, () => ({ localPath: problem.updatePath! }))
                    }
                  >
                    Update path
                  </button>
                )}
                <button
                  className="project-control"
                  disabled={blocked || admissionBlocked || dirty || !repository.localPath}
                  onClick={() => void run(repository.id, "match")}
                >
                  Match existing checkout
                </button>
                <button
                  className="project-control"
                  disabled={blocked || dirty || observed?.status === "ready"}
                  onClick={() => void run(repository.id, "clone")}
                >
                  Prepare checkout
                </button>
              </div>
            </article>
          );
        })}
        {value.repositories.length === 0 && (
          <p className="project-muted">No repository URLs added.</p>
        )}
        <label>
          Repository URL
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
        <button
          className="project-control"
          disabled={
            blocked ||
            urlIdentity === null ||
            value.repositories.length >= 32 ||
            value.repositories.some((r) => projectRepositoryIdentity(r.url) === urlIdentity)
          }
          onClick={() => {
            onChange({
              ...value,
              repositories: [
                ...value.repositories,
                { id: randomUUID(), url: url.trim(), localPath: null },
              ],
            });
            setUrl("");
          }}
        >
          Add URL
        </button>
        {url.trim() && urlIdentity === null && (
          <p role="alert">
            Use a credential-free HTTPS or SSH repository URL, without a query or fragment.
          </p>
        )}
        {dirty && (
          <p className="project-notice">Save changes before matching or preparing a checkout.</p>
        )}
        <p className="project-muted">
          Removing an entry revokes future project use; it does not delete files or remote
          repositories. Existing threads retain their current checkout.
        </p>
      </section>
      {kind === "code" && (
        <ProjectEnvironmentImport
          initialRoot={project.workspaceRoot}
          revision={revision}
          disabled={blocked || admissionBlocked || dirty}
          onBusyChange={onBusyChange}
          onPreview={async (root) => {
            const result = await previewImport({
              environmentId: project.environmentId,
              input: { projectId: project.id, root },
            });
            if (result._tag === "Failure") throw squashAtomCommandFailure(result);
            return result.value;
          }}
          onImport={async (preview) => {
            const result = await importWorkspace({
              environmentId: project.environmentId,
              input: {
                projectId: project.id,
                root: preview.root,
                expectedRevision: preview.revision,
                fingerprint: preview.fingerprint,
                commandId: CommandId.make(randomUUID()),
              },
            });
            if (result._tag === "Failure") throw squashAtomCommandFailure(result);
            onPrepared(result.value.revision, {
              additionalFolders: result.value.additionalFolders,
              repositories: result.value.repositories.map(({ id, url, localPath }) => ({
                id,
                url,
                localPath,
              })),
            });
            query.refresh();
          }}
        />
      )}
      {navigationBlocked ? (
        <div>
          <button className="project-text-link" disabled>
            Manage project icon, checkouts and worktree defaults
          </button>
          <p className="project-muted">
            Save or discard your drafts and finish pending operations before opening checkout
            settings.
          </p>
        </div>
      ) : (
        <Link
          className="project-text-link"
          to="/settings/projects"
          search={{ project: projectKey, machine: project.environmentId }}
        >
          Manage project icon, checkouts and worktree defaults
        </Link>
      )}
    </section>
  );
}
