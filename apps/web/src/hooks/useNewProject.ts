import { scopeProjectRef } from "@specweave-studio/client-runtime/environment";
import { getNewProjectGitHubRepository } from "@specweave-studio/client-runtime/operations/projects";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@specweave-studio/client-runtime/state/runtime";
import type { EnvironmentId } from "@specweave-studio/contracts";
import { useCallback } from "react";
import { useNavigate } from "@tanstack/react-router";
import {
  deriveLogicalProjectKeyFromSettings,
  selectProjectGroupingSettings,
} from "../logicalProject";
import { useClientSettings } from "./useSettings";
import { findFolderCopies, type FolderToAdd } from "../studio/folderLinkSuggestion";
import { projectLink } from "../studio/projectLink";

import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import { useEnvironments } from "~/state/environments";
import { useProjects, waitForProject } from "~/state/entities";
import { projectEnvironment } from "~/state/projects";
import { sourceControlEnvironment } from "~/state/sourceControl";
import { useAtomCommand } from "~/state/use-atom-command";
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
  const createNew = useAtomCommand(projectEnvironment.createNew, { reportFailure: false });
  const publishRepository = useAtomCommand(sourceControlEnvironment.publishRepository, {
    reportFailure: false,
  });
  const handleNewThread = useNewThreadHandler();

  const publishToGitHub = useCallback(
    async (input: {
      readonly environmentId: EnvironmentId;
      readonly workspaceRoot: string;
      readonly account: string | null;
    }) => {
      const result = await publishRepository({
        environmentId: input.environmentId,
        input: {
          cwd: input.workspaceRoot,
          provider: "github",
          repository: getNewProjectGitHubRepository(input, input.workspaceRoot),
          visibility: "private",
        },
      });
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result)) {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Could not create the GitHub repository",
              description: `${errorMessage(squashAtomCommandFailure(result))} Use Publish Repository in the Git menu to try again.`,
            }),
          );
        }
        return;
      }
      toastManager.add(
        stackedThreadToast({
          type: "success",
          title: "Published to GitHub",
          description: result.value.repository.nameWithOwner,
        }),
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
    }): Promise<boolean> => {
      const result = await createNew({
        environmentId: input.environmentId,
        input: {
          name: input.name,
          kind: input.kind ?? "code",
          ...(input.parentPath ? { parentPath: input.parentPath } : {}),
        },
      });
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result)) {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Could not create the project",
              description: errorMessage(squashAtomCommandFailure(result)),
            }),
          );
        }
        return false;
      }

      const { projectId, workspaceRoot, commitError, existing } = result.value;
      // Confirm the actual folder, including any collision suffix.
      toastManager.add(
        stackedThreadToast(
          existing === true
            ? {
                type: "success",
                title: `Opened ${input.name} in its existing folder`,
                description: workspaceRoot,
              }
            : commitError === undefined
              ? {
                  type: "success",
                  title:
                    input.kind === "personal"
                      ? "Personal assistant ready"
                      : `Created ${input.name}`,
                  description: workspaceRoot,
                }
              : {
                  type: "warning",
                  title: `Created ${input.name} without a first commit`,
                  description: `${commitError} The project is in ${workspaceRoot}.`,
                },
        ),
      );
      // An existing folder keeps its own remotes; publishing is for new repositories.
      if (input.kind !== "personal" && input.github && existing !== true) {
        void publishToGitHub({
          environmentId: input.environmentId,
          workspaceRoot,
          account: input.github.account,
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
      await handleNewThread(projectRef).catch((error: unknown) => {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Failed to open project",
            description: errorMessage(error),
          }),
        );
      });
      return true;
    },
    [createNew, handleNewThread, publishToGitHub, navigate, clientSettings],
  );
}

/**
 * Add folder: finds copies of the folder on other connected machines that can
 * link. Resolves to no matches at once when no such machine is connected, and
 * leaves out any machine that fails or is slow; it never links on its own.
 */
export function useFindFolderCopies() {
  const { environments } = useEnvironments();
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
