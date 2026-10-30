import type { EnvironmentProject } from "@specweave-studio/client-runtime/state/shell";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@specweave-studio/client-runtime/state/runtime";
import {
  AuthOrchestrationOperateScope,
  type ProjectIconOverride,
} from "@specweave-studio/contracts";
import { useMemo, useState, type ReactElement, type ReactNode } from "react";

import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import {
  awaitEnvironmentScope,
  readEnvironmentScope,
  useEnvironmentsWithScope,
} from "../../state/session";
import { projectEnvironment } from "../../state/projects";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { ProjectFavicon } from "../ProjectFavicon";
import {
  canPickExternalProjectFavicon,
  ProjectFaviconPickerDialog,
} from "../settings/ProjectFaviconPickerDialog";
import { ProjectIconPicker, useLatestIconSave } from "../settings/ProjectIconPicker";
import { toastManager } from "../ui/toast";

type IconChange = { faviconPath: string | null; projectIcon: ProjectIconOverride | null };

/**
 * Change a project's icon from wherever the project is shown. A project checked
 * out on several machines shares one icon, so every checkout takes the change.
 */
export function useProjectIconEditor({
  project,
  checkouts,
  disabled,
}: {
  /** The checkout whose files and saved icon the pickers start from. */
  project: EnvironmentProject;
  /** Every checkout of this project; defaults to the one above. */
  checkouts?: readonly EnvironmentProject[];
  disabled: boolean;
}) {
  const [filePickerOpen, setFilePickerOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const update = useOrchestrationCommand(projectEnvironment.update, { reportFailure: false });
  const { environments } = useEnvironments();
  const members = useMemo(
    () => (checkouts && checkouts.length > 0 ? checkouts : [project]),
    [checkouts, project],
  );
  const writable = useEnvironmentsWithScope(members, AuthOrchestrationOperateScope);
  const environmentLabel = (member: EnvironmentProject) =>
    environments.find((entry) => entry.environmentId === member.environmentId)?.label ??
    "the other machine";
  // Every checkout shares the icon, so one that cannot take the change blocks it
  // up front instead of leaving the checkouts with different icons.
  const blockedMember = members.find(
    (member) =>
      !writable.has(member.environmentId) ||
      environments.find((entry) => entry.environmentId === member.environmentId)?.connection
        .phase !== "connected",
  );
  // A machine that is not connected has no confirmed grant yet: ask to connect
  // it rather than reporting a permission it may well have.
  const blocked =
    blockedMember === undefined
      ? null
      : writable.has(blockedMember.environmentId) ||
          environments.find((entry) => entry.environmentId === blockedMember.environmentId)
            ?.connection.phase !== "connected"
        ? `Connect ${environmentLabel(blockedMember)} to change this project's icon.`
        : `This connection cannot change the icon on ${environmentLabel(blockedMember)}.`;
  const pickExternal =
    typeof window !== "undefined" &&
    members.every(
      (member) =>
        member.environmentId === primaryEnvironmentId &&
        canPickExternalProjectFavicon(member.workspaceRoot, navigator.platform),
    )
      ? window.desktopBridge?.pickProjectFavicon
      : undefined;
  const locked = disabled || blocked !== null;
  const busy = locked || saving;
  // A picker left open when editing stops must not reopen on its own later.
  if (locked && filePickerOpen) setFilePickerOpen(false);

  // Resolves false when the change was not saved, so the picker shows the saved icon again.
  const save = useLatestIconSave(async (change: IconChange) => {
    if (locked) return false;
    // The cached grant can be empty after an idle period; load it before denying.
    const granted = await Promise.all(
      members.map(
        async (member) =>
          readEnvironmentScope(member.environmentId, AuthOrchestrationOperateScope) ||
          (await awaitEnvironmentScope(member.environmentId, AuthOrchestrationOperateScope)),
      ),
    );
    const denied = members.find((_, index) => !granted[index]);
    if (denied) {
      toastManager.add({
        type: "error",
        title: "Could not change the project icon",
        description: `This connection cannot change the icon on ${environmentLabel(denied)}.`,
      });
      return false;
    }
    setSaving(true);
    try {
      for (const member of members) {
        const result = await update({
          environmentId: member.environmentId,
          input: { projectId: member.id, ...change },
        });
        if (result._tag === "Failure") {
          if (!isAtomCommandInterrupted(result)) {
            const error = squashAtomCommandFailure(result);
            toastManager.add({
              type: "error",
              title:
                members.length > 1
                  ? `Could not change the project icon on ${environmentLabel(member)}`
                  : "Could not change the project icon",
              description: error instanceof Error ? error.message : "Try again.",
            });
          }
          return false;
        }
      }
      return true;
    } finally {
      setSaving(false);
    }
  });

  const customized = members.some(
    (member) => member.faviconPath != null || member.projectIcon != null,
  );
  const dialogs: ReactNode = (
    <>
      {/* Mounted only while open: the closed picker would still search the workspace. */}
      {filePickerOpen && !locked ? (
        <ProjectFaviconPickerDialog
          cwd={project.workspaceRoot}
          environmentId={project.environmentId}
          onOpenChange={setFilePickerOpen}
          {...(pickExternal ? { onPickExternal: () => pickExternal(project.workspaceRoot) } : {})}
          onSelect={(path) => void save({ faviconPath: path, projectIcon: null })}
          open
          projectName={project.title}
        />
      ) : null}
    </>
  );
  return {
    busy,
    /** Why the icon cannot change right now, beyond the caller's own `disabled`. */
    blocked,
    customized,
    openFilePicker: () => setFilePickerOpen(true),
    reset: () => void save({ faviconPath: null, projectIcon: null }),
    /** The compact icon picker, opened from `trigger`. */
    iconPicker: (trigger: ReactElement, tooltip?: string) => (
      <ProjectIconPicker
        trigger={trigger}
        tooltip={tooltip}
        current={project.projectIcon ?? null}
        customized={customized}
        projectName={project.title}
        disabled={locked}
        onSelect={(icon) => save({ faviconPath: null, projectIcon: icon })}
        onReset={() => save({ faviconPath: null, projectIcon: null })}
        onChooseImage={() => setFilePickerOpen(true)}
      />
    ),
    dialogs,
  };
}

/** The project's icon as a button that opens the icon picker. */
export function ProjectIconButton({
  project,
  checkouts,
  disabled,
  className,
}: {
  project: EnvironmentProject;
  checkouts?: readonly EnvironmentProject[];
  disabled: boolean;
  className?: string;
}) {
  const editor = useProjectIconEditor({
    project,
    ...(checkouts ? { checkouts } : {}),
    disabled,
  });
  const icon = <ProjectFavicon project={project} className={className} />;
  if (disabled || editor.blocked) return icon;
  return (
    <>
      {editor.iconPicker(
        <button
          type="button"
          className="project-icon-button"
          aria-label={`Change the icon for ${project.title}`}
        >
          {icon}
        </button>,
        "Change project icon",
      )}
      {editor.dialogs}
    </>
  );
}
