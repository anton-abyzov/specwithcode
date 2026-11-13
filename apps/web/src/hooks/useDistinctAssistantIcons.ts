import {
  CommandId,
  type EnvironmentId,
  type ProjectIconOverride,
} from "@specweave-studio/contracts";
import {
  distinctAssistantIconPlan,
  type AssistantIconHolder,
} from "@specweave-studio/shared/assistantIcon";
import { useEffect, useRef } from "react";

import { projectEnvironment } from "../state/projects";
import { useOrchestrationCommand } from "../state/use-orchestration-command";

export interface AssistantIconMember {
  readonly id: string;
  readonly environmentId: EnvironmentId;
  readonly createdAt: string;
  readonly projectIcon?: ProjectIconOverride | null | undefined;
}

/** One change per assistant, ever: every window sends the same id, so a repeat changes nothing. */
export const distinctIconCommandId = (projectId: string) =>
  CommandId.make(`assistant-distinct-icon:v1:${projectId}`);

/** The changes to send now: none until every machine is connected, so all windows see the same assistants. */
export function distinctAssistantIconChanges(input: {
  readonly assistants: ReadonlyArray<AssistantIconMember>;
  readonly everyMachineConnected: boolean;
  readonly attempted: ReadonlySet<string>;
}) {
  if (!input.everyMachineConnected || input.assistants.length < 2) return [];
  const holders: ReadonlyArray<AssistantIconHolder> = input.assistants.map((assistant) => ({
    id: assistant.id,
    environmentId: assistant.environmentId,
    createdAt: assistant.createdAt,
    icon: assistant.projectIcon,
  }));
  return distinctAssistantIconPlan(holders).filter(
    (change) => !input.attempted.has(`${change.environmentId}:${change.id}`),
  );
}

/**
 * Assistants made before icons were chosen all carry the same bell. Once more
 * than one is listed, each after the earliest gets its own icon through the
 * ordinary project update. An icon a person chose is never changed.
 */
export function useDistinctAssistantIcons(
  assistants: ReadonlyArray<AssistantIconMember>,
  everyMachineConnected: boolean,
): void {
  const update = useOrchestrationCommand(projectEnvironment.update, { reportFailure: false });
  const attempted = useRef(new Set<string>());
  useEffect(() => {
    const changes = distinctAssistantIconChanges({
      assistants,
      everyMachineConnected,
      attempted: attempted.current,
    });
    for (const change of changes) {
      // Tried once per window: a machine that refuses keeps its icon without a retry loop.
      attempted.current.add(`${change.environmentId}:${change.id}`);
      void update({
        environmentId: change.environmentId as EnvironmentId,
        input: {
          projectId: change.id as never,
          commandId: distinctIconCommandId(change.id),
          projectIcon: change.icon as ProjectIconOverride,
        },
      });
    }
  }, [assistants, everyMachineConnected, update]);
}
