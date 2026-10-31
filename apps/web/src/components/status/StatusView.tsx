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
import { useId, useMemo, useState, type KeyboardEvent, type ReactNode } from "react";

import { useMediaQuery } from "../../hooks/useMediaQuery";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { RefreshIcon } from "../ui/refresh-icon";
import {
  STATUS_LEVEL_STYLES,
  formatAge,
  formatClock,
  formatShortDate,
  formatStatusDate,
  formatStatusTime,
  formatUptime,
  groupPastIncidents,
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

/** Phones show the last 30 days, as public status pages do; wider windows all 90. */
const NARROW_DAYS = 30;

const LEVEL_TEXT: Record<StatusLevel, string> = {
  operational: "text-success-foreground",
  degraded: "text-warning-foreground",
  partial_outage: "text-orange-600 dark:text-orange-400",
  major_outage: "text-destructive-foreground",
  maintenance: "text-info-foreground",
  unknown: "text-muted-foreground",
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
  return <Icon aria-hidden className={cn(LEVEL_TEXT[level], className)} />;
}

/** The level as colored text with its icon, the way public status pages mark a row. */
function LevelLabel({ level, label }: { level: StatusLevel; label?: string }) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 font-medium text-xs",
        LEVEL_TEXT[level],
      )}
    >
      {label ?? statusLabel(level)}
      <LevelIcon level={level} className="size-4" />
    </span>
  );
}

function ExternalLink({ href, children }: { href: string; children: ReactNode }) {
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

/** Daily bars; hovering or arrowing through them shows that day's detail. */
export function StatusDayBars({
  days,
  label,
  incidents,
  uptimePercent,
}: {
  days: ReadonlyArray<StatusDay>;
  label: string;
  incidents: ReadonlyArray<StatusIncident>;
  uptimePercent: number | null;
}) {
  const wide = useMediaQuery("sm");
  const firstShown = wide ? 0 : Math.max(0, days.length - NARROW_DAYS);
  const shown = days.length - firstShown;
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
      if (event.key === "Home") return firstShown;
      if (event.key === "End") return days.length - 1;
      return Math.min(
        days.length - 1,
        Math.max(firstShown, index + (event.key === "ArrowRight" ? 1 : -1)),
      );
    });
  };
  const position = active === null ? 0 : (active - firstShown + 0.5) / shown;

  return (
    <div className="relative">
      <div
        role="group"
        tabIndex={0}
        aria-label={`${label}: daily status for the last ${shown} days. Use the arrow keys to read a day.`}
        aria-describedby={activeDay ? tooltipId : undefined}
        className="flex h-7 min-w-0 items-stretch gap-[2px] rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onKeyDown={onKeyDown}
        onBlur={() => setActive(null)}
        onMouseLeave={() => setActive(null)}
        data-testid="status-day-bars"
      >
        {days.map((day, index) =>
          index < firstShown ? null : (
            <span
              key={day.date}
              data-level={day.level}
              onMouseEnter={() => setActive(index)}
              className={cn(
                "min-w-0 flex-1 rounded-[1.5px] transition-opacity",
                STATUS_LEVEL_STYLES[day.level].bar,
                active !== null && active !== index && "opacity-50",
              )}
            />
          ),
        )}
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
                  <span className="line-clamp-3">{note}</span>
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
                    <span className="line-clamp-2">{incident.title}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      ) : null}
      <div
        className="mt-1.5 flex items-center gap-2 text-[11px] text-muted-foreground"
        data-testid="status-uptime-line"
      >
        <span>{shown} days ago</span>
        <span aria-hidden className="h-px flex-1 bg-border" />
        <span className="tabular-nums">{formatUptime(uptimePercent)}</span>
        <span aria-hidden className="h-px flex-1 bg-border" />
        <span>Today</span>
      </div>
    </div>
  );
}

function ComponentRow({ component }: { component: StatusComponent }) {
  return (
    <li className="flex items-start justify-between gap-3 py-1.5">
      <div className="min-w-0">
        <p className="text-xs">{component.name}</p>
        {component.detail ? (
          <p className="break-words text-[11px] text-muted-foreground">{component.detail}</p>
        ) : null}
      </div>
      <LevelLabel level={component.level} />
    </li>
  );
}

function ServiceRow({
  service,
  incidents,
}: {
  service: StatusService;
  incidents: ReadonlyArray<StatusIncident>;
}) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const serviceIncidents = incidents.filter((incident) => incident.serviceId === service.id);
  const quiet = service.level === "operational";
  return (
    <li className="px-4 py-3 sm:px-5" data-testid="status-service" data-service-id={service.id}>
      <div className="flex items-center gap-3">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => setOpen((value) => !value)}
          className="group flex min-w-0 flex-1 items-center gap-1.5 rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span className="truncate font-medium text-sm">{service.name}</span>
          <ChevronRightIcon
            aria-hidden
            className={cn(
              "size-3.5 shrink-0 text-muted-foreground opacity-60 transition-transform group-hover:opacity-100",
              open && "rotate-90",
            )}
          />
        </button>
        <LevelLabel
          level={service.level}
          {...(service.level === "unknown" && service.group === "machines"
            ? { label: "Offline" }
            : {})}
        />
      </div>
      {quiet ? null : (
        <p className="mt-0.5 line-clamp-2 break-words text-muted-foreground text-xs">
          {service.detail}
        </p>
      )}
      <div className="mt-2">
        <StatusDayBars
          days={service.days}
          label={service.name}
          incidents={serviceIncidents}
          uptimePercent={service.uptimePercent}
        />
      </div>
      {open ? (
        <div id={panelId} className="mt-2.5 rounded-lg border bg-muted/30 px-3 py-1">
          {quiet ? <p className="py-1.5 text-muted-foreground text-xs">{service.detail}</p> : null}
          <ul className={cn("divide-y", quiet && "border-t")}>
            {service.components.map((component) => (
              <ComponentRow key={component.id} component={component} />
            ))}
          </ul>
          <div className="flex flex-wrap items-center gap-1.5 border-t py-2 text-[11px]">
            <span className="text-muted-foreground">Used by</span>
            {service.dependents.map((dependent) => (
              <span key={dependent} className="rounded border bg-background px-1.5 py-px">
                {dependent}
              </span>
            ))}
          </div>
          <p className="border-t py-1.5 text-[11px] text-muted-foreground">
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
  const counted = group.services.length - group.unknown;
  return (
    <section data-testid="status-group" data-group-id={group.id}>
      <div className="mb-1.5 flex items-baseline justify-between gap-3 px-1">
        <h2 className="font-semibold text-sm">{group.name}</h2>
        <span className="text-muted-foreground text-xs">
          {group.operational}/{counted} operational
          {group.unknown > 0 ? ` · ${group.unknown} offline or unknown` : ""}
        </span>
      </div>
      {/* No overflow-hidden: it would clip a day popover rising above the first row. */}
      <ul className="divide-y rounded-xl border bg-card text-card-foreground">
        {group.services.map((service) => (
          <ServiceRow key={service.id} service={service} incidents={incidents} />
        ))}
      </ul>
    </section>
  );
}

function OpenIncidents({
  incidents,
  names,
}: {
  incidents: ReadonlyArray<StatusIncident>;
  names: ReadonlyMap<string, string>;
}) {
  return (
    <section className="flex flex-col gap-2" data-testid="status-incidents">
      {incidents.map((incident) => (
        <article
          key={incident.id}
          className={cn(
            "rounded-xl border border-s-4 bg-card px-4 py-3 sm:px-5",
            incident.level === "major_outage"
              ? "border-s-destructive"
              : incident.level === "partial_outage"
                ? "border-s-orange-500"
                : incident.level === "maintenance"
                  ? "border-s-info"
                  : "border-s-warning",
          )}
        >
          <div className="flex items-start justify-between gap-3">
            <p className="min-w-0 break-words font-medium text-sm">{incident.title}</p>
            <span
              className={cn(
                "shrink-0 rounded-full px-2 py-0.5 font-medium text-xs",
                STATUS_LEVEL_STYLES[incident.level].chip,
              )}
            >
              {STAGE_LABELS[incident.stage]}
            </span>
          </div>
          <p className="mt-1 text-muted-foreground text-xs">
            {names.get(incident.serviceId) ?? incident.serviceId} ·{" "}
            {incident.origin === "public" ? "Provider status page" : "Seen by this Mac"} · Started{" "}
            {formatStatusTime(incident.startedAt)}
            {incident.url ? (
              <>
                {" · "}
                <ExternalLink href={incident.url}>Details</ExternalLink>
              </>
            ) : null}
          </p>
        </article>
      ))}
    </section>
  );
}

function PastIncidents({
  incidents,
  names,
}: {
  incidents: ReadonlyArray<StatusIncident>;
  names: ReadonlyMap<string, string>;
}) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const days = useMemo(() => groupPastIncidents(incidents), [incidents]);
  const total = incidents.filter((incident) => incident.resolvedAt !== null).length;
  if (total === 0) return null;
  return (
    <section data-testid="status-past-incidents">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center justify-between gap-3 rounded-sm px-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className="flex shrink-0 items-center gap-1.5 font-semibold text-sm">
          Past incidents
          <ChevronRightIcon
            aria-hidden
            className={cn(
              "size-3.5 text-muted-foreground transition-transform",
              open && "rotate-90",
            )}
          />
        </span>
        <span className="text-muted-foreground text-xs">{total} resolved · last 14 days</span>
      </button>
      {open ? (
        <div id={panelId} className="mt-1.5 divide-y rounded-xl border bg-card">
          {days.map((day) => (
            <div key={day.date} className="px-4 py-2.5 sm:px-5">
              <h3 className="mb-1 font-medium text-muted-foreground text-xs">
                {formatShortDate(day.date)}
              </h3>
              <ul className="space-y-1.5">
                {day.entries.map((entry) => (
                  <li key={entry.key} className="flex items-start gap-2">
                    <LevelIcon level={entry.level} className="mt-0.5 size-3.5 shrink-0" />
                    <div className="min-w-0 flex-1">
                      <p className="break-words text-xs">
                        {entry.title}
                        {entry.count > 1 ? (
                          <span className="ms-1.5 rounded bg-muted px-1 py-px font-medium text-[10px] text-muted-foreground tabular-nums">
                            ×{entry.count}
                          </span>
                        ) : null}
                      </p>
                      <p className="text-[11px] text-muted-foreground">
                        {names.get(entry.serviceId) ?? entry.serviceId} ·{" "}
                        {entry.count > 1
                          ? `${formatClock(entry.firstStartedAt)} to ${formatClock(entry.lastResolvedAt)}`
                          : `Resolved ${formatClock(entry.lastResolvedAt)}`}
                        {entry.url ? (
                          <>
                            {" · "}
                            <ExternalLink href={entry.url}>Details</ExternalLink>
                          </>
                        ) : null}
                      </p>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      ) : null}
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
  const names = useMemo(
    () => new Map(services.map((service) => [service.id, service.name])),
    [services],
  );
  const incidents = snapshot?.incidents ?? [];
  const open = incidents.filter((incident) => incident.resolvedAt === null);
  const checking = refreshing || snapshot?.checking === true;

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6" data-testid="status-view">
      <section
        className={cn(
          "flex items-center gap-3 rounded-xl border px-4 py-3 sm:px-5",
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
        <LevelIcon level={headline.level} className="size-6 shrink-0" />
        <div className="min-w-0 flex-1">
          <h2 className="font-semibold text-base leading-tight">{headline.title}</h2>
          <p className="mt-0.5 line-clamp-2 text-muted-foreground text-xs">
            {headline.description}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span className="hidden text-muted-foreground text-xs sm:inline">
            {checking ? "Checking…" : `Updated ${formatAge(snapshot?.checkedAt ?? null, now)}`}
          </span>
          {onRefresh ? (
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={onRefresh}
              disabled={checking}
              aria-label="Check status now"
              title="Check now"
            >
              <RefreshIcon refreshing={checking} />
            </Button>
          ) : null}
        </div>
      </section>

      {error ? (
        <p
          role="alert"
          className="rounded-lg border border-destructive/30 bg-destructive/6 px-4 py-3 text-sm"
        >
          {error}
        </p>
      ) : null}

      {open.length > 0 ? <OpenIncidents incidents={open} names={names} /> : null}

      {groups.map((group) => (
        <GroupSection key={group.id} group={group} incidents={incidents} />
      ))}

      <PastIncidents incidents={incidents} names={names} />

      {snapshot !== null && services.length > 0 ? (
        <p className="px-1 text-[11px] text-muted-foreground leading-relaxed">
          Checked every 5 minutes; history stays on this Mac for 90 days. Each bar is one day at the
          worst level seen, and a single failed check among many shows as Needs attention. Provider
          rows combine their public status pages with sign-in, usage limits and failed turns seen
          here in the last hour. A machine offline for over a day is not counted.
        </p>
      ) : null}
    </div>
  );
}
