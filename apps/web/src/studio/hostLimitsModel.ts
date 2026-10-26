/**
 * Subscription limits per machine. Every host runs its own CLIs with its own
 * sign-ins, so Claude on m4 and Claude on M3 can be different accounts with
 * different windows. The pooled view answers "how much is left in total";
 * this one answers "what will this machine hit". Accounts signed in on more
 * than one host say so, because they share one quota.
 */
import type {
  EnvironmentId,
  ServerProvider,
  ServerProviderUsageLimits,
  ServerProviderUsageWindow,
} from "@specweave-studio/contracts";
import { isProviderAvailable } from "@specweave-studio/contracts";
import {
  limitAccountKey,
  limitsNotice,
  missingLimitsNotice,
} from "@specweave-studio/shared/usageLimits";
import {
  blockingWindow,
  windowModelScope,
  windowTitle,
} from "@specweave-studio/shared/usageWindows";
import { planLabel } from "./accountSwitches";
import { usageToneOfUsed } from "./usageIndicatorModel";

export type HostStatus = "online" | "connecting" | "offline";

export interface HostLimitWindow {
  readonly id: string;
  readonly label: string;
  readonly kind: ServerProviderUsageWindow["kind"];
  readonly usedPercent: number;
  /** Epoch ms of the next reset, or null when unknown or already past. */
  readonly resetsAt: number | null;
  /** Its reset has passed since the reading: the bar no longer describes the window. */
  readonly stale: boolean;
  /** The window's length as the provider reports it (300 for Claude's 5-hour). */
  readonly durationMins?: number;
  /** The model family the window limits, when it is not account-wide. */
  readonly modelScope?: string;
  /**
   * A spent window that caps this one (the weekly over the session): what is
   * left here cannot be used until that one resets.
   */
  readonly blockedBy?: { readonly label: string; readonly resetsAt: number | null };
}

export interface HostProviderRow {
  readonly key: string;
  /** The native instance behind the row; absent on readings saved before it was kept. */
  readonly instanceId?: string;
  readonly driver: ServerProvider["driver"];
  readonly label: string;
  readonly iconUrl: string | undefined;
  /** Who is signed in: the email when reported, otherwise the instance name. */
  readonly identity: string | null;
  readonly plan: string | null;
  /** Labels of the other hosts signed in to this same account. */
  readonly sharedWith: readonly string[];
  readonly windows: readonly HostLimitWindow[];
  /** Fullest current window; decides whether work on this host stops. */
  readonly peak: number | null;
  readonly bankedResets: number;
  /** Why there are no bars: no limits reported, a failed probe, an API key. */
  readonly notice: string | null;
  readonly checkedAt: number | null;
}

export interface HostLimitBlock {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly isProjectHost: boolean;
  /** The machine this window is served from: the app's own host. */
  readonly isThisMachine: boolean;
  readonly status: HostStatus;
  /** Newest provider reading on this host, epoch ms. */
  readonly readAt: number | null;
  /** True when the rows come from the last saved reading, not a live host. */
  readonly fromSavedReading: boolean;
  readonly providers: readonly HostProviderRow[];
}

/** What a host showed the last time it was online, kept per viewer. */
export interface SavedHostReading {
  readonly label: string;
  readonly savedAt: number;
  readonly providers: readonly HostProviderRow[];
}

export type HostLimitPresentations = ReadonlyMap<
  EnvironmentId,
  {
    readonly entry: { readonly target: { readonly label: string; readonly _tag?: string } };
    readonly connection: { readonly phase: string };
    readonly serverConfig: { readonly providers?: readonly ServerProvider[] | undefined } | null;
  }
>;

/** Drivers in the order people scan them. Others follow alphabetically. */
const DRIVER_ORDER = ["claudeAgent", "codex", "acpRegistry", "grok", "cursor"];

function driverRank(driver: string, label: string): number {
  // An ACP agent named Copilot sits with the subscription CLIs.
  const index = DRIVER_ORDER.indexOf(driver);
  if (driver === "acpRegistry") return /copilot/i.test(label) ? 2 : 10;
  return index < 0 ? 20 : index;
}

export function hostStatus(phase: string): HostStatus {
  if (phase === "connected") return "online";
  if (phase === "connecting" || phase === "reconnecting") return "connecting";
  return "offline";
}

function windowsOf(limits: ServerProviderUsageLimits, now: number): HostLimitWindow[] {
  return withBlockers(
    limits.windows.map((window) => {
      const at = window.resetsAt === undefined ? NaN : Date.parse(window.resetsAt);
      const scope = windowModelScope(window);
      return {
        id: window.id,
        label: window.label,
        kind: window.kind,
        usedPercent: Math.round(Math.max(0, Math.min(100, window.usedPercent))),
        resetsAt: Number.isFinite(at) && at > now ? at : null,
        stale: Number.isFinite(at) && at <= now,
        ...(window.windowDurationMins ? { durationMins: window.windowDurationMins } : {}),
        ...(scope === null ? {} : { modelScope: scope }),
      };
    }),
    now,
  );
}

/** Marks each window a spent one caps; stale readings neither block nor are blocked. */
export function withBlockers(windows: readonly HostLimitWindow[], now: number): HostLimitWindow[] {
  const live = windows
    .filter((window) => !window.stale)
    .map((window) => ({
      source: window,
      id: window.id,
      label: window.label,
      usedPercent: window.usedPercent,
      ...(window.resetsAt === null ? {} : { resetsAt: new Date(window.resetsAt).toISOString() }),
      ...(window.modelScope === undefined ? {} : { modelScope: window.modelScope }),
    }));
  return windows.map((window) => {
    const { blockedBy: _previous, ...rest } = window;
    const self = live.find((entry) => entry.source === window);
    const blocker = self ? blockingWindow(self, live, now) : null;
    return blocker === null
      ? rest
      : {
          ...rest,
          blockedBy: {
            label: windowDisplayLabel(blocker.source),
            resetsAt: blocker.source.resetsAt,
          },
        };
  });
}

/** The shared window name (`5-hour`, `Weekly`, `Fable weekly`), as every usage surface writes it. */
export function windowDisplayLabel(window: HostLimitWindow): string {
  // Readings saved before the length was kept: Claude's id names it.
  const mins = window.durationMins ?? (window.id === "five_hour" ? 300 : undefined);
  return windowTitle({
    id: window.id,
    label: window.label,
    windowDurationMins: mins,
    ...(window.modelScope === undefined ? {} : { modelScope: window.modelScope }),
  });
}

/**
 * The window that stops the provider first: the fullest current
 * account-wide one (model windows count only when nothing else reports), the
 * one that resets last on a tie. Null when no window is current. Windows are
 * compared, never averaged.
 */
export function bindingWindowId(windows: readonly HostLimitWindow[]): string | null {
  const current = windows.filter((window) => !window.stale);
  const wide = current.filter((window) => window.modelScope === undefined);
  let binding: HostLimitWindow | null = null;
  for (const window of wide.length > 0 ? wide : current) {
    if (
      binding === null ||
      window.usedPercent > binding.usedPercent ||
      (window.usedPercent === binding.usedPercent &&
        (window.resetsAt ?? Infinity) > (binding.resetsAt ?? Infinity))
    )
      binding = window;
  }
  return binding === null ? null : `${binding.kind}:${binding.id}`;
}

/**
 * The fullest current account-wide window: a spent model window (Fable) stops
 * only that model, so it decides the peak only when nothing else reports.
 */
function peakOf(windows: readonly HostLimitWindow[]): number | null {
  const current = windows.filter((window) => !window.stale);
  const wide = current.filter((window) => window.modelScope === undefined);
  const counted = wide.length > 0 ? wide : current;
  return counted.length === 0 ? null : Math.max(...counted.map((window) => window.usedPercent));
}

/**
 * Providers worth a row on a host: enabled and installed. A provider that
 * reports no limits still gets a row with its reason, so a missing Copilot
 * reads as "reports no limits" rather than as absent.
 */
function providerRows(
  providers: readonly ServerProvider[],
  driverLabel: (driver: ServerProvider["driver"]) => string,
  now: number,
): HostProviderRow[] {
  return providers
    .filter((provider) => provider.enabled && provider.installed && isProviderAvailable(provider))
    .map((provider): HostProviderRow => {
      const limits = provider.usageLimits;
      const label = provider.displayName?.trim() || driverLabel(provider.driver);
      const notice =
        limits === undefined
          ? missingLimitsNotice(provider)
          : limits.unavailable?.reason === "probeFailed" && limits.windows.length > 0
            ? null
            : limitsNotice(limits);
      // A failed probe keeps its last good bars, as the Limits page does.
      const windows = limits && notice === null ? windowsOf(limits, now) : [];
      const email = provider.auth.email;
      return {
        key:
          limitAccountKey(provider.driver, email, limits) ??
          `instance:${provider.driver}:${provider.instanceId}`,
        instanceId: provider.instanceId,
        driver: provider.driver,
        label,
        iconUrl: provider.iconUrl,
        identity: email?.trim() || null,
        // A failed probe's label ("Status check did not finish") is not a plan.
        plan: planLabel(provider.auth),
        sharedWith: [],
        windows,
        peak: peakOf(windows),
        bankedResets: limits?.resetCredits?.availableCount ?? 0,
        notice,
        checkedAt: limits ? Date.parse(limits.checkedAt) || null : null,
      };
    })
    .sort(
      (left, right) =>
        driverRank(left.driver, left.label) - driverRank(right.driver, right.label) ||
        left.label.localeCompare(right.label),
    );
}

/**
 * One block per host: the project's host first, then the app's own machine,
 * then online hosts, then offline hosts with their last saved reading.
 * Account keys shared by two hosts are named on both rows.
 */
export function collectHostLimitBlocks(
  presentations: HostLimitPresentations,
  options: {
    readonly projectEnvironmentId: EnvironmentId | null;
    readonly saved: ReadonlyMap<EnvironmentId, SavedHostReading>;
    readonly driverLabel: (driver: ServerProvider["driver"]) => string;
    readonly now: number;
  },
): readonly HostLimitBlock[] {
  const blocks: HostLimitBlock[] = [];
  for (const [environmentId, presentation] of presentations) {
    const status = hostStatus(presentation.connection.phase);
    const live = providerRows(
      presentation.serverConfig?.providers ?? [],
      options.driverLabel,
      options.now,
    );
    const saved = options.saved.get(environmentId);
    const useSaved = live.length === 0 && status !== "online" && saved !== undefined;
    const providers = useSaved
      ? saved.providers.map((row) => {
          // A saved reset that has passed no longer says anything about the window.
          const windows = withBlockers(
            row.windows.map((window) =>
              window.resetsAt !== null && window.resetsAt <= options.now
                ? { ...window, resetsAt: null, stale: true }
                : window,
            ),
            options.now,
          );
          return { ...row, windows, peak: peakOf(windows), sharedWith: [] };
        })
      : live;
    const readings = providers.flatMap((row) => (row.checkedAt === null ? [] : [row.checkedAt]));
    blocks.push({
      environmentId,
      label: presentation.entry.target.label,
      isProjectHost: environmentId === options.projectEnvironmentId,
      isThisMachine: presentation.entry.target._tag === "PrimaryConnectionTarget",
      status,
      readAt: readings.length > 0 ? Math.max(...readings) : useSaved ? saved.savedAt : null,
      fromSavedReading: useSaved,
      providers,
    });
  }
  const hostsByAccount = new Map<string, Set<string>>();
  for (const block of blocks) {
    for (const row of block.providers) {
      if (row.key.startsWith("instance:")) continue;
      const hosts = hostsByAccount.get(row.key) ?? new Set<string>();
      hosts.add(block.label);
      hostsByAccount.set(row.key, hosts);
    }
  }
  const statusRank: Record<HostStatus, number> = { online: 0, connecting: 1, offline: 2 };
  return blocks
    .map((block) => ({
      ...block,
      providers: block.providers.map((row) => ({
        ...row,
        sharedWith: [...(hostsByAccount.get(row.key) ?? [])]
          .filter((label) => label !== block.label)
          .sort(),
      })),
    }))
    .sort(
      (left, right) =>
        Number(right.isProjectHost) - Number(left.isProjectHost) ||
        Number(right.isThisMachine) - Number(left.isThisMachine) ||
        statusRank[left.status] - statusRank[right.status] ||
        left.label.localeCompare(right.label),
    );
}

/** The readings worth saving: hosts that are online now and reported something. */
export function savableReadings(
  blocks: readonly HostLimitBlock[],
  now: number,
): ReadonlyMap<EnvironmentId, SavedHostReading> {
  const saved = new Map<EnvironmentId, SavedHostReading>();
  for (const block of blocks) {
    if (block.status !== "online" || block.fromSavedReading || block.providers.length === 0)
      continue;
    saved.set(block.environmentId, {
      label: block.label,
      savedAt: now,
      providers: block.providers,
    });
  }
  return saved;
}

/** Tone of a used share: amber at 20% left or less, red only once it is spent. */
export function usageToneOf(usedPercent: number | null): "ok" | "warn" | "full" {
  return usedPercent === null ? "ok" : usageToneOfUsed(usedPercent);
}

/** `just now`, `5m ago`, `3h ago`, `2d ago`. */
export function formatAgo(at: number, now: number): string {
  const minutes = Math.floor(Math.max(0, now - at) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/** One account in the limits view: the reading shown and every machine signed in to it. */
export interface AccountLimitGroup {
  readonly key: string;
  readonly row: HostProviderRow;
  /** The machine the shown reading comes from. */
  readonly machine: string;
  readonly environmentId: EnvironmentId;
  /** Every machine signed in to this account, the shown one first. */
  readonly machines: readonly string[];
  readonly readAt: number | null;
}

export interface AccountLimitGroups {
  /** What the chat runs on now, read on its own machine. */
  readonly current: AccountLimitGroup | null;
  /** The fallback order, best first; null where the model's provider is not on any machine. */
  readonly fallback: ReadonlyArray<{
    readonly instanceId: string;
    readonly label: string;
    readonly group: AccountLimitGroup | null;
  }>;
  /** Every other account once, with its freshest reading. */
  readonly others: readonly AccountLimitGroup[];
}

/**
 * The limits view by account instead of by machine. The current account is
 * read on the machine the chat runs on, because that machine admits its turns
 * on its own reading. Any other account read on several machines shows once,
 * with its freshest reading. A row with no reported identity (`instance:`)
 * can't be matched across machines, so it stays per machine.
 */
export function groupLimitsByAccount(
  blocks: readonly HostLimitBlock[],
  input: {
    readonly current: { readonly environmentId: EnvironmentId; readonly instanceId: string } | null;
    readonly fallback?: ReadonlyArray<{ readonly instanceId: string; readonly label: string }>;
  },
): AccountLimitGroups {
  const pairs = blocks.flatMap((block) =>
    block.providers.map((row) => ({
      block,
      row,
      // `instance:` keys name an instance id that another machine may reuse.
      key: row.key.startsWith("instance:") ? `${row.key}@${block.environmentId}` : row.key,
    })),
  );
  const machinesOf = (key: string, first: string) => [
    first,
    ...new Set(
      pairs
        .filter((pair) => pair.key === key && pair.block.label !== first)
        .map((pair) => pair.block.label),
    ),
  ];
  const groupOf = (pair: (typeof pairs)[number]): AccountLimitGroup => ({
    key: pair.key,
    row: pair.row,
    machine: pair.block.label,
    environmentId: pair.block.environmentId,
    machines: machinesOf(pair.key, pair.block.label),
    readAt: pair.row.checkedAt,
  });
  const used = new Set<string>();
  const currentPair = input.current
    ? pairs.find(
        (pair) =>
          pair.block.environmentId === input.current!.environmentId &&
          pair.row.instanceId === input.current!.instanceId,
      )
    : undefined;
  const current = currentPair ? groupOf(currentPair) : null;
  if (current) used.add(current.key);
  const fallback = (input.fallback ?? []).map((entry) => {
    // The chat's own machine runs the fallback; another machine's reading only stands in.
    const pair =
      pairs.find(
        (candidate) =>
          candidate.row.instanceId === entry.instanceId &&
          candidate.block.environmentId === input.current?.environmentId,
      ) ?? pairs.find((candidate) => candidate.row.instanceId === entry.instanceId);
    if (pair) used.add(pair.key);
    return { instanceId: entry.instanceId, label: entry.label, group: pair ? groupOf(pair) : null };
  });
  const others: AccountLimitGroup[] = [];
  const seen = new Set<string>();
  for (const pair of pairs) {
    if (used.has(pair.key) || seen.has(pair.key)) continue;
    // Accounts that report nothing say so on the Limits page, not here.
    if (pair.row.notice !== null) continue;
    seen.add(pair.key);
    const freshest = pairs
      .filter((candidate) => candidate.key === pair.key && candidate.row.notice === null)
      .reduce((best, candidate) =>
        (candidate.row.checkedAt ?? 0) > (best.row.checkedAt ?? 0) ? candidate : best,
      );
    others.push(groupOf(freshest));
  }
  return { current, fallback, others };
}
