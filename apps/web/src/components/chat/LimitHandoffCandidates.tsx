import type {
  EnvironmentId,
  LimitHandoffCandidate,
  LimitHandoffCandidatesResult,
  ThreadId,
} from "@specweave-studio/contracts";
import { squashAtomCommandFailure } from "@specweave-studio/client-runtime/state/runtime";
import { useEffect, useState } from "react";

import { useAtomCommand } from "../../state/use-atom-command";
import { limitHandoff } from "../../studio/limitHandoff";
import { requestHandOffThread } from "../handoff/HandOffThreadDialog";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const REFRESH_MS = 30_000;

/** The order machines are tried in, as one sentence. */
export function limitHandoffOrderText(result: LimitHandoffCandidatesResult): string {
  return result.order === "other-machine-first"
    ? "Other machines are tried before this machine's models."
    : "This machine's models are tried before other machines.";
}

/**
 * The tooltip of "Move to {machine}": the order machines are tried in, then
 * each machine's verdict ("Minis: same Claude account as M4").
 */
export function limitHandoffOrderTip(result: LimitHandoffCandidatesResult): string {
  return [
    limitHandoffOrderText(result),
    ...result.candidates.map((candidate) => candidate.text),
  ].join("\n");
}

/**
 * The limit banner's machine target: one "Move to {machine}" button for the
 * first machine that can take the thread, which opens the thread's move
 * dialog on that machine with the model its verdict was for. Why the others
 * can't, and the order they are tried in, sit in the button's tooltip (it
 * opens on hover and on keyboard focus); when none can, the banner says why
 * the thread waits and lists each machine's verdict in plain view.
 */
export function LimitHandoffCandidateList({
  result,
  onMove,
}: {
  result: LimitHandoffCandidatesResult;
  onMove: (candidate: LimitHandoffCandidate) => void;
}) {
  if (result.candidates.length === 0) return null;
  if (!result.available) {
    return (
      <p className="basis-full text-xs text-muted-foreground">
        This server can't move threads to another machine yet.
      </p>
    );
  }
  const best = result.candidates.find((candidate) => candidate.eligible) ?? null;
  if (!best) {
    return (
      <div className="flex basis-full flex-col gap-1 text-xs" aria-label="Other machines">
        <p role="status" className="text-muted-foreground">
          {result.waiting ?? "No other machine can take this thread now."}
        </p>
        <ul
          className="flex flex-col gap-0.5 text-muted-foreground"
          data-slot="limit-handoff-verdicts"
        >
          {result.candidates.map((candidate) => (
            <li key={candidate.environmentId}>{candidate.text}</li>
          ))}
        </ul>
      </div>
    );
  }
  return (
    <div
      className="flex basis-full flex-wrap items-center gap-2 text-xs"
      aria-label="Other machines"
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              size="xs"
              variant="outline"
              className="max-w-full min-w-0"
              onClick={() => onMove(best)}
            >
              <span className="truncate">{`Move to ${best.machineLabel}`}</span>
            </Button>
          }
        />
        <TooltipPopup side="bottom" className="whitespace-pre-line">
          {limitHandoffOrderTip(result)}
        </TooltipPopup>
      </Tooltip>
    </div>
  );
}

/** Loads the verdicts for a thread and refreshes them while the banner shows. */
export function LimitHandoffCandidates({
  environmentId,
  threadId,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
}) {
  const candidates = useAtomCommand(limitHandoff.candidates, { reportFailure: false });
  const [result, setResult] = useState<LimitHandoffCandidatesResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    const load = async () => {
      const next = await candidates({ environmentId, input: { threadId } });
      if (!live) return;
      if (next._tag === "Failure") {
        const cause = squashAtomCommandFailure(next);
        setError(cause instanceof Error ? cause.message : "couldn't check them");
        return;
      }
      setError(null);
      setResult(next.value);
    };
    void load();
    const timer = window.setInterval(() => void load(), REFRESH_MS);
    return () => {
      live = false;
      window.clearInterval(timer);
    };
  }, [candidates, environmentId, threadId]);
  if (result)
    return (
      <LimitHandoffCandidateList
        result={result}
        onMove={(candidate) =>
          requestHandOffThread(
            { environmentId, threadId },
            {
              destinationEnvironmentId: candidate.environmentId,
              modelSelection: candidate.modelSelection,
            },
          )
        }
      />
    );
  return error ? (
    <p className="basis-full text-xs text-muted-foreground">{`Couldn't check other machines: ${error}`}</p>
  ) : null;
}
