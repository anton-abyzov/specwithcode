/** Turns the monitor's latest inputs and the stored history into what clients read. */
import {
  rollupStatusLevels,
  type StatusIncident,
  type StatusSnapshot,
} from "@specweave-studio/contracts";
import * as DateTime from "effect/DateTime";

import { buildStatusServices, publicIncidents, type StatusInputs } from "./catalog.ts";
import { serviceDays, serviceUptime, type StatusHistory } from "./history.ts";

/** The page lists resolved incidents by day for this long, like a public status page. */
const RESOLVED_INCIDENT_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
const RESOLVED_INCIDENTS_SHOWN = 60;

export interface MonitorState {
  readonly inputs: StatusInputs | null;
  readonly checkedAt: number | null;
  readonly checking: boolean;
}

const isoAt = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));

export function snapshotFrom(
  state: MonitorState,
  history: StatusHistory,
  now: number,
): StatusSnapshot {
  const inputs = state.inputs;
  const services = inputs === null ? [] : buildStatusServices({ ...inputs, now });
  const shown = new Set(services.map((service) => service.id));
  const incidents: Array<StatusIncident> = [
    ...history.incidents.filter((incident) => shown.has(incident.serviceId)),
    ...(inputs === null ? [] : publicIncidents(services, inputs.feeds)),
  ];
  const open = incidents
    .filter((incident) => incident.resolvedAt === null)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const resolved = incidents
    .filter(
      (incident) =>
        incident.resolvedAt !== null &&
        now - Date.parse(incident.resolvedAt) <= RESOLVED_INCIDENT_WINDOW_MS,
    )
    .sort((a, b) => b.resolvedAt!.localeCompare(a.resolvedAt!))
    .slice(0, RESOLVED_INCIDENTS_SHOWN);
  return {
    generatedAt: isoAt(now),
    level:
      services.length === 0
        ? "unknown"
        : rollupStatusLevels(services.map((service) => service.level)),
    checkedAt: state.checkedAt === null ? null : isoAt(state.checkedAt),
    checking: state.checking,
    services: services.map(({ tracksIncidents: _tracks, ...service }) => {
      const days = serviceDays(history, service.id, now);
      return {
        ...service,
        checkedAt: state.checkedAt === null ? null : isoAt(state.checkedAt),
        days,
        uptimePercent: serviceUptime(days, history, service.id),
      };
    }),
    incidents: [...open, ...resolved],
  };
}
