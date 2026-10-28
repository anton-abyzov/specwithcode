import { useEffect, useMemo, useRef, useState } from "react";
import type {
  EnvironmentId,
  ProjectId,
  ProjectWorkspaceReadResult,
} from "@specweave-studio/contracts";
import { projectWorkspace } from "../../studio/projectWorkspace";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { squashAtomCommandFailure } from "@specweave-studio/client-runtime/state/runtime";
import ChatMarkdown from "../ChatMarkdown";

type MemorySummary = ProjectWorkspaceReadResult["memory"];
/** Rows drawn at once; an imported memory can hold thousands of files. */
export const MEMORY_LIST_PAGE = 50;

/** MEMORY.md is the index every agent reads, so it leads; the rest follow the chosen order. */
export function memoryFileRows(
  files: MemorySummary["files"],
  query: string,
  options: { group?: MemoryGroup | null; sort?: "name" | "recent" } = {},
): MemorySummary["files"] {
  const needle = query.trim().toLowerCase();
  let matched = needle
    ? files.filter((f) => {
        const label = memoryLabel(f.name);
        return `${f.name} ${label.title} ${label.owner ?? ""}`.toLowerCase().includes(needle);
      })
    : files;
  if (options.group) matched = matched.filter((f) => memoryLabel(f.name).group === options.group);
  if (options.sort === "recent")
    matched = [...matched].sort(
      (a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.name.localeCompare(b.name),
    );
  const index = matched.find((f) => f.name === "MEMORY.md");
  return index ? [index, ...matched.filter((f) => f !== index)] : matched;
}

export function memorySize(bytes: number): string {
  if (bytes < 1_024) return `${bytes.toLocaleString()} bytes`;
  if (bytes < 1_048_576) return `${(bytes / 1_024).toFixed(bytes < 10_240 ? 1 : 0)} KB`;
  return `${(bytes / 1_048_576).toFixed(1)} MB`;
}

export type MemoryGroup =
  | "index"
  | "projects"
  | "references"
  | "feedback"
  | "decisions"
  | "people"
  | "agents"
  | "skills"
  | "other";

export const MEMORY_GROUP_LABELS: Record<MemoryGroup, string> = {
  index: "Index",
  projects: "Projects",
  references: "References",
  feedback: "Feedback",
  decisions: "Decisions",
  people: "People",
  agents: "Agents",
  skills: "Skills",
  other: "Other",
};

/** Agents name files `<type>_<topic>_<yyyy_mm_dd>.md`; the type becomes the group. */
const TYPE_PREFIXES: ReadonlyArray<readonly [string, MemoryGroup]> = [
  ["project_", "projects"],
  ["reference_", "references"],
  ["feedback_", "feedback"],
  ["decision_", "decisions"],
  ["user_", "people"],
];

function humanize(stem: string, fallback: string): { title: string; date?: string } {
  const dated = /^(.*?)[_-](\d{4})[_-](\d{2})[_-](\d{2})$/.exec(stem);
  const words = (dated ? dated[1]! : stem).replace(/[_-]+/g, " ").trim();
  const title = words ? words[0]!.toUpperCase() + words.slice(1) : fallback;
  return dated ? { title, date: `${dated[2]}-${dated[3]}-${dated[4]}` } : { title };
}

/**
 * A readable title and group for a stored filename. Imported files carry their origin in
 * the name (`agent-memory.<agent>.<file>`, `skill-memory.<skill>`, `MEMORY.<source>`).
 */
export function memoryLabel(name: string): {
  group: MemoryGroup;
  title: string;
  owner?: string;
  date?: string;
} {
  const stem = name.replace(/\.md$/, "");
  if (stem === "MEMORY") return { group: "index", title: "Memory index" };
  if (stem.startsWith("MEMORY."))
    return { group: "index", title: "Imported index", owner: stem.slice("MEMORY.".length) };
  const agent = /^agent-memory\.([^.]+)\.(.+)$/.exec(stem);
  if (agent) {
    // `sw-sw-closer` is the `sw` plugin's `sw-closer` agent.
    const owner = agent[1]!.replace(/^([a-z0-9]+)-\1-/, "$1:");
    const inner = memoryLabel(`${agent[2]}.md`);
    return {
      group: "agents",
      title: inner.title,
      owner,
      ...(inner.date ? { date: inner.date } : {}),
    };
  }
  if (stem.startsWith("skill-memory."))
    return { group: "skills", ...humanize(stem.slice("skill-memory.".length), stem) };
  for (const [prefix, group] of TYPE_PREFIXES)
    if (stem.startsWith(prefix)) return { group, ...humanize(stem.slice(prefix.length), stem) };
  return { group: "other", ...humanize(stem, stem) };
}

export function memoryGroupCounts(files: MemorySummary["files"]): Array<[MemoryGroup, number]> {
  const counts = new Map<MemoryGroup, number>();
  for (const f of files) {
    const group = memoryLabel(f.name).group;
    counts.set(group, (counts.get(group) ?? 0) + 1);
  }
  return (Object.keys(MEMORY_GROUP_LABELS) as MemoryGroup[])
    .filter((g) => counts.has(g))
    .map((g) => [g, counts.get(g)!]);
}

export function memoryUpdated(updatedAt: string): string {
  const date = new Date(updatedAt);
  return Number.isNaN(date.getTime())
    ? ""
    : date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

/** Stored names are already safe filenames; the group folder keeps a large export browsable. */
export function memoryArchivePath(name: string): string {
  return `${memoryLabel(name).group}/${name}`;
}

function saveBlob(filename: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

const EXPORT_READERS = 6;

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
  const [editing, setEditing] = useState(false);
  const [newName, setNewName] = useState("");
  const [draft, setDraft] = useState("");
  const [revision, setRevision] = useState<number | null>(null);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [filter, setFilter] = useState("");
  const [group, setGroup] = useState<MemoryGroup | null>(null);
  const [sort, setSort] = useState<"name" | "recent">("recent");
  const [shown, setShown] = useState(MEMORY_LIST_PAGE);
  const [copied, setCopied] = useState(false);
  const [exporting, setExporting] = useState<{ done: number; total: number } | null>(null);
  const rows = useMemo(
    () => memoryFileRows(memory.files, filter, { group, sort }),
    [memory.files, filter, group, sort],
  );
  const groups = useMemo(() => memoryGroupCounts(memory.files), [memory.files]);
  // The open file stays in the list even when it sits past the page being shown.
  const visible = useMemo(() => {
    const page = rows.slice(0, shown);
    const open = name ? rows.find((f) => f.name === name) : undefined;
    return open && !page.includes(open) ? [...page, open] : page;
  }, [rows, shown, name]);
  useEffect(() => {
    onDirtyChange(dirty);
  }, [dirty, onDirtyChange]);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1_500);
    return () => window.clearTimeout(timer);
  }, [copied]);
  const viewer = useRef<HTMLDivElement>(null);
  // The list scrolls on its own, so an opened file can land below the fold.
  useEffect(() => {
    if (name) viewer.current?.scrollIntoView?.({ block: "nearest" });
  }, [name]);
  const known = memory.files.some((f) => f.name === name);
  const openFile = known ? memory.files.find((f) => f.name === name) : undefined;
  const query = useEnvironmentQuery(
    name && known
      ? projectWorkspace.memoryRead({ environmentId, input: { projectId, name } })
      : null,
  );
  const write = useAtomCommand(projectWorkspace.memoryWrite);
  const remove = useAtomCommand(projectWorkspace.memoryDelete);
  const fetchFile = useAtomCommand(projectWorkspace.memoryFetch);
  // After a save the query still holds the previous version until its refresh lands.
  const savedRevision = useRef<number | null>(null);
  useEffect(() => {
    if (
      query.data &&
      query.data.name === name &&
      !dirty &&
      query.data.revision >= (savedRevision.current ?? 0)
    ) {
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
    setEditing(false);
    if (result._tag === "Success" && "content" in result.value) {
      savedRevision.current = result.value.revision;
      setDraft(result.value.content);
      setRevision(result.value.revision);
    }
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
    if (next === name && !fresh) return;
    savedRevision.current = null;
    setName(next);
    setEditing(fresh);
    setDraft("");
    setRevision(null);
    setDirty(fresh);
    setError(null);
    setConfirmDelete(false);
  }
  async function downloadShown() {
    if (exporting || rows.length === 0) return;
    const names = rows.map((f) => f.name);
    setError(null);
    setExporting({ done: 0, total: names.length });
    try {
      const { default: JSZip } = await import("jszip");
      const zip = new JSZip();
      const failed: string[] = [];
      let next = 0;
      let done = 0;
      // A few reads at a time: a large memory finishes quickly without flooding the host.
      const reader = async () => {
        while (next < names.length) {
          const file = names[next++]!;
          const result = await fetchFile({ environmentId, input: { projectId, name: file } });
          if (result._tag === "Success") zip.file(memoryArchivePath(file), result.value.content);
          else failed.push(file);
          setExporting({ done: ++done, total: names.length });
        }
      };
      await Promise.all(Array.from({ length: Math.min(EXPORT_READERS, names.length) }, reader));
      if (failed.length < names.length)
        saveBlob("project-memory.zip", await zip.generateAsync({ type: "blob" }));
      if (failed.length > 0)
        setError(
          `${failed.length.toLocaleString()} of ${names.length.toLocaleString()} memory files could not be read and are not in the download: ${failed.slice(0, 3).join(", ")}${failed.length > 3 ? "…" : ""}`,
        );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not build the memory download.");
    } finally {
      setExporting(null);
    }
  }
  const label = name ? memoryLabel(name) : null;
  const loaded = !known || revision !== null;
  return (
    <section className="project-settings-section">
      <h2>Project memory</h2>
      <p className="project-muted">
        Agents save what they learn here, one topic per file, and every thread receives MEMORY.md as
        the index. Open a file to read it; edits are checked against its latest version so
        concurrent work is never overwritten.
      </p>
      {(memory.files.length > 8 || filter !== "" || group !== null) && (
        <>
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
          <div className="project-memory-groups" role="group" aria-label="Memory groups">
            <button
              type="button"
              aria-pressed={group === null}
              onClick={() => {
                setGroup(null);
                setShown(MEMORY_LIST_PAGE);
              }}
            >
              All <small>{memory.files.length.toLocaleString()}</small>
            </button>
            {groups.map(([g, count]) => (
              <button
                type="button"
                key={g}
                aria-pressed={group === g}
                onClick={() => {
                  setGroup(group === g ? null : g);
                  setShown(MEMORY_LIST_PAGE);
                }}
              >
                {MEMORY_GROUP_LABELS[g]} <small>{count.toLocaleString()}</small>
              </button>
            ))}
          </div>
        </>
      )}
      {memory.files.length > 0 && (
        <div className="project-memory-toolbar">
          <label>
            <span className="project-muted">Order</span>
            <select
              aria-label="Order memory files"
              value={sort}
              onChange={(e) => setSort(e.target.value === "name" ? "name" : "recent")}
            >
              <option value="recent">Recently updated</option>
              <option value="name">Name</option>
            </select>
          </label>
          <button
            type="button"
            className="project-control"
            disabled={exporting !== null || rows.length === 0}
            onClick={() => void downloadShown()}
          >
            {exporting
              ? `Preparing ${exporting.done.toLocaleString()} of ${exporting.total.toLocaleString()}…`
              : rows.length === memory.files.length
                ? "Download all (.zip)"
                : `Download ${rows.length.toLocaleString()} shown (.zip)`}
          </button>
        </div>
      )}
      <div className="project-memory-list">
        {visible.map((f) => {
          const row = memoryLabel(f.name);
          return (
            <button
              className="project-control"
              key={f.name}
              disabled={dirty || busy}
              aria-pressed={name === f.name}
              data-memory-file={f.name}
              onClick={() => select(f.name)}
            >
              <span>
                <strong>
                  {row.owner ? `${row.owner} · ` : ""}
                  {row.title}
                </strong>
                <small>{f.name}</small>
              </span>
              <small>
                {memorySize(f.byteLength)} · {memoryUpdated(f.updatedAt)}
                {f.revision > 1 ? ` · ${f.revision} versions` : ""}
              </small>
            </button>
          );
        })}
      </div>
      {memory.files.length > 0 && rows.length === 0 && (
        <p className="project-muted" role="status">
          No memory file matches
          {filter.trim() ? ` “${filter.trim()}”` : ""}
          {group ? ` in ${MEMORY_GROUP_LABELS[group]}` : ""}.
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
      {name && label && (
        <div className="project-memory-viewer" ref={viewer}>
          <div className="project-section-title">
            <h3>
              {label.owner ? `${label.owner} · ` : ""}
              {label.title}
            </h3>
            <span className="project-muted">
              {known
                ? `${name} · ${revision === null ? "loading" : `version ${revision}`}${openFile ? ` · updated ${memoryUpdated(openFile.updatedAt)}` : ""}`
                : `${name} · new file`}
            </span>
          </div>
          {query.error && <p role="alert">{query.error}</p>}
          {editing ? (
            <textarea
              aria-label={`Content of ${name}`}
              rows={14}
              value={draft}
              disabled={disabled || busy || !loaded}
              onChange={(e) => {
                setDraft(e.target.value);
                setDirty(true);
              }}
            />
          ) : (
            <div
              className="project-memory-content"
              aria-label={`Content of ${name}`}
              aria-busy={!loaded}
            >
              {loaded ? (
                draft.trim() ? (
                  <ChatMarkdown text={draft} cwd={undefined} environmentId={environmentId} />
                ) : (
                  <p className="project-muted">This file is empty.</p>
                )
              ) : (
                <p className="project-muted">Loading…</p>
              )}
            </div>
          )}
          <div className="project-actions">
            {editing ? (
              <>
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
                    setEditing(false);
                    setError(null);
                    if (known) setDraft(query.data?.content ?? "");
                    else setName(null);
                  }}
                  disabled={busy}
                >
                  Discard edit
                </button>
              </>
            ) : (
              <>
                <button
                  className="project-control"
                  disabled={!loaded}
                  onClick={() => {
                    const fail = () => setError("Could not copy to the clipboard.");
                    if (!navigator.clipboard) fail();
                    else
                      void navigator.clipboard.writeText(draft).then(() => setCopied(true), fail);
                  }}
                >
                  {copied ? "Copied" : "Copy"}
                </button>
                <button
                  className="project-control"
                  disabled={!loaded}
                  onClick={() =>
                    saveBlob(name, new Blob([draft], { type: "text/markdown;charset=utf-8" }))
                  }
                >
                  Download
                </button>
                <button
                  className="project-control"
                  disabled={disabled || busy || !loaded}
                  onClick={() => setEditing(true)}
                >
                  Edit
                </button>
                <button className="project-control" onClick={() => setName(null)}>
                  Close
                </button>
              </>
            )}
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
        </div>
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
      {error && (
        <div role="alert" className="project-notice">
          <p>{error}</p>
          {name && known && editing && (
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
