import { ChevronRightIcon, FolderIcon } from "lucide-react";

/** Compact at rest; the exact path remains selectable and keyboard accessible. */
export function ProjectLocation({ path }: { path: string }) {
  const folder =
    path
      .replace(/[\\/]+$/, "")
      .split(/[\\/]/)
      .pop() || path;
  return (
    <details className="project-location">
      <summary aria-label={`Folder location: ${path}`}>
        <FolderIcon size={14} aria-hidden="true" />
        <span>{folder}</span>
        <ChevronRightIcon className="project-location-chevron" size={14} aria-hidden="true" />
      </summary>
      <code tabIndex={0} aria-label="Full folder path">
        {path}
      </code>
    </details>
  );
}
