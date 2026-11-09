/**
 * The wake card (D-02 `prompt`): when work left this machine and is not back,
 * a small card asks to bring it back with one click. "Later" hides it for
 * that session; Settings can turn the prompt off.
 */
import type { AwaySnapshot, EnvironmentId } from "@specweave-studio/contracts";
import { useEffect, useState } from "react";

import { requestAway } from "../../studio/awayRequest";
import { Button } from "../ui/button";
import { RunHereAnyway } from "./AwayDialog";
import { awayRpc, runAway } from "./awayRpc";
import { AWAY_WAKE_POLL_MS, showAwayWakeCard, showRunHereAnyway } from "./awaySession.logic";

const DISMISSED_KEY = "specwithcode:away-wake-dismissed";

function readDismissed(): string | null {
  try {
    return window.sessionStorage.getItem(DISMISSED_KEY);
  } catch {
    return null;
  }
}

export function AwayWakeCard(props: { environmentId: EnvironmentId; hidden?: boolean }) {
  const { environmentId } = props;
  const [snapshot, setSnapshot] = useState<AwaySnapshot | null>(null);
  // When the snapshot was read: Run here anyway is judged against it, not during render.
  const [readAt, setReadAt] = useState(0);
  const [dismissed, setDismissed] = useState<string | null>(() => readDismissed());
  const [bringing, setBringing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    const read = () =>
      void runAway(awayRpc.snapshot, { environmentId, input: {} }).then((next) => {
        if (!live || !next.ok) return;
        setSnapshot(next.value);
        setReadAt(Date.now());
      });
    read();
    const timer = setInterval(read, AWAY_WAKE_POLL_MS);
    // A wake or unlock brings the window back; ask again then.
    const onVisible = () => {
      if (document.visibilityState === "visible") read();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      live = false;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [environmentId]);

  if (props.hidden) return null;
  // The target stayed silent ten minutes after a wake: the owner may run the held work here.
  if (showRunHereAnyway(snapshot, readAt)) {
    const waiting = snapshot!.session!;
    return (
      <section
        role="dialog"
        aria-label="The other machine has not answered"
        data-testid="away-wake-card-silent"
        className="fixed right-4 bottom-4 z-50 flex w-80 flex-col gap-2 rounded-xl border border-border bg-popover py-4 text-sm shadow-lg"
      >
        <p className="px-4 font-medium">{`${waiting.targetLabel} has not answered`}</p>
        <p className="px-4 text-muted-foreground">
          {`This machine holds the work it handed to ${waiting.targetLabel} until it answers.`}
        </p>
        {error ? (
          <p role="alert" className="px-4 text-xs text-destructive-foreground">
            {error}
          </p>
        ) : null}
        <RunHereAnyway
          className="px-4"
          targetLabel={waiting.targetLabel}
          onConfirm={() => {
            setError(null);
            void runAway(awayRpc.forceLocal, {
              environmentId,
              input: { sessionId: waiting.sessionId },
            }).then((next) => {
              if (!next.ok) {
                setError(next.error);
                return;
              }
              setSnapshot({ ...snapshot!, session: next.value });
            });
          }}
        />
      </section>
    );
  }
  if (!showAwayWakeCard(snapshot, dismissed)) return null;
  const session = snapshot!.session!;
  return (
    <AwayWakeCardView
      targetLabel={session.targetLabel}
      bringing={bringing}
      error={error}
      onBringBack={() => {
        setBringing(true);
        setError(null);
        void runAway(awayRpc.bringBack, {
          environmentId,
          input: { sessionId: session.sessionId },
        }).then((next) => {
          setBringing(false);
          if (!next.ok) {
            setError(next.error);
            return;
          }
          setSnapshot({ ...snapshot!, session: next.value, running: true });
          // The dialog follows Bring back and shows what came back.
          requestAway("back");
        });
      }}
      onLater={() => {
        setDismissed(session.sessionId);
        try {
          window.sessionStorage.setItem(DISMISSED_KEY, session.sessionId);
        } catch {
          // Private windows may refuse storage; the card stays hidden until reload.
        }
      }}
    />
  );
}

export function AwayWakeCardView(props: {
  targetLabel: string;
  bringing: boolean;
  error: string | null;
  onBringBack: () => void;
  onLater: () => void;
}) {
  return (
    <section
      role="dialog"
      aria-label="Bring work back"
      data-testid="away-wake-card"
      className="fixed right-4 bottom-4 z-50 flex w-80 flex-col gap-2 rounded-xl border border-border bg-popover p-4 text-sm shadow-lg"
    >
      <p className="font-medium">{`Your work is on ${props.targetLabel}`}</p>
      <p className="text-muted-foreground">
        Bring threads, routines and coordinators back to this machine?
      </p>
      {props.error ? (
        <p role="alert" className="text-xs text-destructive-foreground">
          {props.error}
        </p>
      ) : null}
      <div className="flex justify-end gap-2">
        <Button type="button" size="sm" variant="outline" onClick={props.onLater}>
          Later
        </Button>
        <Button type="button" size="sm" disabled={props.bringing} onClick={props.onBringBack}>
          {props.bringing ? "Bringing back…" : "Bring back"}
        </Button>
      </div>
    </section>
  );
}
