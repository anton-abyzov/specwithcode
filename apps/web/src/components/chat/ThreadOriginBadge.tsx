/**
 * Who outside this machine's own UI started a thread: an outside agent over
 * MCP ("From Claude.ai") or another machine's fleet work ("From SpecWithCode
 * · m4-studio"). Threads this machine's user or its own agents started carry
 * no origin and show nothing.
 */
import type { OrchestrationV2ThreadOrigin } from "@specweave-studio/contracts";
import { MonitorIcon, PlugIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/** The badge face: "From <label> · <machine>", or "From <label>" when the machine is unknown. */
export function threadOriginText(origin: OrchestrationV2ThreadOrigin): string {
  const machine = origin.machineLabel?.trim();
  return machine && machine !== origin.label
    ? `From ${origin.label} · ${machine}`
    : `From ${origin.label}`;
}

/** The tooltip: what started the thread, and where its parent lives when known. */
export function threadOriginTooltip(origin: OrchestrationV2ThreadOrigin): string {
  const machine = origin.machineLabel?.trim() || origin.environmentId;
  const started =
    origin.kind === "mcp_client"
      ? `Started by ${origin.label}, an outside agent connected over MCP${machine ? ` from ${machine}` : ""}.`
      : `Started by work from ${machine ?? "another machine"} through ${origin.label}.`;
  const parent = origin.parentThreadRef
    ? ` Its parent thread ${origin.parentThreadRef.threadId} is on ${
        origin.machineLabel?.trim() || origin.parentThreadRef.environmentId || "that machine"
      }.`
    : "";
  return started + parent;
}

export function ThreadOriginBadge({
  origin,
  variant = "inline",
  className,
}: {
  origin: OrchestrationV2ThreadOrigin | null | undefined;
  /** `chip` matches the project thread header's chip row; `inline` the chat header. */
  variant?: "chip" | "inline";
  className?: string;
}) {
  if (!origin) return null;
  const text = threadOriginText(origin);
  const Icon = origin.kind === "mcp_client" ? PlugIcon : MonitorIcon;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            data-thread-origin={origin.kind}
            aria-label={`${text}. ${threadOriginTooltip(origin)}`}
            className={cn(
              variant === "chip"
                ? "sws-chip"
                : "inline-flex min-w-0 max-w-48 shrink items-center gap-1 rounded-full border border-border/70 px-2 py-0.5 text-[11px] text-muted-foreground",
              className,
            )}
          />
        }
      >
        <Icon aria-hidden className="size-3 shrink-0" />
        <span className="min-w-0 truncate">{text}</span>
      </TooltipTrigger>
      <TooltipPopup side="bottom">{threadOriginTooltip(origin)}</TooltipPopup>
    </Tooltip>
  );
}
