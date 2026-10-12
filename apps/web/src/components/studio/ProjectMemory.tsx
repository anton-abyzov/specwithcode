import { useEffect, useMemo, useState } from "react";
import type {
  EnvironmentId,
  ProjectId,
  ProjectWorkspaceReadResult,
} from "@specweave-studio/contracts";
import { projectWorkspace } from "../../studio/projectWorkspace";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { squashAtomCommandFailure } from "@specweave-studio/client-runtime/state/runtime";

type MemorySummary = ProjectWorkspaceReadResult["memory"];
/** Rows drawn at once; an imported memory can hold thousands of files. */
export const MEMORY_LIST_PAGE = 50;

/** MEMORY.md is the index every agent reads, so it leads; the rest stay in name order. */
export function memoryFileRows(
  files: MemorySummary["files"],
  query: string,
): MemorySummary["files"] {
  const needle = query.trim().toLowerCase();
  const matched = needle ? files.filter((f) => f.name.toLowerCase().includes(needle)) : files;
  const index = matched.find((f) => f.name === "MEMORY.md");
  return index ? [index, ...matched.filter((f) => f !== index)] : matched;
}

export function memorySize(bytes: number): string {
  if (bytes < 1_024) return `${bytes.toLocaleString()} bytes`;
  if (bytes < 1_048_576) return `${(bytes / 1_024).toFixed(bytes < 10_240 ? 1 : 0)} KB`;
  return `${(bytes / 1_048_576).toFixed(1)} MB`;
}

export function ProjectMemory({
  environmentId,
  projectId,
  memory,
  disabled,
  onSaved,
  onDirtyChange,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  memory: MemorySummary;
  disabled: boolean;
  onSaved: () => void;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const [name, setName] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [draft, setDraft] = useState("");
  const [revision, setRevision] = useState<number | null>(null);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [filter, setFilter] = useState("");
  const [shown, setShown] = useState(MEMORY_LIST_PAGE);
  const rows = useMemo(() => memoryFileRows(memory.files, filter), [memory.files, filter]);
  // The open file stays in the list even when it sits past the page being shown.
  const visible = useMemo(() => {
    const page = rows.slice(0, shown);
    const open = name ? rows.find((f) => f.name === name) : undefined;
    return open && !page.includes(open) ? [...page, open] : page;
  }, [rows, shown, name]);
  useEffect(() => {
    onDirtyChange(dirty);
  }, [dirty, onDirtyChange]);
  const known = memory.files.some((f) => f.name === name);
  const query = useEnvironmentQuery(
    name && known
      ? projectWorkspace.memoryRead({ environmentId, input: { projectId, name } })
      : null,
  );
  const write = useAtomCommand(projectWorkspace.memoryWrite);
  const remove = useAtomCommand(projectWorkspace.memoryDelete);
  useEffect(() => {
    if (query.data && query.data.name === name && !dirty) {
      setDraft(query.data.content);
      setRevision(query.data.revision);
    }
  }, [query.data, name, dirty]);
  async function save(deleting = false) {
    if (!name || busy || disabled) return;
    setBusy(true);
    setError(null);
    const result =
      deleting && revision !== null
        ? await remove({ environmentId, input: { projectId, name, expectedRevision: revision } })
        : await write({
            environmentId,
            input: { projectId, name, content: draft, expectedRevision: revision },
          });
    setBusy(false);
    if (result._tag === "Failure") {
      const e = squashAtomCommandFailure(result);
      setError(
        e instanceof Error
          ? e.message
          : "Memory changed or could not be saved. Your edit is preserved. Reload before retrying.",
      );
      return;
    }
    setDirty(false);
    setConfirmDelete(false);
    if (deleting) {
      setName(null);
      setDraft("");
      setRevision(null);
    } else {
      query.refresh();
    }
    onSaved();
  }
  function select(next: string, fresh = false) {
    setName(next);
    setDraft("");
    setRevision(null);
    setDirty(fresh);
    setError(null);
    setConfirmDelete(false);
  }
  return (
    <section className="project-settings-section">
      <h2>Project memory</h2>
      <p className="project-muted">
        The coordinator receives the bounded memory index. Topic files retain decisions and
        references. Edits use a revision check to protect concurrent work.
      </p>
      {memory.files.length > 8 && (
        <label className="project-memory-find">
          <span className="sr-only">Find a memory file</span>
          <input
            type="search"
            aria-label="Find a memory file"
            placeholder={`Find in ${memory.files.length.toLocaleString()} files`}
            value={filter}
            onChange={(e) => {
              setFilter(e.target.value);
              setShown(MEMORY_LIST_PAGE);
            }}
          />
        </label>
      )}
      <div className="project-memory-list">
        {visible.map((f) => (
          <button
            className="project-control"
            key={f.name}
            disabled={dirty || busy}
            aria-pressed={name === f.name}
            onClick={() => select(f.name)}
          >
            <span>{f.name}</span>
            <small>
              {memorySize(f.byteLength)} · revision {f.revision}
            </small>
          </button>
        ))}
      </div>
      {memory.files.length > 0 && rows.length === 0 && (
        <p className="project-muted" role="status">
          No memory file matches “{filter.trim()}”.
        </p>
      )}
      {rows.length > shown && (
        <button
          type="button"
          className="project-control"
          onClick={() => setShown((count) => count + MEMORY_LIST_PAGE * 4)}
        >
          Show more ({(rows.length - shown).toLocaleString()} hidden)
        </button>
      )}
      {memory.files.length === 0 && (
        <p className="project-muted">No project memory yet. Start with MEMORY.md.</p>
      )}
      <form
        className="project-inline-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (
            /^[A-Za-z0-9][A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]+)*\.md$/.test(newName) &&
            !memory.files.some((f) => f.name === newName)
          )
            select(newName, true);
          else setError("Use a unique Markdown filename, for example MEMORY.md.");
        }}
      >
        <input
          aria-label="New memory filename"
          placeholder="MEMORY.md"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          disabled={disabled || dirty || busy}
        />
        <button className="project-control" disabled={disabled || dirty || busy || !newName}>
          New file
        </button>
      </form>
      {name && (
        <>
          <div className="project-section-title">
            <h3>{name}</h3>
            <span className="project-muted">
              {known ? `Revision ${revision ?? "loading"}` : "New file"}
            </span>
          </div>
          {query.error && <p role="alert">{query.error}</p>}
          <textarea
            aria-label={`Content of ${name}`}
            rows={14}
            value={draft}
            disabled={disabled || busy || (known && revision === null)}
            onChange={(e) => {
              setDraft(e.target.value);
              setDirty(true);
            }}
          />
          <div className="project-actions">
            <button
              className="project-control project-primary"
              onClick={() => void save()}
              disabled={disabled || busy || !dirty}
            >
              Save memory
            </button>
            <button
              className="project-control"
              onClick={() => {
                setDirty(false);
                setName(null);
                setError(null);
              }}
              disabled={busy}
            >
              Discard edit
            </button>
            {known && (
              <button
                className="project-control project-danger-text"
                disabled={disabled || busy || revision === null}
                onClick={() => setConfirmDelete(true)}
              >
                Delete file
              </button>
            )}
          </div>
          {confirmDelete && (
            <div className="project-notice">
              <p>Delete {name} from this project?</p>
              <button
                className="project-control project-danger"
                onClick={() => void save(true)}
                disabled={busy}
              >
                Delete memory file
              </button>
              <button className="project-control" onClick={() => setConfirmDelete(false)}>
                Cancel
              </button>
            </div>
          )}
        </>
      )}
      {error && (
        <div role="alert" className="project-notice">
          <p>{error}</p>
          {name && known && (
            <button
              className="project-control"
              disabled={busy}
              onClick={() => {
                setDirty(false);
                setRevision(null);
                setError(null);
                query.refresh();
              }}
            >
              Reload file and discard edit
            </button>
          )}
        </div>
      )}
      <p className="project-muted">
        {memory.files.length.toLocaleString()} {memory.files.length === 1 ? "file" : "files"},{" "}
        {memorySize(memory.totalBytes)} stored in this project.
      </p>
    </section>
  );
}
