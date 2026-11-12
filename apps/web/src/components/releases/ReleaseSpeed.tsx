import type { ReleaseInstallTiming, ReleaseRunTiming } from "@specweave-studio/contracts";
import { ArrowDownIcon, ArrowUpIcon } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "../../lib/utils";
import {
  RUN_STATE_LABELS,
  TONE_STYLES,
  formatSeconds,
  formatWhen,
  runTone,
} from "./releaseRunModel";
import {
  SPEED_CHANGE_MIN_SECONDS,
  SPEED_CHANGE_PERCENT,
  formatPercent,
  formatSignedSeconds,
  installSpeedRows,
  releaseSpeedRows,
  type SpeedDelta,
  type SpeedPart,
  type SpeedRow,
} from "./releaseSpeedModel";

function Delta({ delta, compact = false }: { delta: SpeedDelta | null; compact?: boolean }) {
  if (delta === null) return <span className="text-muted-foreground">—</span>;
  const percent = formatPercent(delta.percent);
  const tone =
    delta.verdict === "slower" ? "danger" : delta.verdict === "faster" ? "success" : "muted";
  return (
    <span
      data-verdict={delta.verdict}
      className={cn(
        "inline-flex items-center justify-end gap-0.5 whitespace-nowrap tabular-nums",
        delta.verdict === "same" ? "text-muted-foreground" : TONE_STYLES[tone].text,
        delta.verdict !== "same" && "font-medium",
      )}
    >
      {delta.verdict === "slower" ? (
        <ArrowUpIcon aria-hidden className="size-3" />
      ) : delta.verdict === "faster" ? (
        <ArrowDownIcon aria-hidden className="size-3" />
      ) : null}
      {formatSignedSeconds(delta.seconds)}
      {percent && !compact ? <span className="font-normal opacity-80">({percent})</span> : null}
      {delta.verdict !== "same" ? (
        <span className="sr-only">{delta.verdict === "slower" ? " slower" : " faster"}</span>
      ) : null}
    </span>
  );
}

const changeList = (parts: ReadonlyArray<SpeedPart>) =>
  parts
    .slice(0, 3)
    .map((part) => `${part.name} ${formatSignedSeconds(part.delta?.seconds ?? 0)}`)
    .join(", ") + (parts.length > 3 ? `, ${parts.length - 3} more` : "");

function RowSummary({ row, partLabel }: { row: SpeedRow; partLabel: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-1 text-xs">
      {row.slowest ? (
        <span className="text-muted-foreground">
          Slowest {partLabel}:{" "}
          <span className="text-foreground">
            {row.slowest.name} {formatSeconds(row.slowest.seconds ?? 0)}
          </span>
        </span>
      ) : null}
      {row.slower.length > 0 ? (
        <span className={TONE_STYLES.danger.text} data-speed-slower>
          Slower: {changeList(row.slower)}
        </span>
      ) : null}
      {row.faster.length > 0 ? (
        <span className={TONE_STYLES.success.text} data-speed-faster>
          Faster: {changeList(row.faster)}
        </span>
      ) : null}
    </div>
  );
}

function PartsTable({ row, partLabel }: { row: SpeedRow; partLabel: string }) {
  return (
    <table className="w-full table-fixed text-xs">
      <thead>
        <tr className="text-left text-muted-foreground">
          <th scope="col" className="pb-1 pr-2 font-medium">
            {partLabel === "stage" ? "Stage" : "Phase"}
          </th>
          <th scope="col" className="w-20 pb-1 pr-2 text-right font-medium">
            Took
          </th>
          <th scope="col" className="w-32 pb-1 text-right font-medium">
            {row.previousVersion ? `vs ${row.previousVersion}` : "Change"}
          </th>
        </tr>
      </thead>
      <tbody>
        {row.parts.map((part) => (
          <tr
            key={part.id}
            data-speed-part={part.id}
            data-verdict={part.delta?.verdict ?? "none"}
            className="border-border border-t"
          >
            <th scope="row" className="py-1 pr-2 text-left font-normal break-words">
              {part.name}
              {row.slowest?.id === part.id ? (
                <span className="ml-1.5 rounded bg-muted px-1 text-3xs text-muted-foreground uppercase">
                  slowest
                </span>
              ) : null}
            </th>
            <td className="py-1 pr-2 text-right tabular-nums">
              {part.seconds === null ? "—" : formatSeconds(part.seconds)}
            </td>
            <td className="py-1 text-right">
              <Delta delta={part.delta} compact />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function SpeedRowItem({
  row,
  partLabel,
  open,
  badge,
}: {
  row: SpeedRow;
  partLabel: "stage" | "phase";
  open: boolean;
  badge?: ReactNode;
}) {
  return (
    <li className="min-w-0 border-border border-t first:border-t-0">
      <details open={open} className="group min-w-0" data-speed-version={row.version}>
        <summary className="flex min-w-0 cursor-pointer list-none flex-col gap-1 py-2 outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
          <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto_auto] items-baseline gap-x-3">
            <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
              <span className="font-medium text-sm tabular-nums">{row.version}</span>
              {badge}
              <span className="text-muted-foreground text-xs">{formatWhen(row.at)}</span>
            </span>
            <span className="text-right font-medium text-sm tabular-nums" data-speed-total>
              {row.totalSeconds === null ? "—" : formatSeconds(row.totalSeconds)}
            </span>
            <span className="w-32 text-right text-xs" data-speed-delta>
              <Delta delta={row.delta} />
            </span>
          </div>
          <RowSummary row={row} partLabel={partLabel} />
        </summary>
        {row.parts.length > 0 ? (
          <div className="pb-3">
            <PartsTable row={row} partLabel={partLabel} />
          </div>
        ) : null}
      </details>
    </li>
  );
}

function SpeedHeader({ first, last }: { first: string; last: string }) {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto_auto] gap-x-3 pb-1 text-muted-foreground text-xs">
      <span>{first}</span>
      <span className="text-right">{last}</span>
      <span className="w-32 text-right">Change</span>
    </div>
  );
}

export interface ReleaseSpeedProps {
  readonly timings: ReadonlyArray<ReleaseRunTiming>;
  /** Undefined when the server sends none: one from before install timings. */
  readonly installs: ReadonlyArray<ReleaseInstallTiming> | undefined;
}

/**
 * Speed by version: each version's release time and stages, its install time
 * on this machine, and both against the version before.
 */
export function ReleaseSpeed({ timings, installs }: ReleaseSpeedProps) {
  const releases = releaseSpeedRows(timings);
  const installed = installSpeedRows(installs ?? []);
  return (
    <section
      className="flex min-w-0 flex-col gap-3"
      aria-label="Speed by version"
      data-release-speed
    >
      <div className="flex flex-col gap-0.5">
        <h3 className="font-semibold text-sm">Speed by version</h3>
        <p className="text-muted-foreground text-xs">
          Times in hours, minutes and seconds. Change is against the newest earlier version, named
          in each table; <span className={TONE_STYLES.danger.text}>slower</span> or{" "}
          <span className={TONE_STYLES.success.text}>faster</span> is marked past{" "}
          {SPEED_CHANGE_PERCENT}% and {SPEED_CHANGE_MIN_SECONDS}s.
        </p>
      </div>
      {releases.length === 0 && installed.length === 0 ? (
        <p className="text-muted-foreground text-sm" data-speed-empty>
          No timings on this machine yet. Each release and each update install adds one.
        </p>
      ) : null}
      {releases.length > 0 ? (
        <div className="min-w-0" data-speed-releases>
          <h4 className="mb-1 font-medium text-sm">Release</h4>
          <p className="mb-1 text-muted-foreground text-xs">
            The time stages ran, waits before a resume left out.
          </p>
          <SpeedHeader first="Version" last="Took" />
          <ul className="min-w-0">
            {releases.map((row, index) => (
              <SpeedRowItem
                key={row.key}
                row={row}
                partLabel="stage"
                open={index === 0}
                badge={
                  row.state === "done" ? null : (
                    <span
                      className={cn(
                        "rounded px-1 text-3xs uppercase",
                        TONE_STYLES[runTone(row.state)].chip,
                      )}
                    >
                      {RUN_STATE_LABELS[row.state]}
                    </span>
                  )
                }
              />
            ))}
          </ul>
        </div>
      ) : null}
      {releases.length > 0 || installed.length > 0 ? (
        <div className="min-w-0" data-speed-installs>
          <h4 className="mb-1 font-medium text-sm">Install on this machine</h4>
          {installed.length > 0 ? (
            <>
              <p className="mb-1 text-muted-foreground text-xs">
                From the start of the install to the new version verified.
              </p>
              <SpeedHeader first="Version" last="Took" />
              <ul className="min-w-0">
                {installed.map((row) => (
                  <SpeedRowItem key={row.key} row={row} partLabel="phase" open={false} />
                ))}
              </ul>
            </>
          ) : (
            <p className="text-muted-foreground text-xs">
              {installs === undefined
                ? "This machine's service does not report install times yet; it does from the next update."
                : "No verified update install recorded on this machine yet."}
            </p>
          )}
        </div>
      ) : null}
    </section>
  );
}
