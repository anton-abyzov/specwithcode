import type { EnvironmentId } from "@specweave-studio/contracts";
import { useId, useState } from "react";

import { environmentCatalog } from "~/connection/catalog";
import { cn } from "~/lib/utils";
import { reasonNeedsPairing } from "~/lib/machineStatus";
import { useAtomCommand } from "~/state/use-atom-command";
import { InlineButton } from "../ui/button";

/** Past this length the reason clamps to three lines with Show more. */
const CLAMP_AFTER = 300;

/**
 * Why a machine in Settings > Connections is not connected and what to do,
 * on its own wrapped line under the row's short status, so the instruction is
 * readable without hovering. Retry asks the machine's supervisor to try now; it
 * is left out when the reason says the machine has to be paired again, since
 * retrying cannot fix that.
 */
export function ConnectionReason({
  environmentId,
  reason,
  tone = "error",
  retryable = false,
  className,
}: {
  readonly environmentId: EnvironmentId;
  readonly reason: string;
  readonly tone?: "error" | "muted";
  readonly retryable?: boolean;
  readonly className?: string;
}) {
  const textId = useId();
  const retryEnvironment = useAtomCommand(environmentCatalog.retryNow, { reportFailure: false });
  const [retrying, setRetrying] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const canRetry = retryable && !reasonNeedsPairing(reason);
  const canExpand = reason.length > CLAMP_AFTER;
  return (
    <div className={cn("mt-0.5 min-w-0 text-xs", className)}>
      <p
        id={textId}
        className={cn(
          "break-words whitespace-pre-wrap",
          tone === "error" ? "text-destructive-foreground" : "text-muted-foreground",
          canExpand && !expanded && "line-clamp-3",
        )}
      >
        {reason}
      </p>
      {canRetry || canExpand ? (
        <div className="mt-0.5 flex items-center gap-3">
          {canRetry ? (
            <InlineButton
              tone="muted"
              disabled={retrying}
              onClick={async () => {
                setRetrying(true);
                try {
                  await retryEnvironment(environmentId);
                } finally {
                  setRetrying(false);
                }
              }}
            >
              {retrying ? "Retrying…" : "Retry now"}
            </InlineButton>
          ) : null}
          {canExpand ? (
            <InlineButton
              tone="muted"
              aria-expanded={expanded}
              aria-controls={textId}
              onClick={() => setExpanded((value) => !value)}
            >
              {expanded ? "Show less" : "Show more"}
            </InlineButton>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
