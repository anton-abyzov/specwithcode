import { Button } from "../ui/button";

export interface ContextLimitRecoveryActions {
  /** Only the latest terminal root failure owns inline actions. */
  failureItemId?: string | null;
  /** Omit when the selected provider does not support native compaction. */
  onCompactContext?: () => void;
  compactDisabledReason?: string | null;
  onNewThread: () => void;
}

/** Callers provide the existing guarded composer and same-project draft actions. */
export function ContextLimitRecovery({
  recovery,
}: {
  recovery?: ContextLimitRecoveryActions | undefined;
}) {
  if (!recovery) return null;
  return (
    <div className="space-y-2" data-context-limit-recovery>
      <p className="text-sm text-muted-foreground">
        {recovery.onCompactContext
          ? "Compact the conversation or start a new thread with a shorter prompt to continue."
          : "Start a new thread with a shorter prompt to continue."}
      </p>
      <div className="flex flex-wrap gap-2">
        {recovery.onCompactContext ? (
          <Button
            size="xs"
            variant="outline"
            disabled={Boolean(recovery.compactDisabledReason)}
            onClick={recovery.onCompactContext}
          >
            Compact context
          </Button>
        ) : null}
        <Button size="xs" variant="outline" onClick={recovery.onNewThread}>
          New thread
        </Button>
      </div>
      {recovery.onCompactContext && recovery.compactDisabledReason ? (
        <p className="text-xs text-muted-foreground">{recovery.compactDisabledReason}</p>
      ) : null}
    </div>
  );
}
