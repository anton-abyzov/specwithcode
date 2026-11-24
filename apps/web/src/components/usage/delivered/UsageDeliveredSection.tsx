import { AuthDiagnosticsReadScope, type EnvironmentId } from "@specweave-studio/contracts";
import { useAtomValue } from "@effect/atom-react";
import { formatPercent, formatUsd } from "@specweave-studio/shared/usageFormat";
import { useEffect, useEffectEvent, useMemo, useState } from "react";

import { environmentPresentations } from "../../../state/presentation";
import { useEnvironmentsWithScope } from "../../../state/session";
import { useAtomCommand } from "../../../state/use-atom-command";
import { usageDeliveredReport } from "../../../state/usageDelivered";
import { useMachineIdentities } from "../../../studio/machineIdentity";
import { Button } from "../../ui/button";
import { Skeleton } from "../../ui/skeleton";
import type { UsageFilters } from "../usageFilters";
import { DeliveredTable } from "./DeliveredTable";
import { deliveredCostText, deliveredReportMarkdown } from "./deliveredReport";
import { mergeDelivered, type DeliveredAnswer, type DeliveredView } from "./usageDeliveredMerge";

const SHORT_DAY = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" });

export function formatDeliveredDay(iso: string): string {
  const at = Date.parse(iso);
  return Number.isNaN(at) ? iso : SHORT_DAY.format(at);
}

function Stat({
  label,
  value,
  sub,
  children,
}: {
  readonly label: string;
  readonly value: string;
  readonly sub: string;
  readonly children?: React.ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1 rounded-xl border border-border p-4">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="text-2xl font-semibold text-foreground tabular-nums">{value}</span>
      <span className="text-xs text-muted-foreground">{sub}</span>
      {children}
    </div>
  );
}

function ShareStrip({ view }: { readonly view: DeliveredView }) {
  const total = view.measured.costUsd;
  if (total <= 0 || view.groupsHidden) return null;
  const parts = [
    { label: "increments", value: view.attributed.costUsd, className: "bg-primary" },
    {
      label: "coordinators",
      value: view.coordinators.cost.costUsd,
      className: "bg-muted-foreground/70",
    },
    {
      label: "other threads",
      value: view.otherThreads.cost.costUsd,
      className: "bg-muted-foreground/40",
    },
    {
      label: "outside the app",
      value: view.outsideApp.cost.costUsd,
      className: "bg-muted-foreground/20",
    },
  ];
  return (
    <>
      <div className="mt-2 flex h-2 overflow-hidden rounded-full bg-muted" aria-hidden>
        {parts.map((part) => (
          <span
            key={part.label}
            className={part.className}
            style={{ width: `${(part.value / total) * 100}%` }}
          />
        ))}
      </div>
      <span className="text-2xs text-muted-foreground">
        {parts.map((part) => `${part.label} ${formatPercent(part.value / total, 0)}`).join(" · ")}
      </span>
    </>
  );
}

/**
 * Usage > Delivered (1456): what the measured usage of the range delivered,
 * per SpecWeave increment, read from every selected machine.
 */
export function UsageDeliveredSection({
  selectedEnvironmentIds,
  range,
  rangeLabel,
  filters,
  filterLabels,
  refreshKey,
  onProjectsChange,
}: {
  readonly selectedEnvironmentIds: ReadonlySet<EnvironmentId> | null;
  readonly range: {
    readonly sinceDay: string;
    readonly untilDay: string;
    readonly timeZone: string;
  };
  readonly rangeLabel: string;
  readonly filters: UsageFilters;
  /** The active filters in words, for the copied report. */
  readonly filterLabels: readonly string[];
  readonly refreshKey: number;
  readonly onProjectsChange: (projects: readonly string[]) => void;
}) {
  const presentations = useAtomValue(environmentPresentations.presentationsAtom);
  const identities = useMachineIdentities();
  const readReport = useAtomCommand(usageDeliveredReport, {
    reportFailure: false,
    reportDefect: false,
  });
  const [read, setRead] = useState<{
    readonly key: string;
    readonly answers: ReadonlyMap<string, DeliveredAnswer>;
  } | null>(null);
  // The command's identity may change between renders; a read starts only when its inputs do.
  const ask = useEffectEvent((input: Parameters<typeof readReport>[0]) => readReport(input));
  const [copied, setCopied] = useState(false);

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
  const status = (id: EnvironmentId): DeliveredAnswer["kind"] | "ask" => {
    const presentation = presentations.get(id);
    if (!permitted.has(id) || presentation?.connection.phase !== "connected") return "unreachable";
    if (presentation.serverConfig?.environment.capabilities.usageDeliveredReport !== true)
      return "unsupported";
    return "ask";
  };
  const askKey = machineIds.filter((id) => status(id) === "ask").join("\n");
  const readKey = `${askKey}|${range.sinceDay}|${range.untilDay}|${range.timeZone}|${refreshKey}`;
  const answers = read?.answers ?? null;

  useEffect(() => {
    let cancelled = false;
    const ids = askKey === "" ? [] : (askKey.split("\n") as EnvironmentId[]);
    void Promise.all(
      ids.map((environmentId): Promise<readonly [string, DeliveredAnswer]> =>
        Promise.resolve(
          ask({
            environmentId,
            input: {
              sinceDay: range.sinceDay as never,
              untilDay: range.untilDay as never,
              timeZone: range.timeZone,
            },
          }),
        )
          .then((result): readonly [string, DeliveredAnswer] => [
            environmentId,
            result?._tag === "Success"
              ? { kind: "report", report: result.value }
              : { kind: "failed" },
          ])
          .catch((): readonly [string, DeliveredAnswer] => [environmentId, { kind: "failed" }]),
      ),
    ).then((entries) => {
      if (!cancelled) setRead({ key: readKey, answers: new Map(entries) });
    });
    return () => {
      cancelled = true;
    };
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- readKey holds every input, refreshKey included.
  }, [readKey]);

  const view = useMemo(
    () =>
      mergeDelivered(
        machineIds.map((id) => {
          const kind = status(id);
          return {
            machineId: id,
            name: identities(id, presentations.get(id)?.entry.target.label).name,
            answer:
              kind === "ask"
                ? (answers?.get(id) ?? { kind: "failed" })
                : ({ kind } as DeliveredAnswer),
          };
        }),
        { drivers: filters.drivers, modelQuery: filters.modelQuery, projects: filters.projects },
      ),
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- status reads the same inputs.
    [machineIds, answers, identities, presentations, permitted, filters],
  );
  const projectKey = view.projects.join("\n");
  useEffect(() => {
    onProjectsChange(projectKey === "" ? [] : projectKey.split("\n"));
  }, [projectKey, onProjectsChange]);

  if (askKey !== "" && read?.key !== readKey) {
    return (
      <div className="flex flex-col gap-4" aria-busy>
        <div className="grid gap-3 md:grid-cols-4">
          {[0, 1, 2, 3].map((index) => (
            <Skeleton key={index} className="h-24 rounded-xl" />
          ))}
        </div>
        <Skeleton className="h-64 rounded-xl" />
      </div>
    );
  }

  const share =
    view.measured.costUsd > 0 && !view.groupsHidden
      ? `${formatPercent(view.attributed.costUsd / view.measured.costUsd, 0)} of ${deliveredCostText(view.measured)} measured · `
      : "";
  return (
    <div className="flex min-w-0 flex-col gap-5" data-usage-delivered>
      <section
        className="grid gap-3 md:grid-cols-[1.3fr_1fr_1fr_1fr]"
        aria-label="Delivered summary"
      >
        <Stat
          label="Tied to increments"
          value={deliveredCostText(view.attributed)}
          sub={`${share}API-equivalent, not a bill`}
        >
          <ShareStrip view={view} />
        </Stat>
        <Stat
          label="Delivered"
          value={String(view.deliveredCount)}
          sub="increments closed or merged in range"
        />
        <Stat
          label="Tasks done"
          value={String(view.tasksDone)}
          sub={`across ${view.incrementsWithTasksDone} ${view.incrementsWithTasksDone === 1 ? "increment" : "increments"}`}
        />
        <Stat
          label="Median per delivered increment"
          value={view.medianDeliveredUsd === null ? "—" : formatUsd(view.medianDeliveredUsd)}
          sub={
            view.highest === null
              ? "no delivered increment recorded cost"
              : `highest ${formatUsd(view.highest.cost.costUsd)} (${view.highest.number})`
          }
        />
      </section>
      <DeliveredTable
        view={view}
        formatDay={formatDeliveredDay}
        action={
          <Button
            size="xs"
            variant="outline"
            disabled={view.answered.length === 0}
            onClick={() => {
              void navigator.clipboard
                ?.writeText(
                  deliveredReportMarkdown({
                    view,
                    rangeLabel,
                    filters: filterLabels,
                    formatDay: formatDeliveredDay,
                  }),
                )
                .then(() => setCopied(true))
                .catch(() => setCopied(false));
            }}
          >
            {copied ? "Copied as Markdown" : "Copy report"}
          </Button>
        }
      />
      <footer className="flex flex-col gap-1 text-xs text-muted-foreground">
        <p>
          How costs are tied: a thread counts toward one increment, linked by hand, by claim,
          branch, checkpoint or title, else by its parent thread&apos;s increment. &quot;Matched by
          title&quot; is the weakest link. Coordinators are never spread over increments.
        </p>
        <p>
          Cost uses the Cost tab&apos;s basis: transcripts and recorded turns at the same rates.
          Increments meet across machines by project and folder name.
          {view.answered.length > 0 ? ` Answered: ${view.answered.join(", ")}.` : ""}
        </p>
        {view.missing.length > 0 ? (
          <p className="text-warning-foreground" role="status">
            Totals are incomplete:{" "}
            {view.missing.map((machine) => `${machine.name} ${machine.reason}`).join("; ")}.
          </p>
        ) : null}
      </footer>
    </div>
  );
}
