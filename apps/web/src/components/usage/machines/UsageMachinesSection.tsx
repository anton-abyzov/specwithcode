import {
  AuthDiagnosticsReadScope,
  type EnvironmentId,
  type UsageLimitHistorySeries,
  type UsageMachineReport,
} from "@specweave-studio/contracts";
import { useAtomValue } from "@effect/atom-react";
import { usageAccountKey } from "@specweave-studio/shared/usageAccountKey";
import {
  type ShareMachineInput,
  shareMachineInput,
} from "@specweave-studio/shared/usageMachineShare";
import { useEffect, useMemo, useState } from "react";

import { environmentPresentations } from "../../../state/presentation";
import { serverEnvironment } from "../../../state/server";
import { useEnvironmentsWithScope } from "../../../state/session";
import type { EnvironmentUsageStatus } from "../../../state/usage";
import { useAtomCommand } from "../../../state/use-atom-command";
import { useMachineIdentities } from "../../../studio/machineIdentity";
import { UsageMachines } from "./UsageMachines";
import { readMachineReportCache, saveMachineReports } from "./machineReportCache";
import { type SharePeriod, VIEWER_TIME_ZONE, reportRange } from "./machineShareView";

type Answer =
  | { readonly kind: "report"; readonly report: UsageMachineReport }
  | { readonly kind: "failed" };

/**
 * Usage > Machines with live data: asks every selected machine what it
 * recorded, keeps each answer for when the machine is out of reach, and lets a
 * machine too old to answer stand in with the usage summary the page has.
 */
export function UsageMachinesSection({
  selectedEnvironmentIds,
  usage,
  refreshKey,
  now,
  range: pageRange,
  rangeLabel,
  drivers,
}: {
  /** Null selects every machine. */
  readonly selectedEnvironmentIds: ReadonlySet<EnvironmentId> | null;
  /** The page's usage summaries, for machines that cannot send a report yet. */
  readonly usage: readonly EnvironmentUsageStatus[];
  readonly refreshKey: number;
  readonly now: number;
  /** The page range (1456); Machines reads it unless the reset window is picked. */
  readonly range: { readonly sinceDay: string; readonly untilDay: string };
  readonly rangeLabel: string;
  readonly drivers: ReadonlySet<string>;
}) {
  const presentations = useAtomValue(environmentPresentations.presentationsAtom);
  const identities = useMachineIdentities();
  const [followReset, setFollowReset] = useState(false);
  const period = useMemo<SharePeriod>(
    () =>
      followReset
        ? { kind: "reset" }
        : { kind: "custom", sinceDay: pageRange.sinceDay, untilDay: pageRange.untilDay },
    [followReset, pageRange.sinceDay, pageRange.untilDay],
  );
  const [read, setRead] = useState<{
    readonly rangeKey: string;
    readonly answers: ReadonlyMap<string, Answer>;
  } | null>(null);
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

  const machineIds = useMemo(
    () =>
      [...presentations.keys()]
        .filter((id) => selectedEnvironmentIds === null || selectedEnvironmentIds.has(id))
        .sort(),
    [presentations, selectedEnvironmentIds],
  );
  const requested = useMemo(
    () => machineIds.map((environmentId) => ({ environmentId })),
    [machineIds],
  );
  const permitted = useEnvironmentsWithScope(requested, AuthDiagnosticsReadScope);
  const range = reportRange(period, now, VIEWER_TIME_ZONE);
  // Answers only stand for the range they were read for; a new range shows loading until its own arrive.
  const rangeKey = `${range.sinceDay}|${range.untilDay}`;
  const answers = read?.rangeKey === rangeKey ? read.answers : null;
  // Only machines that can answer are asked; the key changes when one joins or leaves.
  const askKey = machineIds
    .filter((id) => {
      const presentation = presentations.get(id);
      return (
        permitted.has(id) &&
        presentation?.connection.phase === "connected" &&
        presentation.serverConfig?.environment.capabilities.usageMachineReport === true
      );
    })
    .join("\n");
  const historyKey = machineIds
    .filter((id) => presentations.get(id)?.connection.phase === "connected")
    .join("\n");

  useEffect(() => {
    let cancelled = false;
    const ids = askKey === "" ? [] : (askKey.split("\n") as EnvironmentId[]);
    void Promise.all(
      ids.map((environmentId): Promise<readonly [string, Answer]> =>
        Promise.resolve(
          readReport({
            environmentId,
            input: {
              sinceDay: range.sinceDay as UsageMachineReport["sinceDay"],
              untilDay: range.untilDay as UsageMachineReport["untilDay"],
              timeZone: VIEWER_TIME_ZONE,
            },
          }),
        )
          .then((result): readonly [string, Answer] => [
            environmentId,
            // Only an answer for exactly this range counts as live.
            result?._tag === "Success" &&
            result.value.sinceDay === range.sinceDay &&
            result.value.untilDay === range.untilDay
              ? { kind: "report", report: result.value }
              : { kind: "failed" },
          ])
          .catch((): readonly [string, Answer] => [environmentId, { kind: "failed" }]),
      ),
    ).then((entries) => {
      if (cancelled) return;
      const next = new Map(entries);
      setRead({ rangeKey: `${range.sinceDay}|${range.untilDay}`, answers: next });
      saveMachineReports(
        new Map(
          entries.flatMap(([id, answer]) =>
            answer.kind === "report" ? [[id, answer.report] as const] : [],
          ),
        ),
        Date.now(),
      );
    });
    return () => {
      cancelled = true;
    };
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- refreshKey re-reads on refresh.
  }, [askKey, range.sinceDay, range.untilDay, readReport, refreshKey]);

  useEffect(() => {
    let cancelled = false;
    const ids = historyKey === "" ? [] : (historyKey.split("\n") as EnvironmentId[]);
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
  }, [historyKey, readHistory, refreshKey]);

  const asked = useMemo(() => new Set(askKey === "" ? [] : askKey.split("\n")), [askKey]);
  const inputs = useMemo((): readonly ShareMachineInput[] => {
    const cache = readMachineReportCache(now);
    const summaries = new Map(usage.map((entry) => [entry.environmentId as string, entry.summary]));
    return machineIds.map((machineId) => {
      const presentation = presentations.get(machineId);
      const answer = answers?.get(machineId);
      return shareMachineInput({
        machineId,
        name: identities(machineId, presentation?.entry.target.label).name,
        connected: presentation?.connection.phase === "connected",
        canReport: presentation?.serverConfig?.environment.capabilities.usageMachineReport === true,
        permitted: permitted.has(machineId),
        heldAccountKeys: (presentation?.serverConfig?.providers ?? [])
          .filter((provider) => provider.auth.status === "authenticated")
          .map((provider) => usageAccountKey(provider)),
        answer: answer === undefined ? null : answer.kind === "report" ? answer.report : "failed",
        // A kept report stands in only when it covers the asked days, and never while this range is still being read.
        kept: (() => {
          const kept = cache[machineId]?.report ?? null;
          if (kept === null || (answers === null && asked.has(machineId))) return null;
          return kept.sinceDay <= range.sinceDay && kept.untilDay >= range.untilDay ? kept : null;
        })(),
        summary: summaries.get(machineId) ?? null,
      });
    });
  }, [
    machineIds,
    presentations,
    identities,
    answers,
    permitted,
    usage,
    now,
    asked,
    range.sinceDay,
    range.untilDay,
  ]);

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

  return (
    <UsageMachines
      inputs={inputs}
      histories={histories}
      scopedWindowIds={scopedWindowIds}
      identityOf={identities}
      now={now}
      period={period}
      pageRangeLabel={rangeLabel}
      onFollowResetChange={setFollowReset}
      drivers={drivers}
      loading={asked.size > 0 && answers === null}
    />
  );
}
