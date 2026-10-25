import type { EnvironmentThreadShell } from "@specweave-studio/client-runtime/state/shell";
import type { DesignThreadBinding, EnvironmentId } from "@specweave-studio/contracts";
import { InfoIcon, MessageSquarePlusIcon, MonitorIcon } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Button } from "~/components/ui/button";
import { Spinner } from "~/components/ui/spinner";
import { NO_PROVIDER_THREAD_NOTICE, WAITING_FOR_PROVIDER_NOTICE } from "../projectThread";
import type { DesignMachine } from "./backend";

/** Above the thread when this window could not attach it to the design itself. */
function attachNotice(reason: string) {
  const why = reason.trim().replace(/[.!]?$/, ".");
  return `The thread started, but this window could not attach it to the design. ${why} The agent attaches it itself, and your canvas edits keep saving.`;
}

/** Whether a thread has messages or runs, from its shell; undefined while the shell is not loaded. */
export function threadHasStarted(
  shell:
    | Pick<EnvironmentThreadShell, "latestRun" | "latestUserMessageAt" | "itemCount">
    | undefined,
): boolean | undefined {
  if (shell === undefined) return undefined;
  return shell.latestRun !== null || shell.latestUserMessageAt !== null || shell.itemCount > 0;
}

/**
 * What the pane says above the thread: that the agent attaches a thread this
 * window could not bind, or that the design's thread cannot run because no
 * provider on its machine is ready. Only a thread known to have no messages
 * or runs is told its first message waits in the composer.
 */
export function threadNotice({
  binding,
  selfBinding,
  providerReady,
  started,
}: {
  /** The design's own binding. */
  binding: DesignThreadBinding | null;
  /** A thread this window started but could not bind. */
  selfBinding: { readonly reason: string } | null;
  providerReady?: boolean | undefined;
  /** From `threadHasStarted`; undefined when unknown. */
  started?: boolean | undefined;
}): string | null {
  if (binding === null) return selfBinding === null ? null : attachNotice(selfBinding.reason);
  if (providerReady !== false) return null;
  return started === false ? WAITING_FOR_PROVIDER_NOTICE : NO_PROVIDER_THREAD_NOTICE;
}

/**
 * The left side of the editor: the design's agent thread when it runs on
 * this machine, the machine that has it otherwise, or a way to start one.
 */
export function BoundThreadPane({
  binding,
  environmentId,
  machine,
  renderChat,
  onStartThread,
  onOpenThere,
  canStart,
  notice = null,
}: {
  binding: DesignThreadBinding | null;
  environmentId: EnvironmentId;
  machine: (environmentId: EnvironmentId) => DesignMachine | null;
  renderChat: (binding: DesignThreadBinding) => ReactNode;
  onStartThread: () => Promise<void>;
  onOpenThere: (binding: DesignThreadBinding) => void;
  /** Starting the design's thread binds it, which needs edit access. */
  canStart: boolean;
  /** Shown above the thread, e.g. when the agent has yet to attach it to the design. */
  notice?: string | null;
}) {
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const start = async () => {
    setStarting(true);
    setError(null);
    try {
      await onStartThread();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setStarting(false);
    }
  };
  if (binding !== null && binding.environmentId === environmentId)
    return (
      <div data-testid="bound-thread" className="flex min-h-0 flex-1 flex-col">
        {notice !== null && (
          <p
            role="status"
            data-testid="bound-thread-notice"
            className="mx-3 mt-2 flex shrink-0 items-start gap-2 rounded-lg border border-border/70 bg-muted/40 px-3 py-2 text-xs leading-relaxed text-muted-foreground"
          >
            <InfoIcon aria-hidden className="mt-0.5 size-3.5 shrink-0" />
            <span>{notice}</span>
          </p>
        )}
        <div className="project-native-thread">{renderChat(binding)}</div>
      </div>
    );
  const other = binding === null ? null : machine(binding.environmentId);
  return (
    <div
      data-testid="bound-thread-empty"
      className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-8 text-center"
    >
      {binding === null ? (
        <>
          <MessageSquarePlusIcon className="size-7 text-muted-foreground" aria-hidden />
          <h2 className="text-base font-medium">No thread on this design yet</h2>
          <p className="max-w-72 text-sm text-muted-foreground">
            Start one to describe what you want. The agent edits this canvas with the design tools
            while you work on it.
          </p>
        </>
      ) : (
        <>
          <MonitorIcon className="size-7 text-muted-foreground" aria-hidden />
          <h2 className="text-base font-medium">
            The thread runs on {other?.label ?? "another machine"}
          </h2>
          <p className="max-w-72 text-sm text-muted-foreground">
            {other?.linked === true
              ? "Open it there, or start a thread on this machine. The new thread becomes the design's thread."
              : "That machine is not linked here. Start a thread on this machine to keep working; it becomes the design's thread."}
          </p>
        </>
      )}
      <div className="flex flex-wrap justify-center gap-2">
        {binding !== null && other?.linked === true && (
          <Button variant="outline" onClick={() => onOpenThere(binding)}>
            Open there
          </Button>
        )}
        {canStart && (
          <Button onClick={() => void start()} disabled={starting}>
            {starting && <Spinner />}
            {binding === null ? "Start a thread" : "Start a thread here"}
          </Button>
        )}
      </div>
      {!canStart && (
        <p className="max-w-72 text-xs text-muted-foreground">
          You can view this design. Someone with edit access starts its thread.
        </p>
      )}
      {error !== null && (
        <p role="alert" className="max-w-72 text-xs text-destructive-foreground">
          The thread did not start: {error.replace(/\.$/, "")}. Nothing on the canvas changed.
        </p>
      )}
    </div>
  );
}
