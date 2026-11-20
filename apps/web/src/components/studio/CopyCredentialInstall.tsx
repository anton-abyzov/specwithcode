/**
 * "Install there": runs a missing tool's install on the destination machine,
 * in the terminal panel that agent installs and sign-ins use, so the person
 * sees its log and can answer what an installer asks.
 *
 * The command is the destination's own, from its answer about the tool, and
 * is shown above the button before anything runs. Only a connection that may
 * operate that machine's terminal sees the button; nothing installs without
 * the click.
 *
 * The install outlives its panel: a row that closes, or changes after a
 * check, leaves it running on that machine. Until it lands the row says so,
 * checks again by itself (`CopyCredentialInstallWatch`, mounted with the row
 * open or closed) and offers no second install. It is filed per tool and per
 * command: another project's install of the same tool is another install.
 */
import { useAtomValue } from "@effect/atom-react";
import {
  AuthTerminalOperateScope,
  type EnvironmentId,
  type ProviderInstanceId,
} from "@specweave-studio/contracts";
import { useEffect, useRef, useState } from "react";

import { useTx } from "../../i18n";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentScope } from "../../state/session";
import { AgentSetupPanel, useDetachedInstall } from "../onboarding/AgentSetupPanel";
import { Button } from "../ui/button";

/** How often a row checks for an install it left running. */
export const LEFT_RUNNING_CHECK_MS = 15_000;

/**
 * The install's name on that machine: the tool, and a short mark of the
 * command. The same tool installed by another command (another project's
 * folder) is not this install, and does not hold this row's button.
 */
export function installAgent(tool: string, command: string): string {
  let mark = 0x811c9dc5;
  for (let index = 0; index < command.length; index += 1) {
    mark ^= command.charCodeAt(index);
    mark = Math.imul(mark, 0x01000193);
  }
  return `credential-tool-${tool}-${(mark >>> 0).toString(36)}`;
}

/**
 * Waits for an install the row left running: checks the row again every so
 * often, and stops waiting when the tool is there (no install is offered any
 * more) or when the wait runs out. Renders nothing, so the row can keep it
 * mounted while its steps are closed.
 */
export function CopyCredentialInstallWatch({
  environmentId,
  tool,
  command,
  paused,
  onCheck,
}: {
  readonly environmentId: EnvironmentId;
  readonly tool: string;
  /** The install the row offers now, or null when it offers none. */
  readonly command: string | null;
  /** A check of this row is running: no second one is started on top. */
  readonly paused: boolean;
  readonly onCheck: () => void;
}) {
  // The last install offered: the one a row that no longer offers any may have left running.
  const [offered, setOffered] = useState(command);
  if (command !== null && command !== offered) setOffered(command);
  const { until, forget } = useDetachedInstall(
    environmentId,
    installAgent(tool, offered ?? "") as ProviderInstanceId,
  );
  const live = useRef({ paused, onCheck });
  useEffect(() => {
    live.current = { paused, onCheck };
  }, [onCheck, paused]);
  useEffect(() => {
    if (until === null) return;
    // The tool is there, or the wait ran out with the row away: nothing is left to wait for.
    if (command === null || Date.now() >= until) {
      forget();
      return;
    }
    // An install that never lands gives the button back.
    const timer = setInterval(() => {
      if (Date.now() >= until) forget();
      else if (!live.current.paused) live.current.onCheck();
    }, LEFT_RUNNING_CHECK_MS);
    return () => clearInterval(timer);
  }, [command, forget, until]);
  return null;
}

export function CopyCredentialInstall({
  environmentId,
  tool,
  command,
  disabled,
  onEnded,
}: {
  readonly environmentId: EnvironmentId;
  /** The tool's name, for the panel's "Installing wrangler" line. */
  readonly tool: string;
  readonly command: string;
  readonly disabled: boolean;
  /** The install ended or its panel was closed: time to check the row again. */
  readonly onEnded: () => void;
}) {
  const tx = useTx();
  const serverConfig = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const canOperateTerminal = useEnvironmentScope(environmentId, AuthTerminalOperateScope);
  const [running, setRunning] = useState(false);
  const agent = installAgent(tool, command);
  // The panel files an install it left running under the session's agent name.
  const { until, forget } = useDetachedInstall(environmentId, agent as ProviderInstanceId);
  const leftRunning = until !== null && !running;
  if (serverConfig === null || !canOperateTerminal) return null;
  return (
    <>
      <Button
        variant="outline"
        size="xs"
        disabled={disabled || running || leftRunning}
        data-slot="copy-credential-install"
        onClick={() => setRunning(true)}
      >
        {tx("Install there")}
      </Button>
      {leftRunning && (
        <p
          className="text-xs text-muted-foreground"
          role="status"
          data-slot="copy-credential-install-running"
        >
          {tx("The install is still running on that machine. This row updates when it is done.")}
        </p>
      )}
      {running && (
        <AgentSetupPanel
          session={{
            environmentId,
            agent,
            agentName: tool,
            cwd: serverConfig.cwd,
            command,
            purpose: "install",
            keybindings: serverConfig.keybindings,
          }}
          // A row that closes or changes mid-install leaves the install to finish.
          keepInstallRunning
          onClose={() => {
            setRunning(false);
            forget();
            onEnded();
          }}
          // A failed install keeps its log on screen; one that worked makes room for the row.
          onEnded={(succeeded) => {
            if (!succeeded) return;
            setRunning(false);
            onEnded();
          }}
        />
      )}
    </>
  );
}
