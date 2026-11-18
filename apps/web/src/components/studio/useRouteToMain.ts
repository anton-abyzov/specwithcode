import { useRef, useState } from "react";
import { squashAtomCommandFailure } from "@specweave-studio/client-runtime/state/runtime";
import {
  AuthOrchestrationOperateScope,
  CommandId,
  type EnvironmentId,
  type ProjectId,
} from "@specweave-studio/contracts";
import { randomUUID } from "../../lib/utils";
import { useEnvironment } from "../../state/environments";
import { useEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { projectWorkspace } from "../../studio/projectWorkspace";
import {
  canRouteToMain,
  routeTarget,
  routedCommand,
  ROUTED_FILES_MESSAGE,
  type HeldRoute,
} from "../../studio/routeToMain";

/**
 * A copy whose main is on another machine sends what is typed in its message box to main's
 * coordinator (`projects.coordinatorSend` on main's machine, with this window's operate
 * grant there), then shows main's page, where the answer comes. Files stay on the copy's
 * machine, so a draft holding files is refused with the reason, never sent without them.
 * Nothing starts on the copy itself.
 */
export function useRouteToMain(input: {
  /** Main's checkout, `environmentId:projectId`; null when this page is not a copy. */
  readonly mainKey: string | null;
  /** The copy's box is off because main is elsewhere. */
  readonly copyOff: boolean;
  /** Main is a live coordinator the resolver found, not a bare successor reference. */
  readonly mainLive: boolean;
  /** Shows main's page after the send; null until saved choices load. */
  readonly onOpen: ((key: string) => void) | null;
}): {
  readonly ready: boolean;
  /** Main's machine, where a routed message runs; null when this page is not a copy. */
  readonly environmentId: EnvironmentId | null;
  readonly sending: boolean;
  readonly send: (text: string, files?: readonly unknown[]) => Promise<void>;
} {
  const target = routeTarget(input.mainKey);
  const environmentId = (target?.environmentId ?? null) as EnvironmentId | null;
  const environment = useEnvironment(environmentId);
  const mayOperate = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  const sendCommand = useAtomCommand(projectWorkspace.send, { reportFailure: false });
  const [sending, setSending] = useState(false);
  const held = useRef<HeldRoute | null>(null);
  const ready = canRouteToMain({
    copyOff: input.copyOff,
    target,
    mainLive: input.mainLive,
    mainConnected: environment?.connection.phase === "connected",
    mayOperate,
  });
  const { mainKey, onOpen } = input;
  const send = async (text: string, files?: readonly unknown[]) => {
    if (!ready || !target || !mainKey) throw new Error("Main is not reachable from here.");
    // Refused before anything is sent: the draft keeps its text and files.
    if (files?.length) throw new Error(ROUTED_FILES_MESSAGE);
    const command = routedCommand(held.current, mainKey, text, randomUUID);
    held.current = command;
    setSending(true);
    const result = await sendCommand({
      environmentId: target.environmentId as EnvironmentId,
      input: {
        projectId: target.projectId as ProjectId,
        commandId: CommandId.make(command.commandId),
        prompt: text,
      },
    }).finally(() => setSending(false));
    if (result._tag === "Failure") {
      const cause = squashAtomCommandFailure(result);
      throw cause instanceof Error ? cause : new Error("Main did not confirm the message.");
    }
    held.current = null;
    onOpen?.(mainKey);
  };
  return { ready, environmentId, sending, send };
}
