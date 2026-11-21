import { useTx } from "../../i18n";
import {
  AuthTerminalOperateScope,
  type EnvironmentId,
  type RuntimeMode,
  type TerminalElevationState,
  terminalElevationState,
  type ThreadId,
} from "@specweave-studio/contracts";
import {
  type ShellRunElevation,
  shellRunElevation,
  shellRunNeedsElevationConfirm,
} from "@specweave-studio/shared/shellRunElevation";
import { terminalOutputText } from "@specweave-studio/client-runtime/state/terminal";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@specweave-studio/client-runtime/state/runtime";
import { PlayIcon, SquareIcon } from "lucide-react";
import {
  createContext,
  type ReactNode,
  use,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { readThreadShell } from "../../state/entities";
import { useEnvironment, usePrimaryEnvironmentId } from "../../state/environments";
import { useEnvironmentScope } from "../../state/session";
import { terminalEnvironment } from "../../state/terminal";
import { useAttachedTerminalSession, useKnownTerminalSessions } from "../../state/terminalSessions";
import { useAtomCommand } from "../../state/use-atom-command";
import { useCanOpenSettingsFor, useFullDiskAccess } from "../access/FullDiskAccess";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { TerminalActionBar, TerminalLinkedText } from "./TerminalTextActions";
import {
  inlineRunTerminalId,
  shellRunAsksForPassword,
  shellRunHitProtectedFile,
  shellRunMachineWarning,
  shellRunNeedsConfirmation,
  terminalOutputPlainText,
} from "./shellCodeBlocks";

/** Where a thread's shell code blocks run: its host, working directory and runtime mode. */
export interface ShellRunTarget {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly cwd: string;
  readonly fallbackCwd?: string | undefined;
  readonly worktreePath: string | null;
  readonly env?: Record<string, string> | undefined;
  readonly runtimeMode: RuntimeMode | null;
}

/** Set around a thread's or coordinator's messages; markdown elsewhere never runs code. */
export const ShellRunTargetContext = createContext<ShellRunTarget | null>(null);

const RUN_TERMINAL_COLS = 120;
const RUN_TERMINAL_ROWS = 30;
const CTRL_C = "\u0003";

/**
 * The secret each administrator run's state markers carry, by terminal. Only
 * the window that started the run reads its states; another window, or this
 * one after a reload, shows the plain exit code.
 */
const elevationNonces = new Map<string, string>();
const NONCE_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

function newElevationNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return Array.from(bytes, (byte) => NONCE_ALPHABET[byte % NONCE_ALPHABET.length]).join("");
}

export interface InlineShellRun {
  readonly available: boolean;
  readonly running: boolean;
  readonly pending: boolean;
  readonly confirming: boolean;
  readonly visible: boolean;
  readonly output: string;
  readonly exitCode: number | null;
  readonly exitSignal: number | null;
  readonly status: "idle" | "starting" | "running" | "exited" | "error" | "closed";
  readonly error: string | null;
  readonly environmentId: EnvironmentId | null;
  readonly cwd: string | null;
  /** The machine this command runs on, when known. */
  readonly hostLabel: string | null;
  /** Why this machine may be the wrong one for this command. */
  readonly warning: string | null;
  /** What the command does with administrator rights; asks first when it does anything. */
  readonly elevation: ShellRunElevation | null;
  /** The run goes through the machine's own password prompt. */
  readonly promptAvailable: boolean;
  /** The machine can show the prompt, whatever the block's text says (sudo inside a script). */
  readonly promptSupportedHere: boolean;
  /** This window sits on the Mac that runs the command, so it can hand it to Terminal. */
  readonly canOpenInTerminal: boolean;
  /** This window is on the machine that runs the command. */
  readonly localMachine: boolean;
  /** Where an administrator run stands, from the run's own output. */
  readonly elevationState: TerminalElevationState | null;
  /** sudo asked for a password this panel cannot take. */
  readonly asksForPassword: boolean;
  /** A Mac refused a file to the command even though it had the rights. */
  readonly hitProtectedFile: boolean;
  readonly command: string | null;
  /** The click: asks first under a stricter mode than Full access, otherwise runs. */
  readonly requestRun: () => void;
  readonly confirmRun: () => void;
  readonly runWithPrompt: () => void;
  readonly confirmOpenInTerminal: () => void;
  readonly openInTerminal: () => void;
  readonly cancelRun: () => void;
  readonly stop: () => void;
  readonly clear: () => void;
}

/**
 * Runs one shell command from a code block in its own terminal on the
 * thread's host and working directory, and follows that terminal's output.
 * Nothing runs without a click.
 */
export function useInlineShellRun(command: string | null): InlineShellRun {
  const target = use(ShellRunTargetContext);
  const active = command !== null && target !== null;
  const environmentId = active ? target.environmentId : null;
  const threadId = active ? target.threadId : null;
  const terminalId = command !== null ? inlineRunTerminalId(command) : null;
  const canOperate = useEnvironmentScope(environmentId, AuthTerminalOperateScope);
  const environment = useEnvironment(environmentId);
  const hostLabel = environment?.label ?? null;
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const primaryLabel = useEnvironment(primaryEnvironmentId)?.label ?? null;
  const localMachine = environmentId !== null && environmentId === primaryEnvironmentId;
  const hostOs = environment?.serverConfig?.environment.platform.os ?? null;
  // Older servers reject nothing but ignore the field; they keep today's run.
  const promptSupported =
    environment?.serverConfig?.environment.capabilities.terminalElevationPrompt === true;
  const elevation = useMemo(
    () => (command !== null ? shellRunElevation(command) : null),
    [command],
  );
  // Windows runs the block as it is: its sudo raises the system's own approval.
  const sendsElevation =
    // Only sudo can use the machine's prompt; su, doas and pkexec ask for themselves.
    promptSupported && hostOs !== "windows" && (elevation?.sudo ?? false);
  const promptAvailable = sendsElevation && hostOs === "darwin";
  const nonceKey =
    environmentId !== null && threadId !== null && terminalId !== null
      ? `${environmentId}\n${threadId}\n${terminalId}`
      : null;
  const [nonceState, setNonceState] = useState<{
    readonly key: string | null;
    readonly value: string | null;
  }>(() => ({
    key: nonceKey,
    value: nonceKey === null ? null : (elevationNonces.get(nonceKey) ?? null),
  }));
  const nonce =
    nonceKey === null
      ? null
      : nonceState.key === nonceKey
        ? nonceState.value
        : (elevationNonces.get(nonceKey) ?? null);
  const canOpenInTerminal = promptSupported && hostOs === "darwin" && localMachine;
  const warning =
    command !== null && environmentId !== null
      ? shellRunMachineWarning(command, environmentId, hostLabel)
      : null;
  const runKey =
    environmentId !== null && threadId !== null && terminalId !== null && command !== null
      ? `${environmentId}\n${threadId}\n${terminalId}\n${target?.worktreePath ?? target?.cwd ?? ""}\n${command}`
      : null;
  const knownSessions = useKnownTerminalSessions({ environmentId, threadId });
  const known =
    terminalId !== null &&
    (knownSessions?.some((session) => session.target.terminalId === terminalId) ?? false);
  const [openedKey, setOpenedKey] = useState<string | null>(null);
  const [confirmingKey, setConfirmingKey] = useState<string | null>(null);
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const [errorState, setErrorState] = useState<{
    readonly key: string;
    readonly message: string;
  } | null>(null);
  const latestRunKeyRef = useRef<string | null>(runKey);
  const pendingRunKeyRef = useRef<string | null>(null);
  const runAttemptRef = useRef(0);
  useLayoutEffect(() => {
    latestRunKeyRef.current = runKey;
  }, [runKey]);
  const opened = runKey !== null && openedKey === runKey;
  const pending = runKey !== null && pendingKey === runKey;
  const error = runKey !== null && errorState?.key === runKey ? errorState.message : null;
  const attached = active && canOperate && (known || opened);
  const terminal = useMemo(
    () => (attached && threadId !== null && terminalId !== null ? { threadId, terminalId } : null),
    [attached, threadId, terminalId],
  );
  const session = useAttachedTerminalSession({
    environmentId: attached ? environmentId : null,
    terminal,
  });
  const openTerminal = useAtomCommand(terminalEnvironment.open, "terminal open");
  const writeTerminal = useAtomCommand(terminalEnvironment.write, "terminal write");
  const closeTerminal = useAtomCommand(terminalEnvironment.close, "terminal close");

  const running = attached && (session.status === "running" || session.status === "starting");
  const [prevRunningKey, setPrevRunningKey] = useState<string | null>(null);
  const activeRunningKey = running ? runKey : null;
  if (activeRunningKey !== prevRunningKey) {
    setPrevRunningKey(activeRunningKey);
    if (activeRunningKey !== null && confirmingKey === activeRunningKey) {
      setConfirmingKey(null);
    }
  }
  const confirming = runKey !== null && confirmingKey === runKey && !running;
  const outputVersion = session.output;
  const rawOutput = useMemo(() => terminalOutputText(outputVersion), [outputVersion]);
  const output = useMemo(() => terminalOutputPlainText(rawOutput).trimEnd(), [rawOutput]);
  const elevationState = useMemo(
    () => (attached ? terminalElevationState(rawOutput, nonce) : null),
    [attached, nonce, rawOutput],
  );

  const run = useCallback(
    async (
      mode: "plain" | "prompt" | "terminal-app",
      options?: { readonly allowWhileRunning?: boolean },
    ) => {
      if (!target || command === null || terminalId === null || runKey === null) return;
      if ((!options?.allowWhileRunning && running) || pendingRunKeyRef.current === runKey) return;
      const requestKey = runKey;
      const attempt = ++runAttemptRef.current;
      pendingRunKeyRef.current = requestKey;
      setPendingKey(requestKey);
      const runNonce = mode === "plain" ? null : newElevationNonce();
      if (nonceKey !== null) {
        if (runNonce === null) elevationNonces.delete(nonceKey);
        else elevationNonces.set(nonceKey, runNonce);
      }
      setNonceState({ key: nonceKey, value: runNonce });
      const threadTitle =
        mode === "plain"
          ? null
          : (readThreadShell({ environmentId: target.environmentId, threadId: target.threadId })
              ?.title ?? null);
      setConfirmingKey(null);
      setErrorState(null);
      try {
        const result = await openTerminal({
          environmentId: target.environmentId,
          input: {
            threadId: target.threadId,
            terminalId,
            cwd: target.cwd,
            ...(target.fallbackCwd ? { fallbackCwd: target.fallbackCwd } : {}),
            ...(target.worktreePath !== null ? { worktreePath: target.worktreePath } : {}),
            ...(target.env ? { env: target.env } : {}),
            cols: RUN_TERMINAL_COLS,
            rows: RUN_TERMINAL_ROWS,
            command,
            ...(mode === "plain"
              ? {}
              : {
                  elevation: {
                    ...(threadTitle ? { threadTitle: threadTitle.slice(0, 200) } : {}),
                    ...(localMachine
                      ? {}
                      : { requestedFrom: (primaryLabel ?? "another device").slice(0, 120) }),
                    ...(mode === "terminal-app" ? { openIn: "terminal-app" as const } : {}),
                    ...(runNonce !== null ? { nonce: runNonce } : {}),
                  },
                }),
          },
        });
        if (latestRunKeyRef.current !== requestKey || runAttemptRef.current !== attempt) return;
        if (result._tag === "Failure") {
          if (!isAtomCommandInterrupted(result)) {
            const cause = squashAtomCommandFailure(result);
            setErrorState({
              key: requestKey,
              message: cause instanceof Error ? cause.message : "The command could not start.",
            });
          }
          return;
        }
        setOpenedKey(requestKey);
      } finally {
        if (pendingRunKeyRef.current === requestKey && runAttemptRef.current === attempt) {
          pendingRunKeyRef.current = null;
          setPendingKey((current) => (current === requestKey ? null : current));
        }
      }
    },
    [
      command,
      localMachine,
      nonceKey,
      openTerminal,
      primaryLabel,
      runKey,
      running,
      target,
      terminalId,
    ],
  );
  const runDefault = useCallback(
    () => run(sendsElevation ? "prompt" : "plain"),
    [run, sendsElevation],
  );

  const requestRun = useCallback(() => {
    if (running || pending || pendingRunKeyRef.current === runKey || runKey === null) return;
    if (
      warning !== null ||
      shellRunNeedsConfirmation(target?.runtimeMode ?? null) ||
      (elevation !== null && shellRunNeedsElevationConfirm(elevation))
    ) {
      setConfirmingKey(runKey);
      return;
    }
    void runDefault();
  }, [elevation, pending, runDefault, runKey, running, target?.runtimeMode, warning]);

  const stop = useCallback(() => {
    if (!target || terminalId === null) return;
    // Ctrl-C reaches the command's process group the way it would in a terminal.
    void writeTerminal({
      environmentId: target.environmentId,
      input: { threadId: target.threadId, terminalId, data: CTRL_C },
    });
  }, [target, terminalId, writeTerminal]);

  const clear = useCallback(() => {
    if (!target || terminalId === null) return;
    runAttemptRef.current += 1;
    pendingRunKeyRef.current = null;
    setPendingKey(null);
    setOpenedKey(null);
    setConfirmingKey(null);
    setErrorState(null);
    void closeTerminal({
      environmentId: target.environmentId,
      input: { threadId: target.threadId, terminalId, deleteHistory: true },
    });
  }, [closeTerminal, target, terminalId]);

  const status = attached ? session.status : "idle";
  return {
    available: active && canOperate,
    running,
    pending,
    confirming,
    visible: confirming || error !== null || attached,
    output,
    exitCode: session.exitCode,
    exitSignal: session.exitSignal,
    status,
    error: error ?? (attached ? session.error : null),
    environmentId,
    cwd: target?.worktreePath ?? target?.cwd ?? null,
    hostLabel,
    warning,
    elevation,
    promptAvailable,
    promptSupportedHere: promptSupported && hostOs === "darwin",
    canOpenInTerminal,
    localMachine,
    elevationState,
    asksForPassword:
      attached &&
      (elevationState === null || elevationState === "started") &&
      shellRunAsksForPassword(output, running),
    hitProtectedFile:
      attached &&
      hostOs === "darwin" &&
      session.status === "exited" &&
      session.exitCode !== 0 &&
      shellRunHitProtectedFile(output),
    command,
    requestRun,
    confirmRun: () => void runDefault(),
    runWithPrompt: () => void run("prompt", { allowWhileRunning: true }),
    confirmOpenInTerminal: () => void run("terminal-app"),
    openInTerminal: () => void run("terminal-app", { allowWhileRunning: true }),
    cancelRun: () => setConfirmingKey(null),
    stop,
    clear,
  };
}

const InlineShellRunContext = createContext<InlineShellRun | null>(null);

function InlineShellRunProvider({
  command,
  children,
}: {
  command: string | null;
  children: ReactNode;
}) {
  const run = useInlineShellRun(command);
  return <InlineShellRunContext value={run}>{children}</InlineShellRunContext>;
}

/**
 * Gives a code block's Run button and output panel their run. Markdown outside
 * a thread has no run target and skips the terminal subscriptions entirely.
 */
export function InlineShellRunScope({
  command,
  children,
}: {
  command: string | null;
  children: ReactNode;
}) {
  if (use(ShellRunTargetContext) === null) return children;
  return <InlineShellRunProvider command={command}>{children}</InlineShellRunProvider>;
}

export function InlineShellRunButton() {
  const tx = useTx();
  const run = use(InlineShellRunContext);
  if (!run?.available) return null;
  const label = run.running ? "Stop" : run.hostLabel ? `Run on ${run.hostLabel}` : "Run";
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant="ghost-muted"
            size="xs"
            disabled={!run.running && run.pending}
            onClick={run.running ? run.stop : run.requestRun}
            aria-label={run.running ? tx("Stop command") : tx("Run command")}
            aria-description={run.hostLabel ? `Runs on ${run.hostLabel}` : undefined}
            data-shell-run-action={run.running ? "stop" : "run"}
          />
        }
      >
        {run.running ? <SquareIcon className="size-3" /> : <PlayIcon className="size-3" />}
        <span className="max-w-40 truncate">{label}</span>
      </TooltipTrigger>
      <TooltipPopup side="top">
        {run.running
          ? tx("Stop the command")
          : `Run on ${run.hostLabel ?? "this thread's machine"} and show the output below`}
      </TooltipPopup>
    </Tooltip>
  );
}

function exitLabel(run: InlineShellRun): { text: string; failed: boolean } | null {
  if (run.status === "starting" || run.status === "running")
    return { text: "Running", failed: false };
  if (run.status === "error") return { text: "Could not run", failed: true };
  if (run.status === "exited") {
    if ((run.exitSignal ?? 0) > 0 || run.exitCode === null)
      return { text: "Stopped", failed: true };
    return { text: `Exit ${run.exitCode}`, failed: run.exitCode !== 0 };
  }
  return null;
}

function InlineShellRunConfirm({ run }: { run: InlineShellRun }) {
  const tx = useTx();
  const where =
    run.hostLabel && run.cwd
      ? tx("{host} in {cwd}", { host: run.hostLabel, cwd: run.cwd })
      : run.hostLabel || run.cwd;
  const host = run.hostLabel ?? tx("this machine");
  const systemChanges = run.elevation?.systemChanges.slice(0, 3) ?? [];
  const elevated = (run.elevation?.administrator ?? false) || systemChanges.length > 0;
  return (
    <div
      className="flex flex-wrap items-center gap-2 border-t border-border/60 px-3 py-2 text-xs select-none"
      data-shell-run="confirm"
      role="group"
      aria-label={tx("Confirm command")}
    >
      <span className="min-w-0 flex-1 text-muted-foreground">
        {run.warning ? (
          <span className="block font-medium text-warning-foreground" data-shell-run-warning="">
            {run.warning}
          </span>
        ) : null}
        {run.elevation?.administrator ? (
          <span
            className="block font-medium text-warning-foreground"
            data-shell-run-elevation="administrator"
          >
            {tx("Runs as administrator on {host}", { host })}
          </span>
        ) : null}
        {systemChanges.length > 0 ? (
          <span
            className="block font-medium break-all text-warning-foreground"
            data-shell-run-elevation="system"
          >
            {tx("Changes system settings: {items}", { items: systemChanges.join(", ") })}
          </span>
        ) : null}
        {run.promptAvailable ? (
          <span className="block">
            {tx("macOS will ask for your password on {host}. SpecWithCode never sees it.", {
              host,
            })}
          </span>
        ) : null}
        {where ? tx("Run this command on {where}?", { where }) : tx("Run this command?")}
      </span>
      <Button
        type="button"
        size="micro"
        disabled={run.pending || run.running}
        onClick={run.confirmRun}
        data-shell-run-confirm=""
      >
        {tx("Run")}
      </Button>
      <Button type="button" size="micro" variant="outline" onClick={run.cancelRun}>
        {tx("Cancel")}
      </Button>
      {elevated && run.canOpenInTerminal ? (
        <Button
          type="button"
          size="micro"
          variant="outline"
          disabled={run.pending || run.running}
          onClick={run.confirmOpenInTerminal}
          data-shell-run-terminal-app=""
        >
          {tx("Open in Terminal")}
        </Button>
      ) : null}
    </div>
  );
}

/** What an administrator run says instead of an exit code, and whether it is a failure. */
function elevationNote(
  run: InlineShellRun,
  tx: ReturnType<typeof useTx>,
): { text: string; failed: boolean; copy?: boolean } | null {
  const host = run.hostLabel ?? tx("this machine");
  switch (run.elevationState) {
    case "waiting":
      // The run ended while the prompt was up: nobody gave a password.
      if (!run.running) return { text: tx("Password not given. Nothing has run."), failed: true };
      return {
        text: run.localMachine
          ? tx("Waiting for your password on {host}", { host })
          : tx("Enter the password on {host}'s screen", { host }),
        failed: false,
      };
    case "cancelled":
      return { text: tx("Password not given. Nothing has run."), failed: true };
    case "timeout":
      return { text: tx("Nobody answered on {host}. Nothing has run.", { host }), failed: true };
    case "denied":
      return { text: tx("Password not accepted. Nothing has run."), failed: true };
    case "unavailable":
      return {
        text: tx("This needs an administrator password. Run it in a terminal on {host}.", { host }),
        failed: true,
        copy: true,
      };
    case "terminal-app":
      return {
        text: tx(
          "Opened in Terminal on {host}. The output stays there. Terminal has its own Full Disk Access switch, separate from SpecWithCode's.",
          { host },
        ),
        failed: false,
      };
    default:
      return null;
  }
}

/** Why a Mac refused a file to a command that had the rights, from the machine's own probe. */
function ProtectedFileNote({ run }: { run: InlineShellRun & { environmentId: EnvironmentId } }) {
  const tx = useTx();
  const { access, openSettings } = useFullDiskAccess(run.environmentId);
  const canOpenSettings = useCanOpenSettingsFor(run.environmentId);
  const host = run.hostLabel ?? tx("this machine");
  const notAllowed = access?.fullDiskAccess === "not-allowed";
  return (
    <div
      className="flex flex-wrap items-center gap-2 border-t border-border/60 bg-warning-surface px-3 py-2 text-xs select-none"
      data-shell-run-note="protected-file"
      role="note"
    >
      <span className="min-w-0 flex-1">
        {notAllowed
          ? tx(
              "macOS blocked a protected file. {app} does not have Full Disk Access on {host}. Turning it on may not unlock this file.",
              { app: access?.agentHost?.name ?? "SpecWithCode", host },
            )
          : access?.fullDiskAccess === "allowed" && run.elevation?.administrator
            ? tx(
                "macOS blocked this file even for an administrator. Some system files are protected by macOS itself.",
              )
            : tx("macOS blocked a protected file.")}
      </span>
      {notAllowed && canOpenSettings ? (
        <Button type="button" size="micro" variant="outline" onClick={() => void openSettings()}>
          {tx("Open System Settings")}
        </Button>
      ) : null}
    </div>
  );
}

/** sudo is asking, and this panel cannot take a password: the two ways on. */
function PasswordAskNote({ run }: { run: InlineShellRun }) {
  const tx = useTx();
  const host = run.hostLabel ?? tx("this machine");
  const offerPrompt = run.promptSupportedHere;
  return (
    <div
      className="flex flex-wrap items-center gap-2 border-t border-border/60 bg-warning-surface px-3 py-2 text-xs select-none"
      data-shell-run-note="password"
      role="note"
    >
      <span className="min-w-0 flex-1">
        {offerPrompt || run.canOpenInTerminal
          ? tx("This command is asking for an administrator password.")
          : tx("This needs an administrator password. Run it in a terminal on {host}.", { host })}
      </span>
      {offerPrompt ? (
        <Button
          type="button"
          size="micro"
          disabled={run.pending}
          onClick={run.runWithPrompt}
          data-shell-run-prompt=""
        >
          {tx("Run again with the Mac's prompt")}
        </Button>
      ) : null}
      {run.canOpenInTerminal ? (
        <Button
          type="button"
          size="micro"
          variant="outline"
          disabled={run.pending}
          onClick={run.openInTerminal}
        >
          {tx("Open in Terminal")}
        </Button>
      ) : null}
      {!offerPrompt && !run.canOpenInTerminal && run.command !== null ? (
        <CopyCommandButton command={run.command} />
      ) : null}
    </div>
  );
}

function CopyCommandButton({ command }: { command: string }) {
  const tx = useTx();
  const [copied, setCopied] = useState(false);
  return (
    <Button
      type="button"
      size="micro"
      variant="outline"
      data-shell-run-copy=""
      onClick={() => {
        void navigator.clipboard?.writeText(command).then(() => setCopied(true));
      }}
    >
      {copied ? tx("Copied") : tx("Copy")}
    </Button>
  );
}

export function InlineShellRunPanel() {
  const tx = useTx();
  const run = use(InlineShellRunContext);
  const outputRef = useRef<HTMLPreElement | null>(null);
  const followRef = useRef(true);
  const output = run?.output;
  // Follow new output while the reader stays at the bottom.
  useLayoutEffect(() => {
    const element = outputRef.current;
    if (output && element && followRef.current) element.scrollTop = element.scrollHeight;
  }, [output]);
  if (!run?.visible) return null;

  if (run.confirming) return <InlineShellRunConfirm run={run} />;

  const note = elevationNote(run, tx);
  const exit = note ?? exitLabel(run);
  const environmentId = run.environmentId;
  return (
    <div
      className="border-t border-border/60"
      data-shell-run={run.status}
      {...(run.exitCode !== null ? { "data-shell-run-exit": String(run.exitCode) } : {})}
    >
      {run.output.length > 0 ? <TerminalActionBar text={run.output} /> : null}
      {run.output.length > 0 ? (
        <pre
          ref={outputRef}
          className="max-h-72 overflow-auto px-3 pt-2 font-mono text-xs whitespace-pre-wrap text-foreground/85"
          aria-label={tx("Command output")}
          tabIndex={0}
          onScroll={(event) => {
            const element = event.currentTarget;
            followRef.current =
              element.scrollHeight - element.scrollTop - element.clientHeight < 24;
          }}
        >
          <TerminalLinkedText text={run.output} />
        </pre>
      ) : null}
      {run.asksForPassword ? <PasswordAskNote run={run} /> : null}
      {run.hitProtectedFile && environmentId !== null ? (
        <ProtectedFileNote run={{ ...run, environmentId }} />
      ) : null}
      <div className="flex items-center gap-2 px-3 py-1.5 text-2xs select-none">
        {exit ? (
          <span
            className={
              exit.failed ? "font-medium text-destructive-foreground" : "text-muted-foreground"
            }
            role="status"
            data-shell-run-status=""
            {...(run.elevationState
              ? { "data-shell-run-elevation-state": run.elevationState }
              : {})}
          >
            {exit.text}
          </span>
        ) : null}
        {note?.copy && run.command !== null ? <CopyCommandButton command={run.command} /> : null}
        {run.error ? (
          <span className="min-w-0 truncate text-destructive-foreground" role="alert">
            {run.error}
          </span>
        ) : null}
        <span className="ms-auto flex items-center gap-0.5">
          {run.running ? (
            <Button type="button" size="micro" variant="destructive-outline" onClick={run.stop}>
              <SquareIcon className="size-3" />
              {run.elevationState === "waiting" ? tx("Cancel") : tx("Stop")}
            </Button>
          ) : (
            <>
              <Button
                type="button"
                size="micro"
                variant="outline"
                disabled={run.pending}
                onClick={run.requestRun}
              >
                <PlayIcon className="size-3" />
                {tx("Run again")}
              </Button>
              <Button type="button" size="micro" variant="outline" onClick={run.clear}>
                {tx("Clear")}
              </Button>
            </>
          )}
        </span>
      </div>
    </div>
  );
}
