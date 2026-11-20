import { useEffect, useState } from "react";

import { formatProgressElapsed, type CoordinatorProgress } from "../../studio/coordinatorProgress";

/** The coordinator's live line: what it is doing and for how long, counting every second. */
export function CoordinatorWorking({ progress }: { progress: CoordinatorProgress }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  return (
    <div className="sws-coordinator-working" role="status" aria-live="polite">
      <span className="sws-dot" data-tone={progress.waiting ? "waiting" : "working"} aria-hidden />
      <span className="sws-coordinator-working-label">{progress.label}…</span>
      {progress.since === null ? null : (
        <span className="sws-coordinator-working-time" aria-hidden>
          {formatProgressElapsed(progress.since, now)}
        </span>
      )}
    </div>
  );
}
