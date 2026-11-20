import { useAtomValue } from "@effect/atom-react";
import {
  AuthDiagnosticsReadScope,
  type EnvironmentId,
  type UsageDay,
  type UsageLimitHistorySeries,
  type UsageSummary,
} from "@specweave-studio/contracts";
import {
  formatDateTimeShort,
  formatDayShort,
  formatPercent,
  formatTokens,
  formatUsd,
} from "@specweave-studio/shared/usageFormat";
import { type ShareReport, measureOf } from "@specweave-studio/shared/usageMachineShare";
import {
  type SharePeriod,
  type SubscriptionView,
  buildSubscriptionViews,
  reportRange,
} from "@specweave-studio/shared/usageMachineShareView";
import { useEffect, useMemo, useState } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { SegmentedControl } from "../../components/SegmentedControl";
import { environmentPresentations } from "../../state/presentation";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentsWithScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  type ByMachineIdentity,
  askableMachines,
  byMachineInputs,
  machineIdentities,
} from "./usageByMachine";

const PERIOD_OPTIONS = [
  { value: "7", label: "7 days" },
  { value: "reset", label: "Since reset" },
  { value: "30", label: "30 days" },
] as const;
type PeriodValue = (typeof PERIOD_OPTIONS)[number]["value"];
const PERIODS: Record<PeriodValue, SharePeriod> = {
  "7": { kind: "days", days: 7 },
  reset: { kind: "reset" },
  "30": { kind: "days", days: 30 },
};

const TIME_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

function instant(atMs: number): string {
  return formatDateTimeShort(new Date(atMs).toISOString());
}

/** One part of a bar. Outside the app is the machine's tint; the estimate is a dashed neutral. */
function Part(props: {
  readonly kind: SubscriptionView["segments"][number]["kind"];
  readonly color: string | null;
  readonly share: number;
}) {
  const { kind, color } = props;
  return (
    <View
      className={
        kind === "outside"
          ? "h-full rounded-[4px] border border-dashed border-foreground-muted bg-subtle"
          : "h-full rounded-[4px]"
      }
      style={[
        { flex: Math.max(props.share, 0.01), minWidth: 4 },
        kind === "outside" || color === null
          ? null
          : kind === "native"
            ? { backgroundColor: `${color}44`, borderColor: color, borderWidth: 1.5 }
            : { backgroundColor: color },
      ]}
    />
  );
}

function estimateText(view: SubscriptionView): string {
  const estimate = view.estimate;
  if (estimate.kind === "unavailable") return `No estimate of use elsewhere. ${estimate.detail}`;
  const tail = `Estimate, ${estimate.confidence} confidence. Limit last read ${instant(estimate.lastCheckedAt)}.`;
  if (!estimate.detected) {
    return `No use outside your machines detected. They explain the ${estimate.consumedPoints} points the limit moved. ${tail}`;
  }
  const share = formatPercent(estimate.outsidePoints / Math.max(estimate.consumedPoints, 1e-9), 0);
  return `About ${share} was used outside your machines: ${estimate.outsidePoints} of the ${estimate.consumedPoints} points the limit moved. ${tail}`;
}

function SubscriptionCard(props: {
  readonly view: SubscriptionView;
  readonly identityOf: (machineId: string) => ByMachineIdentity;
}) {
  const { view, identityOf } = props;
  // Cost, or tokens where none of the subscription's use has a price.
  const measure = view.measure;
  const amount = (value: number) =>
    measure === "tokens" ? `${formatTokens(value)} tokens` : formatUsd(value);
  const outside = view.segments.find((segment) => segment.kind === "outside");
  const summary = view.segments
    .map(
      (segment) =>
        `${segment.machineId === null ? "Outside your machines, estimate" : identityOf(segment.machineId).name} ${formatPercent(segment.share, 0)}`,
    )
    .join(", ");
  return (
    <View className="gap-3 rounded-[24px] border-continuous bg-grouped-card p-4">
      <View className="gap-0.5">
        <View className="flex-row items-baseline justify-between gap-3">
          <Text className="flex-1 text-sm font-studio-medium text-foreground" numberOfLines={1}>
            {view.provider}
            {view.account ? ` · ${view.account}` : ""}
          </Text>
          <Text className="text-sm font-studio-medium tabular-nums text-foreground">
            {amount(measureOf(view.subscription.total, measure))}
          </Text>
        </View>
        <Text className="text-sm text-foreground-muted">
          {view.sinceReset
            ? `Since the limit reset on ${instant(view.period.startMs)}`
            : `${formatDayShort(view.period.sinceDay)} to ${formatDayShort(view.period.untilDay)}`}
          {view.reading ? ` · limit ${Math.round(view.reading.usedPercent)}% used` : ""}
          {view.resetDayWhole
            ? ` · ${formatDayShort(view.period.sinceDay)} is counted as a whole day`
            : ""}
        </Text>
      </View>
      <View
        accessible
        accessibilityRole="image"
        accessibilityLabel={summary === "" ? "No use recorded" : `Split by machine: ${summary}`}
        className="h-7 flex-row gap-0.5"
      >
        {view.segments.length === 0 ? (
          <View className="h-full flex-1 rounded-[4px] bg-subtle" />
        ) : (
          view.segments.map((segment) => (
            <Part
              key={segment.key}
              kind={segment.kind}
              color={segment.machineId === null ? null : identityOf(segment.machineId).color}
              share={segment.share}
            />
          ))
        )}
      </View>
      <View className="gap-2">
        {view.subscription.machines.map((machine) => {
          const identity = identityOf(machine.machineId);
          const share = view.segments
            .filter((segment) => segment.machineId === machine.machineId)
            .reduce((sum, segment) => sum + segment.share, 0);
          const native = measureOf(machine.native, measure);
          const silent = view.subscription.silentHolders.includes(identity.name);
          return (
            <View key={machine.machineId} className="flex-row items-start gap-2">
              <View
                className="mt-1.5 size-2.5 rounded-[2px]"
                style={{ backgroundColor: identity.color }}
              />
              <View className="flex-1">
                <Text className="text-sm text-foreground">{identity.name}</Text>
                <Text className="text-sm text-foreground-muted">
                  {machine.total.requests === 0
                    ? "Signed in, no use in this period"
                    : native > 0
                      ? `${amount(native)} outside the app`
                      : measureOf(machine.unsplit, measure) > 0
                        ? "Older version, not split"
                        : "All in SpecWithCode"}
                  {silent ? " · did not report the whole period" : ""}
                </Text>
              </View>
              <Text className="text-sm tabular-nums text-foreground">
                {amount(measureOf(machine.total, measure))}
              </Text>
              <Text className="w-10 text-right text-sm tabular-nums text-foreground-muted">
                {formatPercent(share, 0)}
              </Text>
            </View>
          );
        })}
        {outside ? (
          <View className="flex-row items-start gap-2">
            <View className="mt-1.5 size-2.5 rounded-[2px] border border-dashed border-foreground-muted bg-subtle" />
            <Text className="flex-1 text-sm text-foreground">Outside your machines (estimate)</Text>
            <Text className="text-sm tabular-nums text-foreground">
              {outside.value === null ? "" : `≈ ${amount(outside.value)}`}
            </Text>
            <Text className="w-10 text-right text-sm tabular-nums text-foreground-muted">
              {formatPercent(outside.share, 0)}
            </Text>
          </View>
        ) : null}
      </View>
      <Text className="text-sm text-foreground-muted">{estimateText(view)}</Text>
    </View>
  );
}

/**
 * Usage > Machines on the phone: each subscription as a bar split by machine,
 * with the estimate of use on no machine. The days and the breakdown stay on
 * the desktop.
 */
export function UsageByMachineSection(props: {
  /** Null selects every machine. */
  readonly selectedEnvironmentIds: ReadonlySet<EnvironmentId> | null;
  /** The screen's usage summaries, for machines that cannot send a report yet. */
  readonly summaries: ReadonlyMap<string, UsageSummary | null>;
  readonly refreshKey: number;
  readonly now: number;
}) {
  const { selectedEnvironmentIds, summaries, refreshKey, now } = props;
  const presentations = useAtomValue(environmentPresentations.presentationsAtom);
  const [periodValue, setPeriodValue] = useState<PeriodValue>("7");
  const period = PERIODS[periodValue];
  const [answers, setAnswers] = useState<ReadonlyMap<string, ShareReport | "failed"> | null>(null);
  const [histories, setHistories] = useState<ReadonlyArray<ReadonlyArray<UsageLimitHistorySeries>>>(
    [],
  );
  const readReport = useAtomCommand(serverEnvironment.usageMachineReport, {
    reportFailure: false,
    reportDefect: false,
  });
  const readHistory = useAtomCommand(serverEnvironment.usageLimitHistory, {
    reportFailure: false,
    reportDefect: false,
  });

  const requested = useMemo(
    () => [...presentations.keys()].map((environmentId) => ({ environmentId })),
    [presentations],
  );
  const permitted = useEnvironmentsWithScope(requested, AuthDiagnosticsReadScope);
  const askKey = askableMachines(presentations, selectedEnvironmentIds, permitted).join("\n");
  const connectedKey = [...presentations]
    .filter(([, presentation]) => presentation.connection.phase === "connected")
    .map(([environmentId]) => environmentId)
    .join("\n");
  const range = reportRange(period, now, TIME_ZONE);

  useEffect(() => {
    let cancelled = false;
    const ids = askKey === "" ? [] : (askKey.split("\n") as EnvironmentId[]);
    void Promise.all(
      ids.map((environmentId) =>
        Promise.resolve(
          readReport({
            environmentId,
            input: {
              sinceDay: range.sinceDay as UsageDay,
              untilDay: range.untilDay as UsageDay,
              timeZone: TIME_ZONE,
            },
          }),
        )
          .then((result): readonly [string, ShareReport | "failed"] => [
            environmentId,
            result?._tag === "Success" ? result.value : "failed",
          ])
          .catch((): readonly [string, ShareReport | "failed"] => [environmentId, "failed"]),
      ),
    ).then((entries) => {
      if (!cancelled) setAnswers(new Map(entries));
    });
    return () => {
      cancelled = true;
    };
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- refreshKey re-reads on refresh.
  }, [askKey, range.sinceDay, range.untilDay, readReport, refreshKey]);

  useEffect(() => {
    let cancelled = false;
    const ids = connectedKey === "" ? [] : (connectedKey.split("\n") as EnvironmentId[]);
    void Promise.all(
      ids.map((environmentId) =>
        Promise.resolve(readHistory({ environmentId, input: { sinceHours: 336 } }))
          .then((result) => (result?._tag === "Success" ? result.value.series : []))
          .catch((): readonly UsageLimitHistorySeries[] => []),
      ),
    ).then((next) => {
      if (!cancelled) setHistories(next);
    });
    return () => {
      cancelled = true;
    };
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- refreshKey re-reads on refresh.
  }, [connectedKey, readHistory, refreshKey]);

  const identityOf = useMemo(() => machineIdentities(presentations), [presentations]);
  const inputs = useMemo(
    () =>
      byMachineInputs({
        presentations,
        selected: selectedEnvironmentIds,
        permitted,
        answers,
        summaries,
      }),
    [presentations, selectedEnvironmentIds, permitted, answers, summaries],
  );
  const scopedWindowIds = useMemo(() => {
    const ids = new Set<string>();
    for (const presentation of presentations.values()) {
      for (const provider of presentation.serverConfig?.providers ?? []) {
        for (const window of provider.usageLimits?.windows ?? []) {
          if (window.modelScope !== undefined) ids.add(window.id);
        }
      }
    }
    return ids;
  }, [presentations]);
  // A signed-in subscription nothing used in the period has nothing to draw.
  const views = useMemo(
    () =>
      buildSubscriptionViews({
        inputs,
        histories,
        scopedWindowIds,
        period,
        measure: "cost",
        now,
        timeZone: TIME_ZONE,
      }).filter((view) => view.segments.length > 0),
    [inputs, histories, scopedWindowIds, period, now],
  );
  const quiet = inputs.filter((input) => input.state !== "live");

  return (
    <View className="gap-4">
      <SegmentedControl
        options={PERIOD_OPTIONS}
        selected={periodValue}
        onSelect={setPeriodValue}
        size="compact"
        className="w-full"
      />
      <Text className="text-sm text-foreground-muted">
        API-equivalent cost of what each machine recorded, per subscription. A machine's colour is
        its own; the lighter part ran outside the app on that machine.
      </Text>
      {quiet.length > 0 ? (
        <Text className="text-sm text-foreground-muted">
          {quiet.map((input) => `${input.name}: ${input.note ?? "no report"}`).join(" · ")}
        </Text>
      ) : null}
      {views.length === 0 ? (
        <Text className="py-8 text-center text-sm text-foreground-muted">
          {askKey !== "" && answers === null
            ? "Asking each machine what it recorded."
            : "No subscription use recorded on these machines in this period."}
        </Text>
      ) : (
        views.map((view) => (
          <SubscriptionCard key={view.accountKey} view={view} identityOf={identityOf} />
        ))
      )}
    </View>
  );
}
