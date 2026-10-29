import { Fragment, useMemo, useState } from "react";
import {
  ProviderDriverKind,
  type EnvironmentId,
  type ProjectId,
  type ProjectUsageSummary,
  type ThreadId,
} from "@specweave-studio/contracts";
import { formatPercent, formatTokens } from "@specweave-studio/shared/usageFormat";
import { projectWorkspace } from "../../studio/projectWorkspace";
import { cliOfDriver, combinedCacheReadRatio, providerLabel } from "../../studio/projectUsageModel";
import {
  ALL_FILTERS,
  NOT_REPORTED_FAMILY,
  SOURCE_LABELS,
  filterOptions,
  groupByHarness,
  groupByModel,
  localToday,
  matches,
  modelFamily,
  normalizeModelId,
  periodChange,
  sumFacts,
  trendDays,
  usageDayFacts,
  usageFacts,
  type UsageFilters,
  type UsageGroup,
  type UsageSource,
} from "../../studio/projectUsageInsights";
import { useEnvironmentQuery } from "../../state/query";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { UsageShareBar } from "../usage/UsageShareBar";
import { HostLimits } from "./shell/HostLimits";
import { SubscriptionUsageSummary } from "./shell/ProjectUsageIndicator";
import { ProjectUsageTrend } from "./ProjectUsageTrend";

const CLI_ICON: Record<string, { driver: string; agentId?: string }> = {
  claude: { driver: "claudeAgent" },
  codex: { driver: "codex" },
  grok: { driver: "grok" },
  copilot: { driver: "acpRegistry", agentId: "github-copilot-cli" },
};

function CliIcon({ provider }: { provider: string }) {
  const icon = CLI_ICON[provider] ?? { driver: provider };
  return (
    <ProviderInstanceIcon
      driverKind={ProviderDriverKind.make(icon.driver)}
      displayName={providerLabel(provider)}
      acpRegistryAgentId={icon.agentId}
      showBadge={false}
      className="size-4"
      iconClassName="size-4 text-foreground/80"
    />
  );
}

/** Fixed per harness so a filter never repaints the rest; anything else is neutral. */
const HARNESS_COLOR: Record<string, string> = {
  codex: "var(--usage-harness-1)",
  claude: "var(--usage-harness-2)",
  copilot: "var(--usage-harness-3)",
  gemini: "var(--usage-harness-4)",
  cursor: "var(--usage-harness-5)",
  grok: "var(--usage-harness-7)",
};
const harnessColor = (harness: string) => HARNESS_COLOR[harness] ?? "var(--usage-harness-other)";

const SORTS = [
  { value: "share", label: "Share" },
  { value: "name", label: "Name" },
] as const;

const TREND_DAYS = 30;

/** Unknown stays visibly unknown, quietly: a dash, never a zero. */
const tokens = (value: number | null) => (value === null ? "—" : formatTokens(value));

function FilterSelect({
  label,
  value,
  all,
  options,
  onChange,
}: {
  label: string;
  value: string;
  all: string;
  options: readonly { readonly value: string; readonly label: string }[];
  onChange: (value: string) => void;
}) {
  const items = [{ value: "all", label: all }, ...options];
  return (
    <Select
      items={items}
      value={value}
      onValueChange={(next) => {
        if (next !== null) onChange(next);
      }}
    >
      <SelectTrigger size="xs" className="w-auto min-w-40" aria-label={label}>
        <SelectValue />
      </SelectTrigger>
      <SelectPopup align="start" alignItemWithTrigger={false}>
        {items.map((item) => (
          <SelectItem key={item.value} value={item.value}>
            {item.label}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}

/**
 * A thread's tokens that match the harness and model filters; null when an
 * older host sent no per-model split, so the share is unknown rather than zero.
 */
function threadTokens(
  thread: ProjectUsageSummary["threads"][number],
  filters: UsageFilters,
): number | null {
  if (filters.harness === "all" && filters.family === "all") return thread.totals.totalTokens;
  if (thread.models === undefined) return null;
  const source: UsageSource = thread.role === "coordinator" ? "coordinator" : "thread";
  return (thread.models ?? [])
    .filter((row) =>
      matches(
        {
          source,
          harness: cliOfDriver(row.provider, row.providerInstanceId),
          model: normalizeModelId(row.model),
        },
        { ...filters, source: "all" },
      ),
    )
    .reduce((sum, row) => sum + row.totals.totalTokens, 0);
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

export function ProjectUsage({
  environmentId,
  projectId,
  onOpenThread,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  onOpenThread: (id: ThreadId) => void;
}) {
  const query = useEnvironmentQuery(
    projectWorkspace.usage({ environmentId, input: { projectId } }),
  );
  const [sort, setSort] = useState<"share" | "name">("share");
  const [filters, setFilters] = useState<UsageFilters>(ALL_FILTERS);
  const [showIdle, setShowIdle] = useState(false);
  const data = query.data;
  const folder = data?.folderSessions ?? null;
  const facts = useMemo(() => (data ? usageFacts(data) : []), [data]);
  const dayFacts = useMemo(() => (data ? usageDayFacts(data) : []), [data]);
  const options = useMemo(() => filterOptions(facts), [facts]);
  const filtered = useMemo(() => facts.filter((fact) => matches(fact, filters)), [facts, filters]);
  const totals = sumFacts(filtered);
  const harnesses = groupByHarness(filtered);
  const models = groupByModel(filtered);
  // A column nobody reported is noise: show cache reads only when some model has them.
  const showCache = models.some((row) => row.totals.cachedInputTokens !== null);
  // The window ends on the day the server read the logs, so a re-render never shifts it.
  // The host buckets days in its own time zone, which can run ahead of this
  // browser's: the window ends on the later of the two so no recent day drops out.
  const readAt = Date.parse(data?.readAt ?? "");
  const hasDaily = data?.daily !== undefined;
  const lastDay = Number.isFinite(readAt)
    ? dayFacts.reduce((last, fact) => (fact.day > last ? fact.day : last), localToday(readAt))
    : null;
  const days =
    hasDaily && lastDay !== null
      ? trendDays(
          dayFacts.filter((fact) => matches(fact, filters)),
          lastDay,
          TREND_DAYS,
        )
      : [];
  const week = periodChange(days, 7);
  const filtering =
    filters.source !== "all" || filters.harness !== "all" || filters.family !== "all";
  const cacheRatio = !data
    ? null
    : !filtering
      ? combinedCacheReadRatio(data)
      : totals.inputTokens > 0 &&
          totals.cachedInputTokens !== null &&
          totals.cachedInputTokens <= totals.inputTokens
        ? totals.cachedInputTokens / totals.inputTokens
        : null;

  const families = new Map<string, UsageGroup[]>();
  for (const model of models) {
    const family = modelFamily(model.key.startsWith("\0") ? null : model.key);
    families.set(family, [...(families.get(family) ?? []), model]);
  }
  const familyShare = (rows: readonly UsageGroup[]) =>
    rows.reduce((sum, row) => sum + row.share, 0);
  const familyRows = [...families].sort(
    ([a, left], [b, right]) =>
      Number(a === NOT_REPORTED_FAMILY) - Number(b === NOT_REPORTED_FAMILY) ||
      familyShare(right) - familyShare(left),
  );

  // An older host does not split threads by model; its usage facts read every
  // thread, coordinator included, as "Threads", so the table must too.
  const split = (data?.threads ?? []).every((thread) => thread.models !== undefined);
  const threadRows = (data?.threads ?? [])
    .filter(
      (thread) =>
        filters.source === "all" ||
        (!split && filters.source === "thread") ||
        (filters.source === "coordinator") === (thread.role === "coordinator"),
    )
    .map((thread) => ({ thread, tokens: threadTokens(thread, filters) }));
  const threadTotal = threadRows.reduce((sum, row) => sum + (row.tokens ?? 0), 0);
  const idleThreads = threadRows.filter((row) => row.tokens === 0).length;
  const visibleThreads = threadRows
    .filter((row) => showIdle || row.tokens !== 0)
    .toSorted((a, b) =>
      sort === "name"
        ? a.thread.title.localeCompare(b.thread.title)
        : (b.tokens ?? -1) - (a.tokens ?? -1),
    );

  const coverage = data?.coverage;
  const gaps = coverage
    ? [
        {
          count: coverage.missingThreads,
          text: (n: number) => `${plural(n, "thread", "threads")} recorded no usage`,
        },
        {
          count: coverage.partialTurns,
          text: (n: number) => `${plural(n, "turn", "turns")} reported only part of their usage`,
        },
        {
          count: coverage.missingTurns,
          text: (n: number) => `${plural(n, "turn", "turns")} reported no usage`,
        },
        {
          count: coverage.costUnknownTurns,
          text: (n: number) =>
            `${plural(n, "turn", "turns")} have no price, so the cost leaves them out`,
        },
      ].filter((gap) => gap.count > 0)
    : [];
  const tokenGaps = coverage
    ? coverage.missingThreads + coverage.partialTurns + coverage.missingTurns
    : 0;

  return (
    <section
      className="project-settings-section project-usage-insights"
      aria-labelledby="project-usage-heading"
    >
      <div className="project-section-title">
        <h2 id="project-limits-heading">Subscription limits</h2>
      </div>
      <p className="project-muted">
        Each machine runs its own CLIs with its own sign-ins, so limits are shown per host, this
        project&apos;s device first. An account signed in on two hosts shares one quota and is
        marked on both. Limits are account-wide, across every project.
      </p>
      <HostLimits projectEnvironmentId={environmentId} pooled={<SubscriptionUsageSummary />} />
      <div className="project-section-title">
        <h2 id="project-usage-heading">Project usage</h2>
        <button className="project-control" onClick={query.refresh} disabled={query.isPending}>
          Refresh
        </button>
      </div>
      <p className="project-muted">
        Tokens recorded by this project&apos;s SpecWithCode threads, plus CLI sessions (Claude Code,
        Codex, Copilot, Grok) run in its folder. Token usage and equivalent API cost are separate
        from subscription limits or money paid.
      </p>
      {query.error && <p role="alert">{query.error}</p>}
      {!data ? (
        <p role="status">{query.isPending ? "Loading recorded usage…" : "Usage is unavailable."}</p>
      ) : (
        <>
          {facts.length > 0 ? (
            <div className="project-usage-filters" role="group" aria-label="Filter usage">
              {options.sources.length > 1 ? (
                <FilterSelect
                  label="Filter by source"
                  all="All sources"
                  value={filters.source}
                  options={options.sources.map((source) => ({
                    value: source,
                    label: SOURCE_LABELS[source],
                  }))}
                  onChange={(source) =>
                    setFilters((current) => ({
                      ...current,
                      source: source as UsageFilters["source"],
                    }))
                  }
                />
              ) : null}
              {options.harnesses.length > 1 ? (
                <FilterSelect
                  label="Filter by harness"
                  all="All harnesses"
                  value={filters.harness}
                  options={options.harnesses}
                  onChange={(harness) => setFilters((current) => ({ ...current, harness }))}
                />
              ) : null}
              {options.families.length > 1 ? (
                <FilterSelect
                  label="Filter by model family"
                  all="All models"
                  value={filters.family}
                  options={options.families.map((family) => ({ value: family, label: family }))}
                  onChange={(family) => setFilters((current) => ({ ...current, family }))}
                />
              ) : null}
              {filtering ? (
                <button className="project-control" onClick={() => setFilters(ALL_FILTERS)}>
                  Clear filters
                </button>
              ) : null}
            </div>
          ) : null}
          <dl className="project-usage-summary">
            <div>
              <dt>Tokens</dt>
              <dd>{formatTokens(totals.totalTokens)}</dd>
              <small>
                {[
                  filters.source === "cli"
                    ? null
                    : plural(
                        threadRows.filter((row) => row.tokens !== 0).length,
                        "thread",
                        "threads",
                      ),
                  folder && (filters.source === "all" || filters.source === "cli")
                    ? plural(folder.sessions, "CLI session", "CLI sessions")
                    : null,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </small>
            </div>
            <div>
              <dt>Last 7 days</dt>
              <dd>{days.length === 0 ? "—" : formatTokens(week.recent)}</dd>
              <small>
                {days.length === 0
                  ? "This host does not report daily usage"
                  : week.change === null
                    ? "Nothing the week before"
                    : `${week.change >= 0 ? "+" : "−"}${formatPercent(Math.abs(week.change), 0)} vs the week before`}
              </small>
            </div>
            <div>
              <dt>Equivalent API cost</dt>
              <dd>
                {totals.equivalentCostUsd === null
                  ? "—"
                  : `$${totals.equivalentCostUsd.toFixed(2)}`}
              </dd>
              <small>Estimate, not money paid</small>
            </div>
            <div>
              <dt>Cache read ratio</dt>
              <dd>{cacheRatio === null ? "—" : `${(cacheRatio * 100).toFixed(1)}%`}</dd>
              <small>
                {cacheRatio === null ? "Not reported by every turn" : "Of input, read from cache"}
              </small>
            </div>
          </dl>
          {facts.length === 0 ? (
            <p className="project-muted" role="status">
              No usage recorded yet. Turns from this project&apos;s threads and CLI sessions in its
              folder appear here.
            </p>
          ) : null}
          <ProjectUsageTrend days={days} />
          {harnesses.length > 0 ? (
            <div className="project-usage-block">
              <UsageShareBar
                label="Share by harness"
                format={formatTokens}
                segments={harnesses.map((row) => ({
                  label: row.label,
                  value: row.totals.totalTokens,
                  color: harnessColor(row.key),
                }))}
              />
              <div className="project-table-scroll">
                <table>
                  <caption className="sr-only">Tokens by harness</caption>
                  <thead>
                    <tr>
                      <th>Harness</th>
                      <th>Tokens</th>
                      <th>Share</th>
                      <th>Input</th>
                      <th>Output</th>
                    </tr>
                  </thead>
                  <tbody>
                    {harnesses.map((row) => (
                      <tr key={row.key}>
                        <th>
                          <span className="inline-flex items-center gap-2">
                            <CliIcon provider={row.key} />
                            {row.label}
                          </span>
                          <small>{row.via.join(" · ")}</small>
                        </th>
                        <td>{formatTokens(row.totals.totalTokens)}</td>
                        <td>{formatPercent(row.share)}</td>
                        <td>{formatTokens(row.totals.inputTokens)}</td>
                        <td>{formatTokens(row.totals.outputTokens)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ) : null}
          {models.length > 0 ? (
            <div className="project-table-scroll">
              <table className="project-usage-models">
                <caption>Tokens by model</caption>
                <thead>
                  <tr>
                    <th>Model</th>
                    <th>Tokens</th>
                    <th>Share</th>
                    <th>Input</th>
                    <th>Output</th>
                    {showCache ? <th>Cache read</th> : null}
                  </tr>
                </thead>
                <tbody>
                  {familyRows.map(([family, rows]) => {
                    const single = rows.length === 1;
                    return (
                      <Fragment key={family}>
                        {single ? null : (
                          <tr className="project-usage-family">
                            <th>{family}</th>
                            <td>
                              {formatTokens(
                                rows.reduce((sum, row) => sum + row.totals.totalTokens, 0),
                              )}
                            </td>
                            <td>{formatPercent(familyShare(rows))}</td>
                            <td colSpan={showCache ? 3 : 2} />
                          </tr>
                        )}
                        {rows.map((row) => (
                          <tr key={row.key} data-nested={single ? undefined : ""}>
                            <th>
                              {row.label}
                              <small>{row.via.join(" · ")}</small>
                            </th>
                            <td>{formatTokens(row.totals.totalTokens)}</td>
                            <td>
                              <span className="project-usage-meter">
                                <span aria-hidden>
                                  <i style={{ width: `${row.share * 100}%` }} />
                                </span>
                                {formatPercent(row.share)}
                              </span>
                            </td>
                            <td>{formatTokens(row.totals.inputTokens)}</td>
                            <td>{formatTokens(row.totals.outputTokens)}</td>
                            {showCache ? <td>{tokens(row.totals.cachedInputTokens)}</td> : null}
                          </tr>
                        ))}
                      </Fragment>
                    );
                  })}
                </tbody>
                <tfoot>
                  <tr>
                    <th>Total</th>
                    <td>{formatTokens(totals.totalTokens)}</td>
                    <td />
                    <td>{formatTokens(totals.inputTokens)}</td>
                    <td>{formatTokens(totals.outputTokens)}</td>
                    {showCache ? <td>{tokens(totals.cachedInputTokens)}</td> : null}
                  </tr>
                </tfoot>
              </table>
            </div>
          ) : facts.length > 0 ? (
            <p className="project-muted" role="status">
              Nothing matches these filters.
            </p>
          ) : null}
          <p className="project-muted">
            Input includes cache reads and writes. A dash means not every turn reported it. Separate
            subagent usage is not included in these main-agent totals.
          </p>
          {gaps.length > 0 ? (
            <details
              className={tokenGaps > 0 ? "project-usage-gaps project-notice" : "project-usage-gaps"}
            >
              <summary>
                {tokenGaps > 0
                  ? "Some usage was not reported; totals include what was"
                  : `${plural(coverage!.costUnknownTurns, "turn has", "turns have")} no cost estimate`}
              </summary>
              <ul>
                {gaps.map((gap) => (
                  <li key={gap.text(gap.count)}>{gap.text(gap.count)}</li>
                ))}
              </ul>
            </details>
          ) : null}
          {filters.source === "cli" ? null : (
            <>
              <div className="project-section-title">
                <h3>Threads</h3>
                <Select
                  items={SORTS}
                  value={sort}
                  onValueChange={(value) => {
                    if (value !== null) setSort(value);
                  }}
                >
                  <SelectTrigger size="xs" className="w-36" aria-label="Sort threads by">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectPopup align="end" alignItemWithTrigger={false}>
                    {SORTS.map(({ value, label }) => (
                      <SelectItem key={value} value={value}>
                        Sort by {label.toLowerCase()}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </div>
              {threadRows.length === 0 ? (
                <p className="project-muted">
                  No SpecWithCode threads in this project yet. Start one from the coordinator to
                  record its turns here.
                </p>
              ) : null}
              <div className="project-table-scroll" hidden={visibleThreads.length === 0}>
                <table>
                  <thead>
                    <tr>
                      <th>Thread</th>
                      <th>Tokens</th>
                      <th>Share</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleThreads.map(({ thread, tokens: count }) => (
                      <tr key={thread.threadId}>
                        <th>
                          <button
                            className="project-control project-text-link"
                            onClick={() => onOpenThread(thread.threadId as ThreadId)}
                          >
                            {thread.title}
                          </button>
                          <small>
                            {thread.role === "coordinator" ? "Coordinator" : "Thread"}
                            {thread.archived ? " · archived" : ""}
                          </small>
                        </th>
                        <td>{count ? formatTokens(count) : "—"}</td>
                        <td>
                          {count && threadTotal > 0 ? formatPercent(count / threadTotal) : "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {idleThreads > 0 ? (
                <button
                  className="project-control project-text-link"
                  onClick={() => setShowIdle((value) => !value)}
                >
                  {showIdle
                    ? "Hide threads without usage"
                    : `Show ${plural(idleThreads, "thread", "threads")} without usage`}
                </button>
              ) : null}
            </>
          )}
        </>
      )}
    </section>
  );
}
