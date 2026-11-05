import { useTx } from "../../i18n";
import { useAtomValue } from "@effect/atom-react";
import {
  AuthTerminalOperateScope,
  type EnvironmentId,
  ThreadId,
} from "@specweave-studio/contracts";
import { scopeThreadRef } from "@specweave-studio/client-runtime/environment";
import * as Schema from "effect/Schema";
import { TerminalIcon } from "lucide-react";
import { useCallback, useMemo } from "react";

import { TYPOGRAPHY_ADVANCED_STORAGE_KEY } from "../../appearanceFonts";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import { randomUUID } from "../../lib/utils";
import { serverEnvironment } from "../../state/server";
import { readEnvironmentScope, useEnvironmentScope } from "../../state/session";
import { terminalEnvironment } from "../../state/terminal";
import { useAtomCommand } from "../../state/use-atom-command";
import { TerminalViewport } from "../ThreadTerminalDrawer";
import { Button } from "../ui/button";

/** Machine shells belong to no thread; the id only scopes their terminal sessions. */
export const MACHINE_TERMINAL_THREAD_ID = ThreadId.make("machine-terminal");
/** The server reads "~" as its own home folder, whose path this client does not know. */
export const MACHINE_TERMINAL_CWD = "~";
const MACHINE_TERMINAL_DEVICE_KEY = "studio:machine-terminal-device";

let deviceTerminalId: string | null = null;
/**
 * One shell per machine for this device: reopening the panel, a reload or a
 * reconnect attaches to the same shell instead of starting another one. Only
 * Close ends it.
 */
export function machineTerminalId(): string {
  if (deviceTerminalId !== null) return deviceTerminalId;
  let id: string | null = null;
  try {
    id = localStorage.getItem(MACHINE_TERMINAL_DEVICE_KEY);
    if (!id) {
      id = `machine-${randomUUID()}`;
      localStorage.setItem(MACHINE_TERMINAL_DEVICE_KEY, id);
    }
  } catch {
    id = `machine-${randomUUID()}`;
  }
  deviceTerminalId = id;
  return id;
}

/** Ends this device's shell on a machine while this connection still has terminal access. */
export function useCloseMachineTerminal(): (environmentId: EnvironmentId) => void {
  const closeTerminal = useAtomCommand(terminalEnvironment.close, { reportFailure: false });
  return useCallback(
    (environmentId: EnvironmentId) => {
      if (!readEnvironmentScope(environmentId, AuthTerminalOperateScope)) return;
      void closeTerminal({
        environmentId,
        input: {
          threadId: MACHINE_TERMINAL_THREAD_ID,
          terminalId: machineTerminalId(),
          deleteHistory: true,
        },
      });
    },
    [closeTerminal],
  );
}

/**
 * Opens a shell on a connected machine over its existing environment
 * connection, without a thread. A remote shell is full access to that machine,
 * so the entry exists only while this connection holds terminal access there;
 * the machine itself still checks the grant when the terminal opens.
 */
export function MachineTerminalButton({
  environmentId,
  environmentLabel,
  open,
  onOpenChange,
}: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const tx = useTx();
  const canOperateTerminal = useEnvironmentScope(environmentId, AuthTerminalOperateScope);
  if (!canOperateTerminal) return null;
  return (
    <Button size="xs" variant="outline" aria-expanded={open} onClick={() => onOpenChange(!open)}>
      <TerminalIcon aria-hidden />
      {open ? tx("Close terminal") : `Terminal on ${environmentLabel}`}
    </Button>
  );
}

/**
 * Shows this device's shell on a machine. Unmounting (leaving the page or the
 * machine disconnecting) keeps the shell; `onClose` is where the caller ends it.
 */
export function MachineTerminal({
  environmentId,
  environmentLabel,
  onClose,
}: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly onClose: () => void;
}) {
  const tx = useTx();
  const canOperateTerminal = useEnvironmentScope(environmentId, AuthTerminalOperateScope);
  const serverConfig = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const [advancedTypography] = useLocalStorage(
    TYPOGRAPHY_ADVANCED_STORAGE_KEY,
    false,
    Schema.Boolean,
  );
  const terminalId = machineTerminalId();
  const threadRef = useMemo(
    () => scopeThreadRef(environmentId, MACHINE_TERMINAL_THREAD_ID),
    [environmentId],
  );

  return (
    <div
      data-thread-terminal-drawer
      className="overflow-hidden rounded-lg border border-border/70 bg-background text-foreground"
    >
      <div className="flex items-center justify-between border-b border-border/60 bg-background/60 px-3 py-1.5">
        <span className="text-2xs font-medium text-muted-foreground">
          {!canOperateTerminal
            ? tx("This connection cannot control terminals on this machine.")
            : serverConfig === null
              ? `Connecting to ${environmentLabel}…`
              : `Shell on ${environmentLabel}, in its home folder`}
        </span>
        <Button size="xs" variant="ghost-muted" onClick={onClose}>
          {tx("Close")}
        </Button>
      </div>
      <div className="h-72">
        {canOperateTerminal && serverConfig !== null ? (
          <TerminalViewport
            threadRef={threadRef}
            threadId={MACHINE_TERMINAL_THREAD_ID}
            terminalId={terminalId}
            terminalLabel={`Terminal on ${environmentLabel}`}
            cwd={MACHINE_TERMINAL_CWD}
            fallbackCwd={MACHINE_TERMINAL_CWD}
            advancedTypography={advancedTypography}
            onSessionExited={onClose}
            focusRequestId={1}
            autoFocus
            visible
            resizeEpoch={0}
            drawerHeight={288}
            keybindings={serverConfig.keybindings}
          />
        ) : null}
      </div>
    </div>
  );
}
