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

/**
 * On the github channel release.sh publishes v<version> before any machine
 * installs it, so the "candidate" stage is the publish and the "canary" stage
 * is M4's rollout. The stage ids stay the graph's.
 */
const GITHUB_CHANNEL_LABELS: Record<string, string> = {
  "publish.candidate": "Publish",
  canary: "M4 rollout",
};

function phaseOf(stageId: string, channel?: string): string {
  if (channel === "github" && stageId === "canary") return GITHUB_CHANNEL_LABELS.canary!;
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
  channel?: string,
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
      label: [...new Set(column.map((stage) => phaseOf(stage.id, channel)))].join(" · "),
      stages: column,
    }));
}

/** A stage as the view shows it: its recorded state, or `absent` for one this run never runs. */
export type ReleaseStageViewState = ReleaseRunStageState | "absent";

export const STAGE_STATE_LABELS: Record<ReleaseStageViewState, string> = {
  pending: "Waiting",
  running: "Running",
  passed: "Passed",
  failed: "Failed",
  skipped: "Skipped",
  absent: "Not in this run",
};

/**
 * A pending stage with no steps is one this run has nothing for: release.sh
 * records every step it will run when the run starts (so on its runs such a
 * stage never runs: Windows and Linux builds, the web and fleet suites run in
 * their own workflows), and a finished run will run nothing more. Release
 * verification runs after release.sh, so it waits while the run is not done.
 * A release.yml run records a stage once its job starts, so there it waits.
 */
export function stageViewState(
  stage: ReleaseRunStage,
  run: Pick<ReleaseRun, "state" | "createdBy">,
): ReleaseStageViewState {
  if (stage.state !== "pending" || stage.steps.length > 0) return stage.state;
  if (run.state === "done") return "absent";
  if (stage.id === "verify.release") return "pending";
  return run.createdBy === "release.sh" ? "absent" : "pending";
}

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

export function stageTone(state: ReleaseStageViewState): ReleaseTone {
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

/**
 * The Version cell: where a machine went. A machine the release did not update stays on
 * the version it had (or unknown), never the release's target.
 */
export function hostVersion(host: ReleaseRunHost): string {
  if (host.state === "not-updated") return host.from ?? "—";
  return host.from && host.from !== host.to ? `${host.from} → ${host.to ?? "?"}` : (host.to ?? "?");
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

/**
 * How long a stage took, or has run so far while running; null before it
 * started. With step times it is the time its steps ran, overlaps counted
 * once: a stage's first and last step can be far apart (a resume reruns
 * `trees` half an hour after the rest of Resolve; Canary's steps sit around
 * the publish), and that gap is no time the stage took.
 */
export function stageDuration(stage: ReleaseRunStage, nowMs: number): string | null {
  const intervals: Array<[number, number]> = [];
  for (const step of stage.steps) {
    const started = parseMs(step.startedAt);
    if (started === null) continue;
    // A step that started but never recorded its end (killed, failed mid-way) ran until the
    // stage ended, or until now while the stage still runs. A finished stage never counts on.
    const ended =
      parseMs(step.endedAt) ??
      (stage.state === "running"
        ? nowMs
        : (parseMs(stage.endedAt) ?? (step.state === "running" ? nowMs : null)));
    if (ended !== null && ended >= started) intervals.push([started, ended]);
  }
  // A running stage between two steps (one passed, the next not started) keeps counting.
  if (
    stage.state === "running" &&
    intervals.length > 0 &&
    !stage.steps.some((step) => step.state === "running")
  ) {
    const last = Math.max(...intervals.map(([, end]) => end));
    if (nowMs > last) intervals.push([last, nowMs]);
  }
  if (intervals.length > 0) {
    intervals.sort((left, right) => left[0] - right[0]);
    let total = 0;
    let [from, to] = intervals[0]!;
    for (const [start, end] of intervals.slice(1)) {
      if (start > to) {
        total += to - from;
        [from, to] = [start, end];
      } else {
        to = Math.max(to, end);
      }
    }
    return formatSeconds((total + (to - from)) / 1000);
  }
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

export function stageName(stageId: string, channel?: string): string {
  if (channel === "github" && GITHUB_CHANNEL_LABELS[stageId]) return GITHUB_CHANNEL_LABELS[stageId];
  return STAGE_NAMES[stageId] ?? stageId;
}

/** The run to show: the one asked for when it is still listed, else the newest. */
export function selectedRun(
  runs: ReadonlyArray<ReleaseRun>,
  runId: string | null,
): ReleaseRun | null {
  return runs.find((run) => run.runId === runId) ?? runs[0] ?? null;
}

/** Stage counts for the run's one-line summary; stages not in this run are no waiting ones. */
export function stageCounts(run: Pick<ReleaseRun, "stages" | "state" | "createdBy">) {
  const counts = { passed: 0, running: 0, failed: 0, pending: 0, skipped: 0, absent: 0 };
  for (const stage of run.stages) counts[stageViewState(stage, run)] += 1;
  return counts;
}
