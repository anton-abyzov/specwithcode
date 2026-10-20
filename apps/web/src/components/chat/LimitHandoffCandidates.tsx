import type {
  EnvironmentId,
  LimitHandoffCandidatesResult,
  ThreadId,
} from "@specweave-studio/contracts";
import { squashAtomCommandFailure } from "@specweave-studio/client-runtime/state/runtime";
import { useEffect, useState } from "react";

import { useAtomCommand } from "../../state/use-atom-command";
import { limitHandoff } from "../../studio/limitHandoff";

const REFRESH_MS = 30_000;

/**
 * The limit banner's machine targets: which paired machine takes the thread,
 * or why each one can't ("Minis: same Claude account as M4").
 */
export function LimitHandoffCandidateList({ result }: { result: LimitHandoffCandidatesResult }) {
  if (result.candidates.length === 0) return null;
  const order =
    result.order === "other-machine-first"
      ? "Other machines are tried before this machine's models."
      : "This machine's models are tried before other machines.";
  return (
    <div className="flex basis-full flex-col gap-1 text-xs" aria-label="Other machines">
      <span className="text-muted-foreground">
        {result.available
          ? `Other machines. ${order}`
          : "Other machines. This server can't move threads to another machine yet."}
      </span>
      <ol className="flex flex-col gap-0.5">
        {result.candidates.map((candidate, index) => (
          <li
            key={`${candidate.environmentId}:${candidate.modelSelection.instanceId}:${candidate.modelSelection.model}`}
            className={candidate.eligible ? "text-foreground" : "text-muted-foreground"}
          >
            {`${index + 1}. ${candidate.text}`}
          </li>
        ))}
      </ol>
      {result.waiting ? (
        <p role="status" className="text-muted-foreground">
          {result.waiting}
        </p>
      ) : null}
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
  if (result) return <LimitHandoffCandidateList result={result} />;
  return error ? (
    <p className="basis-full text-xs text-muted-foreground">{`Other machines: ${error}`}</p>
  ) : null;
}
