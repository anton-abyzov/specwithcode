import { scopeProjectRef } from "@specweave-studio/client-runtime/environment";
import { availableScratchWorkspaceRoot } from "@specweave-studio/client-runtime/operations/projects";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@specweave-studio/client-runtime/state/runtime";
import type { EnvironmentProject } from "@specweave-studio/client-runtime/state/shell";
import { AuthOrchestrationOperateScope, type EnvironmentId } from "@specweave-studio/contracts";
import { readEnvironmentScope } from "../state/session";
import { useRouter } from "@tanstack/react-router";
import { useCallback } from "react";

import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import { useEnvironments } from "~/state/environments";
import { projectEnvironment } from "~/state/projects";
import { useAtomCommand } from "~/state/use-atom-command";
import { useNewThreadHandler } from "./useHandleNewThread";
import { defaultProjectMachine } from "../studio/projectCreation";

// Different new-thread surfaces share one router and must respect the latest host intent.
const latestScratchRequestByRouter = new WeakMap<object, symbol>();

function reportScratchFailure(title: string, error: unknown) {
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title,
      description: error instanceof Error ? error.message : "An error occurred.",
    }),
  );
}

/**
 * Threads without a project live in the environment's scratch project, a
 * plain folder the server owns (users see it as "No project"). The server
 * creates it on first use; after that it is an ordinary project on the
 * non-git path, and each thread gets its own subfolder.
 */
export function useScratchProject() {
  const router = useRouter();
  const { environments } = useEnvironments();
  const openScratch = useAtomCommand(projectEnvironment.openScratch, { reportFailure: false });
  const handleNewThread = useNewThreadHandler();

  /** The scratch folder of a connected environment, or null when it offers none. */
  const scratchWorkspaceRootFor = useCallback(
    (environmentId: EnvironmentId | null): string | null => {
      const environment = environments.find((entry) => entry.environmentId === environmentId);
      return environmentId !== null &&
        readEnvironmentScope(environmentId, AuthOrchestrationOperateScope)
        ? availableScratchWorkspaceRoot(environment?.connection.phase, environment?.serverConfig)
        : null;
    },
    [environments],
  );

  // A thread without a project starts on the machine the user is working on,
  // and only there. With no current machine (the hosted app with nothing
  // open), it starts on the one machine that offers it, never a silent pick.
  const scratchEnvironmentId = useCallback(
    (current: EnvironmentId | null): EnvironmentId | null => {
      const offering = environments.filter(
        (entry) => scratchWorkspaceRootFor(entry.environmentId) !== null,
      );
      return defaultProjectMachine(
        current,
        offering.map((entry) => entry.environmentId),
      );
    },
    [environments, scratchWorkspaceRootFor],
  );

  /** Resolves to the scratch project once it is in this client's store. */
  const openScratchProject = useCallback(
    async (
      environmentId: EnvironmentId,
      failureTitle = "Could not start without a project",
    ): Promise<EnvironmentProject | null> => {
      const result = await openScratch({ environmentId, input: {} });
      if (result._tag === "Success") return result.value;
      if (!isAtomCommandInterrupted(result)) {
        reportScratchFailure(failureTitle, squashAtomCommandFailure(result));
      }
      return null;
    },
    [openScratch],
  );

  const startScratchThread = useCallback(
    async (environmentId: EnvironmentId) => {
      const request = Symbol();
      latestScratchRequestByRouter.set(router, request);
      const requestingLocation = router.state.location;
      const requestingHref = requestingLocation.href;
      const project = await openScratchProject(environmentId);
      // The normal draft handler's route guard begins after this await. Preserve
      // navigation (including away and back) and newer Scratch requests here.
      if (
        latestScratchRequestByRouter.get(router) !== request ||
        router.state.location !== requestingLocation ||
        router.state.location.href !== requestingHref
      )
        return;
      if (project) {
        // Scratch is a server-owned plain folder, even when Git projects default to worktrees.
        await handleNewThread(scopeProjectRef(project.environmentId, project.id), {
          envMode: "local",
        }).catch((error: unknown) =>
          reportScratchFailure("Could not start without a project", error),
        );
      }
    },
    [handleNewThread, openScratchProject, router],
  );

  return { scratchWorkspaceRootFor, scratchEnvironmentId, openScratchProject, startScratchThread };
}
