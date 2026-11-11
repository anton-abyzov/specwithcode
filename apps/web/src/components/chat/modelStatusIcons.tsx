/**
 * A model row's status as icons: what the row used to print in words ("Usage
 * not read", "Billed per token") now sits in each icon's tooltip and accessible
 * name. Missing data is not a warning: unknown billing draws nothing.
 */
import type { ServerProviderModel } from "@specweave-studio/contracts";
import { formatDuration } from "@specweave-studio/shared/usageLimits";
import { CircleDashedIcon, CircleSlashIcon, CoinsIcon, HardDriveIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import {
  isAvailabilityBlocking,
  type AvailabilityText,
  type ModelAvailability,
} from "../../studio/modelAvailability";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { MeterRing } from "./ModelUsage";

export type ModelStatusIcon =
  | { readonly kind: "new"; readonly label: string; readonly tooltip: string }
  | {
      readonly kind: "usage";
      readonly leftPercent: number;
      readonly tone: "ok" | "warn" | "full";
      /** The number shows beside the ring only once 80% or more is used. */
      readonly percentText: string | null;
      readonly label: string;
      readonly tooltip: string;
    }
  | {
      readonly kind: "limit";
      /** The short reset: `20d`, `2h`. */
      readonly reset: string | null;
      readonly label: string;
      readonly tooltip: string;
    }
  | { readonly kind: "unknown"; readonly label: string; readonly tooltip: string }
  | { readonly kind: "perToken"; readonly label: string; readonly tooltip: string }
  | { readonly kind: "local"; readonly label: string; readonly tooltip: string };

/** The first unit of a duration: `20d 0h` reads `20d`. */
function shortReset(resetsAt: number | null, nowMs: number): string | null {
  if (resetsAt === null || resetsAt <= nowMs) return null;
  return formatDuration(resetsAt - nowMs).split(" ")[0] ?? null;
}

const USAGE_NOT_REPORTED = "Usage not reported by this provider";

/**
 * The icons a model row shows, in order: new, usage (ring, limit reached or
 * unknown), then how it is billed (per token, local). A subscription and
 * unreported billing show nothing.
 */
export function modelStatusIcons(input: {
  readonly billing?: ServerProviderModel["billing"] | undefined;
  readonly isNew?: boolean;
  /** The row's usage state and its words; null when the picker shows no usage. */
  readonly availability?: {
    readonly state: ModelAvailability;
    readonly text: AvailabilityText;
  } | null;
  readonly nowMs: number;
}): ReadonlyArray<ModelStatusIcon> {
  const icons: ModelStatusIcon[] = [];
  if (input.isNew) icons.push({ kind: "new", label: "New model", tooltip: "New" });
  const perToken =
    input.billing === "api" ||
    input.billing === "paid-router" ||
    input.availability?.state.kind === "perToken";
  const usage = input.availability;
  if (usage && !perToken && input.billing !== "local") {
    const { state, text } = usage;
    switch (state.kind) {
      case "room":
        icons.push({
          kind: "usage",
          leftPercent: state.leftPercent,
          tone: state.tone,
          percentText: state.leftPercent <= 20 ? `${state.leftPercent}% left` : null,
          label: text.label,
          tooltip: text.long,
        });
        break;
      case "exhausted":
      case "denied":
        if (isAvailabilityBlocking(state)) {
          icons.push({
            kind: "limit",
            reset: shortReset(
              state.kind === "exhausted" ? state.binding.resetsAt : state.resetsAt,
              input.nowMs,
            ),
            label: text.label,
            tooltip: text.long,
          });
        } else {
          // Extra usage still runs turns: an empty amber ring, never the limit mark.
          icons.push({
            kind: "usage",
            leftPercent: 0,
            tone: "warn",
            percentText: null,
            label: text.label,
            tooltip: text.long,
          });
        }
        break;
      case "unreported":
        icons.push({
          kind: "unknown",
          label: USAGE_NOT_REPORTED,
          tooltip: state.message ? text.long : USAGE_NOT_REPORTED,
        });
        break;
      case "perToken":
        break;
      default:
        icons.push({ kind: "unknown", label: text.label, tooltip: text.long });
    }
  }
  if (perToken) {
    icons.push({
      kind: "perToken",
      label: "Billed per token",
      tooltip: usage?.state.kind === "perToken" ? usage.text.long : "Billed per token",
    });
  } else if (input.billing === "local") {
    icons.push({
      kind: "local",
      label: "Local model",
      tooltip: "Local model: runs on this machine",
    });
  }
  return icons;
}

const TONE_TEXT = {
  ok: "text-muted-foreground",
  warn: "text-warning-foreground",
  full: "text-destructive-foreground",
} as const;

function StatusGlyph({ icon }: { readonly icon: ModelStatusIcon }) {
  switch (icon.kind) {
    case "new":
      return <span className="size-1.5 rounded-full bg-update" />;
    case "usage":
      return (
        <span className={cn("inline-flex items-center gap-1 tabular-nums", TONE_TEXT[icon.tone])}>
          {/* The ring carries the tone; the words stay in the text color, which keeps
              its contrast on a selected or highlighted row. */}
          {icon.percentText ? (
            <span className="text-xs text-foreground">{icon.percentText}</span>
          ) : null}
          <MeterRing percent={icon.leftPercent} tone={icon.tone} dashed={false} />
        </span>
      );
    case "limit":
      return (
        <span className="inline-flex items-center gap-1 text-xs text-destructive-foreground tabular-nums">
          <CircleSlashIcon className="size-3.5" aria-hidden />
          {icon.reset}
        </span>
      );
    case "unknown":
      return <CircleDashedIcon className="size-3.5" aria-hidden />;
    case "perToken":
      return <CoinsIcon className="size-3.5" aria-hidden />;
    case "local":
      return <HardDriveIcon className="size-3.5" aria-hidden />;
  }
}

/** The row's status icons, each with its tooltip and accessible name. */
export function ModelStatusIcons({ icons }: { readonly icons: ReadonlyArray<ModelStatusIcon> }) {
  if (icons.length === 0) return null;
  return (
    <span className="flex shrink-0 items-center gap-2 text-muted-foreground" data-model-status="">
      {icons.map((icon) => (
        <Tooltip key={icon.kind}>
          <TooltipTrigger
            render={
              <span
                role="img"
                aria-label={icon.label}
                className="inline-flex shrink-0 items-center"
                data-model-status-icon={icon.kind}
              />
            }
          >
            <StatusGlyph icon={icon} />
          </TooltipTrigger>
          <TooltipPopup side="top" align="end" className="max-w-64">
            {icon.tooltip}
          </TooltipPopup>
        </Tooltip>
      ))}
    </span>
  );
}
