import type {
  EnvironmentId,
  HandoffMachineRun,
  HandoffPreflightResult,
  ThreadId,
} from "@specweave-studio/contracts";
import { CheckIcon, XIcon } from "lucide-react";

import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";

/** A machine a thread can move to; "this-machine" continues here with another model. */
export interface HandoffDestination {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly state: "reachable" | "offline" | "this-machine";
  /** Why it can't be chosen, or what it needs first: "Offline", "Not connected", "Needs an update". */
  readonly reason?: string | null;
}

export function destinationText(destination: HandoffDestination): string {
  if (destination.state === "this-machine") return `${destination.label} (this machine)`;
  return destination.state === "offline"
    ? `${destination.label} (${(destination.reason ?? "Offline").toLowerCase()})`
    : destination.label;
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

const VERSION_FAILURE = /^(.+?) runs SpecWithCode .* Update (.+) first\.$/s;

/**
 * True when a version check says to update the destination first. The
 * destination words it "<destination> runs SpecWithCode … Update <machine>
 * first.", so the machine to update is the destination when both names match.
 */
export function versionFailureNamesDestination(
  results: readonly HandoffPreflightResult[],
): boolean {
  return results.some((result) =>
    result.failures.some((failure) => {
      if (failure.check !== "version") return false;
      const match = VERSION_FAILURE.exec(failure.message);
      return match !== null && match[1]!.toLowerCase() === match[2]!.toLowerCase();
    }),
  );
}

/**
 * One thread's preflight verdict, then what happens to its run. `here` is the
 * same-machine model switch: the thread stays put, so nothing runs "there".
 */
export function preflightSummary(
  result: HandoffPreflightResult,
  machine = "That machine",
  here = false,
): string {
  if (here) {
    if (!result.ok) return "Can't switch yet:";
    return result.resume
      ? "Ready. The current turn keeps running."
      : "Ready. It will wait for your next message.";
  }
  if (!result.ok) return `${machine} can't take it yet:`;
  return result.resume
    ? "Ready. The current turn keeps running there."
    : "Ready. It will wait there for your next message.";
}

/** The check line: checking, ready, or the destination's own failure text under a short lead. */
export function HandoffPreflightPanel({
  preflight,
  machine = "the other machine",
  here = false,
}: {
  preflight: PreflightView;
  /** The destination's name, for "Checking Minis…" and "Couldn't reach Minis: …". */
  machine?: string;
  /** The thread stays on this machine (switch model), so the copy drops "there". */
  here?: boolean;
}) {
  switch (preflight.state) {
    case "idle":
      return null;
    case "checking":
      return (
        <p role="status" className="text-xs text-muted-foreground">
          {`Checking ${machine}…`}
        </p>
      );
    case "error":
      return (
        <p role="alert" className="text-xs text-destructive-foreground">
          {`Couldn't reach ${machine}: ${preflight.message}`}
        </p>
      );
    case "done":
      return (
        <div className="flex flex-col gap-2" role="status" aria-label="Destination checks">
          {preflight.results.map((result) => (
            <div key={result.threadId} className="flex flex-col gap-1">
              <p
                className={
                  result.ok
                    ? "flex items-center gap-1.5 text-xs text-foreground"
                    : "flex items-center gap-1.5 text-xs text-destructive-foreground"
                }
              >
                {result.ok ? (
                  <CheckIcon className="size-3.5 shrink-0 text-success-foreground" aria-hidden />
                ) : (
                  <XIcon className="size-3.5 shrink-0" aria-hidden />
                )}
                {preflightSummary(result, capitalize(machine), here)}
              </p>
              <HandoffPreflightFailures result={result} />
            </div>
          ))}
        </div>
      );
  }
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
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
    return (
      <p className="text-sm text-muted-foreground">
        Nothing was running here that's set to keep ready to move.
      </p>
    );
  return (
    <ul className="flex flex-col gap-2" aria-label="Results">
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
                // Button padding, so the focus ring sits around the text rather than on it.
                className="-my-1 shrink-0 rounded-md px-2 py-1 text-xs text-primary underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
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
                ? `The current turn keeps running on ${props.destinationName}.`
                : `It waits on ${props.destinationName} for your next message.`}
            </span>
          ) : result.detail ? (
            <span className="text-xs text-muted-foreground">{result.detail}</span>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
