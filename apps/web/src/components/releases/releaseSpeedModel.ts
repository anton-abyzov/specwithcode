import {
  releaseRunTiming,
  type ReleaseInstallTiming,
  type ReleaseRun,
  type ReleaseRunTiming,
} from "@specweave-studio/contracts";

import { formatSeconds, stageName } from "./releaseRunModel";

/**
 * Speed by version: how long each version's release and its install on this
 * machine took, against the version before. Pure; the view only lays it out.
 */

/** Versions listed, newest first. */
export const SPEED_VERSIONS = 6;
/**
 * A change counts as slower or faster past both of these, the thresholds
 * scripts/release/release_tools.py `timing compare` marks SLOWER with: a 2 s
 * stage taking 3 s is no regression.
 */
export const SPEED_CHANGE_PERCENT = 25;
export const SPEED_CHANGE_MIN_SECONDS = 10;

export type SpeedVerdict = "slower" | "faster" | "same";

export interface SpeedDelta {
  readonly seconds: number;
  /** Null when the earlier time was 0. */
  readonly percent: number | null;
  readonly verdict: SpeedVerdict;
}

export function speedDelta(now: number, then: number): SpeedDelta {
  const seconds = now - then;
  const percent = then > 0 ? (100 * seconds) / then : null;
  const past = Math.abs(seconds) >= SPEED_CHANGE_MIN_SECONDS;
  let verdict: SpeedVerdict = "same";
  if (past && seconds > 0 && (percent === null || percent > SPEED_CHANGE_PERCENT))
    verdict = "slower";
  else if (past && seconds < 0 && percent !== null && percent < -SPEED_CHANGE_PERCENT)
    verdict = "faster";
  return { seconds, percent, verdict };
}

/** "+1m 05s", "−12s", "±0s". */
export function formatSignedSeconds(seconds: number): string {
  const rounded = Math.round(seconds);
  if (rounded === 0) return "±0s";
  return `${rounded > 0 ? "+" : "−"}${formatSeconds(Math.abs(rounded))}`;
}

/** "+16%", "−40%"; null without a percentage. */
export function formatPercent(percent: number | null): string | null {
  if (percent === null || !Number.isFinite(percent)) return null;
  const rounded = Math.round(percent);
  if (rounded === 0) return "±0%";
  return `${rounded > 0 ? "+" : "−"}${Math.abs(rounded)}%`;
}

export interface SpeedPart {
  readonly id: string;
  readonly name: string;
  readonly seconds: number | null;
  readonly previousSeconds: number | null;
  readonly delta: SpeedDelta | null;
}

export interface SpeedRow {
  readonly version: string;
  /** The run or install the row reads. */
  readonly key: string;
  readonly at: string;
  readonly totalSeconds: number | null;
  /** The version this row is compared with; null for the oldest, or when nothing older finished. */
  readonly previousVersion: string | null;
  readonly delta: SpeedDelta | null;
  readonly slowest: SpeedPart | null;
  readonly parts: ReadonlyArray<SpeedPart>;
  readonly slower: ReadonlyArray<SpeedPart>;
  readonly faster: ReadonlyArray<SpeedPart>;
}

export interface ReleaseSpeedRow extends SpeedRow {
  readonly state: ReleaseRunTiming["state"];
  readonly channel: string;
  /**
   * Start to end of the run as its record has them, pauses before a resume
   * included; null while it runs. `totalSeconds` is stage time, which leaves
   * those pauses out and counts stages that ran side by side once.
   */
  readonly wallSeconds: number | null;
}

/** Start to end of a finished run, in whole seconds; null without both. */
export function releaseWallSeconds(timing: ReleaseRunTiming): number | null {
  const started = Date.parse(timing.startedAt);
  const ended = Date.parse(timing.endedAt ?? "");
  if (!Number.isFinite(started) || !Number.isFinite(ended) || ended < started) return null;
  return Math.round((ended - started) / 1000);
}

const deltaOf = (now: number | null, then: number | null) =>
  now === null || then === null ? null : speedDelta(now, then);

function compareParts(
  parts: ReadonlyArray<Omit<SpeedPart, "previousSeconds" | "delta">>,
  previous: ReadonlyMap<string, number | null> | null,
): ReadonlyArray<SpeedPart> {
  return parts.map((part) => {
    const previousSeconds = previous?.get(part.id) ?? null;
    return { ...part, previousSeconds, delta: deltaOf(part.seconds, previousSeconds) };
  });
}

function slowestOf(parts: ReadonlyArray<SpeedPart>): SpeedPart | null {
  let slowest: SpeedPart | null = null;
  for (const part of parts) {
    if (part.seconds !== null && (slowest === null || part.seconds > (slowest.seconds ?? 0)))
      slowest = part;
  }
  return slowest;
}

const byChange = (left: SpeedPart, right: SpeedPart) =>
  Math.abs(right.delta?.seconds ?? 0) - Math.abs(left.delta?.seconds ?? 0);

function finish<T extends Omit<SpeedRow, "slowest" | "slower" | "faster">>(row: T) {
  return {
    ...row,
    slowest: slowestOf(row.parts),
    slower: row.parts.filter((part) => part.delta?.verdict === "slower").sort(byChange),
    faster: row.parts.filter((part) => part.delta?.verdict === "faster").sort(byChange),
  };
}

/** The timings the server sent, else (a server from before them) the runs' own. */
export function releaseTimings(
  runs: ReadonlyArray<ReleaseRun>,
  timings: ReadonlyArray<ReleaseRunTiming> | undefined,
  nowMs: number,
): ReadonlyArray<ReleaseRunTiming> {
  return timings ?? runs.map((run) => releaseRunTiming(run, nowMs));
}

/**
 * One row per version, newest first: its newest released run, else its newest
 * run of any state. A row is compared with the newest released run of an older
 * version on the same channel, started the same way (release.sh on a machine,
 * or the release.yml graph in CI): the candidate channel has stages the github
 * one does not, and a CI run shards what a local one runs in one go. A stage is
 * compared only when it passed in both, the total only when both runs were
 * released, so a run still going never reads as faster.
 */
export function releaseSpeedRows(
  timings: ReadonlyArray<ReleaseRunTiming>,
  limit = SPEED_VERSIONS,
): ReadonlyArray<ReleaseSpeedRow> {
  const newest = [...timings].sort(
    (left, right) =>
      right.startedAt.localeCompare(left.startedAt) || right.runId.localeCompare(left.runId),
  );
  const byVersion = new Map<string, ReleaseRunTiming>();
  for (const timing of newest) {
    const kept = byVersion.get(timing.version);
    if (!kept || (kept.state !== "done" && timing.state === "done"))
      byVersion.set(timing.version, timing);
  }
  const chosen = [...byVersion.values()].sort(
    (left, right) =>
      newest.findIndex((timing) => timing.version === left.version) -
      newest.findIndex((timing) => timing.version === right.version),
  );
  return chosen.slice(0, limit).map((timing) => {
    const previous =
      newest.find(
        (entry) =>
          entry.state === "done" &&
          entry.version !== timing.version &&
          entry.channel === timing.channel &&
          entry.createdBy === timing.createdBy &&
          entry.startedAt < timing.startedAt,
      ) ?? null;
    const passed = (entry: ReleaseRunTiming) =>
      new Map(
        entry.stages.map((stage) => [stage.id, stage.state === "passed" ? stage.seconds : null]),
      );
    const parts = timing.stages
      .filter((stage) => stage.seconds !== null)
      .map((stage) => ({
        id: stage.id,
        name: stageName(stage.id, timing.channel),
        seconds: stage.seconds,
      }));
    const mine = passed(timing);
    const compared = compareParts(parts, previous ? passed(previous) : null).map((part) =>
      mine.get(part.id) === null ? { ...part, delta: null } : part,
    );
    return finish({
      version: timing.version,
      key: timing.runId,
      at: timing.startedAt,
      state: timing.state,
      channel: timing.channel,
      totalSeconds: timing.totalSeconds,
      wallSeconds: releaseWallSeconds(timing),
      previousVersion: previous?.version ?? null,
      delta:
        timing.state === "done" && previous
          ? deltaOf(timing.totalSeconds, previous.totalSeconds)
          : null,
      parts: compared,
    });
  });
}

/** `serviceStop` reads "Service stop". */
export function phaseName(phase: string): string {
  const words = phase.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

const seconds = (ms: number) => Math.round(ms / 1000);

/** One row per version installed on this machine, newest first, each against the install before. */
export function installSpeedRows(
  installs: ReadonlyArray<ReleaseInstallTiming>,
  limit = SPEED_VERSIONS,
): ReadonlyArray<SpeedRow> {
  const newest = [...installs].sort((left, right) =>
    right.installedAt.localeCompare(left.installedAt),
  );
  const chosen: ReleaseInstallTiming[] = [];
  for (const install of newest) {
    if (!chosen.some((entry) => entry.version === install.version)) chosen.push(install);
  }
  const phasesOf = (install: ReleaseInstallTiming) =>
    Object.entries(install.phases ?? {}).map(([id, ms]) => ({
      id,
      name: phaseName(id),
      seconds: seconds(ms),
    }));
  return chosen.slice(0, limit).map((install, index) => {
    const previous = chosen[index + 1] ?? null;
    const before = previous
      ? new Map(phasesOf(previous).map((part) => [part.id, part.seconds] as const))
      : null;
    return finish({
      version: install.version,
      key: `${install.version}@${install.installedAt}`,
      at: install.installedAt,
      totalSeconds: seconds(install.totalMs),
      previousVersion: previous?.version ?? null,
      delta: previous ? speedDelta(seconds(install.totalMs), seconds(previous.totalMs)) : null,
      parts: compareParts(phasesOf(install), before),
    });
  });
}
