/**
 * Usage > Limits > Subscriptions: "Agents and models". Which registry agents
 * (GitHub Copilot, Gemini CLI, and Antigravity beside them) ran in the last 30
 * days and on which models, from the turns each machine recorded. Copilot
 * reports one premium-request pool per account, so the split by model exists
 * only here.
 */
import { useAtomValue } from "@effect/atom-react";
import {
  AuthDiagnosticsReadScope,
  type EnvironmentId,
  type UsageMachineReport,
} from "@specweave-studio/contracts";
import { formatCount, formatTokens } from "@specweave-studio/shared/usageFormat";
import { type LimitAccount, limitAccountKey } from "@specweave-studio/shared/usageLimits";
import { zonedDay } from "@specweave-studio/shared/usageMachineShareView";
import { useEffect, useMemo, useState } from "react";

import { environmentPresentations } from "../../../state/presentation";
import { serverEnvironment } from "../../../state/server";
import { useEnvironmentsWithScope } from "../../../state/session";
import { useAtomCommand } from "../../../state/use-atom-command";
import { useMachineIdentities } from "../../../studio/machineIdentity";
import { ProviderInstanceIcon } from "../../chat/ProviderInstanceIcon";
import { VIEWER_TIME_ZONE } from "../machines/machineShareView";
import { providerGroupOf } from "./providerGroups";
import { type AgentOf, type AgentStatsView, OTHER_MODELS, agentStats } from "./registryAgents";

const DAY_MS = 24 * 60 * 60 * 1000;
export const AGENT_DAYS = 30;

/**
 * Categorical slots in fixed order, light then dark step (validated with the
 * dataviz palette checks). "Other models" always takes the neutral last slot.
 */
const SERIES = [
  "light-dark(#2a78d6, #3987e5)",
  "light-dark(#eb6834, #d95926)",
  "light-dark(#1baf7a, #199e70)",
  "light-dark(#eda100, #c98500)",
  "light-dark(#e87ba4, #d55181)",
] as const;
const OTHER_COLOR = "light-dark(#a3a29b, #6b6a64)";

export function modelColor(models: readonly string[], model: string): string {
  if (model === OTHER_MODELS) return OTHER_COLOR;
  const index = models.indexOf(model);
  return index === -1 ? OTHER_COLOR : (SERIES[index] ?? OTHER_COLOR);
}

const dayLabel = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
const dayOf = (day: string) => dayLabel.format(new Date(`${day}T12:00:00`));
const share = (part: number, whole: number) =>
  whole <= 0 ? "0%" : `${Math.max(part > 0 ? 1 : 0, Math.round((part / whole) * 100))}%`;

function Legend({ models }: { readonly models: readonly string[] }) {
  return (
    <ul
      className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground"
      aria-label="Models"
    >
      {models.map((model) => (
        <li key={model} className="flex items-center gap-1.5">
          <span
            aria-hidden
            className="size-2.5 rounded-xs"
            style={{ backgroundColor: modelColor(models, model) }}
          />
          {model}
        </li>
      ))}
    </ul>
  );
}

/** Turns per day, stacked by model; a day without turns is a baseline. */
function DailyChart({ view }: { readonly view: AgentStatsView }) {
  const peak = Math.max(1, ...view.days.map((day) => day.total));
  const height = 120;
  const width = 600;
  const gap = 2;
  const columnWidth = width / view.days.length;
  return (
    <figure className="flex flex-col gap-2" data-agents-daily="">
      <svg
        viewBox={`0 0 ${width} ${height + 18}`}
        className="h-auto w-full"
        role="img"
        aria-label={`Turns per day over the last ${view.days.length} days, peak ${peak}`}
      >
        <line x1={0} x2={width} y1={height} y2={height} className="stroke-border" strokeWidth={1} />
        {view.days.map((day, index) => {
          const x = index * columnWidth + gap / 2;
          let y = height;
          const segments = view.models.flatMap((model) => {
            const count = day.turns.get(model) ?? 0;
            if (count === 0) return [];
            const segment = Math.max(2, (count / peak) * (height - 4));
            y -= segment;
            return [{ model, count, y, segment }];
          });
          const title = `${dayOf(day.day)}: ${
            day.total === 0
              ? "no turns"
              : segments.map((entry) => `${entry.model} ${entry.count}`).join(", ")
          }`;
          return (
            <g key={day.day} data-agents-day={day.day}>
              <title>{title}</title>
              {/* A hit area the full height of the plot, wider than the bars. */}
              <rect
                x={index * columnWidth}
                y={0}
                width={columnWidth}
                height={height}
                fill="transparent"
              />
              {segments.map((entry, segmentIndex) => (
                <rect
                  key={entry.model}
                  x={x}
                  y={entry.y + (segmentIndex === 0 ? 0 : gap / 2)}
                  width={Math.max(1, columnWidth - gap)}
                  height={Math.max(1, entry.segment - (segmentIndex === 0 ? 0 : gap / 2))}
                  rx={segmentIndex === segments.length - 1 ? 2 : 0}
                  style={{ fill: modelColor(view.models, entry.model) }}
                />
              ))}
              {index % 7 === 0 || index === view.days.length - 1 ? (
                <text
                  x={index * columnWidth + columnWidth / 2}
                  y={height + 14}
                  textAnchor="middle"
                  className="fill-muted-foreground text-[10px]"
                >
                  {dayOf(day.day)}
                </text>
              ) : null}
            </g>
          );
        })}
      </svg>
      <Legend models={view.models} />
    </figure>
  );
}

function AgentRow({
  agent,
  models,
}: {
  readonly agent: AgentStatsView["agents"][number];
  readonly models: readonly string[];
}) {
  const shown = agent.models.slice(0, 4);
  return (
    <li
      className="grid grid-cols-[1rem_minmax(0,1fr)_auto] items-center gap-x-2.5 gap-y-1.5 border-t border-border/60 py-2.5 first:border-t-0"
      data-agent-row={agent.group.key}
    >
      <ProviderInstanceIcon
        driverKind={agent.group.driver}
        displayName={agent.group.label}
        acpRegistryIconUrl={agent.group.iconUrl ?? undefined}
        showBadge={false}
        className="size-4"
        iconClassName="size-4 text-foreground/80"
      />
      <span className="min-w-0 truncate text-sm font-medium">{agent.group.label}</span>
      <span className="text-right text-xs tabular-nums text-muted-foreground">
        <strong className="font-semibold text-foreground">{formatCount(agent.turns)}</strong>{" "}
        {agent.turns === 1 ? "turn" : "turns"}
        {agent.tokens > 0 ? ` · ${formatTokens(agent.tokens)} tokens` : ""}
      </span>
      <span
        className="col-start-2 col-end-4 flex h-2 overflow-hidden rounded-full bg-muted"
        role="img"
        aria-label={agent.models
          .map((entry) => `${entry.model} ${share(entry.turns, agent.turns)}`)
          .join(", ")}
      >
        {agent.models.map((entry, index) => (
          <span
            key={entry.model}
            className={index === 0 ? "h-full" : "h-full border-l-2 border-background"}
            style={{
              width: `${(entry.turns / agent.turns) * 100}%`,
              backgroundColor: modelColor(
                models,
                models.includes(entry.model) ? entry.model : OTHER_MODELS,
              ),
            }}
          />
        ))}
      </span>
      <span className="col-start-2 col-end-4 flex flex-wrap gap-x-3 text-xs text-muted-foreground tabular-nums">
        {shown.map((entry) => (
          <span key={entry.model}>
            <span className="text-foreground">{entry.model}</span> {share(entry.turns, agent.turns)}
          </span>
        ))}
        {agent.models.length > shown.length ? (
          <span>+{agent.models.length - shown.length} more</span>
        ) : null}
        {agent.turnsWithoutTokens > 0 && agent.turnsWithoutTokens < agent.turns ? (
          <span>{formatCount(agent.turnsWithoutTokens)} turns without token counts</span>
        ) : null}
      </span>
    </li>
  );
}

export function RegistryAgentsView({
  view,
  loading,
  unreached,
}: {
  readonly view: AgentStatsView | null;
  readonly loading: boolean;
  /** Machines that could not report, named so their turns are not taken for none. */
  readonly unreached: readonly string[];
}) {
  return (
    <section
      className="flex flex-col gap-3 rounded-xl border border-border/70 bg-card p-4"
      aria-labelledby="agents-models-heading"
      data-registry-agents=""
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 id="agents-models-heading" className="text-sm font-medium">
          Agents and models
        </h3>
        <span className="text-xs text-muted-foreground">
          Last {AGENT_DAYS} days · turns SpecWithCode recorded
        </span>
      </div>
      {view === null || (loading && view.turns === 0) ? (
        <p className="text-sm text-muted-foreground">Reading each machine…</p>
      ) : view.turns === 0 ? (
        <p className="text-sm text-muted-foreground">
          No registry agent ran a turn in the last {AGENT_DAYS} days.
        </p>
      ) : (
        <>
          <p className="text-sm tabular-nums" data-agents-summary="">
            <strong className="font-semibold">{formatCount(view.turns)}</strong>{" "}
            {view.turns === 1 ? "turn" : "turns"} across {view.agents.length}{" "}
            {view.agents.length === 1 ? "agent" : "agents"}
            {view.tokens > 0 ? ` · ${formatTokens(view.tokens)} tokens` : ""}
          </p>
          <ul className="flex flex-col">
            {view.agents.map((agent) => (
              <AgentRow key={agent.group.key} agent={agent} models={view.models} />
            ))}
          </ul>
          <DailyChart view={view} />
          <table className="sr-only">
            <caption>Turns by agent and model</caption>
            <thead>
              <tr>
                <th>Agent</th>
                <th>Model</th>
                <th>Turns</th>
                <th>Tokens</th>
              </tr>
            </thead>
            <tbody>
              {view.agents.flatMap((agent) =>
                agent.models.map((entry) => (
                  <tr key={`${agent.group.key}:${entry.model}`}>
                    <td>{agent.group.label}</td>
                    <td>{entry.model}</td>
                    <td>{entry.turns}</td>
                    <td>{entry.tokens}</td>
                  </tr>
                )),
              )}
            </tbody>
          </table>
        </>
      )}
      {unreached.length > 0 ? (
        <p className="text-xs text-muted-foreground" data-agents-unreached="">
          Not counted: {unreached.join(", ")} did not report.
        </p>
      ) : null}
    </section>
  );
}

type Answer = UsageMachineReport | "failed";

/** The section with live data: asks every connected machine that can report. */
export function RegistryAgentsSection({
  accounts,
  now,
}: {
  readonly accounts: readonly LimitAccount[];
  readonly now: number;
}) {
  const presentations = useAtomValue(environmentPresentations.presentationsAtom);
  const identities = useMachineIdentities();
  const readReport = useAtomCommand(serverEnvironment.usageMachineReport, {
    reportFailure: false,
    reportDefect: false,
  });
  const [answers, setAnswers] = useState<ReadonlyMap<string, Answer> | null>(null);
  const range = useMemo(
    () => ({
      sinceDay: zonedDay(now - (AGENT_DAYS - 1) * DAY_MS, VIEWER_TIME_ZONE),
      untilDay: zonedDay(now, VIEWER_TIME_ZONE),
    }),
    [now],
  );
  const machineIds = useMemo(() => [...presentations.keys()].sort(), [presentations]);
  const requested = useMemo(
    () => machineIds.map((environmentId) => ({ environmentId })),
    [machineIds],
  );
  const permitted = useEnvironmentsWithScope(requested, AuthDiagnosticsReadScope);
  const canAsk = (id: EnvironmentId) => {
    const presentation = presentations.get(id);
    return (
      permitted.has(id) &&
      presentation?.connection.phase === "connected" &&
      presentation.serverConfig?.environment.capabilities.usageMachineReport === true
    );
  };
  const askKey = machineIds.filter(canAsk).join("\n");

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
            result?._tag === "Success" ? result.value : "failed",
          ])
          .catch((): readonly [string, Answer] => [environmentId, "failed"]),
      ),
    ).then((entries) => {
      if (!cancelled) setAnswers(new Map(entries));
    });
    return () => {
      cancelled = true;
    };
  }, [askKey, range.sinceDay, range.untilDay, readReport]);

  // An account is named by the instance that holds it: its registry icon first, then its name.
  const agentOf = useMemo((): AgentOf => {
    const byKey = new Map<string, LimitAccount>();
    for (const account of accounts) {
      const key = limitAccountKey(account.driver, account.email, account.limits);
      if (key !== null) byKey.set(key, account);
    }
    const instances = new Map<string, { displayName?: string; iconUrl?: string }>();
    for (const presentation of presentations.values()) {
      for (const provider of presentation.serverConfig?.providers ?? []) {
        if (!instances.has(provider.instanceId)) {
          instances.set(provider.instanceId, {
            ...(provider.displayName ? { displayName: provider.displayName } : {}),
            ...(provider.iconUrl ? { iconUrl: provider.iconUrl } : {}),
          });
        }
      }
    }
    return (accountKey, driver, label) => {
      const account = byKey.get(accountKey);
      const instance = instances.get(accountKey.split(":instance:")[1] ?? "");
      return providerGroupOf({
        driver: driver as LimitAccount["driver"],
        displayName: account?.displayName ?? instance?.displayName ?? label,
        iconUrl: account?.iconUrl ?? instance?.iconUrl,
      });
    };
  }, [accounts, presentations]);

  const reports = useMemo(
    () =>
      [...(answers?.values() ?? [])].filter(
        (answer): answer is UsageMachineReport => answer !== "failed",
      ),
    [answers],
  );
  const view = useMemo(
    () => (answers === null && askKey !== "" ? null : agentStats(reports, agentOf, range)),
    [answers, askKey, reports, agentOf, range],
  );
  const unreached = machineIds
    .filter((id) => !canAsk(id) || answers?.get(id) === "failed")
    .map((id) => identities(id, presentations.get(id)?.entry.target.label).name);

  return (
    <RegistryAgentsView
      view={view}
      loading={answers === null && askKey !== ""}
      unreached={unreached}
    />
  );
}
