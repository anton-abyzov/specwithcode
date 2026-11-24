import { useEnvironmentsWithScope } from "../../state/session";
import { ChatGptUsageButton } from "../settings/ChatGptUsageButton";
import { usesChatGptSharing } from "@specweave-studio/shared/usageLimits";
import { RefreshIcon } from "~/components/ui/refresh-icon";
import { useAtomValue } from "@effect/atom-react";
import {
  AuthSettingsWriteScope,
  type EnvironmentId,
  type UsageProviderKind,
} from "@specweave-studio/contracts";
import {
  CircleDollarSignIcon,
  CoinsIcon,
  GaugeIcon,
  MonitorIcon,
  PackageCheckIcon,
} from "lucide-react";
import { useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import {
  cursorKeychainAccessEnvironments,
  refreshUsageLimits,
} from "@specweave-studio/client-runtime/state/usage";

import { type DailyTotals, type HourlyTotals } from "@specweave-studio/shared/usageMerge";

import { isElectron } from "../../env";
import { cn } from "../../lib/utils";
import { environmentPresentations } from "../../state/presentation";
import { primaryServerKeybindingsAtom, serverEnvironment } from "../../state/server";
import { isCommandPaletteOpen } from "../../commandPaletteBus";
import { isModelPickerOpen } from "../../modelPickerVisibility";
import { shortcutLabelForCommand } from "../../keybindings";
import { mergeAnsweredUsage, useUsage, type EnvironmentUsageStatus } from "../../state/usage";
import { useMachineNicknames } from "../../studio/machineNickname";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  enumerateDays,
  enumerateHourStarts,
  formatCount,
  formatDateTimeShort,
  formatDayShort,
  formatHourShort,
  formatPercent,
  formatTokens,
  formatUsd,
} from "@specweave-studio/shared/usageFormat";
import {
  formatUsageRange,
  restoreUsageRange,
  todayIn,
  usageRangeIsPast,
  usageRangeWindow,
  type UsageRange,
} from "@specweave-studio/shared/usageRange";
import { Button } from "../ui/button";
import { ScrollArea } from "../ui/scroll-area";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { AppSheet } from "../ui/app-sheet";
import {
  SidebarContent,
  SidebarGroup,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "../ui/sidebar";
import { Skeleton } from "../ui/skeleton";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
} from "../WorkspaceBreadcrumb";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { CursorEnableLimits, CursorEnableRow, ProviderMark } from "./CursorUsageEnable";
import { resetExpiryAccounts } from "./alerts/resetExpiry";
import { ResetCredits, UsageLimitsSection } from "./UsageLimits";
import { UsageMachinesSection } from "./machines/UsageMachinesSection";
import { UsagePriceOverrides } from "./UsagePriceOverrides";
import { UsageProviderChart } from "./UsageProviderChart";
import { SpeedPremium, UsageModelDialog } from "./UsageModelDialog";
import { UsageShareBar } from "./UsageShareBar";
import {
  costTypeSegments,
  sortModelsByTokens,
  speedCostSegments,
  tokenTypeSegments,
} from "./usageBreakdown";
import {
  METRIC_OPTIONS,
  WINDOW_OPTIONS,
  resolveUsageShortcut,
  type UsageMetric,
} from "./usageShortcuts";
import { useEscapeToGoBack } from "../../hooks/useNavigateBack";
import { PROVIDER_ORDER, PROVIDER_PRESENTATION, providersWithUsage } from "./usageProviders";
import {
  readUsagePagePreferences,
  saveUsagePagePreferences,
  type UsagePagePreferences,
} from "./usagePagePreferences";

import { UsageCostBasis } from "./UsageCostBasis";
import { UsageScopeBar } from "./UsageScopeBar";
import { UsageEnvironmentFilter } from "./UsageEnvironmentFilter";
import { UsageRangeControl } from "./UsageRangeControl";
import { UsageDeliveredSection } from "./delivered/UsageDeliveredSection";
import {
  driverLabel as PROVIDER_LABEL,
  driverOfUsageKind,
  driversWithoutCost,
  notAppliedNotes,
  sortDrivers,
  usageKindOfDriver,
  usageKindsOfDrivers,
} from "./usageScope";
import { UsageModelTable } from "./UsageModelTable";
import { UsageOutlook } from "./UsageOutlook";
import { forecastUsage } from "./usageForecast";
import { usageBillingPicture, BILLING_MODE_LABEL, BILLING_MODE_DESCRIPTION } from "./usageBilling";
import {
  NO_USAGE_FILTERS,
  costText,
  matchesModelQuery,
  toggleUsageProvider,
  usageBucketFilter,
  type UsageFilters,
} from "./usageFilters";

function isUsageMetric(value: string | null | undefined): value is UsageMetric {
  return METRIC_OPTIONS.some((option) => option.value === value);
}

function savedRange(preferences: UsagePagePreferences): UsageRange {
  return (
    restoreUsageRange(
      preferences.customRange === undefined
        ? undefined
        : { kind: "custom", ...preferences.customRange },
      todayIn(Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"),
    ) ?? { kind: "preset", days: preferences.windowDays }
  );
}

export function UsagePage({
  variant = "page",
  initialMetric,
  onClose,
}: {
  /** A sheet renders over the app, without the page's sidebar inset and window header. */
  readonly variant?: "page" | "sheet";
  /** Opens on this tab without saving it; switching tabs inside saves as usual. */
  readonly initialMetric?: UsageMetric;
  /** Closes the sheet; Escape uses it once nothing on the page is pinned. */
  readonly onClose?: () => void;
} = {}) {
  const sheet = variant === "sheet";
  const [filters, setFilters] = useState<UsageFilters>(NO_USAGE_FILTERS);
  const [preferences, setPreferences] = useState(() => {
    const saved = readUsagePagePreferences();
    return initialMetric === undefined ? saved : { ...saved, metric: initialMetric };
  });
  useEscapeToGoBack(
    filters.period !== null
      ? () => setFilters((current) => ({ ...current, period: null }))
      : sheet
        ? () => onClose?.()
        : undefined,
  );
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const shortcutTitle = (
    option: (typeof METRIC_OPTIONS)[number] | (typeof WINDOW_OPTIONS)[number],
  ) => {
    const shortcut = shortcutLabelForCommand(keybindings, option.command, {
      context: { usagePageOpen: true },
    });
    return shortcut ? `${option.label} (${shortcut})` : option.label;
  };
  const [windowSelection, setWindowSelection] = useState(() => {
    const range = savedRange(preferences);
    return { range, window: usageRangeWindow(range) };
  });
  const metric = preferences.metric;
  const showingLimits = metric === "limits";
  const showingMachines = metric === "machines";
  const showingDelivered = metric === "delivered";
  // Limits, Machines and Delivered read on their own; only Limits keeps its own period.
  const ownsPeriod = showingLimits || showingMachines || showingDelivered;
  const [machinesRefreshKey, setMachinesRefreshKey] = useState(0);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [limitsNow, setLimitsNow] = useState(() => Date.now());
  const refreshingRef = useRef(false);
  const [breakdown, setBreakdown] = useState<"model" | "time">("model");
  const [priceDialog, setPriceDialog] = useState<{ readonly model?: string } | null>(null);
  const [selectedModelKey, setSelectedModelKey] = useState<string | null>(null);
  const [selectedEnvironmentIds, setSelectedEnvironmentIds] =
    useState<ReadonlySet<EnvironmentId> | null>(null);
  const { range, window } = windowSelection;
  const isPast24Hours = range.kind === "preset" && range.days === 1;
  const today = todayIn(window.timeZone);
  const rangeIsPast = usageRangeIsPast(range, today);
  const {
    merged: fullMerged,
    environments: rawEnvironments,
    selectedEnvironments: rawSelectedEnvironments,
    isPending,
    isPartial,
    refresh,
  } = useUsage(window, selectedEnvironmentIds);
  const nickname = useMachineNicknames();
  const namedStatus = useMemo(
    () => (status: EnvironmentUsageStatus) => {
      const label = nickname(status.environmentId, status.label);
      return label === status.label ? status : { ...status, label };
    },
    [nickname],
  );
  const environments = useMemo(
    () => rawEnvironments.map(namedStatus),
    [rawEnvironments, namedStatus],
  );
  const selectedEnvironments = useMemo(
    () => rawSelectedEnvironments.map(namedStatus),
    [rawSelectedEnvironments, namedStatus],
  );
  const presentations = useAtomValue(environmentPresentations.presentationsAtom);
  /** Selected providers Cost and Tokens can show; empty when no provider is selected. */
  const selectedKinds = useMemo(() => usageKindsOfDrivers(filters.drivers), [filters.drivers]);
  const chartMerged = useMemo(() => {
    const keep = usageBucketFilter(filters, false);
    return keep ? mergeAnsweredUsage(selectedEnvironments, keep) : fullMerged;
  }, [filters, selectedEnvironments, fullMerged]);
  const merged = useMemo(() => {
    const keep = usageBucketFilter(filters, true);
    return keep ? mergeAnsweredUsage(selectedEnvironments, keep) : fullMerged;
  }, [filters, selectedEnvironments, fullMerged]);
  const [billingNow, setBillingNow] = useState(Date.now);
  useEffect(() => {
    const timer = globalThis.setInterval(() => setBillingNow(Date.now()), 60_000);
    return () => globalThis.clearInterval(timer);
  }, []);
  const billing = usageBillingPicture(presentations, selectedEnvironmentIds, billingNow);
  const availableProviders = providersWithUsage(fullMerged.providers);
  const estimate = costText({
    ...merged,
    unpricedRecords: merged.models.reduce((sum, model) => sum + model.unpricedRecords, 0),
  });
  const forecast = useMemo(
    () =>
      forecastUsage({
        usage: chartMerged,
        environments: selectedEnvironments,
        window,
        providers: selectedKinds,
        nowMs: billingNow,
        partial: isPartial,
        pinned: filters.period !== null,
      }),
    [
      chartMerged,
      selectedEnvironments,
      window,
      selectedKinds,
      filters.period,
      billingNow,
      isPartial,
    ],
  );
  const [projectOptions, setProjectOptions] = useState<readonly string[]>([]);
  const driverOptions = useMemo(
    () =>
      sortDrivers([
        ...providersWithUsage(fullMerged.providers).map(driverOfUsageKind),
        ...[...presentations].flatMap(([id, presentation]) =>
          selectedEnvironmentIds !== null && !selectedEnvironmentIds.has(id)
            ? []
            : (presentation.serverConfig?.providers ?? []).map((provider) =>
                String(provider.driver),
              ),
        ),
        ...filters.drivers,
      ]),
    [fullMerged.providers, presentations, selectedEnvironmentIds, filters.drivers],
  );
  const rangeLabel =
    range.kind === "custom"
      ? formatUsageRange(range.sinceDay, range.untilDay, today)
      : (WINDOW_OPTIONS.find((option) => option.days === range.days)?.label ?? "");
  // Machines and Delivered read whole days: Past 24h becomes yesterday and today there, and says so.
  const wholeDays = range.kind === "preset" && range.days === 1;
  const dayRangeLabel = wholeDays
    ? formatUsageRange(window.sinceDay, window.untilDay, today)
    : rangeLabel;
  const scopeNotes = [
    ...(wholeDays && (metric === "machines" || metric === "delivered")
      ? [`Past 24h covers whole days on this tab: ${dayRangeLabel}.`]
      : []),
    ...notAppliedNotes(metric, {
      drivers: filters.drivers,
      modelQuery: filters.modelQuery,
      projects: filters.projects,
      machinesNarrowed: selectedEnvironmentIds !== null,
    }),
    ...(metric === "cost" || metric === "tokens"
      ? driversWithoutCost(filters.drivers, providersWithUsage(fullMerged.providers)).map(
          (driver) =>
            `No measured ${metric === "cost" ? "cost" : "tokens"} for ${PROVIDER_LABEL(driver)} in this range${usageKindOfDriver(driver) === null ? ": it keeps no readable token history here" : ""}.`,
        )
      : []),
    ...(rangeIsPast && !showingLimits
      ? [
          `This range ended ${formatDayShort(window.untilDay)}, so the forecast and current plan chips are hidden.`,
        ]
      : []),
    ...(showingLimits && range.kind === "custom"
      ? ["Limits counts whole reset weeks, not the page range."]
      : []),
  ];
  const periodLabel =
    filters.period === null
      ? null
      : filters.period.kind === "day"
        ? formatDayShort(filters.period.day)
        : formatHourShort(filters.period.hourStart, window.timeZone);
  const settingsWritable = useEnvironmentsWithScope(selectedEnvironments, AuthSettingsWriteScope);
  const cursorAccessEnvironments = cursorKeychainAccessEnvironments(selectedEnvironments).filter(
    ({ environmentId }) => settingsWritable.has(environmentId),
  );
  const sourceMessages = [
    ...new Set(
      selectedEnvironments.flatMap(
        (environment) =>
          environment.summary?.sources.flatMap((source) =>
            source.message &&
            !source.action &&
            (source.status === "partial" ||
              source.status === "failed" ||
              source.fingerprint.provider === "cursor")
              ? [source.message]
              : [],
          ) ?? [],
      ),
    ),
  ];
  const refreshProviders = useAtomCommand(serverEnvironment.refreshProviders, {
    reportFailure: false,
  });

  const canReadDiagnostics = selectedEnvironments.some(
    (environment) => environment.canReadDiagnostics,
  );

  const days = useMemo(
    () => enumerateDays(window.sinceDay, window.untilDay),
    [window.sinceDay, window.untilDay],
  );
  const hours = useMemo(
    () =>
      window.sinceTime === undefined || window.untilTime === undefined
        ? []
        : enumerateHourStarts(window.sinceTime, window.untilTime),
    [window.sinceTime, window.untilTime],
  );
  // Newest first: the window can run 90 periods, so the interesting end
  // belongs at the top of the table.
  const breakdownPeriods = useMemo<readonly (DailyTotals | HourlyTotals)[]>(
    () => (isPast24Hours ? merged.hourly : merged.daily).toReversed(),
    [isPast24Hours, merged.daily, merged.hourly],
  );
  const breakdownModels = useMemo(
    () =>
      breakdown === "model" && metric === "tokens"
        ? sortModelsByTokens(merged.models)
        : merged.models,
    [breakdown, merged.models, metric],
  );
  const filteredModels = breakdownModels.filter((model) =>
    matchesModelQuery(model.model, filters.modelQuery),
  );
  const activeProviders = useMemo(() => providersWithUsage(merged.providers), [merged.providers]);
  const selectedModel =
    selectedModelKey === null
      ? undefined
      : merged.models.find((model) => `${model.provider}:${model.model}` === selectedModelKey);
  const summaryRows: Array<
    | { readonly kind: "usage"; readonly provider: UsageProviderKind }
    | { readonly kind: "enable"; readonly environment: EnvironmentUsageStatus }
  > = availableProviders.map((provider) => ({ kind: "usage", provider }));
  const cursorInsertAt =
    Math.max(availableProviders.indexOf("codex"), availableProviders.indexOf("claude")) + 1;
  summaryRows.splice(
    cursorInsertAt,
    0,
    ...cursorAccessEnvironments.map((environment) => ({ kind: "enable" as const, environment })),
  );
  const timeValueColumnWidth = `${60 / (activeProviders.length + 2)}%`;

  const rangePreferences = (next: UsageRange) =>
    next.kind === "preset"
      ? { windowDays: next.days }
      : {
          windowDays: preferences.windowDays,
          customRange: { sinceDay: next.sinceDay, untilDay: next.untilDay },
        };
  const selectRange = (next: UsageRange) => {
    setFilters((current) => ({ ...current, period: null }));
    const nextPreferences = { metric, ...rangePreferences(next) };
    setPreferences(nextPreferences);
    saveUsagePagePreferences(nextPreferences);
    setWindowSelection({ range: next, window: usageRangeWindow(next) });
  };
  const selectMetric = (nextMetric: UsageMetric) => {
    if (nextMetric !== "cost" && nextMetric !== "tokens") setLimitsNow(Date.now());
    const nextPreferences = { metric: nextMetric, ...rangePreferences(range) };
    setPreferences(nextPreferences);
    saveUsagePagePreferences(nextPreferences);
  };
  const refreshLimits = async (automatic = false, afterPending = false) => {
    try {
      await Promise.all(
        Array.from(presentations, ([environmentId, presentation]) => {
          if (selectedEnvironmentIds !== null && !selectedEnvironmentIds.has(environmentId)) return;
          if (presentation.connection.phase === "connected" && presentation.serverConfig !== null) {
            return refreshUsageLimits(
              environmentId,
              // A pressed Refresh reads each account past the server's probe cache.
              () => refreshProviders({ environmentId, input: automatic ? {} : { fresh: true } }),
              automatic,
              afterPending,
            );
          }
        }),
      );
    } finally {
      setLimitsNow(Date.now());
    }
  };
  const onUsageKeyDown = useEffectEvent((event: KeyboardEvent) => {
    if (
      event.defaultPrevented ||
      event.repeat ||
      event.isComposing ||
      isCommandPaletteOpen() ||
      isModelPickerOpen()
    )
      return;

    const command = resolveUsageShortcut(event, keybindings);
    const metricOption = METRIC_OPTIONS.find((option) => option.command === command);
    const periodOption = WINDOW_OPTIONS.find((option) => option.command === command);
    if (!metricOption && !periodOption) return;

    event.preventDefault();
    event.stopPropagation();
    if (metricOption) selectMetric(metricOption.value);
    if (periodOption && !showingLimits) selectRange({ kind: "preset", days: periodOption.days });
  });

  useEffect(() => {
    globalThis.window.addEventListener("keydown", onUsageKeyDown, true);
    return () => globalThis.window.removeEventListener("keydown", onUsageKeyDown, true);
  }, []);

  // A rolled-forward window can drop the pinned day or hour, whichever tab refreshed it.
  const applyRolledWindow = (nextWindow: typeof window) => {
    setWindowSelection({ range, window: nextWindow });
    const pinned = filters.period;
    if (
      pinned !== null &&
      (pinned.kind === "day"
        ? pinned.day < nextWindow.sinceDay || pinned.day > nextWindow.untilDay
        : nextWindow.sinceTime === undefined ||
          nextWindow.untilTime === undefined ||
          !enumerateHourStarts(nextWindow.sinceTime, nextWindow.untilTime).includes(
            pinned.hourStart,
          ))
    ) {
      setFilters((current) => ({ ...current, period: null }));
    }
  };
  const refreshWindow = () => {
    if (refreshingRef.current) return;

    if (ownsPeriod) {
      if (showingMachines || showingDelivered) {
        // A preset rolls forward: after midnight, Refresh reads the new days.
        const rolled = usageRangeWindow(range);
        if (
          rolled.sinceDay !== window.sinceDay ||
          rolled.untilDay !== window.untilDay ||
          rolled.sinceTime !== window.sinceTime ||
          rolled.untilTime !== window.untilTime
        ) {
          applyRolledWindow(rolled);
        }
        setLimitsNow(Date.now());
        setMachinesRefreshKey((key) => key + 1);
      }
      refreshingRef.current = true;
      setIsRefreshing(true);
      void refreshLimits().finally(() => {
        refreshingRef.current = false;
        setIsRefreshing(false);
      });
      return;
    }
    const nextWindow = usageRangeWindow(range);
    if (
      nextWindow.sinceDay !== window.sinceDay ||
      nextWindow.untilDay !== window.untilDay ||
      nextWindow.sinceTime !== window.sinceTime ||
      nextWindow.untilTime !== window.untilTime
    ) {
      applyRolledWindow(nextWindow);
    }
    refreshingRef.current = true;
    setIsRefreshing(true);
    void refresh(nextWindow).finally(() => {
      refreshingRef.current = false;
      setIsRefreshing(false);
    });
  };
  const connectedLimitsEnvironments = [...presentations]
    .filter(
      ([environmentId, presentation]) =>
        presentation.connection.phase === "connected" &&
        presentation.serverConfig !== null &&
        (selectedEnvironmentIds === null || selectedEnvironmentIds.has(environmentId)),
    )
    .map(([environmentId]) => environmentId)
    .sort()
    .join(",");
  const autoRefreshLimits = useEffectEvent(() => {
    void refreshLimits(true);
  });
  useEffect(() => {
    if (ownsPeriod && connectedLimitsEnvironments) autoRefreshLimits();
  }, [ownsPeriod, connectedLimitsEnvironments]);

  const windowLabel =
    isPast24Hours && window.sinceTime !== undefined && window.untilTime !== undefined
      ? `${formatDateTimeShort(window.sinceTime, window.timeZone)} to ${formatDateTimeShort(window.untilTime, window.timeZone)}`
      : `${formatDayShort(window.sinceDay)} to ${formatDayShort(window.untilDay)}`;
  const topbarContent = (
    <div className="grid w-full min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-2 py-2 xl:flex">
      <WorkspaceBreadcrumb ariaLabel="Usage breadcrumb" className="col-span-2 min-w-0">
        <WorkspaceBreadcrumbItem>
          <h1>Usage</h1>
        </WorkspaceBreadcrumbItem>
        <WorkspaceBreadcrumbSeparator />
        <WorkspaceBreadcrumbItem current className="min-w-10">
          <UsageEnvironmentFilter
            environments={environments}
            selectedEnvironments={selectedEnvironments}
            selectedEnvironmentIds={selectedEnvironmentIds}
            onSelectionChange={setSelectedEnvironmentIds}
            showUsageStatus={!ownsPeriod}
            isPartial={isPartial}
            duplicateSources={merged.duplicateSources}
            contractMismatches={merged.contractMismatches}
            onOpenModelPrices={() => setPriceDialog({})}
          />
        </WorkspaceBreadcrumbItem>
      </WorkspaceBreadcrumb>
      {!showingLimits ? (
        <span className="hidden min-w-0 truncate text-xs text-muted-foreground 2xl:block">
          {windowLabel}
        </span>
      ) : null}
      <div className="ms-auto hidden min-w-0 items-center justify-end gap-2 xl:flex">
        {sheet ? null : (
          <ToggleGroup
            aria-label="Usage metric"
            variant="segmented"
            value={[metric]}
            onValueChange={(next) => {
              const value = next[0];
              if (isUsageMetric(value)) selectMetric(value);
            }}
          >
            {METRIC_OPTIONS.map((option) => (
              <Toggle key={option.value} value={option.value} title={shortcutTitle(option)}>
                {option.label}
              </Toggle>
            ))}
          </ToggleGroup>
        )}
        {/* The period does not apply to Limits, so it stays in place but
            disabled; unmounting it shifted the metric toggle ~300px. */}
        <UsageRangeControl
          range={range}
          today={today}
          disabled={showingLimits}
          titleFor={shortcutTitle}
          onChange={selectRange}
        />
        <Button
          onClick={refreshWindow}
          aria-label={
            showingLimits
              ? "Refresh limits"
              : showingMachines
                ? "Refresh machines"
                : "Refresh usage"
          }
          aria-busy={isRefreshing}
          disabled={isRefreshing || (!ownsPeriod && !canReadDiagnostics)}
          size="icon-sm"
          variant="ghost"
        >
          <RefreshIcon size="sm" refreshing={isRefreshing} />
        </Button>
      </div>
      <div className="col-span-2 ms-auto flex min-w-0 items-center justify-end gap-1 xl:hidden">
        {sheet ? null : (
          <Select
            value={metric}
            onValueChange={(value) => {
              if (isUsageMetric(value)) selectMetric(value);
            }}
          >
            <SelectTrigger
              aria-label="Usage metric"
              size="compact"
              variant="ghost"
              className="w-auto min-w-0"
            >
              <SelectValue>
                {METRIC_OPTIONS.find((option) => option.value === metric)?.label}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {METRIC_OPTIONS.map((option) => (
                <SelectItem key={option.value} value={option.value} title={shortcutTitle(option)}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        )}
        <UsageRangeControl
          compact
          range={range}
          today={today}
          disabled={showingLimits}
          titleFor={shortcutTitle}
          onChange={selectRange}
        />
        <Button
          onClick={refreshWindow}
          aria-label={
            showingLimits
              ? "Refresh limits"
              : showingMachines
                ? "Refresh machines"
                : "Refresh usage"
          }
          aria-busy={isRefreshing}
          disabled={isRefreshing || (!ownsPeriod && !canReadDiagnostics)}
          size="icon-sm"
          variant="ghost"
        >
          <RefreshIcon size="sm" refreshing={isRefreshing} />
        </Button>
      </div>
    </div>
  );

  const body = (
    <>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        {sheet ? null : (
          <WorkspacePageHeader electron={isElectron} className="h-auto">
            {topbarContent}
          </WorkspacePageHeader>
        )}

        <ScrollArea className="min-h-0 flex-1">
          <WorkspacePageContainer width="expanded">
            {resetExpiryAccounts(
              selectedEnvironmentIds === null
                ? presentations
                : new Map([...presentations].filter(([id]) => selectedEnvironmentIds.has(id))),
              billingNow,
            ).map((warning) => (
              <ResetCredits
                key={warning.key}
                {...warning.redeem}
                credits={warning.credits}
                now={billingNow}
                banner={{ message: warning.message, label: warning.label }}
              />
            ))}
            {selectedEnvironments.length > 0 ? (
              <UsageScopeBar
                metric={metric}
                filters={filters}
                setFilters={setFilters}
                driverOptions={driverOptions}
                projectOptions={projectOptions}
                periodLabel={
                  showingLimits || showingMachines || showingDelivered ? null : periodLabel
                }
                notes={scopeNotes}
              />
            ) : null}
            {selectedEnvironments.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {environments.length === 0
                  ? `Connect an environment to see ${showingLimits ? "limits" : "usage"}.`
                  : `Select an environment to see ${showingLimits ? "limits" : "usage"}.`}
              </p>
            ) : showingMachines ? (
              <UsageMachinesSection
                selectedEnvironmentIds={selectedEnvironmentIds}
                usage={selectedEnvironments}
                refreshKey={machinesRefreshKey}
                now={limitsNow}
                range={window}
                rangeLabel={dayRangeLabel}
                drivers={filters.drivers}
              />
            ) : showingDelivered ? (
              <UsageDeliveredSection
                selectedEnvironmentIds={selectedEnvironmentIds}
                range={window}
                rangeLabel={dayRangeLabel}
                filters={filters}
                filterLabels={[
                  ...(filters.drivers.size > 0
                    ? [`Providers: ${sortDrivers(filters.drivers).map(PROVIDER_LABEL).join(", ")}`]
                    : []),
                  ...(filters.modelQuery.trim() !== ""
                    ? [`Model: ${filters.modelQuery.trim()}`]
                    : []),
                  ...(filters.projects.size > 0
                    ? [`Project: ${[...filters.projects].join(", ")}`]
                    : []),
                  ...(selectedEnvironmentIds !== null
                    ? [
                        `Machines: ${selectedEnvironments.map((environment) => environment.label).join(", ")}`,
                      ]
                    : []),
                ]}
                refreshKey={machinesRefreshKey}
                onProjectsChange={setProjectOptions}
              />
            ) : showingLimits ? (
              <UsageLimitsSection
                drivers={filters.drivers}
                selectedEnvironmentIds={selectedEnvironmentIds}
                now={limitsNow}
                cursorPrompt={
                  cursorAccessEnvironments.length > 0 ? (
                    <CursorEnableLimits
                      environments={cursorAccessEnvironments}
                      onEnabled={() => {
                        void refresh();
                        void refreshLimits(false, true);
                      }}
                    />
                  ) : null
                }
              />
            ) : isPending ? (
              <UsageSkeleton />
            ) : !canReadDiagnostics ? (
              <div className="space-y-2 py-12 text-center text-sm text-muted-foreground">
                {selectedEnvironments.map((environment) => (
                  <p key={environment.environmentId}>
                    {selectedEnvironments.length > 1 ? `${environment.label}: ` : null}
                    {environment.error}
                  </p>
                ))}
              </div>
            ) : (
              <>
                {sourceMessages.map((message) => (
                  <p key={message} className="mb-4 text-sm text-muted-foreground">
                    {message}
                  </p>
                ))}
                <section className="grid gap-6 lg:grid-cols-[minmax(0,19rem)_minmax(0,1fr)]">
                  <div className="flex min-w-0 flex-col gap-5">
                    <div className="flex flex-col gap-1">
                      <h2 className="text-xs font-medium text-muted-foreground">
                        Measured {metric === "cost" ? "API-equivalent value" : "processed tokens"}
                      </h2>
                      <span className="text-4xl font-semibold text-foreground tabular-nums">
                        {metric === "cost" ? estimate.text : formatTokens(merged.totalTokens)}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {filters.period
                          ? `${formatCount(merged.records)} responses on ${periodLabel}`
                          : `${formatCount(merged.providers.filter((provider) => filters.drivers.size === 0 || selectedKinds.has(provider.provider)).reduce((sum, provider) => sum + provider.sessions, 0))} sessions`}
                        {metric === "cost" ? " · API-equivalent estimate, not a bill" : null}
                        {metric === "cost" && merged.costQuality.unpricedShare > 0 ? (
                          <span className="mt-1 block">
                            Excludes {formatPercent(merged.costQuality.unpricedShare)} unpriced
                            records.
                          </span>
                        ) : null}
                      </span>
                    </div>

                    {[...presentations].some(
                      ([id, presentation]) =>
                        (selectedEnvironmentIds === null || selectedEnvironmentIds.has(id)) &&
                        presentation.serverConfig?.providers.some(usesChatGptSharing),
                    ) ? (
                      <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                        <span>ChatGPT shared usage</span>
                        <ChatGptUsageButton size="xs" />
                      </div>
                    ) : null}

                    {summaryRows.map((row) => {
                      if (row.kind === "enable") {
                        return (
                          <CursorEnableRow
                            key={`enable:${row.environment.environmentId}`}
                            environmentId={row.environment.environmentId}
                            label={row.environment.label}
                            showEnvironment={selectedEnvironments.length > 1}
                            onEnabled={() => {
                              void refresh();
                              void refreshLimits(false, true);
                            }}
                          />
                        );
                      }
                      const provider = row.provider;
                      const totals = merged.providers.find((entry) => entry.provider === provider);
                      const share =
                        metric === "cost" ? (totals?.costShare ?? 0) : (totals?.tokenShare ?? 0);
                      const providerSessions = filters.period
                        ? (totals?.records ?? 0)
                        : (totals?.sessions ?? 0);
                      const sessionLabel = `${formatCount(providerSessions)} ${
                        filters.period
                          ? "responses"
                          : providerSessions === 1
                            ? "session"
                            : "sessions"
                      }`;
                      return (
                        <button
                          key={provider}
                          type="button"
                          aria-label={`Filter ${PROVIDER_PRESENTATION[provider].label}`}
                          aria-pressed={selectedKinds.has(provider)}
                          onClick={() =>
                            setFilters((current) => ({
                              ...current,
                              drivers: toggleUsageProvider(
                                current.drivers,
                                driverOfUsageKind(provider),
                                availableProviders.map(driverOfUsageKind),
                              ),
                            }))
                          }
                          className={cn(
                            "flex flex-col gap-1 rounded-md p-2 -mx-2 text-left hover:bg-muted/50 focus-visible:outline-2 focus-visible:outline-ring",
                            selectedKinds.has(provider) && "bg-muted",
                          )}
                        >
                          <div className="flex items-baseline justify-between gap-4">
                            <span className="flex min-w-0 items-center gap-2 text-sm text-foreground">
                              <span
                                aria-hidden
                                className="size-2 shrink-0 rounded-full"
                                style={{
                                  backgroundColor: PROVIDER_PRESENTATION[provider].color,
                                }}
                              />
                              <ProviderMark provider={provider} className="size-4" />
                              <span className="flex min-w-0 items-baseline gap-1.5">
                                <span className="truncate">
                                  {PROVIDER_PRESENTATION[provider].label}
                                </span>
                              </span>
                            </span>
                            <span className="shrink-0 text-sm font-medium text-foreground tabular-nums">
                              {metric === "cost"
                                ? costText(totals).text
                                : formatTokens(totals?.totalTokens ?? 0)}
                            </span>
                          </div>
                          <span className="text-xs text-muted-foreground">
                            {metric === "cost"
                              ? `${costText(totals).text === "Unpriced" ? "Cost unpriced" : `${formatPercent(share)} of priced cost`} · ${formatTokens(totals?.totalTokens ?? 0)} tokens`
                              : `${formatPercent(share)} of tokens · ${costText(totals).text}`}
                          </span>
                          <Tooltip>
                            <TooltipTrigger
                              render={<span className="text-2xs text-muted-foreground" />}
                            >
                              {sessionLabel}
                              {rangeIsPast ? null : (
                                <>
                                  {" · "}
                                  {
                                    BILLING_MODE_LABEL[
                                      billing.byProvider.get(provider)?.mode ?? "unknown"
                                    ]
                                  }{" "}
                                  now
                                </>
                              )}
                              <span className="sr-only">
                                {". "}
                                {
                                  BILLING_MODE_DESCRIPTION[
                                    billing.byProvider.get(provider)?.mode ?? "unknown"
                                  ]
                                }
                              </span>
                            </TooltipTrigger>
                            <TooltipPopup>
                              {
                                BILLING_MODE_DESCRIPTION[
                                  billing.byProvider.get(provider)?.mode ?? "unknown"
                                ]
                              }
                            </TooltipPopup>
                          </Tooltip>
                        </button>
                      );
                    })}
                  </div>

                  <div className="flex min-w-0 flex-col gap-3">
                    <h2 className="text-sm font-medium text-foreground">
                      {isPast24Hours ? "Hourly" : "Daily"}{" "}
                      {metric === "tokens" ? "processed tokens" : "API-equivalent cost"}
                    </h2>
                    <UsageProviderChart
                      selectedPeriod={
                        filters.period === null
                          ? null
                          : filters.period.kind === "day"
                            ? filters.period.day
                            : filters.period.hourStart
                      }
                      onSelectPeriod={(period) =>
                        setFilters((current) => ({
                          ...current,
                          period:
                            period === null
                              ? null
                              : isPast24Hours
                                ? { kind: "hour", hourStart: period }
                                : { kind: "day", day: period },
                        }))
                      }
                      providers={providersWithUsage(chartMerged.providers)}
                      days={days}
                      daily={chartMerged.daily}
                      hours={hours}
                      hourly={chartMerged.hourly}
                      metric={metric}
                      referenceTime={window.untilTime}
                      resolution={isPast24Hours ? "hour" : "day"}
                      timeZone={window.timeZone}
                    />
                  </div>
                </section>

                {rangeIsPast ? null : (
                  <UsageOutlook
                    result={forecast}
                    metric={metric === "tokens" ? "tokens" : "cost"}
                    timeZone={window.timeZone}
                  />
                )}
                {metric === "cost" && !rangeIsPast ? (
                  <UsageCostBasis
                    estimateText={estimate.text}
                    quality={merged.costQuality}
                    billing={[...billing.byProvider.values()].filter(
                      (entry) => filters.drivers.size === 0 || selectedKinds.has(entry.provider),
                    )}
                    nowMs={billingNow}
                    onOpenLimits={() => selectMetric("limits")}
                  />
                ) : null}
                {billing.untracked.length > 0 ? (
                  <p className="text-xs text-muted-foreground">
                    <span className="font-medium text-foreground">Not in these totals: </span>
                    {billing.untracked.join(", ")}. These providers do not report readable token
                    history here.
                  </p>
                ) : null}
                <section className="flex flex-col gap-2">
                  <h2 className="text-sm font-medium text-foreground">Totals</h2>
                  <div className="grid grid-cols-2 gap-x-6 gap-y-4 py-1 md:grid-cols-5">
                    <Metric label="Processed tokens" value={formatTokens(merged.totalTokens)} />
                    <Metric label="Cached input" value={formatTokens(merged.cachedInputTokens)} />
                    <Metric
                      label="Uncached input"
                      value={formatTokens(merged.uncachedInputTokens)}
                    />
                    <Metric label="Output" value={formatTokens(merged.outputTokens)} />
                    <Metric
                      label="Cache savings at API rates"
                      value={
                        merged.costQuality.unpricedShare === 1
                          ? "Unpriced"
                          : `${merged.costQuality.unpricedShare > 0 ? "≥ " : ""}${formatUsd(merged.costQuality.cacheSavingsUsd)}`
                      }
                    />
                  </div>
                </section>

                {merged.totalTokens > 0 ? (
                  <section
                    className={cn(
                      "grid gap-6 rounded-xl border border-border p-4 sm:p-5",
                      metric === "cost" &&
                        merged.speedCost.fast + merged.speedCost.ultrafast > 0 &&
                        "xl:grid-cols-2",
                    )}
                  >
                    {metric === "tokens" ? (
                      <UsageShareBar
                        label="Tokens by type"
                        segments={tokenTypeSegments(merged)}
                        format={formatTokens}
                      />
                    ) : (
                      <>
                        {merged.costUsd === 0 ? (
                          <p className="text-xs text-muted-foreground">
                            No nonzero priced cost is available to allocate by type.
                          </p>
                        ) : null}
                        <UsageShareBar
                          label="API-equivalent cost by type"
                          aside={
                            merged.costQuality.unpricedShare > 0 ? (
                              <span className="text-2xs text-muted-foreground">
                                Priced portion only
                              </span>
                            ) : undefined
                          }
                          segments={costTypeSegments(merged.categoryCost)}
                          format={(value) =>
                            `${merged.costQuality.unpricedShare > 0 ? "≥ " : ""}${formatUsd(value)}`
                          }
                        />
                        {merged.speedCost.fast + merged.speedCost.ultrafast > 0 ? (
                          <UsageShareBar
                            label="Cost by speed"
                            segments={speedCostSegments(merged.speedCost)}
                            format={(value) =>
                              `${merged.costQuality.unpricedShare > 0 ? "≥ " : ""}${formatUsd(value)}`
                            }
                            aside={
                              <SpeedPremium
                                premiumUsd={merged.speedCost.premium}
                                partial={merged.costQuality.unpricedShare > 0}
                              />
                            }
                          />
                        ) : null}
                      </>
                    )}
                  </section>
                ) : null}

                <section className="flex flex-col gap-3">
                  <div className="flex items-center justify-between gap-3">
                    <h2 className="text-sm font-medium text-foreground">
                      {breakdown === "model"
                        ? "Model breakdown"
                        : isPast24Hours
                          ? "Hourly breakdown"
                          : "Daily breakdown"}
                    </h2>
                    <ToggleGroup
                      aria-label="Usage breakdown"
                      variant="segmented"
                      value={[breakdown]}
                      onValueChange={(next) => {
                        const value = next[0];
                        if (value === "model" || value === "time") setBreakdown(value);
                      }}
                    >
                      {(
                        [
                          { value: "model", label: "Model" },
                          { value: "time", label: isPast24Hours ? "Hour" : "Day" },
                        ] as const
                      ).map((option) => (
                        <Toggle key={option.value} value={option.value}>
                          {option.label}
                        </Toggle>
                      ))}
                    </ToggleGroup>
                  </div>

                  {breakdown === "model" ? (
                    <UsageModelTable
                      models={filteredModels}
                      metric={metric === "tokens" ? "tokens" : "cost"}
                      onSelect={setSelectedModelKey}
                    />
                  ) : (
                    <table className="w-full table-fixed text-sm">
                      <colgroup>
                        <col className="w-2/5" />
                        {activeProviders.map((provider) => (
                          <col key={provider} style={{ width: timeValueColumnWidth }} />
                        ))}
                        <col style={{ width: timeValueColumnWidth }} />
                        <col style={{ width: timeValueColumnWidth }} />
                      </colgroup>
                      <thead>
                        <tr className="border-b border-border text-left text-xs text-muted-foreground">
                          <th className="py-2 font-normal">{isPast24Hours ? "Hour" : "Day"}</th>
                          {activeProviders.map((provider) => (
                            <th key={provider} className="py-2 text-right font-normal">
                              {PROVIDER_PRESENTATION[provider].label}
                            </th>
                          ))}
                          <th className="py-2 text-right font-normal">Total</th>
                          <th className="py-2 text-right font-normal">Tokens</th>
                        </tr>
                      </thead>
                      <tbody>
                        {breakdownPeriods.length === 0 ? (
                          <tr>
                            <td
                              colSpan={activeProviders.length + 3}
                              className="py-6 text-center text-muted-foreground"
                            >
                              No activity in this window.
                            </td>
                          </tr>
                        ) : (
                          breakdownPeriods.map((period) => (
                            <tr
                              key={"hourStart" in period ? period.hourStart : period.day}
                              className="border-b border-border/50 transition-colors hover:bg-muted/50"
                            >
                              <td className="py-2 text-foreground">
                                {"hourStart" in period
                                  ? formatHourShort(period.hourStart, window.timeZone)
                                  : formatDayShort(period.day)}
                              </td>
                              {activeProviders.map((provider) => (
                                <td
                                  key={provider}
                                  className="py-2 text-right text-muted-foreground tabular-nums"
                                >
                                  {costText(period.byProvider.get(provider)).text}
                                </td>
                              ))}
                              <td className="py-2 text-right text-foreground tabular-nums">
                                {costText(period).text}
                              </td>
                              <td className="py-2 text-right text-muted-foreground tabular-nums">
                                {formatTokens(period.totalTokens)}
                              </td>
                            </tr>
                          ))
                        )}
                      </tbody>
                    </table>
                  )}
                </section>
              </>
            )}
          </WorkspacePageContainer>
        </ScrollArea>
      </div>
      {selectedModel !== undefined && !ownsPeriod ? (
        <UsageModelDialog
          model={selectedModel}
          pinnedPeriod={filters.period}
          environments={selectedEnvironments}
          metric={metric === "tokens" ? "tokens" : "cost"}
          chartWindow={{
            days,
            hours,
            resolution: isPast24Hours ? "hour" : "day",
            timeZone: window.timeZone,
            referenceTime: window.untilTime,
          }}
          onSetPrice={() => {
            setSelectedModelKey(null);
            setPriceDialog({ model: selectedModel.model });
          }}
          onClose={() => setSelectedModelKey(null)}
        />
      ) : null}
      {priceDialog ? (
        <UsagePriceOverrides
          usage={environments}
          initialSelectedEnvironmentIds={selectedEnvironmentIds}
          initialModel={priceDialog.model}
          onOpenChange={(open) => {
            if (!open) setPriceDialog(null);
          }}
        />
      ) : null}
    </>
  );

  if (sheet) {
    // Like Settings: the sections on the left, the page on the right.
    const nav = (
      <SidebarContent className="overflow-x-hidden">
        <SidebarGroup>
          <nav aria-label="Usage sections">
            <SidebarMenu>
              {METRIC_OPTIONS.map((option) => {
                const Icon = METRIC_ICONS[option.value];
                const active = option.value === metric;
                return (
                  <SidebarMenuItem key={option.value}>
                    <SidebarMenuButton
                      isActive={active}
                      aria-current={active ? "page" : undefined}
                      title={shortcutTitle(option)}
                      onClick={() => selectMetric(option.value)}
                    >
                      <Icon />
                      <span className="truncate">{option.label}</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          </nav>
        </SidebarGroup>
      </SidebarContent>
    );
    return (
      <AppSheet
        title="Usage"
        nav={nav}
        closeLabel="Close usage"
        slot="usage-sheet"
        popupProps={{ "data-usage-sheet": "" }}
        focusSheetFirst
        headerWraps
        header={topbarContent}
        onClose={() => onClose?.()}
      >
        {body}
      </AppSheet>
    );
  }
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none isolate">
      {body}
    </SidebarInset>
  );
}

const METRIC_ICONS: Record<UsageMetric, typeof CircleDollarSignIcon> = {
  cost: CircleDollarSignIcon,
  tokens: CoinsIcon,
  limits: GaugeIcon,
  machines: MonitorIcon,
  delivered: PackageCheckIcon,
};

function Metric({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="text-base font-medium text-foreground tabular-nums">{value}</span>
    </div>
  );
}

function UsageSkeleton() {
  return (
    <>
      <section className="grid gap-6 lg:grid-cols-[minmax(0,18rem)_minmax(0,1fr)]">
        <div className="flex flex-col gap-5">
          <div className="flex flex-col gap-1">
            <Skeleton className="h-10 w-36" />
            <Skeleton className="h-4 w-32" />
          </div>
          {PROVIDER_ORDER.map((provider) => (
            <div key={provider} className="flex flex-col gap-1">
              <div className="flex min-h-5 items-center justify-between gap-4">
                <span className="flex items-center gap-2">
                  <Skeleton shape="pill" className="size-2 shrink-0" />
                  <Skeleton shape="pill" className="size-4 shrink-0" />
                  <Skeleton className="h-3.5 w-20" />
                </span>
                <Skeleton className="h-3.5 w-14" />
              </div>
              <Skeleton className="h-4 w-36" />
            </div>
          ))}
        </div>

        <div className="flex flex-col gap-3">
          <Skeleton className="h-5 w-24" />
          <div className="flex flex-col gap-1">
            <Skeleton className="ml-16 h-56" />
            <Skeleton className="ml-16 h-4" />
          </div>
        </div>
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-medium text-foreground">Totals</h2>
        <MetricSkeletons
          labels={["Processed tokens", "Cached input", "Uncached input", "Output", "Cache savings"]}
        />
      </section>

      <section className="grid gap-x-12 gap-y-8 lg:grid-cols-2">
        <div className="flex flex-col gap-2.5">
          <Skeleton className="h-5 w-28" />
          <Skeleton className="h-2" />
          <Skeleton className="h-4 w-72" />
        </div>
      </section>

      <section className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-sm font-medium text-foreground">Breakdown</h2>
          <Skeleton shape="card" className="h-7 w-28" />
        </div>
        <Skeleton className="h-44" />
      </section>
    </>
  );
}

function MetricSkeletons({ labels }: { readonly labels: readonly string[] }) {
  return (
    <div className="grid grid-cols-2 gap-x-6 gap-y-4 py-1 md:grid-cols-5">
      {labels.map((label) => (
        <div key={label} className="flex flex-col gap-0.5">
          <span className="text-xs text-muted-foreground">{label}</span>
          <Skeleton className="h-6 w-16" />
        </div>
      ))}
    </div>
  );
}
