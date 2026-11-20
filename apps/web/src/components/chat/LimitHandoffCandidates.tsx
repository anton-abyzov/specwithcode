import { useTx } from "../../i18n";
import {
  MODEL_TRACK_LABELS,
  type EnvironmentId,
  type LimitHandoffCandidate,
  type LimitHandoffCandidatesResult,
  type ThreadId,
} from "@specweave-studio/contracts";
import { scopeProjectRef, scopeThreadRef } from "@specweave-studio/client-runtime/environment";
import { squashAtomCommandFailure } from "@specweave-studio/client-runtime/state/runtime";
import { describeTrackWait } from "@specweave-studio/shared/machineFallback";
import { useEffect, useRef, useState } from "react";

import { useProject, useThreadShell } from "../../state/entities";
import { useAtomCommand } from "../../state/use-atom-command";
import { useHandoffModeSnapshot } from "../../studio/handoffMode";
import { limitHandoff } from "../../studio/limitHandoff";
import {
  requestHandOffNoMove,
  requestHandOffProgress,
  type HandOffNoMove,
} from "../handoff/HandOffProgress";
import { threadTransfer } from "../handoff/handOffProgress.logic";
import { requestHandOffThread } from "../handoff/HandOffThreadDialog";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const REFRESH_MS = 30_000;

/** "14:02" today, "Nov 20, 14:02" on another day, in the reader's own time. */
export function formatResetTime(at: string, now = new Date()): string {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return at;
  const time = date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return date.toDateString() === now.toDateString()
    ? time
    : `${date.toLocaleDateString(undefined, { month: "short", day: "numeric" })}, ${time}`;
}

/** The order machines are tried in, as one sentence. */
export function limitHandoffOrderText(result: LimitHandoffCandidatesResult): string {
  return result.order === "other-machine-first"
    ? "Other machines are tried before this machine's models."
    : "This machine's models are tried before other machines.";
}

/**
 * The tooltip of "Hand off to {machine}": the order machines are tried in, then
 * each machine's verdict ("Minis: same Claude account as M4").
 */
export function limitHandoffOrderTip(result: LimitHandoffCandidatesResult): string {
  return [
    limitHandoffOrderText(result),
    ...result.candidates.map((candidate) => candidate.text),
  ].join("\n");
}

/** Why a review thread stays, per machine: the lock travels only where it is kept. */
const REVIEW_STAYS = {
  no_reviewer: "Review stays here: no permitted reviewer on {machine}",
  update_needed: "Review stays here: update SpecWithCode on {machine}",
} as const;

/**
 * The limit banner's machine target: one "Hand off to {machine}" button for
 * the first machine that can take the thread, which opens the thread's hand
 * off dialog on that machine with the model its verdict was for. Why the others
 * can't, and the order they are tried in, sit in the button's tooltip (it
 * opens on hover and on keyboard focus); when none can, the banner says why
 * the thread waits and lists each machine's verdict in plain view.
 *
 * A thread on a track that no machine has says so instead, with the earliest
 * reset or "Reset unknown" and what each machine answered (1390). Nothing is
 * offered to move it: it stays until that reset.
 */
export function LimitHandoffCandidateList({
  result,
  onMove,
  formatTime = formatResetTime,
}: {
  result: LimitHandoffCandidatesResult;
  onMove: (candidate: LimitHandoffCandidate) => void;
  formatTime?: (at: string) => string;
}) {
  const tx = useTx();
  const trackWait = result.track == null ? null : describeTrackWait(result.track, formatTime);
  if (trackWait !== null) {
    return (
      <div
        className="flex basis-full flex-col gap-1 text-xs"
        aria-label={tx("Other machines")}
        data-slot="limit-handoff-track-wait"
      >
        <p role="status" className="text-muted-foreground">
          {`${trackWait.title}. ${trackWait.detail}.`}
        </p>
        {result.track!.machines.length > 0 ? (
          <ul
            className="flex flex-col gap-0.5 text-muted-foreground"
            data-slot="limit-handoff-verdicts"
          >
            {result.track!.machines.map((machine) => (
              <li key={machine.environmentId}>{machine.line}</li>
            ))}
          </ul>
        ) : null}
      </div>
    );
  }
  if (result.candidates.length === 0) return null;
  if (!result.available) {
    return (
      <p className="basis-full text-xs text-muted-foreground">
        {tx("This machine can't hand threads off yet.")}
      </p>
    );
  }
  const best = result.candidates.find((candidate) => candidate.eligible) ?? null;
  if (!best) {
    return (
      <div className="flex basis-full flex-col gap-1 text-xs" aria-label={tx("Other machines")}>
        {/* A review that stays says so once, in its own row. */}
        {result.candidates.every((candidate) => candidate.review !== undefined) ? null : (
          <p role="status" className="text-muted-foreground">
            {result.waiting ?? tx("No other machine can take this thread now.")}
          </p>
        )}
        <ul
          className="flex flex-col gap-0.5 text-muted-foreground"
          data-slot="limit-handoff-verdicts"
        >
          {result.candidates.map((candidate) => (
            <li key={candidate.environmentId}>
              {candidate.review === undefined
                ? candidate.text
                : tx(REVIEW_STAYS[candidate.review], { machine: candidate.machineLabel })}
            </li>
          ))}
        </ul>
      </div>
    );
  }
  return (
    <div
      className="flex basis-full flex-wrap items-center gap-2 text-xs"
      aria-label={tx("Other machines")}
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
              <span className="truncate">
                {tx("Hand off to {machine}", { machine: best.machineLabel })}
              </span>
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

/** The banner's line for a thread whose hand off this machine has a record of. */
export function LimitHandoffProgressLink({ onOpen }: { onOpen: () => void }) {
  const tx = useTx();
  return (
    <div className="flex basis-full flex-wrap items-center gap-2 text-xs">
      <Button size="xs" variant="outline" onClick={onOpen}>
        {tx("Show hand off progress")}
      </Button>
    </div>
  );
}

type TrackDecision = LimitHandoffCandidatesResult["track"];

/**
 * The progress view's no-move state for a decision where every machine is out
 * of the thread's track (1390 AC-39), else null. Each out machine's reset is
 * listed, and the decision's earliest reset is kept when none of them said it.
 */
export function trackNoMove(track: TrackDecision, projectName: string): HandOffNoMove | null {
  if (!track || !track.everyMachineOut || track.target !== null) return null;
  const resets = track.machines
    .filter((machine) => machine.state === "out")
    .map((machine) => ({ machineLabel: machine.machineLabel, resetsAt: machine.resetsAt }));
  const earliest = track.earliestReset;
  if (earliest && !resets.some((reset) => reset.resetsAt === earliest.at))
    resets.push({ machineLabel: earliest.machineLabel, resetsAt: earliest.at });
  return {
    projectName,
    trackOut: { track: MODEL_TRACK_LABELS[track.track], staying: 1, resets },
  };
}

/**
 * Opens the no-move view by itself when the track runs out on every machine:
 * once per episode, so the banner's refresh never reopens a view that was closed.
 */
export function useTrackNoMove(
  environmentId: EnvironmentId,
  track: TrackDecision,
  projectName: string,
) {
  const opened = useRef<string | null>(null);
  // Read when an episode starts; later refreshes leave the opened view as it is.
  const latest = useRef<HandOffNoMove | null>(null);
  latest.current = trackNoMove(track, projectName);
  const episode = latest.current && track ? `${track.threadId}:${track.track}` : null;
  useEffect(() => {
    if (episode === null) {
      opened.current = null;
      return;
    }
    if (opened.current === episode || latest.current === null) return;
    opened.current = episode;
    requestHandOffNoMove(environmentId, latest.current);
  }, [environmentId, episode]);
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
  const tx = useTx();
  const shell = useThreadShell(scopeThreadRef(environmentId, threadId));
  const project = useProject(shell ? scopeProjectRef(environmentId, shell.projectId) : null);
  useTrackNoMove(environmentId, result?.track, project?.title || tx("This project"));
  // A hand off of this thread that this machine has a record of: its progress view is one press away.
  const { snapshot } = useHandoffModeSnapshot(environmentId);
  const progress = threadTransfer(snapshot?.transfers, threadId) ? (
    <LimitHandoffProgressLink onOpen={() => requestHandOffProgress(environmentId, { threadId })} />
  ) : null;
  if (result)
    return (
      <>
        {progress}
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
      </>
    );
  if (progress) return progress;
  return error ? (
    <p className="basis-full text-xs text-muted-foreground">{`Couldn't check other machines: ${error}`}</p>
  ) : null;
}
