import {
  STATUS_LEVEL_LABELS,
  rollupStatusLevels,
  type DesktopUpdateState,
  type StatusComponent,
  type StatusIncident,
  type StatusLevel,
  type StatusService,
  type StatusServiceGroup,
  type StatusSnapshot,
} from "@specweave-studio/contracts";

export const STATUS_GROUPS: ReadonlyArray<{
  readonly id: StatusServiceGroup;
  readonly name: string;
  readonly description: string;
}> = [
  { id: "app", name: "SpecWithCode", description: "This Mac's service, coordinators and updates" },
  { id: "machines", name: "Machines", description: "Paired machines and the private network" },
  {
    id: "dependencies",
    name: "Dependencies",
    description: "Providers and services the app relies on",
  },
];

/** Bar, dot and chip colors per level; tokens follow the light and dark themes. */
export const STATUS_LEVEL_STYLES: Record<
  StatusLevel,
  { readonly bar: string; readonly dot: string; readonly chip: string }
> = {
  operational: {
    bar: "bg-success/80",
    dot: "bg-success",
    chip: "bg-success/10 text-success-foreground dark:bg-success/16",
  },
  degraded: {
    bar: "bg-warning",
    dot: "bg-warning",
    chip: "bg-warning/12 text-warning-foreground dark:bg-warning/18",
  },
  partial_outage: {
    bar: "bg-orange-500",
    dot: "bg-orange-500",
    chip: "bg-orange-500/12 text-orange-700 dark:bg-orange-500/20 dark:text-orange-300",
  },
  major_outage: {
    bar: "bg-destructive",
    dot: "bg-destructive",
    chip: "bg-destructive/10 text-destructive-foreground dark:bg-destructive/18",
  },
  maintenance: {
    bar: "bg-info",
    dot: "bg-info",
    chip: "bg-info/10 text-info-foreground dark:bg-info/16",
  },
  unknown: {
    bar: "bg-muted-foreground/20",
    dot: "bg-muted-foreground/50",
    chip: "bg-muted text-muted-foreground",
  },
};

export const statusLabel = (level: StatusLevel) => STATUS_LEVEL_LABELS[level];

/** The desktop app's own updater, which only this window can see. */
export function desktopUpdaterComponent(state: DesktopUpdateState | null): StatusComponent | null {
  if (state === null) return null;
  const component = (level: StatusLevel, detail: string): StatusComponent => ({
    id: "desktop-updater",
    name: "Desktop updater",
    level,
    detail,
  });
  if (!state.enabled || state.status === "disabled") {
    return component("maintenance", "Automatic updates are off.");
  }
  switch (state.status) {
    case "error":
      return component(
        "degraded",
        state.message ?? `The last ${state.errorContext ?? "check"} failed.`,
      );
    case "available":
    case "downloading":
      return component(
        "operational",
        `Version ${state.availableVersion ?? "update"} ${state.status === "downloading" ? "downloading" : "available"}.`,
      );
    case "downloaded":
      return component(
        "operational",
        `Version ${state.downloadedVersion ?? "update"} ready to install.`,
      );
    case "checking":
      return component("operational", "Checking for updates.");
    default:
      return component("operational", `Up to date on ${state.currentVersion}.`);
  }
}

/** Adds what only this window knows (the desktop updater) to the host's services. */
export function withLocalComponents(
  snapshot: StatusSnapshot,
  updater: StatusComponent | null,
): StatusSnapshot {
  if (updater === null) return snapshot;
  const services = snapshot.services.map((service) => {
    if (service.id !== "updates") return service;
    const components = [...service.components, updater];
    const known = components.filter((entry) => entry.level !== "unknown");
    const level = rollupStatusLevels(
      known.length > 0 ? known.map((entry) => entry.level) : ["unknown"],
    );
    return {
      ...service,
      components,
      level,
      detail: level === service.level ? service.detail : `${updater.name}: ${updater.detail}`,
    };
  });
  return {
    ...snapshot,
    services,
    level: rollupStatusLevels(services.map((service) => service.level)),
  };
}

export interface StatusGroupView {
  readonly id: StatusServiceGroup;
  readonly name: string;
  readonly description: string;
  readonly level: StatusLevel;
  readonly services: ReadonlyArray<StatusService>;
  readonly operational: number;
  readonly unknown: number;
}

export function groupStatusServices(
  services: ReadonlyArray<StatusService>,
): ReadonlyArray<StatusGroupView> {
  return STATUS_GROUPS.flatMap((group) => {
    const members = services.filter((service) => service.group === group.id);
    if (members.length === 0) return [];
    const known = members.filter((service) => service.level !== "unknown");
    return [
      {
        ...group,
        level: rollupStatusLevels(
          known.length > 0 ? known.map((service) => service.level) : ["unknown"],
        ),
        services: members,
        operational: members.filter((service) => service.level === "operational").length,
        unknown: members.length - known.length,
      },
    ];
  });
}

const isTrouble = (level: StatusLevel) =>
  level === "degraded" || level === "partial_outage" || level === "major_outage";

/** The banner: the app's own health first, dependencies as a qualifier. */
export function statusHeadline(services: ReadonlyArray<StatusService>): {
  readonly level: StatusLevel;
  readonly title: string;
  readonly description: string;
} {
  if (services.length === 0) {
    return {
      level: "unknown",
      title: "Checking status",
      description: "The first check runs in the background and takes a few seconds.",
    };
  }
  const own = services.filter((service) => service.group !== "dependencies");
  const dependencies = services.filter((service) => service.group === "dependencies");
  const ownTrouble = own.filter((service) => isTrouble(service.level));
  const dependencyTrouble = dependencies.filter((service) => isTrouble(service.level));
  const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;
  if (ownTrouble.length === 0 && dependencyTrouble.length === 0) {
    const unknown = services.filter((service) => service.level === "unknown").length;
    return {
      level: "operational",
      title: "All systems operational",
      description:
        unknown > 0
          ? `${plural(services.length - unknown, "service")} checked · ${unknown} unknown`
          : `${plural(services.length, "service")} checked`,
    };
  }
  const level = rollupStatusLevels([...own, ...dependencies].map((service) => service.level));
  if (ownTrouble.length === 0) {
    return {
      level: "degraded",
      title: "SpecWithCode is operational",
      description: `${dependencyTrouble.map((service) => service.name).join(", ")} ${
        dependencyTrouble.length === 1 ? "reports" : "report"
      } issues.`,
    };
  }
  const trouble = [...ownTrouble, ...dependencyTrouble];
  return {
    level,
    title: `${plural(trouble.length, "service")} need${trouble.length === 1 ? "s" : ""} attention`,
    description: trouble
      .map((service) => `${service.name}: ${statusLabel(service.level)}`)
      .join(" · "),
  };
}

export function formatStatusDate(date: string): string {
  return new Date(`${date}T12:00:00`).toLocaleDateString(undefined, {
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

export function formatStatusTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: "long",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });
}

export function formatAge(iso: string | null, now: number): string {
  if (iso === null) return "not checked yet";
  const minutes = Math.max(0, Math.floor((now - Date.parse(iso)) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours} hr ago` : `${Math.floor(hours / 24)} days ago`;
}

export function formatUptime(percent: number | null): string {
  if (percent === null) return "No data";
  return `${percent >= 99.995 ? "100" : percent.toFixed(2)}% uptime`;
}

/** One line in the past incidents list: repeats of one title on one service that day. */
export interface PastIncidentEntry {
  readonly key: string;
  readonly serviceId: string;
  readonly title: string;
  readonly level: StatusLevel;
  readonly origin: StatusIncident["origin"];
  readonly url: string | null;
  readonly count: number;
  readonly firstStartedAt: string;
  readonly lastResolvedAt: string;
}

export interface PastIncidentDay {
  /** Local calendar day the incidents resolved, `YYYY-MM-DD`. */
  readonly date: string;
  readonly entries: ReadonlyArray<PastIncidentEntry>;
}

const pad = (value: number) => String(value).padStart(2, "0");
const localDay = (iso: string) => {
  const date = new Date(iso);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
};

/**
 * Resolved incidents by the day they resolved, newest first. Repeats of one
 * title on one service collapse into a single entry with a count, so a noisy
 * check reads as one line, not a wall.
 */
export function groupPastIncidents(
  incidents: ReadonlyArray<StatusIncident>,
): ReadonlyArray<PastIncidentDay> {
  const days = new Map<string, Map<string, PastIncidentEntry>>();
  const resolved = incidents
    .filter((incident) => incident.resolvedAt !== null)
    .toSorted((a, b) => b.resolvedAt!.localeCompare(a.resolvedAt!));
  for (const incident of resolved) {
    const date = localDay(incident.resolvedAt!);
    const entries = days.get(date) ?? new Map<string, PastIncidentEntry>();
    days.set(date, entries);
    const key = `${incident.serviceId}\u0000${incident.title}`;
    const existing = entries.get(key);
    entries.set(
      key,
      existing === undefined
        ? {
            key: incident.id,
            serviceId: incident.serviceId,
            title: incident.title,
            level: incident.level,
            origin: incident.origin,
            url: incident.url,
            count: 1,
            firstStartedAt: incident.startedAt,
            lastResolvedAt: incident.resolvedAt!,
          }
        : {
            ...existing,
            level: rollupStatusLevels([existing.level, incident.level]),
            count: existing.count + 1,
            firstStartedAt:
              incident.startedAt < existing.firstStartedAt
                ? incident.startedAt
                : existing.firstStartedAt,
          },
    );
  }
  return [...days].map(([date, entries]) => ({ date, entries: [...entries.values()] }));
}

export function formatClock(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

export function formatShortDate(date: string): string {
  return new Date(`${date}T12:00:00`).toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}
