import { useEffect, useRef, useState } from "react";
import type { ProjectEnvironmentImportPreview } from "@specweave-studio/contracts";

/** The UI only sends the root and server receipt; membership and grants are inspected on the host. */
export function ProjectEnvironmentImport({
  initialRoot,
  revision,
  disabled,
  onPreview,
  onImport,
  onBusyChange,
}: {
  initialRoot: string;
  revision: number;
  disabled: boolean;
  onPreview: (root: string) => Promise<ProjectEnvironmentImportPreview>;
  onImport: (preview: ProjectEnvironmentImportPreview) => Promise<void>;
  onBusyChange: (busy: boolean) => void;
}) {
  const [root, setRoot] = useState(initialRoot);
  const [preview, setPreview] = useState<ProjectEnvironmentImportPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const readyCount = preview?.repositories.filter((row) => row.status === "add").length ?? 0;
  useEffect(() => {
    if (!inFlight.current) setPreview(null);
  }, [revision, initialRoot]);
  async function run(apply: boolean) {
    if (disabled || inFlight.current || (apply && (!preview || !preview.canApply))) return;
    inFlight.current = true;
    setBusy(true);
    onBusyChange(true);
    setMessage(null);
    setError(null);
    try {
      if (apply && preview) {
        await onImport(preview);
        const attached = preview.repositories.filter((row) => row.status === "add").length;
        const remaining = preview.repositories.filter((row) => row.status === "blocked").length;
        // Saving is already confirmed. A refresh failure must not hide the remaining rows
        // or turn that durable success into a failed import.
        setPreview({
          ...preview,
          canApply: false,
          repositories: preview.repositories.map((row) =>
            row.status === "add"
              ? {
                  ...row,
                  status: "existing",
                  reason: "Attached successfully; keeps its existing ID.",
                }
              : row,
          ),
        });
        setMessage(
          `${attached} attached, ${remaining} remaining. Your project and plan are preserved.`,
        );
        try {
          setPreview(await onPreview(preview.root));
        } catch {
          setError("Import saved. Preview again to refresh the remaining repositories.");
        }
      } else {
        setPreview(await onPreview(root.trim()));
      }
    } catch (cause) {
      setPreview(null);
      setError(cause instanceof Error ? cause.message : "Import was not confirmed. Preview again.");
    } finally {
      inFlight.current = false;
      setBusy(false);
      onBusyChange(false);
    }
  }
  return (
    <section className="project-environment-section" aria-label="Import SpecWeave workspace">
      <h3>Import SpecWeave workspace</h3>
      <p className="project-muted">
        Attach the existing repositories registered in a workspace. Preview checks each checkout
        against this project's approved folders.
      </p>
      <label>
        Workspace folder
        <input
          aria-label="Workspace folder"
          value={root}
          disabled={disabled || busy}
          placeholder="Absolute path on this machine"
          onChange={(event) => {
            setRoot(event.target.value);
            setPreview(null);
            setMessage(null);
            setError(null);
          }}
        />
      </label>
      <button
        className="project-control my-3 min-h-11 border bg-card px-4"
        disabled={disabled || busy || !root.trim()}
        onClick={() => void run(false)}
      >
        {busy ? "Checking workspace…" : "Preview import"}
      </button>
      {error && (
        <p className="project-notice" style={{ marginBlock: 12 }} role="alert">
          {error}
        </p>
      )}
      {message && (
        <p className="project-notice" style={{ marginBlock: 12 }} role="status">
          {message}
        </p>
      )}
      {preview && (
        <div aria-label="Workspace import preview">
          <p className="project-muted">
            {preview.repositories.filter((row) => row.status === "add").length} to attach ·{" "}
            {preview.repositories.filter((row) => row.status === "existing").length} already
            attached · {preview.repositories.filter((row) => row.status === "blocked").length}{" "}
            blocked
          </p>
          {preview.repositories.map((row, index) => (
            <article className="project-repository-entry" key={`${row.id}:${index}`}>
              <strong>{row.id}</strong>
              <p className="project-muted" style={{ overflowWrap: "anywhere" }}>
                {row.path}
              </p>
              {row.url && (
                <p className="project-muted" style={{ overflowWrap: "anywhere" }}>
                  {row.url}
                </p>
              )}
              <p role={row.status === "blocked" ? "alert" : undefined}>{row.reason}</p>
            </article>
          ))}
          {preview.repositories.length === 0 && (
            <p className="project-muted">This workspace has no registered repositories.</p>
          )}
          <p className="project-muted">
            Files stay in place. Folder permissions and plan authority stay as configured.
          </p>
          <button
            className="project-control project-primary my-3"
            disabled={disabled || busy || !preview.canApply || preview.repositories.length === 0}
            onClick={() => void run(true)}
          >
            {preview.repositories.some((row) => row.status === "add")
              ? `Import ${readyCount} ready ${readyCount === 1 ? "repository" : "repositories"}`
              : "Keep existing attachments"}
          </button>
        </div>
      )}
    </section>
  );
}
