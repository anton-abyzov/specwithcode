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
import { defaultInstanceIdForDriver, ProviderDriverKind } from "@specweave-studio/contracts";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import { useLatestRef } from "../../hooks/useLatestRef";
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

const CLAUDE_DRIVER = ProviderDriverKind.make("claudeAgent");

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

/** Set by the composer each render: clears the draft once the terminal opened. */
export interface ClaudeShipComposerHandlers {
  /** Clears the draft only while it still reads `sentText`: newer text is the person's. */
  clearDraft?: (sentText: string) => void;
}

/**
 * `/ship` and `/steward` typed in a Claude thread open a card that hands the
 * line to a Claude Code session in the thread's terminal (increment 1458).
 */
export function useClaudeShip(context: ClaudeShipContext): {
  /**
   * True when the draft was one of these commands and the card took it.
   * `sendAsWritten` sends that same draft past the card, for a custom command of the same name.
   */
  readonly intercept: (text: string, sendAsWritten: () => void) => boolean;
  readonly composer: ClaudeShipComposerHandlers;
  readonly dialog: ReactNode;
} {
  const openTerminal = useAtomCommand(terminalEnvironment.open, "terminal open");
  // The card belongs to the thread whose draft it took. The view is reused
  // across threads, so a card left open is dropped when the thread changes,
  // and its actions never run on another thread's folder, session or draft.
  const threadKey = `${context.environmentId}\u0000${context.threadId ?? ""}`;
  const [card, setCard] = useState<{
    readonly line: ClaudeShipLine;
    readonly text: string;
    readonly threadKey: string;
  } | null>(null);
  const line = card !== null && card.threadKey === threadKey ? card.line : null;
  const setLine = (next: ClaudeShipLine | null) =>
    setCard(next === null ? null : { line: next, text: next.line, threadKey });
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const composer = useRef<ClaudeShipComposerHandlers>({}).current;
  const sendAsWrittenRef = useRef<(() => void) | null>(null);

  const intercept = useCallback(
    (text: string, sendAsWritten: () => void) => {
      const parsed = parseClaudeShipCommand(text);
      if (parsed === null) return false;
      sendAsWrittenRef.current = sendAsWritten;
      setError(null);
      setCard({ line: parsed, text, threadKey });
      return true;
    },
    [threadKey],
  );
  useEffect(() => {
    // A card from another thread is gone for good, with its pending send.
    if (card === null || card.threadKey === threadKey) return;
    sendAsWrittenRef.current = null;
    setCard(null);
  }, [threadKey, card]);
  // An open still in flight from the last thread no longer speaks for this one.
  const threadKeyRef = useLatestRef(threadKey);
  useEffect(() => {
    setOpening(false);
    setError(null);
  }, [threadKey]);

  const plan = claudeShipPlan({
    cliVersion: context.cliVersion,
    interactionMode: context.interactionMode,
    runtimeMode: context.runtimeMode,
    platform: context.platformOs,
    sessionId: context.sessionId,
  });

  const onOpenTerminal = async () => {
    if (line === null) return;
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
    // The composer swaps this callback on every render, and the view can move to
    // another thread while the terminal opens: clear the draft of the thread
    // that asked, never the one shown when the open finishes.
    const clearDraft = composer.clearDraft;
    const sentText = card?.text ?? line.line;
    const askedFrom = threadKey;
    setOpening(true);
    const terminalId = context.allocateTerminalId();
    context.showTerminal(threadTarget, terminalId);
    const result = await openTerminal({
      environmentId: context.environmentId,
      input: {
        threadId,
        terminalId,
        cwd,
        // No fallback folder: Claude must start in the thread's own checkout. When
        // its worktree is gone the open fails and says so, rather than running
        // /ship against the project root's branch.
        ...(context.worktreePath !== null ? { worktreePath: context.worktreePath } : {}),
        ...(context.providerInstanceId !== null
          ? { providerInstanceId: context.providerInstanceId }
          : {}),
        ...(context.env !== undefined ? { env: context.env } : {}),
        command,
      },
    });
    const stillHere = threadKeyRef.current === askedFrom;
    if (stillHere) setOpening(false);
    if (result._tag === "Failure") {
      context.dropTerminal(threadTarget, terminalId);
      if (isAtomCommandInterrupted(result) || !stillHere) return;
      const cause = squashAtomCommandFailure(result);
      setError(cause instanceof Error ? cause.message : "The terminal could not open.");
      return;
    }
    clearDraft?.(sentText);
    // Only the asking thread's card closes; a card opened since on another thread stays.
    setCard((current) => (current?.threadKey === askedFrom ? null : current));
  };

  const onSendAnyway = () => {
    if (line === null) return;
    const sendAsWritten = sendAsWrittenRef.current;
    sendAsWrittenRef.current = null;
    setLine(null);
    sendAsWritten?.();
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
  /**
   * The legacy `settings.providers` blob. The server builds the default Claude
   * instance from `providers.claudeAgent` when `providerInstances` has no
   * entry for it, so its program is read from there too.
   */
  readonly legacyProviders?: Readonly<Record<string, unknown>> | undefined;
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
  const instanceId = input.providerInstanceId;
  const instances = input.providerInstances;
  const legacy = input.legacyProviders;
  const config =
    instanceId === null
      ? undefined
      : instances !== undefined && Object.hasOwn(instances, instanceId)
        ? instances[instanceId]?.config
        : instanceId === defaultInstanceIdForDriver(CLAUDE_DRIVER) &&
            legacy !== undefined &&
            Object.hasOwn(legacy, CLAUDE_DRIVER)
          ? legacy[CLAUDE_DRIVER]
          : undefined;
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
