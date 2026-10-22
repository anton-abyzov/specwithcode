/**
 * Sits beside a model chip whenever the chip alone would mislead: a usage-limit
 * fallback runs instead of the model that was picked, or the turn in progress
 * runs on another model than the one picked for the next message.
 */
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { cn } from "~/lib/utils";

export type ModelState =
  | { readonly kind: "preferred"; readonly pick: string }
  | { readonly kind: "next"; readonly pick: string }
  /** The chip shows a fallback that stands in for the picked model. */
  | {
      readonly kind: "fallback";
      /** The picked model in full: `Claude Code · Opus 5.5`. */
      readonly pick: string;
      /** The same, without the provider: `Opus 5.5`. */
      readonly pickModel: string;
      readonly reason?: string | null;
    }
  /** The chip shows the next message's pick; this turn still runs on `running`. */
  | { readonly kind: "running"; readonly running: string };

type Selection = { readonly instanceId: string; readonly model: string };

/**
 * What a chat composer's chip needs beside it. Labels are compared, not slugs, so a
 * provider reporting `claude-opus-5-5[1m]` for `claude-opus-5-5` reads as the same model.
 */
export function composerModelState(input: {
  /** What the chip shows: the pick for the next message. */
  readonly shown: Selection;
  /** The model of the turn in progress, if one runs. */
  readonly running: Selection | null;
  /** The thread's own model, which a limit fallback moved. */
  readonly thread: Selection | null;
  /** The picked model a limit fallback stands in for. */
  readonly fallbackFrom: Selection | null;
  readonly label: (selection: Selection) => { readonly full: string; readonly model: string };
}): ModelState | null {
  const shown = input.label(input.shown).full;
  if (input.running && input.label(input.running).full !== shown)
    return { kind: "running", running: input.label(input.running).full };
  if (input.fallbackFrom && input.thread && input.thread.instanceId === input.shown.instanceId) {
    const pick = input.label(input.fallbackFrom);
    return { kind: "fallback", pick: pick.full, pickModel: pick.model, reason: "usage limit" };
  }
  return null;
}

export function modelStateText(state: ModelState): { label: string; tip: string } {
  if (state.kind === "preferred")
    return {
      label: `Preferred: ${state.pick}`,
      tip: `The thread is set to ${state.pick}. The active turn keeps the model shown in the chip.`,
    };
  if (state.kind === "next")
    return {
      label: `Next: ${state.pick}`,
      tip: `This turn keeps its active model. Your next message uses ${state.pick}.`,
    };
  if (state.kind === "fallback")
    return {
      label: `Fallback for ${state.pickModel}`,
      tip: `Runs on this model instead of your pick, ${state.pick}${state.reason ? ` (${state.reason})` : ""}.`,
    };
  return {
    label: `Running: ${state.running}`,
    tip: `This turn runs on ${state.running}. Your pick applies from the next message.`,
  };
}

export function ModelStateTag(props: { state: ModelState; className?: string }) {
  const { label, tip } = modelStateText(props.state);
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            className={cn(
              "inline-flex h-5 max-w-44 shrink-0 items-center gap-1 truncate rounded-full border px-1.5 text-2xs leading-none font-medium",
              props.state.kind === "fallback"
                ? "border-warning/40 bg-warning/10 text-warning-foreground"
                : "border-border bg-muted/60 text-muted-foreground",
              props.className,
            )}
            data-model-state={props.state.kind}
            aria-label={tip}
          />
        }
      >
        <span
          aria-hidden
          className={cn(
            "size-1.5 shrink-0 rounded-full",
            props.state.kind === "fallback" ? "bg-warning" : "animate-pulse bg-success",
          )}
        />
        <span className="truncate">{label}</span>
      </TooltipTrigger>
      <TooltipPopup side="top">{tip}</TooltipPopup>
    </Tooltip>
  );
}
