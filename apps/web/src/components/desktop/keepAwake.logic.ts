/**
 * What the keep-awake hold counts and what the battery notice says (1457).
 *
 * @module keepAwake.logic
 */

export interface KeepAwakeThread {
  readonly environmentId: string;
  readonly deletedAt: string | null;
  readonly archivedAt: string | null;
  readonly working: boolean;
}

/**
 * Threads working on this machine's own environment. Work on another machine
 * runs there whether this laptop sleeps or not, so it never counts here.
 */
export function countLocalWorking(
  threads: ReadonlyArray<KeepAwakeThread>,
  ownEnvironmentId: string | null,
): number {
  if (ownEnvironmentId === null) return 0;
  let count = 0;
  for (const thread of threads) {
    if (
      thread.working &&
      thread.deletedAt === null &&
      thread.archivedAt === null &&
      thread.environmentId === ownEnvironmentId
    ) {
      count += 1;
    }
  }
  return count;
}

export interface KeepAwakeBatteryNotice {
  /** `held` or `released`: a battery session shows each kind at most once. */
  readonly kind: "held" | "released";
  readonly title: string;
  readonly description: string;
}

const threads = (count: number) => (count === 1 ? "1 thread works" : `${count} threads work`);

/** The notice for this moment, or null when there is nothing to say. */
export function keepAwakeBatteryNotice(input: {
  readonly onBattery: boolean;
  readonly holding: boolean;
  readonly working: number;
  readonly machine: string;
}): KeepAwakeBatteryNotice | null {
  if (!input.onBattery || input.working === 0) return null;
  if (input.holding) {
    return {
      kind: "held",
      title: `Keeping ${input.machine} awake on battery while ${threads(input.working)}`,
      description:
        "Hand them to a plugged-in machine to save the battery, or change Settings > Keep awake on battery.",
    };
  }
  return {
    kind: "released",
    title: `${input.machine} is on battery and can sleep while ${threads(input.working)}`,
    description:
      "Plug in to keep them running, or hand them to a plugged-in machine. Nothing moves until you choose.",
  };
}

/**
 * Remembers which notices a battery session already showed. Plugging in
 * starts a new session, so the next unplug may say it again.
 */
export function makeBatteryNoticeMemory() {
  const shown = new Set<KeepAwakeBatteryNotice["kind"]>();
  return {
    /** True the first time this kind is offered in the current battery session. */
    take: (notice: KeepAwakeBatteryNotice): boolean => {
      if (shown.has(notice.kind)) return false;
      shown.add(notice.kind);
      return true;
    },
    pluggedIn: () => shown.clear(),
  };
}

/** The Settings choice as one menu value: the battery rule and, for `until-low`, its floor. */
export const KEEP_AWAKE_BATTERY_OPTIONS = [
  { value: "adapter-only", label: "Only on power adapter", policy: "adapter-only", floor: null },
  { value: "until-low-20", label: "Until battery is below 20%", policy: "until-low", floor: 20 },
  { value: "until-low-30", label: "Until battery is below 30%", policy: "until-low", floor: 30 },
  { value: "until-low-50", label: "Until battery is below 50%", policy: "until-low", floor: 50 },
  { value: "always", label: "Always", policy: "always", floor: null },
] as const;

export type KeepAwakeBatteryOption = (typeof KEEP_AWAKE_BATTERY_OPTIONS)[number];

/** The menu entry for stored settings; a floor not on the menu shows as the nearest one. */
export function keepAwakeBatteryOption(
  policy: "adapter-only" | "until-low" | "always",
  floorPercent: number,
): KeepAwakeBatteryOption {
  if (policy !== "until-low") {
    return KEEP_AWAKE_BATTERY_OPTIONS.find((option) => option.policy === policy)!;
  }
  const lows = KEEP_AWAKE_BATTERY_OPTIONS.filter((option) => option.policy === "until-low");
  return lows.reduce((best, option) =>
    Math.abs(option.floor - floorPercent) < Math.abs(best.floor - floorPercent) ? option : best,
  );
}
