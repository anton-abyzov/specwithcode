import type { EnvironmentId } from "@specweave-studio/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@specweave-studio/client-runtime/state/runtime";
import { Link } from "@tanstack/react-router";
import { ArchiveX, BotIcon } from "lucide-react";
import { useCallback, useMemo } from "react";

import { useTx } from "../../i18n";
import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import { useServerConfigs } from "../../state/entities";
import { projectEnvironment } from "../../state/projects";
import { useAtomCommand } from "../../state/use-atom-command";
import { useMachineNicknames } from "../../studio/machineNickname";
import {
  archiveWorkspacePatch,
  membersToMark,
  membersToToggle,
  originWorkspacePatch,
  partitionProjectGroups,
} from "../../studio/projectListVisibility";
import { Button } from "../ui/button";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { useSettingsProjectGroups } from "./useSettingsProjectGroups";

const isPersonalGroup = (group: SidebarProjectSnapshot) =>
  group.memberProjects.some((member) => member.workspaceSettings?.kind === "personal");

/**
 * Archived projects, and the projects checks and agents made for themselves, are kept
 * here instead of the sidebar: each opens from its name and moves back from its button.
 */
export function ArchivedProjectsSections() {
  const tx = useTx();
  const groups = useSettingsProjectGroups();
  const serverConfigs = useServerConfigs();
  const nicknames = useMachineNicknames();
  const updateProject = useAtomCommand(projectEnvironment.update, { reportFailure: false });
  const scratchRootFor = useCallback(
    (environmentId: EnvironmentId) =>
      serverConfigs.get(environmentId)?.scratchWorkspaceRoot ?? null,
    [serverConfigs],
  );
  const partition = useMemo(
    () => partitionProjectGroups(groups, scratchRootFor),
    [groups, scratchRootFor],
  );
  const archived = partition.archived.filter((group) => !isPersonalGroup(group));
  const automated = partition.automated.filter((group) => !isPersonalGroup(group));

  const apply = async (
    group: SidebarProjectSnapshot,
    members: ReadonlyArray<SidebarProjectSnapshot["memberProjects"][number]>,
    patch: (
      member: SidebarProjectSnapshot["memberProjects"][number],
    ) => ReturnType<typeof archiveWorkspacePatch>,
  ) => {
    for (const member of members) {
      const result = await updateProject({
        environmentId: member.environmentId,
        input: { projectId: member.id, workspaceSettings: patch(member) },
      });
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const cause = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: tx("Could not move {name}", { name: group.displayName }),
            description: cause instanceof Error ? cause.message : tx("Try again in a moment."),
          }),
        );
        return;
      }
    }
  };
  const restore = (group: SidebarProjectSnapshot) =>
    void apply(group, membersToToggle(group, false, scratchRootFor), (member) =>
      archiveWorkspacePatch(member, false),
    );
  const makeOwn = (group: SidebarProjectSnapshot) =>
    void apply(group, membersToMark(group, "user", scratchRootFor), (member) =>
      originWorkspacePatch(member, "user"),
    );

  const machinesOf = (group: SidebarProjectSnapshot) =>
    [
      ...new Set(
        group.memberProjects.map((member) => nicknames(member.environmentId) ?? member.environmentId),
      ),
    ].join(", ");

  const row = (group: SidebarProjectSnapshot, control: React.ReactNode, note: string) => (
    <SettingsRow
      key={group.projectKey}
      data-set-aside-project={group.projectKey}
      literal
      title={
        <Link
          to="/projects/$projectKey"
          params={{ projectKey: group.projectKey }}
          className="hover:underline"
        >
          {group.displayName}
        </Link>
      }
      description={`${note} · ${machinesOf(group)}`}
      control={control}
    />
  );

  return (
    <>
      {archived.length > 0 ? (
        <SettingsSection
          id="archived-projects"
          title={tx("Archived projects")}
          data-archived-projects=""
        >
          {archived.map((group) =>
            row(
              group,
              <Button
                type="button"
                variant="outline"
                size="xs"
                className="shrink-0"
                onClick={() => restore(group)}
              >
                <ArchiveX className="size-3.5" />
                <span>{tx("Restore")}</span>
              </Button>,
              tx("Archived"),
            ),
          )}
        </SettingsSection>
      ) : null}
      {automated.length > 0 ? (
        <SettingsSection
          id="automated-projects"
          title={tx("Made by checks and agents")}
          data-automated-projects=""
        >
          {automated.map((group) =>
            row(
              group,
              <Button
                type="button"
                variant="outline"
                size="xs"
                className="shrink-0"
                onClick={() => makeOwn(group)}
              >
                <BotIcon className="size-3.5" />
                <span>{tx("Move to your projects")}</span>
              </Button>,
              tx("Test and agent project"),
            ),
          )}
        </SettingsSection>
      ) : null}
    </>
  );
}
