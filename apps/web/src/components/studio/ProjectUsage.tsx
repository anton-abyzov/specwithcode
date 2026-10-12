import { useState } from "react";
import {
  ProviderDriverKind,
  type EnvironmentId,
  type ProjectId,
  type ThreadId,
} from "@specweave-studio/contracts";
import { projectWorkspace } from "../../studio/projectWorkspace";
import {
  combinedCacheReadRatio,
  combinedProjectTotals,
  projectProviderRows,
  cliOfDriver,
  providerLabel,
} from "../../studio/projectUsageModel";
import { formatAgo } from "../../studio/hostLimitsModel";
import { useEnvironmentQuery } from "../../state/query";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { HostLimits } from "./shell/HostLimits";
import { SubscriptionUsageSummary } from "./shell/ProjectUsageIndicator";

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

const SORTS = [
  { value: "share", label: "Share" },
  { value: "name", label: "Name" },
] as const;

const number = (value: number | null) =>
  value === null
    ? "Not reported"
    : Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(value);
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
  const data = query.data;
  const folder = data?.folderSessions ?? null;
  const combined = data ? combinedProjectTotals(data) : null;
  const cacheRatio = data ? combinedCacheReadRatio(data) : null;
  const providerRows = data ? projectProviderRows(data) : [];
  const now = Date.now();
  return (
    <section className="project-settings-section" aria-labelledby="project-usage-heading">
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
        Recorded provider turns in this project&apos;s SpecWithCode threads, plus CLI sessions
        (Claude Code, Codex, Copilot, Grok) run in the project folder on its device. Token usage and
        equivalent API cost are separate from subscription limits or money paid.
      </p>
      {query.error && <p role="alert">{query.error}</p>}
      {!data ? (
        <p role="status">{query.isPending ? "Loading recorded usage…" : "Usage is unavailable."}</p>
      ) : (
        <>
          <dl className="project-usage-summary">
            <div>
              <dt>Tokens</dt>
              <dd>{number(combined?.totalTokens ?? 0)}</dd>
            </div>
            <div>
              <dt>SpecWithCode threads</dt>
              <dd>{data.coverage.threads}</dd>
            </div>
            <div>
              <dt>CLI sessions</dt>
              <dd>{folder ? folder.sessions : "—"}</dd>
            </div>
            <div>
              <dt>Coordinator share</dt>
              <dd>
                {data.threads.find((t) => t.role === "coordinator")?.share == null
                  ? "—"
                  : `${((data.threads.find((t) => t.role === "coordinator")?.share ?? 0) * 100).toFixed(1)}%`}
              </dd>
            </div>
            <div>
              <dt>Cache read ratio</dt>
              <dd>{cacheRatio == null ? "Not reported" : `${(cacheRatio * 100).toFixed(1)}%`}</dd>
            </div>
          </dl>
          {folder ? (
            <p className="project-muted">
              CLI sessions: logs on {folder.hostLabel} from the last {folder.windowDays} days whose
              working directory is inside {folder.roots.join(", ")}. Sessions a SpecWithCode thread
              already records ({folder.studioOwnedSessions}) are not counted twice; folders that
              belong to another project are left out.
            </p>
          ) : null}
          {providerRows.length > 0 ? (
            <div className="project-table-scroll">
              <table>
                <caption>Tokens by provider</caption>
                <thead>
                  <tr>
                    <th>Provider</th>
                    <th>SpecWithCode threads</th>
                    <th>CLI sessions</th>
                    <th>Total</th>
                  </tr>
                </thead>
                <tbody>
                  {providerRows.map((row) => (
                    <tr key={row.provider}>
                      <th>
                        <span className="inline-flex items-center gap-2">
                          <CliIcon provider={row.provider} />
                          {row.label}
                        </span>
                        <small>
                          {row.cliSessions > 0
                            ? `${row.cliSessions} CLI ${row.cliSessions === 1 ? "session" : "sessions"}`
                            : "SpecWithCode only"}
                          {row.lastActiveAt
                            ? ` · active ${formatAgo(Date.parse(row.lastActiveAt), now)}`
                            : ""}
                        </small>
                      </th>
                      <td>{number(row.studioTokens)}</td>
                      <td>{number(row.cliTokens)}</td>
                      <td>{number(row.totalTokens)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
          <p className="project-muted">
            Cache reads and writes are included in input tokens. The cache read ratio is weighted by
            input tokens and is unavailable when input or cache reporting is incomplete.
          </p>
          {(data.coverage.missingThreads > 0 ||
            data.coverage.partialTurns > 0 ||
            data.coverage.missingTurns > 0) && (
            <p className="project-notice" role="status">
              Incomplete usage: {data.coverage.missingThreads} threads without usage;{" "}
              {data.coverage.partialTurns} partial turns; {data.coverage.missingTurns} unreported
              turns. Totals include known data.
            </p>
          )}
          <div className="project-table-scroll">
            <table>
              <caption>Token breakdown by model</caption>
              <thead>
                <tr>
                  <th>Model</th>
                  <th>Input</th>
                  <th>Output</th>
                  <th>Cache read</th>
                  <th>Cache write</th>
                </tr>
              </thead>
              <tbody>
                {data.models.map((m) => (
                  <tr
                    key={`${m.providerInstanceId}:${m.provider}:${m.model}:${m.modelAttribution}`}
                  >
                    <th>
                      {m.model ?? "Model not reported"}
                      <small>
                        {providerLabel(cliOfDriver(m.provider, m.providerInstanceId))} ·
                        SpecWithCode thread
                      </small>
                    </th>
                    <td>{number(m.totals.inputTokens)}</td>
                    <td>{number(m.totals.outputTokens)}</td>
                    <td>{number(m.totals.cachedInputTokens)}</td>
                    <td>{number(m.totals.cacheCreationTokens)}</td>
                  </tr>
                ))}
                {(folder?.models ?? []).map((m) => (
                  <tr key={`cli:${m.provider}:${m.model}`}>
                    <th>
                      {m.model ?? "Model not reported"}
                      <small>{providerLabel(m.provider)} · CLI session</small>
                    </th>
                    <td>{number(m.totals.inputTokens)}</td>
                    <td>{number(m.totals.outputTokens)}</td>
                    <td>{number(m.totals.cachedInputTokens)}</td>
                    <td>{number(m.totals.cacheCreationTokens)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <th>Total</th>
                  <td>{number(combined?.inputTokens ?? 0)}</td>
                  <td>{number(combined?.outputTokens ?? 0)}</td>
                  <td>{number(combined?.cachedInputTokens ?? null)}</td>
                  <td>{number(combined?.cacheCreationTokens ?? null)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
          <p className="project-muted">
            Estimated equivalent API cost:{" "}
            {combined?.equivalentCostUsd == null
              ? "not reported"
              : `$${combined.equivalentCostUsd.toFixed(2)}`}
            . {data.coverage.costUnknownTurns} turns have no cost estimate. Separate subagent usage
            is not included in these main-agent totals.
          </p>
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
          {data.threads.length === 0 ? (
            <p className="project-muted">
              No SpecWithCode threads in this project yet. Start one from the coordinator to record
              its turns here.
            </p>
          ) : null}
          <div className="project-table-scroll" hidden={data.threads.length === 0}>
            <table>
              <thead>
                <tr>
                  <th>Thread</th>
                  <th>Tokens</th>
                  <th>Share</th>
                </tr>
              </thead>
              <tbody>
                {[...data.threads]
                  .sort((a, b) =>
                    sort === "name"
                      ? a.title.localeCompare(b.title)
                      : (b.share ?? -1) - (a.share ?? -1),
                  )
                  .map((t) => (
                    <tr key={t.threadId}>
                      <th>
                        <button
                          className="project-control project-text-link"
                          onClick={() => onOpenThread(t.threadId as ThreadId)}
                        >
                          {t.title}
                        </button>
                        <small>
                          {t.role}
                          {t.archived ? " · archived" : ""}
                        </small>
                      </th>
                      <td>{number(t.totals.totalTokens)}</td>
                      <td>{t.share === null ? "—" : `${(t.share * 100).toFixed(1)}%`}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}
