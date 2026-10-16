/**
 * Claude Code subscription usage. Both sources produce windows with the same
 * ids so a turn-driven `rate_limit_event` lands on the row the SDK's
 * `get_usage` read established:
 *
 * - `get_usage` (on demand, during the capabilities probe) reports every
 *   window at once as 0–100 percentages with ISO reset times.
 * - `rate_limit_event` (streamed during a turn) names one window at a time
 *   with a 0–1 utilization fraction and an epoch-seconds reset.
 *
 * @module provider/claudeUsageLimits
 */
import type { SDKControlGetUsageResponse, SDKRateLimitInfo } from "@anthropic-ai/claude-agent-sdk";
import type {
  ProviderUsageLimitsUpdate,
  ServerProviderUsageLimits,
  ServerProviderUsageWindow,
} from "@specweave-studio/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

import {
  clampPercent,
  makeUnavailableUsageLimits,
  makeUsageLimits,
} from "./providerUsageLimits.ts";

const SESSION_MINS = 5 * 60;
const WEEK_MINS = 7 * 24 * 60;

/**
 * The account-wide windows, keyed by the SDK's `rateLimitType`. Model-scoped
 * weeklies are additive on top of these: the CLI reports them under
 * `rate_limits.model_scoped[]` on `get_usage` and streams the overage-included
 * model bucket (Fable today) as `seven_day_overage_included`.
 */
const WINDOWS: Readonly<
  Record<string, Pick<ServerProviderUsageWindow, "kind" | "label" | "windowDurationMins">>
> = {
  five_hour: { kind: "session", label: "Session", windowDurationMins: SESSION_MINS },
  seven_day: { kind: "weekly", label: "Weekly", windowDurationMins: WEEK_MINS },
};

/**
 * The streamed event names the overage-included bucket by type
 * (`seven_day_overage_included`), while `get_usage` names it by the model's
 * `display_name`. Which model that is changes over time, so the probe records
 * the name it saw and the event mapper reuses it; the mid-turn update then
 * lands on the row the probe drew instead of opening a second one.
 */
const OVERAGE_INCLUDED_EVENT_TYPE = "seven_day_overage_included";

export interface ClaudeScopedLimitNames {
  readonly overageIncluded: string | undefined;
}

export const makeClaudeScopedLimitNames = Ref.make<ClaudeScopedLimitNames>({
  overageIncluded: undefined,
});

function scopedWindowId(displayName: string): string {
  return `seven_day_${displayName.toLowerCase().replace(/[^a-z0-9]+/g, "_")}`;
}

function scopedWindow(
  displayName: string,
  usedPercent: number,
  resetsAt: string | undefined,
): ServerProviderUsageWindow {
  return {
    id: scopedWindowId(displayName),
    kind: "weekly",
    label: `Weekly · ${displayName}`,
    windowDurationMins: WEEK_MINS,
    modelScope: displayName,
    usedPercent: clampPercent(usedPercent),
    ...(resetsAt ? { resetsAt } : {}),
  };
}

/**
 * `model_scoped` shipped in the CLI after the SDK typings we pin, so it is
 * read structurally until the `.d.ts` catches up.
 */
interface ModelScopedWindow {
  readonly display_name: string;
  readonly utilization: number | null;
  readonly resets_at: string | null;
}

function readModelScoped(rateLimits: object): ReadonlyArray<ModelScopedWindow> {
  const raw = (rateLimits as { readonly model_scoped?: unknown }).model_scoped;
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (entry): entry is ModelScopedWindow =>
      typeof entry === "object" &&
      entry !== null &&
      typeof (entry as ModelScopedWindow).display_name === "string" &&
      (entry as ModelScopedWindow).display_name.trim().length > 0,
  );
}

function isoFromEpochSeconds(value: number | undefined): string | undefined {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return undefined;
  const dt = DateTime.make(value * 1000);
  return Option.isSome(dt) ? DateTime.formatIso(dt.value) : undefined;
}

function isoFromString(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  const dt = DateTime.make(value);
  return Option.isSome(dt) ? DateTime.formatIso(dt.value) : undefined;
}

function malformedUsageWindow(utilization: unknown, resetsAt: unknown): boolean {
  return (
    (utilization != null &&
      (typeof utilization !== "number" ||
        !Number.isFinite(utilization) ||
        utilization < 0 ||
        utilization > 100)) ||
    (resetsAt != null && (typeof resetsAt !== "string" || isoFromString(resetsAt) === undefined))
  );
}

function makeWindow(
  id: keyof typeof WINDOWS & string,
  usedPercent: number,
  resetsAt: string | undefined,
): ServerProviderUsageWindow {
  const window = WINDOWS[id]!;
  return {
    id,
    ...window,
    usedPercent: clampPercent(usedPercent),
    ...(resetsAt ? { resetsAt } : {}),
  };
}

/** A complete current Claude read can permit a manual retry, never automatic usage. */
export function completeClaudeUsageWindows(
  windows: ReadonlyArray<ServerProviderUsageWindow>,
  now: number,
): boolean {
  const ids = new Set(windows.map((entry) => entry.id));
  return (
    Number.isFinite(now) &&
    ids.size === windows.length &&
    windows.some((entry) => entry.id === "five_hour" && entry.kind === "session") &&
    windows.some((entry) => entry.id === "seven_day" && entry.kind === "weekly") &&
    windows.every(
      (entry) =>
        Number.isFinite(entry.usedPercent) &&
        entry.usedPercent >= 0 &&
        entry.usedPercent < 100 &&
        // An unused session has no reset yet; all other windows need a future reset.
        ((entry.id === "five_hour" &&
          entry.kind === "session" &&
          entry.usedPercent === 0 &&
          entry.resetsAt == null) ||
          (Number.isFinite(Date.parse(entry.resetsAt ?? "")) && Date.parse(entry.resetsAt!) > now)),
    )
  );
}

/**
 * Utilization is a 0–1 fraction on the streamed event. An overage-included
 * event before any probe has named the bucket is dropped: guessing a name
 * would draw a row the next probe cannot reconcile.
 */
export function claudeRateLimitEventToUpdate(
  info: SDKRateLimitInfo,
  names: ClaudeScopedLimitNames,
): ProviderUsageLimitsUpdate | undefined {
  const overage = info as SDKRateLimitInfo & { readonly overageInUse?: boolean };
  const overageAllowed =
    info.overageStatus === "allowed" ||
    info.overageStatus === "allowed_warning" ||
    info.isUsingOverage === true ||
    overage.overageInUse === true;
  const denial =
    info.status === "rejected" && !overageAllowed
      ? {
          ordinaryUsageAllowed: false as const,
          nativeDenialRequiresFullRead: true as const,
          rateLimitReachedType: "rate_limit_reached",
        }
      : undefined;
  const type: string | undefined = info.rateLimitType;
  const resetsAt = isoFromEpochSeconds(info.resetsAt);
  if (
    !type ||
    typeof info.utilization !== "number" ||
    !Number.isFinite(info.utilization) ||
    info.utilization < 0 ||
    info.utilization > 1 ||
    (info.resetsAt !== undefined && resetsAt === undefined)
  ) {
    return denial ? { windows: [], ...denial } : undefined;
  }
  const usedPercent = info.utilization * 100;
  if (type in WINDOWS) {
    return { windows: [makeWindow(type, usedPercent, resetsAt)], ...denial };
  }
  if (type === OVERAGE_INCLUDED_EVENT_TYPE && names.overageIncluded) {
    return { windows: [scopedWindow(names.overageIncluded, usedPercent, resetsAt)], ...denial };
  }
  return denial ? { windows: [], ...denial } : undefined;
}

/**
 * Percentages on the `get_usage` response are already 0–100. Also yields the
 * scoped-bucket names the response carried, for the event mapper to reuse.
 */
export function claudeUsageResponseToLimits(input: {
  readonly response: Pick<SDKControlGetUsageResponse, "rate_limits_available" | "rate_limits">;
  readonly checkedAt: string;
}): { readonly limits: ServerProviderUsageLimits; readonly names: ClaudeScopedLimitNames } {
  const { response, checkedAt } = input;
  // Availability describes whether plan limits apply. The SDK also returns
  // true/null when applicable limits could not be read; neither case observes
  // quota or grants permission. Missing fields are not the documented null.
  if (typeof response.rate_limits_available === "boolean" && response.rate_limits === null) {
    return {
      limits: makeUnavailableUsageLimits({ checkedAt, reason: "unsupported" }),
      names: { overageIncluded: undefined },
    };
  }
  // Missing or contradictory fields are malformed evidence, not a valid
  // unavailable lookup. In particular false with windows is contradictory.
  if (
    response.rate_limits_available !== true ||
    response.rate_limits === null ||
    typeof response.rate_limits !== "object" ||
    Array.isArray(response.rate_limits)
  ) {
    return {
      limits: {
        checkedAt,
        windows: [],
        unavailable: { reason: "probeFailed", invalidResponse: true },
      },
      names: { overageIncluded: undefined },
    };
  }
  const windows: ServerProviderUsageWindow[] = [];
  let invalidEvidence = false;
  for (const id of Object.keys(WINDOWS)) {
    const window = response.rate_limits[id as "five_hour" | "seven_day"];
    if (!window || typeof window.utilization !== "number") {
      invalidEvidence = true;
      continue;
    }
    invalidEvidence ||= malformedUsageWindow(window.utilization, window.resets_at);
    windows.push(makeWindow(id, window.utilization, isoFromString(window.resets_at)));
  }
  // The CLI filters `model_scoped` to the overage-included allowlist, which
  // today holds one model; the first entry is the one the event refers to.
  let overageIncluded: string | undefined;
  const scopedInput = (response.rate_limits as { readonly model_scoped?: unknown }).model_scoped;
  const scopedEntries = readModelScoped(response.rate_limits);
  if (
    scopedInput != null &&
    (!Array.isArray(scopedInput) || scopedEntries.length !== scopedInput.length)
  ) {
    invalidEvidence = true;
  }
  for (const entry of scopedEntries) {
    invalidEvidence ||= malformedUsageWindow(entry.utilization, entry.resets_at);
    if (typeof entry.utilization !== "number") {
      invalidEvidence = true;
      continue;
    }
    windows.push(
      scopedWindow(entry.display_name, entry.utilization, isoFromString(entry.resets_at)),
    );
    // Only a bucket that drew a row may receive events; naming one that was
    // skipped would let a mid-turn event open a row the probe never showed.
    overageIncluded ??= entry.display_name;
  }
  return {
    limits: {
      ...makeUsageLimits({ checkedAt, windows }),
      // Display normalization must not turn malformed/unknown input into
      // evidence of an unused subscription window for admission decisions.
      ...(invalidEvidence
        ? { unavailable: { reason: "probeFailed" as const, invalidResponse: true as const } }
        : {}),
      // Only a later complete valid read can reconcile a streamed rejection.
      // This witness does not assert ordinaryUsageAllowed or grant credits.
      ...(!invalidEvidence && completeClaudeUsageWindows(windows, Date.parse(checkedAt))
        ? { nativeAllowanceObservedAt: checkedAt }
        : {}),
    },
    names: { overageIncluded },
  };
}

/** Probe-side helper: map the response and remember the scoped names for events. */
export const recordClaudeUsageResponse = (
  namesRef: Ref.Ref<ClaudeScopedLimitNames>,
  input: Parameters<typeof claudeUsageResponseToLimits>[0],
): Effect.Effect<ServerProviderUsageLimits> => {
  const { limits, names } = claudeUsageResponseToLimits(input);
  return Ref.set(namesRef, names).pipe(Effect.as(limits));
};
