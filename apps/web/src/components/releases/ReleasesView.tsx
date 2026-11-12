import type {
  ReleaseInstallTiming,
  ReleaseRun,
  ReleaseRunHost,
  ReleaseRunStage,
  ReleaseRunTiming,
} from "@specweave-studio/contracts";
import {
  CircleAlertIcon,
  CircleCheckIcon,
  CircleDashedIcon,
  CircleMinusIcon,
  CircleSlashIcon,
  LoaderCircleIcon,
} from "lucide-react";
import { useId, type ReactNode } from "react";

import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { RefreshIcon } from "../ui/refresh-icon";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  HOST_STATE_LABELS,
  RUN_STATE_LABELS,
  STAGE_STATE_LABELS,
  TONE_STYLES,
  formatClock,
  formatWhen,
  hostSummary,
  hostTone,
  hostVersion,
  releaseGraphColumns,
  releaseHostGroups,
  runTone,
  selectedRun,
  stageCounts,
  stageDuration,
  stageName,
  stageTone,
  stageViewState,
  type ReleaseStageViewState,
  type ReleaseTone,
} from "./releaseRunModel";
import { ReleaseSpeed } from "./ReleaseSpeed";
import { releaseTimings } from "./releaseSpeedModel";

export interface ReleasesViewProps {
  readonly runs: ReadonlyArray<ReleaseRun>;
  /** Files in the runs folder that are no release record this app reads. */
  readonly skipped: number;
  readonly loading: boolean;
  readonly failed: boolean;
  /** The run picked in the list; null shows the newest. */
  readonly selectedRunId: string | null;
  readonly onSelectRun: (runId: string) => void;
  readonly onRefresh?: () => void;
  readonly nowMs: number;
  /** Timings of more runs than `runs`; a server from before them sends none. */
  readonly timings?: ReadonlyArray<ReleaseRunTiming> | undefined;
  /** Verified installs on this machine; undefined from a server from before them. */
  readonly installs?: ReadonlyArray<ReleaseInstallTiming> | undefined;
}

function Chip({ tone, children }: { tone: ReleaseTone; children: ReactNode }) {
  return (
    <span
      className={cn(
        "inline-flex h-5 shrink-0 items-center gap-1.5 rounded-full px-2 font-medium text-xs leading-none",
        TONE_STYLES[tone].chip,
      )}
    >
      <span aria-hidden className={cn("size-1.5 rounded-full", TONE_STYLES[tone].dot)} />
      {children}
    </span>
  );
}

function StageIcon({ state }: { state: ReleaseStageViewState }) {
  const className = cn("size-4 shrink-0", TONE_STYLES[stageTone(state)].text);
  switch (state) {
    case "passed":
      return <CircleCheckIcon aria-hidden className={className} />;
    case "failed":
      return <CircleAlertIcon aria-hidden className={className} />;
    case "running":
      return <LoaderCircleIcon aria-hidden className={cn(className, "motion-safe:animate-spin")} />;
    case "skipped":
      return <CircleSlashIcon aria-hidden className={className} />;
    case "absent":
      return <CircleMinusIcon aria-hidden className={className} />;
    default:
      return <CircleDashedIcon aria-hidden className={className} />;
  }
}

function StageCard({
  stage,
  run,
  nowMs,
}: {
  stage: ReleaseRunStage;
  run: ReleaseRun;
  nowMs: number;
}) {
  const state = stageViewState(stage, run);
  const duration = stageDuration(stage, nowMs);
  const tone = stageTone(state);
  return (
    <Tooltip>
      <TooltipTrigger
        delay={200}
        render={
          <li
            tabIndex={0}
            data-stage={stage.id}
            data-state={state}
            className={cn(
              "flex min-w-0 flex-col gap-1 rounded-lg border bg-card px-2.5 py-2 text-card-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring",
              TONE_STYLES[tone].border,
              (state === "pending" || state === "absent") && "border-dashed",
              state === "absent" && "bg-transparent opacity-70",
            )}
          />
        }
      >
        <div className="flex min-w-0 items-start gap-1.5">
          <StageIcon state={state} />
          <span className="line-clamp-2 min-w-0 font-medium text-xs leading-4">
            {stageName(stage.id, run.channel)}
          </span>
        </div>
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-2 text-muted-foreground text-xs">
          <span className={TONE_STYLES[tone].text}>{STAGE_STATE_LABELS[state]}</span>
          {duration ? <span className="tabular-nums">{duration}</span> : null}
        </div>
        {stage.shards && stage.shards.length > 0 ? (
          <div
            className="flex flex-wrap gap-1"
            aria-label={`${stage.shards.filter((shard) => shard.state === "passed").length} of ${stage.shards.length} shards passed`}
          >
            {stage.shards.map((shard) => (
              <span
                key={shard.n}
                className={cn("size-2 rounded-full", TONE_STYLES[stageTone(shard.state)].dot)}
              />
            ))}
          </div>
        ) : null}
      </TooltipTrigger>
      <TooltipPopup side="top" className="max-w-xs">
        <span className="block font-mono text-2xs">{stage.id}</span>
        <span className="block">
          {stage.needs.length > 0 ? `Needs ${stage.needs.join(", ")}` : "First stage"}
        </span>
        {stage.log ? <span className="block break-all">Log: {stage.log}</span> : null}
      </TooltipPopup>
    </Tooltip>
  );
}

/**
 * The stage graph, one column per depth of `needs`, read left to right. It
 * sizes to its own width, not the window's: a narrow graph stacks the columns,
 * a wider one lays as many side by side as fit and wraps the rest onto the
 * next row, so no column is ever cut off at the page's edge.
 */
export function ReleaseStageGraph({ run, nowMs }: { run: ReleaseRun; nowMs: number }) {
  const columns = releaseGraphColumns(run.stages, run.channel);
  return (
    <div className="@container -mx-1 min-w-0 overflow-x-auto px-1 pb-1" data-release-graph>
      <ol className="flex flex-col gap-3 @min-[36rem]:grid @min-[36rem]:grid-cols-[repeat(auto-fit,minmax(6rem,1fr))] @min-[36rem]:gap-2">
        {columns.map((column) => (
          <li key={column.stages[0]?.id ?? column.label} className="min-w-0">
            <section className="flex min-w-0 flex-col gap-1.5">
              <h4 className="truncate px-0.5 font-medium text-2xs text-muted-foreground uppercase tracking-wide">
                {column.label}
              </h4>
              <ul className="grid min-w-0 grid-cols-2 gap-1.5 @min-[24rem]:grid-cols-3 @min-[36rem]:grid-cols-1">
                {column.stages.map((stage) => (
                  <StageCard key={stage.id} stage={stage} run={run} nowMs={nowMs} />
                ))}
              </ul>
            </section>
          </li>
        ))}
      </ol>
    </div>
  );
}

function HostRow({ host }: { host: ReleaseRunHost }) {
  const tone = hostTone(host);
  return (
    <tr data-host={host.identity} data-state={host.state} className="border-border border-t">
      <th scope="row" className="py-2 pr-3 text-left font-medium whitespace-nowrap">
        <span className="flex items-center gap-1.5">
          {host.identity}
          {host.required ? (
            <span className="rounded bg-muted px-1 font-normal text-3xs text-muted-foreground uppercase">
              required
            </span>
          ) : null}
        </span>
      </th>
      <td className="py-2 pr-3 whitespace-nowrap tabular-nums text-muted-foreground">
        {hostVersion(host)}
      </td>
      <td className="py-2 pr-3 whitespace-nowrap tabular-nums">{formatClock(host.askedAt)}</td>
      <td className="py-2 pr-3 whitespace-nowrap tabular-nums">{formatClock(host.ackedAt)}</td>
      <td className="py-2 pr-3 whitespace-nowrap tabular-nums">{formatClock(host.installedAt)}</td>
      <td className="py-2 pr-3 whitespace-nowrap tabular-nums">{formatClock(host.verifiedAt)}</td>
      <td className="py-2 pr-3 text-muted-foreground">{host.desktop ?? "—"}</td>
      <td className="py-2">
        <div className="flex min-w-48 flex-col items-start gap-0.5">
          <Chip tone={tone}>{HOST_STATE_LABELS[host.state]}</Chip>
          {host.reason ? (
            <span className="text-muted-foreground text-xs">{host.reason}</span>
          ) : null}
        </div>
      </td>
    </tr>
  );
}

/** One table per role: canary, then fleet. */
export function ReleaseHostTables({ hosts }: { hosts: ReadonlyArray<ReleaseRunHost> }) {
  const groups = releaseHostGroups(hosts);
  if (groups.length === 0) {
    return (
      <p className="text-muted-foreground text-sm">No machine has been asked to install it yet.</p>
    );
  }
  return (
    <div className="flex flex-col gap-4">
      {groups.map((group) => (
        <section key={group.role} className="min-w-0" data-host-group={group.role}>
          <h4 className="mb-1 font-medium text-sm">{group.label}</h4>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[44rem] text-sm">
              <thead>
                <tr className="text-left text-muted-foreground text-xs">
                  <th scope="col" className="pb-1 pr-3 font-medium">
                    Machine
                  </th>
                  <th scope="col" className="pb-1 pr-3 font-medium">
                    Version
                  </th>
                  <th scope="col" className="pb-1 pr-3 font-medium">
                    Asked
                  </th>
                  <th scope="col" className="pb-1 pr-3 font-medium">
                    Acked
                  </th>
                  <th scope="col" className="pb-1 pr-3 font-medium">
                    Installed
                  </th>
                  <th scope="col" className="pb-1 pr-3 font-medium">
                    Verified
                  </th>
                  <th scope="col" className="pb-1 pr-3 font-medium">
                    Desktop
                  </th>
                  <th scope="col" className="pb-1 font-medium">
                    State
                  </th>
                </tr>
              </thead>
              <tbody>
                {group.hosts.map((host) => (
                  <HostRow key={host.identity} host={host} />
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ))}
    </div>
  );
}

function RunHeader({ run }: { run: ReleaseRun }) {
  const counts = stageCounts(run);
  const summary = hostSummary(run.hosts);
  return (
    <header className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="font-semibold text-base">SpecWithCode {run.version}</h3>
        <Chip tone={runTone(run.state)}>{RUN_STATE_LABELS[run.state]}</Chip>
        <span className="rounded bg-muted px-1.5 py-0.5 text-muted-foreground text-xs">
          {run.channel}
        </span>
      </div>
      <p className="text-muted-foreground text-xs">
        {run.previous ? `From ${run.previous}. ` : ""}
        Started {formatWhen(run.startedAt)}
        {run.endedAt
          ? `, ended ${formatWhen(run.endedAt)}`
          : `, updated ${formatWhen(run.updatedAt)}`}
        {run.sha ? ` · ${run.sha.slice(0, 12)}` : ""}
        {run.resumes ? ` · resumed ${run.resumes}×` : ""}
      </p>
      <p className="text-sm" data-run-summary>
        {counts.passed} passed, {counts.running} running, {counts.failed} failed, {counts.pending}{" "}
        waiting
        {counts.skipped ? `, ${counts.skipped} skipped` : ""}
        {counts.absent ? `, ${counts.absent} not in this run` : ""}
        {summary ? `. ${summary}.` : "."}
      </p>
    </header>
  );
}

export function ReleasesView({
  runs,
  skipped,
  loading,
  failed,
  selectedRunId,
  onSelectRun,
  onRefresh,
  nowMs,
  timings,
  installs,
}: ReleasesViewProps) {
  const pickerId = useId();
  const run = selectedRun(runs, selectedRunId);
  return (
    <div className="flex min-w-0 flex-col gap-5" data-releases-view>
      <div className="flex flex-wrap items-end justify-between gap-3">
        {runs.length > 1 ? (
          <label htmlFor={pickerId} className="flex min-w-0 flex-col gap-1 text-xs">
            <span className="text-muted-foreground">Release run</span>
            <select
              id={pickerId}
              value={run?.runId ?? ""}
              onChange={(event) => onSelectRun(event.target.value)}
              className="h-8 max-w-full rounded-md border border-input bg-background px-2 text-sm"
            >
              {runs.map((entry) => (
                <option key={entry.runId} value={entry.runId}>
                  {entry.version} · {RUN_STATE_LABELS[entry.state]} · {formatWhen(entry.startedAt)}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <span />
        )}
        {onRefresh ? (
          <Button variant="outline" size="sm" onClick={onRefresh} disabled={loading}>
            <RefreshIcon size="sm" refreshing={loading} />
            Refresh
          </Button>
        ) : null}
      </div>
      {failed ? (
        <p role="alert" className="text-destructive-foreground text-sm">
          Could not read the release runs on this machine. They show again once it answers.
        </p>
      ) : null}
      {run === null ? (
        <p className="text-muted-foreground text-sm">
          {loading
            ? "Reading release runs…"
            : "No release has run on this machine yet. Each run of scripts/release/release.sh records its stages and machines here."}
        </p>
      ) : (
        <>
          <RunHeader run={run} />
          <section className="flex flex-col gap-2" aria-label="Stages">
            <h3 className="font-semibold text-sm">Stages</h3>
            <ReleaseStageGraph run={run} nowMs={nowMs} />
          </section>
          <section className="flex flex-col gap-2" aria-label="Machines">
            <h3 className="font-semibold text-sm">Machines</h3>
            <ReleaseHostTables hosts={run.hosts} />
          </section>
        </>
      )}
      {(loading || failed) && runs.length === 0 && timings === undefined ? null : (
        <ReleaseSpeed timings={releaseTimings(runs, timings, nowMs)} installs={installs} />
      )}
      {skipped > 0 ? (
        <p className="text-muted-foreground text-xs">
          {skipped} file{skipped === 1 ? "" : "s"} in the runs folder could not be read as a release
          run.
        </p>
      ) : null}
    </div>
  );
}
