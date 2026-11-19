/**
 * The automatic start of a hand off when a thread's track is out on this
 * machine (1390). A thread on a track falls back on this machine first: every
 * source of its model, then every later model of its track. Only when all of
 * that is out here is another machine asked, and only for the same track: the
 * machine answers with a sign-in of its own track and a reading taken for the
 * call, and nothing else qualifies it. When no machine has the track the
 * thread stays and names the earliest reset.
 *
 * Everything here is a pure rule. `MachineLimitHandoff` asks the machines and
 * moves the thread; the fallback sweep reads the track's state for its trigger.
 *
 * @module limitHandoffTrack
 */
import {
  type EnvironmentId,
  HANDOFF_TRACK_START_CAPABILITY,
  type HandoffPreflightFailure,
  hasHandoffTrackStart,
  type LimitHandoffTrackDecision,
  type LimitHandoffTrackMachine,
  MODEL_TRACK_LABELS,
  type ModelTrack,
  type OrchestrationV2ThreadShell,
  type ServerProvider,
  type ServerSettings,
  type ThreadId,
} from "@specweave-studio/contracts";
import type { MachineView } from "@specweave-studio/shared/machineFallback";
import {
  effectiveModelLanes,
  launchTrackLanes,
  TRACK_LANES,
} from "@specweave-studio/shared/modelTracks";
import { describeFallbackOrder, usageResetAt } from "@specweave-studio/shared/providerFallback";

import * as DateTime from "effect/DateTime";

import { checkAnswer, type PeerCheckEvidence } from "../handoff/handoffPlan.ts";
import { providerUsageSummary } from "../usage/providerUsageSummary.ts";

/** A wait with no reset time is checked again once the readings behind it are old. */
export const TRACK_RECHECK_UNKNOWN_MS = 15 * 60_000;
/** A machine that could not be asked is asked again this soon. */
export const TRACK_RECHECK_UNREACHED_MS = 2 * 60_000;
/** The transfer record's limit for a reason. */
const REASON_MAX = 120;
/** The most account pools one check names. */
const MAX_FINGERPRINTS = 16;

/** A track an automatic start can move a thread on. A review thread keeps its reviewer. */
export type StartTrack = Exclude<ModelTrack, "review">;

export type ThreadTrackState =
  /** Its project is not on tracks: the saved order decides, as before. */
  | { readonly kind: "none" }
  /** On tracks, and nothing starts by itself: its track is not known, or it is a review. */
  | { readonly kind: "held"; readonly reason: string }
  | {
      readonly kind: "track";
      readonly track: StartTrack;
      /** Every source of its model and every later model of the track is out here. */
      readonly outHere: boolean;
      /** The account pools the track ran out on here, on any provider. */
      readonly fingerprints: ReadonlyArray<string>;
      /** When the first of them has room again; null when none names a reset. */
      readonly earliestResetMs: number | null;
    };

type TrackThread = Pick<OrchestrationV2ThreadShell, "providerInstanceId" | "modelSelection"> &
  Partial<Pick<OrchestrationV2ThreadShell, "routing" | "usageLimitResetAt">>;

type TrackRule = Pick<
  ServerSettings,
  | "threadModelMode"
  | "modelLanes"
  | "defaultModelProviders"
  | "providerLimitExcludedModels"
  | "providerLimitSwitchAtPercent"
>;

const LANE_TRACKS = { routine: "daily", complex: "complex" } as const;

/** "Daily track out of tokens on M4": why an automatic start left, on both machines. */
export function trackOutReason(track: ModelTrack, machineLabel: string): string {
  return `${MODEL_TRACK_LABELS[track]} track out of tokens on ${machineLabel}`.slice(0, REASON_MAX);
}

/**
 * The thread's track and whether it is out on this machine. The track is the
 * routing decision's; with none, it is the one track that names the thread's
 * model, and a model on both or neither is never guessed.
 */
export function limitHandoffTrackState(input: {
  readonly thread: TrackThread;
  readonly rule: TrackRule;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly nowMs: number;
  /** Sources a current stop shows are limited, whatever their reading says. */
  readonly limited?: ReadonlySet<string> | undefined;
}): ThreadTrackState {
  const { thread, rule, providers, nowMs } = input;
  if (rule.threadModelMode !== "tracks") return { kind: "none" };
  const routing = thread.routing ?? null;
  if (routing?.reviewFamily !== undefined || routing?.taskClass === "review")
    return { kind: "held", reason: "A review thread stays with its reviewer." };
  const model = thread.modelSelection.model;
  let track: StartTrack;
  if (routing?.lane !== undefined) {
    track = LANE_TRACKS[routing.lane];
  } else {
    const lanes = effectiveModelLanes(rule.modelLanes, providers, rule.defaultModelProviders).lanes;
    const daily = lanes.routine.some((entry) => entry.model === model);
    const complex = lanes.complex.some((entry) => entry.model === model);
    if (daily === complex)
      return {
        kind: "held",
        reason: daily
          ? "Its model is on both the Daily and the Complex track, so its track is not known."
          : "Its model is on no track of this project.",
      };
    track = daily ? "daily" : "complex";
  }

  const entries = launchTrackLanes(rule.modelLanes, providers, rule.defaultModelProviders, nowMs)[
    TRACK_LANES[track]
  ];
  if (entries.length === 0)
    return { kind: "track", track, outHere: true, fingerprints: [], earliestResetMs: null };
  const threshold = rule.providerLimitSwitchAtPercent ?? 100;
  // The track's own entries and nothing else: no project default, no other track, no guess.
  const described = describeFallbackOrder({
    providers,
    currentInstanceId: thread.providerInstanceId,
    currentModel: model,
    rule: {
      providerLimitFallbackModels: entries,
      providerLimitFallbackModelSelection: null,
      providerLimitExcludedModels: rule.providerLimitExcludedModels,
      modelLanes: null,
      defaultModelProviders: rule.defaultModelProviders,
      defaultModelSelection: null,
    },
    nowMs,
    belowPercent: threshold,
    limitedInstanceIds: input.limited,
  });
  const fingerprints = new Set<string>();
  let earliestResetMs: number | null = null;
  const stopResetMs = Date.parse(thread.usageLimitResetAt ?? "");
  for (const entry of described) {
    if (entry.provider === undefined) continue;
    const spent =
      entry.unavailable === "current" ||
      entry.unavailable === "full" ||
      entry.unavailable === "limited";
    if (!spent) continue;
    const fingerprint = providerUsageSummary(entry.provider, nowMs).accountFingerprint;
    if (fingerprint !== null && fingerprints.size < MAX_FINGERPRINTS) fingerprints.add(fingerprint);
    const read =
      entry.resetAt ?? usageResetAt(entry.provider, threshold, nowMs, entry.selection.model);
    const resetMs =
      read ??
      (entry.unavailable === "current" && Number.isFinite(stopResetMs) ? stopResetMs : null);
    if (resetMs !== null && resetMs > nowMs)
      earliestResetMs = earliestResetMs === null ? resetMs : Math.min(earliestResetMs, resetMs);
  }
  return {
    kind: "track",
    track,
    outHere: described.every((entry) => entry.unavailable !== null),
    fingerprints: [...fingerprints],
    earliestResetMs,
  };
}

const needsTrackStart = (label: string, consequence: string) =>
  `Needs update: ${label} runs a SpecWithCode from before automatic track hand offs, so ${consequence}. Update SpecWithCode on ${label} first.`;

/**
 * The check an automatic track start fails for a machine that does not name
 * `handoff.track-start`. A hand off by hand, and a thread with no track, ask
 * nothing of it.
 */
export function trackStartCapabilityFailure(input: {
  readonly peerLabel: string;
  readonly capabilities: ReadonlyArray<string> | undefined;
  readonly start: "manual" | "automatic";
  /** The request names a track for at least one thread. */
  readonly tracked: boolean;
}): HandoffPreflightFailure | null {
  if (input.start !== "automatic" || !input.tracked) return null;
  if (hasHandoffTrackStart(input.capabilities)) return null;
  return {
    check: "version",
    message: needsTrackStart(input.peerLabel, "none is answered for it"),
  };
}

/** Why a machine cannot be asked at all, or null when it can. */
export function trackMachineReach(input: {
  readonly label: string;
  readonly machine: (MachineView & { readonly teamRulesRefused?: string | undefined }) | undefined;
  readonly projectTitle: string | null;
}): string | null {
  const { machine } = input;
  const at = (detail: string) => `${input.label}: ${detail}`;
  if (machine === undefined) return at("not paired");
  if (machine.teamRulesRefused !== undefined) return at(machine.teamRulesRefused);
  switch (machine.status) {
    case "unreachable":
      return at("offline");
    case "needs_grant":
      return at("no work grant");
    case "grant_revoked":
      return at("work grant revoked");
    case "grant_expired":
      return at("work grant expired");
    case "identity_mismatch":
      return at("pair again, its identity changed");
    case "unsupported":
      return at("update SpecWithCode there");
    default:
      break;
  }
  const project = input.projectTitle ?? "this project";
  if (machine.project?.match === "none") return at(`no work grant for ${project}`);
  if (machine.project?.match === "ambiguous") return at(`more than one project matches ${project}`);
  return null;
}

/** What a machine answered a track check with, or why it was not asked. */
export type TrackCheckAnswer =
  | Parameters<typeof checkAnswer>[0]["answer"]
  | { readonly kind: "unreachable"; readonly line: string };

export interface JudgedTrackMachine extends LimitHandoffTrackMachine {
  /** The sign-in the machine confirmed; set only for `room`. */
  readonly evidence: PeerCheckEvidence | null;
}

/**
 * One machine's place in an automatic track start. It has room only when it
 * names the track start, listed no failure, and confirmed a sign-in whose
 * reading qualifies an automatic move. A sign-in on the same depleted pool,
 * unknown or stale usage, and a machine with nothing on the track are `out`.
 * A machine that could not be asked, needs an update or cannot take the
 * project is none of those, and is never read as out.
 */
export function judgeTrackMachine(input: {
  readonly environmentId: EnvironmentId;
  readonly machineLabel: string;
  readonly threadId: ThreadId;
  readonly answer: TrackCheckAnswer;
}): JudgedTrackMachine {
  const { answer } = input;
  const label =
    answer.kind === "answered"
      ? answer.response.machineLabel || input.machineLabel
      : input.machineLabel;
  const row = (
    state: LimitHandoffTrackMachine["state"],
    line: string,
    evidence: PeerCheckEvidence | null = null,
    resetsAt: string | null = null,
  ): JudgedTrackMachine => ({
    environmentId: input.environmentId,
    machineLabel: label,
    state,
    line,
    resetsAt,
    evidence,
  });
  if (answer.kind === "unreachable") return row("unreachable", answer.line);
  const check = checkAnswer({ peerLabel: label, threadId: input.threadId, answer });
  if (check.kind === "needs-update") return row("needs-update", check.message);
  if (check.kind !== "checked")
    return row("error", check.kind === "error" ? check.message : `${label}: not checked`);
  if (answer.kind === "answered" && !hasHandoffTrackStart(answer.response.capabilities))
    return row("needs-update", needsTrackStart(label, "no thread is sent there by itself"));
  const { failures, evidence } = check;
  if (failures.length === 0 && evidence?.automatic === true)
    return row("room", `${label}: ${evidence.line}`, evidence, evidence.resetsAt);
  // Anything but the sign-in or the track is a reason the machine cannot take the thread at all.
  const blocking = failures.filter(
    (failure) => failure.check !== "provider" && failure.check !== "model",
  );
  if (blocking.length > 0)
    return row("error", blocking.map((failure) => failure.message).join(" "));
  return row(
    "out",
    failures[0]?.message ?? `${label}: ${evidence?.line ?? "no sign-in on the track has room"}`,
    null,
    evidence?.resetsAt ?? null,
  );
}

const isoAt = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));

/**
 * The decision for one thread once the machines answered: the target chosen,
 * or why it stays. "Out on every machine" needs every machine to have
 * answered with no room. The earliest reset is the first future one this
 * machine or an out machine names. The machines are asked again at that
 * reset; with none known, once the readings are old; and sooner while one
 * could not be asked.
 */
export function trackDecision(input: {
  readonly threadId: ThreadId;
  readonly track: ModelTrack;
  /** This machine. */
  readonly machineLabel: string;
  readonly outHere: boolean;
  /** When the track has room on this machine again, if known. */
  readonly localResetMs: number | null;
  readonly machines: ReadonlyArray<JudgedTrackMachine>;
  readonly target: LimitHandoffTrackDecision["target"];
  readonly nowMs: number;
}): LimitHandoffTrackDecision {
  const { nowMs } = input;
  const everyMachineOut =
    input.target === null &&
    input.outHere &&
    input.machines.every((machine) => machine.state === "out");
  const resets = [
    { machineLabel: input.machineLabel, ms: input.localResetMs ?? Number.NaN },
    ...input.machines
      .filter((machine) => machine.state === "out")
      .map((machine) => ({
        machineLabel: machine.machineLabel,
        ms: machine.resetsAt === null ? Number.NaN : Date.parse(machine.resetsAt),
      })),
  ].filter((reset) => Number.isFinite(reset.ms) && reset.ms > nowMs);
  const first = resets.reduce<(typeof resets)[number] | null>(
    (earliest, reset) => (earliest === null || reset.ms < earliest.ms ? reset : earliest),
    null,
  );
  const earliestReset =
    input.target !== null || first === null
      ? null
      : { machineLabel: first.machineLabel, at: isoAt(first.ms) };
  const recheckAt =
    input.target !== null
      ? null
      : !everyMachineOut
        ? isoAt(nowMs + TRACK_RECHECK_UNREACHED_MS)
        : (earliestReset?.at ?? isoAt(nowMs + TRACK_RECHECK_UNKNOWN_MS));
  return {
    threadId: input.threadId,
    track: input.track,
    machineLabel: input.machineLabel,
    trackOut: input.outHere,
    reason: trackOutReason(input.track, input.machineLabel),
    target: input.target,
    everyMachineOut,
    earliestReset,
    recheckAt,
    machines: input.machines.map(({ evidence: _evidence, ...machine }) => machine),
    decidedAt: isoAt(nowMs),
  };
}

export { HANDOFF_TRACK_START_CAPABILITY };
