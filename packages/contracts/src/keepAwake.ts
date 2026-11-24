import * as Schema from "effect/Schema";

/**
 * When the desktop app may hold off idle sleep while running on battery (1457).
 * `adapter-only` lets the machine sleep as soon as it is unplugged, `until-low`
 * holds until the battery falls to the chosen floor, `always` ignores the battery.
 */
export const KeepAwakeOnBattery = Schema.Literals(["adapter-only", "until-low", "always"]);
export type KeepAwakeOnBattery = typeof KeepAwakeOnBattery.Type;

/** The battery percent at or below which `until-low` lets the machine sleep. */
export const KeepAwakeBatteryFloorPercent = Schema.Int.check(
  Schema.isBetween({ minimum: 5, maximum: 95 }),
);

export const DEFAULT_KEEP_AWAKE_ON_BATTERY: KeepAwakeOnBattery = "adapter-only";
export const DEFAULT_KEEP_AWAKE_BATTERY_FLOOR_PERCENT = 30;

export interface KeepAwakePower {
  /** True on battery, false on a power adapter, null when unknown. */
  readonly onBattery: boolean | null;
  /** Battery charge from 0 to 1, or null when unknown. */
  readonly level: number | null;
}

/**
 * Whether the keep-awake hold may stay on under this power state. On a power
 * adapter, or when the source is unknown, the hold is allowed. On battery,
 * `until-low` with an unknown level lets the machine sleep: a battery reading
 * that cannot be had never keeps a laptop awake.
 */
export function keepAwakeAllowedOnPower(
  policy: KeepAwakeOnBattery,
  floorPercent: number,
  power: KeepAwakePower,
): boolean {
  if (power.onBattery !== true) return true;
  switch (policy) {
    case "always":
      return true;
    case "adapter-only":
      return false;
    case "until-low":
      return power.level !== null && power.level * 100 > floorPercent;
  }
}

/** What a window reports to the desktop app about its working sessions. */
export interface DesktopKeepAwakeReport {
  readonly active: boolean;
  readonly onBattery?: KeepAwakeOnBattery;
  readonly batteryFloorPercent?: number;
  readonly batteryLevel?: number | null;
  /** Whether the window sees the battery charging; informational, the power source is read by the desktop app. */
  readonly charging?: boolean | null;
}

/** What the desktop app answers: whether it holds the machine awake, and on what power. */
export interface DesktopKeepAwakeState {
  readonly holding: boolean;
  readonly onBattery: boolean;
}
