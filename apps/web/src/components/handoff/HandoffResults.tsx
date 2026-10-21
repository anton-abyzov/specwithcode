import type {
  EnvironmentId,
  HandoffMachineRun,
  HandoffPreflightResult,
  ThreadId,
} from "@specweave-studio/contracts";

import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";

/** A machine a thread can move to; "this-machine" continues here with another model. */
export interface HandoffDestination {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly state: "reachable" | "offline" | "this-machine";
}

export function destinationText(destination: HandoffDestination): string {
  if (destination.state === "this-machine") return `${destination.label} (this machine)`;
  return destination.state === "offline" ? `${destination.label} (offline)` : destination.label;
}

export function HandoffDestinationSelect(props: {
  id: string;
  destinations: readonly HandoffDestination[];
  value: EnvironmentId | null;
  disabled?: boolean;
  onChange: (environmentId: EnvironmentId) => void;
}) {
  const selected = props.destinations.find((item) => item.environmentId === props.value) ?? null;
  if (props.destinations.length === 0)
    return (
      <p className="text-sm text-muted-foreground">
        No other machine is paired with this one. Pair one in Settings &gt; Connections.
      </p>
    );
  return (
    <Select
      value={props.value}
      disabled={props.disabled}
      onValueChange={(value) => {
        if (value) props.onChange(value as EnvironmentId);
      }}
    >
      <SelectTrigger id={props.id} size="sm">
        <SelectValue>{selected ? destinationText(selected) : "Choose a machine"}</SelectValue>
      </SelectTrigger>
      <SelectPopup>
        {props.destinations.map((destination) => (
          <SelectItem
            key={destination.environmentId}
            value={destination.environmentId}
            disabled={destination.state === "offline"}
          >
            {destinationText(destination)}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}

export type PreflightView =
  | { readonly state: "idle" }
  | { readonly state: "checking" }
  | { readonly state: "error"; readonly message: string }
  | { readonly state: "done"; readonly results: readonly HandoffPreflightResult[] };

/** Every failed check, worded by the destination exactly as it sent it: "Minis: no .env.local". */
export function HandoffPreflightFailures({ result }: { result: HandoffPreflightResult }) {
  if (result.ok || result.failures.length === 0) return null;
  return (
    <ul className="flex flex-col gap-0.5 text-xs text-destructive-foreground" role="list">
      {result.failures.map((failure) => (
        <li key={`${failure.check}:${failure.message}`} data-check={failure.check}>
          {failure.message}
        </li>
      ))}
    </ul>
  );
}

/** One thread's preflight verdict, then what happens to its run. */
export function preflightSummary(result: HandoffPreflightResult): string {
  if (!result.ok) return "Stays here: a check failed.";
  return result.resume
    ? "Ready. Its turn continues there."
    : "Ready. It moves without starting a turn.";
}

export function HandoffPreflightPanel({ preflight }: { preflight: PreflightView }) {
  switch (preflight.state) {
    case "idle":
      return null;
    case "checking":
      return (
        <p role="status" className="text-xs text-muted-foreground">
          Checking the destination…
        </p>
      );
    case "error":
      return (
        <p role="alert" className="text-xs text-destructive-foreground">
          {`Couldn't check: ${preflight.message}`}
        </p>
      );
    case "done":
      return (
        <div className="flex flex-col gap-2" aria-label="Destination checks">
          {preflight.results.map((result) => (
            <div key={result.threadId} className="flex flex-col gap-1">
              <p
                className={
                  result.ok ? "text-xs text-foreground" : "text-xs text-destructive-foreground"
                }
              >
                {preflightSummary(result)}
              </p>
              <HandoffPreflightFailures result={result} />
            </div>
          ))}
        </div>
      );
  }
}

const OUTCOME_TEXT = { moved: "Moved", stayed: "Stayed", skipped: "Skipped" } as const;

/** One line per thread: moved (with a link), stayed with the exact reason, or skipped. */
export function HandoffMachineResults(props: {
  run: HandoffMachineRun;
  destinationName: string;
  onOpenThread?: (threadId: ThreadId, environmentId: EnvironmentId) => void;
}) {
  const { run } = props;
  if (run.results.length === 0)
    return <p className="text-sm text-muted-foreground">No running thread was in handoff mode.</p>;
  return (
    <ul className="flex flex-col gap-2" aria-label="Handoff results">
      {run.results.map((result) => (
        <li
          key={result.threadId}
          data-outcome={result.outcome}
          className="flex flex-col gap-0.5 rounded-md border border-border/70 px-2.5 py-1.5"
        >
          <span className="flex items-baseline gap-2 text-sm">
            <span
              className={
                result.outcome === "moved"
                  ? "font-medium text-success-foreground"
                  : result.outcome === "stayed"
                    ? "font-medium text-destructive-foreground"
                    : "font-medium text-muted-foreground"
              }
            >
              {OUTCOME_TEXT[result.outcome]}
            </span>
            <span className="min-w-0 flex-1 truncate">{result.title}</span>
            {result.outcome === "moved" && result.continuedThreadId && props.onOpenThread ? (
              <button
                type="button"
                className="text-xs text-primary underline-offset-2 hover:underline"
                onClick={() =>
                  props.onOpenThread?.(
                    result.continuedThreadId as ThreadId,
                    run.destinationEnvironmentId,
                  )
                }
              >
                {`Open on ${props.destinationName}`}
              </button>
            ) : null}
          </span>
          {result.outcome === "moved" ? (
            <span className="text-xs text-muted-foreground">
              {result.resumed
                ? `Its turn continues on ${props.destinationName}.`
                : `It waits on ${props.destinationName}; no turn was running.`}
            </span>
          ) : result.detail ? (
            <span className="text-xs text-muted-foreground">{result.detail}</span>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
