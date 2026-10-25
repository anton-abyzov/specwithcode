import { ChatGptUsageButton } from "../settings/ChatGptUsageButton";
import { usesChatGptSharing } from "@specweave-studio/shared/usageLimits";
import { RefreshIcon } from "~/components/ui/refresh-icon";
import { useAtomValue } from "@effect/atom-react";
import {
  ProviderDriverKind,
  USAGE_CONTRACT_VERSION,
  type EnvironmentId,
  type UsageProviderKind,
} from "@specweave-studio/contracts";
import {
  CircleAlertIcon,
  ChevronDownIcon,
  CircleDashedIcon,
  SlidersHorizontalIcon,
} from "lucide-react";
import { useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import {
  cursorKeychainAccessEnvironments,
  refreshUsageLimits,
} from "@specweave-studio/client-runtime/state/usage";

import {
  isCompatibleUsageContractVersion,
  type DailyTotals,
  type HourlyTotals,
  type MergedUsage,
} from "@specweave-studio/shared/usageMerge";

import { isElectron } from "../../env";
import { cn } from "../../lib/utils";
import { environmentPresentations } from "../../state/presentation";
import { primaryServerKeybindingsAtom, serverEnvironment } from "../../state/server";
import { isCommandPaletteOpen } from "../../commandPaletteBus";
import { isModelPickerOpen } from "../../modelPickerVisibility";
import { shortcutLabelForCommand } from "../../keybindings";
import { mergeAnsweredUsage, useUsage, type EnvironmentUsageStatus } from "../../state/usage";
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
  formatUsageContractMismatch,
  formatUsd,
  makeWindow,
} from "@specweave-studio/shared/usageFormat";
import { Button, InlineButton } from "../ui/button";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import {
  Menu,
  MenuCheckboxItem,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";
import { ScrollArea } from "../ui/scroll-area";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { AppSheet } from "../ui/app-sheet";
import { SidebarInset } from "../ui/sidebar";
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
import { UsageLimitsSection } from "./UsageLimits";
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
import { UsageFilterBar } from "./UsageFilterBar";
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

function isUsageWindowDays(value: number): value is UsagePagePreferences["windowDays"] {
  return WINDOW_OPTIONS.some((option) => option.days === value);
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
  const [windowSelection, setWindowSelection] = useState(() => ({
    days: preferences.windowDays,
    window: makeWindow(
      preferences.windowDays,
      undefined,
      preferences.windowDays === 1 ? "hour" : "day",
    ),
  }));
  const metric = preferences.metric;
  const showingLimits = metric === "limits";
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [limitsNow, setLimitsNow] = useState(() => Date.now());
  const refreshingRef = useRef(false);
  const [breakdown, setBreakdown] = useState<"model" | "time">("model");
  const [priceDialog, setPriceDialog] = useState<{ readonly model?: string } | null>(null);
  const [selectedModelKey, setSelectedModelKey] = useState<string | null>(null);
  const [selectedEnvironmentIds, setSelectedEnvironmentIds] =
    useState<ReadonlySet<EnvironmentId> | null>(null);
  const { days: windowDays, window } = windowSelection;
  const isPast24Hours = windowDays === 1;
  const {
    merged: fullMerged,
    environments,
    selectedEnvironments,
    isPending,
    isPartial,
    refresh,
  } = useUsage(window, selectedEnvironmentIds);
  const presentations = useAtomValue(environmentPresentations.presentationsAtom);
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
        providers: filters.providers,
        nowMs: billingNow,
        partial: isPartial,
        pinned: filters.period !== null,
      }),
    [
      chartMerged,
      selectedEnvironments,
      window,
      filters.providers,
      filters.period,
      billingNow,
      isPartial,
    ],
  );
  const periodLabel =
    filters.period === null
      ? null
      : filters.period.kind === "day"
        ? formatDayShort(filters.period.day)
        : formatHourShort(filters.period.hourStart, window.timeZone);
  const cursorAccessEnvironments = cursorKeychainAccessEnvironments(selectedEnvironments);
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

  const selectWindow = (days: number) => {
    if (!isUsageWindowDays(days)) return;
    setFilters((current) => ({ ...current, period: null }));
    const nextPreferences = { metric, windowDays: days };
    setPreferences(nextPreferences);
    saveUsagePagePreferences(nextPreferences);
    setWindowSelection({
      days,
      window: makeWindow(days, undefined, days === 1 ? "hour" : "day"),
    });
  };
  const selectMetric = (nextMetric: UsageMetric) => {
    if (nextMetric === "limits") setLimitsNow(Date.now());
    const nextPreferences = { metric: nextMetric, windowDays };
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
              () => refreshProviders({ environmentId, input: {} }),
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
    if (periodOption && !showingLimits) selectWindow(periodOption.days);
  });

  useEffect(() => {
    globalThis.window.addEventListener("keydown", onUsageKeyDown, true);
    return () => globalThis.window.removeEventListener("keydown", onUsageKeyDown, true);
  }, []);

  const refreshWindow = () => {
    if (refreshingRef.current) return;

    if (showingLimits) {
      refreshingRef.current = true;
      setIsRefreshing(true);
      void refreshLimits().finally(() => {
        refreshingRef.current = false;
        setIsRefreshing(false);
      });
      return;
    }
    const nextWindow = makeWindow(windowDays, undefined, isPast24Hours ? "hour" : "day");
    if (
      nextWindow.sinceDay !== window.sinceDay ||
      nextWindow.untilDay !== window.untilDay ||
      nextWindow.sinceTime !== window.sinceTime ||
      nextWindow.untilTime !== window.untilTime
    ) {
      setWindowSelection({ days: windowDays, window: nextWindow });
      // A refreshed rolling window can drop the pinned day or hour.
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
    if (showingLimits && connectedLimitsEnvironments) autoRefreshLimits();
  }, [showingLimits, connectedLimitsEnvironments]);

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
            showUsageStatus={!showingLimits}
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
        {/* The period does not apply to Limits, so it stays in place but
            disabled; unmounting it shifted the metric toggle ~300px. */}
        <ToggleGroup
          aria-label="Usage period"
          variant="segmented"
          value={[String(windowDays)]}
          disabled={showingLimits}
          onValueChange={(next) => {
            const value = next[0];
            if (value) selectWindow(Number(value));
          }}
        >
          {WINDOW_OPTIONS.map((option) => (
            <Toggle key={option.days} value={String(option.days)} title={shortcutTitle(option)}>
              {option.label}
            </Toggle>
          ))}
        </ToggleGroup>
        <Button
          onClick={refreshWindow}
          aria-label={showingLimits ? "Refresh limits" : "Refresh usage"}
          aria-busy={isRefreshing}
          disabled={isRefreshing || (!showingLimits && !canReadDiagnostics)}
          size="icon-sm"
          variant="ghost"
        >
          <RefreshIcon size="sm" refreshing={isRefreshing} />
        </Button>
      </div>
      <div className="col-span-2 ms-auto flex min-w-0 items-center justify-end gap-1 xl:hidden">
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
        <Select
          value={String(windowDays)}
          disabled={showingLimits}
          onValueChange={(value) => selectWindow(Number(value))}
        >
          <SelectTrigger
            aria-label="Usage period"
            size="compact"
            variant="ghost"
            className="w-auto min-w-0"
          >
            <SelectValue>
              {WINDOW_OPTIONS.find((option) => option.days === windowDays)?.label}
            </SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            {WINDOW_OPTIONS.map((option) => (
              <SelectItem
                key={option.days}
                value={String(option.days)}
                title={shortcutTitle(option)}
              >
                {option.label}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
        <Button
          onClick={refreshWindow}
          aria-label={showingLimits ? "Refresh limits" : "Refresh usage"}
          aria-busy={isRefreshing}
          disabled={isRefreshing || (!showingLimits && !canReadDiagnostics)}
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
            {selectedEnvironments.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {environments.length === 0
                  ? `Connect an environment to see ${showingLimits ? "limits" : "usage"}.`
                  : `Select an environment to see ${showingLimits ? "limits" : "usage"}.`}
              </p>
            ) : showingLimits ? (
              <UsageLimitsSection
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
                <UsageFilterBar
                  filters={filters}
                  setFilters={setFilters}
                  periodLabel={periodLabel}
                />
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
                          : `${formatCount(merged.providers.filter((provider) => filters.providers.size === 0 || filters.providers.has(provider.provider)).reduce((sum, provider) => sum + provider.sessions, 0))} sessions`}
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
                          aria-pressed={filters.providers.has(provider)}
                          onClick={() =>
                            setFilters((current) => ({
                              ...current,
                              providers: toggleUsageProvider(
                                current.providers,
                                provider,
                                availableProviders,
                              ),
                            }))
                          }
                          className={cn(
                            "flex flex-col gap-1 rounded-md p-2 -mx-2 text-left hover:bg-muted/50 focus-visible:outline-2 focus-visible:outline-ring",
                            filters.providers.has(provider) && "bg-muted",
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
                              {sessionLabel} ·{" "}
                              {
                                BILLING_MODE_LABEL[
                                  billing.byProvider.get(provider)?.mode ?? "unknown"
                                ]
                              }{" "}
                              now
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

                <UsageOutlook
                  result={forecast}
                  metric={metric === "tokens" ? "tokens" : "cost"}
                  timeZone={window.timeZone}
                />
                {metric === "cost" ? (
                  <UsageCostBasis
                    estimateText={estimate.text}
                    quality={merged.costQuality}
                    billing={[...billing.byProvider.values()].filter(
                      (entry) =>
                        filters.providers.size === 0 || filters.providers.has(entry.provider),
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
                    <input
                      aria-label="Search models"
                      placeholder="Search models…"
                      type="search"
                      value={filters.modelQuery}
                      onChange={(event) =>
                        setFilters((current) => ({ ...current, modelQuery: event.target.value }))
                      }
                      onKeyDown={(event) => {
                        // Escape clears the search; it must not leave the page or unpin.
                        if (event.key !== "Escape" || filters.modelQuery === "") return;
                        event.preventDefault();
                        event.stopPropagation();
                        setFilters((current) => ({ ...current, modelQuery: "" }));
                      }}
                      className="w-full max-w-sm rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    />
                  ) : null}
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
      {selectedModel !== undefined && !showingLimits ? (
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
    return (
      <AppSheet
        title="Usage"
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

const CURSOR_KEYCHAIN_COPY = "Requires access to your Cursor login in macOS Keychain.";

function CursorEnableButton({
  environmentId,
  label,
  onEnabled,
  tooltip,
  buttonText = "Enable",
}: {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly onEnabled: () => void;
  readonly tooltip: boolean;
  readonly buttonText?: string;
}) {
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, {
    label: "enable Cursor account usage",
  });
  const [pending, setPending] = useState(false);
  const enable = async () => {
    setPending(true);
    try {
      const result = await updateSettings({
        environmentId,
        input: { patch: { cursorKeychainUsageEnabled: true } },
      });
      if (result._tag === "Success") onEnabled();
    } finally {
      setPending(false);
    }
  };
  const button = tooltip ? (
    <InlineButton
      disabled={pending}
      aria-busy={pending}
      aria-label={`Enable Cursor usage from ${label}`}
      onClick={() => void enable()}
    >
      {buttonText}
    </InlineButton>
  ) : (
    <Button
      size="sm"
      variant="outline"
      disabled={pending}
      aria-busy={pending}
      aria-label={`Enable Cursor usage from ${label}`}
      onClick={() => void enable()}
    >
      {buttonText}
    </Button>
  );
  if (!tooltip) return button;
  return (
    <Tooltip>
      <TooltipTrigger render={button} />
      <TooltipPopup>{CURSOR_KEYCHAIN_COPY}</TooltipPopup>
    </Tooltip>
  );
}

function CursorEnableRow({
  environmentId,
  label,
  showEnvironment,
  onEnabled,
}: {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly showEnvironment: boolean;
  readonly onEnabled: () => void;
}) {
  return (
    <div className="flex min-w-0 items-baseline justify-between gap-4 text-sm">
      <span className="flex min-w-0 items-center gap-2 text-sm text-foreground">
        <span
          aria-hidden
          className="size-2 shrink-0 rounded-full"
          style={{ backgroundColor: PROVIDER_PRESENTATION.cursor.color }}
        />
        <ProviderMark provider="cursor" className="size-4" />
        <span className="truncate">Cursor{showEnvironment ? ` · ${label}` : ""}</span>
      </span>
      <CursorEnableButton
        environmentId={environmentId}
        label={label}
        onEnabled={onEnabled}
        tooltip
      />
    </div>
  );
}

function CursorEnableLimits({
  environments,
  onEnabled,
}: {
  readonly environments: readonly EnvironmentUsageStatus[];
  readonly onEnabled: () => void;
}) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="flex items-center gap-2 text-sm font-medium text-foreground">
        <ProviderInstanceIcon
          driverKind={ProviderDriverKind.make("cursor")}
          displayName="Cursor"
          indicatorBackground="var(--background)"
          className="size-5"
          iconClassName="size-4 text-foreground/80"
        />
        Cursor
      </h2>
      <div className="flex flex-col items-start gap-3 rounded-lg border border-border/60 p-4">
        <p className="text-xs text-muted-foreground">{CURSOR_KEYCHAIN_COPY}</p>
        <div className="flex flex-wrap gap-2">
          {environments.map((environment) => (
            <CursorEnableButton
              key={environment.environmentId}
              environmentId={environment.environmentId}
              label={environment.label}
              buttonText={environments.length > 1 ? `Enable on ${environment.label}` : "Enable"}
              onEnabled={onEnabled}
              tooltip={false}
            />
          ))}
        </div>
      </div>
    </section>
  );
}

/** Brand mark for the harness a row belongs to. */
function ProviderMark({
  provider,
  className,
}: {
  readonly provider: UsageProviderKind;
  readonly className: string;
}) {
  const presentation = PROVIDER_PRESENTATION[provider];
  return (
    <ProviderInstanceIcon
      driverKind={presentation.driverKind}
      displayName={presentation.label}
      iconClassName={className}
    />
  );
}

function Metric({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="text-base font-medium text-foreground tabular-nums">{value}</span>
    </div>
  );
}

/**
 * Explains failed or incompatible environments and deduplicated transcripts.
 * Shown inside the environment filter so arriving results do not move the page.
 */
function UsageCoverageNotice({
  environments,
  duplicateSources,
  contractMismatches,
}: {
  readonly environments: readonly EnvironmentUsageStatus[];
  readonly duplicateSources: readonly string[];
  readonly contractMismatches: MergedUsage["contractMismatches"];
}) {
  const failed = environments.filter((environment) => environment.error !== null);
  const mismatchByEnvironment = new Map(
    contractMismatches.map((mismatch) => [mismatch.environmentId, mismatch]),
  );
  const incompatible = environments.flatMap((environment) => {
    const mismatch = mismatchByEnvironment.get(environment.environmentId);
    return mismatch === undefined ? [] : [{ environment, mismatch }];
  });
  if (failed.length === 0 && incompatible.length === 0 && duplicateSources.length === 0) {
    return null;
  }

  return (
    <div className="flex flex-col gap-1 border-t border-border px-2 py-2 text-xs text-muted-foreground">
      {failed.map((environment) => (
        <span key={environment.label}>
          {environment.label}: {environment.error}
        </span>
      ))}
      {incompatible.map(({ environment, mismatch }) => (
        <span key={environment.environmentId}>
          {formatUsageContractMismatch(environment.label, mismatch)}
        </span>
      ))}
      {duplicateSources.length > 0 ? (
        <span>
          Counted once across environments sharing a transcript directory:{" "}
          {duplicateSources.join(", ")}
        </span>
      ) : null}
    </div>
  );
}

/** Environment selection and scan progress share a permanent header control. */
function UsageEnvironmentFilter({
  environments,
  selectedEnvironments,
  selectedEnvironmentIds,
  onSelectionChange,
  showUsageStatus,
  isPartial,
  duplicateSources,
  contractMismatches,
  onOpenModelPrices,
}: {
  readonly environments: readonly EnvironmentUsageStatus[];
  readonly selectedEnvironments: readonly EnvironmentUsageStatus[];
  readonly selectedEnvironmentIds: ReadonlySet<EnvironmentId> | null;
  readonly onSelectionChange: (ids: ReadonlySet<EnvironmentId> | null) => void;
  readonly showUsageStatus: boolean;
  readonly isPartial: boolean;
  readonly duplicateSources: readonly string[];
  readonly contractMismatches: MergedUsage["contractMismatches"];
  readonly onOpenModelPrices: () => void;
}) {
  const allSelected = selectedEnvironmentIds === null;
  const label = allSelected
    ? "All environments"
    : selectedEnvironments.length === 1
      ? selectedEnvironments[0]!.label
      : `${selectedEnvironments.length} environments`;
  const pendingCount = selectedEnvironments.filter(
    (environment) =>
      environment.error === null && (environment.isPending || environment.summary === null),
  ).length;
  const hasIssue =
    selectedEnvironments.some((environment) => environment.error !== null) ||
    contractMismatches.length > 0;

  return (
    <Menu>
      <MenuTrigger render={<InlineButton />} className="group/usage-environment min-w-0 max-w-full">
        <span className="min-w-0 truncate">{label}</span>
        <span className="flex size-3.5 shrink-0 items-center justify-center text-muted-foreground">
          {showUsageStatus && pendingCount > 0 ? (
            <>
              <CircleDashedIcon className="size-3.5" aria-hidden />
              <span className="sr-only">
                {pendingCount} {pendingCount === 1 ? "environment" : "environments"} still scanning
                {isPartial ? "; totals are partial" : ""}
              </span>
            </>
          ) : showUsageStatus && hasIssue ? (
            <CircleAlertIcon
              className="size-3.5 text-warning-foreground"
              aria-label="Some environments could not report usage"
            />
          ) : (
            <ChevronDownIcon
              className="size-3.5 opacity-0 transition-opacity group-hover/usage-environment:opacity-100 group-focus-visible/usage-environment:opacity-100 group-data-popup-open/usage-environment:opacity-100"
              aria-hidden
            />
          )}
        </span>
      </MenuTrigger>
      <MenuPopup align="start">
        <MenuCheckboxItem
          checked={allSelected}
          closeOnClick={false}
          onCheckedChange={(checked) => onSelectionChange(checked ? null : new Set())}
        >
          All environments
        </MenuCheckboxItem>
        <MenuSeparator />
        {environments.map((environment) => {
          const checked =
            selectedEnvironmentIds === null ||
            selectedEnvironmentIds.has(environment.environmentId);
          const status =
            environment.error !== null
              ? "Unavailable"
              : environment.summary !== null &&
                  !isCompatibleUsageContractVersion(
                    environment.summary.contractVersion,
                    USAGE_CONTRACT_VERSION,
                  )
                ? "Update required"
                : environment.summary === null
                  ? "Scanning…"
                  : environment.isPending
                    ? "Refreshing…"
                    : "Ready";
          return (
            <MenuCheckboxItem
              key={environment.environmentId}
              checked={checked}
              closeOnClick={false}
              onCheckedChange={(nextChecked) => {
                const next = new Set(selectedEnvironments.map((entry) => entry.environmentId));
                if (nextChecked) next.add(environment.environmentId);
                else next.delete(environment.environmentId);
                onSelectionChange(next.size === environments.length ? null : next);
              }}
            >
              <span className="flex min-w-0 items-center gap-3">
                <span className="min-w-0 flex-1 truncate">{environment.label}</span>
                {showUsageStatus ? (
                  <span
                    className={cn(
                      "shrink-0 text-xs text-muted-foreground",
                      environment.error !== null && "text-destructive-foreground",
                    )}
                  >
                    {status}
                  </span>
                ) : null}
              </span>
            </MenuCheckboxItem>
          );
        })}
        {environments.length === 0 ? (
          <p className="px-2 py-2 text-xs text-muted-foreground">No environments connected.</p>
        ) : null}
        {showUsageStatus && isPartial ? (
          <p className="px-2 py-2 text-xs text-muted-foreground">
            Totals are partial while selected environments scan.
          </p>
        ) : null}
        {showUsageStatus ? (
          <UsageCoverageNotice
            environments={selectedEnvironments}
            duplicateSources={duplicateSources}
            contractMismatches={contractMismatches}
          />
        ) : null}
        <MenuSeparator />
        <MenuItem onClick={onOpenModelPrices}>
          <SlidersHorizontalIcon aria-hidden />
          Model prices
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
}

/**
 * Stand-in with the loaded page's shape, using the shared `Skeleton` bars so it
 * breathes with the same `animate-skeleton` pulse as every other loading state.
 * Replaced by results as soon as the first environment answers.
 */
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
