import { ArrowRightIcon, CheckIcon, LaptopIcon } from "lucide-react";
import type { ComponentProps } from "react";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Radio, RadioGroup } from "../ui/radio-group";
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

export function MachineHandoffButton({ className, ...props }: ComponentProps<typeof Button>) {
  return (
    <Button
      {...props}
      variant="ghost-muted"
      size="sm"
      className={cn("h-6 gap-1.5 px-2 text-xs sm:h-6 sm:text-xs", className)}
      data-slot="handoff-trigger"
      aria-label="Continue this project on another machine"
    >
      <LaptopIcon className="size-3.5 shrink-0" aria-hidden />
      <span>Handoff</span>
    </Button>
  );
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
          <DialogDescription className="wrap-anywhere">
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
                <RadioGroup
                  value={selected}
                  onValueChange={(value) => onSelect(String(value))}
                  disabled={busy || preview !== null}
                  aria-label="Continue on"
                  className="gap-2"
                >
                  {destinations.length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                      Add this project on another connected machine to hand off work.
                    </p>
                  ) : (
                    destinations.map((destination) => (
                      <label
                        key={destination.key}
                        data-slot="handoff-destination"
                        className={`grid min-w-0 grid-cols-[1.125rem_1rem_minmax(0,1fr)] items-start gap-x-3 rounded-lg border p-3 transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring has-[:focus-visible]:ring-offset-2 has-[:focus-visible]:ring-offset-background ${
                          selected === destination.key
                            ? "border-primary bg-accent/40"
                            : "border-border"
                        } ${destination.unavailable ? "cursor-not-allowed opacity-60" : busy || preview !== null ? "cursor-default" : "cursor-pointer hover:bg-accent/40"}`}
                      >
                        <span className="flex h-5 items-center justify-center">
                          <Radio
                            value={destination.key}
                            disabled={destination.unavailable !== null}
                          />
                        </span>
                        <span
                          data-slot="handoff-destination-icon"
                          className="flex h-5 items-center justify-center"
                        >
                          <LaptopIcon className="size-4 shrink-0" aria-hidden />
                        </span>
                        <span className="min-w-0 text-sm leading-5">
                          <span
                            data-slot="handoff-destination-label"
                            className="block wrap-anywhere font-medium"
                          >
                            {destination.label}
                          </span>
                          <span className="block break-all text-xs text-muted-foreground">
                            {destination.folder}
                          </span>
                          {destination.unavailable && (
                            <span className="mt-1 block wrap-anywhere text-xs">
                              {destination.unavailable}
                            </span>
                          )}
                        </span>
                      </label>
                    ))
                  )}
                </RadioGroup>
              </fieldset>
              {preview ? (
                <div className="space-y-3 text-sm">
                  <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-start gap-2 font-medium">
                    <span className="min-w-0 wrap-anywhere">{sourceLabel}</span>
                    <span className="flex h-5 items-center">
                      <ArrowRightIcon className="size-4 shrink-0" aria-hidden />
                    </span>
                    <span className="min-w-0 wrap-anywhere">{target?.label}</span>
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
                    <span className="flex h-5 shrink-0 items-center">
                      <Checkbox checked={consent} disabled={busy} onCheckedChange={onConsent} />
                    </span>
                    <span className="min-w-0 wrap-anywhere leading-5">
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
            <p role="alert" className="wrap-anywhere text-sm text-destructive">
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
            <Button
              className="h-auto min-h-9 min-w-0 max-w-full shrink whitespace-normal wrap-anywhere py-2 sm:h-auto sm:min-h-8"
              onClick={onOpenDestination}
            >
              Open coordinator on {target?.label}
            </Button>
          ) : (
            <>
              <Button variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>
                Close
              </Button>
              {preview ? (
                <Button
                  className="h-auto min-h-9 min-w-0 max-w-full shrink whitespace-normal wrap-anywhere py-2 sm:h-auto sm:min-h-8"
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
