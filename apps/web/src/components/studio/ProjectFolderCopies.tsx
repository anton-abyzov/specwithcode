import type { EnvironmentProject } from "@specweave-studio/client-runtime/state/shell";
import { useState, type ReactNode } from "react";

import { useProjects } from "../../state/entities";
import { useEnvironment } from "../../state/environments";
import { useMachineNickname } from "../../studio/machineNickname";
import { useProjectFolderHealth } from "../../studio/useProjectFolderHealth";
import { ProjectLocation } from "./ProjectLocation";

const copyKey = (item: EnvironmentProject) => `${item.environmentId}:${item.id}`;

/**
 * The project's copies on other machines: the same logical project, plus the copies the
 * sidebar shows as this one project (`members`, grouped by repository even when unlinked).
 * Never matched by path.
 */
export function otherProjectCopies(
  project: EnvironmentProject,
  projects: ReadonlyArray<EnvironmentProject>,
  members: ReadonlyArray<EnvironmentProject> = [],
): EnvironmentProject[] {
  const logicalId = project.workspaceSettings?.logicalProject?.id;
  const self = copyKey(project);
  const memberKeys = new Set(members.map(copyKey));
  const seen = new Set<string>([self]);
  const copies: EnvironmentProject[] = [];
  for (const item of [...projects, ...members]) {
    const key = copyKey(item);
    if (seen.has(key)) continue;
    const linked = Boolean(logicalId) && item.workspaceSettings?.logicalProject?.id === logicalId;
    if (!linked && !memberKeys.has(key)) continue;
    seen.add(key);
    copies.push(item);
  }
  return copies;
}

/**
 * Under "Project folder on {machine}": where each other machine keeps this project, with
 * Change… to point that copy at another folder. A copy whose connected machine finds no
 * folder says so and offers Relink…; an offline machine or an unread check says nothing.
 */
export function ProjectFolderCopies({
  project,
  members,
  disabled,
  renderChange,
}: {
  readonly project: EnvironmentProject;
  /** Every copy the sidebar groups as this project, this one included. */
  readonly members?: ReadonlyArray<EnvironmentProject> | undefined;
  readonly disabled: boolean;
  /** The folder check and change, run against the copy's own machine. */
  readonly renderChange: (copy: EnvironmentProject, done: () => void) => ReactNode;
}) {
  const copies = otherProjectCopies(project, useProjects(), members);
  if (copies.length === 0) return null;
  return (
    <ul className="project-folder-copies" aria-label="This project on other machines">
      {copies.map((copy) => (
        <ProjectFolderCopyRow
          key={`${copy.environmentId}:${copy.id}`}
          copy={copy}
          disabled={disabled}
          renderChange={renderChange}
        />
      ))}
    </ul>
  );
}

function ProjectFolderCopyRow({
  copy,
  disabled,
  renderChange,
}: {
  readonly copy: EnvironmentProject;
  readonly disabled: boolean;
  readonly renderChange: (copy: EnvironmentProject, done: () => void) => ReactNode;
}) {
  const machine = useMachineNickname(copy.environmentId);
  const connected = useEnvironment(copy.environmentId)?.connection.phase === "connected";
  const health = useProjectFolderHealth(copy);
  const [open, setOpen] = useState(false);
  const missing = connected && (health === "missing" || health === "file");
  return (
    <li data-folder-copy={copy.environmentId} data-folder-health={connected ? health : undefined}>
      <div className="project-folder-copy">
        <span className="project-folder-copy-machine">{machine}</span>
        <ProjectLocation path={copy.workspaceRoot} />
        {missing ? (
          <span className="project-folder-copy-missing" role="status">
            {health === "file" ? "Is a file, not a folder" : "Folder missing"}
          </span>
        ) : null}
        <button
          type="button"
          className="project-control"
          disabled={disabled || !connected}
          aria-expanded={open}
          aria-label={`${missing ? "Relink" : "Change"} the folder on ${machine}`}
          onClick={() => setOpen((value) => !value)}
        >
          {missing ? "Relink…" : "Change…"}
        </button>
      </div>
      {!connected ? (
        <p className="project-muted" data-folder-copy-offline>
          {machine} is offline. Change its folder once it connects.
        </p>
      ) : null}
      {/* Stays open after a change, so its summary shows; Change… closes it. */}
      {open && connected ? renderChange(copy, () => undefined) : null}
    </li>
  );
}
