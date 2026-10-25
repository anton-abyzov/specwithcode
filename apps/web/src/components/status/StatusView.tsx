import type {
  StatusComponent,
  StatusDay,
  StatusIncident,
  StatusLevel,
  StatusService,
  StatusSnapshot,
} from "@specweave-studio/contracts";
import {
  CircleAlertIcon,
  CircleCheckIcon,
  CircleDashedIcon,
  ChevronRightIcon,
  ExternalLinkIcon,
  TriangleAlertIcon,
  WrenchIcon,
} from "lucide-react";
import { useId, useMemo, useState, type KeyboardEvent } from "react";

import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { RefreshIcon } from "../ui/refresh-icon";
import {
  STATUS_LEVEL_STYLES,
  formatAge,
  formatStatusDate,
  formatStatusTime,
  formatUptime,
  groupStatusServices,
  statusHeadline,
  statusLabel,
  type StatusGroupView,
} from "./statusModel";

const STAGE_LABELS: Record<StatusIncident["stage"], string> = {
  investigating: "Investigating",
  identified: "Identified",
  monitoring: "Monitoring",
  resolved: "Resolved",
};

export function StatusChip({ level, className }: { level: StatusLevel; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex h-5 shrink-0 items-center gap-1.5 rounded-full px-2 font-medium text-xs leading-none",
        STATUS_LEVEL_STYLES[level].chip,
        className,
      )}
    >
      <span aria-hidden className={cn("size-1.5 rounded-full", STATUS_LEVEL_STYLES[level].dot)} />
      {statusLabel(level)}
    </span>
  );
}

function LevelIcon({ level, className }: { level: StatusLevel; className?: string }) {
  const Icon =
    level === "operational"
      ? CircleCheckIcon
      : level === "unknown"
        ? CircleDashedIcon
        : level === "maintenance"
          ? WrenchIcon
          : level === "degraded"
            ? TriangleAlertIcon
            : CircleAlertIcon;
  const color =
    level === "operational"
      ? "text-success-foreground"
      : level === "unknown"
        ? "text-muted-foreground"
        : level === "maintenance"
          ? "text-info-foreground"
          : level === "degraded"
            ? "text-warning-foreground"
            : level === "partial_outage"
              ? "text-orange-500"
              : "text-destructive-foreground";
  return <Icon aria-hidden className={cn(color, className)} />;
}

function ExternalLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-1 text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
    >
      {children}
      <ExternalLinkIcon aria-hidden className="size-3" />
    </a>
  );
}

/** 90 day bars; hovering or arrowing through them shows that day's detail. */
export function StatusDayBars({
  days,
  label,
  incidents,
}: {
  days: ReadonlyArray<StatusDay>;
  label: string;
  incidents: ReadonlyArray<StatusIncident>;
}) {
  const [active, setActive] = useState<number | null>(null);
  const tooltipId = useId();
  const activeDay = active === null ? null : days[active];
  const activeIncidents =
    activeDay === null || activeDay === undefined
      ? []
      : incidents.filter((incident) => {
          const start = incident.startedAt.slice(0, 10);
          const end = (incident.resolvedAt ?? new Date().toISOString()).slice(0, 10);
          return start <= activeDay.date && activeDay.date <= end;
        });
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    setActive((current) => {
      const index = current ?? days.length - 1;
      if (event.key === "Home") return 0;
      if (event.key === "End") return days.length - 1;
      return Math.min(days.length - 1, Math.max(0, index + (event.key === "ArrowRight" ? 1 : -1)));
    });
  };
  const position = active === null ? 0 : (active + 0.5) / days.length;

  return (
    <div className="relative">
      <div
        role="group"
        tabIndex={0}
        aria-label={`${label}: daily status for the last ${days.length} days. Use the arrow keys to read a day.`}
        aria-describedby={activeDay ? tooltipId : undefined}
        className="flex h-8 min-w-0 items-stretch gap-px rounded-sm sm:gap-0.5 outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onKeyDown={onKeyDown}
        onBlur={() => setActive(null)}
        onMouseLeave={() => setActive(null)}
        data-testid="status-day-bars"
      >
        {days.map((day, index) => (
          <span
            key={day.date}
            data-level={day.level}
            onMouseEnter={() => setActive(index)}
            className={cn(
              "min-w-0 flex-1 rounded-[2px] transition-opacity",
              STATUS_LEVEL_STYLES[day.level].bar,
              active !== null && active !== index && "opacity-60",
            )}
          />
        ))}
      </div>
      {activeDay ? (
        <div
          id={tooltipId}
          role="tooltip"
          data-testid="status-day-popover"
          className="pointer-events-none absolute bottom-full z-20 mb-2 w-72 max-w-full -translate-x-1/2 rounded-lg border bg-popover p-3 text-popover-foreground text-xs shadow-lg"
          // Centred on the day, kept inside the strip even when the strip is
          // narrower than the popover.
          style={{
            left: `clamp(min(9rem, 50%), ${position * 100}%, max(calc(100% - 9rem), 50%))`,
          }}
        >
          <div className="flex items-center justify-between gap-2">
            <span className="font-medium text-sm">{formatStatusDate(activeDay.date)}</span>
            <StatusChip level={activeDay.level} />
          </div>
          <p className="mt-1.5 text-muted-foreground">
            {activeDay.checks === 0
              ? "No checks recorded this day."
              : activeDay.failures === 0
                ? `${activeDay.checks} checks, all healthy.`
                : `${activeDay.failures} of ${activeDay.checks} checks found a problem.`}
          </p>
          {activeDay.notes.length > 0 ? (
            <ul className="mt-2 space-y-1">
              {activeDay.notes.map((note) => (
                <li key={note} className="flex gap-1.5">
                  <span
                    aria-hidden
                    className="mt-1.5 size-1 shrink-0 rounded-full bg-current opacity-60"
                  />
                  <span>{note}</span>
                </li>
              ))}
            </ul>
          ) : null}
          {activeIncidents.length > 0 ? (
            <div className="mt-2 border-t pt-2">
              <p className="mb-1 font-medium">Related incidents</p>
              <ul className="space-y-1">
                {activeIncidents.slice(0, 3).map((incident) => (
                  <li key={incident.id} className="flex items-start gap-1.5">
                    <LevelIcon level={incident.level} className="mt-px size-3.5 shrink-0" />
                    <span>{incident.title}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      ) : null}
      <div className="mt-1.5 flex justify-between text-[11px] text-muted-foreground">
        <span>{days.length} days ago</span>
        <span>Today</span>
      </div>
    </div>
  );
}

function ComponentRow({ component }: { component: StatusComponent }) {
  return (
    <li className="flex items-start justify-between gap-3 py-2">
      <div className="min-w-0">
        <p className="text-sm">{component.name}</p>
        {component.detail ? (
          <p className="mt-0.5 break-words text-muted-foreground text-xs">{component.detail}</p>
        ) : null}
      </div>
      <StatusChip level={component.level} />
    </li>
  );
}

function ServiceRow({
  service,
  incidents,
  defaultOpen,
}: {
  service: StatusService;
  incidents: ReadonlyArray<StatusIncident>;
  defaultOpen: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const panelId = useId();
  const serviceIncidents = incidents.filter((incident) => incident.serviceId === service.id);
  return (
    <li className="px-4 py-3.5 sm:px-5" data-testid="status-service" data-service-id={service.id}>
      <div className="flex items-start gap-3">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => setOpen((value) => !value)}
          className="group flex min-w-0 flex-1 items-start gap-2 rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ChevronRightIcon
            aria-hidden
            className={cn(
              "mt-0.5 size-4 shrink-0 text-muted-foreground transition-transform",
              open && "rotate-90",
            )}
          />
          <span className="min-w-0">
            <span className="block font-medium text-sm">{service.name}</span>
            <span className="mt-0.5 block truncate text-muted-foreground text-xs">
              {service.detail}
            </span>
          </span>
        </button>
        <span className="hidden pt-0.5 text-muted-foreground text-xs tabular-nums sm:block">
          {formatUptime(service.uptimePercent)}
        </span>
        <StatusChip level={service.level} />
      </div>
      <div className="mt-3 ps-6">
        <StatusDayBars days={service.days} label={service.name} incidents={serviceIncidents} />
      </div>
      {open ? (
        <div id={panelId} className="mt-3 ms-6 rounded-lg border bg-muted/30 px-3.5 py-1.5">
          <ul className="divide-y">
            {service.components.map((component) => (
              <ComponentRow key={component.id} component={component} />
            ))}
          </ul>
          <div className="border-t py-2.5">
            <p className="mb-1.5 text-muted-foreground text-xs">Used by</p>
            <div className="flex flex-wrap gap-1.5">
              {service.dependents.map((dependent) => (
                <span
                  key={dependent}
                  className="rounded-md border bg-background px-2 py-0.5 text-xs"
                >
                  {dependent}
                </span>
              ))}
            </div>
          </div>
          <p className="border-t py-2 text-muted-foreground text-xs">
            Source:{" "}
            {service.sourceUrl ? (
              <ExternalLink href={service.sourceUrl}>{service.source}</ExternalLink>
            ) : (
              service.source
            )}
          </p>
        </div>
      ) : null}
    </li>
  );
}

function GroupSection({
  group,
  incidents,
}: {
  group: StatusGroupView;
  incidents: ReadonlyArray<StatusIncident>;
}) {
  const [open, setOpen] = useState(true);
  const panelId = useId();
  return (
    // No overflow-hidden here: it would clip a day popover rising above the
    // group's first row. The header rounds its own top corners instead.
    <section
      className="rounded-xl border bg-card text-card-foreground"
      data-testid="status-group"
      data-group-id={group.id}
    >
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((value) => !value)}
        className={cn(
          "flex w-full items-center gap-3 border-b bg-muted/30 px-4 py-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset sm:px-5",
          open ? "rounded-t-xl" : "rounded-xl",
        )}
      >
        <ChevronRightIcon
          aria-hidden
          className={cn("size-4 text-muted-foreground transition-transform", open && "rotate-90")}
        />
        <span className="min-w-0 flex-1">
          <span className="block font-semibold text-sm">{group.name}</span>
          <span className="block text-muted-foreground text-xs">
            {group.operational}/{group.services.length} operational
            {group.unknown > 0 ? ` · ${group.unknown} unknown` : ""} · {group.description}
          </span>
        </span>
        <StatusChip level={group.level} />
      </button>
      {open ? (
        <ul id={panelId} className="divide-y">
          {group.services.map((service) => (
            <ServiceRow
              key={service.id}
              service={service}
              incidents={incidents}
              defaultOpen={service.level !== "operational" && service.level !== "unknown"}
            />
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function IncidentList({
  incidents,
  services,
}: {
  incidents: ReadonlyArray<StatusIncident>;
  services: ReadonlyArray<StatusService>;
}) {
  const names = new Map(services.map((service) => [service.id, service.name]));
  return (
    <section className="rounded-xl border bg-card" data-testid="status-incidents">
      <h2 className="border-b px-4 py-3 font-semibold text-sm sm:px-5">Incidents</h2>
      <ul className="divide-y">
        {incidents.map((incident) => (
          <li key={incident.id} className="flex items-start gap-3 px-4 py-3 sm:px-5">
            <LevelIcon
              level={incident.resolvedAt === null ? incident.level : "operational"}
              className="mt-0.5 size-4 shrink-0"
            />
            <div className="min-w-0 flex-1">
              <p className="font-medium text-sm">{incident.title}</p>
              <p className="mt-0.5 text-muted-foreground text-xs">
                {names.get(incident.serviceId) ?? incident.serviceId} ·{" "}
                {incident.origin === "public" ? "Provider status page" : "Seen by this Mac"} ·{" "}
                {incident.resolvedAt
                  ? `Resolved ${formatStatusTime(incident.resolvedAt)}`
                  : `Started ${formatStatusTime(incident.startedAt)}`}
                {incident.url ? (
                  <>
                    {" · "}
                    <ExternalLink href={incident.url}>Details</ExternalLink>
                  </>
                ) : null}
              </p>
            </div>
            <span
              className={cn(
                "shrink-0 rounded-full px-2 py-0.5 font-medium text-xs",
                incident.resolvedAt === null
                  ? STATUS_LEVEL_STYLES[incident.level].chip
                  : "bg-muted text-muted-foreground",
              )}
            >
              {STAGE_LABELS[incident.stage]}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function StatusView({
  snapshot,
  now,
  refreshing,
  error,
  onRefresh,
}: {
  snapshot: StatusSnapshot | null;
  now: number;
  refreshing: boolean;
  error: string | null;
  onRefresh: (() => void) | null;
}) {
  const services = snapshot?.services ?? [];
  const headline = useMemo(() => statusHeadline(services), [services]);
  const groups = useMemo(() => groupStatusServices(services), [services]);
  const incidents = snapshot?.incidents ?? [];
  const checking = refreshing || snapshot?.checking === true;

  return (
    <div className="flex flex-col gap-5" data-testid="status-view">
      <section
        className={cn(
          "flex flex-col gap-4 rounded-xl border px-4 py-4 sm:flex-row sm:items-center sm:px-5",
          headline.level === "operational"
            ? "border-success/30 bg-success/6"
            : headline.level === "unknown"
              ? "bg-card"
              : headline.level === "major_outage"
                ? "border-destructive/30 bg-destructive/6"
                : "border-warning/40 bg-warning/8",
        )}
        data-testid="status-banner"
        data-level={headline.level}
      >
        <LevelIcon level={headline.level} className="size-7 shrink-0" />
        <div className="min-w-0 flex-1">
          <h2 className="font-semibold text-lg">{headline.title}</h2>
          <p className="text-muted-foreground text-sm">{headline.description}</p>
          <p className="mt-1 text-muted-foreground text-xs">
            {checking ? "Checking now…" : `Checked ${formatAge(snapshot?.checkedAt ?? null, now)}`}
            {" · "}
            Checks run every 5 minutes in the background
          </p>
        </div>
        {onRefresh ? (
          <Button
            variant="outline"
            size="sm"
            onClick={onRefresh}
            disabled={checking}
            aria-label="Check status now"
          >
            <RefreshIcon refreshing={checking} />
            Check now
          </Button>
        ) : null}
      </section>

      {error ? (
        <p
          role="alert"
          className="rounded-lg border border-destructive/30 bg-destructive/6 px-4 py-3 text-sm"
        >
          {error}
        </p>
      ) : null}

      {incidents.length > 0 ? <IncidentList incidents={incidents} services={services} /> : null}

      {groups.map((group) => (
        <GroupSection key={group.id} group={group} incidents={incidents} />
      ))}

      {snapshot !== null && services.length > 0 ? (
        <p className="text-muted-foreground text-xs">
          History is kept on this Mac for 90 days. Each bar is one day in the worst status seen that
          day; a single failed check among many shows as Needs attention. Provider levels combine
          their public status pages with what this app saw: sign-in, usage limits and failed turns
          in the last hour.
        </p>
      ) : null}
    </div>
  );
}
