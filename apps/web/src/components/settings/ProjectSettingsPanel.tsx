import { useComposerMenuState } from "../chat/useComposerMenuState";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { AuthOrchestrationOperateScope, logicalProjectTitle } from "@specweave-studio/contracts";
import { useEnvironmentsWithScope, readEnvironmentScope } from "../../state/session";
import {
  isAtomCommandInterrupted,
  mapAtomCommandResult,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@specweave-studio/client-runtime/state/runtime";
import { scopeProjectRef, scopeThreadRef } from "@specweave-studio/client-runtime/environment";
import { AsyncResult } from "effect/reactivity";
import { type EnvironmentId, type ProjectIconOverride } from "@specweave-studio/contracts";
import { useLocation, useNavigate } from "@tanstack/react-router";
import * as Cause from "effect/Cause";
import { SparklesIcon, Trash2Icon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useComposerDraftStore } from "../../composerDraftStore";
import { releaseProjectDraftUploads } from "../../lib/composerDraftUploads";
import { useProjectDeletionConfirmation } from "../studio/useProjectDeletionConfirmation";
import {
  type SidebarProjectGroupMember,
  type SidebarProjectSnapshot,
} from "../../sidebarProjectGrouping";
import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import { readProjects, useThreadShells } from "../../state/entities";
import { projectEnvironment } from "../../state/projects";
import { ProjectLocation } from "../studio/ProjectLocation";
import { ProjectMachinesSettings } from "../studio/ProjectMachinesSettings";
import { ProjectFavicon } from "../ProjectFavicon";
import { Button } from "../ui/button";
import { InputGroup, InputGroupAddon, InputGroupInput } from "../ui/input-group";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import {
  canPickExternalProjectFavicon,
  ProjectFaviconPickerDialog,
} from "./ProjectFaviconPickerDialog";
import { ProjectActionsSettings } from "./ProjectActionsSettings";
import { ProjectIconPicker, useLatestIconSave } from "./ProjectIconPicker";
import { ProjectDefaultsSettings } from "./ProjectDefaultsSettings";
import { ProjectOverrides } from "./ProjectOverrides";
import { projectGroupTitleNeedsUpdate } from "./ProjectSettingsPanel.logic";
import { ProjectCheckoutMissing } from "./ProjectCheckoutMissing";
import { ProjectKeyFollowHold } from "./projectKeyFollow";
import { useSettingsProjectGroups } from "./useSettingsProjectGroups";
import { logicalCoordinator } from "../../studio/projectDomain";

function memberKey(member: { environmentId: string; id: string }): string {
  return `${member.environmentId}:${member.id}`;
}

/** `project` is the Projects page shortcut: the new-thread defaults people change most. */
export type ProjectSettingsCategory = "general" | "integrations" | "source-control" | "project";

const memberRef = (member: { environmentId: EnvironmentId; id: string }) =>
  `${member.environmentId}/${member.id}`;

export function ProjectSettingsPanel({
  projectKey,
  environmentId = null,
  checkoutKey = null,
}: {
  projectKey: string;
  environmentId?: EnvironmentId | null;
  checkoutKey?: string | null;
}) {
  const groups = useSettingsProjectGroups();
  const navigate = useNavigate({ from: "/settings" });
  const pathname = useLocation({ select: (location) => location.pathname });

  const { environments } = useEnvironments();
  const missingCheckoutEnvironments = useMemo(
    () =>
      environments.map((environment) => ({
        environmentId: environment.environmentId,
        label: environment.label,
        connected: environment.connection.phase === "connected",
      })),
    [environments],
  );
  // Remember the last rendered selection so a group key change (a grouping-rule change, or a
  // link that gives the project a shared identity) follows the same projects instead of
  // parking on the not-found state. Project refs are stable; group and physical keys are not.
  const lastSelectionRef = useRef<{
    requestedKey: string;
    environmentId: EnvironmentId | null;
    checkoutKey: string | null;
    memberRefs: string[];
    detailKey: string;
  } | null>(null);
  const last = lastSelectionRef.current;
  const followsLast =
    last !== null && last.environmentId === environmentId && last.checkoutKey === checkoutKey;
  const selected =
    groups.find((group) => group.projectKey === projectKey) ??
    (followsLast && last.requestedKey === projectKey
      ? (groups.find((group) =>
          group.memberProjects.some((member) => last.memberRefs.includes(memberRef(member))),
        ) ?? null)
      : null);
  const members = useMemo(
    () =>
      selected?.memberProjects.filter(
        (member) =>
          (environmentId === null || member.environmentId === environmentId) &&
          (checkoutKey === null || member.physicalProjectKey === checkoutKey),
      ) ?? [],
    [selected, environmentId, checkoutKey],
  );

  const memberRefs = members.map(memberRef);
  // The same projects under a new key keep the open page, so a dialog on it (the link
  // dialog's success step) survives the key change.
  const detailKey =
    followsLast && memberRefs.some((ref) => last.memberRefs.includes(ref))
      ? last.detailKey
      : `${selected?.projectKey}:${environmentId ?? "all"}:${checkoutKey ?? "all"}`;
  useEffect(() => {
    if (!selected || members.length === 0) return;
    lastSelectionRef.current = {
      requestedKey: projectKey,
      environmentId,
      checkoutKey,
      memberRefs: members.map(memberRef),
      detailKey,
    };
  }, [selected, members, projectKey, environmentId, checkoutKey, detailKey]);

  const [holds, setHolds] = useState(0);
  const hold = useCallback(() => {
    setHolds((count) => count + 1);
    return () => setHolds((count) => count - 1);
  }, []);
  // Point the address at the followed group's new key once no dialog holds the page.
  useEffect(() => {
    if (holds > 0 || !selected || selected.projectKey === projectKey) return;
    void navigate({
      to: pathname,
      search: () => ({
        project: selected.projectKey,
        machine: environmentId ?? undefined,
        checkout: checkoutKey ?? undefined,
      }),
      replace: true,
      hashScrollIntoView: false,
    });
  }, [holds, selected, navigate, pathname, projectKey, environmentId, checkoutKey]);

  if (!selected) {
    return (
      <div className="flex flex-1 items-center justify-center p-8 text-sm text-muted-foreground">
        {groups.length === 0
          ? "Add a project from the sidebar to configure it here."
          : "This project is no longer available."}
      </div>
    );
  }
  if (members.length === 0)
    return (
      <SettingsPageContainer>
        <ProjectCheckoutMissing
          group={selected}
          environments={missingCheckoutEnvironments}
          environmentId={environmentId}
          checkoutKey={checkoutKey}
          onPick={(search) =>
            void navigate({
              to: pathname,
              search: () => ({
                project: search.project,
                machine: search.machine,
                checkout: undefined,
              }),
              hash: "",
              resetScroll: false,
            })
          }
        />
      </SettingsPageContainer>
    );
  const scopedGroup = {
    ...selected,
    memberProjects: members,
    environmentId: members[0]!.environmentId,
    id: members[0]!.id,
  };
  return (
    <ProjectKeyFollowHold.Provider value={hold}>
      <ProjectDetail
        key={detailKey}
        group={scopedGroup}
        domainMembers={selected.memberProjects}
        hasOtherMembers={members.length < selected.memberProjects.length}
      />
    </ProjectKeyFollowHold.Provider>
  );
}

/** Project overrides that still live on their category page, reached with this project kept. */
function ProjectDetail({
  group,
  domainMembers,
  hasOtherMembers,
}: {
  group: SidebarProjectSnapshot;
  domainMembers: readonly SidebarProjectGroupMember[];
  hasOtherMembers: boolean;
}) {
  const navigate = useNavigate({ from: "/settings" });
  const { confirmDeletion, deletionDialog } = useProjectDeletionConfirmation();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const { environments } = useEnvironments();
  const environmentById = useMemo(
    () => new Map(environments.map((environment) => [environment.environmentId, environment])),
    [environments],
  );
  const editableIds = useEnvironmentsWithScope(group.memberProjects, AuthOrchestrationOperateScope);
  const canEditGroup = group.memberProjects.every((member) =>
    editableIds.has(member.environmentId),
  );
  // A checkout filter only scopes physical settings; the logical name belongs to its active owner.
  const ownership = logicalCoordinator(domainMembers);
  const nameOwner = ownership?.member;
  const nameEditableIds = useEnvironmentsWithScope(domainMembers, AuthOrchestrationOperateScope);
  const nameEnvironment = nameOwner ? environmentById.get(nameOwner.environmentId) : undefined;
  const nameProblem = ownership
    ? (ownership.problem ??
      (!nameOwner
        ? "The active coordinator is unavailable. Reconnect its machine to rename this project."
        : nameEnvironment?.connection.phase !== "connected" || !nameEnvironment.serverConfig
          ? `Connect ${nameOwner.environmentLabel ?? "the active coordinator machine"} to rename this project.`
          : !nameEditableIds.has(nameOwner.environmentId)
            ? "The active coordinator connection needs permission to rename this project."
            : null))
    : null;
  const canEditName = ownership ? nameProblem === null : canEditGroup;
  const displayName = nameOwner ? logicalProjectTitle(nameOwner) : group.displayName;
  const representative =
    group.memberProjects.find(
      (member) => environmentById.get(member.environmentId)?.serverConfig != null,
    ) ?? group.memberProjects[0]!;
  const threads = useThreadShells();
  const updateProject = useOrchestrationCommand(projectEnvironment.update, {
    reportFailure: false,
  });
  const deleteProject = useOrchestrationCommand(projectEnvironment.delete, {
    reportFailure: false,
  });
  const projectNameEditedRef = useRef(false);

  const projectIcon = representative.projectIcon ?? null;
  const pickProjectFavicon =
    typeof window !== "undefined" &&
    group.memberProjects.every(
      (member) =>
        member.environmentId === primaryEnvironmentId &&
        canPickExternalProjectFavicon(member.workspaceRoot, navigator.platform),
    )
      ? window.desktopBridge?.pickProjectFavicon
      : undefined;

  const reportFailure = useCallback((title: string, result: AtomCommandResult<void, unknown>) => {
    if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return;
    const error = squashAtomCommandFailure(result);
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title,
        description: error instanceof Error ? error.message : "An error occurred.",
      }),
    );
  }, []);

  const checkProjectAccess = useCallback(
    (members: ReadonlyArray<SidebarProjectGroupMember>, failureTitle: string) => {
      const denied = members.find(
        (member) => !readEnvironmentScope(member.environmentId, AuthOrchestrationOperateScope),
      );
      if (!denied) return null;
      const result = AsyncResult.failure<void, Error>(
        Cause.fail(
          new Error(
            `This connection cannot change projects in ${denied.environmentLabel ?? "this environment"}.`,
          ),
        ),
      );
      reportFailure(failureTitle, result);
      return result;
    },
    [reportFailure],
  );

  // Group-shared fields live on each physical project record, so a
  // group-level edit fans out to every member.
  const updateAllMembers = useCallback(
    async (
      input: Partial<{
        title: string;
        faviconPath: string | null;
        projectIcon: ProjectIconOverride | null;
        workspaceSettings: { expectedRevision: number };
      }>,
      failureTitle: string,
      members: ReadonlyArray<SidebarProjectGroupMember> = group.memberProjects,
    ): Promise<AtomCommandResult<void, unknown>> => {
      const denied = checkProjectAccess(members, failureTitle);
      if (denied) return denied;
      const unavailable = members.find((member) => {
        const environment = environmentById.get(member.environmentId);
        return environment?.connection.phase !== "connected" || !environment.serverConfig;
      });
      if (unavailable) {
        const error = new Error(
          `Connect ${unavailable.environmentLabel ?? "the selected environment"} and try again.`,
        );
        const result: AtomCommandResult<void, unknown> = AsyncResult.failure(Cause.fail(error));
        reportFailure(failureTitle, result);
        return result;
      }
      for (const member of members) {
        const revoked = checkProjectAccess([member], failureTitle);
        if (revoked) return revoked;
        const result = mapAtomCommandResult(
          await updateProject({
            environmentId: member.environmentId,
            input: { projectId: member.id, ...input },
          }),
          () => undefined,
        );
        if (result._tag === "Failure") {
          // A partial fan-out is possible: earlier members already took the
          // write. Name the environment so the user knows where it stopped.
          reportFailure(
            members.length > 1
              ? `${failureTitle} on ${member.environmentLabel ?? "the current environment"}`
              : failureTitle,
            result,
          );
          return result;
        }
      }
      return AsyncResult.success(undefined);
    },
    [checkProjectAccess, environmentById, group.memberProjects, reportFailure, updateProject],
  );

  const renameGroup = useCallback(
    async (nextTitle: string, wasEdited: boolean) => {
      const title = nextTitle.trim();
      if (!title) {
        toastManager.add({ type: "warning", title: "Project title cannot be empty" });
        return;
      }
      if (
        !projectGroupTitleNeedsUpdate(
          ownership ? [displayName] : group.memberProjects.map((member) => member.title),
          title,
          wasEdited,
        )
      ) {
        return;
      }
      if (ownership) {
        if (nameProblem || !nameOwner) {
          reportFailure(
            "Failed to rename project",
            AsyncResult.failure(
              Cause.fail(new Error(nameProblem ?? "The active coordinator is unavailable.")),
            ),
          );
          return;
        }
        const currentOwner = logicalCoordinator(
          readProjects().filter(
            (member) =>
              member.workspaceSettings?.logicalProject?.id ===
              nameOwner.workspaceSettings?.logicalProject?.id,
          ),
        );
        if (
          !currentOwner?.member ||
          currentOwner.problem ||
          memberKey(currentOwner.member) !== memberKey(nameOwner) ||
          currentOwner.member.workspaceSettings?.coordinatorBinding?.epoch !==
            nameOwner.workspaceSettings?.coordinatorBinding?.epoch
        ) {
          reportFailure(
            "Failed to rename project",
            AsyncResult.failure(
              Cause.fail(
                new Error(
                  currentOwner?.problem ??
                    "Coordinator ownership changed. Reopen project settings before renaming.",
                ),
              ),
            ),
          );
          return;
        }
        await updateAllMembers(
          { title, workspaceSettings: { expectedRevision: nameOwner.workspaceSettings!.revision } },
          "Failed to rename project",
          [nameOwner],
        );
        return;
      }
      await updateAllMembers({ title }, "Failed to rename project");
    },
    [
      group.memberProjects,
      updateAllMembers,
      ownership,
      nameOwner,
      nameProblem,
      displayName,
      reportFailure,
    ],
  );

  // ----- project icon -----
  const [faviconPickerOpen, setFaviconPickerOpen] = useComposerMenuState(!canEditGroup);
  // Picks made while a save is in flight collapse to the latest one.
  const setProjectIcon = useLatestIconSave(
    async (input: { faviconPath: string | null; projectIcon: ProjectIconOverride | null }) =>
      (await updateAllMembers(input, "Failed to update project icon"))._tag !== "Failure",
  );
  const iconCustomized = group.memberProjects.some(
    (member) => member.faviconPath != null || member.projectIcon != null,
  );

  const hasMultipleCheckouts = group.memberProjects.length > 1;

  const removeMembers = useCallback(
    async (members: ReadonlyArray<SidebarProjectGroupMember>) => {
      if (checkProjectAccess(members, "Failed to remove project")) return;
      const memberKeys = new Set(members.map(memberKey));
      const projectThreads = threads.filter((thread) =>
        memberKeys.has(`${thread.environmentId}:${thread.projectId}`),
      );
      const isWholeGroup = members.length === group.memberProjects.length;
      const confirmations = new Map<string, string>();
      for (const member of members) {
        const typed = await confirmDeletion(member);
        if (typed !== member.title) return;
        confirmations.set(memberKey(member), typed);
      }
      if (checkProjectAccess(members, "Failed to remove project")) return;

      const draftStore = useComposerDraftStore.getState();
      let removed = 0;
      for (const member of members) {
        if (checkProjectAccess([member], "Failed to remove project")) return;
        const memberThreads = projectThreads.filter(
          (thread) =>
            thread.environmentId === member.environmentId && thread.projectId === member.id,
        );
        const result = mapAtomCommandResult(
          await deleteProject({
            environmentId: member.environmentId,
            input: {
              projectId: member.id,
              force: true,
              confirmationTitle: confirmations.get(memberKey(member))!,
            },
          }),
          () => undefined,
        );
        if (result._tag === "Failure") {
          // The server limits how many projects go per minute, so say how far it got.
          reportFailure(
            removed === 0
              ? `Failed to remove "${member.title}"`
              : `Removed ${removed} of ${members.length}. Failed to remove "${member.title}"`,
            result,
          );
          return;
        }
        removed += 1;
        const projectRef = scopeProjectRef(member.environmentId, member.id);
        releaseProjectDraftUploads(
          projectRef,
          memberThreads.map((thread) => scopeThreadRef(thread.environmentId, thread.id)),
        );
        const projectDraftThread = draftStore.getDraftThreadByProjectRef(projectRef);
        if (projectDraftThread) {
          draftStore.clearDraftThread(projectDraftThread.draftId);
        }
        draftStore.clearProjectDraftThreadId(projectRef);
      }

      if (isWholeGroup && !hasOtherMembers) {
        void navigate({ to: "/", replace: true });
      }
    },
    [
      confirmDeletion,
      checkProjectAccess,
      deleteProject,
      group.memberProjects.length,
      hasOtherMembers,
      navigate,
      reportFailure,
      threads,
    ],
  );

  const checkoutChoices = (
    <SettingsSection title="Checkouts">
      {group.memberProjects.map((member) => (
        <SettingsRow
          key={member.physicalProjectKey}
          title={member.environmentLabel ?? "Environment"}
          description={<ProjectLocation path={member.workspaceRoot} />}
          control={
            <Button
              size="sm"
              variant="outline"
              disabled={!editableIds.has(member.environmentId)}
              onClick={() => void removeMembers([member])}
              aria-label={`Remove checkout ${member.workspaceRoot}`}
            >
              Remove
            </Button>
          }
        />
      ))}
    </SettingsSection>
  );

  return (
    <>
      {deletionDialog}
      <SettingsPageContainer className="gap-6">
        <SettingsSection id="project-overview" title="Project" hideTitle>
          {!canEditGroup ? (
            <p className="px-3 py-2 text-sm text-muted-foreground sm:px-4">
              {group.memberProjects.length > 1
                ? "Shared settings require permission to change every checkout in this group."
                : "This connection cannot change this project."}
            </p>
          ) : null}
          {nameProblem ? (
            <p className="px-3 py-2 text-sm text-muted-foreground" role="alert">
              {nameProblem}
            </p>
          ) : null}
          <SettingsRow
            title="Name and icon"
            description="Shown for this project group in the sidebar and thread lists."
            control={
              <InputGroup className="w-full sm:w-72">
                <InputGroupAddon>
                  <ProjectIconPicker
                    trigger={
                      <Button
                        size="icon-xs"
                        variant="ghost"
                        type="button"
                        aria-label="Change the project icon"
                      >
                        <ProjectFavicon project={representative} className="size-4" />
                      </Button>
                    }
                    tooltip="Change icon"
                    current={projectIcon}
                    customized={iconCustomized}
                    projectName={representative.title}
                    disabled={!canEditGroup}
                    onSelect={(icon) => setProjectIcon({ faviconPath: null, projectIcon: icon })}
                    onReset={() => setProjectIcon({ faviconPath: null, projectIcon: null })}
                    onChooseImage={() => setFaviconPickerOpen(true)}
                  />
                </InputGroupAddon>
                <InputGroupInput
                  key={`${group.projectKey}:${displayName}`}
                  size="sm"
                  aria-label="Project name"
                  disabled={!canEditName}
                  defaultValue={displayName}
                  onChange={() => {
                    projectNameEditedRef.current = true;
                  }}
                  onBlur={(event) => {
                    const wasEdited = projectNameEditedRef.current;
                    projectNameEditedRef.current = false;
                    void renameGroup(event.currentTarget.value, wasEdited);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") event.currentTarget.blur();
                  }}
                />
              </InputGroup>
            }
          />
          <SettingsRow
            title="Skills"
            description="Which skills each agent loads in this folder, with vskill versions and drift."
            control={
              <Button
                size="sm"
                variant="outline"
                type="button"
                onClick={() =>
                  void navigate({ to: "/settings/skills", hash: "", hashScrollIntoView: false })
                }
              >
                <SparklesIcon />
                Open skills
              </Button>
            }
          />
        </SettingsSection>
        <ProjectDefaultsSettings category="project" />
        <ProjectDefaultsSettings category="source-control" onProjectPage />
        <ProjectDefaultsSettings category="integrations" onProjectPage />
        <ProjectOverrides checkouts={group.memberProjects} />
        <ProjectMachinesSettings members={domainMembers} />
        <ProjectActionsSettings />
        {hasMultipleCheckouts ? checkoutChoices : null}
        <SettingsSection title="Danger">
          <SettingsRow
            title={
              hasOtherMembers
                ? "Remove checkout"
                : group.memberProjects.length > 1
                  ? "Remove this project everywhere"
                  : "Remove project"
            }
            description={
              hasOtherMembers
                ? "Deletes the selected machine's checkout entries and their threads. Other machines and files on disk are not touched."
                : group.memberProjects.length > 1
                  ? `Deletes all ${group.memberProjects.length} checkout entries and their threads on every machine. Files on disk are not touched.`
                  : "Deletes the project entry and its threads. Files on disk are not touched."
            }
            control={
              <Button
                size="sm"
                variant="destructive-outline"
                disabled={!canEditGroup}
                onClick={() => void removeMembers(group.memberProjects)}
              >
                <Trash2Icon />
                {hasOtherMembers
                  ? "Remove checkout"
                  : group.memberProjects.length > 1
                    ? "Remove all entries"
                    : "Remove project"}
              </Button>
            }
          />
        </SettingsSection>
      </SettingsPageContainer>

      <ProjectFaviconPickerDialog
        key={`${representative.environmentId}:${representative.workspaceRoot}:${faviconPickerOpen}`}
        cwd={representative.workspaceRoot}
        environmentId={representative.environmentId}
        onOpenChange={setFaviconPickerOpen}
        {...(pickProjectFavicon
          ? { onPickExternal: () => pickProjectFavicon(representative.workspaceRoot) }
          : {})}
        onSelect={(path) => void setProjectIcon({ faviconPath: path, projectIcon: null })}
        open={faviconPickerOpen && canEditGroup}
        projectName={group.displayName}
      />
    </>
  );
}
