import type { ReactNode } from "react";
import { ArrowRightIcon, ChevronRightIcon } from "lucide-react";
import { useTx, type TranslatePhrase } from "../../i18n";
import { accessLabel } from "../../studio/fleetWorkers";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import type { MachineWorkerGrant, MachineWorkHere } from "./machinesSettings.logic";
import {
  workGrantAllowsNoProject,
  workGrantProjectsSummary,
  workGrantStatus,
} from "./machineWorkGrants.logic";

type Tone = "allowed" | "warning" | "off";

const TONE_CLASS: Record<Tone, string> = {
  allowed: "border-success/40 bg-success/8 text-foreground",
  warning: "border-warning/50 bg-warning/10 text-foreground",
  off: "border-border text-muted-foreground",
};

const dateOf = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });

/** What agents here may do there, in a few words: "Full access", "Not allowed". */
function outgoing(workers: MachineWorkerGrant, tx: TranslatePhrase): { tone: Tone; text: string } {
  const grant = workers.workers;
  if (workers.status === "not-allowed")
    return {
      tone: "off",
      text:
        grant.status === "revoked"
          ? tx("Revoked")
          : grant.status === "expired"
            ? tx("Expired")
            : tx("Not allowed"),
    };
  const access = grant.access === null ? tx("Allowed") : tx(accessLabel(grant.access));
  if (grant.renewable) return { tone: "allowed", text: access };
  return {
    tone: workers.status === "expiring" ? "warning" : "allowed",
    text: grant.expiresAt
      ? tx("{access}, until {date}", { access, date: dateOf(grant.expiresAt) })
      : access,
  };
}

/** What that machine's agents may do here, in a few words: "All projects", "No projects allowed". */
function incoming(workHere: MachineWorkHere, tx: TranslatePhrase): { tone: Tone; text: string } {
  const grant = workHere.grant;
  if (grant.status === "revoked") return { tone: "off", text: tx("Revoked") };
  if (grant.status === "expired") return { tone: "warning", text: tx("Expired") };
  const snapshot = { projects: workHere.projects, projectsUnreadable: workHere.projectsUnreadable };
  if (workGrantAllowsNoProject(grant, snapshot))
    return { tone: "warning", text: tx("No projects allowed") };
  return {
    tone: "allowed",
    text:
      grant.projects.kind === "linked"
        ? tx("Linked projects")
        : workGrantProjectsSummary(grant, workHere.projects, workHere.projectsUnreadable, tx),
  };
}

function WorkChip({
  from,
  to,
  tone,
  text,
  hint,
}: {
  from: string;
  to: string;
  tone: Tone;
  text: string;
  hint: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            tabIndex={0}
            aria-label={`${hint} ${text}`}
            className={`inline-flex min-w-0 max-w-full cursor-default items-center gap-1 rounded-md border px-1.5 py-0.5 text-xs focus-visible:ring-2 focus-visible:ring-ring ${TONE_CLASS[tone]}`}
          />
        }
      >
        <span className="shrink-0 font-medium">{from}</span>
        <ArrowRightIcon aria-hidden className="size-3 shrink-0" />
        <span className="shrink-0 font-medium">{to}</span>
        <span className="truncate text-muted-foreground">{text}</span>
      </TooltipTrigger>
      <TooltipPopup side="top">{hint}</TooltipPopup>
    </Tooltip>
  );
}

/**
 * One line per machine card on who may start work where: "M4 → M5 Full access"
 * and "M5 → M4 All projects", each explained on hover.
 */
export function MachineWorkSummary({
  hereLabel,
  thereLabel,
  workers,
  workHere,
}: {
  hereLabel: string;
  thereLabel: string;
  workers: MachineWorkerGrant | null;
  /** Null with `allowBackOffered`: that direction is not set up yet. */
  workHere: MachineWorkHere | null;
}) {
  const tx = useTx();
  const out = workers ? outgoing(workers, tx) : null;
  const back = workHere ? incoming(workHere, tx) : null;
  const outHint = tx("Agents on {hereLabel} can start work on {thereLabel}", {
    hereLabel,
    thereLabel,
  });
  const backHint = tx("Agents on {thereLabel} can start work on {hereLabel}", {
    hereLabel,
    thereLabel,
  });
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1.5" data-slot="machine-work-summary">
      <WorkChip
        from={hereLabel}
        to={thereLabel}
        tone={out?.tone ?? "off"}
        text={out?.text ?? tx("Not set up")}
        hint={
          workers?.workers.renewable && workers.status !== "not-allowed"
            ? `${outHint}. ${tx("Renews automatically.")}`
            : outHint
        }
      />
      <WorkChip
        from={thereLabel}
        to={hereLabel}
        tone={back?.tone ?? "off"}
        text={back?.text ?? tx("Not allowed")}
        hint={
          workHere
            ? `${backHint}. ${workGrantProjectsSummary(
                workHere.grant,
                workHere.projects,
                workHere.projectsUnreadable,
                tx,
              )} · ${workGrantStatus(workHere.grant, tx)}`
            : backHint
        }
      />
    </div>
  );
}

/**
 * Whether a card's Limits opens by itself: while a direction still needs a
 * choice, while agents here are not allowed there, or while that access is
 * running out and will not renew.
 */
export function machineLimitsOpen({
  workers,
  workHere,
  addForAgents,
  allowBack,
}: {
  workers: MachineWorkerGrant | null;
  workHere: MachineWorkHere | null;
  addForAgents: boolean;
  allowBack: boolean;
}): boolean {
  return (
    (addForAgents && !workers) ||
    (allowBack && !workHere) ||
    workers?.status === "not-allowed" ||
    workers?.status === "expiring"
  );
}

/** The folded part of a card: what each side may do, and how this app reaches it. */
export function MachineLimits({
  open,
  children,
}: {
  /** Open by itself while something there needs a choice. */
  open: boolean;
  children: ReactNode;
}) {
  const tx = useTx();
  return (
    <details className="group min-w-0 text-xs" data-slot="limits" open={open}>
      <summary className="flex w-fit cursor-pointer list-none items-center gap-1 rounded text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
        <ChevronRightIcon
          aria-hidden
          className="size-3 transition-transform group-open:rotate-90"
        />
        {tx("Limits")}
      </summary>
      <div className="mt-2 flex min-w-0 flex-col gap-2 [&>.pl-7]:pl-0">{children}</div>
    </details>
  );
}
