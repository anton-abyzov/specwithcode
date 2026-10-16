/**
 * Which usage windows bind a turn. Account-wide windows (the session and the
 * weekly) cap every model; a model-scoped window (Claude's "Weekly · Fable")
 * caps only the models it names, on top of the account-wide ones. A window
 * that is spent blocks the windows it caps, whatever they still show: a
 * session at 100% left is no use while the weekly is exhausted.
 *
 * @module usageWindows
 */
import type { ServerProviderUsageWindow } from "@specweave-studio/contracts";

type Window = Pick<
  ServerProviderUsageWindow,
  "id" | "label" | "usedPercent" | "resetsAt" | "modelScope"
>;

const SCOPED_ID = /^seven_day_(?!overage_included$)/;

const normalize = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, "");

/**
 * The model family a window is limited to, or null for an account-wide one.
 * Older hosts do not send `modelScope`; their Claude model windows are named
 * `seven_day_<model>` and labelled `Weekly · <Model>`.
 */
export function windowModelScope(window: Window): string | null {
  const scope = window.modelScope?.trim();
  if (scope) return scope;
  if (!SCOPED_ID.test(window.id)) return null;
  const [, ...rest] = window.label.split(" · ");
  const name = rest.join(" · ").trim();
  return name.length > 0 ? name : null;
}

/**
 * Whether the window caps turns on `model`. A scoped window applies only to a
 * model whose slug names its family; with no model known it caps nothing, so
 * a spent Fable weekly never marks the whole provider as full.
 */
export function windowAppliesToModel(window: Window, model: string | null | undefined): boolean {
  const scope = windowModelScope(window);
  if (scope === null) return true;
  if (!model) return false;
  const family = normalize(scope);
  return family.length > 0 && normalize(model).includes(family);
}

/** Its reset has not passed: the reading still describes the window. */
export function isLiveWindow(window: Window, nowMs: number): boolean {
  if (window.resetsAt === undefined) return true;
  const at = Date.parse(window.resetsAt);
  return !Number.isFinite(at) || at > nowMs;
}

const isSpent = (window: Window, nowMs: number) =>
  window.usedPercent >= 100 && isLiveWindow(window, nowMs);

/**
 * The spent window that keeps `window` from being used, or null. A spent
 * account-wide window blocks every other window; a spent scoped window blocks
 * only the windows of its own model family. Of several, the one that resets
 * last binds.
 */
export function blockingWindow<W extends Window>(
  window: W,
  windows: ReadonlyArray<W>,
  nowMs: number,
): W | null {
  if (isSpent(window, nowMs)) return null;
  const scope = windowModelScope(window);
  let binding: W | null = null;
  for (const other of windows) {
    if (other === window || other.id === window.id || !isSpent(other, nowMs)) continue;
    const otherScope = windowModelScope(other);
    if (otherScope !== null && otherScope !== scope) continue;
    if (binding === null || resetMs(other) > resetMs(binding)) binding = other;
  }
  return binding;
}

const resetMs = (window: Window): number => {
  const at = window.resetsAt === undefined ? Number.NaN : Date.parse(window.resetsAt);
  return Number.isFinite(at) ? at : Number.POSITIVE_INFINITY;
};

/**
 * The share of quota `model` can still use: the least left across the live
 * windows that apply to it, 0..100, or null when none reports. With no model,
 * only the account-wide windows count.
 */
export function effectiveLeftPercent(
  windows: ReadonlyArray<Window>,
  nowMs: number,
  model?: string | null,
): number | null {
  let left: number | null = null;
  for (const window of windows) {
    if (!isLiveWindow(window, nowMs) || !windowAppliesToModel(window, model)) continue;
    const share = 100 - Math.max(0, Math.min(100, window.usedPercent));
    left = left === null ? share : Math.min(left, share);
  }
  return left === null ? null : Math.round(left);
}

/** The fullest live window that applies to `model`, as a used share, or null. */
export function effectiveUsedPercent(
  windows: ReadonlyArray<Window>,
  nowMs: number,
  model?: string | null,
): number | null {
  let used: number | null = null;
  for (const window of windows) {
    if (!isLiveWindow(window, nowMs) || !windowAppliesToModel(window, model)) continue;
    used = used === null ? window.usedPercent : Math.max(used, window.usedPercent);
  }
  return used;
}
