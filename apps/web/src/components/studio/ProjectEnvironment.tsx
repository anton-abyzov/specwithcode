import { useEffect, useId, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import {
  CommandId,
  projectRepositoryIdentity,
  type ProjectWorkspaceReadResult,
} from "@specweave-studio/contracts";
import type { EnvironmentProject } from "@specweave-studio/client-runtime/state/shell";
import { squashAtomCommandFailure } from "@specweave-studio/client-runtime/state/runtime";
import { projectWorkspace } from "../../studio/projectWorkspace";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { randomUUID } from "../../lib/utils";
import { CharacterCount } from "../ui/character-count";

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
}) {
  const countId = useId();
  const query = useEnvironmentQuery(
    projectWorkspace.environmentRead({
      environmentId: project.environmentId,
      input: { projectId: project.id },
    }),
  );
  const prepare = useAtomCommand(projectWorkspace.environmentPrepare);
  const [url, setUrl] = useState("");
  const [folder, setFolder] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [uncertainKey, setUncertainKey] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const inFlight = useRef(false);
  const requests = useRef(new Map<string, string>());
  useEffect(() => {
    query.refresh();
  }, [revision, query.refresh]);
  useEffect(() => {
    onDraftChange(Boolean(url || folder));
  }, [url, folder, onDraftChange]);
  const blocked = disabled || busy !== null;
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
    <section className="project-settings-section">
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
        <dd>{project.workspaceRoot}</dd>
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
        {value.additionalFolders.map((path) => (
          <div className="project-environment-entry" key={path}>
            <code>{path}</code>
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
        ))}
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
          return (
            <article className="project-repository-entry" key={repository.id}>
              <div className="project-environment-entry">
                <code>{repository.url}</code>
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
              <p className="project-muted" role="status">
                {busy === repository.id
                  ? "Checking on this machine…"
                  : observed
                    ? `Checkout: ${observed.status}`
                    : dirty
                      ? "Unsaved repository settings"
                      : query.isPending
                        ? "Checking checkout…"
                        : "Checkout status unknown"}
              </p>
              <label>
                Checkout path
                <input
                  aria-label={`Checkout path for ${repository.url}`}
                  value={repository.localPath ?? ""}
                  disabled={blocked}
                  placeholder="Leave empty for a managed checkout"
                  onChange={(e) =>
                    onChange({
                      ...value,
                      repositories: value.repositories.map((r) =>
                        r.id === repository.id ? { ...r, localPath: e.target.value || null } : r,
                      ),
                    })
                  }
                />
              </label>
              <p className="project-muted">
                Use an existing checkout, or a new destination inside the execution folder or an
                approved folder.
              </p>
              <div className="project-actions">
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
