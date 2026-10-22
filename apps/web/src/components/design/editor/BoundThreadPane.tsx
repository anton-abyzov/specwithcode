import type { DesignThreadBinding, EnvironmentId } from "@specweave-studio/contracts";
import { MessageSquarePlusIcon, MonitorIcon } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Button } from "~/components/ui/button";
import { Spinner } from "~/components/ui/spinner";
import type { DesignMachine } from "./backend";

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
}: {
  binding: DesignThreadBinding | null;
  environmentId: EnvironmentId;
  machine: (environmentId: EnvironmentId) => DesignMachine | null;
  renderChat: (binding: DesignThreadBinding) => ReactNode;
  onStartThread: () => Promise<void>;
  onOpenThere: (binding: DesignThreadBinding) => void;
  /** Starting the design's thread binds it, which needs edit access. */
  canStart: boolean;
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
      <div data-testid="bound-thread" className="project-native-thread">
        {renderChat(binding)}
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
      {error !== null && <p className="max-w-72 text-xs text-destructive-foreground">{error}</p>}
    </div>
  );
}
