import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@specweave-studio/client-runtime/state/runtime";
import type {
  EnvironmentId,
  ProviderInstanceId,
  RuntimeMode,
  ScopedThreadRef,
  ThreadId,
} from "@specweave-studio/contracts";
import { useCallback, useRef, useState, type ReactNode } from "react";

import { terminalEnvironment } from "../../state/terminal";
import { useAtomCommand } from "../../state/use-atom-command";
import { ClaudeShipDialog } from "./ClaudeShipDialog";
import {
  buildClaudeShipTerminalCommand,
  claudeShipPermissionMode,
  claudeShipPlan,
  ClaudeShipCommandError,
  parseClaudeShipCommand,
  type ClaudeShipLine,
} from "./claudeShip.logic";

export interface ClaudeShipContext {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId | null;
  readonly threadTarget: ScopedThreadRef | null;
  /** The thread's folder: its worktree when it has one. */
  readonly cwd: string | null;
  readonly fallbackCwd: string | null;
  readonly worktreePath: string | null;
  readonly providerInstanceId: ProviderInstanceId | null;
  /** The thread's Claude session, from its active provider thread. */
  readonly sessionId: string | null;
  readonly cliVersion: string | null;
  readonly binaryPath: string;
  readonly platformOs: string | null;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: string;
  readonly hasTerminalWriteAccess: () => boolean;
  readonly allocateTerminalId: () => string;
  /** The project's script environment, as every other thread terminal gets. */
  readonly env: Record<string, string> | undefined;
  readonly showTerminal: (threadTarget: ScopedThreadRef, terminalId: string) => void;
  /** Removes a tab whose terminal did not open. */
  readonly dropTerminal: (threadTarget: ScopedThreadRef, terminalId: string) => void;
}

/** Set by the composer each render: send the draft as a prompt, and clear it. */
export interface ClaudeShipComposerHandlers {
  resend?: () => void;
  clearDraft?: () => void;
}

/**
 * `/ship` and `/steward` typed in a Claude thread open a card that hands the
 * line to a Claude Code session in the thread's terminal (increment 1458).
 */
export function useClaudeShip(context: ClaudeShipContext): {
  /** True when the draft was one of these commands and the card took it. */
  readonly intercept: (text: string) => boolean;
  readonly composer: ClaudeShipComposerHandlers;
  readonly dialog: ReactNode;
} {
  const openTerminal = useAtomCommand(terminalEnvironment.open, "terminal open");
  const [line, setLine] = useState<ClaudeShipLine | null>(null);
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const composer = useRef<ClaudeShipComposerHandlers>({}).current;
  // One send that skips the card: the person chose to send the line to Claude as written.
  // It holds for a moment only, so a send that stopped early can't skip a later card.
  const bypassUntil = useRef(0);

  const intercept = useCallback((text: string) => {
    if (Date.now() < bypassUntil.current) {
      bypassUntil.current = 0;
      return false;
    }
    const parsed = parseClaudeShipCommand(text);
    if (parsed === null) return false;
    setError(null);
    setLine(parsed);
    return true;
  }, []);

  const plan = claudeShipPlan({
    cliVersion: context.cliVersion,
    interactionMode: context.interactionMode,
    runtimeMode: context.runtimeMode,
    platform: context.platformOs,
    sessionId: context.sessionId,
  });

  const onOpenTerminal = async () => {
    const { threadId, threadTarget, cwd } = context;
    if (threadId === null || threadTarget === null || cwd === null) {
      setError("This thread has no folder to open a terminal in.");
      return;
    }
    if (!context.hasTerminalWriteAccess()) {
      setError("This connection can't open terminals on that machine.");
      return;
    }
    let command: string;
    try {
      command = buildClaudeShipTerminalCommand({
        binaryPath: context.binaryPath,
        sessionId: context.sessionId,
        permissionMode: claudeShipPermissionMode(context.runtimeMode),
      });
    } catch (cause) {
      setError(cause instanceof ClaudeShipCommandError ? cause.message : String(cause));
      return;
    }
    setOpening(true);
    const terminalId = context.allocateTerminalId();
    context.showTerminal(threadTarget, terminalId);
    const result = await openTerminal({
      environmentId: context.environmentId,
      input: {
        threadId,
        terminalId,
        cwd,
        ...(context.fallbackCwd !== null ? { fallbackCwd: context.fallbackCwd } : {}),
        ...(context.worktreePath !== null ? { worktreePath: context.worktreePath } : {}),
        ...(context.providerInstanceId !== null
          ? { providerInstanceId: context.providerInstanceId }
          : {}),
        ...(context.env !== undefined ? { env: context.env } : {}),
        command,
      },
    });
    setOpening(false);
    if (result._tag === "Failure") {
      context.dropTerminal(threadTarget, terminalId);
      if (isAtomCommandInterrupted(result)) return;
      const cause = squashAtomCommandFailure(result);
      setError(cause instanceof Error ? cause.message : "The terminal could not open.");
      return;
    }
    composer.clearDraft?.();
    setLine(null);
  };

  const onSendAnyway = () => {
    setLine(null);
    bypassUntil.current = Date.now() + 2_000;
    composer.resend?.();
  };

  const dialog =
    line === null ? null : (
      <ClaudeShipDialog
        open
        onOpenChange={(next) => {
          if (!next && !opening) setLine(null);
        }}
        line={line}
        plan={plan}
        opening={opening}
        error={error}
        onOpenTerminal={() => void onOpenTerminal()}
        onSendAnyway={onSendAnyway}
      />
    );

  return { intercept, composer, dialog };
}

interface ClaudeShipProjection {
  readonly thread: { readonly activeProviderThreadId: string | null };
  readonly providerThreads: ReadonlyArray<{
    readonly id: string;
    readonly driver: string;
    readonly providerInstanceId: string;
    readonly nativeThreadRef: { readonly nativeId: string | null } | null;
  }>;
}

/**
 * The thread's own Claude facts: its session (only when it belongs to the
 * selected Claude instance, whose sign-in folder holds the transcript), the
 * CLI version that instance reported and its configured program.
 */
export function claudeShipContextValues(input: {
  readonly projection: ClaudeShipProjection | null | undefined;
  readonly driverKind: string | null | undefined;
  readonly providerInstanceId: ProviderInstanceId | null;
  readonly providerStatus: { readonly version: string | null } | null;
  readonly providerInstances: Readonly<Record<string, { readonly config?: unknown }>> | undefined;
  readonly platformOs: string | null;
}): Pick<
  ClaudeShipContext,
  "providerInstanceId" | "sessionId" | "cliVersion" | "binaryPath" | "platformOs"
> {
  const isClaude = input.driverKind === "claudeAgent";
  const projection = input.projection ?? null;
  const active =
    projection === null
      ? undefined
      : projection.providerThreads.find(
          (thread) => thread.id === projection.thread.activeProviderThreadId,
        );
  const sessionId =
    isClaude &&
    active !== undefined &&
    active.driver === "claudeAgent" &&
    active.providerInstanceId === input.providerInstanceId
      ? (active.nativeThreadRef?.nativeId ?? null)
      : null;
  const config =
    input.providerInstanceId === null
      ? undefined
      : input.providerInstances?.[input.providerInstanceId]?.config;
  const binaryPath =
    config !== null &&
    typeof config === "object" &&
    "binaryPath" in config &&
    typeof config.binaryPath === "string"
      ? config.binaryPath.trim()
      : "";
  return {
    providerInstanceId: isClaude ? input.providerInstanceId : null,
    sessionId,
    cliVersion: isClaude ? (input.providerStatus?.version ?? null) : null,
    binaryPath: binaryPath || "claude",
    platformOs: input.platformOs,
  };
}
