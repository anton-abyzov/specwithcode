import { cn } from "~/lib/utils";
import { Radio, RadioGroup } from "../ui/radio-group";
import type { HandoffDestination } from "./HandoffResults";

/** One machine a dialog can send work to. */
export interface MachineOption {
  readonly value: string;
  readonly label: string;
  /** "ready" is online, "attention" is online with a reason (an update), "off" can't be chosen. */
  readonly tone: "ready" | "attention" | "off";
  /** Short and plain: "Offline", "Needs an update", "Not connected". */
  readonly reason?: string | null;
  readonly disabled?: boolean;
}

/** Machine rows for a thread move: online machines first, offline ones shown but disabled. */
export function destinationOptions(destinations: readonly HandoffDestination[]): MachineOption[] {
  return destinations.map((destination): MachineOption => {
    if (destination.state === "offline")
      return {
        value: destination.environmentId,
        label: destination.label,
        tone: "off",
        reason: destination.reason ?? "Offline",
        disabled: true,
      };
    return {
      value: destination.environmentId,
      label: destination.label,
      tone: destination.reason ? "attention" : "ready",
      reason: destination.reason ?? (destination.state === "this-machine" ? "This machine" : null),
    };
  });
}

const DOT = {
  ready: "bg-success",
  attention: "bg-warning",
  off: "bg-muted-foreground/50",
} as const;

/** Radio rows for picking a machine: status dot, name, and a muted reason when it can't be chosen. */
export function MachineOptionRows(props: {
  options: readonly MachineOption[];
  value: string | null;
  onChange: (value: string) => void;
  disabled?: boolean;
  /** Names the group for screen readers when no visible legend wraps it. */
  "aria-label"?: string;
}) {
  return (
    <RadioGroup
      value={props.value ?? ""}
      onValueChange={(value) => {
        if (typeof value === "string" && value) props.onChange(value);
      }}
      disabled={props.disabled}
      aria-label={props["aria-label"]}
      data-slot="machine-options"
    >
      {props.options.map((option) => {
        const selected = props.value === option.value;
        return (
          <label
            key={option.value}
            data-slot="machine-option"
            data-tone={option.tone}
            className={cn(
              "flex min-w-0 items-center gap-3 rounded-lg border px-3 py-2 text-sm transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring has-[:focus-visible]:ring-offset-2 has-[:focus-visible]:ring-offset-background",
              selected ? "border-primary bg-accent/40" : "border-border",
              option.disabled
                ? "cursor-not-allowed opacity-60"
                : props.disabled
                  ? "cursor-default"
                  : "cursor-pointer hover:bg-accent/40",
            )}
          >
            <Radio value={option.value} disabled={option.disabled ?? false} />
            <span className={cn("size-2 shrink-0 rounded-full", DOT[option.tone])} aria-hidden />
            <span className="min-w-0 flex-1 truncate font-medium">{option.label}</span>
            {option.reason ? (
              <span className="shrink-0 text-xs text-muted-foreground">{option.reason}</span>
            ) : null}
          </label>
        );
      })}
    </RadioGroup>
  );
}
