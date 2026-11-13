import type {
  EnvironmentId,
  ProviderInstanceId,
  ServerConfig,
  ServerProvider,
} from "@specweave-studio/contracts";
import { scopeThreadRef } from "@specweave-studio/client-runtime/environment";
import { AuthTerminalOperateScope, ThreadId } from "@specweave-studio/contracts";
import * as Schema from "effect/Schema";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import { TYPOGRAPHY_ADVANCED_STORAGE_KEY } from "../../appearanceFonts";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import { useT, useTx } from "../../i18n";
import { cn, randomUUID } from "../../lib/utils";
import { serverEnvironment } from "../../state/server";
import { readEnvironmentScope, useEnvironmentScope } from "../../state/session";
import { terminalEnvironment } from "../../state/terminal";
import { useAtomCommand } from "../../state/use-atom-command";
import { TerminalViewport } from "../ThreadTerminalDrawer";
import { Button } from "../ui/button";

const AGENT_ONBOARDING_THREAD_ID = ThreadId.make("onboarding-agent-setup");
// Some providers report "not checked yet" for good, so checking cannot last forever.
export const AGENT_CHECK_TIMEOUT_MS = 15_000;
/** While an agent's sign-in runs in the panel, its machine is asked this often. */
const SIGN_IN_POLL_MS = 3_000;

/** Setup values stay fixed while provider probes refresh the surrounding rows. */
export interface AgentTerminalSession {
  readonly environmentId: EnvironmentId;
  readonly agent: string;
  readonly agentName: string;
  /** Absent for a command that belongs to no agent, such as the Git install. */
  readonly providerInstanceId?: ServerProvider["instanceId"] | undefined;
  readonly cwd: string;
  readonly command: string;
  /**
   * Each runs at once, and its output is the log. A sign-in's panel closes when
   * it ends. An install's closes when it worked and stays open with the log
   * when it did not. `tools` installs something agents need, such as Git.
   */
  readonly purpose: "signIn" | "install" | "tools";
  readonly keybindings: ServerConfig["keybindings"];
}

export type AgentPanelRequest = Pick<
  AgentTerminalSession,
  "agent" | "agentName" | "command" | "purpose"
> & {
  readonly providerInstanceId?: ServerProvider["instanceId"];
};

/** A new panel for another agent or another purpose, never a reused one. */
export const agentSetupPanelKey = (session: AgentTerminalSession): string =>
  `${session.environmentId}:${session.agent}:${session.purpose}`;

/** How long a row waits for an install it left running before offering Install again. */
export const DETACHED_INSTALL_WAIT_MS = 10 * 60_000;

/**
 * Installs whose panel went away while they ran (see `keepInstallRunning`), by
 * `environmentId:instanceId`, with when their row stops waiting. Nothing
 * reports their end, so their row reads the machine until the agent shows up,
 * and offers no second install meanwhile.
 */
const detachedInstalls = new Map<string, number>();
const detachedInstallListeners = new Set<() => void>();
const detachedInstallKey = (environmentId: EnvironmentId, instanceId: string) =>
  `${environmentId}:${instanceId}`;
function setDetachedInstall(key: string, until: number | null) {
  if (until === null ? !detachedInstalls.has(key) : detachedInstalls.get(key) === until) return;
  if (until === null) detachedInstalls.delete(key);
  else detachedInstalls.set(key, until);
  for (const listener of detachedInstallListeners) listener();
}
function onDetachedInstallsChanged(listener: () => void) {
  detachedInstallListeners.add(listener);
  return () => void detachedInstallListeners.delete(listener);
}

/**
 * When the row of this agent entry stops waiting for an install it left
 * running, or null when there is none, and a way to forget it.
 */
export function useDetachedInstall(environmentId: EnvironmentId, instanceId: ProviderInstanceId) {
  const key = detachedInstallKey(environmentId, instanceId);
  const until = useSyncExternalStore(
    onDetachedInstallsChanged,
    () => detachedInstalls.get(key) ?? null,
    () => null,
  );
  const forget = useCallback(() => setDetachedInstall(key, null), [key]);
  return { until, forget } as const;
}

/** Whether a read's own answer says that agent is signed in. */
function readAsSignedIn(
  result:
    | {
        readonly _tag: string;
        readonly value?: { readonly providers?: ReadonlyArray<ServerProvider> } | undefined;
      }
    | undefined,
  instanceId: ProviderInstanceId,
): boolean {
  if (result?._tag !== "Success") return false;
  return (
    result.value?.providers?.some(
      (provider) => provider.instanceId === instanceId && provider.auth.status === "authenticated",
    ) === true
  );
}

/**
 * The one panel a machine's agents share for a sign-in or an install, and what
 * their rows need to know about it: which agent is being read again after its
 * sign-in ended, and whose sign-in ended last.
 */
export function useAgentSetupPanel({
  environmentId,
  providers,
  serverConfig,
  onInstallClosed,
}: {
  readonly environmentId: EnvironmentId;
  readonly providers: ReadonlyArray<ServerProvider> | null | undefined;
  readonly serverConfig: Pick<ServerConfig, "cwd" | "keybindings"> | null;
  /** An install or tools panel was closed: look for agents again. */
  readonly onInstallClosed: () => void;
}) {
  const refreshProviders = useAtomCommand(serverEnvironment.refreshProviders, {
    reportFailure: false,
  });
  const canOperateTerminal = useEnvironmentScope(environmentId, AuthTerminalOperateScope);
  const [session, setSession] = useState<AgentTerminalSession | null>(null);
  // The agent whose sign-in the app started and whose result is being read.
  const [checkingInstance, setCheckingInstance] = useState<ProviderInstanceId | null>(null);
  // The agent whose sign-in in the panel ended last, for a line on its row if it is still signed out.
  const [endedInstance, setEndedInstance] = useState<ProviderInstanceId | null>(null);
  const polling = useRef(false);
  // One per agent, so one agent's sign-in ending never cancels another's.
  const checkTimers = useRef(new Map<ProviderInstanceId, ReturnType<typeof setTimeout>>());

  // A sign-in in the panel is done when the machine reads the agent as signed in.
  const signInInstanceId =
    session?.purpose === "signIn" ? (session.providerInstanceId ?? null) : null;
  const signedIn =
    signInInstanceId !== null &&
    providers?.find((provider) => provider.instanceId === signInInstanceId)?.auth.status ===
      "authenticated";
  if (signedIn) setSession(null);
  // The line about a sign-in that ended is about that sign-in only.
  if (
    endedInstance !== null &&
    providers?.find((provider) => provider.instanceId === endedInstance)?.auth.status ===
      "authenticated"
  )
    setEndedInstance(null);
  useEffect(() => {
    if (signInInstanceId === null) return;
    const timer = setInterval(() => {
      if (polling.current) return;
      polling.current = true;
      void Promise.resolve(
        refreshProviders({ environmentId, input: { instanceId: signInInstanceId } }),
      ).finally(() => {
        polling.current = false;
      });
    }, SIGN_IN_POLL_MS);
    return () => clearInterval(timer);
  }, [signInInstanceId, environmentId, refreshProviders]);

  const open = (request: AgentPanelRequest) => {
    if (serverConfig === null || !readEnvironmentScope(environmentId, AuthTerminalOperateScope))
      return;
    setEndedInstance(null);
    setSession({
      ...request,
      environmentId,
      cwd: serverConfig.cwd,
      keybindings: serverConfig.keybindings,
    });
  };

  const close = () => {
    const closed = session;
    setSession(null);
    if (closed === null) return;
    if (closed.purpose !== "signIn") {
      onInstallClosed();
      return;
    }
    // The sign-in command has ended: read that agent now, and say so on its row.
    const instanceId = closed.providerInstanceId;
    if (instanceId === undefined) return;
    const checked = () =>
      setCheckingInstance((current) => (current === instanceId ? null : current));
    setCheckingInstance(instanceId);
    setEndedInstance(instanceId);
    // A read already under way may have begun before the sign-in saved the account.
    // So this one is asked for by itself, and a signed-out answer is read once more.
    const read = (fresh: boolean) =>
      Promise.resolve(
        refreshProviders({
          environmentId,
          input: fresh ? { instanceId, fresh } : { instanceId },
        }),
      );
    void read(true)
      .then((result) => (readAsSignedIn(result, instanceId) ? undefined : read(false)))
      .finally(checked);
    // A check that never answers must not hold the row on "Checking…".
    clearTimeout(checkTimers.current.get(instanceId));
    checkTimers.current.set(instanceId, setTimeout(checked, AGENT_CHECK_TIMEOUT_MS));
  };

  return {
    session,
    canOperateTerminal,
    /** Whether a panel can be opened on this machine by this connection. */
    available: serverConfig !== null && canOperateTerminal,
    open,
    close,
    checkingInstance,
    endedInstance,
    stopChecking: () => setCheckingInstance(null),
  };
}

/**
 * The panel under the list, and the log of what it runs. Opens a PTY on the
 * connected environment under a synthetic onboarding thread id (terminals are
 * keyed by free-form thread id; the server validates only the cwd). The command
 * is the session's own: it runs at once and the session ends with it. A sign-in
 * closes the panel when it ends. An install closes it when it worked, and keeps
 * the log on screen with the exit code when it did not.
 */
export function AgentSetupPanel({
  session,
  onClose,
  onEnded,
  onRetry,
  signInFollowsInstall = false,
  keepInstallRunning = false,
}: {
  readonly session: AgentTerminalSession;
  readonly onClose: () => void;
  /**
   * An install's command has ended; `false` keeps this panel open on its log.
   * Without it, an install that worked closes the panel.
   */
  readonly onEnded?: ((succeeded: boolean) => void) | undefined;
  /** The command is about to run again in a new session. */
  readonly onRetry?: (() => void) | undefined;
  /** The caller opens the agent's sign-in once its install is done. */
  readonly signInFollowsInstall?: boolean | undefined;
  /**
   * An install keeps running when this panel goes away with it unfinished,
   * for example when another agent is picked. Its Close button still stops it.
   */
  readonly keepInstallRunning?: boolean | undefined;
}) {
  const t = useT();
  const tx = useTx();
  const { agent, agentName, command, cwd, environmentId, keybindings, providerInstanceId } =
    session;
  const signIn = session.purpose === "signIn";
  const canOperateTerminal = useEnvironmentScope(environmentId, AuthTerminalOperateScope);
  // Same terminal typography preference the thread drawer honors.
  const [advancedTypography] = useLocalStorage(
    TYPOGRAPHY_ADVANCED_STORAGE_KEY,
    false,
    Schema.Boolean,
  );
  const openTerminal = useAtomCommand(terminalEnvironment.open, { reportFailure: false });
  const closeTerminal = useAtomCommand(terminalEnvironment.close, { reportFailure: false });
  const setupQueueRef = useRef(Promise.resolve());
  const setupGenerationRef = useRef(0);
  const activeSetupGenerationRef = useRef<number | null>(null);
  // An install or tools command that has started and not ended yet.
  const commandRunningRef = useRef(false);
  const closePressedRef = useRef(false);
  const [setupAttempt, setSetupAttempt] = useState(0);
  // A session that has ended cannot run again, so each try gets its own.
  const terminalId = useMemo(
    () => `onboarding-${agent}-${setupAttempt}-${randomUUID()}`,
    [agent, setupAttempt],
  );
  const threadRef = useMemo(
    () => scopeThreadRef(environmentId, AGENT_ONBOARDING_THREAD_ID),
    [environmentId],
  );
  const [setupState, setSetupState] = useState<"preparing" | "ready" | "openFailed" | "failed">(
    "preparing",
  );
  const [exitCode, setExitCode] = useState<number | null>(null);
  const terminalReady = setupState === "ready" || setupState === "failed";
  const panelRef = useRef<HTMLDivElement | null>(null);

  // The panel opens under a list that may be longer than the window.
  useEffect(() => {
    panelRef.current?.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
  }, []);

  // Keep each setup generation distinct. In Strict Mode, a canceled open can
  // finish after the replacement setup starts; it must not close the
  // replacement session.
  useEffect(() => {
    const generation = setupGenerationRef.current + 1;
    setupGenerationRef.current = generation;
    activeSetupGenerationRef.current = generation;
    setSetupState("preparing");
    setExitCode(null);

    setupQueueRef.current = setupQueueRef.current.then(async () => {
      if (activeSetupGenerationRef.current !== generation) return;
      if (!readEnvironmentScope(environmentId, AuthTerminalOperateScope)) {
        setSetupState("openFailed");
        return;
      }
      const opened = await openTerminal({
        environmentId,
        input: {
          threadId: AGENT_ONBOARDING_THREAD_ID,
          terminalId,
          cwd,
          ...(providerInstanceId !== undefined ? { providerInstanceId } : {}),
          command,
        },
      });
      if (activeSetupGenerationRef.current !== generation) return;
      commandRunningRef.current = opened._tag === "Success" && !signIn;
      setSetupState(opened._tag === "Success" ? "ready" : "openFailed");
    });

    // Every exit path unmounts the drawer. Close the PTY only while this
    // connection still has terminal access; revocation leaves it running.
    return () => {
      if (activeSetupGenerationRef.current === generation) {
        activeSetupGenerationRef.current = null;
      }
      // Leaving the panel mid-install leaves the install to finish on its machine.
      if (keepInstallRunning && commandRunningRef.current && !closePressedRef.current) {
        setDetachedInstall(
          detachedInstallKey(environmentId, providerInstanceId ?? agent),
          Date.now() + DETACHED_INSTALL_WAIT_MS,
        );
        return;
      }
      setupQueueRef.current = setupQueueRef.current.then(async () => {
        if (!readEnvironmentScope(environmentId, AuthTerminalOperateScope)) return;
        await closeTerminal({
          environmentId,
          input: { threadId: AGENT_ONBOARDING_THREAD_ID, terminalId, deleteHistory: true },
        });
      });
    };
  }, [
    agent,
    closeTerminal,
    command,
    cwd,
    environmentId,
    keepInstallRunning,
    openTerminal,
    providerInstanceId,
    signIn,
    terminalId,
  ]);

  const sessionExited = (code: number | null) => {
    commandRunningRef.current = false;
    if (signIn) {
      onClose();
      return;
    }
    if (code === 0) {
      if (onEnded) onEnded(true);
      else onClose();
      return;
    }
    setExitCode(code);
    setSetupState("failed");
    onEnded?.(false);
  };

  const running =
    session.purpose === "signIn"
      ? tx("{agent}'s sign-in is running here. Its row updates when it is done.", {
          agent: agentName,
        })
      : session.purpose === "install"
        ? signInFollowsInstall
          ? tx("Installing {agent}. This is its log. Its sign-in opens when the install is done.", {
              agent: agentName,
            })
          : tx("Installing {agent}. This is its log.", { agent: agentName })
        : tx("Asking macOS to install its developer tools, which carry Git. This is its log.");
  const failed =
    exitCode === null
      ? tx("The install of {agent} stopped before it was done. Its log is below.", {
          agent: agentName,
        })
      : tx("The install of {agent} ended with an error (exit code {code}). Its log is below.", {
          agent: agentName,
          code: exitCode,
        });

  return (
    <div
      ref={panelRef}
      data-thread-terminal-drawer
      data-agent-panel={session.purpose}
      data-agent-panel-state={setupState}
      className="mt-4 overflow-hidden rounded-lg border border-border/70 bg-background text-foreground"
    >
      <div className="flex items-center justify-between gap-3 border-b border-border/60 bg-background/60 px-3 py-1.5">
        <span
          role="status"
          className={cn(
            "min-w-0 text-2xs font-medium",
            setupState === "failed" || setupState === "openFailed"
              ? "text-warning-foreground"
              : "text-muted-foreground",
          )}
        >
          {!canOperateTerminal
            ? t("wizard.agents.noTerminal")
            : setupState === "failed"
              ? failed
              : setupState === "ready"
                ? running
                : setupState === "openFailed"
                  ? t("wizard.terminal.openFailed")
                  : t("wizard.terminal.preparing")}
        </span>
        <div className="flex shrink-0 items-center gap-1">
          {setupState === "openFailed" || setupState === "failed" ? (
            <Button
              size="xs"
              variant="ghost"
              disabled={!canOperateTerminal}
              onClick={() => {
                if (readEnvironmentScope(environmentId, AuthTerminalOperateScope)) {
                  onRetry?.();
                  setSetupAttempt((value) => value + 1);
                }
              }}
            >
              {t("wizard.retry")}
            </Button>
          ) : null}
          <Button
            size="xs"
            variant="ghost-muted"
            onClick={() => {
              closePressedRef.current = true;
              onClose();
            }}
          >
            {t("wizard.closeTerminal")}
          </Button>
        </div>
      </div>
      <details className="border-b border-border/60 px-3 py-1.5 text-2xs text-muted-foreground">
        <summary className="cursor-default">{tx("Show command")}</summary>
        <code className="mt-1 block overflow-x-auto font-mono whitespace-nowrap">{command}</code>
      </details>
      {/* Enter and Escape typed here belong to the terminal, not to setup. */}
      <div className="h-64" data-wizard-keys="off">
        {terminalReady ? (
          <TerminalViewport
            key={terminalId}
            threadRef={threadRef}
            threadId={AGENT_ONBOARDING_THREAD_ID}
            terminalId={terminalId}
            terminalLabel={
              signIn
                ? tx("Sign in to {agent}", { agent: agentName })
                : t("wizard.terminal.label", { driver: agentName })
            }
            cwd={cwd}
            {...(providerInstanceId !== undefined ? { providerInstanceId } : {})}
            advancedTypography={advancedTypography}
            onSessionExited={sessionExited}
            focusRequestId={1}
            autoFocus
            visible
            resizeEpoch={0}
            drawerHeight={256}
            keybindings={keybindings}
          />
        ) : null}
      </div>
    </div>
  );
}
