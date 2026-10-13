import { ArrowRightIcon, CheckIcon, LaptopIcon } from "lucide-react";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";

export interface HandoffDestination {
  readonly key: string;
  readonly label: string;
  readonly folder: string;
  readonly unavailable: string | null;
}

export interface HandoffPreview {
  readonly repositories: ReadonlyArray<{ readonly relativePath: string; readonly head: string }>;
  readonly messageCount: number;
}

/** The transfer has one explicit destination and one commit point. */
export function MachineHandoffDialog({
  open,
  onOpenChange,
  sourceLabel,
  projectTitle,
  destinations,
  selected,
  onSelect,
  preview,
  phase,
  error,
  consent,
  onConsent,
  onReview,
  onContinue,
  onOpenDestination,
  onRestart,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly sourceLabel: string;
  readonly projectTitle: string;
  readonly destinations: ReadonlyArray<HandoffDestination>;
  readonly selected: string;
  readonly onSelect: (key: string) => void;
  readonly preview: HandoffPreview | null;
  readonly phase: "choose" | "checking" | "review" | "transferring" | "complete";
  readonly error: string | null;
  readonly consent: boolean;
  readonly onConsent: (value: boolean) => void;
  readonly onReview: () => void;
  readonly onContinue: () => void;
  readonly onOpenDestination: () => void;
  readonly onRestart?: (() => void) | undefined;
}) {
  const target = destinations.find((item) => item.key === selected);
  const busy = phase === "checking" || phase === "transferring";
  const complete = phase === "complete";
  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (!busy) onOpenChange(value);
      }}
    >
      <DialogPopup showCloseButton={!busy} className="w-full sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{complete ? "Handoff ready" : "Continue on another machine"}</DialogTitle>
          <DialogDescription>
            {complete
              ? `The coordinator on ${target?.label ?? "the destination"} has the code and context.`
              : `Move ${projectTitle} forward from ${sourceLabel}.`}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {complete ? (
            <div className="flex items-center gap-3 rounded-lg bg-muted p-4 text-sm" role="status">
              <CheckIcon className="size-5 shrink-0" aria-hidden />
              <span>The new coordinator can continue in its own checkout.</span>
            </div>
          ) : (
            <>
              <fieldset disabled={busy || preview !== null} className="min-w-0 space-y-2">
                <legend className="mb-2 text-sm font-medium">Continue on</legend>
                {destinations.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    Add this project on another connected machine to hand off work.
                  </p>
                ) : (
                  destinations.map((destination) => (
                    <label
                      key={destination.key}
                      className={`flex min-w-0 items-start gap-3 rounded-lg border p-3 ${
                        selected === destination.key
                          ? "border-primary bg-accent/40"
                          : "border-border"
                      } ${destination.unavailable ? "opacity-60" : "cursor-pointer"}`}
                    >
                      <input
                        type="radio"
                        name="handoff-destination"
                        value={destination.key}
                        checked={selected === destination.key}
                        disabled={destination.unavailable !== null}
                        onChange={() => onSelect(destination.key)}
                        className="mt-1 accent-primary"
                      />
                      <LaptopIcon className="mt-0.5 size-4 shrink-0" aria-hidden />
                      <span className="min-w-0 text-sm">
                        <span className="block font-medium">{destination.label}</span>
                        <span className="block break-all text-xs text-muted-foreground">
                          {destination.folder}
                        </span>
                        {destination.unavailable && (
                          <span className="mt-1 block text-xs">{destination.unavailable}</span>
                        )}
                      </span>
                    </label>
                  ))
                )}
              </fieldset>
              {preview ? (
                <div className="space-y-3 text-sm">
                  <div className="flex items-center gap-2 font-medium">
                    <span>{sourceLabel}</span>
                    <ArrowRightIcon className="size-4" aria-hidden />
                    <span>{target?.label}</span>
                  </div>
                  <p className="text-muted-foreground">
                    {preview.repositories.length}{" "}
                    {preview.repositories.length === 1 ? "repository" : "repositories"},{" "}
                    {preview.messageCount} retained messages. The destination gets an isolated
                    checkout and a fresh coordinator.
                  </p>
                  <details className="rounded-lg border p-3">
                    <summary className="cursor-pointer font-medium">Code checkpoint</summary>
                    <ul className="mt-3 space-y-2">
                      {preview.repositories.map((repository) => (
                        <li
                          key={repository.relativePath}
                          className="flex items-baseline justify-between gap-3"
                        >
                          <span className="min-w-0 break-all text-xs">
                            {repository.relativePath === "."
                              ? projectTitle
                              : repository.relativePath}
                          </span>
                          <code className="shrink-0 text-xs text-muted-foreground">
                            {repository.head.slice(0, 12)}
                          </code>
                        </li>
                      ))}
                    </ul>
                  </details>
                  <label className="flex cursor-pointer items-start gap-3 py-1">
                    <input
                      type="checkbox"
                      checked={consent}
                      disabled={busy}
                      onChange={(event) => onConsent(event.target.checked)}
                      className="mt-1 accent-primary"
                    />
                    <span>
                      Publish these commits to their configured Git remotes and send the project
                      context to {target?.label}.
                    </span>
                  </label>
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">
                  Save and commit your changes first. We’ll check both checkouts before transferring
                  code and context.
                </p>
              )}
            </>
          )}
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          {error && onRestart && (
            <Button variant="outline" onClick={onRestart}>
              Review the updated source
            </Button>
          )}
          {busy && (
            <p role="status" aria-live="polite" className="text-sm text-muted-foreground">
              {phase === "checking"
                ? "Checking code and machine access…"
                : "Transferring code and context…"}
            </p>
          )}
        </DialogPanel>
        <DialogFooter>
          {complete ? (
            <Button onClick={onOpenDestination}>Open coordinator on {target?.label}</Button>
          ) : (
            <>
              <Button variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>
                Close
              </Button>
              {preview ? (
                <Button
                  disabled={busy || !consent || !target || !!target.unavailable}
                  onClick={onContinue}
                >
                  {busy ? "Transferring…" : `Continue on ${target?.label ?? "selected machine"}`}
                </Button>
              ) : (
                <Button disabled={busy || !target || !!target.unavailable} onClick={onReview}>
                  {busy ? "Checking…" : "Review handoff"}
                </Button>
              )}
            </>
          )}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
