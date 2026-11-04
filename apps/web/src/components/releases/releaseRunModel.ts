import type {
  ReleaseRun,
  ReleaseRunHost,
  ReleaseRunHostState,
  ReleaseRunStage,
  ReleaseRunStageState,
  ReleaseRunState,
} from "@specweave-studio/contracts";

/**
 * The Releases view's pure parts: the stage graph laid out in columns by its
 * `needs` (a stage sits one column right of the latest stage it needs), the
 * per-machine rows of the canary and fleet stages, and the labels and times.
 */

export interface ReleaseGraphColumn {
  readonly label: string;
  readonly stages: ReadonlyArray<ReleaseRunStage>;
}

const PHASE_LABELS: Record<string, string> = {
  resolve: "Resolve",
  preflight: "Preflight",
  test: "Tests",
  build: "Build",
  verify: "Verify",
  publish: "Publish",
  canary: "Canary",
  fleet: "Fleet",
  finalize: "Finalize",
  "verify.release": "Released",
};

function phaseOf(stageId: string): string {
  if (PHASE_LABELS[stageId]) return PHASE_LABELS[stageId];
  const head = stageId.split(".")[0] ?? stageId;
  return PHASE_LABELS[head] ?? head;
}

/**
 * Columns of the graph, left to right. A stage's column is one more than the
 * deepest stage it needs; a need the record does not hold, or a cycle, counts
 * as nothing. Within a column the record's order is kept.
 */
export function releaseGraphColumns(
  stages: ReadonlyArray<ReleaseRunStage>,
): ReadonlyArray<ReleaseGraphColumn> {
  const byId = new Map(stages.map((stage) => [stage.id, stage]));
  const depth = new Map<string, number>();
  const visiting = new Set<string>();
  const depthOf = (stage: ReleaseRunStage): number => {
    const known = depth.get(stage.id);
    if (known !== undefined) return known;
    if (visiting.has(stage.id)) return 0;
    visiting.add(stage.id);
    let value = 0;
    for (const need of stage.needs) {
      const needed = byId.get(need);
      if (needed) value = Math.max(value, depthOf(needed) + 1);
    }
    visiting.delete(stage.id);
    depth.set(stage.id, value);
    return value;
  };
  const columns: ReleaseRunStage[][] = [];
  for (const stage of stages) {
    const at = depthOf(stage);
    (columns[at] ??= []).push(stage);
  }
  return columns
    .filter((column) => column !== undefined && column.length > 0)
    .map((column) => ({
      label: [...new Set(column.map((stage) => phaseOf(stage.id)))].join(" · "),
      stages: column,
    }));
}

export const STAGE_STATE_LABELS: Record<ReleaseRunStageState, string> = {
  pending: "Waiting",
  running: "Running",
  passed: "Passed",
  failed: "Failed",
  skipped: "Skipped",
};

export const RUN_STATE_LABELS: Record<ReleaseRunState, string> = {
  running: "Running",
  held: "Held",
  failed: "Failed",
  done: "Released",
};

export const HOST_STATE_LABELS: Record<ReleaseRunHostState, string> = {
  pending: "Not asked yet",
  asked: "Asked",
  acked: "Acknowledged",
  installed: "Installed",
  verified: "Verified",
  "not-updated": "Not updated",
};

export type ReleaseTone = "success" | "warning" | "danger" | "info" | "muted";

export const TONE_STYLES: Record<
  ReleaseTone,
  { readonly chip: string; readonly dot: string; readonly border: string; readonly text: string }
> = {
  success: {
    chip: "bg-success/10 text-success-foreground dark:bg-success/16",
    dot: "bg-success",
    border: "border-success/40",
    text: "text-success-foreground",
  },
  warning: {
    chip: "bg-warning/12 text-warning-foreground dark:bg-warning/18",
    dot: "bg-warning",
    border: "border-warning/50",
    text: "text-warning-foreground",
  },
  danger: {
    chip: "bg-destructive/10 text-destructive-foreground dark:bg-destructive/18",
    dot: "bg-destructive",
    border: "border-destructive/50",
    text: "text-destructive-foreground",
  },
  info: {
    chip: "bg-info/10 text-info-foreground dark:bg-info/16",
    dot: "bg-info",
    border: "border-info/50",
    text: "text-info-foreground",
  },
  muted: {
    chip: "bg-muted text-muted-foreground",
    dot: "bg-muted-foreground/40",
    border: "border-border",
    text: "text-muted-foreground",
  },
};

export function stageTone(state: ReleaseRunStageState): ReleaseTone {
  switch (state) {
    case "passed":
      return "success";
    case "running":
      return "info";
    case "failed":
      return "danger";
    default:
      return "muted";
  }
}

export function runTone(state: ReleaseRunState): ReleaseTone {
  switch (state) {
    case "done":
      return "success";
    case "running":
      return "info";
    case "held":
      return "warning";
    default:
      return "danger";
  }
}

export function hostTone(host: ReleaseRunHost): ReleaseTone {
  if (host.state === "verified") return "success";
  if (host.state === "not-updated") return host.required ? "danger" : "warning";
  if (host.state === "pending") return "muted";
  return "info";
}

export interface ReleaseHostGroup {
  readonly role: ReleaseRunHost["role"];
  readonly label: string;
  readonly hosts: ReadonlyArray<ReleaseRunHost>;
}

/** Canary first, then fleet; required machines first within each. */
export function releaseHostGroups(
  hosts: ReadonlyArray<ReleaseRunHost>,
): ReadonlyArray<ReleaseHostGroup> {
  const groups: ReleaseHostGroup[] = [];
  for (const [role, label] of [
    ["canary", "Canary"],
    ["fleet", "Fleet"],
  ] as const) {
    const members = hosts
      .filter((host) => host.role === role)
      .sort(
        (left, right) =>
          Number(right.required) - Number(left.required) ||
          left.identity.localeCompare(right.identity),
      );
    if (members.length > 0) groups.push({ role, label, hosts: members });
  }
  return groups;
}

/** "2 of 3 required machines verified", or null before any machine was asked. */
export function hostSummary(hosts: ReadonlyArray<ReleaseRunHost>): string | null {
  const required = hosts.filter((host) => host.required);
  if (hosts.length === 0) return null;
  const verified = required.filter((host) => host.state === "verified").length;
  const notUpdated = hosts.filter((host) => host.state === "not-updated").length;
  const parts = [
    `${verified} of ${required.length} required machine${required.length === 1 ? "" : "s"} verified`,
  ];
  if (notUpdated > 0) parts.push(`${notUpdated} not updated`);
  return parts.join(", ");
}

const parseMs = (value: string | null | undefined): number | null => {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
};

/** "4m 05s", "1h 02m" or "12s" from whole seconds. */
export function formatSeconds(totalSeconds: number): string {
  const seconds = Math.max(0, Math.round(totalSeconds));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, "0")}m`;
  if (minutes > 0) return `${minutes}m ${String(rest).padStart(2, "0")}s`;
  return `${rest}s`;
}

/** How long a stage took, or has run so far while running; null before it started. */
export function stageDuration(stage: ReleaseRunStage, nowMs: number): string | null {
  const started = parseMs(stage.startedAt);
  if (started === null) return null;
  const ended = parseMs(stage.endedAt) ?? (stage.state === "running" ? nowMs : null);
  if (ended === null) return null;
  return formatSeconds((ended - started) / 1000);
}

/** A record time as the viewer's local clock time, `14:05`; an em dash when absent. */
export function formatClock(value: string | null | undefined, locale?: string): string {
  const ms = parseMs(value);
  if (ms === null) return "—";
  return new Date(ms).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
}

/** A record time as a local date and time, `Nov 4, 14:05`. */
export function formatWhen(value: string | null | undefined, locale?: string): string {
  const ms = parseMs(value);
  if (ms === null) return "—";
  return new Date(ms).toLocaleString(locale, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Stage ids as written for people: `test.server` reads "Server tests". */
const STAGE_NAMES: Record<string, string> = {
  resolve: "Resolve",
  preflight: "Preflight",
  "test.unit": "Unit tests",
  "test.server": "Server tests",
  "test.web": "Web tests",
  "test.fleet": "Fleet tests",
  "test.desktop-e2e": "Desktop E2E",
  "test.migration": "Migration rehearsal",
  "build.mac": "Build macOS",
  "build.windows": "Build Windows",
  "build.linux": "Build Linux",
  "verify.mac": "Verify macOS",
  "verify.windows": "Verify Windows",
  "verify.linux": "Verify Linux",
  "publish.candidate": "Publish candidate",
  canary: "Canary",
  fleet: "Fleet",
  finalize: "Finalize",
  "verify.release": "Verify release",
};

export function stageName(stageId: string): string {
  return STAGE_NAMES[stageId] ?? stageId;
}

/** The run to show: the one asked for when it is still listed, else the newest. */
export function selectedRun(
  runs: ReadonlyArray<ReleaseRun>,
  runId: string | null,
): ReleaseRun | null {
  return runs.find((run) => run.runId === runId) ?? runs[0] ?? null;
}

/** Stage counts for the run's one-line summary. */
export function stageCounts(stages: ReadonlyArray<ReleaseRunStage>) {
  const counts = { passed: 0, running: 0, failed: 0, pending: 0, skipped: 0 };
  for (const stage of stages) counts[stage.state] += 1;
  return counts;
}
