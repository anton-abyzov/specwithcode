/**
 * What the model picker says while a thread runs on a fallback, in one place:
 * the model running now, the model the thread was meant to use and why it is
 * not, how and when it goes back, and the fallback order. The thread banner
 * used to offer the same way back; the picker is now its only control.
 */
import type { FallbackOrderUnavailable } from "@specweave-studio/shared/providerFallback";
import {
  PRESWITCH_RETURN_BLOCK_REASON,
  type PreswitchReturnBlock,
} from "@specweave-studio/shared/preswitchReturn";
import { preswitchFallbackDetail, type LimitPairingRoomUnknown } from "./UsageLimitRecoveryBanner";

/** One step of the fallback order as the picker lists it. */
export type FallbackChainEntry = {
  readonly instanceId: string;
  readonly model: string;
  /** `GPT-6-Astra · Codex`. */
  readonly label: string;
  /** `pick` is the model the thread was meant to use; `now` is the one running. */
  readonly role: "pick" | "now" | null;
  /** 1-based place in the user's fallback order; null for a pick or a model outside it. */
  readonly position: number | null;
  /** Why this step cannot take the thread now: `full`, `signed out`. */
  readonly note: string | null;
};

export type ModelStateHeader = {
  title: string;
  /** One sentence for the chip's tooltip: why, and what happens next. */
  detail: string;
  /** The model answering now: `GPT-6-Astra · Codex`. */
  now?: string | null;
  /** The model the thread was meant to use, and why it is not running it. */
  pick?: { readonly label: string; readonly why: string } | null;
  /** How the thread gets back to its pick. */
  returns?: { readonly mode: "auto" | "manual"; readonly text: string } | null;
  back: { label: string; onClick: () => void; disabledReason: string | null } | null;
  /** The pick, then the fallback order, with the running step marked. */
  chain?: ReadonlyArray<FallbackChainEntry> | null;
};

type Label = { readonly full: string; readonly model: string };

const ORDER_NOTES: Record<FallbackOrderUnavailable, string | null> = {
  current: null,
  missing: "not set up",
  limited: "at its limit",
  "signed-out": "signed out",
  "per-token": "billed per token",
  full: "full",
  "too-small": "context too small",
  unverified: "usage unknown",
  "not-ready": "not ready here",
  excluded: "kept out of fallback",
};

/** `Claude Code · Opus 5.5` reads model first in the picker: `Opus 5.5 · Claude Code`. */
function modelFirst(label: Label): string {
  const provider = label.full.endsWith(` · ${label.model}`)
    ? label.full.slice(0, -` · ${label.model}`.length)
    : null;
  return provider ? `${label.model} · ${provider}` : label.full;
}

const same = (
  a: { readonly instanceId: string; readonly model: string },
  b: { readonly instanceId: string; readonly model: string },
) => a.instanceId === b.instanceId && a.model.split("[")[0] === b.model.split("[")[0];

export function fallbackChain(input: {
  readonly pick: { readonly instanceId: string; readonly model: string; readonly label: Label };
  readonly running: {
    readonly instanceId: string;
    readonly model: string;
    readonly label: Label;
  } | null;
  readonly order: ReadonlyArray<{
    readonly instanceId: string;
    readonly model: string;
    readonly label: Label;
    readonly unavailable: FallbackOrderUnavailable | null;
    readonly resetLabel?: string | null;
  }>;
}): FallbackChainEntry[] {
  const { pick, running } = input;
  const chain: FallbackChainEntry[] = [
    {
      instanceId: pick.instanceId,
      model: pick.model,
      label: modelFirst(pick.label),
      role: "pick",
      position: null,
      note: null,
    },
  ];
  let position = 0;
  for (const step of input.order) {
    // The pick leads already; listed again in the order, it is not a fallback for itself.
    if (same(step, pick)) continue;
    position += 1;
    const isNow = running !== null && same(step, running);
    chain.push({
      instanceId: step.instanceId,
      model: step.model,
      label: modelFirst(step.label),
      role: isNow ? "now" : null,
      position,
      note: isNow
        ? null
        : step.unavailable === "full" && step.resetLabel
          ? `full until ${step.resetLabel}`
          : step.unavailable
            ? ORDER_NOTES[step.unavailable]
            : null,
    });
  }
  // The server may pick a model outside the order, such as the same model on another account.
  if (running !== null && !chain.some((entry) => same(entry, running)))
    chain.push({
      instanceId: running.instanceId,
      model: running.model,
      label: modelFirst(running.label),
      role: "now",
      position: null,
      note: "not in your order",
    });
  return chain;
}

/**
 * The picker's fallback status. A limit fallback goes back on its own once the
 * pick has room (the server's limitFallbackReturnCommand, while the thread is
 * idle); a thread that started on a stand-in never does, so its way back is by hand.
 */
export function fallbackStatusHeader(input: {
  readonly pick: Label;
  /** The words that tell the pick apart from the running model (fallbackModelState). */
  readonly pickModel: string;
  readonly running: Label | null;
  readonly launched: boolean;
  /** The usage pre-switch moved the thread before its limit (1075). */
  readonly preswitched?: boolean;
  /** Why the way back from a pre-switch never moves the thread by itself. */
  readonly returnBlock?: PreswitchReturnBlock | null;
  /**
   * The pick can take a turn when chosen by hand. A pre-switched thread goes back
   * on its own only below the switch threshold, so `hasRoom` can be false while
   * a pick back is still open.
   */
  readonly canPickBack?: boolean;
  readonly hasRoom: boolean;
  readonly roomUnknown?: LimitPairingRoomUnknown | undefined;
  /**
   * The pick's provider reports no usage (Copilot and other agents). The server only
   * returns on a reading that shows room or a passed reset, so without a reset time
   * nothing brings the thread back on its own, even when room is otherwise proven.
   */
  readonly pickReportsNoUsage?: boolean;
  /** `4:30 PM`, when the pick's usage reading names its reset. */
  readonly resetLabel: string | null;
  readonly chain?: ReadonlyArray<FallbackChainEntry> | null;
  readonly onBack: () => void;
}): ModelStateHeader {
  const { pickModel, launched, hasRoom, roomUnknown, resetLabel } = input;
  const preswitched = !launched && input.preswitched === true;
  const returnBlock = preswitched ? (input.returnBlock ?? null) : null;
  const why = launched
    ? "Had no room when this thread started."
    : preswitched
      ? "Neared its usage limit."
      : "Hit its usage limit.";
  const byHandOnly =
    !launched && (roomUnknown === "unreported" || input.pickReportsNoUsage === true) && !resetLabel;
  const returns = returnBlock
    ? {
        mode: "manual" as const,
        text: `It stays on the fallback: ${PRESWITCH_RETURN_BLOCK_REASON[returnBlock]}.`,
      }
    : preswitched && !byHandOnly
      ? {
          mode: "auto" as const,
          text: hasRoom
            ? "Has room again. Goes back on its own when this thread is idle."
            : "Goes back on its own once it has room.",
        }
      : launched || byHandOnly
        ? {
            mode: "manual" as const,
            text: byHandOnly
              ? `${hasRoom ? "Has room now, but it" : "It"} reports no usage, so it goes back only by hand.`
              : hasRoom
                ? "Has room now. It does not switch back on its own."
                : roomUnknown
                  ? "Its room is unknown. It does not switch back on its own."
                  : resetLabel
                    ? `Resets at ${resetLabel}. It does not switch back on its own.`
                    : "No room yet. It does not switch back on its own.",
          }
        : {
            mode: "auto" as const,
            text: hasRoom
              ? "Has room again. Goes back on its own when this thread is idle."
              : roomUnknown === "unreported"
                ? `Goes back on its own after ${resetLabel}.`
                : roomUnknown
                  ? "Goes back on its own once a fresh usage reading shows room."
                  : resetLabel
                    ? `Goes back on its own after it resets at ${resetLabel}.`
                    : "Goes back on its own once it has room.",
          };
  const disabledReason =
    (input.canPickBack ?? false) || hasRoom || roomUnknown
      ? null
      : resetLabel
        ? `Available at ${resetLabel}`
        : `${pickModel} has no room yet`;
  return {
    title: "Running on a fallback",
    detail: preswitched
      ? preswitchFallbackDetail({ originalModel: pickModel, hasRoom, returnBlock })
      : `${pickModel} ${why.charAt(0).toLowerCase()}${why.slice(1)} ${returns.text}`,
    now: input.running ? modelFirst(input.running) : null,
    pick: { label: modelFirst(input.pick), why },
    returns,
    back: {
      label: returns.mode === "auto" ? `Return to ${pickModel} now` : `Return to ${pickModel}`,
      onClick: input.onBack,
      disabledReason,
    },
    chain: input.chain ?? null,
  };
}
