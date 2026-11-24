import * as Schema from "effect/Schema";

import { getLocalStorageItem, setLocalStorageItem } from "../../hooks/useLocalStorage";

const STORAGE_KEY = "studio:usage-page-preferences:v1";
const UsageDaySchema = Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/u));
const UsagePagePreferencesSchema = Schema.Struct({
  metric: Schema.Literals(["cost", "tokens", "limits", "machines", "delivered"]),
  /** The preset, and the fallback when a saved custom range no longer applies. */
  windowDays: Schema.Literals([1, 7, 30, 90]),
  /** A custom range (1456); absent for presets and from older saves. */
  customRange: Schema.optionalKey(
    Schema.Struct({ sinceDay: UsageDaySchema, untilDay: UsageDaySchema }),
  ),
});
export type UsagePagePreferences = typeof UsagePagePreferencesSchema.Type;

// Limits is what most people open the page for (how much subscription quota is
// left, and when it resets), so it is the first-visit default; the last picked
// tab sticks after that.
const DEFAULT_PREFERENCES: UsagePagePreferences = { metric: "limits", windowDays: 30 };

export function readUsagePagePreferences(): UsagePagePreferences {
  try {
    return getLocalStorageItem(STORAGE_KEY, UsagePagePreferencesSchema) ?? DEFAULT_PREFERENCES;
  } catch (error) {
    console.error("Could not read Usage page preferences.", error);
    return DEFAULT_PREFERENCES;
  }
}

export function saveUsagePagePreferences(preferences: UsagePagePreferences): void {
  try {
    setLocalStorageItem(STORAGE_KEY, preferences, UsagePagePreferencesSchema);
  } catch (error) {
    console.error("Could not save Usage page preferences.", error);
  }
}
