import {
  AuthTerminalOperateScope,
  type EnvironmentId,
  type RuntimeMode,
  type ThreadId,
} from "@specweave-studio/contracts";
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

import { useEnvironment } from "../../state/environments";
import { useEnvironmentScope } from "../../state/session";
import { terminalEnvironment } from "../../state/terminal";
import { useAttachedTerminalSession, useKnownTerminalSessions } from "../../state/terminalSessions";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { TerminalActionBar, TerminalLinkedText } from "./TerminalTextActions";
import {
  inlineRunTerminalId,
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

export interface InlineShellRun {
  readonly available: boolean;
  readonly running: boolean;
  readonly confirming: boolean;
  readonly visible: boolean;
  readonly output: string;
  readonly exitCode: number | null;
  readonly exitSignal: number | null;
  readonly status: "idle" | "starting" | "running" | "exited" | "error" | "closed";
  readonly error: string | null;
  readonly environmentId: EnvironmentId | null;
  readonly cwd: string | null;
  /** The click: asks first under a stricter mode than Full access, otherwise runs. */
  readonly requestRun: () => void;
  readonly confirmRun: () => void;
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
  const knownSessions = useKnownTerminalSessions({ environmentId, threadId });
  const known =
    terminalId !== null &&
    (knownSessions?.some((session) => session.target.terminalId === terminalId) ?? false);
  const [opened, setOpened] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
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
  const outputVersion = session.output;
  const output = useMemo(
    () => terminalOutputPlainText(terminalOutputText(outputVersion)).trimEnd(),
    [outputVersion],
  );

  const run = useCallback(async () => {
    if (!target || command === null || terminalId === null) return;
    setConfirming(false);
    setError(null);
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
      },
    });
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        const cause = squashAtomCommandFailure(result);
        setError(cause instanceof Error ? cause.message : "The command could not start.");
      }
      return;
    }
    setOpened(true);
  }, [command, openTerminal, target, terminalId]);

  const requestRun = useCallback(() => {
    if (running) return;
    if (shellRunNeedsConfirmation(target?.runtimeMode ?? null)) {
      setConfirming(true);
      return;
    }
    void run();
  }, [run, running, target?.runtimeMode]);

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
    setOpened(false);
    setError(null);
    void closeTerminal({
      environmentId: target.environmentId,
      input: { threadId: target.threadId, terminalId, deleteHistory: true },
    });
  }, [closeTerminal, target, terminalId]);

  const status = attached ? session.status : "idle";
  return {
    available: active && canOperate,
    running,
    confirming,
    visible: confirming || error !== null || attached,
    output,
    exitCode: session.exitCode,
    exitSignal: session.exitSignal,
    status,
    error: error ?? (attached ? session.error : null),
    environmentId,
    cwd: target?.worktreePath ?? target?.cwd ?? null,
    requestRun,
    confirmRun: () => void run(),
    cancelRun: () => setConfirming(false),
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
  const run = use(InlineShellRunContext);
  if (!run?.available) return null;
  const label = run.running ? "Stop" : "Run";
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant="ghost-muted"
            size="xs"
            onClick={run.running ? run.stop : run.requestRun}
            aria-label={run.running ? "Stop command" : "Run command"}
            data-shell-run-action={run.running ? "stop" : "run"}
          />
        }
      >
        {run.running ? <SquareIcon className="size-3" /> : <PlayIcon className="size-3" />}
        {label}
      </TooltipTrigger>
      <TooltipPopup side="top">
        {run.running ? "Stop the command" : "Run here and show the output below"}
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
  const hostLabel = useEnvironment(run.environmentId)?.label ?? null;
  const where = [hostLabel, run.cwd].filter(Boolean).join(" in ");
  return (
    <div
      className="flex flex-wrap items-center gap-2 border-t border-border/60 px-3 py-2 text-xs select-none"
      data-shell-run="confirm"
      role="group"
      aria-label="Confirm command"
    >
      <span className="min-w-0 flex-1 text-muted-foreground">
        Run this command{where ? ` on ${where}` : ""}?
      </span>
      <Button type="button" size="micro" onClick={run.confirmRun} data-shell-run-confirm="">
        Run
      </Button>
      <Button type="button" size="micro" variant="ghost-muted" onClick={run.cancelRun}>
        Cancel
      </Button>
    </div>
  );
}

export function InlineShellRunPanel() {
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

  const exit = exitLabel(run);
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
          aria-label="Command output"
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
      <div className="flex items-center gap-2 px-3 py-1.5 text-2xs select-none">
        {exit ? (
          <span
            className={
              exit.failed ? "font-medium text-destructive-foreground" : "text-muted-foreground"
            }
            role="status"
            data-shell-run-status=""
          >
            {exit.text}
          </span>
        ) : null}
        {run.error ? (
          <span className="min-w-0 truncate text-destructive-foreground" role="alert">
            {run.error}
          </span>
        ) : null}
        <span className="ms-auto flex items-center gap-0.5">
          {run.running ? (
            <Button type="button" size="micro" variant="ghost-muted" onClick={run.stop}>
              <SquareIcon className="size-3" />
              Stop
            </Button>
          ) : (
            <>
              <Button type="button" size="micro" variant="ghost-muted" onClick={run.requestRun}>
                <PlayIcon className="size-3" />
                Run again
              </Button>
              <Button type="button" size="micro" variant="ghost-muted" onClick={run.clear}>
                Clear
              </Button>
            </>
          )}
        </span>
      </div>
    </div>
  );
}
