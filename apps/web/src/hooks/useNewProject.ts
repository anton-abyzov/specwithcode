import { scopeProjectRef } from "@specweave-studio/client-runtime/environment";
import { getNewProjectGitHubRepository } from "@specweave-studio/client-runtime/operations/projects";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@specweave-studio/client-runtime/state/runtime";
import type { EnvironmentId, ProjectIconOverride } from "@specweave-studio/contracts";
import { useCallback } from "react";
import { useNavigate } from "@tanstack/react-router";
import {
  deriveLogicalProjectKeyFromSettings,
  selectProjectGroupingSettings,
} from "../logicalProject";
import { useClientSettings } from "./useSettings";
import { findFolderCopies, type FolderToAdd } from "../studio/folderLinkSuggestion";
import { projectLink } from "../studio/projectLink";
import {
  isPersonalAssistantDisabledError,
  personalAssistantDisabledMessage,
} from "../studio/personalAssistant";

import {
  createFailureDescription,
  createFailureNeedsGit,
  nothingPushedDescription,
  notOpenedDescription,
  projectWhere,
  publishFailureDescription,
  type ProjectMachineName,
} from "../studio/newProjectMessages";
import { isThisMachineTarget } from "../connection/desktopLocal";

import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import { requestMachineToolInstall } from "~/components/machineTools/machineToolInstallRequest";
import { useNamedEnvironments } from "~/components/settings/useNamedEnvironments";
import { useProjects, waitForProject } from "~/state/entities";
import { projectEnvironment } from "~/state/projects";
import { sourceControlEnvironment } from "~/state/sourceControl";
import { useAtomCommand } from "~/state/use-atom-command";
import { useOrchestrationCommand } from "~/state/use-orchestration-command";
import { useNewThreadHandler } from "./useHandleNewThread";

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.trim().length > 0
    ? error.message
    : "An error occurred.";
}

/**
 * Starts a project in the chosen parent folder (or managed storage for Personal
 * and older callers). The server makes a new child folder with a README, an icon, and a first commit,
 * or uses the chosen folder as-is when it is already a project; this then
 * opens a new thread draft in it. With `github`, it also publishes the
 * repository as private, without holding up the draft.
 *
 * Resolves to whether the project was created.
 */
export function useNewProject() {
  const navigate = useNavigate();
  const clientSettings = useClientSettings();
  const { environments } = useNamedEnvironments();
  const createNew = useAtomCommand(projectEnvironment.createNew, { reportFailure: false });
  const updateProject = useOrchestrationCommand(projectEnvironment.update, {
    reportFailure: false,
  });
  const publishRepository = useAtomCommand(sourceControlEnvironment.publishRepository, {
    reportFailure: false,
  });
  const handleNewThread = useNewThreadHandler();

  const publishToGitHub = useCallback(
    async (input: {
      readonly environmentId: EnvironmentId;
      readonly workspaceRoot: string;
      readonly account: string | null;
      readonly machine: ProjectMachineName;
      readonly commitError?: string | undefined;
    }) => {
      const repositoryName = getNewProjectGitHubRepository(input, input.workspaceRoot);
      const result = await publishRepository({
        environmentId: input.environmentId,
        input: {
          cwd: input.workspaceRoot,
          provider: "github",
          repository: repositoryName,
          visibility: "private",
        },
      });
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result)) {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Could not create the GitHub repository",
              description: `${publishFailureDescription(squashAtomCommandFailure(result), input.machine, repositoryName)} Use Publish Repository in the Git menu to try again.`,
            }),
          );
        }
        return;
      }
      const { repository, status } = result.value;
      toastManager.add(
        stackedThreadToast(
          // Without a first commit the server only adds the remote.
          status === "remote_added"
            ? {
                type: "warning",
                title: "GitHub repository created, nothing pushed yet",
                description: nothingPushedDescription({
                  repository: repository.nameWithOwner,
                  commitError: input.commitError,
                }),
              }
            : {
                type: "success",
                title: "Published to GitHub",
                description: repository.nameWithOwner,
              },
        ),
      );
    },
    [publishRepository],
  );

  return useCallback(
    async (input: {
      readonly environmentId: EnvironmentId;
      readonly name: string;
      readonly parentPath?: string;
      readonly kind?: "code" | "personal";
      readonly github: { readonly account: string | null } | null;
      /** "Use SpecWeave" was ticked: run `specweave init` before the first commit. */
      readonly specweave?: boolean;
      /** The icon chosen for a new assistant; the server's own starting icon stays without it. */
      readonly icon?: ProjectIconOverride;
    }): Promise<boolean> => {
      const result = await createNew({
        environmentId: input.environmentId,
        input: {
          name: input.name,
          kind: input.kind ?? "code",
          ...(input.parentPath ? { parentPath: input.parentPath } : {}),
          ...(input.specweave === true ? { specweave: true } : {}),
        },
      });
      const environment = environments.find(
        (candidate) => candidate.environmentId === input.environmentId,
      );
      // The machine is named whenever the project is not on this device.
      const machine: ProjectMachineName =
        environment === undefined || isThisMachineTarget(environment.entry)
          ? null
          : environment.label;
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result)) {
          const failure = squashAtomCommandFailure(result);
          // No Git there: the install is one click away, on that machine.
          const needsGit = createFailureNeedsGit(failure);
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Could not create the project",
              ...(needsGit
                ? {
                    timeout: 0,
                    actionProps: {
                      children: "Install Git",
                      onClick: () =>
                        requestMachineToolInstall({
                          environmentId: input.environmentId,
                          tool: "git",
                          machineLabel: machine,
                        }),
                    },
                    actionVariant: "outline" as const,
                  }
                : {}),
              // Machines keep their own Percy switch: name the one that refused.
              description: isPersonalAssistantDisabledError(failure)
                ? personalAssistantDisabledMessage(
                    environments.find(
                      (environment) => environment.environmentId === input.environmentId,
                    )?.label,
                  )
                : createFailureDescription(failure, machine),
            }),
          );
        }
        return false;
      }

      const { projectId, workspaceRoot, commitError, existing, specweaveError } = result.value;
      // The chosen icon goes on with the same update a later icon change uses, so
      // any server takes it. If it fails the assistant keeps its starting icon.
      if (input.kind === "personal" && input.icon !== undefined && existing !== true) {
        await updateProject({
          environmentId: input.environmentId,
          input: { projectId, projectIcon: input.icon },
        });
      }
      // Confirm the actual folder, including any collision suffix. An existing
      // project is confirmed once it is read, under its own title.
      if (existing !== true)
        toastManager.add(
          stackedThreadToast(
            commitError === undefined
              ? {
                  type: "success",
                  title:
                    input.kind === "personal"
                      ? "Personal assistant ready"
                      : `Created ${input.name}`,
                  description: projectWhere(workspaceRoot, machine),
                }
              : {
                  type: "warning",
                  title: `Created ${input.name} without a first commit`,
                  description: `${commitError} The project is in ${projectWhere(workspaceRoot, machine)}.`,
                },
          ),
        );
      if (input.specweave === true && input.kind !== "personal") {
        const { specweaveAdded } = result.value;
        if (specweaveError !== undefined) {
          const needsNode = result.value.specweaveNeedsNode === true;
          toastManager.add(
            stackedThreadToast({
              type: "warning",
              title: "SpecWeave was not set up",
              description: needsNode
                ? "SpecWeave needs Node.js, which this machine does not have. Install it, then retry from Project settings > General."
                : `${specweaveError.replace(/[.\s]*$/, ".")} You can retry from Project settings > General.`,
              ...(needsNode
                ? {
                    timeout: 0,
                    actionProps: {
                      children: "Install Node.js",
                      onClick: () =>
                        requestMachineToolInstall({
                          environmentId: input.environmentId,
                          tool: "node",
                          machineLabel: machine,
                        }),
                    },
                    actionVariant: "outline" as const,
                  }
                : {}),
            }),
          );
        } else if (existing === true && specweaveAdded === true) {
          toastManager.add(
            stackedThreadToast({
              type: "success",
              title: "SpecWeave was added to the existing folder",
              description: "Its files are in the folder, not committed yet.",
            }),
          );
        }
      }
      // An existing folder keeps its own remotes; publishing is for new repositories.
      if (input.kind !== "personal" && input.github && existing !== true) {
        void publishToGitHub({
          environmentId: input.environmentId,
          workspaceRoot,
          account: input.github.account,
          machine,
          commitError,
        });
      }

      const projectRef = scopeProjectRef(input.environmentId, projectId);
      // Drafts key off the project's stored path, so wait for the create event
      // to reach the store before opening one.
      const project = await waitForProject(projectRef).catch((error: unknown) => {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Failed to open project",
            description: `${errorMessage(error)} It will appear in the sidebar once this client catches up.`,
          }),
        );
        return null;
      });
      // An existing project keeps its own title, which may differ from the name typed.
      const title = existing === true ? (project?.title ?? input.name) : input.name;
      if (existing === true) {
        toastManager.add(
          stackedThreadToast({
            type: "success",
            title: `Opened ${title} in its existing folder`,
            description: projectWhere(workspaceRoot, machine),
          }),
        );
      }
      if (project === null) return true;
      if (input.kind === "personal") {
        await navigate({
          to: "/projects/$projectKey",
          params: {
            projectKey: deriveLogicalProjectKeyFromSettings(
              project,
              selectProjectGroupingSettings(clientSettings),
            ),
          },
        });
        return true;
      }
      // The dialog closes either way, so a project that is not opened is said, never silent.
      const reportNotOpened = () =>
        toastManager.add(
          stackedThreadToast({
            type: "info",
            title: `${title} is ready`,
            description: notOpenedDescription({ title, workspaceRoot, machine }),
          }),
        );
      await handleNewThread(projectRef, { onNotOpened: reportNotOpened }).catch(
        (error: unknown) => {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Failed to open project",
              description: errorMessage(error),
            }),
          );
        },
      );
      return true;
    },
    [
      createNew,
      updateProject,
      environments,
      handleNewThread,
      publishToGitHub,
      navigate,
      clientSettings,
    ],
  );
}

/**
 * Add folder: finds copies of the folder on other connected machines that can
 * link. Resolves to no matches at once when no such machine is connected, and
 * leaves out any machine that fails or is slow; it never links on its own.
 */
export function useFindFolderCopies() {
  const { environments } = useNamedEnvironments();
  const projects = useProjects();
  const readFingerprint = useAtomCommand(projectLink.fingerprint, {
    reportFailure: false,
    reportDefect: false,
  });
  return useCallback(
    (folder: FolderToAdd) =>
      findFolderCopies({
        folder,
        machines: environments.map((environment) => ({
          environmentId: environment.environmentId,
          label: environment.label,
          connected: environment.connection.phase === "connected",
          supportsLink: environment.serverConfig?.environment.capabilities.projectLink,
        })),
        projects,
        read: async (environmentId, input) => {
          const result = await readFingerprint({ environmentId, input });
          return result._tag === "Success" ? result.value.fingerprint : null;
        },
      }),
    [environments, projects, readFingerprint],
  );
}
